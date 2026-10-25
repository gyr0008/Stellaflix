'use strict';

// 批4 修复验证：旁挂封面(cover.jpg)/歌词(track.lrc) 配对 → hydrate 出封面 URL + parse 出歌词文本。
// 这是真机「无海报无歌词」的回归守卫（原 makeLocalSongFromFile 传 null,null,[] 丢了旁挂）。

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

const LRC_TEXT = '[00:01.00]Hello 旁挂歌词\n[00:05.00]second line';

function boot() {
  const root = 'D:\\Music';
  const enc = (p) => 'http://127.0.0.1:3000/api/local-file?path=' + encodeURIComponent(p);
  const audioPath = root + '\\track.flac';
  const coverPath = root + '\\cover.jpg';
  const lrcPath = root + '\\track.lrc';
  const mk = (fullPath, name, type, size) => ({
    name, fullPath, filePath: fullPath, url: enc(fullPath), relativePath: name, webkitRelativePath: name,
    size, lastModified: 1, type,
  });
  const lrcBytes = Buffer.from(LRC_TEXT, 'utf8');
  const calls = [];
  const context = {
    Array, Blob, URL, Error, Intl, Map, Math, Number, Object, Promise, String, TextDecoder, Uint8Array, atob, btoa,
    LOCAL_ASSET_LIGHT_SCAN_BYTES: 4 * 1024 * 1024,
    console: { warn: () => {}, log: () => {} },
    hydrateCustomCover: (song) => song,
    playQueue: [], currentIdx: -1,
    localLibraryDbState: { probed: false, available: false, promise: null, status: null },
    callLocalLibraryDb: (method, a) => {
      if (method === 'loadLocalLibraryDbRoot') {
        return Promise.resolve({ ok: true, folderPath: a, savedAt: 1,
          files: [mk(audioPath, 'track.flac', 'audio/flac', 10), mk(coverPath, 'cover.jpg', 'image/jpeg', 5), mk(lrcPath, 'track.lrc', 'text/plain', lrcBytes.length)],
          index: { records: {} } });
      }
      if (method === 'readLocalLibraryDbAssets') return Promise.resolve({ ok: true, records: {} });
      if (method === 'readLocalLibraryDbLyrics') return Promise.resolve({ ok: true, records: {} });
      return Promise.resolve(null);
    },
    window: { desktopWindow: { isDesktop: true, readLocalFileRange: (fp, start, end) => {
      calls.push(fp);
      if (fp === lrcPath) {
        const from = Math.min(Math.max(0, start), lrcBytes.length);
        const stop = end == null ? lrcBytes.length : Math.min(lrcBytes.length, end);
        const r = lrcBytes.subarray(from, Math.max(from, stop));
        return Promise.resolve({ ok: true, base64Chunks: [r.toString('base64')], byteLength: r.length });
      }
      // 音频/封面：返回空（本用例不依赖内嵌）
      return Promise.resolve({ ok: true, base64Chunks: [], byteLength: 0 });
    } } },
  };
  vm.runInNewContext(
    stripHeader(read('public/js/modules/04-shelf/11-local-track-map.js')) + '\n'
    + stripHeader(read('public/js/modules/04-shelf/10-local-tag-parser.js')) + '\n'
    + stripHeader(read('public/js/modules/04-shelf/13-local-library-engine.js')),
    context
  );
  return { ctx: context, root, coverPath, lrcPath, enc, calls };
}

test('旁挂封面：hydrate 用 cover.jpg 的代理 URL 作 localCoverDataUrl', async () => {
  const h = boot();
  await h.ctx.hydrateLocalLibraryRoot(h.root);
  const tracks = h.ctx.getLocalLibraryTracks();
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].localCoverDataUrl, h.enc(h.coverPath), '应取 cover.jpg 的代理 URL');
  assert.equal(tracks[0].localCoverFileName, 'cover.jpg');
});

test('旁挂歌词：parse 读 track.lrc 文本进 localLyricText + hasLyric', async () => {
  const h = boot();
  await h.ctx.hydrateLocalLibraryRoot(h.root);
  const res = await h.ctx.parseLocalLibraryRootMetadata(h.root);
  assert.equal(res.ok, true);
  const song = h.ctx.getLocalLibraryTracks()[0];
  assert.ok(String(song.localLyricText || '').indexOf('Hello 旁挂歌词') >= 0, '应读入 track.lrc 文本');
  assert.equal(song.hasLyric, true, '应标记 hasLyric');
  assert.ok(h.calls.includes(h.lrcPath), '应经 readLocalFileRange 读 .lrc');
});
