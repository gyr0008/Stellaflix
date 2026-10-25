'use strict';
/**
 * 片源面板 drpy(T4) 入口契约测 —— 「外置规则仓库」
 *
 * 主人 10-25 定的位置：不单独开第三个折叠，而是在「规则」折叠里
 * 「内置规则仓库」按钮的右侧加「外置规则仓库」，点击进规则页面做下载 + 添加。
 * 本测把这条位置契约钉死（顺序、只在 SFV.drpy 在场时出现、面板结构、单模块添加）。
 *
 * 假 DOM 说明：huilian-harness 的 makeEl 把 innerHTML 只当字符串存（不清不建子节点），
 * 而 fx-sources 的折叠/面板正文全用 innerHTML 拼装，故本测自带 hydrate()：
 * 走一遍真实节点树，把每个 _innerHTML 解析成可 querySelector 的子树。
 * 运行：node --test tests/fx-sources-drpy-fold.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeEl, fire } = require('./helpers/huilian-harness');

const ROOT = path.resolve(__dirname, '..');
const FX = path.join(ROOT, 'public/video/fx-sources.js');
const INDEX_HTML = path.join(ROOT, 'public/index.html');
const TAB_KEY = 'system';

// ---------------------------------------------------------------- 假 DOM 补强

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source']);
const TOKEN_RE = /<!--[\s\S]*?-->|<\/[a-zA-Z][^>]*>|<[a-zA-Z][^>]*>|[^<]+/g;

/** 把 html 字符串解析进 parent 的子树（只支撑本测用到的标签/属性）。 */
function parseInto(parent, html) {
  const stack = [parent];
  const tokens = String(html || '').match(TOKEN_RE) || [];
  for (const tok of tokens) {
    if (tok.startsWith('<!--')) continue;
    if (tok.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (tok.startsWith('<')) {
      const m = /^<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(tok);
      if (!m) continue;
      const el = makeEl(m[1]);
      const attrRe = /([\w:-]+)(?:=("[^"]*"|'[^']*'|[^\s"'`=<>]+))?/g;
      let a;
      while ((a = attrRe.exec(m[2] || ''))) {
        const raw = a[2] == null ? '' : a[2].replace(/^["']|["']$/g, '');
        el.setAttribute(a[1], decodeEnt(raw));
      }
      const selfClose = /^<.+\/>$/.test(tok) || VOID_TAGS.has(m[1].toLowerCase());
      stack[stack.length - 1].appendChild(el);
      if (!selfClose) stack.push(el);
      continue;
    }
    const text = decodeEnt(tok).trim();
    if (text) stack[stack.length - 1].textContent += text;
  }
}

function decodeEnt(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&times;/g, '×').replace(/&nbsp;/g, ' ');
}

/** 假 DOM 不做文本上卷（textContent 只存本节点自有文本），要读「行内含哪些文案」得自己递归。 */
function textOf(node) {
  if (!node) return '';
  return String(node.textContent || '') + ' ' + (node.children || []).map(textOf).join(' ');
}

/** 生产代码每次 innerHTML 赋值都会清空 children，故按源串变化重新解析。 */
function hydrate(node) {
  if (!node) return node;
  if (node._hydratedSrc !== node._innerHTML) {
    node._hydratedSrc = node._innerHTML;
    parseInto(node, node._innerHTML);
  }
  node.children.forEach(hydrate);
  return node;
}

// ---------------------------------------------------------------- 沙箱装载

function load(options) {
  const opts = options || {};
  const body = makeEl('body');
  const systemPage = makeEl('div');
  systemPage.setAttribute('id', 'fx-console-page-' + TAB_KEY);
  body.appendChild(systemPage);

  const store = {};
  const sandbox = {
    console, Math, Number, Array, Object, String, Boolean, Promise, Set, Map, JSON, Date,
    RegExp, Error, setTimeout, clearTimeout, setInterval, clearInterval,
    encodeURIComponent, decodeURIComponent,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    fetch: () => Promise.reject(new Error('测试不发真实请求')),
  };
  sandbox.document = {
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => (body.querySelector('#' + id) || (id === 'fx-console-page-' + TAB_KEY ? systemPage : null)),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    body,
    readyState: 'complete',
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.StellaflixVideo = {};

  const calls = { importModules: [], syncRules: [], previewRepo: [], added: [] };
  const sourceList = (opts.sources || []).slice();
  sandbox.StellaflixVideo.sources = {
    getSources: () => sourceList,
    addSource: (e) => {
      calls.added.push(e);
      const dup = sourceList.some((s) => (e.drpyModule ? s.drpyModule === e.drpyModule : s.api === e.api));
      if (dup) return { ok: false, reason: 'duplicate-api' };
      sourceList.push(e);
      return { ok: true, source: e };
    },
    removeSource: () => {}, setEnabled: () => {},
  };
  if (opts.drpy) {
    const mods = () => (opts.modules == null
      ? [{ name: '我的模块(DS)', module: '我的模块', api: 'http://127.0.0.1:5555/api/我的模块' }]
      : opts.modules);
    sandbox.StellaflixVideo.drpy = {
      __bridge: true,
      getStatus: () => Promise.resolve({ running: true, state: 'running', baseUrl: 'http://127.0.0.1:5555', pwd: '' }),
      listModules: () => Promise.resolve(mods()),
      importModules: (only) => {
        calls.importModules.push(only);
        const picked = mods().filter((m) => !Array.isArray(only) || only.indexOf(m.module) >= 0);
        const sources = [];
        let skipped = 0;
        picked.forEach((m) => {
          const r = sandbox.StellaflixVideo.sources.addSource({
            name: m.name, api: m.api, enabled: false, type: 'drpy', drpyModule: m.module,
          });
          if (r && r.ok) sources.push(r.source); else skipped += 1;
        });
        return Promise.resolve({ added: sources.length, skipped, sources });
      },
      syncRules: (url) => { calls.syncRules.push(url); return Promise.resolve({ ok: true, added: 1, updated: 0, removed: 0 }); },
      previewRepo: (url) => {
        calls.previewRepo.push(url);
        return Promise.resolve(opts.preview || {
          ok: true,
          version: '2026.10.25-1',
          description: '本仓库只做断言',
          rules: [
            { name: 'repo源A', file: 'repo源A.js', size: 1234, sha256: 'a'.repeat(64), desc: 'A 文案：电影列表源，日更' },
            { name: 'repo源B', file: 'repo源B.js', size: 99, sha256: 'b'.repeat(64), desc: '' },
          ],
        });
      },
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(FX, 'utf8'), sandbox, { filename: 'fx-sources.js' });
  const flush = () => new Promise((r) => setImmediate(r));
  return { sandbox, body, systemPage, SFV: sandbox.StellaflixVideo, calls, sourceList, flush };
}

function foldsOf(systemPage) {
  const root = hydrate(systemPage).querySelector('.sfv-source-folds');
  if (!root) return { root: null, groups: [] };
  return { root, groups: root.children.map((c) => c.getAttribute('data-fx-console-group')) };
}

function rulesFoldBody(systemPage) {
  const { root } = foldsOf(systemPage);
  const rulesFold = root.children.filter((c) => c.getAttribute('data-fx-console-group') === 'rules')[0];
  return hydrate(rulesFold.children[1]);
}

/** glass 面板挂到 body 上；生产代码用 el.id 赋值（假 DOM 不反射成 attribute），故按 .id 找。 */
function drpyPanelOf(body) {
  hydrate(body);
  const panel = body.children.filter((c) => c.id === 'sfv-drpy-panel')[0] || null;
  return panel ? hydrate(panel) : null;
}

/**
 * 打开面板并让列表落地。
 * 假 DOM 的 innerHTML 不是即时解析，所以打开时那次 refreshDrpyStatus 抓不到节点，
 * 需要 hydrate 之后再点一次「刷新」（真浏览器里 innerHTML 同步解析，不存在这一步）。
 */
async function openPanel(ctx) {
  const { systemPage, body, flush } = ctx;
  const { root } = foldsOf(systemPage);
  fire(root, 'click', { target: rulesFoldBody(systemPage).querySelector('.sfv-rule-repo-external') });
  const panel = drpyPanelOf(body);
  fire(panel, 'click', { target: panel.querySelector('.sfv-drpy-refresh') });
  await flush(); await flush();
  return hydrate(panel);
}

// ---------------------------------------------------------------- 位置契约

test('只保留 cms10 / rules 两个折叠（drpy 入口不再单独占一个折叠）', () => {
  assert.deepEqual(foldsOf(load({ drpy: true }).systemPage).groups, ['cms10', 'rules']);
  assert.deepEqual(foldsOf(load({ drpy: false }).systemPage).groups, ['cms10', 'rules']);
});

test('「外置规则仓库」紧跟「内置规则仓库」右侧，且仅在 SFV.drpy 在场时出现', () => {
  const body = rulesFoldBody(load({ drpy: true }).systemPage);
  const btns = body.querySelectorAll('button');
  const iInternal = btns.findIndex((b) => b.classList.contains('sfv-rule-repo-btn'));
  const iExternal = btns.findIndex((b) => b.classList.contains('sfv-rule-repo-external'));
  assert.ok(iInternal >= 0, '内置规则仓库按钮基线断言');
  assert.ok(iExternal >= 0, '缺少外置规则仓库按钮 → 规则引擎又没有 UI 入口');
  assert.equal(iExternal, iInternal + 1, '必须紧邻其右侧，DOM 顺序即视觉顺序');
  assert.ok(btns[iExternal].textContent.indexOf('外置规则仓库') >= 0, '按钮文案须为「外置规则仓库」');

  const noDrpy = rulesFoldBody(load({ drpy: false }).systemPage);
  assert.equal(noDrpy.querySelectorAll('.sfv-rule-repo-external').length, 0,
    'sidecar 桥缺失时不得出现点不开的门');
});

test('点击「外置规则仓库」打开规则页面（glass 面板），含下载与添加所需控件', async () => {
  const { systemPage, body, SFV, flush } = load({ drpy: true });
  const { root } = foldsOf(systemPage);
  const btn = rulesFoldBody(systemPage).querySelector('.sfv-rule-repo-external');
  fire(root, 'click', { target: btn });
  const panel = drpyPanelOf(body);
  assert.ok(panel, '面板未挂到 body');
  assert.equal(panel.getAttribute('aria-hidden'), 'false');
  assert.ok(panel.classList.contains('open'));
  ['sfv-drpy-repo', 'sfv-drpy-sync', 'sfv-drpy-import', 'sfv-drpy-refresh', 'sfv-drpy-hint', 'sfv-drpy-list']
    .forEach((cls) => assert.ok(panel.querySelector('.' + cls), '面板缺少 .' + cls));
  assert.equal(panel.querySelector('.sfv-drpy-repo').getAttribute('value'), null,
    '仓库地址输入框不得有默认值');
  assert.equal(SFV.fxSources.openDrpy(), true, 'openDrpy() 须等价于点这个按钮');

  await flush(); await flush();
  hydrate(panel);
  assert.ok(panel.querySelector('.sfv-drpy-status').textContent.indexOf('1 个') >= 0,
    '侧挂运行中应报告模块数');
  assert.ok(panel.querySelector('.sfv-drpy-item'), '模块列表未渲染 → 没有「添加」的落点');
});

test('单个模块「添加」只提交该模块，并在列表里标记已添加', async () => {
  const ctx = load({ drpy: true });
  const { calls, sourceList, flush } = ctx;
  const panel = await openPanel(ctx);
  const addBtn = panel.querySelector('.sfv-drpy-add');
  assert.ok(addBtn, '模块行缺少添加按钮');
  assert.equal(addBtn.getAttribute('data-mod'), '我的模块');
  fire(panel, 'click', { target: addBtn });
  await flush(); await flush(); await flush();
  assert.deepEqual(calls.importModules, [['我的模块']], '必须按模块名定向导入，而非整仓');
  assert.equal(sourceList.length, 1, '未落进片源列表');
  assert.equal(sourceList[0].type, 'drpy');
  assert.equal(sourceList[0].drpyModule, '我的模块');
  assert.equal(sourceList[0].enabled, false, '新加入的源默认停用');
  hydrate(panel);
  const row = panel.querySelector('.sfv-drpy-item');
  assert.ok(row.classList.contains('is-added'), '已添加的模块行要标记出来，避免重复点');
  assert.ok(row.querySelector('.sfv-drpy-add').textContent.indexOf('已添加') >= 0, '按钮文案要变成已添加');
});

test('「下载规则」把输入框地址原样交给 syncRules，空地址直接拒绝', async () => {
  const { systemPage, body, calls, flush } = load({ drpy: true, modules: [] });
  const { root } = foldsOf(systemPage);
  fire(root, 'click', { target: rulesFoldBody(systemPage).querySelector('.sfv-rule-repo-external') });
  const panel = drpyPanelOf(body);
  const repo = panel.querySelector('.sfv-drpy-repo');
  const syncBtn = panel.querySelector('.sfv-drpy-sync');
  assert.ok(repo && syncBtn, '面板控件未就绪');

  fire(panel, 'click', { target: syncBtn });
  await flush(); await flush();
  assert.equal(calls.syncRules.length, 0, '空地址不得发请求');
  hydrate(panel);
  assert.ok(panel.querySelector('.sfv-drpy-hint').textContent.indexOf('请先填写') >= 0,
    '空地址要当面拒绝，不能静默');

  repo.value = 'https://example.com/manifest.json';
  fire(panel, 'click', { target: syncBtn });
  await flush(); await flush();
  assert.deepEqual(calls.syncRules, ['https://example.com/manifest.json']);
});

test('面板有「预览仓库」钮，且排在「下载规则」之前（先看清单再下载）', async () => {
  const panel = await openPanel(load({ drpy: true }));
  const btns = panel.querySelectorAll('button');
  const iPrev = btns.findIndex((b) => b.classList.contains('sfv-drpy-preview'));
  const iSync = btns.findIndex((b) => b.classList.contains('sfv-drpy-sync'));
  assert.ok(iPrev >= 0, '缺少「预览仓库」按钮 → 用户在下载前看不见仓库里有什么规则');
  assert.ok(iSync >= 0, '基线断言：下载规则按钮仍在');
  assert.ok(iPrev < iSync, '预览应排在下载之前');
  assert.ok(btns[iPrev].textContent.indexOf('预览') >= 0, '按钮文案须含「预览」');
});

test('「预览仓库」实时抓 manifest，把规则名 + 每条文案渲染进列表（不触发下载）', async () => {
  const ctx = load({ drpy: true });
  const { flush } = ctx;
  const panel = await openPanel(ctx);
  panel.querySelector('.sfv-drpy-repo').value = 'https://example.com/rules';
  fire(panel, 'click', { target: panel.querySelector('.sfv-drpy-preview') });
  await flush(); await flush(); await flush();
  hydrate(panel);
  assert.deepEqual(ctx.calls.previewRepo, ['https://example.com/rules'], '输入框地址应原样交给 previewRepo');
  assert.equal(ctx.calls.syncRules.length, 0, '预览不得触发下载/落盘');
  const rows = panel.querySelectorAll('.sfv-drpy-repo-rule');
  assert.equal(rows.length, 2, '应渲染 2 条仓库规则，实际 ' + rows.length);
  assert.ok(textOf(rows[0]).indexOf('repo源A') >= 0, '行内须有规则名');
  assert.ok(textOf(rows[0]).indexOf('A 文案：电影列表源，日更') >= 0, '行内须有该条规则的文案（文案来自仓库 manifest）');
  assert.ok(textOf(rows[1]).indexOf('repo源B') >= 0, '无文案的规则也要出行，不得整条消失');
  assert.ok(panel.querySelector('.sfv-drpy-status').textContent.indexOf('2026.10.25-1') >= 0, '状态行应带仓库版本');
});

test('预览失败：reason 上浮到状态行；空地址当面拒绝', async () => {
  const ctx = load({ drpy: true, preview: { ok: false, reason: 'manifest 拉取/解析失败: 404' } });
  const { flush } = ctx;
  const panel = await openPanel(ctx);
  panel.querySelector('.sfv-drpy-repo').value = 'https://example.com/nope';
  fire(panel, 'click', { target: panel.querySelector('.sfv-drpy-preview') });
  await flush(); await flush(); await flush();
  hydrate(panel);
  assert.ok(panel.querySelector('.sfv-drpy-status').textContent.indexOf('manifest 拉取/解析失败') >= 0,
    '失败原因须上浮，不能只写 console');
  assert.equal(ctx.calls.syncRules.length, 0, '基线断言：预览失败不得触下载');

  const ctx2 = load({ drpy: true });
  const p2 = await openPanel(ctx2);
  fire(p2, 'click', { target: p2.querySelector('.sfv-drpy-preview') });
  await flush(); await flush();
  hydrate(p2);
  assert.equal(ctx2.calls.previewRepo.length, 0, '空地址不得发请求');
  assert.ok(p2.querySelector('.sfv-drpy-hint').textContent.indexOf('请先填写') >= 0, '空地址要当面拒绝');
});

test('index.html：drpy-bridge.js 必须早于 fx-sources.js 加载', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const scripts = html.match(/"video\/[^"]+\.js"/g) || [];
  const iBridge = scripts.indexOf('"video/drpy-bridge.js"');
  const iFx = scripts.indexOf('"video/fx-sources.js"');
  assert.ok(iBridge >= 0, 'index.html 未引入 video/drpy-bridge.js');
  assert.ok(iFx >= 0, 'index.html 未引入 video/fx-sources.js（基线断言）');
  assert.ok(iBridge < iFx, '入口判定读的是 SFV.drpy，桥文件后置会让按钮静默消失');
});

test('合规红线：外置规则仓库面板模板不含任何地址/站点 URL，输入框出厂为空', () => {
  const src = fs.readFileSync(FX, 'utf8');
  const start = src.indexOf('function buildDrpyPanel');
  assert.ok(start >= 0, '缺少 buildDrpyPanel（外置规则仓库页面构造）');
  const tpl = src.slice(start, src.indexOf('\n  }', start));
  assert.doesNotMatch(tpl, /https?:\/\//, '出厂不得内置任何规则仓库地址');
  assert.doesNotMatch(tpl, /value\s*=/, '仓库输入框不得有默认值');
  ['sfv-drpy-status', 'sfv-drpy-repo', 'sfv-drpy-preview', 'sfv-drpy-sync', 'sfv-drpy-import', 'sfv-drpy-refresh', 'sfv-drpy-hint']
    .forEach((cls) => assert.ok(tpl.indexOf(cls) >= 0, '面板缺少 .' + cls));
  // 文案口径：这是「抓外部仓库」的入口（GitHub raw 即可），不是要用户自己搭服务
  assert.ok(tpl.indexOf('GitHub raw') >= 0, '面板须说明可用 GitHub raw 等外部静态托管');
  assert.ok(/sfv-drpy-note/.test(tpl), '缺少 .sfv-drpy-note 说明行');
});
