'use strict';
// tests/platform-playlist-import.test.js — 批 T8：导入匹配桥换血（netease handleSearch → lx-search searchOne）
// 契约：server.js 注入 platform-playlist-import 的搜索桥改为调用 lxSearch 单例的 searchOne('wy', {query, limit})，
// 输出与旧 netease 注入同形 {ok:true, songs:[{name,singer,songmid,picUrl,interval,source:'wy'}], failures:[]}，
// import 模块零改动。错误语义照旧：桥是 async 函数，searchOne 抛出 → 返回 rejected promise，
// 由 platform-playlist-import.js:30-32 bridgeSearchAll 的 catch 兜底转成 failures:[{source:'bridge',...}]。
// 手法：require('../server.js') 之前 (a) 包一层 platform-playlist-import.setSearchImplementation 捕获注入函数，
// (b) 替换 lx-search.createLxSearch 工厂为计数桩 —— server 模块加载解构到的即桩工厂，
//     据此以 stub 调用计数证明桥走 lx-search 而非 netease handleSearch（RED 时计数为 0）。
// 起服与网络隔离沿用 tests/lx-source-routes.test.js 范式（PORT=3999 先于加载就位，fetch 全桩不触网）。
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = 3999;
process.env.PORT = String(PORT);
delete process.env.HOST;
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-bridge-'));
process.env.STELLAFLIX_USER_DATA = USER_DATA;
process.env.APPDATA = path.join(USER_DATA, 'isolated-appdata');
process.env.LOCALAPPDATA = process.env.APPDATA;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const target = String((input && input.url) || input);
  if (target.startsWith('http://127.0.0.1:' + PORT)) return realFetch(input, init);
  throw new Error('BRIDGE_TEST_FETCH_UNROUTED:' + target);
};

// (a) 捕获 server.js 注入的桥函数
const ppi = require('../platform-playlist-import');
const originalSetSearchImplementation = ppi.setSearchImplementation;
let capturedBridge = null;
ppi.setSearchImplementation = function (fn) {
  capturedBridge = fn;
  return originalSetSearchImplementation.call(ppi, fn);
};

// (b) lx-search 计数桩单例
const lxSearchModule = require('../lx-search');
const originalCreateLxSearch = lxSearchModule.createLxSearch;
const searchOneCalls = [];
const bridgeState = { songs: [], throwNext: false };
lxSearchModule.createLxSearch = () => ({
  searchAll: async () => ({ songs: [], failures: [] }),
  searchOne: async (source, params) => {
    searchOneCalls.push({ source, params });
    if (bridgeState.throwNext) throw new Error('LX_TEST_BRIDGE_FAIL');
    return bridgeState.songs;
  },
});

const server = require('../server.js');

after(() => {
  ppi.setSearchImplementation = originalSetSearchImplementation;
  lxSearchModule.createLxSearch = originalCreateLxSearch;
  globalThis.fetch = realFetch;
  server.close();
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
});

// ---------- 桥注入与 lx-search 接线 ----------
test('server.js 注入的匹配桥调用 lxSearch.searchOne("wy")，limit 解析与旧桥同款（1..30 夹取、默认 10）', async () => {
  assert.equal(typeof capturedBridge, 'function', 'setSearchImplementation 应被 server.js 调用');
  bridgeState.songs = [{
    source: 'wy', id: '333', songmid: 'MID333', name: '明知故犯', singer: 'Max李玄',
    album: '失温', interval: '4:06', pic: 'https://p.example/1.jpg',
  }];
  const result = await capturedBridge('明知故犯 Max李玄', { limit: 10 });
  assert.equal(searchOneCalls.length, 1, '桥内部必须调用 lx-search searchOne（而非 netease handleSearch）');
  assert.equal(searchOneCalls[0].source, 'wy');
  assert.deepEqual(searchOneCalls[0].params, { query: '明知故犯 Max李玄', limit: 10 });
  assert.deepEqual(result, {
    ok: true,
    songs: [{
      name: '明知故犯', singer: 'Max李玄', songmid: 'MID333',
      picUrl: 'https://p.example/1.jpg', interval: '4:06', source: 'wy',
    }],
    failures: [],
  });

  // limit 夹取/默认值与旧桥逐字一致（Math.max(1, Math.min(30, Number||10))）
  await capturedBridge('q', { limit: 999 });
  assert.equal(searchOneCalls[1].params.limit, 30);
  await capturedBridge('q', {});
  assert.equal(searchOneCalls[2].params.limit, 10);
  await capturedBridge('q');
  assert.equal(searchOneCalls[3].params.limit, 10);
});

test('桥输出映射冻结形状：pic→picUrl、songmid 回退 id、缺省空串/0（旧 netease 注入同形契约）', async () => {
  searchOneCalls.length = 0;
  bridgeState.songs = [
    { source: 'wy', id: '555', name: '无songmid', singer: '歌手A', album: '', interval: 0, pic: '' },
    { source: 'wy', id: undefined, songmid: undefined, name: '双缺', singer: undefined, album: '', interval: undefined, pic: undefined },
  ];
  const result = await capturedBridge('双缺测试', { limit: 5 });
  assert.equal(searchOneCalls[0].params.limit, 5);
  assert.equal(result.songs[0].songmid, '555'); // songmid 缺失回退 String(id)
  assert.deepEqual(Object.keys(result.songs[0]), ['name', 'singer', 'songmid', 'picUrl', 'interval', 'source']);
  assert.deepEqual(result.songs[1], { name: '双缺', singer: '', songmid: '', picUrl: '', interval: 0, source: 'wy' });
  assert.deepEqual(result.failures, []);
});

test('桥错误传播语义与旧注入一致：searchOne 抛出 → 桥返回 rejected promise（由 bridgeSearchAll catch 兜底）', async () => {
  searchOneCalls.length = 0;
  bridgeState.throwNext = true;
  await assert.rejects(() => capturedBridge('炸裂query', { limit: 3 }), /LX_TEST_BRIDGE_FAIL/);
  assert.equal(searchOneCalls.length, 1);
  bridgeState.throwNext = false;
  // 对照证据：platform-playlist-import.js:26-32 —— bridgeSearchAll 对注入函数 await+catch，
  // rejected 会被转为 { ok:true, songs:[], failures:[{source:'bridge', reason:<message>] }，
  // 即桥侧保持「抛出=reject」，消费侧兜底，本批不改动错误传播形态。
});
