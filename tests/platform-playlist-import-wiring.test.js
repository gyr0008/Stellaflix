'use strict';

/**
 * 平台歌单导入接线与契约测试
 * 运行：node --test tests/platform-playlist-import-wiring.test.js
 *
 * 覆盖：
 * 1) window.importPlatformPlaylistFromInput 等 7 个钩子挂载（修复后证明）
 * 2) AI 导入契约：silent 路径 → localPlaylistStore 落库 + 返回形状
 * 3) 重复导入：按 platformImportKey 替换曲目（updated:true）
 * 4) .lxmc 解析：gzip → playListPart_v2 → 落库
 * 5) 改动前对照：未加载本模块时钩子不存在（agent-music-tools.js:2464 → NOT_READY）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { Blob } = require('node:buffer');

const appRoot = path.join(__dirname, '..');
const storeSource = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '03b-local-playlist-store.js'), 'utf8');
const ppiSource = fs.readFileSync(path.join(appRoot, 'public', 'js', 'platform-playlist-import.js'), 'utf8');

const FIXTURE_PLAYLIST = {
  ok: true,
  playlist: {
    id: 'platform_wy_3778678', name: '热歌榜（测试）', cover: 'http://example.com/cover.jpg',
    source: 'wy', sourceListId: '3778678', sourceInput: '3778678', imported: true,
    totalTracks: 2, previewTracks: 2, partial: false, importLimitReason: '',
    songs: [
      { id: 111, songmid: 111, name: '明知故犯', singer: 'Max李玄', albumName: '失温', picUrl: 'http://example.com/1.jpg', interval: '2:46', source: 'wy' },
      { id: 222, songmid: 222, name: '测试歌曲', singer: '测试歌手', albumName: '测试专辑', picUrl: '', interval: '3:12', source: 'wy' },
    ],
  },
};

function makeSandbox() {
  const calls = { fetches: [], toasts: [] };
  const storage = new Map();
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    JSON, Math, Date, String, Number, Array, Object, Boolean, Promise,
    setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
    AbortController, URL,
    DecompressionStream: globalThis.DecompressionStream,
    Response: globalThis.Response,
    Blob,
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k),
    },
    fetch: async (url, opts) => {
      calls.fetches.push({ url, opts });
      return {
        ok: true, status: 200,
        json: async () => FIXTURE_PLAYLIST,
      };
    },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} }),
      body: { appendChild() {}, classList: { add() {}, remove() {}, contains: () => false } },
      head: { appendChild() {} },
      addEventListener() {},
    },
    showToast: m => calls.toasts.push(String(m)),
    renderUserPlaylistsList: () => {},
    openPlaylistPanelTab: () => {},
    toggleUploadPanel: () => {},
    openHomeLocalImport: () => {},
    openCustomSourceModal: () => {},
    calls,
  };
  sandbox.window = sandbox;
  sandbox.cloneSong = undefined; // store 有 cloneSong 回退分支
  vm.createContext(sandbox);
  return sandbox;
}

function loadModules(sandbox) {
  vm.runInContext(storeSource, sandbox, { filename: '03b-local-playlist-store.js' });
  vm.runInContext(ppiSource, sandbox, { filename: 'platform-playlist-import.js' });
}

test('修复前对照：未加载模块时 AI 工具钩子不存在（agent-music-tools.js:2464 返回 NOT_READY 的根因）', () => {
  const sandbox = makeSandbox();
  vm.runInContext(storeSource, sandbox, { filename: '03b-local-playlist-store.js' });
  assert.strictEqual(sandbox.window.importPlatformPlaylistFromInput, undefined);
  assert.strictEqual(sandbox.window.openPlatformPlaylistImport, undefined);
  assert.strictEqual(sandbox.window.openLxPlaylistImport, undefined);
});

test('接线：7 个钩子全部挂载', () => {
  const sandbox = makeSandbox();
  loadModules(sandbox);
  const hooks = [
    'importPlatformPlaylistFromInput', 'openPlatformPlaylistImport', 'openLxPlaylistImport',
    'openPlaylistSelection', 'openLxSourceImport', 'openLocalFileImport', 'openLocalFolderImport',
  ];
  hooks.forEach(name => assert.strictEqual(typeof sandbox.window[name], 'function', name + ' 应为函数'));
});

test('AI 导入契约：silent 路径 POST 正确端点并落库', async () => {
  const sandbox = makeSandbox();
  loadModules(sandbox);
  const result = await sandbox.window.importPlatformPlaylistFromInput('https://music.163.com/#/playlist?id=3778678', 'wy', { confirmDuplicate: false, silent: true });
  // 请求形状
  assert.strictEqual(sandbox.calls.fetches.length, 1, '应恰好发起一次导入请求');
  assert.strictEqual(sandbox.calls.fetches[0].url, '/api/platform-playlist/import');
  const body = JSON.parse(sandbox.calls.fetches[0].opts.body);
  assert.strictEqual(body.input, 'https://music.163.com/#/playlist?id=3778678');
  assert.strictEqual(body.source, 'wy');
  // 返回形状（摘要）
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.updated, false);
  assert.strictEqual(result.playlist.name, '热歌榜（测试）');
  assert.strictEqual(result.playlist.songCount, 2);
  assert.strictEqual(result.playlist.platformImportKey, 'platform_wy_3778678');
  // 落库
  const lists = sandbox.window.localPlaylistStore.list();
  const stored = lists.find(pl => pl.platformImportKey === 'platform_wy_3778678');
  assert.ok(stored, '本地歌单应带 platformImportKey 落库');
  assert.strictEqual(stored.songs.length, 2);
  assert.strictEqual(stored.songs[0].type, 'lx-online');
  assert.strictEqual(stored.songs[0].songmid, '111');
  assert.strictEqual(stored.songs[0].source, 'wy');
  assert.strictEqual(stored.songs[0].lxPlaylistName, '热歌榜（测试）');
  assert.strictEqual(stored.creator, '平台导入');
  // silent 模式不开面板、不弹 toast（AI 路径由助手自己汇报）
  assert.strictEqual(sandbox.calls.toasts.filter(t => t.includes('热歌榜')).length, 0, 'silent 路径不应 toast');
});

test('重复导入：同 platformImportKey 替换曲目', async () => {
  const sandbox = makeSandbox();
  loadModules(sandbox);
  await sandbox.window.importPlatformPlaylistFromInput('3778678', 'wy', { confirmDuplicate: false, silent: true });
  // 模拟第二次导入返回不同曲目集（改造 fixture）
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    ok: true,
    playlist: Object.assign({}, FIXTURE_PLAYLIST.playlist, { songs: [FIXTURE_PLAYLIST.playlist.songs[0]] }),
  }) });
  const second = await sandbox.window.importPlatformPlaylistFromInput('3778678', 'wy', { confirmDuplicate: false, silent: true });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.updated, true, '第二次导入应标记 updated:true');
  const lists = sandbox.window.localPlaylistStore.list();
  const stored = lists.filter(pl => pl.platformImportKey === 'platform_wy_3778678');
  assert.strictEqual(stored.length, 1, '不得产生重复歌单');
  assert.strictEqual(stored[0].songs.length, 1, '曲目应被替换为最新一批');
});

test('lxmc 解析：gzip playListPart_v2 落库', async () => {
  const sandbox = makeSandbox();
  loadModules(sandbox);
  const lxmcPayload = {
    type: 'playListPart_v2',
    data: {
      id: 'sf_test_list', name: '落雪导出的歌单', source: '', sourceListId: '',
      list: [
        { name: '晴天', singer: '周杰伦', source: 'wy', songmid: '186016', interval: '4:29', albumName: '叶惠美' },
        { name: '本地占位', singer: '', source: '', interval: '', albumName: '' }, // 无 source 应被过滤
      ],
    },
  };
  const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify(lxmcPayload), 'utf8'));
  const fakeFile = { name: 'sf_test_list.lxmc', stream: () => new Blob([gzipped]).stream() };
  const result = await sandbox.window.openLxPlaylistImport({ files: [fakeFile] });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.imported, 1);
  const lists = sandbox.window.localPlaylistStore.list();
  const stored = lists.find(pl => pl.platformImportKey === 'lxmc_sf_test_list');
  assert.ok(stored, 'lxmc 歌单应落库');
  assert.strictEqual(stored.songs.length, 1, '无 source 的条目应被过滤');
  assert.strictEqual(stored.songs[0].songmid, '186016');
  assert.strictEqual(stored.songs[0].type, 'lx-online');
});

test('本地入口委托：openLocalFolderImport → openHomeLocalImport', () => {
  const sandbox = makeSandbox();
  loadModules(sandbox);
  let delegated = false;
  sandbox.openHomeLocalImport = () => { delegated = true; };
  const result = sandbox.window.openLocalFolderImport();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(delegated, true);
});
