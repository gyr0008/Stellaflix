'use strict';

/**
 * tests/lx-source-manager-ui.test.js — 批 T13：源管理 UI（徽章 + 面板 + 双通道导入）
 *
 * 手法：沿用 tests/lx-search-frontend.test.js 的 vm 模块片段 + DOM/fetch 桩 harness——
 * 把 00-api-quality-output（真 apiJson/escHtml）与 15-lx-source-manager 按序拼进同一个
 * 外层 `try` 块交 vm 执行（与生产 bundle 语义一致）。index.html/13 模块的接线走静态断言。
 *
 * 覆盖（brief Step 1 六件套 + 台账携带）：
 *  ① status 渲染行（当前/已停用）+ 徽章文案「启用数/总数」；
 *  ② 批量条四键（启用/停用/检查/删除）调 toggle/check/delete 的正确路由与请求体；
 *  ③ 文件导入逐文件校验回执（含失败文件名与携带3 的「重新导入会启用」提示）；
 *  ④ APIKEY 输入展开同 Task 4 规则（lx-source-host.js normalizeImportSourceUrl 同款三段）；
 *  ⑤ 「音源会执行代码」安全提示存在（面板静态 DOM + 链接导入弹窗）；
 *  ⑥ 未装脚本时 resolve 失败引导（spec §5）：13 终态分支接线 + attachNoticeOpenAction 行为；
 *  携带1：select/toggle/delete/import 成功后必须调 window.invalidateLxResolvedAudioCache
 *        与 window.clearLxAudioPrefetchTimer（钉桩计数）。
 *
 * 响应形态以本分支 server.js:8217-8450 为准（非上游）：
 *  - status：{ok, installed:[{id,name,version,author,enabled,current,sources}], active, name, version, enabledCount}
 *  - toggle/select/delete：{ok, name, version, sources, installed[, deleted]}
 *  - check：host 返回逐源数组本体（route 直发），非上游 {checked:[...]} 包壳；
 *  - import：{ok, id, meta:{name,version,...}}。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const P_00 = 'public/js/modules/05-playback/00-api-quality-output.js';
const P_15 = 'public/js/modules/05-playback/15-lx-source-manager.js';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function jsonResponse(payload, status) {
  const code = Number(status) || 200;
  return {
    ok: code < 400,
    status: code,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function makeEl(tag) {
  const classes = new Set();
  const attrs = Object.create(null);
  const el = {
    tagName: String(tag || 'DIV').toUpperCase(),
    className: '',
    id: '',
    style: {},
    dataset: {},
    children: [],
    firstChild: null,
    lastElementChild: null,
    parentNode: null,
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    type: '',
    accept: '',
    multiple: false,
    files: [],
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0,
    classList: {
      add(...names) { names.forEach((n) => classes.add(n)); },
      remove(...names) { names.forEach((n) => classes.delete(n)); },
      toggle(name, on) {
        const want = on === undefined ? !classes.has(name) : !!on;
        if (want) classes.add(name); else classes.delete(name);
        return want;
      },
      contains(name) { return classes.has(name); },
    },
    __listeners: {},
    addEventListener(type, fn) {
      if (typeof fn === 'function') (el.__listeners[type] || (el.__listeners[type] = [])).push(fn);
    },
    removeEventListener() {},
    setAttribute(key, value) {
      attrs[key] = String(value);
      if (key === 'class') el.className = String(value);
    },
    getAttribute(key) {
      return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null;
    },
    removeAttribute(key) { delete attrs[key]; },
    insertAdjacentHTML(_position, html) { el.innerHTML += String(html); },
    // harness 选择器桩：__bySelector（querySelector）/ __allSelector（querySelectorAll）
    querySelector(sel) {
      if (el.__bySelector) return el.__bySelector(sel) || null;
      return null;
    },
    querySelectorAll(sel) {
      if (el.__allSelector) return el.__allSelector(sel) || [];
      return [];
    },
    closest() { return null; },
    containsChild() { return false; },
    focus() {},
    blur() {},
    click() { if (typeof el.onclick === 'function') el.onclick({ target: el }); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      el.firstChild = el.children[0] || null;
      el.lastElementChild = el.children[el.children.length - 1] || null;
      return child;
    },
    insertBefore(child, ref) {
      child.parentNode = el;
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i < 0) el.children.push(child); else el.children.splice(i, 0, child);
      el.firstChild = el.children[0] || null;
      el.lastElementChild = el.children[el.children.length - 1] || null;
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      el.firstChild = el.children[0] || null;
      el.lastElementChild = el.children[el.children.length - 1] || null;
      if (child && child.parentNode === el) child.parentNode = null;
      return child;
    },
    remove() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
  let innerHtmlValue = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return innerHtmlValue; },
    set(value) { innerHtmlValue = String(value == null ? '' : value); },
    configurable: true,
  });
  Object.defineProperty(el, 'textContent', {
    get() { return innerHtmlValue; },
    set(value) { innerHtmlValue = escapeText(value); },
    configurable: true,
  });
  return el;
}

const STATUS_FIXTURE = {
  ok: true,
  active: 'src-a',
  name: '洛雪A',
  version: '1.2.0',
  enabledCount: 1,
  installed: [
    { id: 'src-a', name: '洛雪A', description: '', version: '1.2.0', author: '甲', enabled: true, current: true, sources: { tx: '小秋' } },
    { id: 'src-b', name: '洛雪B', description: '', version: '', author: '乙', enabled: false, current: false, sources: {} },
  ],
};

function makeSandbox(hooks) {
  hooks = hooks || {};
  const state = {
    calls: [],
    toasts: [],
    confirmations: [],
    cacheInvalidations: 0,
    cacheInvalidateArgs: [],
    prefetchCleared: 0,
    availabilityCells: new Map(),
    bulkButtons: {},
    checks: [],
  };
  const registry = {
    'lx-source-top-btn': makeEl('button'),
    'lx-source-top-label': makeEl('span'),
    'lx-source-top-count': makeEl('span'),
    'lx-source-manager-mask': makeEl('div'),
    'lx-source-manager-list': makeEl('div'),
    'lx-source-manager-count': makeEl('small'),
    'lx-source-empty-guide': makeEl('div'),
    'source-fallback-notice': makeEl('div'),
    'source-fallback-stack': makeEl('div'),
    'lx-source-bulk-count': makeEl('span'),
    'lx-source-url-modal': makeEl('div'),
  };
  const mask = registry['lx-source-manager-mask'];
  mask.setAttribute('data-open', '0');
  // index.html 静态 DOM 的初始态：引导块默认 hidden，由模块翻出（⑥c 断言依赖此初值）。
  registry['lx-source-empty-guide'].hidden = true;
  mask.__allSelector = (sel) => (sel === '[data-source-check]' ? state.checks : []);
  mask.__bySelector = (sel) => {
    const availability = /\[data-source-availability="([^"]+)"\]/.exec(sel);
    if (availability) return state.availabilityCells.get(availability[1]) || null;
    const attr = /^\[data-source-([a-z-]+)\]$/.exec(sel);
    if (attr) return state.bulkButtons[attr[1]] || null;
    return null;
  };
  const storage = new Map();
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    Date,
    Math,
    JSON,
    String,
    Number,
    Array,
    Object,
    Boolean,
    Promise,
    RegExp,
    Error,
    Set,
    Map,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    URL,
    URLSearchParams,
    setTimeout(fn, ms) { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    requestAnimationFrame(fn) { if (typeof fn === 'function') fn(); return 0; },
    AbortController,
    addEventListener() {},
    removeEventListener() {},
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)); },
      removeItem: (key) => { storage.delete(key); },
    },
    confirm(message) { state.confirmations.push(String(message)); return hooks.confirm !== false; },
    showToast(text) { state.toasts.push(String(text)); },
    invalidateLxResolvedAudioCache(arg) { state.cacheInvalidations++; state.cacheInvalidateArgs.push(arg === undefined ? '<noarg>' : arg); },
    clearLxAudioPrefetchTimer() { state.prefetchCleared++; },
    fetch: async (url, opts) => {
      const route = String(url || '');
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      state.calls.push({ url: route, method: (opts && opts.method) || 'GET', body });
      if (route.indexOf('/api/lx-source/status') === 0) {
        const payload = hooks.status ? hooks.status() : STATUS_FIXTURE;
        return jsonResponse(payload, payload && payload.ok === false ? 503 : 200);
      }
      if (route.indexOf('/api/lx-source/import') === 0) {
        const payload = hooks.import ? hooks.import(body, state.calls.length) : { ok: false, error: 'TEST_UNSET' };
        return jsonResponse(payload, payload && payload.ok === false ? 400 : 200);
      }
      if (route.indexOf('/api/lx-source/check') === 0) {
        // server.js:8380 —— 本分支 check 路由直发 host 数组本体（非上游 {checked} 包壳）。
        const payload = hooks.check
          ? hooks.check(body)
          : (body.ids || []).map((id, i) => ({ id, ok: i === 0, name: id, sources: i === 0 ? ['tx'] : [], error: i === 0 ? '' : 'LX_SOURCE_CHECK_TIMEOUT' }));
        return jsonResponse(payload);
      }
      if (route.indexOf('/api/lx-source/toggle') === 0) {
        const payload = hooks.toggle
          ? hooks.toggle(body)
          : { ok: true, name: '洛雪A', version: '1.2.0', sources: {}, installed: STATUS_FIXTURE.installed };
        return jsonResponse(payload);
      }
      if (route.indexOf('/api/lx-source/select') === 0) {
        const payload = hooks.select ? hooks.select(body) : { ok: true, id: body.id, name: '洛雪B', version: '', sources: {}, installed: STATUS_FIXTURE.installed };
        return jsonResponse(payload);
      }
      if (route.indexOf('/api/lx-source/delete') === 0) {
        const payload = hooks.del ? hooks.del(body) : { ok: true, deleted: (body.ids || [body.id]).length, name: '洛雪A', version: '', sources: {}, installed: [] };
        return jsonResponse(payload);
      }
      state.unexpected = (state.unexpected || []).concat(route);
      return jsonResponse({ ok: false, code: 'TEST_UNEXPECTED_ROUTE' });
    },
    document: {
      getElementById(id) { return registry[id] || null; },
      createElement(tag) { return makeEl(tag); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      body: makeEl('body'),
    },
  };
  sandbox.window = sandbox;
  return { sandbox, state, registry };
}

function makeHarness(hooks) {
  const { sandbox, state, registry } = makeSandbox(hooks);
  const source = [P_00, P_15].map((p) => read(p)).join('\n');
  const wrapped = 'try {\n' + source + '\n' +
    'window.__loadOk = true;\n' +
    '} catch (e) { window.__loadError = e; }\n';
  vm.createContext(sandbox);
  vm.runInContext(wrapped, sandbox, { filename: 'lx-source-manager.bundle-sim.js' });
  if (sandbox.__loadError) {
    throw new Error('模块装载失败: ' + (sandbox.__loadError.stack || String(sandbox.__loadError)));
  }
  const manager = sandbox.lxSourceManager;
  assert.ok(manager, '模块必须导出 window.lxSourceManager');
  return { sandbox, state, registry, manager };
}

function checkedBoxes(state, ids) {
  state.checks = ids.map((id) => ({ checked: true, getAttribute: () => id }));
}

// ---------- ① status 渲染行 + 徽章「启用数/总数」 ----------

test('T13①：status 渲染行含「当前」「已停用」态，徽章文案 = 启用数/总数', async () => {
  const h = makeHarness();
  assert.equal(typeof h.manager.refreshBadge, 'function');
  await h.manager.refreshBadge();
  assert.equal(h.registry['lx-source-top-label'].textContent, '音源：洛雪A');
  assert.equal(h.registry['lx-source-top-count'].textContent, '1/2', '徽章计数必须是 启用数/总数');
  assert.match(h.registry['lx-source-top-btn'].getAttribute('title') || '', /已启用 1\/2/);

  const rows = h.manager.renderRowsHtml(STATUS_FIXTURE.installed);
  assert.ok(rows.includes('data-source-row="src-a"'), '行必须带 data-source-row');
  assert.ok(/lx-source-row[^"]*active/.test(rows), '当前源行必须挂 active 类');
  assert.ok(/lx-source-row[^"]*disabled/.test(rows), '停用行必须挂 disabled 类');
  assert.match(rows, /当前/, '当前源必须渲染「当前」标记');
  assert.match(rows, /已停用/, '停用源必须渲染「已停用」态');
  assert.ok(rows.includes('data-source-id="src-b"'), '行主体必须带 data-source-id 供切换');
  assert.ok(rows.includes('data-source-availability="src-a"'), '每行必须带可用性单元格');
});

test('T13①b：status 空库=未配置文案；拉取失败=不可用，计数清空', async () => {
  const h = makeHarness({ status: () => ({ ok: true, sources: [], active: null, name: '未配置', version: '', installed: [], enabledCount: 0 }) });
  await h.manager.refreshBadge();
  assert.equal(h.registry['lx-source-top-label'].textContent, '音源：未配置');
  assert.equal(h.registry['lx-source-top-count'].textContent, '');
});

// ---------- ② 批量条四键 → toggle/check/delete 正确路由 ----------

test('T13②：批量启用/停用走 /toggle（ids+enabled），检查走 /check，删除走 /delete（ids）', async () => {
  const h = makeHarness();
  await h.manager.refreshBadge();
  checkedBoxes(h.state, ['src-a', 'src-b']);

  await h.manager.bulkSetEnabled(true);
  await h.manager.bulkSetEnabled(false);
  const toggles = h.state.calls.filter((c) => c.url.indexOf('/api/lx-source/toggle') === 0);
  assert.equal(toggles.length, 2, '批量启停必须各发一次 toggle 路由');
  assert.deepEqual(toggles[0].body, { ids: ['src-a', 'src-b'], enabled: true });
  assert.deepEqual(toggles[1].body, { ids: ['src-a', 'src-b'], enabled: false });
  assert.ok(toggles.every((c) => c.method === 'POST'), 'toggle 必须 POST（路由 405 守卫）');

  const cellA = makeEl('span');
  const cellB = makeEl('span');
  h.state.availabilityCells.set('src-a', cellA);
  h.state.availabilityCells.set('src-b', cellB);
  await h.manager.bulkCheck();
  const checks = h.state.calls.filter((c) => c.url.indexOf('/api/lx-source/check') === 0);
  assert.equal(checks.length, 1);
  assert.deepEqual(checks[0].body, { ids: ['src-a', 'src-b'] });
  // 本分支 check 路由直发数组本体（server.js:8372），逐源结果必须写回可用性单元格
  assert.equal(cellA.textContent, '可用');
  assert.equal(cellB.textContent, '不可用');
  assert.ok(h.state.toasts.some((t) => /检查完成/.test(t)), '检查完成必须 toast 汇报');

  await h.manager.bulkDelete();
  const deletes = h.state.calls.filter((c) => c.url.indexOf('/api/lx-source/delete') === 0);
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].body, { ids: ['src-a', 'src-b'] });
  assert.equal(h.state.confirmations.length, 1, '批量删除必须先 confirm');

  // 单选停用也走同一路由，body 用 ids 数组（host normalizeSourceIds 宽容接收）
  await h.manager.toggleSource('src-a');
  const single = h.state.calls.filter((c) => c.url.indexOf('/api/lx-source/toggle') === 0).pop();
  assert.deepEqual(single.body.ids, ['src-a']);
  assert.equal(single.body.enabled, false, '当前启用行的单源按钮语义 = 停用');
});

// ---------- 携带1：源状态变化必须清客户端解析缓存与预取定时器 ----------

test('T13携带1：select/toggle/delete/import 成功后必须同时调 invalidateLxResolvedAudioCache 与 clearLxAudioPrefetchTimer', async () => {
  const h = makeHarness({
    import: () => ({ ok: true, id: 'src-c', meta: { name: '洛雪C', version: '0.1' } }),
  });
  await h.manager.refreshBadge();
  assert.equal(h.state.cacheInvalidations, 0, '纯读取不得触发缓存失效');

  await h.manager.selectSource('src-b');
  assert.ok(h.state.cacheInvalidations >= 1 && h.state.prefetchCleared >= 1, '切换音源必须双清');
  const before = h.state.cacheInvalidations;

  await h.manager.toggleSource('src-a');
  assert.ok(h.state.cacheInvalidations > before && h.state.prefetchCleared > before - 1, '启停必须双清');

  await h.manager.deleteSource('src-b');
  assert.ok(h.state.cacheInvalidations >= 3 && h.state.prefetchCleared >= 3, '删除必须双清');

  await h.manager.importFiles([{ name: 'c.js', text: async () => '/*! 洛雪音源 */' }]);
  assert.ok(h.state.cacheInvalidations >= 4 && h.state.prefetchCleared >= 4, '导入必须双清');
});

