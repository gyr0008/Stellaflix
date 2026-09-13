/**
 * verify-bangumi-timeline.js
 * 验证 Kazumi 2.2.6 Timeline 移植（Stellaflix）的核心不变量。
 *
 * 策略：
 *  - 数据层（bangumi-season / bangumi）用 jsdom 窗口直接 eval 真实模块，调用真实导出函数。
 *  - 时间表排序 / 过滤用「挂载真实页面 → 读取真实 DOM 卡片顺序」做端到端校验，
 *    而非复制排序逻辑（避免“测的是副本而非真代码”）。
 *
 * 运行：node tests/verify-bangumi-timeline.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const JSDOM = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/jsdom').JSDOM;

const ROOT = path.resolve(__dirname, '..');
const VIDEO = path.join(ROOT, 'public', 'video');

// ---- 断言收集器 ----
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name + '  (got ' + g + ')', g === w, 'expected ' + w);
}

// ---- 构造 jsdom 窗口并装配 SFV 桩 ----
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only'
});
const win = dom.window;

const TRACK = { abandoned: [], watched: [], watching: [] };

win.StellaflixVideo = win.StellaflixVideo || {};
const SFV = win.StellaflixVideo;
SFV.router = {
  register: (o) => { win.__reg = o; },
  go() {}, current() {}, currentId() { return null; }, setHost() {}
};
SFV.model = {
  getKeysByTrack: (t) => TRACK[t] || [],
  getTrackStatus: () => null,
  STATE_ICONS: {}, TRACK_LABELS: {}, TRACK_STATUSES: ['wish', 'watching', 'watched', 'abandoned']
};
SFV.onlineShared = { openPage() {}, goToNav() {} };
SFV.bangumiInfo = { open() {} };
SFV.collections = { listUserFolders: () => [], addUserItem() {}, createUserFolder() { return null; } };
win.toast = () => {};
if (!win.localStorage) {
  const store = {};
  win.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
}

// ---- 在窗口上下文 eval 真实模块（顺序：season → bangumi → timeline）----
function evalFile(rel) {
  const code = fs.readFileSync(path.join(VIDEO, rel), 'utf8');
  win.eval(code);
}
evalFile('bangumi-season.js');
evalFile('bangumi.js');
evalFile('bangumi-timeline.js');

console.log('== 模块加载 ==');
ok('SFV.bangumiSeason 已注册', !!SFV.bangumiSeason);
ok('SFV.bangumi 已注册', !!SFV.bangumi);
ok('SFV.bangumiTimeline 已注册', !!SFV.bangumiTimeline);
ok('router 注册时间表页(id=bangumi-timeline,title=时间表)',
  win.__reg && win.__reg.id === 'bangumi-timeline' && win.__reg.title === '时间表');

const S = SFV.bangumiSeason;
const B = SFV.bangumi;

// ============================================================
console.log('\n== A. 季度窗口边界（对齐 Kazumi：整体提前一个月）==');
eq('2026 冬 (Jan) -> ["2025-12-01","2026-03-01"]', S.toSeasonStartAndEnd(new Date(2026, 0, 15)), ['2025-12-01', '2026-03-01']);
eq('2026 春 (Apr) -> ["2026-03-01","2026-06-01"]', S.toSeasonStartAndEnd(new Date(2026, 3, 15)), ['2026-03-01', '2026-06-01']);
eq('2026 夏 (Jul) -> ["2026-06-01","2026-09-01"]', S.toSeasonStartAndEnd(new Date(2026, 6, 15)), ['2026-06-01', '2026-09-01']);
eq('2026 秋 (Oct) -> ["2026-09-01","2026-12-01"]', S.toSeasonStartAndEnd(new Date(2026, 9, 15)), ['2026-09-01', '2026-12-01']);
ok('isSameSeason 同季(1月 vs 3月,差2) -> true', S.isSameSeason(new Date(2026, 0, 15), new Date(2026, 2, 15)) === true);
ok('isSameSeason 跨季(1月 vs 4月,差3) -> false', S.isSameSeason(new Date(2026, 0, 15), new Date(2026, 3, 15)) === false);

const past = S.listPastSeasons(20);
ok('listPastSeasons(20) 返回 20 年', past.length === 20);
ok('listPastSeasons 每个年份的可用季均在过去', past.every(g => g.dates.every(d => d.getTime() < Date.now())));

// ============================================================
console.log('\n== B. 日期→星期 映射 ==');
eq("dateStringToWeekday('2023-01-01') -> 0 (周日)", B.dateStringToWeekday('2023-01-01'), 0);
eq("dateStringToWeekday('2024-01-01') -> 1 (周一)", B.dateStringToWeekday('2024-01-01'), 1);
eq("dateStringToWeekday('2026-01-01') -> 4 (周四)", B.dateStringToWeekday('2026-01-01'), 4);
eq("dateStringToWeekday('2026-12-25') -> 5 (周五)", B.dateStringToWeekday('2026-12-25'), 5);
// JS(0..6) -> Dart(1..7)
eq('jsDayToDartWeekday(0) -> 7', B.jsDayToDartWeekday(0), 7);
eq('jsDayToDartWeekday(3) -> 3', B.jsDayToDartWeekday(3), 3);
// Dart(1..7) -> index(0..6, 周一=0)
eq('weekdayToIndex(1) -> 0', B.weekdayToIndex(1), 0);
eq('weekdayToIndex(7) -> 6', B.weekdayToIndex(7), 6);

// ============================================================
console.log('\n== C. normSubject 双形态 (v0 / next) ==');
const v0 = {
  id: 1, name: 'A', name_cn: '阿', summary: 'sum', date: '2026-04-01',
  rating: { rank: 5, score: 8.0, total: 100, count: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10 } },
  images: { common: 'http://lain.bgm.tv/pic/xyz.jpg' },
  tags: [{ name: '热血', count: 3 }],
  infobox: [{ key: '别名', value: 'AliasA' }], info: '', url: ''
};
const n0 = B.normSubject(v0);
ok('v0: airDate 取顶层 date', n0.airDate === '2026-04-01', n0.airDate);
ok('v0: airWeekdayDart = 周三(3)', n0.airWeekdayDart === 3, String(n0.airWeekdayDart));
ok('v0: rank=5', n0.rank === 5);
ok('v0: ratingScore=8.0', n0.ratingScore === 8.0);
ok('v0: votes=100', n0.votes === 100);
ok('v0: votesCount 长度为10且为 [1..10]', JSON.stringify(n0.votesCount) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
ok('v0: tags 归一化', n0.tags[0] && n0.tags[0].name === '热血' && n0.tags[0].count === 3);
ok("v0: 别名取 value -> ['AliasA']", JSON.stringify(n0.alias) === JSON.stringify(['AliasA']));
ok('v0: 海报经 wsrv.nl 重写', /wsrv\.nl/.test(n0.poster), n0.poster);

const next = {
  id: 2, name: 'B', name_cn: '比', summary: 's2', airtime: { date: '2026-07-15' },
  rating: { score: '9.1', total: 200, count: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
  images: { large: 'https://api.bgm.tv/v0/subjects/2/image' },
  tags: [{ name: '搞笑', count: 5 }],
  infobox: [{ key: '别名', values: [{ v: 'AliasB1' }, { v: 'AliasB2' }] }]
};
const n1 = B.normSubject(next);
ok('next: airDate 取 airtime.date', n1.airDate === '2026-07-15', n1.airDate);
ok('next: airWeekdayDart = 周三(3)', n1.airWeekdayDart === 3, String(n1.airWeekdayDart));
ok('next: ratingScore 数字 9.1', n1.ratingScore === 9.1);
ok('next: votes=200', n1.votes === 200);
ok('next: votesCount 为 List [0..9]', JSON.stringify(n1.votesCount) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
ok("next: 别名取 values -> ['AliasB1','AliasB2']", JSON.stringify(n1.alias) === JSON.stringify(['AliasB1', 'AliasB2']));
ok('next: api 图片经 wsrv.nl 重写', /wsrv\.nl/.test(n1.poster), n1.poster);
ok('normSubject(null) -> null', B.normSubject(null) === null);

// ============================================================
console.log('\n== D. parseCalendarJSON 7 桶 + subject 解包 ==');
const calJson = {
  '1': [{ subject: { id: 11, name: 'M1', date: '2026-01-05' } }],
  '2': [{ subject: { id: 12, name: 'T1' } }],
  '3': [], '4': [], '5': [], '6': [],
  '7': [{ subject: { id: 17, name: 'S7' } }, { id: 18, name: 'NoSub' }]
};
const cal = B.parseCalendarJSON(calJson);
ok('返回 7 天数组', cal.length === 7);
ok('桶1(周一)含 1 项 id=11', cal[0].length === 1 && cal[0][0].id === 11);
ok('桶2(周二)含 1 项 id=12', cal[1].length === 1 && cal[1][0].id === 12);
ok('桶7(周日)含 2 项 [17,18]', cal[6].length === 2 && cal[6][0].id === 17 && cal[6][1].id === 18);

// ============================================================
console.log('\n== E. 时间表排序（挂载真实页面，读真实 DOM 卡片序）==');
const items = [
  { id: 30, name: 'C', name_cn: '丙', title: '丙', summary: 's', airDate: '2026-04-01', rank: 3, ratingScore: 7.0, votes: 300, poster: '', tags: [], alias: [], info: '' },
  { id: 10, name: 'A', name_cn: '甲', title: '甲', summary: 's', airDate: '2026-04-02', rank: 1, ratingScore: 9.5, votes: 100, poster: '', tags: [], alias: [], info: '' },
  { id: 20, name: 'B', name_cn: '乙', title: '乙', summary: 's', airDate: '2026-04-03', rank: 2, ratingScore: 5.0, votes: 200, poster: '', tags: [], alias: [], info: '' }
];
const data = [[], [], [], [], [], [], []];
const DAY = 3; // 周四桶
data[DAY] = items;
const st = SFV.bangumiTimeline._state;
st.data = data;
st.activeDay = DAY;
st.seasonString = '测试季';

const host = win.document.createElement('div');
win.document.body.appendChild(host);
SFV.bangumiTimeline.mount(host);

function cardOrder() {
  return Array.prototype.map.call(host.querySelectorAll('.sfv-bgm-tl-grid .sfv-bgm-tl-card'),
    (c) => parseInt(c.getAttribute('data-bgm-id'), 10));
}
ok('挂载后渲染出 3 张卡片', host.querySelectorAll('.sfv-bgm-tl-card').length === 3);
ok('7 个星期 Tab 渲染', host.querySelectorAll('.sfv-bgm-tl-tab').length === 7);

st.sortMode = 3; SFV.bangumiTimeline.refresh();
eq('排序3=热度(votes降序) -> [30,20,10]', cardOrder(), [30, 20, 10]);

st.sortMode = 2; SFV.bangumiTimeline.refresh();
eq('排序2=评分(ratingScore降序) -> [10,30,20]', cardOrder(), [10, 30, 20]);

st.sortMode = 1; SFV.bangumiTimeline.refresh();
eq('排序1=时间(id升序) -> [10,20,30]', cardOrder(), [10, 20, 30]);

// ============================================================
console.log('\n== F. 时间表过滤组合 ==');
st.sortMode = 1; // 固定 id 升序便于判定
function applyFilter(filters, track) {
  st.filters = { hideAbandoned: false, hideWatched: false, onlyWatching: false };
  Object.assign(st.filters, filters);
  TRACK.abandoned = track.abandoned || [];
  TRACK.watched = track.watched || [];
  TRACK.watching = track.watching || [];
  SFV.bangumiTimeline.refresh();
  return cardOrder();
}
eq('隐藏已抛弃(bangumi:10) -> [20,30]',
  applyFilter({ hideAbandoned: true }, { abandoned: ['bangumi:10'] }), [20, 30]);
eq('隐藏已看过(bangumi:20) -> [10,30]',
  applyFilter({ hideWatched: true }, { watched: ['bangumi:20'] }), [10, 30]);
eq('只看在看(bangumi:30) -> [30]',
  applyFilter({ onlyWatching: true }, { watching: ['bangumi:30'] }), [30]);
eq('无过滤 -> [10,20,30]',
  applyFilter({}, {}), [10, 20, 30]);

// ============================================================
console.log('\n== G. 首页入口行为：openCalendar() 必须优先打开弹窗面板 ==');
const popupCalls = [], pageCalls = [];
const realOpenPopup = SFV.bangumiTimeline.openPopup;
const realOpenPage = SFV.bangumiTimeline.openPage;
SFV.bangumiTimeline.openPopup = function () { popupCalls.push('popup'); };
SFV.bangumiTimeline.openPage = function () { pageCalls.push('page'); };
evalFile('online-collections.js');
SFV.onlineShared.openCalendar();
SFV.bangumiTimeline.openPopup = realOpenPopup;
SFV.bangumiTimeline.openPage = realOpenPage;
ok('openCalendar() 优先调用 openPopup()（popup=1,page=0）',
  popupCalls.length === 1 && pageCalls.length === 0,
  'popup=' + popupCalls.join(',') + ' page=' + pageCalls.join(','));

// ============================================================
console.log('\n==================================================');
console.log('结果: ' + pass + ' passed, ' + fail + ' failed (共 ' + (pass + fail) + ' 项)');
if (fail) {
  console.log('失败项:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
} else {
  console.log('全部通过 ✅');
  process.exit(0);
}
