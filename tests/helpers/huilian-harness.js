'use strict';
/**
 * 汇联页测试 harness：node vm + 假 DOM + 假桥加载 public/video/huilian-page.js。
 * Task 2/3/7/8 契约测复用（轮询、认领、overlay 销毁等均经 loadPage 注入不同桥 stub）。
 * 选择器支持：#id / .class / TAG 及 [attr]、[attr="v"] 谓词（可与前缀组合，如 .a[data-b="c"]）；
 * 沙箱按 index.html 顺序先加载真实 huilian-queue.js + huilian-player-bar.js 再加载 huilian-page.js
 * （页面接线走真实现，非 mock）；
 * 定时器测试：mount 前替换 sandbox.setInterval/clearInterval 捕获回调，手动 tick 保确定性；
 * 播控条测（Task7）还需：元素矩形 getBoundingClientRect（假 _rect）、window 级事件派发
 * （sandbox.addEventListener → fire(sandbox,'resize')）、player.onEvent 订阅登记表 events。
 *
 * 用法：
 *   const { loadPage, fire } = require('./helpers/huilian-harness');
 *   const { page, registrations, uiCalls, host, doc } = loadPage({ bridge: null });
 * bridge 取值：
 *   null/undefined → 不注入 window.stellaflixVideo（非桌面降级分支）；
 *   true           → 注入默认 stub { player, download, ffmpeg }（桌面分支）；
 *   对象           → 按 { player:{}, download:{}, ffmpeg:{} } 深合并覆盖默认 stub，
 *                    便于后续任务定制 download.list()/player.createOverlay 返回值。
 * 默认 stub 与 desktop/preload-video.js 对齐（player.pause/resume/stop 等真实桥不存在的方法已移除）。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function makeClassList(el) {
  const set = new Set();
  return {
    add(...names) { names.forEach((n) => set.add(n)); },
    remove(...names) { names.forEach((n) => set.delete(n)); },
    toggle(name, force) {
      const want = force === undefined ? !set.has(name) : !!force;
      if (want) set.add(name); else set.delete(name);
      return want;
    },
    contains(name) { return set.has(name); },
    _set: set,
  };
}

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parent: null,
    style: { setProperty(name, value) { this[name] = value; } },
    attributes: {},
    listeners: {},
    textContent: '',
    disabled: false,
    _innerHTML: '',
    // 假矩形：Task7 bounds 跟随测需 getBoundingClientRect（默认零尺寸，测中改 el._rect）
    _rect: { x: 0, y: 0, width: 0, height: 0 },
  };
  el.classList = makeClassList(el);
  el.getBoundingClientRect = function () { return Object.assign({}, this._rect); };
  el.appendChild = function (child) { child.parent = this; this.children.push(child); return child; };
  el.removeChild = function (child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parent = null;
    return child;
  };
  el.setAttribute = function (name, value) {
    this.attributes[name] = String(value);
    // 真 DOM 语义：class 属性变更同步 classList
    if (name === 'class') {
      this.classList._set.clear();
      String(value).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
    }
  };
  el.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  };
  el.addEventListener = function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
  el.removeEventListener = function (type, fn) {
    const list = this.listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  el.querySelectorAll = function (selector) {
    const out = [];
    // 真 DOM 作用域：只搜索调用节点 this 的子树（闭包 el 不再作根）；
    // 仿 matches() 语义：节点自身命中选择器也计入。
    (function walk(node) {
      if (matches(node, selector)) out.push(node);
      node.children.forEach((child) => walk(child));
    })(this);
    return out;
  };
  el.querySelector = function (selector) { return this.querySelectorAll(selector)[0] || null; };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._innerHTML; },
    set(value) {
      this._innerHTML = value;
      this.children.forEach((c) => { c.parent = null; });
      this.children = [];
    },
  });
  Object.defineProperty(el, 'className', {
    get() { return Array.from(this.classList._set).join(' '); },
    set(value) { this.setAttribute('class', String(value)); },
  });
  // 真 DOM 名称别名：生产代码用 parentNode/parentElement（假 DOM 内部记在 parent）
  Object.defineProperty(el, 'parentNode', { get() { return this.parent; } });
  Object.defineProperty(el, 'parentElement', { get() { return this.parent; } });
  return el;
}

function matches(node, selector) {
  const sel = String(selector).trim();
  // 属性谓词 [attr] / [attr="v"] / [attr='v'] / [attr=v]（Task3 DOM 契约：data-hash、data-index、data-playable）
  const attrRe = /\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g;
  let base = sel;
  let m;
  while ((m = attrRe.exec(sel))) {
    const value = node.getAttribute(m[1]);
    if (value === null) return false;
    const want = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    if (want !== undefined && value !== String(want)) return false;
    base = base.replace(m[0], '');
  }
  if (!base) return true;
  if (base[0] === '#') return !!node.attributes && node.attributes.id === base.slice(1);
  if (base[0] === '.') return node.classList && node.classList.contains(base.slice(1));
  return node.tagName === base.toUpperCase();
}

/** 派发假事件（沿用 hex-wall.test.js 约定，自动补 stopPropagation/preventDefault/target）。 */
function fire(el, type, event) {
  const ev = Object.assign({ type, stopPropagation() {}, preventDefault() {}, target: el }, event || {});
  (el.listeners[type] || []).slice().forEach((fn) => fn(ev));
}

