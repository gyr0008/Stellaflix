'use strict';

/**
 * 影视空间面板配色 DIY — page-bg-diy 弹窗内 fx 同款配色行（三层页结构，前→后：卡片显示 / 中间玻璃 / 最里层面板）：
 *   玻璃层色(glassColor)→--sfv-glass-tint（只染中间玻璃）；
 *   底层面板色(panelColor)→--sfv-cat-bg + html --page-bg-diy（普通页），片库→--sfv-library-bg 且取色覆盖预设色板；
 *   最外层卡片外壳归「自定义网格 → 卡片外壳」管控，本 DIY 不接线。按页存储；Color Lab 接管取色。
 * 运行：node --test tests/page-bg-diy-panel-color.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// 全局 id 注册表：document.getElementById 用（每次 loadModule 前清空）
const ID_REGISTRY = new Map();

function makeStyle() {
  const props = {};
  return {
    _props: props,
    setProperty(k, v) { props[k] = String(v); },
    removeProperty(k) { delete props[k]; },
  };
}

function makeEl(tag, registry) {
  const el = {
    tagName: tag,
    _classes: new Set(),
    className: '',
    id: '',
    style: makeStyle(),
    children: [],
    parentNode: null,
    innerHTML: '',
    textContent: '',
    type: '', title: '', src: '', alt: '', value: '', disabled: false,
    _listeners: {},
    _attrs: {},
    setAttribute(k, v) { el._attrs[k] = v; if (k === 'id') el._setId(v); },
    getAttribute(k) { return k in el._attrs ? el._attrs[k] : null; },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); return c; },
    insertBefore(c) { el.children.unshift(c); c.parentNode = el; return c; },
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    _setId(v) { el.id = v; ID_REGISTRY.set(v, el); },
  };
  el.classList = {
    add(...cs) { cs.forEach((c) => el._classes.add(c)); },
    remove(...cs) { cs.forEach((c) => el._classes.delete(c)); },
    toggle(c, on) {
      if (on === undefined) { el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c); }
      else if (on) el._classes.add(c);
      else el._classes.delete(c);
    },
    contains: (c) => el._classes.has(c),
  };
  const syncClass = () => { el.className = [...el._classes].join(' '); };
  el._addClass = (c) => { el._classes.add(c); syncClass(); };
  // class 选择器递归查询 + closest + 冒泡派发，够本模块用
  el.querySelector = (sel) => el._findAll(sel)[0] || null;
  el.querySelectorAll = (sel) => el._findAll(sel);
  el._findAll = (sel) => {
    const want = String(sel).replace(':scope > ', '');
    const attrM = /^\[(\w[\w-]*)="([^"]*)"\]$/.exec(want);
    const cls = want.startsWith('.') ? want.slice(1) : null;
    const idSel = want.startsWith('#') ? want.slice(1) : null;
    const out = [];
    (function walk(node) {
      for (const c of node.children) {
        const hit = attrM ? String(c._attrs[attrM[1]] || (attrM[1] === 'data-act' ? c._dataAct : '')) === attrM[2]
          : idSel ? c.id === idSel
          : cls ? (c._classes.has(cls) || c.className === cls)
          : c.tagName === want;
        if (hit) out.push(c);
        walk(c);
      }
    })(el);
    return out;
  };
  el.closest = (sel) => {
    const want = String(sel).replace('.', '');
    let n = el;
    while (n) { if (n._classes && n._classes.has(want)) return n; n = n.parentNode; }
    return null;
  };
  el.dispatch = (type, ev) => {
    let n = el;
    const e = Object.assign({ target: el, preventDefault() {}, stopPropagation() {} }, ev || {});
    while (n) {
      (n._listeners && n._listeners[type] || []).forEach((fn) => fn(e));
      n = n.parentNode;
    }
  };
  // 简化 innerHTML 解析：把 class="x" 的标签变成子节点树（仅本测试工装用）
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html || ''; },
    set(v) {
      el._html = v;
      el.children = [];
      const stack = [el];
      const re = /<(\/?)(\w+)([^>]*)>/g;
      let m;
      while ((m = re.exec(v))) {
        const [_, close, tag, attrs] = m;
        if (close) { if (stack.length > 1) stack.pop(); continue; }
        const child = makeEl(tag);
        const cm = /class="([^"]*)"/.exec(attrs);
        if (cm) cm[1].split(/\s+/).forEach((c) => c && child._addClass(c));
        const im = /id="([^"]*)"/.exec(attrs);
        if (im) child._setId(im[1]);
        const dm = /data-field="([^"]*)"/.exec(attrs);
        if (dm) child._attrs['data-field'] = dm[1];
        const tm = /title="([^"]*)"/.exec(attrs);
        if (tm) child.title = tm[1];
        const am = /data-act="([^"]*)"/.exec(attrs);
        if (am) { child._dataAct = am[1]; child._attrs['data-act'] = am[1]; }
        stack[stack.length - 1].appendChild(child);
        if (!/>\/>$/.test(m[0]) && !/\/\s*>$/.test(m[0])) stack.push(child);
      }
    },
  });
  return el;
}

function loadModule(opts) {
  opts = opts || {};
  const overlay = makeEl('div');
  ['sfv-show'].concat(opts.overlayClasses || []).forEach((c) => overlay._addClass(c));
  const body = makeEl('body');
  body._addClass('video-space-active');
  const bodyEl = makeEl('div');
  bodyEl._addClass('sfv-browse-body');
  if (opts.trackTabs) { const tabs = makeEl('div'); tabs._addClass('sfv-track-tabs'); bodyEl.appendChild(tabs); }
  overlay.appendChild(bodyEl);
  const store = new Map();
  ID_REGISTRY.clear();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body,
      documentElement: makeEl('html'),
      readyState: 'loading',
      createElement: (t) => makeEl(t),
      addEventListener() {},
      getElementById: (id) => ID_REGISTRY.get(id) || null,
    },
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  const SFV = {
    onlineShared: {
      overlay,
      bodyEl,
      getSearchPage: () => (opts.searchPage ? opts.searchPage() : null),
    },
  };
  sandbox.StellaflixVideo = SFV;
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/page-bg-diy.js'), sandbox, { filename: 'page-bg-diy.js' });
  return { SFV, overlay, bodyEl, store, sandbox };
}

const prefKey = (pid) => 'stellaflix-page-bg-diy:' + pid;
const setPref = (store, pid, pref) =>
  store.set(prefKey(pid), pref ? JSON.stringify(pref) : null);
const getPref = (store, pid) =>
  store.has(prefKey(pid)) && store.get(prefKey(pid)) ? JSON.parse(store.get(prefKey(pid))) : null;

const asTrack = (SFV) => { SFV.onlineShared.current = { mode: 'category', field: 'track' }; };
const asLibrary = (SFV) => {
  SFV.onlineShared.activePageId = 'library';
  if (!SFV.onlineShared.overlay._classes.has('sfv-library-chrome')) SFV.onlineShared.overlay._addClass('sfv-library-chrome');
};

// ---------------------------------------------------------------- 按页偏好字段
test('setPanelColor：glassColor/panelColor 写入按页偏好并持久化', () => {
  const { SFV, store } = loadModule({ trackTabs: true });
  asTrack(SFV);
  SFV.pageBgDiy.setPanelColor('track', 'panelColor', '#e8edf3');
  assert.strictEqual(getPref(store, 'track').panelColor, '#e8edf3');
  SFV.pageBgDiy.setPanelColor('track', 'glassColor', '#f3ece1');
  assert.strictEqual(getPref(store, 'track').glassColor, '#f3ece1');
  // 原 type 偏好共存不受影响
  setPref(store, 'track', { type: 'color', value: '#faf8f5', panelColor: '#e8edf3' });
  SFV.pageBgDiy.setPanelColor('track', 'glassColor', '#e7f2f0');
  const p = getPref(store, 'track');
  assert.strictEqual(p.type, 'color');
  assert.strictEqual(p.glassColor, '#e7f2f0');
});

test('setPanelColor：只认 glassColor/panelColor 两字段，cardColor 等旧字段拒绝', () => {
  const { SFV, store } = loadModule({ trackTabs: true });
  asTrack(SFV);
  assert.strictEqual(SFV.pageBgDiy.setPanelColor('track', 'cardColor', '#e8edf3'), false,
    '最外层卡片外壳归「自定义网格」管，本行不得再接');
  assert.strictEqual(getPref(store, 'track'), null, '被拒字段不得落盘');
});

test('setPanelColor：null 清除对应字段（默认钮语义）', () => {
  const { SFV, store } = loadModule({ trackTabs: true });
  asTrack(SFV);
  setPref(store, 'track', { type: 'color', value: '#faf8f5', panelColor: '#e8edf3', glassColor: '#e7f2f0' });
  SFV.pageBgDiy.setPanelColor('track', 'panelColor', null);
  const p = getPref(store, 'track');
  assert.ok(!('panelColor' in p), 'panelColor 应被删除');
  assert.strictEqual(p.glassColor, '#e7f2f0', '其余字段保留');
});

test('setPanelColor：非法色值拒绝写入', () => {
  const { SFV, store } = loadModule({ trackTabs: true });
  asTrack(SFV);
  SFV.pageBgDiy.setPanelColor('track', 'panelColor', 'red; } body{display:none}');
  assert.strictEqual(getPref(store, 'track'), null, '非法值不得落盘');
});

// ---------------------------------------------------------------- apply 落变量（三层各归各位）
test('apply：glassColor 只染中间玻璃层，不得越层改最里层面板', () => {
  const { SFV, overlay, store } = loadModule({ trackTabs: true });
  asTrack(SFV);
  setPref(store, 'track', { glassColor: '#e7f2f0' });
  SFV.pageBgDiy.apply();
  const layer = overlay.querySelector('.sfv-page-bg-layer');
  assert.ok(layer, 'glassColor 应确保玻璃层挂载');
  assert.ok(layer._classes.has('sfv-page-bg--tint'), '应进入 tint 模式');
  assert.strictEqual(layer.style._props['--sfv-glass-tint'], 'rgba(231,242,240,0.78)');
  assert.strictEqual(overlay.style._props['--sfv-cat-bg'], '#faf8f5',
    '面板层必须保持默认乳白，两层同色会抹平景深');
});

test('apply：panelColor 落最里层面板 --sfv-cat-bg + html --page-bg-diy，且不动玻璃 tint', () => {
  const { SFV, overlay, sandbox, store } = loadModule({ trackTabs: true });
  asTrack(SFV);
  setPref(store, 'track', { panelColor: '#e8edf3' });
  SFV.pageBgDiy.apply();
  assert.strictEqual(overlay.style._props['--sfv-cat-bg'], '#e8edf3');
  assert.strictEqual(sandbox.document.documentElement.style._props['--page-bg-diy'], '#e8edf3',
    '四角兜底须与面板同色，否则 clip-path 圆角区露异色');
  const layer = overlay.querySelector('.sfv-page-bg-layer');
  assert.ok(!('--sfv-glass-tint' in layer.style._props) || layer.style._props['--sfv-glass-tint'] !== 'rgba(232,237,243,0.78)',
    'panelColor 不得把面板色灌进玻璃层');
  assert.ok(!('--sfv-page-card-bg' in overlay.style._props), '不得再写最外层卡片变量');
});

test('apply：panelColor 覆盖「背景类型＝颜色」预设（面板层取色优先）', () => {
  const { SFV, overlay, store } = loadModule({ trackTabs: true });
  asTrack(SFV);
  setPref(store, 'track', { type: 'color', value: '#17102a', panelColor: '#e8edf3' });
  SFV.pageBgDiy.apply();
  assert.strictEqual(overlay.style._props['--sfv-cat-bg'], '#e8edf3');
  // 预设仍负责玻璃层
  assert.strictEqual(overlay.querySelector('.sfv-page-bg-layer').style._props['--sfv-glass-tint'],
    'rgba(23,16,42,0.78)');
});

test('apply：片库 panelColor 覆盖预设落 --sfv-library-bg，强调色跟随实际面板色', () => {
  const { SFV, overlay, store } = loadModule();
  asLibrary(SFV);
  setPref(store, 'library', { type: 'color', value: '#0b1626', panelColor: '#14121a' });
  SFV.pageBgDiy.apply();
  assert.strictEqual(overlay.style._props['--sfv-library-bg'], '#14121a');
  assert.ok(!('--sfv-library-card-bg' in overlay.style._props), '海报卡外壳不再由本行管控');
  const accent = overlay.style._props['--sfv-library-accent'];
  assert.ok(accent, '面板色应换算选中态强调色');
  SFV.pageBgDiy.setPanelColor('library', 'panelColor', null);
  SFV.pageBgDiy.apply();
  assert.strictEqual(overlay.style._props['--sfv-library-bg'], '#0b1626', '清除后回落预设色板');
});

test('apply：离页清理 panelColor 写过的面板色与 html 兜底', () => {
  const { SFV, overlay, sandbox, store } = loadModule({ trackTabs: true });
  asTrack(SFV);
  setPref(store, 'track', { panelColor: '#e8edf3' });
  SFV.pageBgDiy.apply();
  assert.strictEqual(overlay.style._props['--sfv-cat-bg'], '#e8edf3');
  SFV.onlineShared.current = { mode: 'detail' };
  SFV.pageBgDiy.apply();
  assert.ok(!('--sfv-cat-bg' in overlay.style._props), '离开 DIY 页应摘除面板色');
  assert.ok(!('--page-bg-diy' in sandbox.document.documentElement.style._props), 'html 兜底同步摘除');
});

// ---------------------------------------------------------------- 弹窗行 DOM
test('模态含两条 fx 同款配色行（lyric-color-row + type=color picker + 默认钮）', () => {
  const src = read('public/video/page-bg-diy.js');
  assert.match(src, /sfv-panel-glass-picker/);
  assert.match(src, /sfv-panel-base-picker/);
  assert.match(src, /lyric-color-row sfv-bg-diy-panel-row/g);
  assert.ok(!/sfv-panel-card-picker/.test(src), '旧的卡片外壳行 id 应清除');
});

test('行文案：玻璃层色＝中间玻璃，底层面板色＝最里层面板（不再叫卡片面板）', () => {
  const src = read('public/video/page-bg-diy.js');
  assert.match(src, /玻璃层色/, '玻璃行标题保留');
  assert.match(src, /底层面板色/, '第二行应写明是底层面板');
  assert.ok(!/卡片面板色/.test(src), '误导性旧文案应清除');
});

test('openModal：浅页显两行；片库只显面板行', () => {
  const { SFV } = loadModule({ trackTabs: true });
  asTrack(SFV);
  SFV.pageBgDiy.openModal();
  const mask = SFV.pageBgDiy.getModal();
  assert.ok(mask, '模态应已构建');
  const glassSec = mask.querySelector('.sfv-bg-diy-glass-row');
  const baseSec = mask.querySelector('.sfv-bg-diy-base-row');
  assert.notStrictEqual(glassSec.style.display, 'none', '浅页玻璃行应可见');
  assert.notStrictEqual(baseSec.style.display, 'none', '浅页面板行应可见');
  SFV.pageBgDiy.closeModal();

  const lib = loadModule();
  asLibrary(lib.SFV);
  lib.SFV.pageBgDiy.openModal();
  const lmask = lib.SFV.pageBgDiy.getModal();
  assert.strictEqual(lmask.querySelector('.sfv-bg-diy-glass-row').style.display, 'none', '片库无玻璃层，应隐藏该行');
  assert.notStrictEqual(lmask.querySelector('.sfv-bg-diy-base-row').style.display, 'none',
    '片库面板行＝底层面板色，覆盖预设色板');
});

test('Color Lab 接管：构建模态时对两 picker 调 bindColorLabPicker + 整行 bindColorLabRows', () => {
  const { SFV, sandbox } = loadModule({ trackTabs: true });
  const bound = [];
  sandbox.bindColorLabPicker = (p) => bound.push(p.id);
  let rowsBound = 0;
  sandbox.bindColorLabRows = () => { rowsBound++; };
  asTrack(SFV);
  SFV.pageBgDiy.openModal();
  assert.deepStrictEqual(bound.sort(), ['sfv-panel-base-picker', 'sfv-panel-glass-picker']);
  // 根因回归：.lyric-color-picker 全局 pointer-events:none，色块收不到点击，
  // fx 侧实际靠行级 pointerdown 打开 Color Lab，模态必须同样挂行绑定。
  assert.strictEqual(rowsBound, 1, 'buildModal 应调用 bindColorLabRows 挂行级点击');
});

// ---------------------------------------------------------------- Color Lab 侧（源级断言）
test('colorlab.js：两 picker 路由进 pageBgDiy.setPanelColor 的 glassColor/panelColor + 弹窗挂体脱离 fx-panel', () => {
  const src = read('public/js/modules/02-visual/06-custom-background-colorlab.js');
  assert.match(src, /sfv-panel-glass-picker/, '应识别玻璃行 picker');
  assert.match(src, /sfv-panel-base-picker/, '应识别底层面板行 picker');
  assert.ok(!/sfv-panel-card-picker/.test(src), '旧卡片外壳 id 路由应清除');
  assert.match(src, /'glassColor'/, '玻璃行应写 glassColor');
  assert.match(src, /'panelColor'/, '面板行应写 panelColor');
  assert.match(src, /pageBgDiy[\s\S]{0,240}setPanelColor/, '应回调按页写入器');
  assert.match(src, /document\.body\.appendChild\(pop\)/, '打开 Color Lab 时应把弹窗重挂到 body，摆脱 fx-panel 隐藏态');
});

// 根因回归：.sfv-bg-diy-mask 顶到 z-index 上限（浏览器夹成 2147483647），取色窗只有 1401，
// 从 DIY 弹窗内调起时被遮罩整层压住 → 用户看到「点了色板没反应」。调起须抬到宿主弹窗同层，
// 且 DOM 已重挂 body 末尾（同层后者在上）；非弹窗内（fx 控制台）须还原走 CSS 原值。
test('colorlab.js：从高层弹窗内调起取色窗时抬高 z-index，普通调起还原', () => {
  const src = read('public/js/modules/02-visual/06-custom-background-colorlab.js');
  assert.match(src, /pop\.style\.zIndex\s*=\s*String\(/, '宿主弹窗层级更高时应抬到同层（重挂 body 末尾即在最上）');
  assert.match(src, /pop\.style\.zIndex\s*=\s*''/, '非弹窗内调起应清空内联 z-index，走 CSS 原值');
  assert.match(src, /getComputedStyle\([^)]*\)\.zIndex/, '应按计算 z-index 判定，不写死常量');
  // 同层弹窗比 DOM 序：只抬 z 不挪位仍会被后入 DOM 的遮罩反压（真机 popLastInBody=false 实锤）
  assert.match(src, /String\(\s*hostZ\s*\)[\s\S]{0,160}document\.body\.appendChild\(pop\)/,
    '抬层时应把取色窗挪到 body 末尾');
  // 第二次从同一弹窗的另一行调起时，内联值还在；不先清空就量不到 CSS 原值 → 会被自己比下去缩回遮罩后
  assert.match(src, /pop\.style\.zIndex\s*=\s*''[\s\S]{0,160}getComputedStyle\(\s*pop\s*\)\.zIndex/,
    '量基准 z-index 前应先摘掉上次抬升的内联值');
});

test('player.css：DIY 遮罩 z-index 顶到整数上限（取色窗必须显式抬高才可见）', () => {
  const css = read('public/video/player.css');
  const mask = css.slice(css.search(/\.sfv-bg-diy-mask\s*\{/));
  assert.match(mask.slice(0, 200), /z-index:\s*2147483\d{3}/, '遮罩用 2147483700，浏览器夹为 2147483647');
});

test('closeModal：取色窗仍绑 DIY 行时一并收掉，fx 侧取色窗不受连带', () => {
  const { SFV, sandbox } = loadModule({ trackTabs: true });
  asTrack(SFV);
  SFV.pageBgDiy.openModal();
  let closed = 0;
  sandbox.closeColorLab = () => { closed++; };
  sandbox.colorLabState = { id: 'sfv-panel-base-picker' };
  SFV.pageBgDiy.closeModal();
  assert.strictEqual(closed, 1, '取色中关弹窗会留下 body 浮空取色窗，应连带关闭');
  closed = 0;
  sandbox.colorLabState = { id: 'ui-accent-picker' };
  SFV.pageBgDiy.closeModal();
  assert.strictEqual(closed, 0, 'fx 控制台的取色窗不该被影视弹窗关掉');
});

// ---------------------------------------------------------------- CSS 消费端（三层各归一位，勿再互相覆盖）
test('player.css：.sfv-card 外壳底色仍由「自定义网格」--sfv-card-bg 单点管控', () => {
  const css = read('public/video/player.css');
  const card = css.slice(css.search(/^\.sfv-card\s*\{/m));
  assert.match(card.slice(0, 400), /background:\s*var\(\s*--sfv-card-bg\s*,/,
    '最外层卡片外壳＝自定义网格管，DIY 行不得插一层按页变量');
  assert.ok(!/--sfv-page-card-bg/.test(css), '--sfv-page-card-bg 接线应整条撤除');
});

test('poster-wall.css：海报卡外壳回到 #121014 常量', () => {
  const css = read('public/video/poster-wall/poster-wall.css');
  const card = css.slice(css.search(/\.sfv-hex-card\s*\{/));
  assert.match(card.slice(0, 500), /background:\s*#121014\s*;/);
  assert.ok(!/--sfv-library-card-bg/.test(css), '海报卡外壳接线应整条撤除');
});

// ---------------------------------------------------------------- 取色窗落位（行为级）
// 主人 10-25 裁定：影视「背景 DIY」弹窗内的取色窗开在弹窗左侧（右侧挡住弹窗内容、且离触发行太远）。
// fx 控制台在屏幕右缘，其取色窗本就落左侧 → 两处观感一致，故只改 DIY 分支，fx 分支不动。
function loadColorLab(vw, vh) {
  const sandbox = {
    console,
    document: { getElementById: () => null, querySelectorAll: () => [], body: { appendChild() {} } },
    getComputedStyle: () => ({ zIndex: '1401' }),
  };
  sandbox.window = {
    innerWidth: vw, innerHeight: vh, addEventListener() {}, requestAnimationFrame: null,
    IndexedDB: undefined, location: { href: '' },
  };
  sandbox.indexedDB = undefined;
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/modules/02-visual/06-custom-background-colorlab.js'), sandbox);
  return sandbox;
}
// 弹窗 440 宽居中于 1440 视口 → left 500/right 940；配色行内边距后 picker 在 x≈527
const DIALOG_BOX = { left: 500, right: 940, top: 120, bottom: 620, width: 440, height: 500 };
const ROW = { left: 518, right: 922, top: 300, bottom: 344, width: 404, height: 44 };
const asBox = (box) => ({ getBoundingClientRect: () => box });
function makeAnchor(dialog) {
  return {
    getBoundingClientRect: () => ROW,
    closest: (sel) => (sel === '.sfv-bg-diy-dialog' && dialog ? asBox(DIALOG_BOX) : null),
  };
}
function makePop() {
  // 真机 offsetWidth＝360（CSS width: min(330px, 100vw−42px) + padding 14×2 + border 1×2）
  return { offsetWidth: 360, offsetHeight: 292, style: {} };
}

test('placeFxFloatingPanel：DIY 弹窗内取色窗落到弹窗左外侧', () => {
  const lab = loadColorLab(1440, 900);
  const pop = makePop();
  lab.placeFxFloatingPanel(pop, makeAnchor(true), { gap: 12, pad: 14 });
  assert.strictEqual(pop.style.left, '128px',
    '左外侧＝弹窗左缘 500 − 取色窗 360 − gap 12，不得再压住弹窗');
  assert.ok(pop.style.left !== `${ROW.right + 12}px`, '不得沿用右侧落位');
});

test('placeFxFloatingPanel：fx 控制台取色窗落位不变（仍右侧优先）', () => {
  const lab = loadColorLab(1440, 900);
  const pop = makePop();
  lab.placeFxFloatingPanel(pop, makeAnchor(false), { gap: 12, pad: 14 });
  assert.strictEqual(pop.style.left, `${ROW.right + 12}px`, '非 DIY 弹窗锚点保持原右侧落位');
});

test('placeFxFloatingPanel：窄视口左侧放不下时回退右侧，不越界', () => {
  const lab = loadColorLab(800, 900);
  const pop = makePop();
  // 弹窗左缘只剩 166px、放不下 360px 取色窗 → 回退锚点右侧
  const narrowDialog = { left: 180, right: 620, top: 120, bottom: 620, width: 440, height: 500 };
  const anchor = {
    getBoundingClientRect: () => ({ left: 198, right: 602, top: 300, bottom: 344, width: 404, height: 44 }),
    closest: (sel) => (sel === '.sfv-bg-diy-dialog' ? asBox(narrowDialog) : null),
  };
  lab.placeFxFloatingPanel(pop, anchor, { gap: 12, pad: 14 });
  const left = parseInt(pop.style.left, 10);
  assert.ok(left >= 14 && left + 360 <= 800 - 14, `回退后须留在视口内，实得 ${pop.style.left}`);
});
