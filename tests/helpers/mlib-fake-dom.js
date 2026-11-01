'use strict';
/**
 * tests/helpers/mlib-fake-dom.js —— 音乐资料库页面层的假 DOM（Task 5 落地，Task 6/7/8 复用）
 *
 * 设计原则：**只做 DOM 机制，不含任何音乐/资料库语义**。
 * 页面模块 public/js/modules/04-shelf/08-mlib-page.js 只允许用下面「API 面」里的能力写代码，
 * 这样假 DOM 与真浏览器行为保持同源，假 DOM 测出来的结论在真机成立。
 *
 * API 面（页面模块可用子集 = 本helper 已实现的全部）：
 *   document.getElementById(id) / document.querySelector(sel) / document.querySelectorAll(sel)
 *   document.createElement(tag) / document.body / document.documentElement
 *   el.classList（add/remove/toggle/contains）/ el.className（读写，写时同步 classList）
 *   el.textContent（写＝清子节点＋设自身文本；读＝拼接子树文本，与真 DOM 同语义）
 *   el.innerHTML（**setter 只记录字符串并清空 children** —— 真 DOM 会解析，这里不解析；
 *                  所以「文本注入防御」类断言读 el.innerHTML 字符串，结构类断言读 children）
 *   el.appendChild(child) / el.removeChild(child) / el.remove()
 *   el.setAttribute / getAttribute / removeAttribute（setAttribute('class'|'id') 有真 DOM 联动语义）
 *   el.dataset（camelCase ↔ data-kebab 属性双向映射）
 *   el.addEventListener / el.querySelector / el.querySelectorAll（作用域＝**后代子树，不含自身命中**，与真 DOM 一致：
 *                  el.querySelector(sel) 永不返回 el 本身，哪怕 el 匹配 sel；要判自身命中请用 el.matches / el.closest）
 *   el.children / el.parentNode（别名 parentElement）/ el.style / el.hidden / el.disabled
 *   el.scrollTop（普通数值属性，供滚动记录/恢复类断言）
 *   选择器支持：#id / .class / TAG / [attr] / [attr="v"]，可组合（如 .a[data-b="c"]）
 *   window.matchMedia(query) → { matches, media, addEventListener, addListener, ... }
 *   事件派发：fire(el, type, extra)（自动补 target/stopPropagation/preventDefault）
 *   createFakeDom 选项：{ hover: bool, media: { '(hover: hover)': bool, ... }, mount: 节点描述数组 }
 *     （media 覆盖某条查询的匹配结果，优先级高于 hover；mount 缺省＝ SHELL 资料库壳层节点）
 *   vm 注入：createFakeDom(opts) → { win, doc, body, html, sandbox, getMql }；
 *            win.loadScript(source, filename) 在沙箱里跑模块源码
 *
 * 用法（资料库页面的典型 boot，见 tests/mlib-page-grid.test.js）：
 *   const { createFakeDom, fire, SHELL } = require('./helpers/mlib-fake-dom');
 *   const page = createFakeDom({ hover: true, mount: SHELL });  // mount＝节点描述数组，缺省即 SHELL
 *   page.win.loadScript(fs.readFileSync(readlayerSrc, 'utf8'), '07-mlib-readlayer.js');
 *   page.win.loadScript(fs.readFileSync(pageSrc, 'utf8'), '08-mlib-page.js');
 *   page.win.stellaMlibPage.openAxis('albums');               // 模块直接用真 api 名操作这棵假 DOM
 *   page.doc.querySelector('.stella-mlib-album-card');        // 断言产物
 *   fire(page.doc.getElementById('mlib-grid'), 'click');      // 后续任务的委托点击
 *
 * 已知取舍（不是 bug，别当成真 DOM）：
 *   - innerHTML 不解析 → 用 innerHTML 写进去的片段查不到子节点（故 08-mlib-page.js 需要被检查的
 *     结构一律 createElement，innerHTML 只用于转义文本片段与静态图标）。
 *   - 事件不冒泡/不捕获：fire 只派发节点自身的监听器。委托监听要测就 fire 到监听所在节点，
 *     Task 8 若需捕获阶段冒泡（img load/error 委托）请在 fire 里沿 parentNode 链派发。
 *   - el.isConnected 恒为 true；无 Shadow/无布局、getBoundingClientRect 不存在。
 */

