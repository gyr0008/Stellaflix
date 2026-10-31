'use strict';

/**
 * tests/home-login-gate-and-egg-retirement.test.js — 任务16b
 *
 * 契约（主人 T16 原话「去掉未登录门槛」经现场取证 = 音乐首页「片库」卡，非影视页）：
 *  ① 音乐首页三处登录弹窗门槛（home-library / home-daily / home-private）全部摘除。
 *     判据：#login-modal 的 DOM 已在 16a 整套离场，弹窗函数现在只走
 *     openGsapModal(null) 的 `if (!mask) return` 空转 —— 点卡=死点击，无任何反馈。
 *     摘除后由各函数**本来就写好的**自有兜底接管（runHomeSearch('每日推荐') / openHomeLibrary()），
 *     不是新造行为。
 *  ② 首页磁贴里「登录同步歌单」那张 kind:'login' 卡与其点击分支同口径退役（同样指向已摘除弹窗）。
 *     保留：搜索卡 / 本地导入卡 / openHomeLibrary 的 'library' 分支。
 *  ③ 登录彩蛋（08-account/00-login-easter-egg.js）整套离场：模块文件 + 专测文件 +
 *     index.css 的 login-easter-* 样式 + bundle-modules 测试口径里的登记位。
 *  ④ 故意不做（防连坐，本测钉住）：03a 的 openHomeDashboardLibrary（未登录开导入面板，不指向弹窗）、
 *     04 里 openHomePlaylist 的 runHomeSearch('') 兜底。
 *
 * 手法：vm + namedFunctionSource 单函数沙箱（不触网/不起服务器）+ 静态反证。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { namedFunctionSource } = require('./helpers/extract-fn');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const P_HOME = 'public/js/modules/05-playback/04-home-empty-wallpaper.js';
const P_TILES = 'public/js/modules/05-playback/03-home-discover-weather.js';
const P_ACTIONS = 'public/js/modules/05-playback/05-home-actions.js';
const P_DASH = 'public/js/modules/05-playback/03a-home-dashboard.js';
const P_LOADER = 'public/js/index-loader.js';
const P_CSS = 'public/css/index.css';
const P_EGG = 'public/js/modules/08-account/00-login-easter-egg.js';
const P_EGG_TEST = 'tests/login-easter-egg-ime-focus.test.js';
const P_BUNDLE_TEST = 'tests/bundle-modules.test.js';

function runOpenHomeLibrary() {
  const calls = { panel: [], refresh: [], lock: [], suppressed: [] };
  const src = namedFunctionSource(read(P_HOME), 'openHomeLibrary');
  const ctx = {
    homeDiscoverState: { loggedIn: false },
    setHomeControlsLocked: (v) => { calls.lock.push(v); },
    openPlaylistPanelTab: (tab, force) => { calls.panel.push([tab, force]); },
    refreshUserPlaylists: (force) => { calls.refresh.push(force); },
    homeSuppressed: true,
    __calls: calls,
  };
  vm.runInNewContext(
    src + '\n;openHomeLibrary();__calls.homeSuppressed = homeSuppressed;',
    vm.createContext(ctx),
    { filename: P_HOME }
  );
  return calls;
}

test('① 未登录点「片库」直接进入歌单面板，无任何登录弹窗触点', () => {
  const calls = runOpenHomeLibrary();
  assert.deepEqual(calls.panel, [['playlists', true]], '必须打开歌单面板 tab');
  assert.deepEqual(calls.refresh, [true], '必须照常刷新歌单');
  assert.deepEqual(calls.lock, [false], '首页控件解锁');
  assert.equal(calls.homeSuppressed, false);
});

test('① 片库入口行为稳定（同一出口，不因摘门槛而少调一步）', () => {
  const calls = runOpenHomeLibrary();
  assert.deepEqual(calls.panel, [['playlists', true]]);
  assert.deepEqual(calls.refresh, [true]);
});

test('② 首页三处登录门槛清零，函数自有兜底原样保留', () => {
  const home = read(P_HOME);
  assert.doesNotMatch(home, /login\s*Modal/i, '04-home-empty-wallpaper 不得再有任何登录弹窗调用');
  assert.doesNotMatch(home, /source:\s*'home-(?:daily|private|library)'/, '门槛 source 字符串一并离场');

  const daily = namedFunctionSource(home, 'playHomeDaily');
  assert.match(daily, /runHomeSearch\('每日推荐'\)/, '无歌单时的自有兜底（搜索）必须还在');
  assert.match(daily, /playQueue = homeDiscoverState\.songs\.map\(cloneSong\)/, '有歌单时照常整队播放');

  const priv = namedFunctionSource(home, 'playHomePrivateRadio');
  assert.match(priv, /openHomeLibrary\(\)/, '私人雷达空态的自有兜底必须还在');

  // 不扩大删除面：openHomePlaylist 的空 id 兜底改走无账号的歌单面板，不得回退登录弹窗
  const playlist = namedFunctionSource(home, 'openHomePlaylist');
  assert.match(playlist, /openHomeLibrary\(\)/, 'openHomePlaylist 的无标识兜底须保留');
  assert.doesNotMatch(playlist, /login\s*Modal/i, 'openHomePlaylist 不得回退登录弹窗');
});

test('③ 首页「登录同步歌单」磁贴与其点击分支退役，搜索/本地卡保留', () => {
  const tiles = read(P_TILES);
  assert.doesNotMatch(tiles, /kind:\s*'login'/, 'starter 磁贴不得再有登录卡');
  assert.doesNotMatch(tiles, /kind === 'login'/, 'tone 映射的登录分支一并离场');
  const fallback = namedFunctionSource(tiles, 'fallbackHomeTiles');
  assert.match(fallback, /kind: 'search'/);
  assert.match(fallback, /kind: 'local'/);

  const actions = read(P_ACTIONS);
  assert.doesNotMatch(actions, /login\s*Modal/i, '首页磁贴点击不得再唤起已退役的登录框');
  assert.doesNotMatch(actions, /item\.kind === 'login'/);
  assert.match(actions, /item\.kind === 'library'\)\s*openHomeLibrary\(\)/, 'library 分支保持消费 openHomeLibrary');
});

test('④ 登录彩蛋整套离场：模块 / 专测 / CSS / 测试口径', () => {
  assert.equal(exists(P_EGG), false, '00-login-easter-egg.js 必须已删除');
  assert.equal(exists(P_EGG_TEST), false, '彩蛋 IME 专测必须随模块删除');
  assert.doesNotMatch(read(P_LOADER), /login-easter-egg/, 'index-loader 不得登记彩蛋模块');
  assert.doesNotMatch(read(P_BUNDLE_TEST), /login-easter-egg/, 'bundle-modules 孤儿扫描口径不得再引用彩蛋路径');
  assert.doesNotMatch(read(P_CSS), /login-easter/, 'index.css 不得残留 login-easter-* 样式');
  assert.doesNotMatch(read('public/index.html'), /login-easter/, 'index.html 不得残留彩蛋 DOM');
});

test('⑤ 防连坐：音乐库卡与 16d 领地口径一致，不指向已退役弹窗', () => {
  const dash = read(P_DASH);
  const dashLib = namedFunctionSource(dash, 'openHomeDashboardLibrary');
  assert.match(dashLib, /openUploadPanel\(\)/, '音乐库卡走导入面板兜底');
  assert.doesNotMatch(dashLib, /login\s*Modal/i, '音乐库卡不得指向已退役弹窗');

  const html = read('public/index.html');
  assert.match(html, /id="home-tile-row"/, '首页磁贴行仍在');
  assert.doesNotMatch(html, /id="login-modal"/, '16a 的登录弹窗不得复活');
});