// ---------- ③ 文件导入逐文件校验回执 ----------

test('T13③：文件导入逐文件回执（成功/失败名各计），import 走 {fileName, script}，收据含重导入启用提示', async () => {
  const seen = [];
  const h = makeHarness({
    import: (body) => {
      seen.push(body);
      if (body.fileName === 'bad.js') return { ok: false, error: 'LX_SOURCE_FILE_INVALID', code: 'LX_SOURCE_FILE_INVALID' };
      return { ok: true, id: 'good-1', meta: { name: '好音源', version: '3.0', enabled: true } };
    },
  });
  const receipt = await h.manager.importFiles([
    { name: 'good.js', text: async () => 'script-good' },
    { name: 'bad.js', text: async () => 'script-bad' },
  ]);
  assert.deepEqual(seen.map((b) => b.fileName), ['good.js', 'bad.js'], '必须逐文件串行 POST /api/lx-source/import');
  assert.ok(seen.every((b) => 'script' in b && !('url' in b)), '文件通道体为 {fileName, script}');
  assert.ok(h.state.toasts.some((t) => /正在验证音源 1\/2/.test(t)), '逐文件校验必须实时回执进度');
  assert.ok(h.state.toasts.some((t) => /正在验证音源 2\/2：bad\.js/.test(t)), '回执必须带文件名');
  assert.match(receipt, /已导入 1 个音源/, '收据必须给出成功数');
  assert.match(receipt, /失败 1 个（bad\.js）/, '收据必须给出失败数与失败文件名');
  assert.match(receipt, /好音源/, '收据必须带当前源名（本分支 import 响应 {ok,id,meta}）');
  assert.match(receipt, /重新导入同一音源会自动启用已停用记录/, '携带3：重复导入静默复活停用记录——必须在收据文案披露');
});

