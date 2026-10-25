'use strict';

// 批4-C1：引擎标签管线（13-local-library-engine.js parseLocalTrackMetadata）契约测试。
// 加载 block1(解析器) + block2(映射/apply) + 引擎，喂合成 FLAC（VORBIS_COMMENT + PICTURE），
// 经假 readLocalFileRange 桩，验证标签应用 + 封面提取 + 歌词提取的接线。

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
function flacStreamInfo(sr, ch, bits, total) {
  const b = Buffer.alloc(34); b.writeUInt16BE(4096, 0); b.writeUInt16BE(4096, 2);
  b[10] = (sr >>> 12) & 0xff; b[11] = (sr >>> 4) & 0xff;
  b[12] = ((sr & 0x0f) << 4) | (((ch - 1) & 0x07) << 1) | (((bits - 1) >>> 4) & 0x01);
  b[13] = (((bits - 1) & 0x0f) << 4) | (Math.floor(total / 4294967296) & 0x0f);
  b.writeUInt32BE(total % 4294967296, 14); return b;
}
function flacHeader(type, last, len) { return Buffer.from([(last ? 0x80 : 0) | (type & 0x7f), (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]); }
function flacBlock(type, last, body) { return Buffer.concat([flacHeader(type, last, body.length), body]); }
function vorbis(items, vendor) {
  const v = Buffer.from(vendor || 'stellaflix-test', 'utf8');
  const parts = [u32le(v.length), v, u32le(items.length)];
  for (const it of items) { parts.push(u32le(it.length)); parts.push(it); }
  return Buffer.concat(parts);
}
function flacPicture(mime, image) {
  const m = Buffer.from(mime, 'ascii');
  return Buffer.concat([u32be(3), u32be(m.length), m, u32be(0), u32be(64), u32be(64), u32be(24), u32be(0), u32be(image.length), image]);
}

// 合成 FLAC：STREAMINFO + VORBIS_COMMENT(标签+LYRICS) + PICTURE(封面, last)
function buildFlac() {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 4, 5, 6, 7]);
  return Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    flacBlock(0, false, flacStreamInfo(44100, 2, 16, 132300)),
    flacBlock(4, false, vorbis([
      Buffer.from('TITLE=标签标题', 'utf8'),
      Buffer.from('ARTIST=标签艺人', 'utf8'),
      Buffer.from('ALBUM=标签专辑', 'utf8'),
      Buffer.from('LYRICS=这是歌词第一行', 'utf8'),
    ])),
    flacBlock(6, true, flacPicture('image/png', png)),
  ]);
}

function loadEngineForParse(flacBytes) {
  const calls = [];
  const fullPath = 'C:\\Music\\track.flac';
  const context = {
    Array, Blob, URL, Error, Intl, Math, Number, Object, Promise, String, TextDecoder, Uint8Array, atob, btoa,
    LOCAL_ASSET_LIGHT_SCAN_BYTES: 4 * 1024 * 1024,
    console: { warn: () => {}, log: () => {} },
    hydrateCustomCover: (song) => song,
    playQueue: [], currentIdx: -1,
    window: { desktopWindow: {
      isDesktop: true,
      readLocalFileRange: (fp, start, end) => {
        calls.push({ fp, start, end });
        const from = Math.min(Math.max(0, start), flacBytes.length);
        const stop = end == null ? flacBytes.length : Math.min(flacBytes.length, end);
        const range = flacBytes.subarray(from, Math.max(from, stop));
        return Promise.resolve({ ok: true, base64Chunks: [range.toString('base64')], byteLength: range.length });
      },
    } },
  };
  const src = stripHeader(read('public/js/modules/04-shelf/11-local-track-map.js')) + '\n'
    + stripHeader(read('public/js/modules/04-shelf/10-local-tag-parser.js')) + '\n'
    + stripHeader(read('public/js/modules/04-shelf/13-local-library-engine.js'));
  vm.runInNewContext(src + '\nthis.parse = parseLocalTrackMetadata;', context);
  context.song = {
    type: 'local', name: 'track.flac', localKey: 'C:\\Music\\track.flac:1:1',
    localUrl: 'http://127.0.0.1:3000/api/local-file?x',
    localFile: { name: 'track.flac', fullPath, size: flacBytes.length, url: 'http://127.0.0.1:3000/api/local-file?x' },
    duration: 0,
  };
  context.calls = calls;
  return context;
}

test('parseLocalTrackMetadata：FLAC 标签应用到歌曲对象（title/artist/album）', async () => {
  const h = loadEngineForParse(buildFlac());
  const res = await h.parse(h.song);
  assert.equal(res.ok, true);
  assert.equal(h.song.name, '标签标题', 'title 应被应用');
  assert.equal(h.song.artist, '标签艺人', 'artist 应被应用');
  assert.equal(h.song.album, '标签专辑', 'album 应被应用');
  assert.ok(res.changed, '应标记有变更');
});

