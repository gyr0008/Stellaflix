'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '..', 'public', 'js', 'agent-daily-recommendation.js');
const DAY_MS = 86400000;

function loadRecommendation() {
  const code = fs.readFileSync(MODULE_PATH, 'utf8');
  const context = { console, Date, Math, JSON, String, Number, Array, Object, Boolean };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.StellaflixAgentDailyRecommendation;
}

function localNoon(dayOffset) {
  // 用本地时间构造，避免时区影响"相隔 N 天"的断言
  const base = new Date(2026, 8, 19, 12, 0, 0);
  return new Date(base.getTime() + dayOffset * DAY_MS).getTime();
}

test('discover card explains local-library origin when the song is not from a playlist', () => {
  const api = loadRecommendation();
  const now = localNoon(0);
  const result = api.pickDailyRecommendation({
    now,
    stats: { songs: {}, artists: {}, history: [] },
    localTracks: [{ type: 'local', localKey: 'cc3', name: '沉睡曲', artist: '子' }],
    playlists: [],
  });
  assert.equal(result.kind, 'discover');
  assert.equal(result.reason, '你的本地曲库里还没听过');
});

test('pickDailyMovie skips watched titles, is deterministic per day, and yields a playable command', () => {
  const api = loadRecommendation();
  const trending = [
    { id: 1, title: '热榜甲片' },
    { id: 2, title: ' 热榜乙片 ' },
    { id: 3, title: '' },
    { id: 4, title: '热榜丙片' },
  ];
  const history = [{ title: '热榜乙片', finished: true }];
  const first = api.pickDailyMovie(trending, history, localNoon(0));
  assert.ok(first, 'expected a movie pick');
  assert.equal(first.kind, 'tmdb');
  assert.ok(['热榜甲片', '热榜丙片'].includes(first.title), `unexpected pick ${first.title}`);
  assert.equal(first.command, '影视播放《' + first.title + '》');
  assert.match(first.reason, /热榜/);
  const again = api.pickDailyMovie(trending, history, localNoon(0));
  assert.deepEqual(again, first);
});

test('pickDailyMovie rotates to a different title on consecutive days', () => {
  const api = loadRecommendation();
  const trending = [{ id: 1, title: '片A' }, { id: 2, title: '片B' }];
  const day0 = api.pickDailyMovie(trending, [], localNoon(0));
  const day1 = api.pickDailyMovie(trending, [], localNoon(1));
  assert.ok(day0 && day1);
  assert.notEqual(day0.title, day1.title);
});

test('pickDailyMovie returns null when everything is watched or the list is empty', () => {
  const api = loadRecommendation();
  const trending = [{ id: 1, title: '唯一一部' }];
  assert.equal(api.pickDailyMovie(trending, [{ title: '唯一一部', finished: false }], localNoon(0)), null);
  assert.equal(api.pickDailyMovie([], [], localNoon(0)), null);
  assert.equal(api.pickDailyMovie(null, null, localNoon(0)), null);
});

test('pickLibraryMovie prefers the newest unfinished record', () => {
  const api = loadRecommendation();
  const result = api.pickLibraryMovie([
    { title: '已看完的剧', finished: true },
    { title: '没看完的剧', finished: false },
  ], []);
  assert.equal(result.kind, 'video-resume');
  assert.equal(result.title, '没看完的剧');
  assert.equal(result.command, '影视播放《没看完的剧》');
  assert.equal(result.reason, '上次没看完');
});

test('pickLibraryMovie falls back to a watching track when nothing is unfinished', () => {
  const api = loadRecommendation();
  const result = api.pickLibraryMovie([{ title: '看完的电影', finished: true }], [{ title: '追更中的番' }]);
  assert.equal(result.kind, 'video-track');
  assert.equal(result.title, '追更中的番');
  assert.match(result.reason, /追/);
});

test('pickLibraryMovie returns null with no history and no tracks', () => {
  const api = loadRecommendation();
  assert.equal(api.pickLibraryMovie([], []), null);
  assert.equal(api.pickLibraryMovie(null, null), null);
});

// chip 的「可播放保证」最终体现在生成的指令能被本地解析链吃下；
// 曾因 '影视播放The Fix' 无书名号且不以动词开头而落到「需要 AI 对话」兜底。
function loadVideoCommandParser() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'music-agent-command.js'), 'utf8');
  function extractFn(name) {
    const marker = '  function ' + name + '(';
    const start = src.indexOf(marker);
    assert.notEqual(start, -1, `parseVideoCommand chain lost ${name}`);
    const body = src.slice(start);
    const next = body.indexOf('\n  function ', 1);
    assert.notEqual(next, -1, `no function follows ${name}`);
    return body.slice(0, next);
  }
  const code = [
    'function videoPlayerIsActive(){return false;}',
    extractFn('isVideoStrongIntent'),
    extractFn('parseVideoCommand'),
    extractFn('cnNumToInt'),
    '({ parseVideoCommand: parseVideoCommand, isVideoStrongIntent: isVideoStrongIntent })',
  ].join('\n');
  const context = { console, Date, Math, JSON, String, Number, Array, Object, Boolean };
  vm.createContext(context);
  return vm.runInContext(code, context);
}

