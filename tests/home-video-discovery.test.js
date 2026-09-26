'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '..', 'public', 'js', 'home-video-discovery.js');

function loadModule() {
  const code = fs.readFileSync(MODULE_PATH, 'utf8');
  const context = { console, Date, Math, JSON, String, Number, Array, Object, Boolean, Promise, setTimeout, encodeURIComponent };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.StellaflixHomeVideoDiscovery;
}

// 2026-09-24 是周四；本地正午构造，避免时区影响"当天"判定
function localTime(y, m, d, hh) {
  return new Date(y, m - 1, d, hh || 12, 0, 0).getTime();
}

function tmdbItem(id, title, extra) {
  return Object.assign({
    id: id, mediaType: 'movie', title: title, originalTitle: title,
    year: '2026', poster: 'https://image.tmdb.org/p' + id + '.jpg',
    rating: 7, voteCount: 1000, popularity: 500, adult: false, genreIds: [],
  }, extra || {});
}

function bgmItem(id, title, extra) {
  return Object.assign({ id: id, title: title, name: title, poster: 'https://bgm.tv/img/' + id + '.jpg', airDate: '2026-09-24' }, extra || {});
}

// calendar 索引 0=周一..6=周日
function calendarWith(dayIdx, items) {
  var cal = [[], [], [], [], [], [], []];
  cal[dayIdx] = items;
  return cal;
}

test('三源齐备时按 最热/高分/新番 顺序产出三张卡', () => {
  const api = loadModule();
  const cards = api.pickVideoDiscoveryCards({
    trending: [tmdbItem(1, '热榜甲')],
    highscore: [tmdbItem(2, '高分乙', { rating: 8.9 })],
    calendar: calendarWith(3, [bgmItem(3, '番剧丙')]), // 周四
    now: localTime(2026, 9, 24),
  });
  assert.equal(cards.length, 3);
  // vm realm 数组与宿主 Array 原型不同，deepEqual 会误报；用 join 比较内容
  assert.equal(cards.map(c => c.slot).join(','), 'hot,high,bangumi');
  assert.equal(cards[0].title, '热榜甲');
  assert.match(cards[0].reason, /最热|趋势/);
  assert.match(cards[1].reason, /★ 8\.9/);
  assert.match(cards[2].reason, /周[一二三四五六日]放送/);
});

test('TMDB 卡 meta 满足 openDetailFromMeta 消费契约（id/mediaType/title/poster 非空）', () => {
  const api = loadModule();
  const cards = api.pickVideoDiscoveryCards({
    trending: [tmdbItem(11, '契约片')],
    highscore: [],
    calendar: [],
    now: localTime(2026, 9, 24),
  });
  assert.equal(cards.length, 1);
  const meta = cards[0].meta;
  assert.equal(meta.id, 11);
  assert.equal(meta.mediaType, 'movie');
  assert.equal(meta.title, '契约片');
  assert.equal(typeof meta.poster, 'string');
  assert.ok(meta.poster.length > 0);
  assert.equal(cards[0].cover, meta.poster);
});

test('新番卡 meta 与放送表页点击路径一致（key=bangumi:<id>、pic、mediaType=tv）', () => {
  const api = loadModule();
  const cards = api.pickVideoDiscoveryCards({
    trending: [],
    highscore: [],
    calendar: calendarWith(3, [bgmItem(77, '芙莉莲')]),
    now: localTime(2026, 9, 24),
  });
  assert.equal(cards.length, 1);
  const meta = cards[0].meta;
  assert.equal(meta.key, 'bangumi:77');
  assert.equal(meta.title, '芙莉莲');
  assert.equal(meta.pic, 'https://bgm.tv/img/77.jpg');
  assert.equal(meta.mediaType, 'tv');
});

test('过滤 adult、无标题与无海报条目', () => {
  const api = loadModule();
  const cards = api.pickVideoDiscoveryCards({
    trending: [
      tmdbItem(1, '成人片', { adult: true }),
      tmdbItem(2, ''),
      tmdbItem(3, '无海报片', { poster: '' }),
      tmdbItem(4, '合格片'),
    ],
    highscore: [],
    calendar: [],
    now: localTime(2026, 9, 24),
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, '合格片');
});

test('当天空日历时顺延到之后有番剧的一天', () => {
  const api = loadModule();
  // 今天周四(索引3)为空，周五(4)有番剧
  const cards = api.pickVideoDiscoveryCards({
    trending: [],
    highscore: [],
    calendar: calendarWith(4, [bgmItem(88, '周五番')]),
    now: localTime(2026, 9, 24),
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, '周五番');
});

test('周日之后回绕到周一', () => {
  const api = loadModule();
  // 2026-09-27 是周日(索引6)；下周一(0)有番剧
  const cards = api.pickVideoDiscoveryCards({
    trending: [],
    highscore: [],
    calendar: calendarWith(0, [bgmItem(99, '周一番')]),
    now: localTime(2026, 9, 27),
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, '周一番');
});

test('同一天同候选池产出稳定；offset+1 换一批轮换到不同片', () => {
  const api = loadModule();
  const ctx = {
    trending: [tmdbItem(1, '甲'), tmdbItem(2, '乙'), tmdbItem(3, '丙')],
    highscore: [tmdbItem(4, '高甲', { rating: 9.1 }), tmdbItem(5, '高乙', { rating: 8.8 })],
    calendar: calendarWith(3, [bgmItem(6, '番甲'), bgmItem(7, '番乙')]),
    now: localTime(2026, 9, 24),
  };
  const a = api.pickVideoDiscoveryCards(ctx);
  const b = api.pickVideoDiscoveryCards(ctx);
  assert.deepEqual(a.map(c => c.title), b.map(c => c.title));
  const rotated = api.pickVideoDiscoveryCards(Object.assign({}, ctx, { offset: 1 }));
  assert.notEqual(rotated[0].title, a[0].title);
  assert.notEqual(rotated[1].title, a[1].title);
  assert.notEqual(rotated[2].title, a[2].title);
});

test('候选池只有一部时换一批保持不变（不越界）', () => {
  const api = loadModule();
  const ctx = {
    trending: [tmdbItem(1, '唯一')],
    highscore: [],
    calendar: [],
    now: localTime(2026, 9, 24),
  };
  const rotated = api.pickVideoDiscoveryCards(Object.assign({}, ctx, { offset: 5 }));
  assert.equal(rotated.length, 1);
  assert.equal(rotated[0].title, '唯一');
});

test('全部源为空返回空数组（条带整体隐藏）', () => {
  const api = loadModule();
  assert.equal(api.pickVideoDiscoveryCards({ trending: [], highscore: [], calendar: [], now: localTime(2026, 9, 24) }).length, 0);
  assert.equal(api.pickVideoDiscoveryCards(null).length, 0);
});

test('日缓存：同 key 当日命中、跨日失效', () => {
  const api = loadModule();
  const store = {};
  const ls = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const pools = {
    trending: [tmdbItem(1, '缓存甲')],
    highscore: [],
    bangumi: calendarWith(3, [bgmItem(2, '缓存番')]),
  };
  assert.equal(api.readDayCache(ls, localTime(2026, 9, 24)), null);
  api.writeDayCache(ls, pools, localTime(2026, 9, 24));
  const hit = api.readDayCache(ls, localTime(2026, 9, 24));
  assert.ok(hit, '当日应命中缓存');
  assert.equal(hit.pools.trending[0].title, '缓存甲');
  assert.equal(api.readDayCache(ls, localTime(2026, 9, 25)), null, '跨日应失效');
});
