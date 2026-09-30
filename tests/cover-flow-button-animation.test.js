'use strict';

/**
 * 浏览厅 Cover Flow（cover-flow.js）— 按键/按钮切换动画契约
 * 运行：node --test tests/cover-flow-button-animation.test.js
 *
 * 缺陷背景：滑动/滚轮经 push()+settle() 走 animateToTarget 逐帧插值（有动画），
 * 而 next()/prev()/goTo()/键盘 ←→ 直接 syncPosition 瞬移（无动画）。
 * 本测试锁定：任何切换入口都必须逐帧逼近目标，且 goTo 走环形最短路径。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parent: null,
    style: {},
    attributes: {},
    listeners: {},
    textContent: '',
  };
  el.appendChild = function (child) {
    child.parent = this;
    this.children.push(child);
    return child;
  };
  el.removeChild = function (child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parent = null;
    return child;
  };
  el.setAttribute = function (name, value) { this.attributes[name] = String(value); };
  el.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  };
  el.addEventListener = function (type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  };
  el.removeEventListener = function (type, fn) {
    const list = this.listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  el.getBoundingClientRect = function () {
    return { top: 0, bottom: 1000, left: 0, right: 1600, width: 1600, height: 1000 };
  };
  return el;
}

function fire(el, type, event) {
  const ev = Object.assign({ type, stopPropagation() {}, preventDefault() {} }, event || {});
  (el.listeners[type] || []).slice().forEach((fn) => fn(ev));
}

function setup(itemCount) {
  const frames = [];
  let rafId = 0;
  const sandbox = {
    console, Math, Number, Array, Object, String, Boolean, Promise, Set, Map, JSON, Date,
    setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => { frames.push(fn); return ++rafId; },
    cancelAnimationFrame: () => {},
  };
  sandbox.window = sandbox;
  const store = {};
  sandbox.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  sandbox.document = {
    createElement: (tag) => makeEl(tag),
    getElementById: () => null,
    body: makeEl('body'),
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/cover-flow.js'), sandbox, { filename: 'cover-flow.js' });

  const stage = makeEl('div');
  const items = [];
  for (let i = 0; i < itemCount; i += 1) {
    items.push({ id: 'tmdb:movie:' + i, title: '片名 ' + i });
  }
  const activeChanges = [];
  const api = sandbox.StellaflixVideo.coverFlow.mount(stage, {
    loadItems: (p) => Promise.resolve(p === 1 ? items : []),
    onActiveChange: (it, idx) => activeChanges.push([it && it.id, idx]),
  });

  const runFrames = (n) => {
    for (let i = 0; i < n && frames.length; i += 1) frames.shift()();
  };
  const cardsWrap = stage.children[0];
  const cardEl = (i) => cardsWrap.children[i];
  const xOf = (i) => {
    const m = /translate3d\((-?[\d.]+)px/.exec(cardEl(i).style.transform || '');
    return m ? Number(m[1]) : NaN;
  };
  return { api, stage, runFrames, xOf, cardEl, frames, activeChanges, itemCount: items.length };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('next() 逐帧插值切换到下一张，而非瞬移', async () => {
  const env = setup(6);
  await flush();
  assert.strictEqual(env.cardEl(0).style.transform.includes('translate3d(0px'), true, '初始 0 号卡应居中');

  env.api.next();
  env.runFrames(1);
  const mid = env.xOf(0);
  assert.ok(mid < 0 && mid > -306, `第一帧后 0 号卡应处于中间态（实测 x=${mid}，应在 -306~0 之间）`);

  env.runFrames(300);
  assert.ok(Math.abs(env.xOf(0) + 306) < 1, `收敛后 0 号卡应落在左侧第一位（实测 x=${env.xOf(0)}）`);
  assert.ok(Math.abs(env.xOf(1)) < 1, `收敛后 1 号卡应居中（实测 x=${env.xOf(1)}）`);
  assert.deepStrictEqual(env.activeChanges[env.activeChanges.length - 1], ['tmdb:movie:1', 1]);
});

test('键盘 ArrowRight 逐帧插值切换，而非瞬移', async () => {
  const env = setup(6);
  await flush();

  fire(env.stage, 'keydown', { key: 'ArrowRight' });
  env.runFrames(1);
  const mid = env.xOf(0);
  assert.ok(mid < 0 && mid > -306, `第一帧后应处于中间态（实测 x=${mid}）`);

  env.runFrames(300);
  assert.ok(Math.abs(env.xOf(1)) < 1, `收敛后 1 号卡应居中（实测 x=${env.xOf(1)}）`);
});

test('goTo 走环形最短路径且带动画：从 0 跳到末位应向左滑一张到位', async () => {
  const env = setup(6);
  await flush();

  env.api.goTo(5);
  env.runFrames(1);
  const mid = env.xOf(5);
  assert.ok(mid !== 0, '第一帧不应已直达终点（须有过渡）');
  assert.ok(Math.abs(mid) < 306, `末位卡应从左侧近邻进入（|x|<306，实测 x=${mid}），不得反向扫过整面墙`);

  env.runFrames(300);
  assert.ok(Math.abs(env.xOf(5)) < 1, `收敛后 5 号卡应居中（实测 x=${env.xOf(5)}）`);
  assert.ok(Math.abs(env.xOf(0) - 306) < 1, `收敛后 0 号卡应落在右侧第一位（实测 x=${env.xOf(0)}）`);
  assert.deepStrictEqual(env.activeChanges[env.activeChanges.length - 1], ['tmdb:movie:5', 5]);
});

test('prev() 从首位环形回退到末位，带动画', async () => {
  const env = setup(6);
  await flush();

  env.api.prev();
  env.runFrames(1);
  const mid = env.xOf(5);
  assert.ok(mid !== 0 && Math.abs(mid) < 306, `第一帧 5 号卡应从相邻位进入中间态（实测 x=${mid}）`);

  env.runFrames(300);
  assert.ok(Math.abs(env.xOf(5)) < 1, `收敛后 5 号卡应居中（实测 x=${env.xOf(5)}）`);
});
