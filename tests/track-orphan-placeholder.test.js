'use strict';

/**
 * 追片页孤儿键占位卡测试（T-孤儿占位卡）
 *
 * 缺陷：tab 计数取 getKeysByTrack().length（全键），卡片取 resolveList()（仅 meta/历史可解析键）。
 * 无 meta 的非 tmdb 源键两头落空：计数含它、渲染静默丢它 → 「在看 4」只显示 3 张卡。
 * 期望：每个 track 键必有对应卡片（元数据缺失时渲染 🎬 占位卡），计数与卡片恒对齐。
 *
 * 运行：node --test tests/track-orphan-placeholder.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---------------- 最小假 DOM ----------------
function matchesToken(node, token) {
  if (node._nottag === token.replace(/^\./, '')) return false;
  const attrRe = /\[([\w-]+)="([^"]*)"\]/g;
  let m;
  let rest = token;
  while ((m = attrRe.exec(token))) {
    if (String(node.attrs && node.attrs[m[1]]) !== m[2]) return false;
  }
  rest = token.replace(attrRe, '');
  const classes = rest.split('.').filter(Boolean); // 首段为空（'.a.b'）
  if (classes.length === 1 && classes[0] === token.replace(/^\./, '') && !token.startsWith('.')) {
    // 纯标签选择器（本测试不需要）
    return node.tag === classes[0];
  }
  for (const c of classes) if (!node.classList.contains(c)) return false;
  return true;
}

function makeNode(tag) {
  const classes = new Set();
  const node = {
    tag,
    children: [],
    parentNode: null,
    attrs: {},
    style: {},
    textContent: '',
    _listeners: {},
    classList: {
      add: function (c) { classes.add(c); },
      remove: function (c) { classes.delete(c); },
      contains: function (c) { return classes.has(c); },
      toggle: function (c, force) {
        if (force === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
        else if (force) classes.add(c); else classes.delete(c);
      },
    },
    setAttribute: function (k, v) { node.attrs[k] = String(v); },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null; },
    appendChild: function (c) { c.parentNode = node; c.parentElement = node; node.children.push(c); return c; },
    removeChild: function (c) {
      const i = node.children.indexOf(c);
      if (i >= 0) node.children.splice(i, 1);
      c.parentNode = null; c.parentElement = null;
      return c;
    },
    addEventListener: function (t, f) { (node._listeners[t] = node._listeners[t] || []).push(f); },
    removeEventListener: function () {},
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 }; },
    animate: function () { return {}; },
    closest: function () { return null; },
    querySelector: function (sel) { return queryList(node, sel, true)[0] || null; },
    querySelectorAll: function (sel) { return queryList(node, sel, false); },
    fire: function (t, ev) { (node._listeners[t] || []).forEach(function (f) { f(ev || { stopPropagation: function () {} }); }); },
  };
  Object.defineProperty(node, 'className', {
    get: function () { return Array.from(classes).join(' '); },
    set: function (v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach(function (c) { classes.add(c); }); },
  });
  let _html = '';
  Object.defineProperty(node, 'innerHTML', {
    get: function () { return _html; },
    set: function (v) { _html = String(v); if (!v) { node.children.forEach(function (c) { c.parentNode = null; }); node.children = []; } },
  });
  node.parentElement = null;
  return node;
}

function descendants(root, out) {
  root.children.forEach(function (c) { out.push(c); descendants(c, out); });
  return out;
}

function queryList(root, sel, firstOnly) {
  const parts = sel.trim().split(/\s+/);
  let pool = descendants(root, []);
  for (let level = 0; level < parts.length; level++) {
    const token = parts[level];
    const matched = pool.filter(function (n) { return matchesToken(n, token); });
    if (level === parts.length - 1) return firstOnly ? matched.slice(0, 1) : matched;
    pool = matched.reduce(function (acc, n) { return descendants(n, acc); }, []);
  }
  return [];
}

// ---------------- 沙箱装载 ----------------
function setup() {
  const store = {};
  const document = makeNode('#document');
  const body = makeNode('body');
  body.body = body;
  const sandbox = {
    console: { log: function () {}, warn: function () {}, error: function () {} },
    JSON, Math, Date, String, Number, Array, Object, Boolean, Promise, RegExp, Set,
    parseInt, parseFloat, isNaN, setTimeout, clearTimeout, Error,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; },
    },
    document: Object.assign(document, { body: body, createElement: function (t) { return makeNode(t); }, addEventListener: function () {} }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const dir = path.join(__dirname, '..', 'public', 'video');
  ['model.js', 'online-core.js', 'online-shared.js', 'online-track.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  });
  const SFV = sandbox.StellaflixVideo;
  const S = SFV.onlineShared;
  S.bodyEl = makeNode('div');
  S.titleEl = makeNode('div');
  S.setNote = function () {}; // online.js 协调器槽，本测试仅要求可调用
  S.openDetailFromMeta = function () {};
  return { SFV: SFV, S: S, sandbox: sandbox };
}

function trackCards(S) {
  return S.bodyEl.querySelectorAll('.sfv-track-card');
}

const flush = function () { return new Promise(function (r) { setTimeout(r, 0); }); };

// ---------------- 测试 ----------------
test('在看：无 meta 的非 tmdb 源键渲染占位卡，计数与卡片对齐', async () => {
  const { SFV, S } = setup();
  SFV.model.setMeta({ key: 'tmdb:movie:2', title: '有元数据片', pic: 'https://x/p.jpg' });
  SFV.model.setTrackStatus('tmdb:movie:2', 'watching');
  SFV.model.setTrackStatus('srcX:9', 'watching'); // 孤儿：无 meta / 无历史 / 非 tmdb
  S.renderTrackPage();
  const cards = trackCards(S);
  assert.strictEqual(cards.length, 2, '计数=2 必须渲染 2 张卡（含 1 张占位卡）');
  const watchingTab = S.bodyEl.querySelector('.sfv-track-tab[data-status="watching"]');
  const countEl = watchingTab.querySelector('.sfv-track-count');
  assert.strictEqual(countEl.textContent, '2', 'tab 计数应为 2');
});

test('在看：全部为孤儿键时也渲染网格与占位卡（不再提前 return）', async () => {
  const { SFV, S } = setup();
  SFV.model.setTrackStatus('srcY:1', 'watching');
  S.renderTrackPage();
  const cards = trackCards(S);
  assert.strictEqual(cards.length, 1, '仅孤儿键时也必须出占位卡');
});

test('占位卡：不绑详情点击，但状态按钮可循环至「未追」完成自助清理', async () => {
  const { SFV, S } = setup();
  SFV.model.setTrackStatus('srcZ:5', 'watching');
  S.renderTrackPage();
  const card = trackCards(S)[0];
  assert.ok(!card._listeners.click || !card._listeners.click.length, '占位卡不得绑定 openDetailFromMeta 点击（无 sourceId 打不开）');
  const fav = card.querySelector('.sfv-track-card-fav');
  assert.ok(fav, '占位卡须带状态按钮');
  fav.fire('click'); fav.fire('click'); fav.fire('click'); fav.fire('click'); fav.fire('click');
  // watching→planToWatch→onHold→watched→abandoned→null
  assert.strictEqual(SFV.model.getTrackStatus('srcZ:5'), null, '循环 5 次后应回到未追（键被清除）');
});

test('tmdb 键补全失败（reject）后补占位卡，计数与卡片对齐', async () => {
  const { SFV, S } = setup();
  SFV.tmdb = { getDetails: function () { return Promise.reject(new Error('network down')); } };
  SFV.model.setTrackStatus('tmdb:movie:77', 'watching'); // 无 meta → 走补全 → 失败
  S.renderTrackPage();
  await flush();
  const cards = trackCards(S);
  assert.strictEqual(cards.length, 1, '补全失败后须以占位卡兜底');
});

test('tmdb 键补全返回空结果后补占位卡', async () => {
  const { SFV, S } = setup();
  SFV.tmdb = { getDetails: function () { return Promise.resolve(null); } };
  SFV.model.setTrackStatus('tmdb:movie:88', 'watching');
  S.renderTrackPage();
  await flush();
  assert.strictEqual(trackCards(S).length, 1, '补全空结果须以占位卡兜底');
});

test('inflight 的 tmdb 键在重渲染时以占位卡对齐（旧渲染回调已失效）', async () => {
  const { SFV, S } = setup();
  S.trackMetaInflight['tmdb:movie:99'] = true; // 模拟上一渲染的补全仍在途
  SFV.model.setTrackStatus('tmdb:movie:99', 'watching');
  S.renderTrackPage();
  assert.strictEqual(trackCards(S).length, 1, 'inflight 键本轮不重复请求，但须出占位卡保证对齐');
});
