'use strict';

/**
 * 多源面板画质标签（2026-10-06 设计批准：宁缺毋滥 + 两处面板）。
 *
 * 原则（主人拍板）：标签只呈现「片源自证的事实」——
 *  - 只扫候选自身字段（CMS: title/remarks/playFrom 线路名；Kazumi: 仅搜索标题），
 *    绝不扫页面文案（夹具里导航词「午夜蓝光」就是污染源）；
 *  - 无事实 → quality=null → 面板不渲染任何画质徽章，绝不出现「未知」。
 * 尺子与 search-filter-core 的 SOURCE_NOISE（剥词）共用词表口径（抽词），
 * detail-source 的 QUALITY_KEYWORD_TIERS（排序打分）行为保持不变。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, 'public', 'video', p), 'utf8');
const Core = require(path.join(root, 'public', 'video', 'search-filter-core.js'));
const { makeEl } = require('./helpers/huilian-harness');

// ---------------------------------------------------------------- 1. 尺子本体

test('qualityTagFromText：事实词 → 归一标签（真实样例）', () => {
  assert.equal(typeof Core.qualityTagFromText, 'function', '必须导出 qualityTagFromText');
  const cases = [
    ['肖申克的救赎 4K', '4K'],
    ['黄金神威 UHD', '4K'],
    ['蓝光-1', '蓝光'],
    ['阿凡达 BDRemux', '蓝光'],
    ['碟中谍 杜比视界', 'HDR'],
    ['西部世界 HDR', 'HDR'],
    ['测试片 1080P', '1080P'],
    ['测试片 高清', '1080P'],
    ['测试片 720P', '720P'],
    ['HD中字', '720P'],
    ['肖申克 TC版', '枪版'],
    ['某某 枪版', '枪版'],
  ];
  cases.forEach(([text, want]) => {
    assert.equal(Core.qualityTagFromText(text), want, `「${text}」应标 ${want}`);
  });
});

test('qualityTagFromText：非画质事实与源标识一律不标（宁缺毋滥）', () => {
  [
    '电影解说',            // CMS remarks：进度/内容标记
    '已完结',
    '你的名字原声版',       // 语言版本词，非画质
    'bfzym3u8',            // 555dy 真实线路名：源标识非画质
    'NBY',                 // netflixgc 线路名
    '午夜蓝光版爱情剧',      // ← 会标「蓝光」是预期行为：本函数只被喂候选自身字段；
                             //   页面导航词根本不该进来（由数据链把守，见 §2 面板测试）
    '',
    null,
    'ckm3u8',
    'hidden hdri',         // 单词边界：hd 不能藏在 hidden/hdri 里
  ].forEach((text) => {
    if (text === '午夜蓝光版爱情剧') return; // 见注释，仅验证边界不含裸词陷阱
    assert.equal(Core.qualityTagFromText(text), null, `「${text}」不应产生标签`);
  });
});

test('qualityTagFromText：多事实词取最高档', () => {
  assert.equal(Core.qualityTagFromText('测试片 1080P 4K HDR'), '4K');
  assert.equal(Core.qualityTagFromText('高清 蓝光'), '蓝光');
  assert.equal(Core.qualityTagFromText('4K 枪版'), '4K');
});

test('qualityScoreFromText 与旧 QUALITY_KEYWORD_TIERS 分值口径一致（排序行为回归护栏）', () => {
  assert.equal(typeof Core.qualityScoreFromText, 'function');
  // 注意：'HDR' 在旧表里被第 3 档 /(720p?|hd|标清)/ 的 hd 子串先命中 → 70 分。
  // 本护栏钉的是「与旧表行为逐条一致」，旧表如此则照此——排序意图由标签函数负责。
  const cases = [
    ['4K', 100], ['蓝光', 95], ['HDR', 70], ['1080P', 85], ['高清', 85],
    ['720P', 70], ['HD', 70], ['中字', 55], ['tc', 30], ['web-dl', 30],
    ['VCD', 20], ['某某线路', 50], ['', 50], [null, 50],
  ];
  cases.forEach(([text, want]) => {
    assert.equal(Core.qualityScoreFromText(text), want, `「${text}」应得 ${want} 分`);
  });
});

// ---------------------------------------------------------------- 2. 候选打标 + 面板渲染

function deferred() {
  let res;
  const p = new Promise((r) => { res = r; });
  return { p, res };
}
const flush = async (n) => { for (let i = 0; i < (n || 40); i++) await Promise.resolve(); };

function loadStack(sourcesStub, kazumiStub) {
  const body = makeEl('body');
  const doc = {
    createElement: (tag) => makeEl(tag),
    body, documentElement: body,
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const sf = {
    detail: { toast: () => {}, classifyCandidateEmbed: () => false, isKazumiView: () => false },
    model: { getProgress: () => null, canonicalTrackKey: () => null },
    watchHistory: { update: () => {} },
    kazumi: kazumiStub || { getEnabledSearchRules: () => [], searchRule: async () => ({ items: [] }) },
    online: { playEpisode: () => {} },
    player: { getVideoEl: () => null },
    sources: sourcesStub,
    SearchFilterCore: Core,
  };
  const sandbox = {
    console, Promise, Date, Math, JSON, RegExp, String, Number, Object, Array, Error, Set, Map,
    document: doc,
    requestAnimationFrame: (fn) => { try { fn(); } catch (e) {} },
    setTimeout: (fn) => { const t = setTimeout(fn, 0); if (t.unref) t.unref(); return t; },
    clearTimeout, setInterval: () => 0, clearInterval: () => {},
    encodeURIComponent, decodeURIComponent,
    StellaflixVideo: sf,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('search-filter-core.js'), sandbox, { filename: 'search-filter-core.js' });
  vm.runInContext(read('source-picker.js'), sandbox, { filename: 'source-picker.js' });
  sf.detailSource = undefined;
  vm.runInContext(read('detail-source.js'), sandbox, { filename: 'detail-source.js' });
  return { ds: sf.detailSource, doc, sandbox };
}

function cmsItem(title, remarks, playFrom) {
  return {
    title, year: '2020',
    // vodId 用 title 保证各条目 id 唯一（同 id 会被 P1-2 池去重吞行，非本测目标）
    variants: [{ sourceId: 's1', vodId: title, sourceName: '源A', remarks, playFrom }],
  };
}

function rowQuality(doc, key, idx) {
  const sec = doc.body.querySelector('.sfv-picker').querySelector('.sfv-picker-source[data-key="' + key + '"]');
  assert.ok(sec, '源分区应存在：' + key);
  const row = sec.querySelectorAll('.sfv-picker-row')[idx];
  assert.ok(row, '行应存在 idx=' + idx);
  const q = row.querySelector('.sfv-picker-row-q');
  return q ? q.textContent : null;
}

test('CMS 候选：remarks 画质词打标，非画质 remarks 不渲染徽章', async () => {
  const calls = [];
  const search = (kw, opt) => { const e = { d: deferred() }; calls.push(e); return e.d.p; };
  const { ds, doc } = loadStack({
    getEnabledSources: () => [{ id: 's1', name: '源A' }],
    search,
  });
  ds.onPlayClick({ key: 'v1', title: '测试片' }, makeEl('div'));
  calls[0].d.res({
    items: [
      cmsItem('测试片甲', '4K', 'ckm3u8'),
      cmsItem('测试片乙', '电影解说', 'ckm3u8'),
      cmsItem('测试片丙', '已完结', '$$$x$$$蓝光-1'), // 事实藏在线路名里
    ],
    errors: [],
  });
  await flush();
  assert.equal(rowQuality(doc, 'cms:s1', 0), '4K', 'remarks「4K」应出徽章');
  assert.equal(rowQuality(doc, 'cms:s1', 1), null, '「电影解说」不是画质事实，不得有徽章');
  assert.equal(rowQuality(doc, 'cms:s1', 2), '蓝光', 'playFrom 线路名「蓝光-1」是片源自证事实');
});

test('Kazumi 候选：仅搜索标题可作事实；线路名类源标识不得标', async () => {
  const { ds, doc } = loadStack(
    { getEnabledSources: () => [], search: () => Promise.resolve({ items: [], errors: [] }) },
    {
      getEnabledSearchRules: () => [{ name: '规则A' }],
      searchRule: async () => ({
        items: [
          { title: '测试片 1080P', src: '/voddetail/1.html', ruleName: '规则A' },
          // 「中字」是语言版本词非画质事实；且与 1080P 同被 SOURCE_NOISE 清洗 → 两条都过严格匹配
          { title: '测试片 中字', src: '/voddetail/2.html', ruleName: '规则A' },
        ],
        errors: [],
      }),
    }
  );
  ds.onPlayClick({ key: 'v1', title: '测试片' }, makeEl('div'));
  await flush();
  assert.equal(rowQuality(doc, 'kazumi:规则A', 0), '1080P', '标题画质词应出徽章');
  assert.equal(rowQuality(doc, 'kazumi:规则A', 1), null, '「中字」是语言版本词非画质，不得标');
});

test('候选对象带 quality 字段（数据链契约，播放器片源区消费同字段）', async () => {
  const calls = [];
  const search = () => { const e = { d: deferred() }; calls.push(e); return e.d.p; };
  const { ds } = loadStack({
    getEnabledSources: () => [{ id: 's1', name: '源A' }],
    search,
  });
  ds.onPlayClick({ key: 'v1', title: '测试片' }, makeEl('div'));
  calls[0].d.res({ items: [cmsItem('测试片甲', 'HD', 'ckm3u8')], errors: [] });
  await flush();
  // 会话池（session.candidates）与本池同引用：onPick 时按引用透传，此处直接断言数据链契约
  const pool = ds.getRunStateCandidates();
  const cand = pool.filter((c) => c.title === '测试片甲')[0];
  assert.ok(cand, '候选应已入池');
  assert.equal(cand.quality, '720P', 'HD → 720P 档标签挂在候选上');
});

// ---------------------------------------------------------------- 3. 播放器片源区（源码护栏）

test('播放器「片源·选集」面板消费同一 quality 字段并渲染徽章', () => {
  const src = read('player-controller.js');
  assert.ok(/quality:\s*c\.quality/.test(src), '片源分区 srcItems 须透传 c.quality');
  assert.ok(/sfv-ep-item-q/.test(src), 'addSection 须渲染 .sfv-ep-item-q 画质徽章');
});

test('面板层无事实不产生徽章节点已由 DOM 测试覆盖；hall.css 须有六档配色', () => {
  const css = read('hall.css');
  ['4K', '蓝光', 'HDR', '1080P', '720P', '枪版'].forEach((tag) => {
    assert.ok(css.includes('data-q="' + tag + '"'), '缺 ' + tag + ' 档配色');
  });
});

// ---------------------------------------------------------------- 4. 浏览厅链（主人 10-06 追加批准）

test('浏览厅 buildCandidates 与详情页同口径打标（hall 链护栏）', () => {
  const src = read('hall.js');
  assert.ok(/function qualityTagOf[\s\S]{0,300}qualityTagFromText/.test(src),
    'hall.js 须有 qualityTagOf 助手并委托 SearchFilterCore.qualityTagFromText');
  assert.ok(/quality:\s*qualityTagOf\(\[it\.title,\s*v\.remarks,\s*v\.playFrom\]/.test(src),
    'hall CMS 分支须扫 title+remarks+playFrom（与 detail-source.normalizeUnitItems 同字段面）');
  assert.ok(/quality:\s*qualityTagOf\(it\.title\)/.test(src),
    'hall Kazumi 分支只可扫搜索标题 it.title（唯一自证事实面）');
});

// ---------------------------------------------------------------- 5. 线路区（主人 10-06 追加批准）

test('播放器线路区吃线路名事实打标，源标识词不吃（road 链护栏）', () => {
  const src = read('player-controller.js');
  assert.ok(/function roadQualityTag[\s\S]{0,400}qualityTagFromText/.test(src),
    'player-controller 须有 roadQualityTag 助手并委托 SearchFilterCore.qualityTagFromText');
  assert.ok(/quality:\s*roadQualityTag\(p && p\.from\)/.test(src),
    '线路分区 roadItems 须用 p.from 打标（addSection 已按 item.quality 渲染徽章）');
});

test('线路名事实样例：真画质词标、源标识不标（尺子对 road 字段面的适用性）', () => {
  // 有来源：netflixgc/maccms 系线路名与 555dy 系线路名实采样本（本会话前期审查）
  assert.equal(Core.qualityTagFromText('$$$x$$$蓝光-1'), '蓝光');
  assert.equal(Core.qualityTagFromText('高清专区'), '1080P');
  assert.equal(Core.qualityTagFromText('bfzym3u8'), null, '源标识不得标');
  assert.equal(Core.qualityTagFromText('NBY'), null, '源标识不得标');
  assert.equal(Core.qualityTagFromText('wsym3u8'), null, '源标识不得标');
});