// ---------- ④ APIKEY 输入展开 = Task 4 规则（lx-source-host normalizeImportSourceUrl） ----------

test('T13④：APIKEY/裸域/https-ynx 展开规则与 lx-source-host.js normalizeImportSourceUrl 一致', async () => {
  const h = makeHarness();
  const KEY = 'a'.repeat(64);
  assert.equal(h.manager.normalizeUrlInput(KEY),
    'http://ynx.de5.net/API/lx-ynx.php?APIKEY=' + KEY,
    '64 位 hex APIKEY 必须展开为 ynx 兼容端点（Task 4 规则①）');
  assert.equal(h.manager.normalizeUrlInput('ynx.de5.net/API/x.php?k=1'),
    'http://ynx.de5.net/API/x.php?k=1', '裸 ynx.de5.net/ 前缀必须补 http（规则②）');
  assert.equal(h.manager.normalizeUrlInput('https://ynx.de5.net/API/lx-ynx.php'),
    'http://ynx.de5.net/API/lx-ynx.php', 'ynx https 必须预降级 http（规则③）');
  assert.equal(h.manager.normalizeUrlInput('https://example.com/source.js'),
    'https://example.com/source.js', '普通 https 链接原样');
  assert.equal(h.manager.normalizeUrlInput('ftp://example.com/x.js'), '', '非 http(s) 拒绝');
  assert.equal(h.manager.normalizeUrlInput('  '), '', '空白拒绝');
  // UI：粘贴 APIKEY 时输入框下方必须展开识别提示（同规则驱动，不重复实现判定）
  assert.match(h.manager.apiKeyHintText(KEY), /识别为 APIKEY/);
  assert.equal(h.manager.apiKeyHintText('https://example.com/a.js'), '');
  assert.ok(/APIKEY/.test(h.manager.urlModalHtml()), '链接导入弹窗必须说明可粘贴 64 位 APIKEY');
});

