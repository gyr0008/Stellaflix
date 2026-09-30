'use strict';

/**
 * 导入歌单弹窗：模态层级与点击行为测试（规格 2026-09-24）
 * 运行：node --test tests/platform-playlist-import-modal.test.js
 *
 * 覆盖：
 * 1) 遮罩静态层级：position:fixed + inset:0，且无 pointer-events:none
 * 2) 点外关闭：target===mask 时关闭，且 stopPropagation（一次点击只允许一个结果）
 * 3) 点内不关：target 为面板子节点时不关闭，但同样拦截冒泡（不得触发背后 UI）
 * 4) busy（导入进行中）时点外不关闭
 * 5) Esc 关闭；IME 组字（isComposing）不关；未打开时 Esc 无副作用
 * 6) 页面级"点空白关 Home"守卫：#sf-ppi-mask 必须在 blockedSelector 白名单内
 *    （Home 关闭跑在 document 捕获阶段，弹窗冒泡拦截对其无效，只能靠该守卫）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.join(__dirname, '..');
const ppiSource = fs.readFileSync(path.join(appRoot, 'public', 'js', 'platform-playlist-import.js'), 'utf8');
const storeSource = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '03b-local-playlist-store.js'), 'utf8');
const wallpaperSource = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '04-home-empty-wallpaper.js'), 'utf8');

function makeEl(tag) {
  const el = {
    tagName: tag, id: '', className: '', value: '', textContent: '', innerHTML: '',
    disabled: false, style: {}, children: [], _listeners: {}, _attrs: {}, _classes: new Set(),
    _qs: {}, _qsa: {},
    classList: {
      add: c => el._classes.add(c),
      remove: c => el._classes.delete(c),
      contains: c => el._classes.has(c),
    },
    setAttribute: (k, v) => { el._attrs[k] = String(v); },
    getAttribute: k => (k in el._attrs ? el._attrs[k] : null),
    addEventListener: (type, fn) => { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    focus() {},
    querySelector: sel => el._qs[sel] || null,
    querySelectorAll: sel => el._qsa[sel] || [],
    appendChild(child) { el.children.push(child); },
  };
  return el;
}

function fire(el, type, event) {
  (el._listeners[type] || []).slice().forEach(fn => fn(event));
}

function makeModalSandbox() {
  const registry = {};
  const docListeners = {};
  const cancelBtn = makeEl('button');
  const confirmBtn = makeEl('button');
  const sourceBtn = makeEl('button'); sourceBtn.setAttribute('data-source', 'tx');
  const entryBtn = makeEl('button'); entryBtn.setAttribute('data-entry', 'lxmc');
  const inputEl = makeEl('textarea'); inputEl.id = 'sf-ppi-input';
  const hintEl = makeEl('div'); hintEl.id = 'sf-ppi-hint';
  registry['sf-ppi-input'] = inputEl;
  registry['sf-ppi-hint'] = hintEl;

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    JSON, Math, Date, String, Number, Array, Object, Boolean, Promise, Set, Map,
    setTimeout: () => 0, clearTimeout: () => {}, // 不排真定时器，避免 90s abort 计时器挂住进程
    encodeURIComponent, decodeURIComponent,
    AbortController, URL, Blob: require('node:buffer').Blob,
    DecompressionStream: globalThis.DecompressionStream,
    Response: globalThis.Response,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'NOT_USED' }) }),
    document: {
      getElementById: id => registry[id] || null,
      querySelector: sel => (sel === '#sf-ppi-mask .sf-ppi-confirm' ? confirmBtn : null),
      querySelectorAll: () => [],
      createElement: tag => {
        const el = makeEl(tag);
        if (tag === 'div') {
          el._qs['.sf-ppi-cancel'] = cancelBtn;
          el._qs['.sf-ppi-confirm'] = confirmBtn;
          el._qsa['[data-source]'] = [sourceBtn];
          el._qsa['[data-entry]'] = [entryBtn];
        }
        return el;
      },
      body: {
        classList: { add() {}, remove() {}, contains: () => false },
        appendChild(node) { if (node.id) registry[node.id] = node; },
      },
      head: { appendChild() {} },
      addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
    },
    showToast() {},
    renderUserPlaylistsList: () => {},
    openPlaylistPanelTab: () => {},
    toggleUploadPanel: () => {},
    openHomeLocalImport: () => {},
    openCustomSourceModal: () => {},
    docListeners, registry, cancelBtn, confirmBtn, inputEl, hintEl,
    fireDoc(type, event) { (docListeners[type] || []).slice().forEach(fn => fn(event)); },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(storeSource, sandbox, { filename: '03b-local-playlist-store.js' });
  vm.runInContext(ppiSource, sandbox, { filename: 'platform-playlist-import.js' });
  return sandbox;
}

function maskOf(sandbox) { return sandbox.registry['sf-ppi-mask']; }

function openDialog(sandbox) {
  sandbox.window.openPlatformPlaylistImport();
  return maskOf(sandbox);
}

function backdropClickEvent(mask) {
  let stopped = false;
  return { target: mask, stopPropagation() { stopped = true; }, get stopped() { return stopped; } };
}

test('遮罩静态层级：fixed 全屏拦截盒且无 pointer-events:none', () => {
  const maskRule = ppiSource.match(/#sf-ppi-mask\{[^}]*\}/);
  assert.ok(maskRule, '应存在 #sf-ppi-mask 规则');
  assert.match(maskRule[0], /position:fixed/, '遮罩必须 position:fixed');
  assert.match(maskRule[0], /inset:0/, '遮罩必须 inset:0 覆盖全视口');
  assert.doesNotMatch(maskRule[0], /pointer-events:\s*none/, '遮罩禁止 pointer-events:none');
});

test('点外关闭：target===mask 时关闭并 stopPropagation', () => {
  const sandbox = makeModalSandbox();
  const mask = openDialog(sandbox);
  assert.ok(mask.classList.contains('open'), '打开后应有 .open');
  const event = backdropClickEvent(mask);
  fire(mask, 'click', event);
  assert.ok(event.stopped, '点遮罩空白必须 stopPropagation，防止页面级点空白逻辑连带触发');
  assert.ok(!mask.classList.contains('open'), '点遮罩空白应关闭弹窗');
});

test('点内不关：target 为面板子节点时不关闭，但必须拦截冒泡', () => {
  const sandbox = makeModalSandbox();
  const mask = openDialog(sandbox);
  let stopped = false;
  fire(mask, 'click', { target: sandbox.confirmBtn, stopPropagation() { stopped = true; } });
  assert.ok(stopped, '弹窗打开期间的任何点击都不得漏给页面级监听（如点空白关面板）');
  assert.ok(mask.classList.contains('open'), '点面板内部不应关闭');
});

test('busy（导入进行中）：点遮罩空白不关闭，但仍拦截冒泡', () => {
  const sandbox = makeModalSandbox();
  const mask = openDialog(sandbox);
  sandbox.inputEl.value = '3778678';
  sandbox.fetch = () => new Promise(() => {}); // 永不 resolve，保持 busy
  fire(sandbox.confirmBtn, 'click', {});
  const event = backdropClickEvent(mask);
  fire(mask, 'click', event);
  assert.ok(event.stopped, 'busy 时点遮罩同样不得漏给页面级监听');
  assert.ok(mask.classList.contains('open'), 'busy 时点外不应关闭');
});

test('Esc 关闭；IME 组字不关；未打开时不生效', () => {
  const sandbox = makeModalSandbox();
  const mask = openDialog(sandbox);
  sandbox.fireDoc('keydown', { key: 'Escape', isComposing: true });
  assert.ok(mask.classList.contains('open'), 'IME 组字中 Esc 不应关闭');
  sandbox.fireDoc('keydown', { key: 'Escape', isComposing: false });
  assert.ok(!mask.classList.contains('open'), 'Esc 应关闭弹窗');
  // 关闭后再按 Esc 不应抛错、不应有副作用
  sandbox.fireDoc('keydown', { key: 'Escape', isComposing: false });
  assert.ok(!mask.classList.contains('open'));
});

test('Home 空白关闭守卫：blockedSelector 必须包含导入弹窗遮罩', () => {
  const guard = wallpaperSource.match(/function isHomeBlankDismissClick[\s\S]*?\n\}/);
  assert.ok(guard, '应存在 isHomeBlankDismissClick');
  assert.ok(guard[0].includes('#sf-ppi-mask'),
    '导入弹窗遮罩须在白名单内：点暗区/面板内一律不得连带关闭 Home（规格 §4）');
});

// ---------- Mineradio 1.6.0 参数对齐（2026-09-24 全面对照结论） ----------
// 基准值来源：Mineradio public/index.html :375-397, :1682, :3871-3878, :3884-3897

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = ppiSource.match(new RegExp(escaped + '\\{[^}]*\\}'));
  return m ? m[0] : '';
}

test('遮罩对齐：底色 rgba(0,0,0,.62) + blur(18px)', () => {
  const rule = cssRule('#sf-ppi-mask');
  assert.match(rule, /background:rgba\(0,0,0,\.62\)/);
  assert.match(rule, /backdrop-filter:blur\(18px\)/);
});

test('对话框对齐：max-height min(720px,vh−48) / padding 20px / 圆角 28px / 透底玻璃', () => {
  const rule = cssRule('.sf-ppi-dialog');
  assert.match(rule, /max-height:min\(720px,calc\(100vh - 48px\)\)/);
  assert.match(rule, /padding:20px/);
  assert.match(rule, /border-radius:28px/);
  assert.match(rule, /background:rgba\(3,4,7,\.38\)/, '应为透底玻璃而非实底渐变');
  assert.match(rule, /backdrop-filter:blur\(34px\) saturate\(1\.28\) brightness\(1\.04\)/);
  assert.match(rule, /box-shadow:0 34px 110px rgba\(0,0,0,\.56\),inset 0 1px 0 rgba\(255,255,255,\.18\),inset 0 -24px 54px rgba\(0,0,0,\.16\)/);
});

test('输入区对齐：textarea min-height 108px / padding 13px 14px / focus 蓝灰', () => {
  const rule = cssRule('.sf-ppi-textarea');
  assert.match(rule, /min-height:108px/);
  assert.match(rule, /padding:13px 14px/);
  const focus = cssRule('.sf-ppi-textarea:focus');
  assert.match(focus, /rgba\(157,184,207,\.56\)/);
  assert.match(focus, /rgba\(157,184,207,\.09\)/);
});

test('按钮组对齐：平台 active 蓝灰 + 辉光 24px；本地入口钮 42px 高', () => {
  const active = cssRule('.sf-ppi-btn.active');
  assert.match(active, /border-color:rgba\(157,184,207,\.55\)/);
  assert.match(active, /background:rgba\(157,184,207,\.16\)/);
  assert.match(active, /0 0 24px rgba\(157,184,207,\.10\)/);
  const entryBtn = cssRule('.sf-ppi-entry-grid .sf-ppi-btn');
  assert.match(entryBtn, /height:42px/);
});

test('动作行对齐：margin-top 16px；取消/提交 30px 高·radius 8·11.5px 字；提交 min-width 116px', () => {
  const actions = cssRule('.sf-ppi-actions');
  assert.match(actions, /margin-top:16px/);
  for (const sel of ['.sf-ppi-cancel', '.sf-ppi-confirm']) {
    const rule = cssRule(sel);
    assert.match(rule, /height:30px/, sel + ' 高应对齐 fx-mini-btn 30px');
    assert.match(rule, /border-radius:8px/, sel + ' 圆角应对齐 8px');
    assert.match(rule, /11\.5px/, sel + ' 字号应对齐 11.5px');
  }
  const confirm = cssRule('.sf-ppi-confirm');
  assert.match(confirm, /min-width:116px/);
});

test('响应式对齐：≤560px 对话框满宽、按钮组降 2 列', () => {
  assert.match(ppiSource, /@media \(max-width:560px\)/, '应存在 560px 断点');
  const mq = ppiSource.match(/@media \(max-width:560px\)\{[\s\S]*?\n/);
  assert.ok(mq && /\.sf-ppi-dialog\{width:100%;max-width:none\}/.test(mq[0]), '窄屏对话框 width:100%;max-width:none');
  assert.ok(mq && /repeat\(2,minmax\(0,1fr\)\)/.test(mq[0]), '窄屏平台/入口组降 2 列');
});
