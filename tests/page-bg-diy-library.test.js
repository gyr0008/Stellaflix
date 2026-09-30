'use strict';

/**
 * 片库背景 DIY — page-bg-diy 认出 library 页，背景走 --sfv-library-bg 变量，深色 6 档色板
 * 运行：node --test tests/page-bg-diy-library.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function makeStyle() {
  const props = {};
  return {
    _props: props,
    setProperty(k, v) { props[k] = v; },
    removeProperty(k) { delete props[k]; },
  };
}

function makeEl(tag) {
  const el = {
    tagName: tag,
    _classes: new Set(),
    className: '',
    style: makeStyle(),
    children: [],
    parentNode: null,
    innerHTML: '',
    textContent: '',
    type: '', title: '', src: '', alt: '', value: '',
    setAttribute() {},
    getAttribute() { return null; },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); return c; },
    insertBefore(c) { el.children.unshift(c); c.parentNode = el; return c; },
    addEventListener() {},
    querySelector(sel) {
      const want = String(sel).replace(':scope > ', '');
      if (!want.startsWith('.')) return null;
      const cls = want.slice(1);
      return el.children.find((c) => c.className === cls || (c._classes && c._classes.has(cls))) || null;
    },
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
  return el;
}

function loadModule() {
  const overlay = makeEl('div');
  overlay.classList.add('sfv-show', 'sfv-browse--fullscreen', 'sfv-library-chrome');
  const body = makeEl('body');
  body.classList.add('video-space-active');
  const store = new Map();
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
      createElement: makeEl,
      addEventListener() {},
    },
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  const SFV = { onlineShared: { overlay, bodyEl: makeEl('div'), getSearchPage: () => null } };
  sandbox.StellaflixVideo = SFV;
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/page-bg-diy.js'), sandbox, { filename: 'page-bg-diy.js' });
  return { SFV, overlay, store };
}

const setPref = (store, pref) =>
  store.set('stellaflix-page-bg-diy:library', pref ? JSON.stringify(pref) : null);

test('getDiyPageId 认出片库页（activePageId=library + sfv-library-chrome）', () => {
  const { SFV } = loadModule();
  SFV.onlineShared.activePageId = 'library';
  assert.strictEqual(SFV.pageBgDiy.getDiyPageId(), 'library');
});

test('getDiyPageId：片库进详情后不误判（detail 视图不挂背景 DIY）', () => {
  const { SFV } = loadModule();
  SFV.onlineShared.activePageId = 'library';
  SFV.onlineShared.current = { mode: 'detail' };
  assert.strictEqual(SFV.pageBgDiy.getDiyPageId(), null);
});

test('apply：color/image/gradient 偏好落到 --sfv-library-bg', () => {
  const { SFV, overlay, store } = loadModule();
  SFV.onlineShared.activePageId = 'library';

  setPref(store, { type: 'color', value: '#0b1626' });
  SFV.pageBgDiy.apply();
  assert.strictEqual(overlay.style._props['--sfv-library-bg'], '#0b1626');

  // 图片偏好不再直接铺 overlay 背景（会糊字），改落 --sfv-library-bg-image，
  // 由 CSS ::before 承载虚化+压暗层；主变量必须同时摘除，避免双层叠加。
  setPref(store, { type: 'image', value: 'data:image/png;base64,AAAA' });
  SFV.pageBgDiy.apply();
  assert.ok(!('--sfv-library-bg' in overlay.style._props), 'image 偏好不得再写 --sfv-library-bg');
  assert.strictEqual(overlay.style._props['--sfv-library-bg-image'],
    'url("data:image/png;base64,AAAA")');

  setPref(store, { type: 'gradient' });
  SFV.pageBgDiy.apply();
  assert.ok(!('--sfv-library-bg' in overlay.style._props), '红蓝渐变=默认，应移除变量走 CSS fallback');
  assert.ok(!('--sfv-library-bg-image' in overlay.style._props), '切回渐变应移除图片变量');
});

test('apply：片库不挂浅色玻璃层、不写乳白四角色', () => {
  const { SFV, overlay, store } = loadModule();
  SFV.onlineShared.activePageId = 'library';
  setPref(store, { type: 'color', value: '#17102a' });
  SFV.pageBgDiy.apply();
  assert.ok(!overlay.classList.contains('sfv-page-bg-diy'), '片库深色语境不应挂 .sfv-page-bg-diy 玻璃层');
  assert.ok(!('--sfv-cat-bg' in overlay.style._props), '片库不应写乳白 --sfv-cat-bg');
});

test('片库深色 6 档色板 + 模态标题「片库背景」存在', () => {
  const src = read('public/video/page-bg-diy.js');
  assert.match(src, /LIBRARY_BG_PRESETS/);
  ['红蓝渐变', '纯黑', '炭黑', '深蓝', '暗紫', '深棕'].forEach((label) => {
    assert.ok(src.includes(`'${label}'`), `色板应含「${label}」`);
  });
  assert.match(src, /片库背景/);
});

test('poster-wall.css：背景走 var(--sfv-library-bg, 红蓝渐变) 且墙容器透明化', () => {
  const css = read('public/video/poster-wall/poster-wall.css');
  assert.match(css, /var\(\s*--sfv-library-bg\s*,/, 'chrome 背景应改为 var(--sfv-library-bg, 默认渐变)');
  assert.match(css, /\.sfv-library-chrome\s+\.sfv-library-wall-host\s*\{[^}]*background:\s*transparent/,
    'chrome 下 wall-host 应透明，让 overlay 背景透出');
});

test('poster-wall.css：自定义图片壁纸 ::before 原图展示（不虚化）+ 轻压暗蒙版', () => {
  const css = read('public/video/poster-wall/poster-wall.css');
  assert.match(css, /\.sfv-library-chrome::before[,\s]/, '应有 ::before 图片承载层');
  const shared = css.slice(css.search(/\.sfv-library-chrome::before\s*,/), css.search(/\.sfv-library-chrome::before\s*\{/));
  assert.match(shared, /position:\s*absolute/, '::before/::after 共享层需绝对定位铺满');
  assert.match(shared, /z-index:\s*-?\d+/, '::before 需沉到卡片之下');
  const before = css.slice(css.search(/\.sfv-library-chrome::before\s*\{/));
  assert.match(before.slice(0, 800), /var\(\s*--sfv-library-bg-image\s*[,)]/, '::before 应消费图片变量');
  assert.match(before.slice(0, 800), /filter:\s*none/, '::before 不应虚化（壁纸画面需正常可见）');
  const afterIdx = css.search(/\.sfv-library-chrome::after(?!,)\s*\{/);
  assert.ok(afterIdx >= 0, '应有 ::after 压暗蒙版');
  const after = css.slice(afterIdx, afterIdx + 600);
  assert.match(after, /rgba\(\s*7\s*,\s*7\s*,\s*7\s*,\s*0?\.[0-3]\d*\s*\)/, '蒙版应≤30% 轻压暗，保壁纸可见');
});

test('apply：离开片库页（无 pageId）应同时清理图片变量', () => {
  const { SFV, overlay, store } = loadModule();
  SFV.onlineShared.activePageId = 'library';
  setPref(store, { type: 'image', value: 'data:image/png;base64,AAAA' });
  SFV.pageBgDiy.apply();
  assert.strictEqual(overlay.style._props['--sfv-library-bg-image'], 'url("data:image/png;base64,AAAA")');
  SFV.onlineShared.activePageId = 'home';
  SFV.pageBgDiy.apply();
  assert.ok(!('--sfv-library-bg-image' in overlay.style._props), '退出片库应移除图片变量');
  assert.ok(!('--sfv-library-bg' in overlay.style._props), '退出片库应移除背景变量');
  assert.ok(!('--sfv-library-accent' in overlay.style._props), '退出片库应移除强调色变量');
  assert.ok(!('--sfv-library-accent-text' in overlay.style._props), '退出片库应移除强调色文字变量');
});

// ---------- 选中态强调色跟随背景（T-选中态强调色 2026-09-26） ----------

const relLum = (hex) => {
  const s = hex.replace('#', '');
  const n = parseInt(s, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

test('resolveAccentForColor：深色背景 → 浅色强调 + 深色按钮文字', () => {
  const { SFV } = loadModule();
  for (const bg of ['#0b1626', '#17102a', '#1c1410', '#14121a']) {
    const a = SFV.pageBgDiy.resolveAccentForColor(bg);
    assert.ok(a, `${bg} 应返回强调色`);
    assert.ok(relLum(a.accent) > 0.7, `${bg} 深底应配浅色强调，实得 ${a.accent}`);
    assert.ok(relLum(a.text) < 0.3, `${bg} 浅强调上文字应为深色，实得 ${a.text}`);
  }
});

test('resolveAccentForColor：纯黑（无彩色）→ 近纯白强调', () => {
  const { SFV } = loadModule();
  const a = SFV.pageBgDiy.resolveAccentForColor('#000000');
  assert.ok(relLum(a.accent) > 0.9, `纯黑应配近纯白，实得 ${a.accent}`);
  const n = parseInt(a.accent.slice(1), 16);
  const [r, , b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  assert.ok(Math.abs(r - b) < 12, `无彩底不应染出强色相：${a.accent}`);
});

test('resolveAccentForColor：浅色背景 → 深色强调 + 白色按钮文字', () => {
  const { SFV } = loadModule();
  const a = SFV.pageBgDiy.resolveAccentForColor('#faf8f5');
  assert.ok(relLum(a.accent) < 0.3, `浅底应配深色强调，实得 ${a.accent}`);
  assert.ok(relLum(a.text) > 0.7, `深强调上文字应为白色，实得 ${a.text}`);
});

test('resolveAccentForColor：保留背景色相（深蓝底 → 蓝调浅强调）', () => {
  const { SFV } = loadModule();
  const a = SFV.pageBgDiy.resolveAccentForColor('#0b1626');
  const n = parseInt(a.accent.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  assert.ok(b > r, `深蓝底色相应保留（b>r），实得 ${a.accent}`);
});

test('apply：color 偏好写 --sfv-library-accent/-text；gradient 与无偏好清除', () => {
  const { SFV, overlay, store } = loadModule();
  SFV.onlineShared.activePageId = 'library';

  setPref(store, { type: 'color', value: '#0b1626' });
  SFV.pageBgDiy.apply();
  const accent = overlay.style._props['--sfv-library-accent'];
  assert.ok(accent, '深蓝预设应落强调色变量');
  assert.ok(relLum(accent) > 0.7, '深底强调应为浅色');
  assert.ok(overlay.style._props['--sfv-library-accent-text'], '应同时落按钮文字色');

  setPref(store, { type: 'gradient' });
  SFV.pageBgDiy.apply();
  assert.ok(!('--sfv-library-accent' in overlay.style._props), '默认渐变应清除变量走 CSS 珊瑚红 fallback');
  assert.ok(!('--sfv-library-accent-text' in overlay.style._props), '默认渐变应清除文字色变量');

  store.delete('stellaflix-page-bg-diy:library');
  SFV.pageBgDiy.apply();
  assert.ok(!('--sfv-library-accent' in overlay.style._props), '无偏好同样走 fallback');
});

test('apply：image 偏好带缓存 accent 直接用缓存；无缓存不写变量且不崩（提取为上传时异步）', () => {
  const { SFV, overlay, store } = loadModule();
  SFV.onlineShared.activePageId = 'library';

  setPref(store, { type: 'image', value: 'data:image/png;base64,AAAA', accent: '#d8e8f8', accentText: '#15131a' });
  SFV.pageBgDiy.apply();
  assert.strictEqual(overlay.style._props['--sfv-library-accent'], '#d8e8f8');
  assert.strictEqual(overlay.style._props['--sfv-library-accent-text'], '#15131a');

  setPref(store, { type: 'image', value: 'data:image/png;base64,BBBB' });
  SFV.pageBgDiy.apply();
  assert.ok(!('--sfv-library-accent' in overlay.style._props), '无缓存时不应写脏强调色');
});

test('computeImageAccent：暗图蓝主色 → 蓝调浅色强调（按整体亮度定明暗）', () => {
  const { SFV } = loadModule();
  // 4x4 像素：深蓝为主 + 少量近黑，整体偏暗
  const px = [];
  const push = (r, g, b) => px.push(r, g, b, 255);
  for (let i = 0; i < 12; i++) push(20, 40, 120);
  for (let i = 0; i < 4; i++) push(5, 5, 8);
  for (let i = 0; i < 4; i++) push(200, 190, 170); // 少量亮色不改整体明暗
  const a = SFV.pageBgDiy.computeImageAccent(px, 4, 4);
  assert.ok(a, '应返回强调色');
  assert.ok(relLum(a.accent) > 0.7, `暗图应配浅色强调，实得 ${a.accent}`);
  const n = parseInt(a.accent.slice(1), 16);
  assert.ok((n & 255) > ((n >> 16) & 255), `蓝主色色相应保留，实得 ${a.accent}`);
  assert.ok(relLum(a.text) < 0.3, '浅强调上文字应深色');
});

test('computeImageAccent：亮图红主色 → 红色系深色强调 + 白字', () => {
  const { SFV } = loadModule();
  const px = [];
  const push = (r, g, b) => px.push(r, g, b, 255);
  for (let i = 0; i < 14; i++) push(235, 90, 80);
  for (let i = 0; i < 2; i++) push(250, 248, 245);
  for (let i = 0; i < 4; i++) push(30, 30, 30);
  const a = SFV.pageBgDiy.computeImageAccent(px, 4, 4);
  assert.ok(relLum(a.accent) < 0.3, `亮图应配深色强调，实得 ${a.accent}`);
  const n = parseInt(a.accent.slice(1), 16);
  assert.ok(((n >> 16) & 255) > (n & 255), '红主色色相应保留');
  assert.ok(relLum(a.text) > 0.7, '深强调上文字应白色');
});

test('computeImageAccent：全灰图 → 无彩色强调（白/黑）', () => {
  const { SFV } = loadModule();
  const px = [];
  for (let i = 0; i < 16; i++) px.push(10, 10, 10, 255);
  const a = SFV.pageBgDiy.computeImageAccent(px, 4, 4);
  const n = parseInt(a.accent.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  assert.ok(relLum(a.accent) > 0.9, `全暗灰图应配近纯白，实得 ${a.accent}`);
  assert.ok(Math.abs(r - g) < 6 && Math.abs(g - b) < 6, '无彩图不应染出强色相');
});

test('poster-wall.css：选中态边框/主按钮走 var(--sfv-library-accent, 珊瑚红) fallback', () => {
  const css = read('public/video/poster-wall/poster-wall.css');
  const focus = css.slice(css.search(/\.sfv-hex-card\.is-focused::after\s*\{/));
  assert.match(focus.slice(0, 400), /border:\s*2px solid var\(\s*--sfv-library-accent\s*,\s*rgba\(253,\s*92,\s*71/,
    '选中框应改为 var(--sfv-library-accent, 珊瑚红)');
  const btn = css.slice(css.search(/\.sfv-hex-btn--primary\s*\{/));
  assert.match(btn.slice(0, 300), /background:\s*var\(\s*--sfv-library-accent\s*,/,
    '主按钮底色应改为 var(--sfv-library-accent, 珊瑚红)');
  assert.match(btn.slice(0, 300), /color:\s*var\(\s*--sfv-library-accent-text\s*,\s*#fff\s*\)/,
    '主按钮文字色应改为 var(--sfv-library-accent-text, #fff)');
});
