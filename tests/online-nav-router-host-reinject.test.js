'use strict';

/**
 * 片库空白事故回归（2026-09-26）：
 * 首次 ensure() 若早于 router.js 加载，SFV.router 缺失导致 setHost 被守卫静默跳过；
 * 之后 overlay 已存在、ensure 幂等早退，router host 永久 null → 所有 router 页（片库等）
 * 在 `if (!p || !host) return;` 处静默不挂载。
 * 要求：ensure() 早退分支对 setHost 做幂等重注入。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function mkClassList(set) {
  return {
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    toggle(c, on) {
      if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); }
      else if (on) set.add(c);
      else set.delete(c);
    },
    contains(c) { return set.has(c); }
  };
}

function mkNode(tag) {
  const set = new Set();
  const node = {
    tagName: tag, id: '', type: '', className: '',
    innerHTML: '', textContent: '',
    style: { setProperty() {}, removeProperty() {} },
    children: [],
    classList: mkClassList(set),
    setAttribute() {},
    appendChild(c) { node.children.push(c); return c; },
    addEventListener() {}
  };
  return node;
}

function buildSandbox() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      createElement: mkNode,
      getElementById() { return null; },
      body: mkNode('body'),
      documentElement: mkNode('html'),
      addEventListener() {}
    },
    addEventListener() {},
    setTimeout() { return 0; },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;

  const S = {
    overlay: null, headEl: null, backBtn: null, titleEl: null, actsEl: null,
    closeBtn: null, bodyEl: null, noteEl: null,
    stack: [], current: null, uiMode: 'view', activePageId: null,
    d() { return sandbox.document; },
    isVideoSpace() { return true; },
    hasSources() { return false; },
    sourceById() { return null; },
    el: (tag, cls, text) => {
      const n = mkNode(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    },
    toast() {}
  };
  sandbox.StellaflixVideo = { onlineShared: S, onlineCore: {} };
  return { sandbox, S };
}

test('router 晚就绪：二次 ensure() 必须补注入 router host（幂等重设）', () => {
  const { sandbox, S } = buildSandbox();
  vm.createContext(sandbox);
  // 加载期无 SFV.router（模拟 router.js 尚未执行）
  vm.runInContext(read('public/video/online-nav.js'), sandbox, { filename: 'online-nav.js' });

  S.ensure();
  assert.ok(S.overlay, '首次 ensure 应创建 overlay');
  assert.ok(S.bodyEl, '首次 ensure 应创建 bodyEl');

  // router 此刻才就绪
  const setHostCalls = [];
  sandbox.StellaflixVideo.router = {
    setHost(h) { setHostCalls.push(h); },
    go() {}, currentId() { return null; }, listIds() { return []; }
  };

  const overlay1 = S.overlay;
  S.ensure(); // 早退分支
  assert.strictEqual(S.overlay, overlay1, '二次 ensure 不得重建 overlay');
  assert.strictEqual(setHostCalls.length, 1, '二次 ensure 应补调 setHost');
  assert.strictEqual(setHostCalls[0], S.bodyEl, 'setHost 应注入当前 bodyEl');
});

test('router 已就绪：首次 ensure() 正常注入 host（原行为不回退）', () => {
  const { sandbox, S } = buildSandbox();
  const setHostCalls = [];
  sandbox.StellaflixVideo.router = {
    setHost(h) { setHostCalls.push(h); },
    go() {}, currentId() { return null; }, listIds() { return []; }
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/online-nav.js'), sandbox, { filename: 'online-nav.js' });

  S.ensure();
  assert.strictEqual(setHostCalls.length, 1);
  assert.strictEqual(setHostCalls[0], S.bodyEl);
});