function promise(data) { return Promise.resolve({ ok: true, data }); }

/**
 * 默认桥 stub：方法名/返回形状对齐 desktop/preload-video.js 真实暴露面
 * （player.pause/resume/stop 与 download.start/getProgress 真实桥并不存在，故不提供，
 *   避免测试期用出不存在的桥方法；真实面为 command/getProperty/setProperty/seek/
 *   stopAndClean/createOverlay/destroyOverlay/setBounds/onEvent + download.addTorrent/
 *   list/files/delete/progress）。
 * onEvent 按订阅登记进 events 数组并返回退订函数（真实 preload onEvent 即返回 unsubscribe）。
 */
function defaultBridge(events) {
  const subscribe = (playerId, event, cb) => {
    const sub = { playerId, event, cb, removed: false };
    events.push(sub);
    return () => { sub.removed = true; };
  };
  return {
    player: {
      createOverlay: () => promise({ overlayId: 'ovl-test', playerId: 'mpv-test', pid: 4321, hwnd: '00' }),
      destroyOverlay: (playerId) => promise(!!playerId),
      setBounds: () => promise(true),
      command: () => promise(null),
      getProperty: (_id, name) => promise({ name, data: null }),
      setProperty: () => promise(null),
      seek: () => promise(null),
      stopAndClean: () => promise(true),
      list: () => promise([]),
      onEvent: subscribe,
      onAllEvents: (playerId, cb) => subscribe(playerId, '*', cb),
    },
    download: {
      addTorrent: (opts) => promise(Object.assign({ hash: '' }, opts || {})),
      // 真实桥（ipc-video:115 → download.listTorrents → JSON.parse）resolve 裸数组：{ok:true,data:[...]}
      list: () => promise([]),
      files: () => promise([]),
      progress: () => promise(0),
      delete: () => promise(true),
    },
    ffmpeg: {},
  };
}

function mergeBridge(custom, events) {
  const base = defaultBridge(events);
  if (!custom || typeof custom !== 'object') return base;
  Object.keys(base).forEach((domain) => {
    if (custom[domain] && typeof custom[domain] === 'object') {
      Object.assign(base[domain], custom[domain]);
    }
  });
  return base;
}

function loadPage(options) {
  const opts = options || {};
  const sandbox = {
    console, Math, Number, Array, Object, String, Boolean, Promise, Set, Map, JSON, Date,
    setTimeout, clearTimeout, setInterval, clearInterval, RegExp, Error,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  // window 级事件（Task7：resize / scroll 监听）：与元素同一 listeners 约定，便于 fire(sandbox,'resize')
  sandbox.listeners = {};
  sandbox.addEventListener = function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
  sandbox.removeEventListener = function (type, fn) {
    const list = this.listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };

  const body = makeEl('body');
  // document 记录事件监听（I4：visibilitychange 页面隐藏拆除可测），并暴露可设的 hidden 标志；
  // 与 makeEl 同一 listeners 约定，故测试可用 fire(doc,'visibilitychange') 派发。
  const docListeners = {};
  sandbox.document = {
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => (body.attributes.id === id ? body : body.querySelector('#' + id)),
    body,
    hidden: false,
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    querySelector: (sel) => (matches(body, sel) ? body : body.querySelector(sel)),
    listeners: docListeners,
    addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => {
      const list = docListeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
  };

  vm.createContext(sandbox);

  const uiCalls = [];
  const registrations = [];
  const events = [];   // player.onEvent 订阅登记表（{playerId,event,cb,removed}）
  sandbox.StellaflixVideo = {
    ui: {
      setTitle: (v) => uiCalls.push(['setTitle', v]),
      setBrowseChrome: (v) => uiCalls.push(['setBrowseChrome', v]),
    },
    router: {
      register: (p) => registrations.push(p),
      go: () => {},
      currentId: () => 'discover',
    },
  };

  if (opts.bridge) sandbox.stellaflixVideo = mergeBridge(opts.bridge === true ? null : opts.bridge, events);

  // 浏览器中 index.html 的加载顺序：huilian-queue.js → huilian-player-bar.js → huilian-page.js；
  // 测试同样先注入真实模块（非 mock），让页面接线走真实现。
  vm.runInContext(read('public/video/huilian-queue.js'), sandbox, { filename: 'huilian-queue.js' });
  vm.runInContext(read('public/video/huilian-player-bar.js'), sandbox, { filename: 'huilian-player-bar.js' });
  vm.runInContext(read('public/video/huilian-page.js'), sandbox, { filename: 'huilian-page.js' });

  const host = makeEl('div');
  body.appendChild(host);
  const page = registrations[0] || sandbox.StellaflixVideo.huilianPage;
  return {
    page, registrations, uiCalls, host, doc: sandbox.document, sandbox, events,
    bridge: sandbox.stellaflixVideo || null,
  };
}

module.exports = { loadPage, fire, makeEl };