test('T13④b：链接导入体走 {url} 通道并复用展开规则', async () => {
  const h = makeHarness({
    import: (body) => (body.url === 'http://ynx.de5.net/API/lx-ynx.php?APIKEY=' + 'b'.repeat(64)
      ? { ok: true, id: 'u1', meta: { name: '远端源', version: '' } }
      : { ok: false, error: 'LX_SOURCE_URL_INVALID' }),
  });
  await h.manager.importFromUrl('  ' + 'b'.repeat(64) + ' ');
  const call = h.state.calls.find((c) => c.url.indexOf('/api/lx-source/import') === 0);
  assert.ok(call.body.url, '链接通道体必须带 url');
  assert.equal('script' in call.body, false);
  assert.ok(h.state.toasts.some((t) => /已接入：远端源/.test(t)), '成功必须回执接入名');
  await assert.rejects(() => h.manager.importFromUrl('垃圾输入'), '无效输入必须抛 INVALID_SOURCE_URL');
});

// ---------- ⑤ 「音源会执行代码」安全提示 ----------

test('T13⑤：面板与链接导入弹窗必须含「音源会执行代码」安全提示（上游 :29917 同款）', () => {
  const html = read('public/index.html');
  const panelStart = html.indexOf('id="lx-source-manager-mask"');
  assert.ok(panelStart > 0, 'index.html 必须内联 #lx-source-manager-mask 面板 DOM');
  const panel = html.slice(panelStart, html.indexOf('lx-source-manager-mask 面板结束', panelStart) > 0
    ? html.indexOf('lx-source-manager-mask 面板结束', panelStart)
    : panelStart + 9000);
  assert.match(panel, /音源会执行代码/, '面板必须常驻安全提示');

  const h = makeHarness();
  assert.match(h.manager.urlModalHtml(), /音源会执行代码/, '链接导入弹窗必须同款提示');
});