const vm = require('node:vm');

/* ---------------------------------------------------------------- 节点 */

function makeClassList(node) {
  const set = new Set();
  return {
    add() { for (const n of arguments) set.add(String(n)); },
    remove() { for (const n of arguments) set.delete(String(n)); },
    toggle(name, force) {
      const k = String(name);
      const want = force === undefined ? !set.has(k) : !!force;
      if (want) set.add(k); else set.delete(k);
      return want;
    },
    contains(name) { return set.has(String(name)); },
    _set: set,
  };
}

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    parent: null,
    attributes: Object.create(null),
    listeners: Object.create(null),
    // 批D Task 3：补 removeProperty（setProperty 的镜像）。主题变量类断言要在 boot 侧
    // （helpers/mlib-detail-boot.js 的 f.themeWrites）成对记账，这里先把机制面补齐。
    style: {
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; },
    },
    _text: '',
    _innerHTML: '',
    hidden: false,
    disabled: false,
    scrollTop: 0,
  };

  node.classList = makeClassList(node);

  node.appendChild = function (child) {
    if (!child) return child;
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  };
  node.removeChild = function (child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    if (child) child.parent = null;
    return child;
  };
  node.remove = function () { if (this.parent) this.parent.removeChild(this); };

  node.setAttribute = function (name, value) {
    const k = String(name);
    this.attributes[k] = String(value);
    // 真 DOM 联动：class 属性 ↔ classList；id 属性无需联动（getElementById 直接读 attributes.id）
    if (k === 'class') this._syncClassFromString(this.attributes[k]);
  };
  node.getAttribute = function (name) {
    const k = String(name);
    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
  };
  node.removeAttribute = function (name) { delete this.attributes[String(name)]; };
  node._syncClassFromString = function (value) {
    this.classList._set.clear();
    String(value || '').split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  };

  node.addEventListener = function (type, fn) {
    const k = String(type);
    (this.listeners[k] = this.listeners[k] || []).push(fn);
  };
  node.removeEventListener = function (type, fn) {
    const list = this.listeners[String(type)] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };

  node.matches = function (sel) { return matches(this, sel); };
  node.closest = function (sel) {
    let cur = this;
    while (cur) {
      if (matches(cur, sel)) return cur;
      cur = cur.parent;
    }
    return null;
  };
  node.querySelectorAll = function (sel) {
    const out = [];
    (function walk(n) {
      n.children.forEach((child) => {
        if (matches(child, sel)) out.push(child);
        walk(child);
      });
    })(this);
    return out;
  };
  node.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };

  Object.defineProperty(node, 'innerHTML', {
    get() { return this._innerHTML; },
    set(value) {
      this._innerHTML = String(value == null ? '' : value);
      this.children.forEach((c) => { c.parent = null; });
      this.children = [];
      this._text = '';
    },
  });
  Object.defineProperty(node, 'className', {
    get() { return Array.from(this.classList._set).join(' '); },
    set(value) { this._syncClassFromString(value); },
  });
  Object.defineProperty(node, 'textContent', {
    get() {
      if (this.children.length) return this.children.map((c) => c.textContent).join('');
      return this._text;
    },
    set(value) {
      this.children.forEach((c) => { c.parent = null; });
      this.children = [];
      this._innerHTML = '';
      this._text = value == null ? '' : String(value);
    },
  });
  Object.defineProperty(node, 'parentNode', { get() { return this.parent; } });
  Object.defineProperty(node, 'parentElement', { get() { return this.parent; } });
  Object.defineProperty(node, 'isConnected', { get() { return true; } });
  Object.defineProperty(node, 'dataset', {
    get() {
      return new Proxy(Object.create(null), {
        get(_t, key) {
          if (typeof key !== 'string') return undefined;
          return node.getAttribute('data-' + key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()));
        },
        set(_t, key, value) {
          node.setAttribute('data-' + String(key).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), value);
          return true;
        },
        deleteProperty(_t, key) {
          node.removeAttribute('data-' + String(key).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()));
          return true;
        },
        has(_t, key) {
          return node.getAttribute('data-' + String(key).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())) !== null;
        },
      });
    },
  });

  return node;
}

