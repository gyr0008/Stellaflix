'use strict';
/**
 * T4 特殊协议（parse:0 磁力/FTP）起播分流测试。
 * 运行：node --test tests/drpy-special-protocol.test.js
 * 规则：drpyS libs_drpy/drpyCustom.js:44 SPECIAL_URL = /^(ftp|magnet|thunder|ws):/
 * 编排器不得把这类地址喂给播放器，只能转交 BT 队列（汇联页）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadPage } = require('./helpers/huilian-harness');

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// mount 会装 2s 轮询，测试里必须换掉假定时器，否则 node --test 进程不退出
function noPolling(loaded) {
  loaded.sandbox.setInterval = () => 7;
  loaded.sandbox.clearInterval = () => {};
  return loaded;
}

const MAGNET = 'magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567';

test('handoff：未挂载时记账，页面挂载即自动入队', async () => {
  const calls = [];
  const loaded = loadPage({
    bridge: { download: { addTorrent: (p) => { calls.push(p); return Promise.resolve({ ok: true, data: {} }); } } },
  });
  const page = loaded.sandbox.StellaflixVideo.huilianPage;
  assert.equal(typeof page.handoff, 'function', '路由注册与命名空间都要带 handoff');
  assert.equal(page.handoff(MAGNET), true);
  await flush();
  assert.equal(calls.length, 0, '页面还没挂载，只记账');

  noPolling(loaded);
  page.mount(loaded.host);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MAGNET);
});

test('handoff：页面已挂载则直接入队；非桌面（无桥）返回 false', async () => {
  const calls = [];
  const loaded = loadPage({
    bridge: { download: { addTorrent: (p) => { calls.push(p); return Promise.resolve({ ok: true, data: {} }); } } },
  });
  const page = loaded.sandbox.StellaflixVideo.huilianPage;
  noPolling(loaded);
  page.mount(loaded.host);
  assert.equal(page.handoff(MAGNET), true);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MAGNET);

  const noBridge = loadPage({ bridge: null });
  assert.equal(noBridge.sandbox.StellaflixVideo.huilianPage.handoff(MAGNET), false);
});

// ---------- 编排器分流 ----------
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 以最小假依赖装载 play-orchestrator：记录 doPlay 落点（source.open）与 toast 文案。
 * opts.huilian 传入 {handoff:fn} 模拟 BT 页存在；缺省=不存在。
 */
function loadOrchestrator(opts) {
  const toasts = [];
  const opened = [];
  const switched = [];
  const sandbox = {
    console, Math, Number, Array, Object, String, Boolean, Promise, Set, Map, JSON, Date,
    setTimeout, clearTimeout, RegExp, Error,
  };
  sandbox.window = sandbox;
  sandbox.StellaflixVideo = {
    source: { open: (meta) => { opened.push(meta.url); return true; } },
    player: { isOpen: () => true, setPlaylist: () => {}, setRoads: () => {}, setPlayNext: () => {}, getVideoEl: null },
    watchHistory: { add: () => {} },
    detailSource: {
      confirmPlaybackSwitch: () => {},
      failPlaybackSwitch: (r) => switched.push(r),
    },
    huilianPage: (opts || {}).huilian,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'video', 'play-orchestrator.js'), 'utf8'),
    sandbox, { filename: 'play-orchestrator.js' });
  const P = sandbox.StellaflixVideo.playOrchestrator;
  P.init({
    toast: (t) => toasts.push(t),
    recordMeta: () => {}, recordHistory: () => {}, captureReturn: () => {}, resolvePic: () => '', close: () => {},
  });
  return { P, toasts, opened, switched, SFV: sandbox.StellaflixVideo };
}

const VIEW = { key: 'k', title: '片子', source: { id: 'drpy:示例', name: '示例' }, vodId: '1' };

test('编排器：磁力集不进播放器，转交 BT 并落失败态', () => {
  const handed = [];
  const { P, toasts, opened, switched } = loadOrchestrator({ huilian: { handoff: (m) => { handed.push(m); return true; } } });
  P.play(VIEW, { index: 0, name: '第1集', url: MAGNET }, { episodes: [] });
  assert.deepEqual(handed, [MAGNET]);
  assert.equal(opened.length, 0, '绝不得把磁力喂给播放器');
  assert.match(toasts.join('|'), /BT 下载队列/);
  assert.equal(switched.length, 1, '热切换状态机要收到失败');
});

test('编排器：无 BT 页时给出可懂的降级提示', () => {
  const { P, toasts, opened } = loadOrchestrator({});
  P.play(VIEW, { index: 0, name: '第1集', url: 'ftp://host/电影.mp4' }, { episodes: [] });
  assert.equal(opened.length, 0);
  assert.match(toasts.join('|'), /需桌面版并配置好 BT/);
});

test('编排器：普通 http 直链不受影响', () => {
  const { P, opened } = loadOrchestrator({ huilian: { handoff: () => { throw new Error('不该被调用'); } } });
  P.play(VIEW, { index: 0, name: '第1集', url: 'https://cdn.example.com/v.m3u8' }, { episodes: [] });
  assert.deepEqual(opened, ['https://cdn.example.com/v.m3u8']);
});
