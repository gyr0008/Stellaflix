'use strict';
/**
 * 汇联页测试 harness：node vm + 假 DOM + 假桥加载 public/video/huilian-page.js。
 * Task 2/3/7 契约测复用（轮询、认领、overlay 销毁等均经 loadPage 注入不同桥 stub）。
 *
 * 用法：
 *   const { loadPage, fire } = require('./helpers/huilian-harness');
 *   const { page, registrations, uiCalls, host, doc } = loadPage({ bridge: null });
 * bridge 取值：
 *   null/undefined → 不注入 window.stellaflixVideo（非桌面降级分支）；
 *   true           → 注入默认 stub { player, download, ffmpeg }（桌面分支）；
 *   对象           → 按 { player:{}, download:{}, ffmpeg:{} } 深合并覆盖默认 stub，
 *                    便于后续任务定制 download.list()/player.createOverlay 返回值。
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
  };
  el.classList = makeClassList(el);
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
  return el;
}

function matches(node, selector) {
  const sel = String(selector).trim();
  if (sel[0] === '#') return !!node.attributes && node.attributes.id === sel.slice(1);
  if (sel[0] === '.') return node.classList && node.classList.contains(sel.slice(1));
  return node.tagName === sel.toUpperCase();
}

/** 派发假事件（沿用 hex-wall.test.js 约定，自动补 stopPropagation/preventDefault/target）。 */
function fire(el, type, event) {
  const ev = Object.assign({ type, stopPropagation() {}, preventDefault() {}, target: el }, event || {});
  (el.listeners[type] || []).slice().forEach((fn) => fn(ev));
}

function promise(data) { return Promise.resolve({ ok: true, data }); }

function defaultBridge() {
  return {
    player: {
      createOverlay: (opts) => promise(Object.assign({ playerId: 'mpv-test' }, opts || {})),
      destroyOverlay: () => promise(true),
      stop: () => promise(true),
      pause: () => promise(true),
      resume: () => promise(true),
      seek: () => promise(true),
      setProperty: () => promise(true),
      onEvent: () => promise(null),
    },
    download: {
      start: () => promise(true),
      addTorrent: (opts) => promise(Object.assign({ hash: '' }, opts || {})),
      list: () => promise({ torrents: [] }),
      files: () => promise({ files: [] }),
      getProgress: () => promise({ progress: 0 }),
      delete: () => promise(true),
    },
    ffmpeg: {},
  };
}

function mergeBridge(custom) {
  const base = defaultBridge();
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

  const body = makeEl('body');
  sandbox.document = {
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => (body.attributes.id === id ? body : body.querySelector('#' + id)),
    body,
    querySelector: (sel) => (matches(body, sel) ? body : body.querySelector(sel)),
    addEventListener: () => {},
  };

  vm.createContext(sandbox);

  const uiCalls = [];
  const registrations = [];
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

  if (opts.bridge) sandbox.stellaflixVideo = mergeBridge(opts.bridge === true ? null : opts.bridge);

  vm.runInContext(read('public/video/huilian-page.js'), sandbox, { filename: 'huilian-page.js' });

  const host = makeEl('div');
  body.appendChild(host);
  const page = registrations[0] || sandbox.StellaflixVideo.huilianPage;
  return { page, registrations, uiCalls, host, doc: sandbox.document, sandbox, bridge: sandbox.stellaflixVideo || null };
}

module.exports = { loadPage, fire, makeEl };