test('generated movie commands are parsed by the local video intent chain', () => {
  const api = loadRecommendation();
  const parser = loadVideoCommandParser();
  const tmdbPick = api.pickDailyMovie([{ id: 1, title: 'The Fix' }], [], localNoon(0));
  const libPick = api.pickLibraryMovie([{ title: '没看完的剧', finished: false }], []);
  for (const pick of [tmdbPick, libPick]) {
    assert.ok(pick, 'expected a pick');
    assert.ok(parser.isVideoStrongIntent(pick.command), `${pick.command} must be a strong video intent`);
    const parsed = parser.parseVideoCommand(pick.command);
    assert.ok(parsed, `${pick.command} must parse locally without AI`);
    assert.equal(parsed.action, 'search_and_play_movie');
    assert.equal(parsed.query, pick.title);
  }
});

test('four consecutive days rotate through all four cards once when all have candidates', () => {
  const api = loadRecommendation();
  const now = localNoon(0);
  const ctx = () => ({
    now,
    stats: {
      songs: {
        'song:401': { key: 'song:401', name: '回听歌', artist: '庚', plays: 6, completed: 6, lastPlayedAt: now - 15 * DAY_MS },
      },
      artists: { 辛: { name: '辛', plays: 10, listenMs: 1, lastPlayedAt: now - DAY_MS } },
      history: [{ key: 'song:402', name: '没听完歌', artist: '壬', completed: false, playedAt: now - DAY_MS }],
    },
    localTracks: [
      { type: 'local', localKey: 'aa1', name: '辛的新歌', artist: '辛' },
      { type: 'local', localKey: 'bb2', name: '另一首', artist: '癸' },
    ],
    playlists: [],
  });
  const kinds = [];
  for (let day = 0; day < 4; day += 1) {
    const result = api.pickDailyRecommendation(Object.assign(ctx(), { now: localNoon(day) }));
    assert.ok(result, `day ${day} should have a recommendation`);
    kinds.push(result.kind);
  }
  assert.deepEqual(kinds.slice().sort(), ['artist', 'discover', 'relisten', 'resume']);
  const again = api.pickDailyRecommendation(Object.assign(ctx(), { now: localNoon(2) }));
  const first = api.pickDailyRecommendation(Object.assign(ctx(), { now: localNoon(2) }));
  assert.deepEqual(first, again);
});

test('resume card surfaces the latest unfinished listen when other cards are empty', () => {
  const api = loadRecommendation();
  const now = localNoon(0);
  const result = api.pickDailyRecommendation({
    now,
    stats: {
      songs: {
        'song:301': { key: 'song:301', name: '昨天那首', artist: '戊', plays: 1, completed: 0, lastPlayedAt: now - DAY_MS },
      },
      artists: {},
      history: [
        { key: 'song:301', name: '昨天那首', artist: '戊', completed: false, playedAt: now - DAY_MS },
        { key: 'song:302', name: '更久没听完', artist: '己', completed: false, playedAt: now - 3 * DAY_MS },
      ],
    },
    localTracks: [],
    playlists: [],
  });
  assert.ok(result, 'expected a recommendation');
  assert.equal(result.kind, 'resume');
  assert.equal(result.title, '昨天那首');
  assert.equal(result.reason, '上次没听完');
});

test('discover card surfaces an unplayed song from an imported playlist with its name', () => {
  const api = loadRecommendation();
  const now = localNoon(0);
  const result = api.pickDailyRecommendation({
    now,
    stats: {
      songs: {
        'song:111': { key: 'song:111', name: '已听过', artist: '丙', plays: 3, completed: 3, lastPlayedAt: now - DAY_MS },
      },
      artists: {},
      history: [],
    },
    localTracks: [],
    playlists: [
      { name: '深夜跑步', id: 'pl1', songs: [
        { id: 111, name: '已听过', artist: '丙' },
        { id: 222, name: '遗珠歌', artist: '丁' },
      ] },
    ],
  });
  assert.ok(result, 'expected a recommendation');
  assert.equal(result.kind, 'discover');
  assert.equal(result.title, '遗珠歌');
  assert.equal(result.reason, '来自你的歌单「深夜跑步」');
  assert.equal(result.command, '播放丁的遗珠歌');
});

