'use strict';

/**
 * 回归测试：首页「接着看」/NEXT UP 续播 → 退出播放器回 home，不重建详情页。
 *
 * 背景（2026-09-18 需求）：从影视态首页「接着看」卡横排或 dashboard「NEXT UP」进入播放时，
 * 退出播放器原先会走 returnFromPlayer → openDetailFromMeta 重建该视频详情页。
 *
 * 契约：
 *  A. home-continue-watching.resumeFromHistory 调 smartResumePlay 时视图带 _origin:'continue'；
 *  B. detail-source.smartResumePlay 的两条起播分支（自带源 / 跨源搜索）都把 _origin 透传进 v2；
 *  C. online-nav.capturePlayerReturn 收到 _origin:'continue' 时不记录返回目标，
 *     returnFromPlayer 成为空操作（默认回 home）；普通详情页 view 仍回详情页（对照）。
 *
 * 运行：node --test tests/continue-watching-return-home.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VIDEO_DIR = path.join(__dirname, '..', 'public', 'video');
const PLAYBACK_DIR = path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback');

function readSrc(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

function makeSandbox(extra) {
  const sandbox = Object.assign({
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    clearTimeout: (id) => clearTimeout(id),
    Promise: Promise,
    Date: Date,
    Math: Math,
    JSON: JSON,
    RegExp: RegExp,
    String: String,
    Number: Number,
    Object: Object,
    Array: Array,
    Error: Error,
    encodeURIComponent,
    decodeURIComponent,
  }, extra || {});
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function runIn(sandbox, code) {
  vm.runInContext(code, sandbox);
}

// ---------------------------------------------------------------- A. 续播入口打标

test('A resumeFromHistory 通过 smartResumePlay 透传 _origin:"continue"', () => {
  const entry = { key: 'cms:1:vid9', title: '测试片', lastSourceId: 'cms:1', lastVodId: '9' };
  let received = null;
  const sandbox = makeSandbox({
    StellaflixVideo: {
      homeCore: { escAttr: (s) => String(s), escHtml: (s) => String(s), fmtTime: () => '0:00' },
      model: { getHistory: () => [entry] },
      detailSource: { smartResumePlay: (v) => { received = v; } },
    },
  });
  runIn(sandbox, readSrc(VIDEO_DIR, 'home-continue-watching.js'));
  sandbox.StellaflixVideo.homeContinueWatching.resumeFromHistory('cms:1:vid9');

  assert.ok(received, 'smartResumePlay 应被调用');
  assert.strictEqual(received._origin, 'continue', '续播视图必须带 _origin:continue 标记');
  assert.strictEqual(received.key, entry.key, '原记录字段不得丢失');
  assert.strictEqual(entry._origin, undefined, '不得原地污染存储中的历史记录');
});

// ---------------------------------------------------------------- B. smartResumePlay 透传

test('B smartResumePlay 的自带源/跨源两条分支都把 _origin 写入起播视图', () => {
  const src = readSrc(VIDEO_DIR, 'detail-source.js');
  const start = src.indexOf('function smartResumePlay');
  assert.ok(start >= 0, 'detail-source.js 应定义 smartResumePlay');
  const body = src.slice(start);
  const occurrences = body.match(/_origin:\s*rec\._origin/g) || [];
  assert.strictEqual(occurrences.length, 2, 'tryLastSource 与 fallbackSearch 两处 v2 均须透传 _origin');
});

// ---------------------------------------------------------------- C. 返回栈消费标记

function loadOnlineNav(S, extraSf) {
  const sandbox = makeSandbox({
    StellaflixVideo: Object.assign({
      onlineShared: S,
      onlineCore: {},
    }, extraSf || {}),
  });
  runIn(sandbox, readSrc(VIDEO_DIR, 'online-nav.js'));
  const sfv = sandbox.StellaflixVideo;
  sfv.__sandbox = sandbox; // 暴露沙箱，供 E 组断言音乐态全局标记（global.homeSuppressed）
  return sfv;
}

test('C1 普通详情页 view：退出播放器仍重建详情页（对照，行为不变）', () => {
  const calls = [];
  const S = { d: () => ({}), openDetailFromMeta: (v) => calls.push(['detail', v]) };
  const SFV = loadOnlineNav(S);
  const view = { key: 'cms:1:vid9', title: '测试片' };
  SFV.onlineNav.capturePlayerReturn(view);
  SFV.onlineNav.returnFromPlayer();
  assert.deepStrictEqual(calls.map((c) => c[0]), ['detail'], '无标记 view 应返回详情页');
  assert.strictEqual(calls[0][1], view);

  // 二次退出（返回栈已消费）不得重复重建
  SFV.onlineNav.returnFromPlayer();
  assert.strictEqual(calls.length, 1, '返回目标一次性消费');
});

test('C2 _origin:"continue" 的续播 view：返回栈不记录，退出即空操作（默认回 home）', () => {
  const calls = [];
  const S = { d: () => ({}), openDetailFromMeta: (v) => calls.push(['detail', v]) };
  const SFV = loadOnlineNav(S);
  SFV.onlineNav.capturePlayerReturn({ key: 'cms:1:vid9', title: '测试片', _origin: 'continue' });
  SFV.onlineNav.returnFromPlayer();
  assert.deepStrictEqual(calls, [], '续播退出不得重建详情页，应保持默认回 home');
});

test('C3 先续播后正常播放：continue 记录被覆盖，不被污染', () => {
  const calls = [];
  const S = { d: () => ({}), openDetailFromMeta: (v) => calls.push(['detail', v]) };
  const SFV = loadOnlineNav(S);
  SFV.onlineNav.capturePlayerReturn({ key: 'a', _origin: 'continue' });
  const view2 = { key: 'b', title: '另一片' };
  SFV.onlineNav.capturePlayerReturn(view2);
  SFV.onlineNav.returnFromPlayer();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][1], view2, '后续正常播放的返回目标应生效');
});

// ---------------------------------------------------------------- D. 历史页退出返回历史页

function fakeEl(tag) {
  const listeners = {};
  return {
    tag: tag || 'div',
    children: [],
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, f) { const on = (f === undefined) ? !this._s.has(c) : !!f; if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) { (listeners[t] || []).slice().forEach((fn) => fn(ev || { stopPropagation() {}, preventDefault() {} })); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    textContent: '', innerHTML: '',
    scrollWidth: 0, clientWidth: 0, scrollLeft: 0, offsetWidth: 300,
  };
}

// 按 className 语义化定位节点（深度优先），取代写死下标。
// 教训（2026-10-01）：D1 原先用 host.children[0].children[0]... 取卡片，而 .sfv-wh-page 的
// 首位后来插入了返回钮 .sfv-plex-back（watch-history.js:444），索引整体位移 →
// 取到按钮（children=0）→ 下一层 undefined → 用例永远跑不到断言，伪装成"产品缺陷"。
// 断言"是什么"而不是"在第几个"，DOM 结构再怎么调整都不会失效。
function findByClass(root, cls) {
  if (!root) return null;
  if (root.className && String(root.className).split(/\s+/).indexOf(cls) >= 0) return root;
  const kids = root.children || [];
  for (let i = 0; i < kids.length; i++) {
    const hit = findByClass(kids[i], cls);
    if (hit) return hit;
  }
  return null;
}

test('D1 历史页卡片 activate 通过 smartResumePlay 透传 _origin:"history"', () => {
  const rec = { key: 'cms:1:vid9', seriesKey: 'cms:1:vid9', title: '测试片', ts: Date.now(), sourceId: 'cms:1', vodId: '9', progress: 0.5 };
  let received = null;
  const doc = { createElement: (t) => fakeEl(t), body: fakeEl('body'), documentElement: fakeEl('html') };
  const sandbox = makeSandbox({
    document: doc,
    addEventListener() {}, removeEventListener() {},
    getComputedStyle: () => ({ gap: '18px' }),
    StellaflixVideo: {
      detailSource: { smartResumePlay: (v) => { received = v; } },
    },
  });
  runIn(sandbox, readSrc(VIDEO_DIR, 'watch-history.js'));
  const host = fakeEl('div');
  sandbox.StellaflixVideo.watchHistory.render(host, [rec]);
  // 语义化定位：.sfv-wh-page → … → .sfv-wh-card（不看层级、只看 class）
  const card = findByClass(host, 'sfv-wh-card');
  assert.ok(card && card.tag === 'div', '历史卡片应已渲染（按 .sfv-wh-card 语义定位，非写死下标）');
  card.dispatch('click');

  assert.ok(received, '点击历史卡片应触发 smartResumePlay');
  assert.strictEqual(received._origin, 'history', '历史页续播视图必须带 _origin:history 标记');
  assert.strictEqual(received.key, rec.key, '原记录字段不得丢失');
  assert.strictEqual(rec._origin, undefined, '不得原地污染存储中的历史记录');
});

// ---------------------------------------------------------------- E. 无返回目标时主动复位 Home
// 背景（2026-10-01 复现）：音乐态「点空白关 Home」会把 homeSuppressed 置 true 并摘掉
// body.empty-home-active；#empty-home 默认 opacity:0（index.css:2421），影视态 goHome()
// 又不重置该标记 → 从「接着看」续播退出播放器后首页永久透明，只剩 3D 粒子星空。
// 契约：returnFromPlayer 在无返回目标（continue）时必须主动把 Home 状态复位回来，
// 而不是空操作等运气。

test('E1 continue 续播退出：复位 homeSuppressed 并补回 body.empty-home-active', () => {
  const doc = { createElement: (t) => fakeEl(t), body: fakeEl('body'), documentElement: fakeEl('html') };
  const S = { d: () => doc, openDetailFromMeta: () => {} };
  const SFV = loadOnlineNav(S);
  SFV.home = { render: () => {} };
  SFV.__sandbox.homeSuppressed = true; // 脏状态：Home 已被「点空白」关掉
  assert.strictEqual(doc.body.classList.contains('empty-home-active'), false, '前置：类已被摘');

  SFV.onlineNav.capturePlayerReturn({ key: 'cms:1:vid9', _origin: 'continue' });
  SFV.onlineNav.returnFromPlayer();

  assert.strictEqual(SFV.__sandbox.homeSuppressed, false, 'homeSuppressed 必须复位，否则首页永久不显示');
  assert.strictEqual(doc.body.classList.contains('empty-home-active'), true, '必须补回 empty-home-active');
});

test('E2 continue 续播退出：主动刷新影视首页（home.render）而非空操作', () => {
  const doc = { createElement: (t) => fakeEl(t), body: fakeEl('body'), documentElement: fakeEl('html') };
  const S = { d: () => doc, openDetailFromMeta: () => {} };
  const SFV = loadOnlineNav(S);
  let rendered = 0;
  SFV.home = { render: () => { rendered++; } };
  SFV.onlineNav.capturePlayerReturn({ key: 'cms:1:vid9', _origin: 'continue' });
  SFV.onlineNav.returnFromPlayer();
  assert.strictEqual(rendered, 1, '无返回目标时应主动渲染一次影视首页');
});

test('E3 对照：有返回目标（普通 view）时不触发 Home 复位', () => {
  const doc = { createElement: (t) => fakeEl(t), body: fakeEl('body'), documentElement: fakeEl('html') };
  const calls = [];
  const S = { d: () => doc, openDetailFromMeta: (v) => calls.push(v) };
  const SFV = loadOnlineNav(S);
  let rendered = 0;
  SFV.home = { render: () => { rendered++; } };
  SFV.onlineNav.capturePlayerReturn({ key: 'cms:1:vid9', title: '测试片' });
  SFV.onlineNav.returnFromPlayer();
  assert.strictEqual(calls.length, 1, '有返回目标时仍走详情页重建');
  assert.strictEqual(rendered, 0, '不得额外复位 Home（会与详情页并存冲突）');
});

// ---------------------------------------------------------------- F. resetHomeVisibilityState（进入影视态隔离）
// 背景（2026-10-02）：homeSuppressed 是音乐态「点空白关 Home」写入的**粘性**全局标志。
// 用户在音乐态点过空白后再切进影视态，若影视首页 render() 不复位它，任何一次
// updateEmptyHomeVisibility() 都会读到 true → shouldShowEmptyHomeCore() 返回 false →
// 摘掉 body.empty-home-active → 影视首页透明只剩粒子星空（历史污染跨态带入）。
// 契约：video/home.js 的 render() 与在线返回栈共用这一个实现，保证「进入即隔离」。

test('F1 resetHomeVisibilityState：复位音乐态残留的脏 home 开关状态', () => {
  const doc = { createElement: (t) => fakeEl(t), body: fakeEl('body'), documentElement: fakeEl('html') };
  const S = { d: () => doc, openDetailFromMeta: () => {} };
  const SFV = loadOnlineNav(S);
  const sb = SFV.__sandbox;
  sb.homeSuppressed = true;    // 音乐态「点空白关 Home」的残留污染
  sb.homeForcedOpen = false;
  sb.emptyHomeActive = false;
  doc.body.classList.remove('empty-home-active');
  assert.strictEqual(doc.body.classList.contains('empty-home-active'), false, '前置：类已被摘');

  SFV.onlineNav.resetHomeVisibilityState();

  assert.strictEqual(sb.homeSuppressed, false, 'homeSuppressed 不复位 → shouldShowEmptyHomeCore 判首页不显示');
  assert.strictEqual(sb.homeForcedOpen, true, 'homeForcedOpen 置真以强制显示影视首页');
  assert.strictEqual(sb.emptyHomeActive, true, 'emptyHomeActive 同步复位');
  assert.strictEqual(doc.body.classList.contains('empty-home-active'), true, '必须补回 empty-home-active');
});

test('F2 resetHomeVisibilityState 幂等：连续两次调用结果一致且不抛错', () => {
  const doc = { createElement: (t) => fakeEl(t), body: fakeEl('body'), documentElement: fakeEl('html') };
  const S = { d: () => doc, openDetailFromMeta: () => {} };
  const SFV = loadOnlineNav(S);
  const sb = SFV.__sandbox;
  sb.homeSuppressed = true;
  SFV.onlineNav.resetHomeVisibilityState();
  SFV.onlineNav.resetHomeVisibilityState();
  assert.strictEqual(sb.homeSuppressed, false);
  assert.strictEqual(doc.body.classList.contains('empty-home-active'), true);
});

test('F3 resetHomeVisibilityState 不得调用 updateEmptyHomeVisibility（避免往影视首页塞音乐内容）', () => {
  const doc = { createElement: (t) => fakeEl(t), body: fakeEl('body'), documentElement: fakeEl('html') };
  const S = { d: () => doc, openDetailFromMeta: () => {} };
  const SFV = loadOnlineNav(S);
  let uv = 0;
  let rendered = 0;
  SFV.__sandbox.updateEmptyHomeVisibility = () => { uv += 1; };
  SFV.home = { render: () => { rendered += 1; } };
  SFV.onlineNav.resetHomeVisibilityState();
  assert.strictEqual(uv, 0, 'updateEmptyHomeVisibility 会触发音乐态 renderHomeDiscover/loadHomeDiscover');
  assert.strictEqual(rendered, 0, '纯状态复位不负责渲染，渲染由调用方（home.render / returnFromPlayer）决定');
});

test('D2 _origin:"history" 的 view：退出播放器重开历史页而非详情页', () => {
  const calls = [];
  const doc = { createElement: (t) => fakeEl(t), body: fakeEl('body'), documentElement: fakeEl('html') };
  const S = {
    d: () => doc,
    el: (t) => fakeEl(t),
    openDetailFromMeta: (v) => calls.push(['detail', v]),
  };
  const sandbox = makeSandbox({
    document: doc,
    StellaflixVideo: {
      onlineShared: S,
      onlineCore: {},
      router: { go: (id) => calls.push(['router.go', id]), setHost() {} },
    },
  });
  runIn(sandbox, readSrc(VIDEO_DIR, 'online-nav.js'));
  const nav = sandbox.StellaflixVideo.onlineNav;
  nav.capturePlayerReturn({ key: 'cms:1:vid9', title: '测试片', _origin: 'history' });
  nav.returnFromPlayer();
  assert.deepStrictEqual(calls, [['router.go', 'history']], '应重开历史页（router.go("history")），不重建详情页');
});