// ---------- ⑥ 未装脚本引导（spec §5）：resolve 失败路径 → 打开面板 ----------

test('T13⑥：13 播放终态按 LX_NO_SOURCES 分流并接线 manager.attachNoticeOpenAction（静态）', () => {
  const p13 = read('public/js/modules/05-playback/13-playback-start-audio.js');
  assert.match(p13, /terminalCode === 'LX_NO_SOURCES'[\s\S]{0,260}attachNoticeOpenAction/,
    'T9 终态分支必须在 NO_SOURCES 码时调用面板接线钩子');
});

test('T13⑥b：attachNoticeOpenAction 在最近失败通知卡上挂「打开音源管理」按钮，点击即开面板', async () => {
  const h = makeHarness();
  const card = makeEl('div');
  card.className = 'source-fallback-card';
  h.registry['source-fallback-stack'].appendChild(card);
  h.manager.attachNoticeOpenAction();
  const btn = card.children.find((c) => c.getAttribute && c.getAttribute('data-lx-open-manager'));
  assert.ok(btn, '通知卡必须挂上打开面板按钮');
  assert.equal(btn.textContent, '打开音源管理');
  btn.click();
  assert.equal(h.registry['lx-source-manager-mask'].getAttribute('data-open'), '1',
    '点击必须直接打开源管理面板（含未装脚本引导态）');
  assert.ok(h.state.calls.some((c) => c.url.indexOf('/api/lx-source/status') === 0),
    '打开面板必须拉取最新 status');
  // 幂等：重复 attach 不得挂第二个按钮
  const n = card.children.length;
  h.manager.attachNoticeOpenAction();
  assert.equal(card.children.length, n, 'attachNoticeOpenAction 必须幂等');
});

