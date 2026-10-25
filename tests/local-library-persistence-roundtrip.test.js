'use strict';

// 批4-C1b：持久化往返测试。同一内存假库跨两次 boot：
//   boot1：水合 + 解析 → 落库（index/assets/lyrics）。
//   boot2：全新引擎态（无 readLocalFileRange，不再解析）→ 仅靠持久化水合 → 曲目仍有标签/封面/歌词。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function read(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8'); }
function stripHeader(src) {
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].startsWith('//') || lines[i].trim() === '')) i += 1;
  return lines.slice(i).join('\n');
}

function u32le(v) { const o = Buffer.alloc(4); o.writeUInt32LE(v >>> 0, 0); return o; }
function u32be(v) { const o = Buffer.alloc(4); o.writeUInt32BE(v >>> 0, 0); return o; }
function flacStreamInfo() { const b = Buffer.alloc(34); b.writeUInt16BE(4096, 0); b.writeUInt16BE(4096, 2); b[10] = 0x0a; b[11] = 0xc4; b[12] = 0x40; return b; }
function flacHeader(t, last, len) { return Buffer.from([(last ? 0x80 : 0) | (t & 0x7f), (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]); }
function flacBlock(t, last, body) { return Buffer.concat([flacHeader(t, last, body.length), body]); }
function vorbis(items) { const v = Buffer.from('sf', 'utf8'); const parts = [u32le(v.length), v, u32le(items.length)]; for (const it of items) { parts.push(u32le(it.length)); parts.push(it); } return Buffer.concat(parts); }
function flacPicture(mime, img) { const m = Buffer.from(mime, 'ascii'); return Buffer.concat([u32be(3), u32be(m.length), m, u32be(0), u32be(64), u32be(64), u32be(24), u32be(0), u32be(img.length), img]); }
function buildFlac() {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  return Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    flacBlock(0, false, flacStreamInfo()),
    flacBlock(4, false, vorbis([Buffer.from('TITLE=持久标题', 'utf8'), Buffer.from('ARTIST=持久艺人', 'utf8'), Buffer.from('ALBUM=持久专辑', 'utf8'), Buffer.from('LYRICS=持久歌词', 'utf8')])),
    flacBlock(6, true, flacPicture('image/png', png)),
  ]);
}

function makeStore(flac, root) {
  const fullPath = root + '\\track.flac';
  const store = { index: {}, assets: {}, lyrics: {}, roots: [root] };
  const scanFiles = [{ name: 'track.flac', fullPath, filePath: fullPath, url: 'http://127.0.0.1:3000/api/local-file?x', relativePath: 'track.flac', webkitRelativePath: 'track.flac', size: flac.length, lastModified: 1, type: 'audio/flac' }];
  store.call = (method, a, b) => {
    if (method === 'listLocalLibraryDbRoots') return Promise.resolve({ ok: true, roots: store.roots.slice() });
    if (method === 'loadLocalLibraryDbRoot') {
      // 模拟真实 store：files 只有文件字段（无标签），标签在 index.records（按 songKey 归位）。
      return Promise.resolve({ ok: true, folderPath: a, savedAt: 1, files: scanFiles, index: { records: Object.assign({}, store.index) } });
    }
    if (method === 'saveLocalLibraryDbIndexRecords') { for (const r of (b || [])) store.index[r.key] = r; return Promise.resolve({ ok: true, saved: (b || []).length }); }
    if (method === 'writeLocalLibraryDbAssets') { for (const r of (a || [])) store.assets[r.id] = r; return Promise.resolve({ ok: true, saved: (a || []).length }); }
    if (method === 'writeLocalLibraryDbLyrics') { for (const r of (a || [])) store.lyrics[r.id] = r; return Promise.resolve({ ok: true, saved: (a || []).length }); }
    if (method === 'readLocalLibraryDbAssets') { const rec = {}; for (const k of (a || [])) if (store.assets[k]) rec[k] = store.assets[k]; return Promise.resolve({ ok: true, records: rec }); }
    if (method === 'readLocalLibraryDbLyrics') { const rec = {}; for (const k of (a || [])) if (store.lyrics[k]) rec[k] = store.lyrics[k]; return Promise.resolve({ ok: true, records: rec }); }
    if (method === 'scanLocalMusicFolder') return Promise.resolve({ ok: true, scanMode: 'full', files: [] });
    return Promise.resolve(null);
  };
  return store;
}

function boot(store, withRange) {
  const context = {
    Array, Blob, URL, Error, Intl, Map, Math, Number, Object, Promise, String, TextDecoder, Uint8Array, atob, btoa,
    LOCAL_ASSET_LIGHT_SCAN_BYTES: 4 * 1024 * 1024,
    console: { warn: () => {}, log: () => {} },
    hydrateCustomCover: (song) => song,
    playQueue: [], currentIdx: -1,
    localLibraryDbState: { probed: false, available: false, promise: null, status: null },
    callLocalLibraryDb: store.call,
    window: { desktopWindow: withRange ? { isDesktop: true, readLocalFileRange: withRange } : { isDesktop: true } },
  };
  vm.runInNewContext(
    stripHeader(read('public/js/modules/04-shelf/11-local-track-map.js')) + '\n'
    + stripHeader(read('public/js/modules/04-shelf/10-local-tag-parser.js')) + '\n'
    + stripHeader(read('public/js/modules/04-shelf/13-local-library-engine.js')),
    context
  );
  return context;
}

test('持久化往返：解析落库后，全新引擎仅靠持久化水合仍有标签/封面/歌词', async () => {
  const root = 'C:\\Music';
  const flac = buildFlac();
  const store = makeStore(flac, root);

  // boot1：有水合 + 解析能力 → 解析并落库。
  const ctx1 = boot(store, (fp, start, end) => {
    const from = Math.min(Math.max(0, start), flac.length);
    const stop = end == null ? flac.length : Math.min(flac.length, end);
    const range = flac.subarray(from, Math.max(from, stop));
    return Promise.resolve({ ok: true, base64Chunks: [range.toString('base64')], byteLength: range.length });
  });
  await ctx1.hydrateLocalLibraryRoot(root);
  await ctx1.parseLocalLibraryRootMetadata(root);

  // 落库校验：index/assets/lyrics 已写入。
  const key = Object.keys(store.index)[0];
  assert.ok(key, '应写入索引行');
  assert.equal(store.index[key].artist, '持久艺人');
  assert.ok(store.assets[key], '应写入封面资产');
  assert.ok(/^data:/.test(store.assets[key].localCoverThumbDataUrl), '封面应为 data URL');
  assert.ok(store.lyrics[key], '应写入歌词');
  assert.ok(store.lyrics[key].localLyricText.indexOf('持久歌词') >= 0);

  // boot2：全新引擎态，无 readLocalFileRange（不解析）→ 仅靠持久化水合。
  const ctx2 = boot(store, null);
  const res = await ctx2.hydrateAllLocalLibraryRoots();
  assert.equal(res.ok, true);
  assert.equal(res.roots, 1);
  const tracks = ctx2.getLocalLibraryTracks();
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].artist, '持久艺人', '标签应来自持久化索引');
  assert.equal(tracks[0].album, '持久专辑');
  assert.ok(/^data:/.test(tracks[0].localCoverDataUrl || ''), '封面应来自持久化资产');
  assert.ok(String(tracks[0].localLyricText || '').indexOf('持久歌词') >= 0, '歌词应来自持久化');
});
