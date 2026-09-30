'use strict';

/**
 * 回归测试（2026-09-26 需求）：片单弹窗 → 选片单 → 点条目进详情页 → 退出详情页
 * 须回到进入详情前的片单页（弹窗二级页原样恢复），而非直接回 home。
 *
 * 契约：
 *  A. openItemDetail 不再整关弹窗，改为「暂存 park」：mask 收起但 state.collection 保留；
 *     进详情前 SFV.online.setDetailOrigin('collections')；
 *  B. resumeFromDetail() 仅复原可见性（不重建、不清空二级页）；未 park 时为空操作；
 *  C. park 期间弹窗的 Esc/Tab 键处理不得劫持（详情页在上层）；
 *  D. online-nav.goBack：栈底 detail 且 from==='collections' → restoreCollectionsPage
 *     （收浏览层 + resumeFromDetail），而非 close() 回首页；from==='browse' 对照不变；
 *  E. close()（✕/回首页等整退路径）丢弃 park 的弹窗，防僵尸态；
 *  F. openDetailFromMeta 把 _detailOrigin==='collections' 映射进 view.from。
 *
 * 运行：node --test tests/home-collections-detail-return.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const indexHtml = read('public/index.html');
const collectionsSrc = read('public/video/collections.js');
const overlaySrc = read('public/video/home-collections-overlay.js');
const onlineNavSrc = read('public/video/online-nav.js');
const onlineDetailSrc = read('public/video/online-detail.js');
const onlineSrc = read('public/video/online.js');

// ---------------------------------------------------------------- 浮层 JSDOM 环境

function makeItems(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: i + 1, mediaType: 'movie', title: prefix + (i + 1), year: 2020,
      poster: 'https://img.example/' + prefix + (i + 1) + '.jpg',
      rating: 7, overview: '', backdrop: '', genreIds: [28], originalLanguage: 'en',
    });
  }
  return out;
}

function buildEnv() {
  const dom = new JSDOM(indexHtml, { url: 'http://localhost:3000/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  const calls = [];
  win.StellaflixVideo = {
    tmdb: {
      hasKey: () => true,
      trending: () => Promise.resolve(makeItems(20, 'T')),
      popular: () => Promise.resolve(makeItems(20, 'P')),
      upcoming: () => Promise.resolve(makeItems(12, 'U')),
      discover: () => Promise.resolve(makeItems(20, 'D')),
      getCollection: () => Promise.resolve({ parts: makeItems(8, 'C') }),
      getDetails: (id) => Promise.resolve({ id, title: 'S' + id, year: 2010, poster: 'https://img.example/s' + id + '.jpg' }),
      genreNames: () => '',
      regionLabel: () => '',
    },
    online: {
      setDetailOrigin: (o) => calls.push(['setDetailOrigin', o]),
      openDetailFromMeta: (it) => calls.push(['openDetailFromMeta', it]),
    },
  };
  win.eval(collectionsSrc);
  win.eval(overlaySrc);
  const doc = win.document;
  const mask = doc.getElementById('home-video-collections-mask');
  const list = doc.getElementById('home-video-collections-list');
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  const press = (key) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { win, doc, SFV: win.StellaflixVideo, mask, list, calls, settle, click, press };
}

// 打开弹窗 → 进第一个片单二级页（条目已渲染）
async function openToItems(env) {
  env.SFV.homeCollectionsOverlay.open();
  const card = env.list.querySelector('[data-wc-id]');
  assert.ok(card, '一级 tab 下应有片单卡');
  env.click(card);
  await env.settle();
  const item = env.list.querySelector('[data-wc-item]');
  assert.ok(item, '二级页应渲染条目（getItems 已 resolve）');
  return item;
}

// ---------------------------------------------------------------- A/B/C. 浮层 park/resume

test('A 点条目：弹窗只暂存（mask 收起、二级页状态保留），并打 collections 来源后进详情', async () => {
  const env = buildEnv();
  const item = await openToItems(env);
  env.click(item);
  await env.settle();

  assert.ok(!env.mask.classList.contains('show'), '进详情时弹窗须收起（暂存）');
  const origins = env.calls.filter((c) => c[0] === 'setDetailOrigin');
  assert.deepStrictEqual(origins, [['setDetailOrigin', 'collections']], '进详情前须 setDetailOrigin("collections")');
  const opens = env.calls.filter((c) => c[0] === 'openDetailFromMeta');
  assert.strictEqual(opens.length, 1, '应调用 openDetailFromMeta 一次');
  assert.strictEqual(opens[0][1].title, 'T1', '传入的应是所点条目');

  // 暂存 ≠ 关闭：resumeFromDetail 须原样恢复二级页
  env.SFV.homeCollectionsOverlay.resumeFromDetail();
  assert.ok(env.mask.classList.contains('show'), 'resumeFromDetail 须复原弹窗可见');
  assert.ok(env.list.querySelector('[data-wc-item]'), '恢复后二级页条目列表须原样在场（不重建不降级）');
});

test('B resumeFromDetail 未暂存时为空操作；普通 close 行为不变', async () => {
  const env = buildEnv();
  env.SFV.homeCollectionsOverlay.open();
  env.SFV.homeCollectionsOverlay.resumeFromDetail(); // 未 park → 不得报错，也不得改变状态
  assert.ok(env.mask.classList.contains('show'), 'open 后未 park：resumeFromDetail 不应收起');
  env.SFV.homeCollectionsOverlay.close();
  assert.ok(!env.mask.classList.contains('show'), 'close 仍收起弹窗');
  env.SFV.homeCollectionsOverlay.resumeFromDetail();
  assert.ok(!env.mask.classList.contains('show'), 'close（非 park）后 resumeFromDetail 不得复活弹窗');
});

test('C park 期间 Esc 不劫持：详情层返回前弹窗键处理保持沉默', async () => {
  const env = buildEnv();
  const item = await openToItems(env);
  env.click(item);
  await env.settle();
  env.press('Escape'); // 模拟详情页按 Esc（浏览层自行处理），弹窗层不得动作
  env.SFV.homeCollectionsOverlay.resumeFromDetail();
  assert.ok(env.mask.classList.contains('show'), 'park 中 Esc 后仍应可恢复（未被误关）');
  assert.ok(env.list.querySelector('[data-wc-item]'), 'park 中 Esc 不得把二级页误退回一级');
});

test('E discardParked：整退浏览层时丢弃暂存弹窗，之后 resumeFromDetail 失效', async () => {
  const env = buildEnv();
  const item = await openToItems(env);
  env.click(item);
  await env.settle();
  env.SFV.homeCollectionsOverlay.discardParked();
  assert.ok(!env.mask.classList.contains('show'), 'discard 后保持收起');
  env.SFV.homeCollectionsOverlay.resumeFromDetail();
  assert.ok(!env.mask.classList.contains('show'), 'discard 后不得复活（防僵尸 park 态）');
  // 重新打开须回一级
  env.SFV.homeCollectionsOverlay.open();
  assert.ok(env.mask.classList.contains('show'), '重新 open 正常显示');
  assert.ok(env.list.querySelector('[data-wc-id]'), '重新 open 须回一级片单卡列表');
});

// ---------------------------------------------------------------- D. goBack collections 分支

function fakeEl(tag) {
  const listeners = {};
  return {
    tag: tag || 'div',
    children: [],
    style: { setProperty() {}, removeProperty() {}, removeItem() {} },
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
    querySelector() { return null; }, querySelectorAll() { return []; },
    textContent: '', innerHTML: '',
  };
}

function loadNav(S, extraSFV, doc) {
  const sandbox = {
    document: doc,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    clearTimeout: (id) => clearTimeout(id),
    Promise, Date, Math, JSON, RegExp, String, Number, Object, Array, Error,
    addEventListener() {}, removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    StellaflixVideo: Object.assign({ onlineShared: S, onlineCore: {} }, extraSFV || {}),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(onlineNavSrc, sandbox);
  return { sandbox, SFV: sandbox.StellaflixVideo, doc };
}

function makeNavHarness() {
  const overlay = fakeEl('div');
  overlay.classList.add('sfv-show');
  const doc = {
    createElement: (t) => fakeEl(t),
    body: fakeEl('body'),
    documentElement: fakeEl('html'),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const S = {
    d: () => doc,
    el: (t) => fakeEl(t),
    stack: [],
    current: null,
    uiMode: 'view',
    _returnPageId: null,
    _detailOrigin: null,
    overlay,
    bodyEl: fakeEl('div'),
  };
  const calls = [];
  const SFV = {
    homeCollectionsOverlay: {
      resumeFromDetail: () => calls.push('resumeFromDetail'),
      discardParked: () => calls.push('discardParked'),
    },
  };
  loadNav(S, SFV, doc);
  return { S, calls };
}

test('D1 栈底 detail.from==="collections"：goBack 收浏览层并恢复暂存弹窗，不回首页', () => {
  const { S, calls } = makeNavHarness();
  const detail = { mode: 'detail', from: 'collections', key: 'tmdb:movie:1' };
  S.stack = [detail];
  S.current = detail;
  sandboxGoBack(S);
  assert.ok(calls.includes('resumeFromDetail'), '须调用 homeCollectionsOverlay.resumeFromDetail 复原片单页');
  assert.ok(!calls.includes('discardParked'), '返回片单页不得丢弃弹窗');
  assert.ok(!S.overlay.classList.contains('sfv-show'), '浏览层须收起');
  assert.strictEqual(S.stack.length, 0, '返回栈须复位');
  assert.strictEqual(S._detailOrigin, null, '来源标记须被消费清空');
});

test('D2 对照 detail.from==="browse"：goBack 仍整关回首页，不触碰弹窗恢复', () => {
  const { S, calls } = makeNavHarness();
  const detail = { mode: 'detail', from: 'browse', key: 'cms:1:vid9' };
  S.stack = [detail];
  S.current = detail;
  sandboxGoBack(S);
  assert.ok(!calls.includes('resumeFromDetail'), 'browse 来源不得触发弹窗恢复');
  assert.ok(calls.includes('discardParked'), '整关路径须丢弃 park 态（防僵尸）');
  assert.ok(!S.overlay.classList.contains('sfv-show'), '浏览层须收起');
});

// goBack 是闭包内函数，经 S.goBack 出口调用（online-nav 尾部 S.goBack = goBack）
function sandboxGoBack(S) { S.goBack(); }

test('D3 close() 整退丢弃 park 态；restore 路径不丢弃（源码契约）', () => {
  const closeFn = /function\s+close\s*\(\s*\)\s*\{[\s\S]*?\n  \}/.exec(onlineNavSrc);
  assert.ok(closeFn, 'expected close()');
  assert.match(closeFn[0], /discardParked/, 'close() 须调用 homeCollectionsOverlay.discardParked');
  const restoreFn = /function\s+restoreCollectionsPage[\s\S]*?\n  \}/.exec(onlineNavSrc);
  assert.ok(restoreFn, 'expected restoreCollectionsPage()');
  assert.equal(restoreFn[0].includes('discardParked'), false, '恢复路径不得丢弃弹窗');
  assert.match(restoreFn[0], /resumeFromDetail/);
});

// ---------------------------------------------------------------- F. from 映射 & 出口

test('F1 openDetailFromMeta 把 collections 来源写进 view.from（search 范式对齐）', () => {
  const fn = /function\s+openDetailFromMeta\s*\([\s\S]*?\n  \}/.exec(onlineDetailSrc);
  assert.ok(fn, 'expected openDetailFromMeta()');
  assert.match(fn[0], /_origin\s*===\s*'collections'/, 'from 映射须识别 collections 来源');
});

test('F2 SFV.online 暴露 setDetailOrigin 出口', () => {
  assert.match(onlineSrc, /setDetailOrigin\s*:/, 'online.js 门面须导出 setDetailOrigin');
});