test('T13⑥c：空库开面板 → 未装脚本引导可见（spec §5：不能白屏）', async () => {
  const h = makeHarness({
    status: () => ({ ok: true, sources: [], active: null, name: '未配置', version: '', installed: [], enabledCount: 0 }),
  });
  await h.manager.open();
  assert.equal(h.registry['lx-source-manager-mask'].getAttribute('data-open'), '1');
  assert.equal(h.registry['lx-source-empty-guide'].hidden, false, '未装脚本引导块必须从 hidden 翻出');
  const guide = read('public/index.html');
  const idx = guide.indexOf('lx-source-empty-guide');
  assert.match(guide.slice(idx, idx + 800), /导入/, '引导块必须指向导入通道');
});

// ---------- 批 T13 修复轮1：全选下发 / 遮罩懒绑 / 弹窗遮罩 / 徽章失败回填 ----------

test('T13修复·全选：勾全选把 checked 下发到每一行，计数与批量钮随之联动；取消清空（旧实现只读不下发）', async () => {
  const h = makeHarness();
  await h.manager.refreshBadge();
  const rowA = { checked: false, getAttribute: () => 'src-a' };
  const rowB = { checked: false, getAttribute: () => 'src-b' };
  h.state.checks = [rowA, rowB];
  const selectAll = makeEl('input');
  selectAll.checked = false;
  h.state.bulkButtons['select-all'] = selectAll;
  ['enable', 'disable', 'check', 'delete'].forEach((k) => {
    const btn = makeEl('button'); btn.disabled = true; h.state.bulkButtons['bulk-' + k] = btn;
  });
  h.state.bulkButtons['bulk-count'] = makeEl('span');

  selectAll.checked = true;
  h.manager.applySelectAll();
  assert.equal(rowA.checked, true, '全选必须把行 checkbox 置 checked（下发到行）');
  assert.equal(rowB.checked, true);
  assert.equal(h.state.bulkButtons['bulk-count'].textContent, '已选 2 个', '下发后计数=选中行数');
  assert.equal(h.state.bulkButtons['bulk-enable'].disabled, false, '有选中时批量钮必须解禁');

  selectAll.checked = false;
  h.manager.applySelectAll();
  assert.equal(rowA.checked, false, '取消全选必须清空行勾选');
  assert.equal(rowB.checked, false);
  assert.equal(h.state.bulkButtons['bulk-count'].textContent, '已选 0 个');
  assert.equal(h.state.bulkButtons['bulk-enable'].disabled, true);
});

