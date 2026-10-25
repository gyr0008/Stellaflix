'use strict';

// 契约：日缓存命中后，空的候选池必须能在后续 getCards() 触发补取并合并回写；
// 已成功的池不得被后续失败覆盖；全池齐备时不再发起任何取数。
// 根因回归：上游瞬时失败（如 bangumi 日历 502/超时）曾被 hasAnyPool 锁成全天两卡。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '..', 'public', 'js', 'home-video-discovery.js');

function tmdbItem(id, title, extra) {
  return Object.assign({
    id: id, mediaType: 'movie', title: title,
    year: '2026', poster: 'https://image.tmdb.org/p' + id + '.jpg',
    rating: 9.1, voteCount: 1000, adult: false,
  }, extra || {});
}
function bgmItem(id, title) {
  return { id: id, title: title, name: title, poster: 'https://bgm.tv/img/' + id + '.jpg', airDate: '2026-10-17' };
}
function calendarWith(dayIdx, items) {
  var cal = [[], [], [], [], [], [], []];
  cal[dayIdx] = items;
  return cal;
}
function todayKey() {
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function makeSandbox(opts) {
  const store = opts.seed ? Object.assign({}, opts.seed) : {};
  const ls = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const calls = { calendar: 0, trending: 0, discover: 0, rerender: 0 };
  const timers = [];
  const fakeSetTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const bangumi = {
    getCalendar: () => {
      calls.calendar++;
      return (opts.calendarImpl || (() => Promise.resolve({ calendar: calendarWith(0, [bgmItem(7, '补番甲')]) })))();
    },
  };
  const tmdb = {
    hasKey: () => !!(opts.tmdbReady),
    trending: () => { calls.trending++; return (opts.trendingImpl || (() => Promise.resolve([])))(); },
    discover: () => { calls.discover++; return (opts.discoverImpl || (() => Promise.resolve([])))(); },
  };
  const context = {
    console, Date, Math, JSON, String, Number, Array, Object, Boolean, Promise, encodeURIComponent,
    setTimeout: opts.captureTimers ? fakeSetTimeout : setTimeout,
    localStorage: ls,
    StellaflixVideo: { tmdb, bangumi },
    renderHomeDashboardDiscovery: () => { calls.rerender++; },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(MODULE_PATH, 'utf8'), context);
  return { api: context.StellaflixHomeVideoDiscovery, store, calls, ls, timers };
}

const settle = () => new Promise(r => setTimeout(r, 5));

test('日缓存命中但 calendar 池为空 → getCards 触发补取，合并回写后三卡齐', async () => {
  const seed = {
    'stellaflix-home-video-discovery-v1': JSON.stringify({
      date: todayKey(),
      pools: { trending: [tmdbItem(1, '热榜甲')], highscore: [tmdbItem(2, '高分乙')], calendar: [] },
    }),
  };
  const { api, store, calls } = makeSandbox({ seed });
  const before = api.getCards();
  assert.equal(before.length, 2, '同步返回仍按现有池出两卡');
  await settle();
  const hit = JSON.parse(store['stellaflix-home-video-discovery-v1']);
  assert.ok(hit.pools.calendar.length === 7 && calls.calendar === 1, '补取成功应合并回写整周日历');
  const after = api.getCards();
  assert.equal(after.length, 3);
  assert.equal(after.map(c => c.slot).join(','), 'hot,high,bangumi');
});

test('补取失败不覆盖已成功池；日历仍空时保持两卡', async () => {
  const seed = {
    'stellaflix-home-video-discovery-v1': JSON.stringify({
      date: todayKey(),
      pools: { trending: [tmdbItem(1, '热榜甲')], highscore: [], calendar: [] },
    }),
  };
  const { api, store } = makeSandbox({
    seed, captureTimers: true,
    calendarImpl: () => Promise.resolve({ calendar: [], error: 'boom' }),
  });
  api.getCards();
  await settle();
  const hit = JSON.parse(store['stellaflix-home-video-discovery-v1']);
  assert.equal(hit.pools.trending.length, 1, 'trending 池不得被覆盖清空');
  assert.equal(api.getCards().length, 1);
});

test('三池齐备时 getCards 不再发起任何取数', async () => {
  const seed = {
    'stellaflix-home-video-discovery-v1': JSON.stringify({
      date: todayKey(),
      pools: { trending: [tmdbItem(1, '甲')], highscore: [tmdbItem(2, '乙')], calendar: calendarWith(0, [bgmItem(3, '丙')]) },
    }),
  };
  const { api, calls } = makeSandbox({ seed, tmdbReady: true });
  assert.equal(api.getCards().length, 3);
  await settle();
  assert.equal(calls.calendar, 0);
  assert.equal(calls.trending, 0);
  assert.equal(calls.discover, 0);
});

test('空池补取一次失败后进入冷却，连续 getCards 不反复打上游', async () => {
  const seed = {
    'stellaflix-home-video-discovery-v1': JSON.stringify({
      date: todayKey(),
      pools: { trending: [tmdbItem(1, '甲')], highscore: [], calendar: [] },
    }),
  };
  const { api, calls } = makeSandbox({
    seed, captureTimers: true,
    calendarImpl: () => Promise.reject(new Error('502')),
  });
  api.getCards();
  await settle();
  api.getCards();
  api.getCards();
  await settle();
  assert.equal(calls.calendar, 1, '冷却窗口内只允许一次补取');
});

test('TMDB 无 key 时不空转重试 trending/highscore，只补日历', async () => {
  const seed = {
    'stellaflix-home-video-discovery-v1': JSON.stringify({
      date: todayKey(),
      pools: { trending: [], highscore: [], calendar: [] },
    }),
  };
  const { api, calls } = makeSandbox({ seed });
  api.getCards();
  await settle();
  assert.equal(calls.calendar, 1);
  assert.equal(calls.trending, 0);
  assert.equal(calls.discover, 0);
});

test('补取失败 → 自排冷却重试，用户停在首页也能自愈', async () => {
  const seed = {
    'stellaflix-home-video-discovery-v1': JSON.stringify({
      date: todayKey(),
      pools: { trending: [tmdbItem(1, '甲')], highscore: [], calendar: [] },
    }),
  };
  let first = true;
  const { api, calls, timers } = makeSandbox({
    seed, captureTimers: true,
    calendarImpl: () => {
      if (first) { first = false; return Promise.resolve({ calendar: [], error: '502' }); }
      return Promise.resolve({ calendar: calendarWith(0, [bgmItem(9, '迟到番')]) });
    },
  });
  api.getCards();
  await settle();
  assert.equal(calls.calendar, 1);
  const retry = timers.find(t => t.ms >= 30000);
  assert.ok(retry, '失败后必须排一个冷却重试定时器，实际 timers=' + JSON.stringify(timers.map(t => t.ms)));
  retry.fn();
  await settle();
  assert.equal(calls.calendar, 2, '定时器触发后应再补一次');
  assert.equal(api.getCards().length, 2, '救回后番剧卡补上（trending+bangumi）');
});

test('补取成功 → 不再排重试定时器', async () => {
  const seed = {
    'stellaflix-home-video-discovery-v1': JSON.stringify({
      date: todayKey(),
      pools: { trending: [tmdbItem(1, '甲')], highscore: [], calendar: [] },
    }),
  };
  const { api, calls, timers } = makeSandbox({ seed, captureTimers: true });
  api.getCards();
  await settle();
  assert.equal(calls.calendar, 1);
  assert.equal(timers.filter(t => t.ms >= 30000).length, 0, '成功路径不应留冷却定时器');
});
