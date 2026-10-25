'use strict';

// 批4-B：seam provider（14-mlib-seam.js）对真实消费方（07-mlib-readlayer.js）的集成测试。
// 同 vm 内加载 block2 + 引擎 + seam provider + 真实读层，水合一个根后，
// 走读层 getAxisData('albums'/'artists') 验证卡片派生；并验 subscribe/notifyChange。

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
function audioFile(name, size, mtime) {
  const fullPath = 'C:\\Music\\' + name;
  return { name, fullPath, filePath: fullPath, url: 'http://127.0.0.1:3000/api/local-file?t=x&path=' + encodeURIComponent(fullPath), relativePath: name, webkitRelativePath: name, size, lastModified: mtime, type: 'audio/flac' };
}

function boot(rootData) {
  const context = {
    Array, Blob, Error, Intl, Map, Math, Number, Object, Promise, String, TextDecoder, Uint8Array, atob,
    console: { warn: () => {}, log: () => {}, error: () => {} },
    window: { desktopWindow: { isDesktop: true } },
    localLibraryDbState: { probed: false, available: false, promise: null, status: null },
    playQueue: [], currentIdx: -1,
    hydrateCustomCover: (song) => song,
    callLocalLibraryDb: (method, a) => {
      if (method === 'loadLocalLibraryDbRoot') return Promise.resolve(rootData[a] || { ok: false, error: 'MISS' });
      if (method === 'scanLocalMusicFolder') return Promise.resolve({ ok: true, scanMode: 'full', files: [] });
      return Promise.resolve(null);
    },
  };
  vm.runInNewContext(
    stripHeader(read('public/js/modules/04-shelf/11-local-track-map.js')) + '\n'
    + stripHeader(read('public/js/modules/04-shelf/13-local-library-engine.js')) + '\n'
    + stripHeader(read('public/js/modules/04-shelf/14-mlib-seam.js')) + '\n'
    + read('public/js/modules/04-shelf/07-mlib-readlayer.js'), // 读层是 IIFE，整文件加载
    context
  );
  return context;
}

test('水合后：读层 getAxisData 从 seam 派生出专辑/艺人卡', async () => {
  const root = 'C:\\Music';
  // 三首歌：前两首同专辑同艺人，第三首另一艺人。文件名带「艺人 - 标题」让 block2 解出 artist。
  const ctx = boot({
    [root]: {
      ok: true, folderPath: root, savedAt: 1,
      files: [
        audioFile('周杰伦 - 稻香.flac', 100, 1),
        audioFile('周杰伦 - 青花瓷.flac', 200, 2),
        audioFile('林俊杰 - 江南.flac', 300, 3),
      ],
    },
  });
  await ctx.window.stellaMlibSeam.addLocalMusicFolder(root);

  const albums = await ctx.window.stellaMlibRead.getAxisData('albums');
  assert.equal(albums.status, 'ok', '专辑轴应 ok（有数据）');
  assert.ok(albums.cards.length >= 1, '至少 1 张专辑卡');
  assert.ok(albums.cards.every((c) => c.count >= 1 && c.id), '每张专辑卡有 id 和 count');

  const artists = await ctx.window.stellaMlibRead.getAxisData('artists');
  assert.equal(artists.status, 'ok', '艺人轴应 ok');
  // 周杰伦 2 首 + 林俊杰 1 首 → 至少 2 个艺人（取决于文件名解析出的 artist）。
  assert.ok(artists.cards.length >= 1, '至少 1 张艺人卡');
  const jay = artists.cards.find((c) => /周杰伦/.test(c.title));
  assert.ok(jay, '应解出「周杰伦」艺人卡');
  assert.equal(jay.count, 2, '周杰伦应聚到 2 首');
});

test('seam track 透传可播 localUrl（页面硬契约）', async () => {
  const root = 'C:\\Music';
  const ctx = boot({ [root]: { ok: true, folderPath: root, savedAt: 1, files: [audioFile('A - B.flac', 1, 1)] } });
  await ctx.window.stellaMlibSeam.addLocalMusicFolder(root);
  const res = await ctx.window.stellaMlibSeam.getTracks();
  assert.equal(res.tracks.length, 1);
  assert.ok(res.tracks[0].localUrl.startsWith('http://127.0.0.1:3000/api/local-file'), 'seam track 必须带可播 localUrl');
  assert.equal(res.tracks[0].matched, true);
  assert.equal(typeof res.rev, 'number', '应带 rev');
});

test('空库：读层三轴报 empty（引擎就绪但无数据）', async () => {
  const ctx = boot({});
  const albums = await ctx.window.stellaMlibRead.getAxisData('albums');
  assert.equal(albums.status, 'empty', '空库应报 empty');
  const artists = await ctx.window.stellaMlibRead.getAxisData('artists');
  assert.equal(artists.status, 'empty');
  const playlists = await ctx.window.stellaMlibRead.getAxisData('playlists');
  assert.equal(playlists.status, 'empty');
});

test('subscribe/notifyChange：新增根后订阅者被通知', async () => {
  const root = 'C:\\Music';
  const ctx = boot({ [root]: { ok: true, folderPath: root, savedAt: 1, files: [audioFile('A - B.flac', 1, 1)] } });
  let hits = 0;
  const off = ctx.window.stellaMlibSeam.subscribe(() => { hits += 1; });
  assert.equal(typeof off, 'function', 'subscribe 应返回 unsubscribe');
  await ctx.window.stellaMlibSeam.addLocalMusicFolder(root);
  assert.ok(hits >= 1, 'addLocalMusicFolder 应通知订阅者');
  off();
  await ctx.window.stellaMlibSeam.removeLocalMusicFolder(root);
  assert.equal(hits, 1, '退订后不再被通知');
});
