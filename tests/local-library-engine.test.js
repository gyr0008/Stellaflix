'use strict';

// 批4-A：本地曲库引擎内核（13-local-library-engine.js）契约测试。
// block2（11-local-track-map.js）真实加载 + 假 callLocalLibraryDb 桥，验证水合→track→统计→移除→当前曲目派生。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BLOCK2 = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '11-local-track-map.js'), 'utf8');
const ENGINE = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '13-local-library-engine.js'), 'utf8');

function stripHeader(src) {
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].startsWith('//') || lines[i].trim() === '')) i += 1;
  return lines.slice(i).join('\n');
}

function audioFile(name, size, mtime) {
  const fullPath = 'C:\\Music\\' + name;
  return {
    name, fullPath, filePath: fullPath,
    url: 'http://127.0.0.1:3000/api/local-file?token=x&path=' + encodeURIComponent(fullPath),
    relativePath: name, webkitRelativePath: name,
    size, lastModified: mtime, type: 'audio/flac',
  };
}

function loadEngine(rootData) {
  const calls = [];
  const context = {
    Array, Blob, Error, Intl, Math, Number, Object, Promise, String, TextDecoder, Uint8Array, atob,
    console: { warn: () => {} },
    hydrateCustomCover: (song) => song,
    playQueue: [], currentIdx: -1,
    callLocalLibraryDb: (method, a, b) => {
      calls.push({ method, a, b });
      if (method === 'loadLocalLibraryDbRoot') {
        return Promise.resolve(rootData[a] || { ok: false, error: 'LOCAL_LIBRARY_DB_ROOT_MISSING' });
      }
      if (method === 'scanLocalMusicFolder') {
        return Promise.resolve({ ok: true, scanMode: 'full', files: [] });
      }
      return Promise.resolve(null);
    },
  };
  vm.runInNewContext(
    stripHeader(BLOCK2) + '\n' + stripHeader(ENGINE)
      + '\nthis.api = { hydrateLocalLibraryRoot, addLocalLibraryRoot, removeLocalLibraryRoot,'
      + ' getLocalLibraryTracks, getLocalLibraryStats, localLibraryCurrentSong };',
    context
  );
  context.calls = calls;
  return context;
}

test('水合根：只收音频、组装 track（localUrl=代理/localKey/type=local）', async () => {
  const root = 'C:\\Music';
  const ctx = loadEngine({
    [root]: {
      ok: true, folderPath: root, savedAt: 111,
      files: [audioFile('a.flac', 100, 1), audioFile('b.flac', 200, 2), { name: 'cover.jpg', fullPath: 'C:\\Music\\cover.jpg', size: 5, lastModified: 1, type: 'image/jpeg' }, { name: 'x.txt', fullPath: 'C:\\Music\\x.txt', size: 1, lastModified: 1, type: 'text/plain' }],
    },
  });
  const res = await ctx.api.hydrateLocalLibraryRoot(root);
  assert.equal(res.ok, true);
  assert.equal(res.count, 2, '只应收 2 条音频（.jpg/.txt 排除）');
  const tracks = ctx.api.getLocalLibraryTracks();
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].type, 'local');
  assert.ok(tracks[0].localUrl.startsWith('http://127.0.0.1:3000/api/local-file'), 'localUrl 应取代理 URL');
  assert.ok(tracks[0].localKey, '应生成 localKey');
  assert.equal(tracks[0].localFormat, 'FLAC');
  // 桥确实被以「loadLocalLibraryDbRoot」调用（批4-C1b 起带索引，不再 index:false）。
  assert.ok(ctx.calls.some((c) => c.method === 'loadLocalLibraryDbRoot'));
});

test('SQLite 不可用：水合返回 ok:false，不污染其它根', async () => {
  const good = 'C:\\Music';
  const bad = 'C:\\Nope';
  const ctx = loadEngine({ [good]: { ok: true, folderPath: good, savedAt: 1, files: [audioFile('a.flac', 1, 1)] } });
  assert.equal((await ctx.api.hydrateLocalLibraryRoot(good)).ok, true);
  const badRes = await ctx.api.hydrateLocalLibraryRoot(bad);
  assert.equal(badRes.ok, false, '坏根应 ok:false');
  assert.equal(ctx.api.getLocalLibraryTracks().length, 1, '坏根不影响已水合的好根');
});

test('addLocalLibraryRoot：先 scan 再水合', async () => {
  const root = 'C:\\Music';
  const ctx = loadEngine({ [root]: { ok: true, folderPath: root, savedAt: 1, files: [audioFile('a.flac', 1, 1), audioFile('b.flac', 2, 2)] } });
  const res = await ctx.api.addLocalLibraryRoot(root);
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  const methods = ctx.calls.map((c) => c.method);
  assert.ok(methods.indexOf('scanLocalMusicFolder') >= 0, '应先触发扫描');
  assert.ok(methods.indexOf('loadLocalLibraryDbRoot') >= 0, '再水合');
  assert.ok(methods.indexOf('scanLocalMusicFolder') < methods.indexOf('loadLocalLibraryDbRoot'), '扫描应先于水合');
});

test('多根统计 + 移除根', async () => {
  const r1 = 'C:\\Music'; const r2 = 'D:\\Songs';
  const ctx = loadEngine({
    [r1]: { ok: true, folderPath: r1, savedAt: 1, files: [audioFile('a.flac', 1, 1), audioFile('b.flac', 2, 2)] },
    [r2]: { ok: true, folderPath: r2, savedAt: 2, files: [audioFile('c.flac', 3, 3)] },
  });
  await ctx.api.hydrateLocalLibraryRoot(r1);
  await ctx.api.hydrateLocalLibraryRoot(r2);
  let stats = ctx.api.getLocalLibraryStats();
  assert.equal(stats.rootCount, 2);
  assert.equal(stats.trackCount, 3, '两根共 3 首');
  const revBefore = stats.revision;
  const removed = ctx.api.removeLocalLibraryRoot(r1);
  assert.equal(removed.removed, true);
  assert.equal(ctx.api.getLocalLibraryTracks().length, 1, '移除 r1 后剩 r2 的 1 首');
  assert.equal(ctx.api.getLocalLibraryStats().revision > revBefore, true, '移除应推进 revision');
  assert.equal(ctx.api.removeLocalLibraryRoot(r1).removed, false, '重复移除返回 false');
});

test('localLibraryCurrentSong：按 playQueue/currentIdx 派生', () => {
  const ctx = loadEngine({});
  const local = { type: 'local', localKey: 'k', localUrl: 'http://127.0.0.1:3000/api/local-file?x' };
  const online = { type: 'online', id: 'n1' };
  // 初始空队列 → null。
  assert.equal(ctx.api.localLibraryCurrentSong(), null);
  ctx.playQueue = [online, local];
  ctx.currentIdx = 0;
  assert.equal(ctx.api.localLibraryCurrentSong(), null, '当前是在线歌 → null');
  ctx.currentIdx = 1;
  assert.equal(ctx.api.localLibraryCurrentSong(), local, '当前是本地歌 → 返回它');
  ctx.currentIdx = 9;
  assert.equal(ctx.api.localLibraryCurrentSong(), null, '越界 → null');
});
