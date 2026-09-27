'use strict';

/**
 * 动画专区（2026-09-26 用户指令③：「上网以真实权威的数据补全新海诚、宫崎骏的动画，
 * 以及 2002 到 2026 年的高分动画榜（拆分为独立片单，每个片单选 15 部）」）
 *
 * 数据来源与核实方式（有来源）：
 *   - 宫崎骏/新海诚：TMDB 影人页（person 608 / 74091）回链的每条 /movie/<id> 逐个抓 og:title，
 *     得到「ID → 站内实际标题」全量对照表（本机 /api/proxy 直连，共 123 + 26 条），
 *     再按两人「导演」身份挑出长片 + 动画短片。不用 discover with_people 的原因：
 *     该端点会把制片/编剧/客串条目一并混入（如 借东西的小人阿莉埃蒂=米林宏昌导演、宫崎骏编剧）。
 *   - 年度高分动画榜：不逐片人工编目（375 条 ID 编目必出错，209 坏 ID 教训），
 *     改由 TMDB discover 实时排序（with_genres=16 + primary_release_year + vote_average.desc
 *     + vote_count 门槛）取前 15 部 —— 权威排序来自站内数据，不由 AI 记忆决定。
 *   - 2002~2026 含首尾 = 25 个年度卡（用户原话「24 年」为含端点差一，按实逐年建卡）。
 * 契约：
 *   ① person-miyazaki / person-shinkai = static-list / tab series / tmdbIds 锁死在 og:title 核实白名单
 *   ② 年度动画卡 25 张：id anim-top-<年> / type tmdb-discover / limit 15 / with_genres 16
 *   ③ 旧的聚合卡 list-animation-2002-2026 已删（由 25 张年度卡取代）
 *   ④ def.limit 生效：getItems 走单页 discover 后截断，不再 discoverAll 拉全量
 * 运行：node --test tests/home-collections-animation-zones.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const indexHtml = read('public/index.html');
const collectionsSrc = read('public/video/collections.js');

// ---- 宫崎骏（person 608）：12 长片 + 10 短片，全部经站内 og:title 回读 ----
const MIYAZAKI_VERIFIED = {
  15371: '鲁邦三世：卡里奥斯特罗城', 81: '风之谷', 10515: '天空之城', 8392: '龙猫',
  16859: '魔女宅急便', 11621: '红猪', 128: '幽灵公主', 129: '千与千寻',
  4935: '哈尔的移动城堡', 12429: '崖上的波妞', 149870: '起风了', 508883: '你想活出怎样的人生',
  188541: '巨神兵在东京出现', 158483: '梅与小猫巴士', 222462: '捕鲸记', 222475: '克洛的大冒险',
  222480: '空中浮遊機械', 222661: '种下星星的日子', 222664: '水蜘蛛萌萌', 214676: '酵母君与鸡蛋公主',
  508884: '毛毛虫波罗', 1658826: 'ON YOUR MARK 吉卜力实验剧场',
};
// ---- 新海诚（person 74091）：8 长片 + 7 短片 ----
const SHINKAI_VERIFIED = {
  37910: '星之声', 12924: '云之彼端，约定的地方', 38142: '秒速五厘米', 79707: '追逐繁星的孩子',
  198375: '言叶之庭', 372058: '你的名字。', 568160: '天气之子', 916224: '铃芽之旅',
  73799: '遥远世界', 449420: '被包围的世界', 18143: '她和她的猫', 277095: '十字路口',
  222715: '某人的目光', 1111342: '猫的集会', 1492940: '笑颜',
};
// 明确不收：他人导演、宫崎骏仅编剧/制片的吉卜力片（站内人页有回链但非其导演作）
const NOT_MIYAZAKI_DIRECTED = [83389, 51739, 15370, 37797, 37933, 15283, 15080, 430447];
const YEARS = [];
for (let y = 2002; y <= 2026; y++) YEARS.push(y);

function makeItems(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: i + 1, mediaType: 'movie', title: prefix + (i + 1), year: 2020,
      poster: 'https://img.example/' + prefix + (i + 1) + '.jpg',
      rating: 7, overview: '', backdrop: '', genreIds: [16], originalLanguage: 'ja',
    });
  }
  return out;
}

function buildEnv() {
  const dom = new JSDOM(indexHtml, { url: 'http://localhost:3000/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  const calls = { discover: [], discoverAll: [], getDetails: [] };
  win.StellaflixVideo = {
    tmdb: {
      hasKey: () => true,
      discover: (q) => { calls.discover.push(q || {}); return Promise.resolve(makeItems(20, 'D1')); },
      discoverAll: (q) => { calls.discoverAll.push(q || {}); return Promise.resolve(makeItems(80, 'DA')); },
      getCollection: () => Promise.resolve({ parts: makeItems(8, 'C') }),
      getListAll: () => Promise.resolve({ items: makeItems(20, 'L') }),
      getDetails: (id) => {
        calls.getDetails.push(id);
        return Promise.resolve({ id, title: 'M' + id, year: 1997, poster: '', rating: 8, overview: '', backdrop: '' });
      },
      genreNames: () => '', regionLabel: () => '',
      getPosterColor: () => Promise.reject(new Error('COLOR_OFFLINE')),
    },
    online: { openDetailFromMeta() {} },
  };
  win.eval(collectionsSrc);
  return { win, SFV: win.StellaflixVideo, calls };
}

// ============================================================ ① 影人静态编目

test('宫崎骏动画全集 = 22 部长片+短片静态编目，ID 全在 og:title 核实白名单内', () => {
  const { SFV } = buildEnv();
  const d = SFV.collections.getByTab('series').find((x) => x.id === 'person-miyazaki');
  assert.ok(d, 'person-miyazaki 须在 series tab');
  assert.equal(d.type, 'static-list', 'discover with_people 会混入非其导演条目 → 改静态编目');
  const ids = (d.tmdbIds || []).map(Number);
  const allow = Object.keys(MIYAZAKI_VERIFIED).map(Number);
  assert.equal(ids.length, allow.length, '须恰为 22 条（12 长片 + 10 短片）');
  assert.equal(new Set(ids).size, ids.length, '不得重复');
  ids.forEach((id) => assert.ok(allow.includes(id), '未核实宫崎骏片 ID: ' + id + '（' + MIYAZAKI_VERIFIED[id] + '）'));
  NOT_MIYAZAKI_DIRECTED.forEach((id) => assert.equal(ids.includes(id), false, id + ' 非宫崎骏导演，不得收入'));
  // 代表作必须在册
  [81, 10515, 8392, 16859, 11621, 128, 129, 4935, 12429, 149870, 508883, 15371].forEach((id) => {
    assert.ok(ids.includes(id), '缺代表作 ' + id + '（' + MIYAZAKI_VERIFIED[id] + '）');
  });
  assert.match(d.sub || '', /吉卜力|宫崎骏/, '副标题须中文描述');
  assert.ok(/^#[0-9a-fA-F]{6}$/.test(d.warm || ''), '须有合法兜底色');
});

test('新海诚动画专区 = 15 部（8 长片 + 7 短片）静态编目，ID 全在核实白名单内', () => {
  const { SFV } = buildEnv();
  const d = SFV.collections.getByTab('series').find((x) => x.id === 'person-shinkai');
  assert.ok(d, 'person-shinkai 须在 series tab');
  assert.equal(d.type, 'static-list');
  const ids = (d.tmdbIds || []).map(Number);
  const allow = Object.keys(SHINKAI_VERIFIED).map(Number);
  assert.equal(ids.length, allow.length, '须恰为 15 条');
  assert.equal(new Set(ids).size, ids.length, '不得重复');
  ids.forEach((id) => assert.ok(allow.includes(id), '未核实新海诚片 ID: ' + id));
  [37910, 12924, 38142, 79707, 198375, 372058, 568160, 916224].forEach((id) => {
    assert.ok(ids.includes(id), '缺长片 ' + id + '（' + SHINKAI_VERIFIED[id] + '）');
  });
  assert.equal(ids.includes(553301), false, '553301 你的名字：特摄（纪录片）不得收入');
  assert.equal(ids.includes(1559487), false, '1559487 未定档新片（无内容）不得收入');
});

test('影人静态卡取数：按 tmdbIds 逐条解析且条数=编目数', async () => {
  const { SFV } = buildEnv();
  const miya = SFV.collections.getByTab('series').find((x) => x.id === 'person-miyazaki');
  const shinkai = SFV.collections.getByTab('series').find((x) => x.id === 'person-shinkai');
  assert.equal((await SFV.collections.getItems(miya)).length, 22);
  assert.equal((await SFV.collections.getItems(shinkai)).length, 15);
});

// ============================================================ ② 年度高分动画榜 25 张

test('2002-2026 逐年高分动画卡 = 25 张，全部 limit 15 + with_genres 16 + 评分排序', () => {
  const { SFV } = buildEnv();
  const lists = SFV.collections.getByTab('lists');
  const yearCards = lists.filter((d) => /^anim-top-\d{4}$/.test(d.id));
  assert.equal(yearCards.length, YEARS.length, '2002~2026 含端点 = 25 张年度卡');
  const years = yearCards.map((d) => Number(d.id.slice(-4)));
  YEARS.forEach((y) => assert.ok(years.includes(y), '缺 ' + y + ' 年度卡'));
  assert.equal(new Set(years).size, years.length, '年度不得重复');
  yearCards.forEach((d) => {
    assert.equal(d.type, 'tmdb-discover', d.id + ' 年度榜由 TMDB 实时排序，非人工编目');
    assert.equal(Number(d.limit), 15, d.id + ' 每年取 15 部');
    const q = d.query || {};
    assert.equal(String(q.with_genres), '16', d.id + ' 须锁动画类型');
    assert.equal(String(q.primary_release_year), String(d.id.slice(-4)), d.id + ' 年份须与卡 ID 一致');
    assert.equal(q.sort_by, 'vote_average.desc', d.id + ' 须按评分降序');
    assert.ok(Number(q['vote_count.gte']) > 0, d.id + ' 须有投票数门槛，避免 10 人 9.8 分占位');
    assert.match(d.title, /20\d\d/, d.id + ' 标题须含年份');
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(d.warm || ''), d.id + ' 须有兜底色');
  });
});

test('旧聚合卡 list-animation-2002-2026 已由年度卡取代（不留重复入口）', () => {
  const { SFV } = buildEnv();
  const all = ['featured', 'series', 'lists', 'genres'].flatMap((t) => SFV.collections.getByTab(t));
  assert.equal(all.some((d) => d.id === 'list-animation-2002-2026'), false, '聚合卡须删除');
});

// ============================================================ ③ limit 取数机制

test('def.limit 生效：走单页 discover 并截断，不调 discoverAll', async () => {
  const { SFV, calls } = buildEnv();
  const def = { id: 'anim-top-2004', type: 'tmdb-discover', limit: 15, query: { with_genres: '16' } };
  const items = await SFV.collections.getItems(def);
  assert.equal(calls.discover.length, 1, '带 limit 的卡走单页 discover（省 4 个分页请求）');
  assert.equal(calls.discoverAll.length, 0, 'limit 卡不得拉全量');
  assert.equal(items.length, 15, '20 条首页须截为 15');
});

test('def.limit 大于返回条数时不填充、不报错', async () => {
  const { SFV, calls } = buildEnv();
  SFV.tmdb.discover = () => Promise.resolve(makeItems(6, 'S'));
  const items = await SFV.collections.getItems({ id: 'thin', type: 'tmdb-discover', limit: 15, query: {} });
  assert.equal(items.length, 6, '上游只给 6 部则如实 6 部');
  assert.equal(calls.discoverAll.length, 0);
});

test('无 limit 的 discover 卡仍拉全量（2026-09-26 指令①不限条数不回归）', async () => {
  const { SFV, calls } = buildEnv();
  // 09-27 起榜单/类型两 tab 的目录卡全部带 limit（≤100 部指令），机制契约改用合成卡
  const def = { id: 'synthetic-unbounded', type: 'tmdb-discover', tab: 'lists', query: { with_genres: '35' } };
  assert.equal(def.limit, undefined, '合成卡不带 limit');
  await SFV.collections.getItems(def);
  assert.equal(calls.discoverAll.length, 1);
});

// ============================================================ ④ 榜单 tab 规模守门

test('年度动画卡并入后 lists tab 仍可渲染（25 年度卡 + 其余常规卡）', () => {
  const { SFV } = buildEnv();
  const lists = SFV.collections.getByTab('lists');
  assert.equal(lists.length, 49, '09-27 大榜拆段后：常规 24 卡 + 25 年度动画卡（精确卡数契约见 catalog-official / ranking-subdivide）');
  assert.equal(lists.filter((d) => d.type === 'placeholder').length, 0, '不得有占位卡');
});
