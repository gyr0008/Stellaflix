'use strict';

/**
 * B 方案（2026-10-11）：影视态专属 Home 收起开关。
 *
 * 背景：2026-10-02 契约把「Home 开关」定为音乐态专属——影视态点 Home 一律委托
 * SFV.online.goHome()，已在首页时再点没有任何反馈（用户感知为"按钮被锁"）。
 * B 方案给影视态新增独立开关：首页显示中点 Home → 收起首页 UI 露出 3D 星空（body.video-home-collapsed），
 * 再点恢复。关键红线：绝不触碰音乐态粘性标志 homeSuppressed/homeForcedOpen，
 * 也不摘 empty-home-active（音乐可见性链保持完整）——10-02 事故根因就是粘性标志跨态残留。
 *
 * 收起必须是"非粘性"：任何进入影视首页的渲染路径（resetHomeVisibilityState）与
 * 切回音乐态（restoreMusic）都必须复位它，否则会复发"首页永久透明"。
 *
 * 运行：node --test tests/video-home-collapse-toggle.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'modules', '05-playback', '04-home-empty-wallpaper.js'),
  'utf8'
);

function fakeClassList() {
  const s = new Set();
  return {
    add: (c) => s.add(c),
    remove: (c) => s.delete(c),
    toggle: (c, on) => { if (on === undefined) on = !s.has(c); on ? s.add(c) : s.delete(c); },
    contains: (c) => s.has(c),
  };
}

function makeEl(rect) {
  return {
    classList: fakeClassList(),
    style: {},
    children: [],
    getBoundingClientRect: () => rect || { left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800 },
    addEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains(node) {
      if (node === this) return true;
      for (const c of this.children) { if (c && c.contains && c.contains(node)) return true; }
      return false;
    },
    closest() { return null; },
  };
}

function loadModule() {
  const body = makeEl();
  const els = {
    'empty-home': makeEl(),
    'sfv-browse': makeEl(),
    'sfv-overlay': makeEl(),
    'sfv-search-page': makeEl(),
    'bottom-bar': makeEl(),
    'search-area': makeEl(),
  };
  const doc = {
    body,
    documentElement: makeEl(),
    createElement: () => makeEl(),
    getElementById: (id) => els[id] || null,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  };
  const toasts = [];
  const sandbox = {
    document: doc,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    clearTimeout,
    showToast: (m) => toasts.push(m),
    Promise, Date, Math, JSON, RegExp, String, Number, Object, Array, Error, Set, Map,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  // 音乐态粘性标志的真实初值（00-state 模块定义），影视分支全程不得改写
  sandbox.homeSuppressed = false;
  // 影视态 + 首页显示中（home.js render 的空态基线：video-space-active + empty-home-active 都在 body 上）
  body.classList.add('video-space-active');
  const onlineCalls = { goHome: 0 };
  sandbox.StellaflixVideo = { online: { goHome: () => { onlineCalls.goHome += 1; } } };
  return { sandbox, doc, body, els, toasts, onlineCalls };
}

// ---------------------------------------------------------------- goHome 收起/恢复

test('影视态·首页显示中：点 Home 收起首页，专属类+标志出现，音乐粘性标志零污染', () => {
  const { sandbox, body, onlineCalls } = loadModule();
  body.classList.add('empty-home-active');
  sandbox.homeSuppressed = false;
  sandbox.homeForcedOpen = false;
  sandbox.goHome();
  assert.strictEqual(sandbox.videoHomeCollapsed, true, '收起态必须记在影视专属标志上');
  assert.ok(body.classList.contains('video-home-collapsed'), '收起靠 body 类层，CSS 据此隐藏 #empty-home');
  assert.strictEqual(onlineCalls.goHome, 0, '收起不是回首页，不该触发委托重渲染');
  assert.strictEqual(sandbox.homeSuppressed, false, '绝不写 homeSuppressed（粘性，10-02 事故根因）');
  assert.strictEqual(sandbox.homeForcedOpen, false, '绝不写 homeForcedOpen');
  assert.ok(body.classList.contains('empty-home-active'), '不摘 empty-home-active，音乐可见性链保持完整');
});

test('影视态·收起中：再点 Home 恢复，类摘除并委托回首页重渲染', () => {
  const { sandbox, body, onlineCalls } = loadModule();
  body.classList.add('empty-home-active');
  sandbox.goHome(); // 第一次：收起
  assert.strictEqual(sandbox.videoHomeCollapsed, true);
  sandbox.goHome(); // 第二次：恢复
  assert.strictEqual(sandbox.videoHomeCollapsed, false, '恢复必须清专属标志（非粘性）');
  assert.ok(!body.classList.contains('video-home-collapsed'));
  assert.strictEqual(onlineCalls.goHome, 1, '恢复走 SFV.online.goHome（回首页+重渲染）');
  assert.strictEqual(sandbox.homeSuppressed, false, '恢复路径同样不得污染音乐标志');
});

// ---------------------------------------------------------------- 「在首页」判定：其它层打开时只委托

test('影视态·浏览层打开（#sfv-browse.sfv-show）：点 Home 照常委托回首页，不收起', () => {
  const { sandbox, body, els, onlineCalls } = loadModule();
  body.classList.add('empty-home-active');
  els['sfv-browse'].classList.add('sfv-show');
  sandbox.goHome();
  assert.strictEqual(sandbox.videoHomeCollapsed, false, '不在首页时 Home 键语义仍是"回首页"');
  assert.strictEqual(onlineCalls.goHome, 1);
});

test('影视态·播放器打开（#sfv-overlay.sfv-show）：点 Home 照常委托，不收起', () => {
  const { sandbox, body, els, onlineCalls } = loadModule();
  body.classList.add('empty-home-active');
  els['sfv-overlay'].classList.add('sfv-show');
  sandbox.goHome();
  assert.strictEqual(sandbox.videoHomeCollapsed, false);
  assert.strictEqual(onlineCalls.goHome, 1);
});

test('影视态·搜索页打开（#sfv-search-page.sfv-search-open）：点 Home 照常委托，不收起', () => {
  const { sandbox, body, els, onlineCalls } = loadModule();
  body.classList.add('empty-home-active');
  els['sfv-search-page'].classList.add('sfv-search-open');
  sandbox.goHome();
  assert.strictEqual(sandbox.videoHomeCollapsed, false);
  assert.strictEqual(onlineCalls.goHome, 1);
});

test('影视态·首页未显示（无 empty-home-active）：点 Home 只委托，不收起', () => {
  const { sandbox, body, onlineCalls } = loadModule();
  sandbox.goHome();
  assert.strictEqual(sandbox.videoHomeCollapsed, false);
  assert.strictEqual(onlineCalls.goHome, 1);
});

// ---------------------------------------------------------------- 复位（防粘性泄漏）

test('resetVideoHomeCollapsed：标志与 body 类同时清掉', () => {
  const { sandbox, body } = loadModule();
  body.classList.add('empty-home-active');
  sandbox.goHome(); // 收起
  sandbox.resetVideoHomeCollapsed();
  assert.strictEqual(sandbox.videoHomeCollapsed, false);
  assert.ok(!body.classList.contains('video-home-collapsed'));
});

test('契约：online-nav.resetHomeVisibilityState 复位收起态（进入影视首页任何渲染路径都不带回收起）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'video', 'online-nav.js'), 'utf8');
  const fnStart = src.indexOf('function resetHomeVisibilityState()');
  assert.ok(fnStart >= 0, 'resetHomeVisibilityState 必须存在');
  const fnBody = src.slice(fnStart, src.indexOf('\n  }', fnStart) + 4);
  assert.ok(/resetVideoHomeCollapsed/.test(fnBody),
    '影视首页渲染前必须复位 videoHomeCollapsed，否则"进首页仍透明"复发 10-02 事故形态');
});

test('契约：home.js restoreMusic 切回音乐态时复位收起态（跨态不残留）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'video', 'home.js'), 'utf8');
  const fnStart = src.indexOf('function restoreMusic()');
  assert.ok(fnStart >= 0, 'restoreMusic 必须存在');
  const fnBody = src.slice(fnStart, fnStart + 3000);
  assert.ok(/resetVideoHomeCollapsed/.test(fnBody),
    'video-home-collapsed 挂在 body 上，切回音乐态不复位会把收起态带进音乐首页');
});

// ---------------------------------------------------------------- CSS 契约

test('CSS 契约：index.css 有 body.video-home-collapsed 对 #empty-home 的隐藏覆写', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'index.css'), 'utf8');
  const ruleStart = css.indexOf('body.video-home-collapsed #empty-home');
  assert.ok(ruleStart >= 0, '收起视觉由该类承担：opacity 0 + pointer-events none（!important，与 splash/immersive 覆写同法）');
  const block = css.slice(ruleStart, css.indexOf('}', ruleStart));
  assert.ok(/opacity:\s*0\s*!important/.test(block), block);
  assert.ok(/pointer-events:\s*none\s*!important/.test(block), block);
});
