'use strict';

/**
 * 多源面板重查链路回归（2026-10-03 审查 P1-1 / P1-2）：
 *
 *  P1-1：retrySource / searchSourceWithKeyword 曾全局 searchToken++，
 *        使同轮其他源在途回调被 F2 守卫整段丢弃 → 兄弟源 Tab 永久停在灰点+「搜索中…」。
 *  P1-2：重查返回 0 条时 appendSource 以「本轮新增渲染数」定状态，
 *        cnt=0 → setStatus('none')，绿点翻橙且冒出「无结果」部件，与源内已有可播行矛盾；
 *        重查返回重叠结果时旧行不清除、新行按新下标重复渲染，候选池同 id 重复入池。
 *
 * 契约：
 *  A. 单源重试不得掐死同轮兄弟源的在途结果（结果照常入面板、点亮绿点）。
 *  B. 重新发起整轮搜索（onPlayClick 二轮）仍须作废旧轮全部在途回调（F2 语义保持）。
 *  C. 重查空结果：源内已有行时状态点保持 ok，不显示「无结果」错误部件。
 *  D. 重查重叠结果：行不重复渲染，副标题计数不膨胀。
 *
 * 运行：node --test tests/source-picker-retry.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, 'public', 'video', p), 'utf8');
const { makeEl, fire } = require('./helpers/huilian-harness');

function deferred() {
  let res;
  const p = new Promise((r) => { res = r; });
  return { p, res };
}

const flush = async (n) => { for (let i = 0; i < (n || 40); i++) await Promise.resolve(); };

function loadStack(sourcesStub) {
  const body = makeEl('body');
  const doc = {
    createElement: (tag) => makeEl(tag),
    body,
    documentElement: body,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const sf = {
    detail: {
      toast: () => {},
      classifyCandidateEmbed: () => false,
      isKazumiView: (v) => !!(v && v.isKazumi),
    },
    model: { getProgress: () => null, canonicalTrackKey: () => null },
    watchHistory: { update: () => {} },
    kazumi: { getEnabledSearchRules: () => [], searchRule: async () => ({ items: [] }) },
    online: { playEpisode: () => {} },
    player: { getVideoEl: () => null },
    sources: sourcesStub,
  };
  const sandbox = {
    console, Promise, Date, Math, JSON, RegExp, String, Number, Object, Array, Error,
    Set, Map, document: doc,
    requestAnimationFrame: (fn) => { try { fn(); } catch (e) {} },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    encodeURIComponent, decodeURIComponent,
    StellaflixVideo: sf,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('search-filter-core.js'), sandbox, { filename: 'search-filter-core.js' });
  vm.runInContext(read('source-picker.js'), sandbox, { filename: 'source-picker.js' });
  sf.detailSource = undefined; // 幂等守卫清除
  vm.runInContext(read('detail-source.js'), sandbox, { filename: 'detail-source.js' });
  return { ds: sf.detailSource, doc };
}

// ---- 面板 DOM 探针（假 DOM 作用域查询，与 huilian-harness 同一 matches 语义）----
function pickerRoot(doc) { return doc.body.querySelector('.sfv-picker'); }
function dotClass(doc, key) {
  const pill = pickerRoot(doc).querySelector('.sfv-picker-pill[data-key="' + key + '"]');
  assert.ok(pill, 'Tab 应存在：' + key);
  return pill.querySelector('.sfv-picker-dot').className;
}
function sourceSection(doc, key) {
  const sec = pickerRoot(doc).querySelector('.sfv-picker-source[data-key="' + key + '"]');
  assert.ok(sec, '源分区应存在：' + key);
  return sec;
}
const rowsOf = (doc, key) => sourceSection(doc, key).querySelectorAll('.sfv-picker-row');
const subtitleOf = (doc) => pickerRoot(doc).querySelector('.sfv-picker-subtitle').textContent;

// 每次 search(kw, {sources:[ref]}) 记一条 {id, kw, d}，由测试手动 resolve（确定性流式）。
function makeSearchHarness() {
  const calls = [];
  const search = (kw, opt) => {
    const entry = { id: opt.sources[0].id, kw, d: deferred() };
    calls.push(entry);
    return entry.d.p;
  };
  const callFor = (id, from = 0) => {
    const hit = calls.slice(from).filter((c) => c.id === id)[0];
    assert.ok(hit, '应有 ' + id + ' 的搜索调用');
    return hit;
  };
  return { calls, search, callFor };
}

const cmsItem = (sourceId, vodId, name, title) => ({
  title: title || '测试片',
  year: '2020',
  variants: [{ sourceId, vodId, sourceName: name }],
});
const okRes = (items) => ({ items, errors: [] });

// ---------------------------------------------------------------- A. P1-1 单源重试不误伤兄弟源

test('A 重试某一无结果源后，同轮另一在途源的结果仍须填充进面板', async () => {
  const h = makeSearchHarness();
  const { ds, doc } = loadStack({
    getEnabledSources: () => [{ id: 's1', name: '源A' }, { id: 's2', name: '源B' }],
    search: h.search,
  });
  ds.onPlayClick({ key: 'v1', title: '测试片' }, makeEl('div'));

  h.callFor('s1').d.res(okRes([]));
  await flush();
  assert.match(dotClass(doc, 'cms:s1'), /sfv-picker-dot--none/, 's1 空结果应为橙点');

  await ds.retrySource('cms:s1');
  h.callFor('s1', 1).d.res(okRes([]));
  await flush();

  h.callFor('s2').d.res(okRes([cmsItem('s2', '77', '源B')]));
  await flush();
  assert.strictEqual(rowsOf(doc, 'cms:s2').length, 1,
    's2 在途结果不得被 s1 的重试作废（P1-1）');
  assert.match(dotClass(doc, 'cms:s2'), /sfv-picker-dot--ok/, 's2 有命中应点亮绿点');
});

// ---------------------------------------------------------------- B. F2 轮级失效保持

test('B 重新发起整轮搜索后，上一轮在途结果仍须整段作废', async () => {
  const h = makeSearchHarness();
  const { ds, doc } = loadStack({
    getEnabledSources: () => [{ id: 's1', name: '源A' }, { id: 's2', name: '源B' }],
    search: h.search,
  });
  ds.onPlayClick({ key: 'v1', title: '测试片' }, makeEl('div'));
  ds.onPlayClick({ key: 'v1', title: '测试片' }, makeEl('div')); // 第二轮，弹窗重建

  h.callFor('s2').d.res(okRes([cmsItem('s2', '77', '源B')])); // 第 1 轮 s2
  await flush();
  assert.strictEqual(rowsOf(doc, 'cms:s2').length, 0, '旧轮结果不得写入新面板');
  assert.match(dotClass(doc, 'cms:s2'), /sfv-picker-dot--wait/, '旧轮回调不得改状态点');

  h.callFor('s2', 2).d.res(okRes([cmsItem('s2', '77', '源B')])); // 第 2 轮 s2
  await flush();
  assert.strictEqual(rowsOf(doc, 'cms:s2').length, 1, '当前轮结果须正常填充');
});

// ---------------------------------------------------------------- C. P1-2 重查空结果不翻 none

test('C 有结果的源用别名重查落空时，绿点与既有行保持，不出现无结果部件', async () => {
  const h = makeSearchHarness();
  const { ds, doc } = loadStack({
    getEnabledSources: () => [{ id: 's1', name: '源A' }],
    search: h.search,
  });
  ds.onPlayClick({ key: 'v1', title: '测试片' }, makeEl('div'));
  h.callFor('s1').d.res(okRes([cmsItem('s1', '9', '源A')]));
  await flush();
  assert.strictEqual(rowsOf(doc, 'cms:s1').length, 1);
  assert.match(dotClass(doc, 'cms:s1'), /sfv-picker-dot--ok/);

  await ds.searchSourceWithKeyword('cms:s1', '冷门别名');
  h.callFor('s1', 1).d.res(okRes([]));
  await flush();
  assert.match(dotClass(doc, 'cms:s1'), /sfv-picker-dot--ok/,
    '重查落空不得把有行的源翻成橙点（P1-2）');
  assert.strictEqual(sourceSection(doc, 'cms:s1').querySelector('.sfv-picker-error'), null,
    '源内已有行时不得显示「无结果」错误部件');
});

// ---------------------------------------------------------------- D. P1-2 重查重叠不重复渲染

test('D 重查命中与旧结果完全重叠时，行与计数保持一份', async () => {
  const h = makeSearchHarness();
  const { ds, doc } = loadStack({
    getEnabledSources: () => [{ id: 's1', name: '源A' }],
    search: h.search,
  });
  const item = cmsItem('s1', '9', '源A');
  ds.onPlayClick({ key: 'v1', title: '测试片' }, makeEl('div'));
  h.callFor('s1').d.res(okRes([item]));
  await flush();

  await ds.searchSourceWithKeyword('cms:s1', '别名');
  h.callFor('s1', 1).d.res(okRes([item])); // 同一 (sourceId, vodId) 再次命中
  await flush();
  assert.strictEqual(rowsOf(doc, 'cms:s1').length, 1,
    '重叠命中不得重复渲染第二行（P1-2）');
  assert.strictEqual(subtitleOf(doc), '1 个数据源 · 1 个命中条目',
    '副标题计数须保持一份');
});

// ---------------------------------------------------------------- E. 源 Tab 栏滚轮横向滚动

test('E Tab 栏滚轮映射为横向滚动并阻止穿透，触控板横手势以 deltaX 优先', async () => {
  const h = makeSearchHarness();
  const { ds, doc } = loadStack({
    getEnabledSources: () => [{ id: 's1', name: '源A' }],
    search: h.search,
  });
  ds.onPlayClick({ key: 'v1', title: '测试片' }, makeEl('div'));

  const bar = pickerRoot(doc).querySelector('.sfv-picker-tabs');
  assert.ok(bar, 'Tab 栏应存在');
  bar.scrollLeft = 0;

  let pd = false;
  fire(bar, 'wheel', { deltaY: 120, deltaX: 0, preventDefault: () => { pd = true; } });
  assert.strictEqual(bar.scrollLeft, 120, '纵向滚轮须映射为横向滚动（片源多时不被遮盖）');
  assert.ok(pd, '须 preventDefault 阻止滚轮穿透到背后页面');

  fire(bar, 'wheel', { deltaY: 10, deltaX: -60, preventDefault: () => {} });
  assert.strictEqual(bar.scrollLeft, 60, '横向手势 |deltaX|>|deltaY| 时以 deltaX 为准');
});

// ---------------------------------------------------------------- F/G. 流式路径相关性过滤（2026-10-04 站点搜索退化事故）

const junkItem = (sourceId, vodId, name) => ({
  title: name, year: '', variants: [{ sourceId, vodId, sourceName: '源' }],
});

test('F 站点搜索退化返回整站目录时，无关标题不得入面板，该源落橙点无结果', async () => {
  const h = makeSearchHarness();
  const { ds, doc } = loadStack({
    getEnabledSources: () => [{ id: 's1', name: '源A' }, { id: 's2', name: '源B' }],
    search: h.search,
  });
  ds.onPlayClick({ key: 'v1', title: '测试片' }, makeEl('div'));

  // s1 站点搜索口失效 → 返回首页目录（标题与查询零重叠）
  h.callFor('s1').d.res(okRes([
    junkItem('s1', '1', '弗兰肯斯坦'),
    junkItem('s1', '2', '操控游戏'),
    junkItem('s1', '3', '凡人修仙传'),
  ]));
  // s2 有真实命中（保证不触发整轮回退，聚焦本源行为）
  h.callFor('s2').d.res(okRes([cmsItem('s2', '9', '源B')]));
  await flush();

  assert.strictEqual(rowsOf(doc, 'cms:s1').length, 0,
    '整站目录垃圾不得渲染成行（缺过滤 = 2026-10-04 事故根因）');
  assert.match(dotClass(doc, 'cms:s1'), /sfv-picker-dot--none/,
    '过滤后无行的源应落 none（橙点），而非展示垃圾');
  assert.strictEqual(rowsOf(doc, 'cms:s2').length, 1, '兄弟源不受影响');
});

test('G 精确命中与子串噪音/垃圾混合时，只保留精确组', async () => {
  const h = makeSearchHarness();
  const { ds, doc } = loadStack({
    getEnabledSources: () => [{ id: 's1', name: '源A' }],
    search: h.search,
  });
  ds.onPlayClick({ key: 'v1', title: '测试片' }, makeEl('div'));

  h.callFor('s1').d.res(okRes([
    cmsItem('s1', '1', '源A', '测试片'),
    cmsItem('s1', '2', '源A', '测试片纪录片后台'),
    junkItem('s1', '3', '弗兰肯斯坦'),
  ]));
  await flush();

  const rows = rowsOf(doc, 'cms:s1');
  assert.strictEqual(rows.length, 1, '有精确命中时子串噪音与无关垃圾都不得入面板');
  // 行标题渲染在 .sfv-picker-row-sub（c.sub）
  const subs = rows.map((r) => r.querySelector('.sfv-picker-row-sub').textContent).join('|');
  assert.match(subs, /测试片/);
  assert.doesNotMatch(subs, /弗兰肯斯坦|纪录片后台/);
});
