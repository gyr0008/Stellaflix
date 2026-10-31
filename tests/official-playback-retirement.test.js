'use strict';

/**
 * tests/official-playback-retirement.test.js — 官方直链播放与试听残留退役钉桩（批 T18）
 *
 * 主人裁定（2026-11-01，选项2）：合流前先清掉 T16d 遗留的官方直链支路。
 * LX 世界观下在线播放 URL 只可能来自用户音源脚本，因此：
 *  - server `/api/song/url` 整条（直链解析 + 站内同曲匹配 + 候选缓存 + 预算常量）退役，
 *    路由与其余平台登录族一样落统一守卫 404 { ok:false, error:'REMOVED' }；
 *  - 前端「同曲候选重试」与 SVIP/试听提示链退役（试听横幅 DOM 保留但永不点亮，
 *    由 tests/local-profile-fix1.test.js 钉住 DOM）。
 *
 * 取证（2026-11-01）：resolveNeteaseDirectSongUrlInner 调用的 probePlaybackAudioUrl
 * 已在 T15 随音频探测改造删除，server.js 里只剩调用点 —— 官方直链支路本身已是死码。
 *
 * 端口 3993（3991 归 platform-login-removal，3992 归 podcast-removal）。
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SERVER = read('server.js');
const PLAYBACK = read(path.join('public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'));

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// 官方直链 / 站内同曲匹配的服务端符号：全部应随退役消失
const RETIRED_SERVER_SYMBOLS = [
  'handleSongUrl',
  'resolveNeteaseDirectSongUrl',
  'resolveNeteaseDirectSongUrlInner',
  'resolveNeteaseSameTrackPlayback',
  'findNeteaseSameTrackCandidates',
  'findNeteaseSameTrackCandidatesInner',
  'neteaseSourceMatchCache',
  'neteaseSourceMatchInflight',
  'neteaseSourceMatchCandidateScore',
  'mergeNeteaseSourceMatchSong',
  'createPlaybackTtlCache',
  'neteaseSongUrlCache',
  'qqSongUrlCache',
  'hasNeteaseSvip',
  'ANONYMOUS_PLAYBACK_LOGIN',
  'classifyNeteasePlaybackRestriction',
  'filterLikelyPlayableWeatherSongs',
  'NETEASE_DIRECT_RESOLVE_BUDGET_MS',
  'NETEASE_SONG_URL_TOTAL_BUDGET_MS',
  'NETEASE_SOURCE_MATCH_TOTAL_BUDGET_MS',
  'NETEASE_SOURCE_MATCH_LOOKUP_BUDGET_MS',
  'NETEASE_QUALITY_CANDIDATES',
  'song_url_v1',
];

test('① server.js：官方直链与站内同曲匹配的实现整体消失', () => {
  for (const symbol of RETIRED_SERVER_SYMBOLS) {
    assert.equal(SERVER.includes(symbol), false, 'server.js 仍含官方直链符号 ' + symbol);
  }
});

test('② server.js：/api/song/url 只登记在统一 REMOVED 守卫里', () => {
  assert.equal(countOccurrences(SERVER, "'/api/song/url'"), 1, '/api/song/url 应只剩守卫名单一处');
  const guardStart = SERVER.indexOf('// ---------- 平台登录族 + 五平台官方 API 统一收口');
  const guardEnd = SERVER.indexOf("sendJSON(res, { ok: false, error: 'REMOVED' }, 404)", guardStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart, '统一守卫块结构不完整');
  assert.ok(SERVER.slice(guardStart, guardEnd).includes("'/api/song/url'"), '/api/song/url 必须登记进 REMOVED 守卫');
});

test('③ 13-playback-start-audio.js：同曲重试与试听提示链消失', () => {
  for (const needle of [
    '/api/song/url',
    'sourceMatch',
    'neteasePlaybackMatchQuery',
    'retryNeteaseSourceMatchPlayback',
    'applyNeteaseSourceMatchMetadata',
    'clearNeteaseSourceMatchMetadata',
    'resolvedNeteaseId',
    'data.trial',
    'song.trial',
    'trial-text',
    "classList.add('show')",
  ]) {
    assert.equal(PLAYBACK.includes(needle), false, '13-playback 仍含官方试听残留 ' + needle);
  }
});

test('④ LX 解析主链与保留的公开元数据路由不受影响', () => {
  assert.ok(PLAYBACK.includes('/api/lx-source/resolve'), '播放解析必须仍指 lx-source/resolve');
  assert.ok(PLAYBACK.includes('/api/audio'), '音频代理入口 /api/audio 必须保留');
  for (const route of ['/api/playlist/tracks', '/api/album/detail', '/api/artist/detail', '/api/lyric', '/api/search', '/api/discover/home']) {
    assert.ok(SERVER.includes("pn === '" + route + "'"), '公开元数据路由 ' + route + ' 必须保留');
  }
  assert.ok(SERVER.includes('function handleNeteaseAlbumDetail'), 'album detail 实现保留');
  assert.ok(SERVER.includes('isLowSignalWeatherSong'), '电台低信号过滤（buildWeatherRadio 仍在用）必须保留');
});

// ---------- ⑤ 进程内起服：/api/song/url 落 404 REMOVED ----------
const PORT = 3993;
process.env.PORT = String(PORT);
delete process.env.HOST;

const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;

async function waitListening() {
  if (server.listening) return;
  await new Promise((resolve) => server.once('listening', resolve));
}

after(() => {
  if (server.listening) server.close();
});

test('⑤ GET /api/song/url 返回 404 REMOVED', async () => {
  await waitListening();
  const res = await fetch(BASE + '/api/song/url?id=441102546&name=x&artist=y');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'REMOVED');
});
