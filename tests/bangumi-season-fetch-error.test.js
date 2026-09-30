'use strict';

/**
 * 每周新番「往季」抓取失败的可辨识化 + 重试（2026-09-30 A+B 组合批）
 *
 * 实测根因（有来源）：
 *  - 镜像 api.kazumi.fyi 的 POST /v0/search/subjects 现要求 X-AppId/X-Timestamp/X-Signature
 *    签名头（凭证由 Kazumi 发布 CI 注入，第三方无法合法取得）-> 401 invalid request signature；
 *  - 官方 api.bgm.tv 国内直连不可达（需 HTTPS_PROXY 全局代理，desktop/global-proxy.js 已支持）；
 *  - server.js 全源失败时返回裸 502 空 body -> 客户端只得 'HTTP 502'；
 *  - getSeasonCalendar 失败时返回 7 个空桶（length===7），bangumi-timeline 的错误分支
 *    条件 `_state.data.length` 判不出空 -> 真实错误被伪装成「本日无符合条件的番剧」。
 *
 * 本批契约：
 *  A1 客户端把 /api/bangumi/search 错误响应体中的 message 提取进 Error；
 *  A2 getSeasonCalendar 失败时 error 必须如实上浮（不得静默成空数据）；
 *  A3 UI 在「数据全空 + 有错误」时渲染真实错误文案 + 重试按钮，点击重试再次抓取；
 *  A4 抓取成功路径不回退（有数据照常出卡）；
 *  B1 server 全源失败 -> 502 + JSON { error, sources[] }，sources 逐源记 status，
 *     且提示 HTTPS_PROXY；
 *  B2 server 上游列表可经 STELLAFLIX_BANGUMI_SEARCH_UPSTREAMS 覆盖（首源失败自动落到次源）；
 *  B3 全局出口代理装配契约不回退（server.js 启动时 setupGlobalProxy(process.env)）。
 *
 * 运行：node --test tests/bangumi-season-fetch-error.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const net = require('node:net');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---------------------------------------------------------------- 迷你 DOM
function makeClassList(el) {
  const set = new Set();
  return {
    add(...names) { names.forEach((n) => n && set.add(n)); },
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
    style: {},
    attributes: {},
    listeners: {},
    textContent: '',
    _innerHTML: '',
    type: '',
    clientWidth: 1280,
    clientHeight: 720,
  };
  el.classList = makeClassList(el);
  el.appendChild = function (child) { child.parent = this; this.children.push(child); return child; };
  el.removeChild = function (child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parent = null;
    return child;
  };
  el.setAttribute = function (name, value) { this.attributes[name] = String(value); };
  el.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  };
  el.addEventListener = function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
  el.removeEventListener = function (type, fn) {
    const list = this.listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  el.contains = function (node) {
    let cur = node;
    while (cur) { if (cur === this) return true; cur = cur.parent; }
    return false;
  };
  el.querySelectorAll = function (selector) {
    const want = String(selector).toUpperCase();
    const out = [];
    (function walk(node) {
      node.children.forEach((child) => {
        if (child.tagName === want) out.push(child);
        walk(child);
      });
    })(el);
    return out;
  };
  el.querySelector = function (selector) { return this.querySelectorAll(selector)[0] || null; };
  el.getBoundingClientRect = function () { return { left: 0, top: 0, right: 160, bottom: 32, width: 160, height: 32 }; };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._innerHTML; },
    set(value) {
      this._innerHTML = value;
      this.children.forEach((c) => { c.parent = null; });
      this.children = [];
    },
  });
  return el;
}

function fire(el, type, event) {
  const ev = Object.assign({ type, stopPropagation() {}, preventDefault() {}, target: el }, event || {});
  (el.listeners[type] || []).slice().forEach((fn) => fn(ev));
}

function texts(node, out) {
  out = out || [];
  if (node.textContent) out.push(String(node.textContent));
  (node.children || []).forEach((c) => texts(c, out));
  return out;
}

const flush = () => new Promise((r) => setTimeout(r, 30));

// ---------------------------------------------------------------- 模块沙箱
function makeFetchStub(handler) {
  const calls = [];
  const fetchStub = function (url, init) {
    const bodyInit = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ url, init, body: bodyInit });
    const res = handler ? handler(calls.length, bodyInit) : { status: 502, json: { error: 'bangumi_search_upstream_failed' } };
    return Promise.resolve({
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      text: () => Promise.resolve(typeof res.json === 'string' ? res.json : JSON.stringify(res.json)),
      json: () => Promise.resolve(res.json),
    });
  };
  return { fetchStub, calls };
}

function loadTimeline(handler) {
  const sandbox = {
    console, setTimeout, clearTimeout, Date, Math, JSON, Promise,
    innerWidth: 1280, innerHeight: 720,
  };
  sandbox.window = sandbox;
  sandbox.StellaflixVideo = {};
  const { fetchStub, calls } = makeFetchStub(handler);
  sandbox.fetch = fetchStub;
  const store = {};
  sandbox.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  sandbox.document = {
    createElement: (tag) => makeEl(tag),
    body: makeEl('body'),
    documentElement: makeEl('html'),
    addEventListener() {}, removeEventListener() {},
  };
  vm.createContext(sandbox);
  for (const f of ['public/video/bangumi-season.js', 'public/video/bangumi.js', 'public/video/bangumi-timeline.js']) {
    vm.runInContext(read(f), sandbox, { filename: path.basename(f) });
  }
  return { SFV: sandbox.StellaflixVideo, calls };
}

const SEARCH_FAIL = {
  status: 502,
  json: {
    error: 'bangumi_search_upstream_failed',
    message: '全部源失败: 上游 api.kazumi.fyi 返回 401; 上游 api.bgm.tv 返回 timeout',
    sources: [
      { label: 'api.kazumi.fyi', status: 401 },
      { label: 'api.bgm.tv', error: 'timeout' },
    ],
    hint: '往季数据需代理时可设置 HTTPS_PROXY',
  },
};

// ---------------------------------------------------------------- A1/A2 客户端
test('A1 getCalendarBySearch 把错误响应体中的 message 提取进 Error', async () => {
  const { SFV } = loadTimeline(() => SEARCH_FAIL);
  const res = await SFV.bangumi.getCalendarBySearch(['2025-06-01', '2025-09-01'], 20, 0);
  assert.ok(res.error, '失败时必须有 error');
  assert.match(res.error, /全部源失败/, 'Error 应携带 server 返回的可辨识 message，而不是裸 HTTP 502');
});

test('A2 getSeasonCalendar 抓取失败时 error 如实上浮（不得静默成空数据）', async () => {
  const { SFV } = loadTimeline(() => SEARCH_FAIL);
  const res = await SFV.bangumi.getSeasonCalendar(['2025-06-01', '2025-09-01']);
  assert.ok(res.error, '全源失败时 getSeasonCalendar 必须带 error 返回');
  assert.match(res.error, /全部源失败/);
});

// ---------------------------------------------------------------- A3/A4 UI
test('A3 往季抓取失败：UI 显示真实错误而非「本日无符合条件的番剧」，并提供重试', async () => {
  const { SFV, calls } = loadTimeline(() => SEARCH_FAIL);
  const host = makeEl('div');
  SFV.bangumiTimeline._state.selectedDate = new Date(2025, 6, 1);
  SFV.bangumiTimeline._state.isCurrentSeason = false;
  SFV.bangumiTimeline.mount(host);
  await flush();

  const all = texts(host).join('\n');
  assert.match(all, /全部源失败/, '占位文案须含上游真实错误');
  assert.doesNotMatch(all, /本日无符合条件的番剧/, '数据全空且报错时不得伪装成「本日无符合条件」');
  assert.doesNotMatch(all, /^HTTP 502$/m);

  const retry = host.querySelectorAll('BUTTON').find((b) => /重试/.test(b.textContent || ''));
  assert.ok(retry, '错误态须提供「重试」按钮');
  const before = calls.length;
  fire(retry, 'click');
  await flush();
  assert.ok(calls.length > before, '点击重试必须再次发起抓取');
});

test('A4 抓取成功路径不回退：有数据照常渲染卡片', async () => {
  const okBody = {
    status: 200,
    json: {
      total: 1,
      data: [
        { id: 441098, name: 'テスト番', name_cn: '测试番', date: '2025-07-02', rating: { score: 8.2, total: 1234 } },
      ],
    },
  };
  const { SFV } = loadTimeline(() => okBody);
  const host = makeEl('div');
  SFV.bangumiTimeline._state.selectedDate = new Date(2025, 6, 1); // 2025-07-02 周三 -> 桶 2
  SFV.bangumiTimeline._state.isCurrentSeason = false;
  SFV.bangumiTimeline._state.activeDay = 2;
  SFV.bangumiTimeline.mount(host);
  await flush();
  const all = texts(host).join('\n');
  assert.match(all, /测试番/, '成功数据须渲染成卡片');
  assert.doesNotMatch(all, /全部源失败/);
});

// ---------------------------------------------------------------- B1/B2 server 行为
const SRV_PORT = 39879;
const SRV_BASE = 'http://127.0.0.1:' + SRV_PORT;

function startServer(extraEnv) {
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT),
      NODE_NO_WARNINGS: '1',
    }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: root,
  });
  const log = { child, out: '' };
  child.stdout.on('data', (b) => { log.out += b.toString(); });
  child.stderr.on('data', (b) => { log.out += b.toString(); });
  log.waitPort = new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    (function poll() {
      const s = net.connect(SRV_PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        if (Date.now() > deadline) reject(new Error('server not up\n' + log.out));
        else setTimeout(poll, 150);
      });
    })();
  });
  log.stop = () => new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 3000);
  });
  return log;
}

async function postSearch(payload) {
  return fetch(SRV_BASE + '/api/bangumi/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const SEARCH_PAYLOAD = {
  keyword: '',
  sort: 'rank',
  filter: { type: [2], tag: ['日本'], air_date: ['>=2025-06-01', '<2025-09-01'], rank: ['>0', '<=99999'], nsfw: true },
  limit: 20,
  offset: 0,
};

test('B2 上游可经 STELLAFLIX_BANGUMI_SEARCH_UPSTREAMS 覆盖，首源失败自动落到次源', async () => {
  const log = startServer({
    STELLAFLIX_BANGUMI_SEARCH_UPSTREAMS: 'https://www.bing.com/404-probe,https://httpbin.org/post',
  });
  try {
    await log.waitPort;
    const res = await postSearch(SEARCH_PAYLOAD);
    assert.equal(res.status, 200, '次源 httpbin 应兜住首源 bing 404\n' + log.out.slice(-400));
    const json = await res.json();
    assert.ok(json && json.args && String(json.args.limit) === '20', '应透传次源响应（httpbin 回显 query limit）');
  } finally {
    await log.stop();
  }
});

test('B1 全源失败：502 + JSON { error, sources[] }，逐源记录且提示 HTTPS_PROXY', async () => {
  const log = startServer({
    STELLAFLIX_BANGUMI_SEARCH_UPSTREAMS: 'https://www.bing.com/404-probe,https://www.bing.com/404-probe-2',
  });
  try {
    await log.waitPort;
    const res = await postSearch(SEARCH_PAYLOAD);
    assert.equal(res.status, 502);
    const json = await res.json();
    assert.equal(json.error, 'bangumi_search_upstream_failed');
    assert.ok(Array.isArray(json.sources) && json.sources.length === 2, 'sources 须逐源记录: ' + JSON.stringify(json));
    assert.ok(json.sources.every((s) => s.status != null || s.error), '每源须有 status 或 error');
    assert.match(JSON.stringify(json), /HTTPS_PROXY|代理/, '须提示代理配置方向');
  } finally {
    await log.stop();
  }
});

// ---------------------------------------------------------------- B4 上游错误体提取
// 实测镜像 401 体为 {"error":{"code":"unauthorized","message":"invalid request signature"}}
// —— message 嵌套在 error 对象内；naive 的 j.message || j.error 会得到 "[object Object]"。
function namedFunctionSource(text, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  if (!declaration) return '';
  const bodyStart = text.indexOf('{', declaration.index + declaration[0].length);
  if (bodyStart < 0) return '';
  let depth = 0, quote = '', escaped = false;
  for (let i = bodyStart; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (!depth) return text.slice(declaration.index, i + 1); }
  }
  return '';
}

test('B4 上游错误体 message 嵌套在 error 对象内时也能提取（不得出现 [object Object]）', () => {
  const src = read('server.js');
  const fnSrc = namedFunctionSource(src, 'extractUpstreamErrorDetail');
  assert.ok(fnSrc, 'server.js 须有 extractUpstreamErrorDetail()');
  const fn = vm.runInNewContext(`(${fnSrc})`);
  assert.equal(
    fn('{"error":{"code":"unauthorized","message":"invalid request signature"}}'),
    'invalid request signature'
  );
  assert.equal(fn('{"message":"top-level msg"}'), 'top-level msg');
  assert.equal(fn('not json at all'), 'not json at all');
  assert.equal(fn('{"error":"plain string"}'), 'plain string');
  assert.ok(!/\[object Object\]/.test(fn('{"error":{"code":"x","message":"y"}}')));
});

// ---------------------------------------------------------------- B3 代理装配契约
test('B3 全局出口代理装配不回退：bangumi 搜索路由与 setupGlobalProxy 均在位', () => {
  const serverSrc = read('server.js');
  assert.match(serverSrc, /setupGlobalProxy\(process\.env\)/, 'server.js 启动时须按环境变量启用全局代理');
  assert.match(serverSrc, /pn === '\/api\/bangumi\/search'/, '往季搜索路由须存在');
  const gp = read('desktop/global-proxy.js');
  assert.match(gp, /setGlobalDispatcher/, 'global-proxy 须经 undici 全局 dispatcher 注入（fetch 自动沿用）');
});