test('parseLocalTrackMetadata：内嵌封面提取为可显示 URL', async () => {
  const h = loadEngineForParse(buildFlac());
  const res = await h.parse(h.song);
  assert.equal(res.hasCover, true, '应提取到内嵌封面');
  assert.ok(/^data:/.test(h.song.localCoverDataUrl || ''), '封面应为 data: URL（可持久化）');
});

test('parseLocalTrackMetadata：内嵌歌词提取为文本', async () => {
  const h = loadEngineForParse(buildFlac());
  const res = await h.parse(h.song);
  assert.equal(res.hasLyric, true, '应提取到内嵌歌词');
  assert.ok(String(h.song.localLyricText || '').indexOf('这是歌词第一行') >= 0, '歌词文本应正确');
});

test('parseLocalTrackMetadata：无 localFile 时优雅返回 ok:false，不抛', async () => {
  const h = loadEngineForParse(buildFlac());
  const res = await h.parse({ type: 'local', name: 'x.flac' });
  assert.equal(res.ok, false);
});

test('parseLocalTrackMetadata：经过 readLocalFileRange 读字节', async () => {
  const h = loadEngineForParse(buildFlac());
  await h.parse(h.song);
  assert.ok(h.calls.length > 0, '应经 IPC 范围读字节');
  assert.ok(h.calls.every((c) => c.fp === 'C:\\Music\\track.flac'));
});

test('端到端：seam.addLocalMusicFolder 扫描+水合+解析 → getTracks 拿到带标签/封面的曲目', async () => {
  const flac = buildFlac();
  const root = 'C://Music';
  const fullPath = 'C://Music//track.flac';
  const context = {
    Array, Blob, URL, Error, Intl, Map, Math, Number, Object, Promise, String, TextDecoder, Uint8Array, atob, btoa,
    LOCAL_ASSET_LIGHT_SCAN_BYTES: 4 * 1024 * 1024,
    console: { warn: () => {}, log: () => {} },
    hydrateCustomCover: (song) => song,
    playQueue: [], currentIdx: -1,
    localLibraryDbState: { probed: false, available: false, promise: null, status: null },
    callLocalLibraryDb: (method, a) => {
      if (method === 'loadLocalLibraryDbRoot') {
        return Promise.resolve({ ok: true, folderPath: a, savedAt: 1, files: [{ name: 'track.flac', fullPath, filePath: fullPath, url: 'http://127.0.0.1:3000/api/local-file?x', relativePath: 'track.flac', webkitRelativePath: 'track.flac', size: flac.length, lastModified: 1, type: 'audio/flac' }] });
      }
      if (method === 'scanLocalMusicFolder') return Promise.resolve({ ok: true, scanMode: 'full', files: [] });
      return Promise.resolve(null);
    },
    window: { desktopWindow: { isDesktop: true, readLocalFileRange: (fp, start, end) => {
      const from = Math.min(Math.max(0, start), flac.length);
      const stop = end == null ? flac.length : Math.min(flac.length, end);
      const range = flac.subarray(from, Math.max(from, stop));
      return Promise.resolve({ ok: true, base64Chunks: [range.toString('base64')], byteLength: range.length });
    } } },
  };
  const src = stripHeader(read('public/js/modules/04-shelf/11-local-track-map.js')) + '\n'
    + stripHeader(read('public/js/modules/04-shelf/10-local-tag-parser.js')) + '\n'
    + stripHeader(read('public/js/modules/04-shelf/13-local-library-engine.js')) + '\n'
    + stripHeader(read('public/js/modules/04-shelf/14-mlib-seam.js'));
  vm.runInNewContext(src, context);

  const res = await context.window.stellaMlibSeam.addLocalMusicFolder(root);
  assert.equal(res.ok, true, 'addLocalMusicFolder 应成功');
  const tracks = (await context.window.stellaMlibSeam.getTracks()).tracks;
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].title, '标签标题', 'getTracks 应含解析后的标题');
  assert.equal(tracks[0].artist, '标签艺人', 'getTracks 应含解析后的艺人');
  assert.equal(tracks[0].album, '标签专辑');
  assert.ok(/^data:/.test(tracks[0].cover || ''), 'getTracks track.cover 应为封面 data URL');
  assert.ok(tracks[0].hasLyric && String(tracks[0].lyric||'').indexOf('这是歌词第一行') >= 0, 'C2-B：seam track 应带内嵌歌词（播放时直接应用）');
  assert.ok(tracks[0].localUrl.startsWith('http://127.0.0.1:3000/api/local-file'), '仍透传可播 localUrl');
});