test('T13修复·遮罩：背景点击关闭监听在首次 open 才懒绑（模块加载期面板 DOM 尚不存在，载入即绑会静默失联）', async () => {
  const h = makeHarness();
  const mask = h.registry['lx-source-manager-mask'];
  assert.ok(!mask.__listeners.click, 'open 之前不得有遮罩监听（钉死懒绑，杜绝模块 load 期绑死 null）');
  await h.manager.open();
  assert.ok(mask.__listeners.click && mask.__listeners.click.length === 1, '首次 open 懒绑恰一个背景关闭监听');
  await h.manager.open();
  assert.equal(mask.__listeners.click.length, 1, '重复 open 不得重绑（once-flag）');
  mask.setAttribute('data-open', '1');
  mask.__listeners.click[0]({ target: mask });
  assert.equal(mask.getAttribute('data-open'), '0', '点击遮罩背景必须关闭面板');
  mask.setAttribute('data-open', '1');
  mask.__listeners.click[0]({ target: makeEl('div') });
  assert.equal(mask.getAttribute('data-open'), '1', '点击对话框内部不得关闭');
});

test('T13修复·弹窗：链接导入弹窗背景点击关闭（懒绑，与面板同款，上游 :29927）', () => {
  const h = makeHarness();
  const modal = h.registry['lx-source-url-modal'];
  h.manager.openUrlModal();
  assert.ok(modal.__listeners.click && modal.__listeners.click.length === 1, 'openUrlModal 懒绑背景关闭');
  modal.style.display = 'flex';
  modal.__listeners.click[0]({ target: modal });
  assert.equal(modal.style.display, 'none', '点击弹窗背景必须关闭');
  h.manager.openUrlModal();
  assert.equal(modal.__listeners.click.length, 1, '重复 open 不重绑（元素级 once-flag）');
});

