'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('index.html loads the recommendation module before the agent command script', () => {
  const html = read('public', 'index.html');
  const rec = html.indexOf('js/agent-daily-recommendation.js');
  const cmd = html.indexOf('js/music-agent-command.js');
  assert.ok(rec >= 0, 'agent-daily-recommendation.js must be loaded');
  assert.ok(cmd >= 0, 'music-agent-command.js must be loaded');
  assert.ok(rec < cmd, 'recommendation module must load before the agent command script');
});

test('dailyRecommendation consults the recommendation module with real user data', () => {
  const src = read('public', 'js', 'music-agent-command.js');
  const body = src.slice(src.indexOf('function dailyRecommendation'), src.indexOf('function updateDailyRecommendationExample'));
  assert.match(body, /StellaflixAgentDailyRecommendation/);
  assert.match(body, /stellaflix-listen-stats-v1/);
  assert.match(body, /getStellaflixPersistentLocalLibraryTracks/);
  assert.match(body, /userPlaylists/);
  assert.match(body, /localOnlineMatchStore/);
});

test('static list remains the fallback and real picks keep their kind and reason', () => {
  const src = read('public', 'js', 'music-agent-command.js');
  const body = src.slice(src.indexOf('function dailyRecommendation'), src.indexOf('function updateDailyRecommendationExample'));
  const fallback = body.slice(body.indexOf('DAILY_RECOMMENDATIONS['));
  assert.match(fallback, /return\s*\{[^}]*title/, 'static fallback must still return a title/command object');
  assert.doesNotMatch(fallback, /kind:/, 'static fallback must not carry a recommendation kind');
});

test('chip label distinguishes real recommendations from static examples', () => {
  const src = read('public', 'js', 'music-agent-command.js');
  const body = src.slice(src.indexOf('function updateDailyRecommendationExample'), src.indexOf('function parseMusicCommand'));
  assert.match(body, /为你推荐/);
  assert.match(body, /试着对我说/);
  assert.match(body, /recommendation\.kind/, 'label must branch on whether the pick is a real recommendation');
  assert.match(body, /recommendation\.reason/, 'tooltip must show the recommendation reason');
});

test('local library tracks are exposed to agent scripts through a getter', () => {
  const src = read('public', 'js', 'modules', '12-expose-inline-globals.js');
  assert.match(src, /window\.getStellaflixPersistentLocalLibraryTracks\s*=/);
  assert.match(src, /persistentLocalLibraryTracks/);
});

test('example chip row drops playlist/source shortcuts and adds the movie chip', () => {
  const src = read('public', 'js', 'music-agent-command.js');
  const start = src.indexOf("class=\"music-agent-examples\"");
  assert.ok(start >= 0, 'examples row template must exist');
  const row = src.slice(start, src.indexOf("'</div>' +", start));
  assert.doesNotMatch(row, /data-agent-example="导入歌单"/);
  assert.doesNotMatch(row, /data-agent-example="打开音源"/);
  assert.match(row, /data-agent-daily-movie/);
});

test('movie chip consults TMDB trending with library and static fallbacks', () => {
  const src = read('public', 'js', 'music-agent-command.js');
  const body = src.slice(src.indexOf('function refreshDailyMoviePick'), src.indexOf('function updateDailyMovieExample'));
  assert.ok(body.length > 0, 'refreshDailyMoviePick must exist before updateDailyMovieExample');
  assert.match(body, /pickDailyMovie/);
  assert.match(body, /trending/);
  assert.match(body, /watchHistory/);
  assert.match(body, /readDailyMovieCache\(\)/);
  assert.match(body, /writeDailyMovieCache\(pick\)/);
  assert.match(src, /DAILY_MOVIE_CACHE_KEY\s*=\s*'stellaflix-agent-daily-movie-v2'/);
  const render = src.slice(src.indexOf('function updateDailyMovieExample'), src.indexOf('function parseMusicCommand'));
  assert.match(render, /pickLibraryMovie/, 'render must fall back to library picks');
  assert.match(render, /今日影视/);
  assert.match(render, /试着对我说：影视播放/);
  assert.match(render, /pick\.reason/, 'tooltip must show the movie reason');
});

test('movie chip refreshes when the panel is built and opened', () => {
  const src = read('public', 'js', 'music-agent-command.js');
  const open = src.slice(src.indexOf('function openPanel'), src.indexOf('function openPanel') + 600);
  assert.match(open, /updateDailyMovieExample\(\)/);
  assert.match(open, /refreshDailyMoviePick\(\)/);
});