/* ---------------------------------------------------------------- 选择器 */

const COMPOUND_RE = /(?:^([a-zA-Z][\w-]*))?((?:#[\w-]+|\.[\w-]+|\[[^\]]*\])*)$/;
const PART_RE = /#[\w-]+|\.[\w-]+|\[[^\]]*\]/g;

/**
 * 单个复合选择器：`TAG`/`#id`/`.class`/`[attr]`/`[attr="v"]` 任意顺序组合，全部命中才算匹配；
 * 逗号（选择器组）递归成「或」。属性值里的点不会破坏解析（方括号整体消费）。
 * 出现无法识别的字符即判不匹配——宁可假阴性，也不静默放过。
 */
function matches(node, selector) {
  const token = String(selector || '').trim();
  if (!token) return false;
  if (token.indexOf(',') >= 0) return token.split(',').some((alt) => matches(node, alt));
  const m = COMPOUND_RE.exec(token);
  if (!m) return false;
  if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
  const rest = m[2] || '';
  PART_RE.lastIndex = 0;
  let seen = 0;
  let mm;
  while ((mm = PART_RE.exec(rest))) {
    seen += mm[0].length;
    const part = mm[0];
    if (part[0] === '#') {
      if (node.attributes.id !== part.slice(1)) return false;
    } else if (part[0] === '.') {
      if (!node.classList.contains(part.slice(1))) return false;
    } else if (!matchAttr(node, part)) {
      return false;
    }
  }
  return seen === rest.length;
}

function matchAttr(node, token) {
  const m = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]$/.exec(token);
  if (!m) return false;
  const value = node.getAttribute(m[1]);
  if (value === null) return false;
  const want = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
  return want === undefined || value === String(want);
}

/* ---------------------------------------------------------------- 文档 */

function makeDocument() {
  const html = makeNode('html');
  const body = makeNode('body');
  html.appendChild(body);
  const doc = {
    documentElement: html,
    body,
    createElement: (tag) => makeNode(tag),
    getElementById(id) { return html.querySelector('#' + id); },
    querySelector(sel) { return matches(html, sel) ? html : html.querySelector(sel); },
    querySelectorAll: (sel) => html.querySelectorAll(sel),
    addEventListener(type, fn) { (body.listeners[String(type)] = body.listeners[String(type)] || []).push(fn); },
    removeEventListener(type, fn) { body.removeEventListener(type, fn); },
    hidden: false,
  };
  return doc;
}

/**
 * 由节点描述建一棵已接好父子关系的假节点（**不自动挂进 body**）。
 * 描述：{ tag?, id?, class?, classes?, attrs?, text?, html?, children? }
 */
function buildNode(doc, spec) {
  const node = doc.createElement(spec.tag || 'div');
  if (spec.id) node.setAttribute('id', spec.id);
  const classes = []
    .concat(spec.class ? String(spec.class).split(/\s+/) : [])
    .concat(spec.classes || []);
  classes.filter(Boolean).forEach((c) => node.classList.add(c));
  Object.keys(spec.attrs || {}).forEach((k) => node.setAttribute(k, spec.attrs[k]));
  if (spec.html != null) node.innerHTML = spec.html;
  if (spec.text != null) node.textContent = spec.text;
  (spec.children || []).forEach((child) => node.appendChild(buildNode(doc, child)));
  return node;
}

/**
 * #mlib-* 页面壳的节点描述（与 public/index.html 的 #music-library 骨架逐一对应）。
 * 资料库系列测试的 boot 默认挂这个；后续任务需要额外入口节点时用 { ...SHELL, extra: {...} } 自取。
 * 批D Task 3：第二段＝#mlib-detail-modal 弹窗静态壳，与 index.html:357-399 逐字对应，
 * 且与 #music-library 同层（遮罩不在滚动容器里）；id 面、data-mlib-modal-* / aria-busy / hidden
 * 属性面全挂上（Task 5 的选择器判据只读这些）。innerHTML 不解析的既有口径下，凡要被断言的
 * 结构一律节点描述（createElement），不用 html: 静态片段。
 */
const SHELL = [
  {
    tag: 'section', id: 'music-library', attrs: { 'aria-hidden': 'true' }, children: [
      {
        id: 'music-library-scroll', children: [
          {
            id: 'mlib-view-grid', children: [
              {
                id: 'mlib-grid-wrap', children: [
                  { id: 'mlib-grid' },
                  { id: 'mlib-state-box' },
                ],
              },
            ],
          },
          {
            id: 'mlib-view-detail', children: [
              { tag: 'button', id: 'mlib-detail-back', text: '返回' },
              { id: 'mlib-detail-head' },
              { id: 'mlib-detail-tracks' },
            ],
          },
        ],
      },
    ],
  },
  {
    tag: 'div', id: 'mlib-detail-modal', class: 'modal-mask',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mlib-detail-modal-heading' },
    children: [
      {
        tag: 'div', class: 'modal stella-mlib-modal', children: [
          {
            tag: 'div', id: 'mlib-detail-modal-scroll', class: 'stella-mlib-modal-scroll', children: [
              {
                tag: 'div', class: 'stella-mlib-modal-info', children: [
                  {
                    tag: 'div', class: 'stella-mlib-modal-cover-wrap', children: [
                      { tag: 'div', id: 'mlib-detail-modal-cover', class: 'stella-mlib-modal-cover', attrs: { 'aria-hidden': 'true' } },
                    ],
                  },
                  {
                    tag: 'div', class: 'stella-mlib-modal-meta', children: [
                      { tag: 'div', id: 'mlib-detail-modal-kicker', class: 'stella-mlib-modal-kicker' },
                      { tag: 'h2', id: 'mlib-detail-modal-heading', class: 'stella-mlib-detail-title', text: '详情' },
                      { tag: 'div', id: 'mlib-detail-modal-artist', class: 'stella-mlib-modal-artist' },
                      { tag: 'p', id: 'mlib-detail-modal-desc', class: 'stella-mlib-modal-desc', attrs: { hidden: '' } },
                      {
                        tag: 'button', id: 'mlib-detail-modal-desc-toggle', class: 'stella-mlib-modal-desc-toggle',
                        attrs: { type: 'button', hidden: '', 'data-mlib-modal-desc-toggle': '' }, text: '展开简介',
                      },
                      { tag: 'div', id: 'mlib-detail-modal-facts', class: 'stella-mlib-modal-facts' },
                      {
                        tag: 'div', class: 'stella-mlib-modal-actions', children: [
                          {
                            tag: 'button', id: 'mlib-detail-modal-play', class: 'stella-mlib-modal-play',
                            attrs: { type: 'button', 'data-mlib-modal-play': '' }, children: [
                              { tag: 'svg', attrs: { 'aria-hidden': 'true' } },
                              { tag: 'span', id: 'mlib-detail-modal-play-label', text: '播放' },
                            ],
                          },
                          {
                            tag: 'button', id: 'mlib-detail-modal-shuffle', class: 'stella-mlib-shuffle-btn',
                            attrs: { type: 'button', 'data-mlib-modal-shuffle': '', title: '随机播放', 'aria-label': '随机播放' },
                            children: [{ tag: 'svg', attrs: { 'aria-hidden': 'true' } }],
                          },
                        ],
                      },
                      {
                        tag: 'div', id: 'mlib-detail-modal-status', class: 'stella-mlib-modal-status',
                        attrs: { role: 'status', 'aria-live': 'polite', hidden: '' },
                      },
                    ],
                  },
                ],
              },
              { tag: 'div', id: 'mlib-detail-modal-tracks', class: 'stella-mlib-modal-tracks', attrs: { 'aria-busy': 'false' } },
            ],
          },
          {
            tag: 'div', class: 'stella-mlib-modal-foot', children: [
              { tag: 'button', class: 'modal-btn', attrs: { type: 'button', 'data-mlib-modal-close': '' }, text: '关闭' },
            ],
          },
        ],
      },
    ],
  },
];

/* ---------------------------------------------------------------- 页面沙箱 */

function makeMmEntry(query) {
  const entry = {
    media: query,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  };
  return entry;
}

/**
 * 建一个带假 DOM 的 vm 沙箱。
 * options：
 *   hover  : boolean            → matchMedia('(hover: hover)').matches，默认 true
 *   mount  : 节点描述数组        → 依序挂进 body（资料库用 SHELL）
 *   media  : { '(hover: hover)': false, ... } 覆盖/追加某条查询的 matches
 *   globals: 追加进沙箱的额外全局（如自定义 window.__x）
 */
function createFakeDom(options) {
  const opts = options || {};
  const sandbox = {
    console, Math, Number, Array, Object, String, Boolean, Promise, Set, Map, WeakMap,
    JSON, Date, RegExp, Error, TypeError, RangeError, Symbol, Intl,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const doc = makeDocument();
  sandbox.document = doc;

  const mqls = Object.create(null);
  sandbox.matchMedia = function (query) {
    const q = String(query);
    if (!mqls[q]) {
      mqls[q] = makeMmEntry(q);
      if (/hover\s*:\s*hover/i.test(q)) mqls[q].matches = opts.hover !== false;
      if (opts.media && Object.prototype.hasOwnProperty.call(opts.media, q)) mqls[q].matches = !!opts.media[q];
    }
    return mqls[q];
  };

  // window 级事件（与节点同一 listeners 约定，便于 fire(win, 'keydown')）
  sandbox.listeners = Object.create(null);
  sandbox.addEventListener = function (type, fn) {
    (this.listeners[String(type)] = this.listeners[String(type)] || []).push(fn);
  };
  sandbox.removeEventListener = function (type, fn) {
    const list = this.listeners[String(type)] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };

  vm.createContext(sandbox);
  Object.keys(opts.globals || {}).forEach((k) => { sandbox[k] = opts.globals[k]; });

  const mountSpecs = opts.mount || [];
  (Array.isArray(mountSpecs) ? mountSpecs : []).forEach((spec) => doc.body.appendChild(buildNode(doc, spec)));
  if (opts.bodyClass) String(opts.bodyClass).split(/\s+/).forEach((c) => doc.body.classList.add(c));

  sandbox.loadScript = function (source, filename) {
    return vm.runInContext(String(source), sandbox, { filename: filename || 'fake-dom-script.js' });
  };

  return {
    win: sandbox,
    window: sandbox,
    sandbox,
    doc,
    document: doc,
    body: doc.body,
    html: doc.documentElement,
    getMql: (query) => mqls[String(query)] || null,
  };
}

/* ---------------------------------------------------------------- 事件派发 */

function fire(target, type, extra) {
  const ev = Object.assign({
    type: String(type),
    target,
    currentTarget: target,
    stopPropagation() {},
    preventDefault() {},
  }, extra || {});
  const list = (target && target.listeners ? target.listeners[String(type)] : null) || [];
  list.slice().forEach((fn) => fn(ev));
  return ev;
}

module.exports = { createFakeDom, makeNode, buildNode, matches, fire, SHELL };