test('T13修复·徽章失败：refreshLxSourceBadge 的 catch 内重新 getElementById（不复用 try 前的 null 局部量）', () => {
  const src = read(P_15);
  const start = src.indexOf('async function refreshLxSourceBadge');
  const fn = src.slice(start, src.indexOf('// —— 面板行渲染', start));
  const catchAt = fn.indexOf('catch');
  assert.ok(catchAt > 0, 'refreshLxSourceBadge 必须有 catch 分支');
  assert.ok(!/var\s+label\s*=\s*document\.getElementById/.test(fn.slice(0, catchAt)),
    'try 之前不应预查 label/count（首屏徽章 DOM 未注入会拿到 null 并被 catch 复用）');
  assert.ok(fn.slice(catchAt).includes("document.getElementById('lx-source-top-label')"),
    'catch 内必须重新查询徽章 label');
});

test('T13修复·携带1b：源变更调用 window 失效钩子必须传空参/nullish（整库语义，不得塞具体 song）', async () => {
  const h = makeHarness({
    import: () => ({ ok: true, id: 'src-c', meta: { name: '洛雪C', version: '0.1' } }),
  });
  await h.manager.refreshBadge();
  await h.manager.selectSource('src-b');
  await h.manager.toggleSource('src-a');
  await h.manager.deleteSource('src-b');
  await h.manager.importFiles([{ name: 'c.js', text: async () => 'x' }]);
  assert.ok(h.state.cacheInvalidateArgs.length >= 4, '四动作各触发一次失效钩子');
  const scoped = h.state.cacheInvalidateArgs.find((a) => a && typeof a === 'object' && Object.keys(a).length > 0);
  assert.equal(scoped, undefined, '失效必须整库（空参/nullish）；传带身份 song 会退化成前缀漏网真实键');
});

test('T13修复·④parity：APIKEY 展开期望值取自 lx-source-host.normalizeImportSourceUrl（防字面量漂移）', () => {
  const host = require('../lx-source-host');
  assert.equal(typeof host.normalizeImportSourceUrl, 'function', '服务端归一函数必须可 require');
  const h = makeHarness();
  const KEY = 'c'.repeat(64);
  for (const input of [KEY, 'ynx.de5.net/API/x.php?k=1', 'https://ynx.de5.net/API/lx-ynx.php', 'https://example.com/source.js']) {
    assert.equal(h.manager.normalizeUrlInput(input), host.normalizeImportSourceUrl(input),
      'UI 归一必须与 host 归一对同输入逐字节等价（任一侧漂移即红）');
  }
  // UI 层对非法输入返回 ''，host 抛 LX_SOURCE_URL_INVALID——语义差异显式钉住。
  assert.equal(h.manager.normalizeUrlInput('ftp://example.com/x.js'), '');
  assert.throws(() => host.normalizeImportSourceUrl('ftp://example.com/x.js'), /LX_SOURCE_URL_INVALID/);
});
