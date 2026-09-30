'use strict';

/**
 * 回归测试：历史/继续播放（smartResumePlay）进入播放器后，
 * 底栏「选集 → 片源」面板必须拿到完整候选池，而非仅当前一个片源。
 *
 * 根因（2026-09-30 审查）：smartResumePlay 的 startPlay 把
 * beginPlaybackSession 的候选数组硬编码为单元素（detail-source.js:741），
 * ① tryLastSource 直用路径不做跨源搜索；② fallbackSearch 搜到多候选却只留起播那个。
 *
 * 契约：
 *  A. fallbackSearch 路径：起播成功后，会话候选池须包含本轮同名搜索的全部可切换候选，
 *     currentKey 精确命中池内起播项（唯一「播放中」高亮）。
 *  B. tryLastSource 直用路径：起播不被后台搜索阻塞；后台跨源搜索结果到达后
 *     增量补入 playbackSession.candidates，按 id 去重且不改 currentKey/view。
 *  C. 后台搜索失败：候选池保持仅当前源，不抛错、不清空会话。
 *
 * 运行：node --test tests/resume-session-candidates.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'public', 'video', 'detail-source.js');
const SFC_SRC = path.join(__dirname, '..', 'public', 'video', 'search-filter-core.js');
const srcText = fs.readFileSync(SRC, 'utf8');

function makePlays(fromList) {
  return {
    ok: true,
    plays: (fromList || ['高清线', '标清线']).map(function (from, fi) {
      return {
        from: from,
        episodes: [
          { name: '第1集', url: 'https://ep.invalid/' + fi + '/1', index: 0 },
          { name: '第2集', url: 'https://ep.invalid/' + fi + '/2', index: 1 },
        ],
      };
    }),
  };
}

function loadDetailSource(sf) {
  const sandbox = {
    console, Promise, Date, Math, JSON, RegExp, String, Number, Object, Array, Error,
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
  // 真实清洗/过滤核心入沙箱（fix③ 要求候选池口径与面板 cleanTitleForAgg 对齐）
  vm.runInContext(fs.readFileSync(SFC_SRC, 'utf8'), sandbox, { filename: SFC_SRC });
  // 幂等守卫：同进程内重复加载需先清除
  sf.detailSource = undefined;
  vm.runInContext(srcText, sandbox, { filename: SRC });
  return sf.detailSource;
}

function baseSFV(stubs) {
  const calls = { playEpisode: [], toasts: [] };
  const sf = {
    detail: {
      toast: (msg) => calls.toasts.push(String(msg)),
      classifyCandidateEmbed: () => false,
      isKazumiView: (v) => !!(v && v.isKazumi),
    },
    model: { getProgress: () => null, canonicalTrackKey: () => null },
    watchHistory: { update: () => {} },
    kazumi: Object.assign({
      getEnabledSearchRules: () => [],
      searchRule: async () => ({ items: [] }),
    }, stubs && stubs.kazumi),
    online: {
      playEpisode: function (v2, ep, play, opts) { calls.playEpisode.push({ v2, ep, play, opts }); },
    },
    player: { getVideoEl: () => null },
    sources: Object.assign({
      getSources: () => [],
      getEnabledSources: () => [],
      detail: async () => makePlays(),
      search: async () => ({ items: [] }),
    }, stubs && stubs.sources),
    __calls: calls,
  };
  return sf;
}

const flush = async (n) => { for (let i = 0; i < (n || 30); i++) await Promise.resolve(); };

// 池内候选必须携带切换所需的最小完备字段（switchPlaybackSource cms 分支读 _ref）
function assertSwitchable(c, id) {
  assert.strictEqual(c.kind, 'cms', '候选 kind 必须为 cms');
  assert.ok(c._ref && c._ref.sourceId != null, id + ' 缺少 _ref.sourceId，无法热切换');
  assert.ok(c._ref && c._ref.vodId != null, id + ' 缺少 _ref.vodId，无法热切换');
  assert.ok(c.id, id + ' 缺少唯一 id');
}

// 与 normalizeUnitItems 一致的候选唯一键（switchPlaybackSource 按 id 全等匹配）
function candIdOfRef(c) {
  return 'cms:' + (c._ref && c._ref.sourceId) + ':' + (c._ref && c._ref.vodId);
}

// ---------------------------------------------------------------- A. fallbackSearch 候选池

test('A 跨源兜底起播后，会话候选池包含全部同名候选且 currentKey 命中池内项', async () => {
  const sf = baseSFV({
    sources: {
      getEnabledSources: () => [{ id: 's1', name: '源A' }, { id: 's2', name: '源B' }],
      search: async () => ({
        items: [
          { title: '测试片', variants: [{ sourceId: 's1', vodId: '9', sourceName: '源A' }] },
          { title: '测试片', variants: [{ sourceId: 's2', vodId: '77', sourceName: '源B' }] },
        ],
      }),
      detail: async () => makePlays(),
    },
  });
  const ds = loadDetailSource(sf);
  // 无 lastSourceId → 跳过自带源直用，走跨源搜索
  ds.smartResumePlay({ key: 'k1', title: '测试片' });
  await flush();

  assert.strictEqual(sf.__calls.playEpisode.length, 1, '应已起播一次');
  const session = ds.getPlaybackSession();
  assert.ok(session, '起播后应存在播放会话');
  const ids = session.candidates.map((c) => c.id);
  assert.ok(session.candidates.length >= 2,
    '候选池须含全部同名候选（当前仅 ' + session.candidates.length + ' 个：' + ids.join(',') + '）');
  assert.ok(ids.includes('cms:s1:9') && ids.includes('cms:s2:77'), '两源候选均须在池内：' + ids.join(','));
  assert.ok(session.currentKey && ids.includes(session.currentKey),
    'currentKey 必须精确命中池内起播项，保证唯一「播放中」高亮');
  session.candidates.forEach((c) => assertSwitchable(c, c.id));
  // id 唯一，避免面板出现重复项
  assert.strictEqual(new Set(ids).size, ids.length, '候选池 id 不得重复');
});

// ---------------------------------------------------------------- B. 直用路径后台补全

test('B1 自带源直用路径：起播不被后台搜索阻塞', async () => {
  const resolvers = [];
  const sf = baseSFV({
    sources: {
      getSources: () => [{ id: 's1', name: '源A' }],
      getEnabledSources: () => [{ id: 's1', name: '源A' }, { id: 's2', name: '源B' }],
      detail: async () => makePlays(),
      search: () => new Promise((res) => { resolvers.push(res); }),
    },
  });
  const ds = loadDetailSource(sf);
  ds.smartResumePlay({ key: 'k2', title: '测试片', lastSourceId: 's1', lastVodId: '9' });
  await flush();

  assert.strictEqual(sf.__calls.playEpisode.length, 1, '搜索未返回也必须已起播（后台补全不得挡起播）');
  resolvers.forEach((r) => r({ items: [] }));
  await flush();
});

test('B2 后台跨源搜索结果到达后增量补入候选池：去重且不改 currentKey/view', async () => {
  const resolvers = [];
  let searchCalls = 0;
  const sf = baseSFV({
    sources: {
      getSources: () => [{ id: 's1', name: '源A' }],
      getEnabledSources: () => [{ id: 's1', name: '源A' }, { id: 's2', name: '源B' }],
      detail: async () => makePlays(),
      search: () => { searchCalls++; return new Promise((res) => { resolvers.push(res); }); },
    },
  });
  const ds = loadDetailSource(sf);
  ds.smartResumePlay({ key: 'k2', title: '测试片', lastSourceId: 's1', lastVodId: '9' });
  await flush();
  const session = ds.getPlaybackSession();
  assert.ok(session, '起播即应有会话（后台补全前先保当前源可标出）');
  const viewBefore = session.view;

  assert.ok(searchCalls >= 1, '直用路径应发起后台跨源搜索补全候选池');

  // 结果含当前源自身（须去重）+ 另一源（须补入）+ 无关标题（须过滤）
  resolvers.forEach((r) => r({
    items: [
      { title: '测试片', variants: [{ sourceId: 's1', vodId: '9', sourceName: '源A' }] },
      { title: '测试片', variants: [{ sourceId: 's2', vodId: '77', sourceName: '源B' }] },
      { title: '完全不同的片子', variants: [{ sourceId: 's3', vodId: '5', sourceName: '源C' }] },
    ],
  }));
  await flush();

  const ids = session.candidates.map((c) => c.id);
  assert.ok(ids.includes('cms:s2:77'), '补全后池内应含其他片源，实际：' + ids.join(','));
  // 去重：同 (sourceId, vodId) 只允许一条，且其 id 必须与面板 candKey 口径一致
  const currentOnAir = session.candidates.filter((c) => candIdOfRef(c) === 'cms:s1:9');
  assert.strictEqual(currentOnAir.length, 1, '当前起播源在池内必须恰好一条（sourceId+vodId 去重）');
  assert.strictEqual(session.currentKey, currentOnAir[0].id,
    'currentKey 必须等于在播源池内条目的 id（' + currentOnAir[0].id + '），否则面板高亮错位');
  assert.ok(!ids.includes('cms:s3:5'), '无关标题不得混入池内');
  assert.strictEqual(session.view, viewBefore, '增量补全不得替换会话 view');
  session.candidates.forEach((c) => assertSwitchable(c, c.id));
});

// ---------------------------------------------------------------- C. 后台搜索失败

test('C 后台搜索失败：会话保持仅当前源，不抛错不清空', async () => {
  const sf = baseSFV({
    sources: {
      getSources: () => [{ id: 's1', name: '源A' }],
      getEnabledSources: () => [{ id: 's1', name: '源A' }, { id: 's2', name: '源B' }],
      detail: async () => makePlays(),
      search: async () => { throw new Error('network down'); },
    },
  });
  const ds = loadDetailSource(sf);
  ds.smartResumePlay({ key: 'k3', title: '测试片', lastSourceId: 's1', lastVodId: '9' });
  await flush();

  const session = ds.getPlaybackSession();
  assert.ok(session, '搜索失败不得清空播放会话');
  assert.ok(session.candidates.length >= 1, '池内至少保留当前源');
  assert.ok(session.currentKey && session.candidates.map((c) => c.id).includes(session.currentKey));
});

// ---------------------------------------------------------------- D. fix③ 清洗口径

test('D 候选池标题过滤须走 cleanTitleForAgg 清洗：变体入池、子串噪声排除', async () => {
  const sf = baseSFV({
    sources: {
      getSources: () => [{ id: 's1', name: '量子' }],
      getEnabledSources: () => [{ id: 's1', name: '量子' }, { id: 's2', name: '光速' }],
      detail: async () => makePlays(),
      search: async () => ({
        items: [
          { title: '你的名字', variants: [{ sourceId: 's2', vodId: '77', sourceName: '光速' }] },
          { title: '你的名字 (2016)', variants: [{ sourceId: 's4', vodId: '88', sourceName: '电影天堂' }] },
          { title: '你的名字。', variants: [{ sourceId: 's5', vodId: '99', sourceName: '魔都资源' }] },
          { title: '请以你的名字呼唤我', variants: [{ sourceId: 's6', vodId: '10', sourceName: '噪声源' }] },
          { title: '你的名字是玫瑰', variants: [{ sourceId: 's7', vodId: '11', sourceName: '噪声源2' }] },
        ],
      }),
    },
  });
  const ds = loadDetailSource(sf);
  // 历史记录标题带句号「你的名字。」——旧原始前缀口径会把「你的名字 (2016)」等变体踢出池
  ds.smartResumePlay({ key: 'k4', title: '你的名字。', lastSourceId: 's1', lastVodId: '9' });
  await flush();

  const session = ds.getPlaybackSession();
  const ids = session.candidates.map((c) => c.id);
  assert.ok(ids.includes('cms:s2:77'), '「你的名字」变体（无句号）须入池：' + ids.join(','));
  assert.ok(ids.includes('cms:s4:88'), '「你的名字 (2016)」（清洗去括号后全等）须入池：' + ids.join(','));
  assert.ok(ids.includes('cms:s5:99'), '「你的名字。」（全等）须入池：' + ids.join(','));
  assert.ok(!ids.includes('cms:s6:10'), '「请以你的名字呼唤我」非前缀命中，不得入池');
  // 「你的名字是玫瑰」清洗后前缀命中可入池（与详情页池同宽口径），
  // 但最终展示由面板严格匹配分支闸掉——断言移到 candidatesForPanel 层
  const panelIds = ds.candidatesForPanel(session.view).map((c) => c.id);
  assert.ok(panelIds.includes('cms:s2:77'), '面板须列出全等变体源');
  assert.ok(!panelIds.includes('cms:s7:11'), '面板严格匹配分支须排除「你的名字是玫瑰」');
  assert.ok(!panelIds.includes('cms:s6:10'), '面板不得出现「请以你的名字呼唤我」');
});

// ---------------------------------------------------------------- E. fix② Kazumi 入池

test('E 后台补池须覆盖 Kazumi 规则源（与详情页弹窗同源单元集）', async () => {
  let kzCalls = 0;
  const sf = baseSFV({
    sources: {
      getSources: () => [{ id: 's1', name: '量子' }],
      getEnabledSources: () => [{ id: 's1', name: '量子' }],
      detail: async () => makePlays(),
      search: async () => ({ items: [] }),
    },
    kazumi: {
      getEnabledSearchRules: () => [{ name: 'AGE' }, { name: 'aafun' }],
      searchRule: async (ruleName) => {
        kzCalls++;
        return {
          items: [
            { ruleName: ruleName, src: 'https://' + ruleName + '/v/1', title: '你的名字。', pic: '' },
            { ruleName: ruleName, src: 'https://' + ruleName + '/v/2', title: '请以你的名字呼唤我', pic: '' },
          ],
        };
      },
    },
  });
  const ds = loadDetailSource(sf);
  ds.smartResumePlay({ key: 'k5', title: '你的名字。', lastSourceId: 's1', lastVodId: '9' });
  await flush();

  assert.ok(kzCalls >= 2, '每条启用 Kazumi 规则都应被后台补池搜索（实际 ' + kzCalls + ' 次）');
  const session = ds.getPlaybackSession();
  const ids = session.candidates.map((c) => c.id);
  assert.ok(ids.includes('kz:AGE:https://AGE/v/1'), 'Kazumi 命中须以 kz:<rule>:<src> 入池：' + ids.join(','));
  assert.ok(ids.includes('kz:aafun:https://aafun/v/1'), '第二条规则命中亦须入池：' + ids.join(','));
  assert.ok(!ids.some((x) => x.indexOf('/v/2') >= 0), 'Kazumi 侧子串噪声不得入池');
  const kz = session.candidates.filter((c) => c.kind === 'kazumi')[0];
  assert.ok(kz && kz._ref && kz._ref.ruleName && kz._ref.src, 'kazumi 候选须带 _ref.ruleName/src 供热切换');
});

// ---------------------------------------------------------------- F. fix② 兜底路径不重复搜 CMS

test('F 跨源兜底起播：后台补池只搜 Kazumi 规则，不得重复发起 CMS 聚合搜索', async () => {
  let cmsSearchCalls = 0;
  let kzCalls = 0;
  const sf = baseSFV({
    sources: {
      getEnabledSources: () => [{ id: 's1', name: '量子' }, { id: 's2', name: '光速' }],
      detail: async () => makePlays(),
      search: async () => {
        cmsSearchCalls++;
        return {
          items: [
            { title: '测试片', variants: [{ sourceId: 's1', vodId: '9', sourceName: '量子' }] },
            { title: '测试片', variants: [{ sourceId: 's2', vodId: '77', sourceName: '光速' }] },
          ],
        };
      },
    },
    kazumi: {
      getEnabledSearchRules: () => [{ name: 'AGE' }],
      searchRule: async () => { kzCalls++; return { items: [{ ruleName: 'AGE', src: 'https://age/v/1', title: '测试片' }] }; },
    },
  });
  const ds = loadDetailSource(sf);
  ds.smartResumePlay({ key: 'k6', title: '测试片' }); // 无 lastSourceId → 兜底搜索路径
  await flush();

  assert.strictEqual(cmsSearchCalls, 1, 'CMS 聚合搜索全程只允许 1 次（补池不得重复搜 CMS）');
  assert.ok(kzCalls >= 1, '兜底路径的后台补池仍须搜 Kazumi 规则');
  const session = ds.getPlaybackSession();
  const ids = session.candidates.map((c) => c.id);
  assert.ok(ids.includes('cms:s1:9') && ids.includes('cms:s2:77'), '兜底即时池须含两 CMS 源：' + ids.join(','));
  assert.ok(ids.includes('kz:AGE:https://age/v/1'), 'Kazumi 候选补入同一池：' + ids.join(','));
});
