'use strict';

/**
 * 回归测试：影视浏览层（#sfv-browse）内的空白点击不得触发音乐态「点空白关 Home」。
 *
 * 背景（2026-09-25 实测复现）：home→片库页浏览（海报墙挂载后点/拖任意非按钮区域）
 * → 04-home-empty-wallpaper.js 的 document 捕获阶段空白关闭处理器把 body.empty-home-active
 * 摘掉（片库页覆盖层透明铺满视口，点击坐标必然落在 #empty-home 矩形内）→
 * 点返回关闭浏览层后首页已透明 → 用户只见粒子星空。
 *
 * 契约：isHomeBlankDismissClick 在 #sfv-browse.sfv-show（浏览层可见）时一律返回 false；
 * 音乐态（无浏览层）行为不变。
 *
 * 运行：node --test tests/home-blank-dismiss-browse-guard.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '04-home-empty-wallpaper.js'),
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
  };
}

function loadModule() {
  const body = makeEl();
  const home = makeEl();
  const browse = makeEl();
  const doc = {
    body,
    documentElement: makeEl(),
    createElement: () => makeEl(),
    getElementById: (id) => (id === 'empty-home' ? home : id === 'sfv-browse' ? browse : null),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  };
  const sandbox = {
    document: doc,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    clearTimeout,
    Promise, Date, Math, JSON, RegExp, String, Number, Object, Array, Error, Set, Map,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  sandbox.emptyHomeActive = true; // 模拟 Home 正显示
  return { sandbox, body, home, browse };
}

function blankClickEvent() {
  return {
    button: 0,
    defaultPrevented: false,
    clientX: 640,
    clientY: 400,
    target: { closest: () => null }, // 非按钮/链接/输入框，也不在任何受保护弹层内
  };
}

test('音乐态基线：Home 显示时空白点击仍判定为关闭 Home（行为不变）', () => {
  const { sandbox } = loadModule();
  assert.strictEqual(sandbox.isHomeBlankDismissClick(blankClickEvent()), true);
});

test('片库页可见时：浏览层内空白点击不得判定为关闭 Home', () => {
  const { sandbox, browse } = loadModule();
  browse.classList.add('sfv-show'); // #sfv-browse 覆盖层打开（片库/历史/任何浏览页）
  assert.strictEqual(
    sandbox.isHomeBlankDismissClick(blankClickEvent()),
    false,
    '浏览层在 Home 之上，其内点击不是「Home 空白」语义，否则返回后首页已被摘类 → 只剩粒子星空'
  );
});

test('对照：浏览层存在但未显示（sfv-show 已移除）时不拦截', () => {
  const { sandbox, browse } = loadModule();
  browse.classList.add('sfv-browse--browse'); // 有类但层未打开
  assert.strictEqual(sandbox.isHomeBlankDismissClick(blankClickEvent()), true);
});