test('artist card recommends an unplayed track of the top artist from the library', () => {
  const api = loadRecommendation();
  const now = localNoon(0);
  const result = api.pickDailyRecommendation({
    now,
    stats: {
      songs: {
        'local:played1': { key: 'local:played1', name: '已听歌', artist: 'EKKSTACY', plays: 20, completed: 20, lastPlayedAt: now - DAY_MS },
      },
      artists: { EKKSTACY: { name: 'EKKSTACY', plays: 20, listenMs: 1, lastPlayedAt: now - DAY_MS } },
      history: [],
    },
    localTracks: [
      { type: 'local', localKey: 'played1', name: '已听歌', artist: 'EKKSTACY' },
      { type: 'local', localKey: 'fresh1', name: '没听过的歌', artist: 'EKKSTACY' },
      { type: 'local', localKey: 'other1', name: '别人家的歌', artist: '其他人' },
    ],
    playlists: [],
  });
  assert.ok(result, 'expected a recommendation');
  assert.equal(result.kind, 'artist');
  assert.equal(result.title, '没听过的歌');
  assert.equal(result.reason, '你常听的 EKKSTACY，这首还没听过');
  assert.equal(result.command, '播放EKKSTACY的没听过的歌');
});

test('relisten ranking merges online twin plays for local tracks via matchStore', () => {
  const api = loadRecommendation();
  const now = localNoon(0);
  const result = api.pickDailyRecommendation({
    now,
    stats: {
      songs: {
        'local:aaa': { key: 'local:aaa', name: '本地歌', artist: '歌手A', plays: 1, completed: 1, lastPlayedAt: now - 9 * DAY_MS },
        'qq:mid1': { key: 'qq:mid1', name: '在线对应曲', artist: '歌手A', plays: 4, completed: 4, lastPlayedAt: now - 9 * DAY_MS },
        'song:200': { key: 'song:200', name: '中间歌', artist: '歌手B', plays: 3, completed: 3, lastPlayedAt: now - 9 * DAY_MS },
      },
      artists: {},
      history: [],
    },
    localTracks: [],
    playlists: [],
    matchStore: { get: (id) => (id === 'aaa' ? { provider: 'qq', key: 'qq:mid1' } : null) },
  });
  assert.equal(result && result.kind, 'relisten');
  assert.equal(result.title, '本地歌');
});

test('relisten card excludes songs played within 7 days or older than 30 days', () => {
  const api = loadRecommendation();
  const now = localNoon(0);
  const stats = {
    songs: {
      'song:101': { key: 'song:101', name: '太新的歌', artist: '甲', plays: 9, completed: 9, lastPlayedAt: now - 2 * DAY_MS },
      'song:102': { key: 'song:102', name: '太旧的歌', artist: '乙', plays: 8, completed: 8, lastPlayedAt: now - 45 * DAY_MS },
    },
    artists: {},
    history: [],
  };
  assert.equal(api.pickDailyRecommendation({ now, stats, localTracks: [], playlists: [] }), null);
  const withInWindow = {
    songs: Object.assign({}, stats.songs, {
      'song:103': { key: 'song:103', name: '窗口内的歌', artist: '丙', plays: 1, completed: 1, lastPlayedAt: now - 8 * DAY_MS },
    }),
    artists: {},
    history: [],
  };
  const result = api.pickDailyRecommendation({ now, stats: withInWindow, localTracks: [], playlists: [] });
  assert.equal(result && result.title, '窗口内的歌');
});

test('relisten card picks the most-played song last heard 7-30 days ago', () => {
  const api = loadRecommendation();
  const now = localNoon(0);
  const result = api.pickDailyRecommendation({
    now,
    stats: {
      songs: {
        'song:101': { key: 'song:101', name: '寻常歌', artist: '陈柏宇', plays: 5, completed: 4, lastPlayedAt: now - 10 * DAY_MS },
        'song:102': { key: 'song:102', name: '冷门歌', artist: '某人', plays: 2, completed: 1, lastPlayedAt: now - 12 * DAY_MS },
      },
      artists: {},
      history: [],
    },
    localTracks: [],
    playlists: [],
  });
  assert.ok(result, 'expected a recommendation');
  assert.equal(result.kind, 'relisten');
  assert.equal(result.title, '寻常歌');
  assert.equal(result.artist, '陈柏宇');
  assert.equal(result.command, '播放陈柏宇的寻常歌');
  assert.equal(result.reason, '有些日子没听了');
});
