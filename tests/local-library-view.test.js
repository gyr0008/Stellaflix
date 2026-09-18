'use strict';

/**
 * 本地音乐库弹窗视图逻辑（过滤/排序/选中态）测试
 * 运行：node --test tests/local-library-view.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.join(__dirname, '..');
const dashboardPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '03a-home-dashboard.js');
const source = fs.readFileSync(dashboardPath, 'utf8');

function loadHelpers() {
  const start = source.indexOf('function filterHomeLocalTracks');
  assert.notStrictEqual(start, -1, 'filterHomeLocalTracks not implemented yet');
  const end = source.indexOf('function renderHomeLocalModes');
  assert.notStrictEqual(end, -1, 'renderHomeLocalModes missing');
  const sandbox = { console, JSON, Math, String, Number, Array, Object, Boolean, window: {}, localeCompare: undefined };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox, { filename: 'local-view-helpers.js' });
  return sandbox;
}

function song(name, artist, album, duration) {
  return { type: 'local', name, artist, album, duration };
}

test('filter matches title, artist and album case-insensitively', () => {
  const sb = loadHelpers();
  const list = [song('Summertime Sadness', 'Lana Del Rey', 'Born To Die', 255), song('晴天', '周杰伦', '叶惠美', 269)];
  assert.strictEqual(sb.filterHomeLocalTracks(list, 'summersadness').length, 0);
  assert.strictEqual(sb.filterHomeLocalTracks(list, 'SUMMERTIME').length, 1);
  assert.strictEqual(sb.filterHomeLocalTracks(list, '周杰伦').length, 1);
  assert.strictEqual(sb.filterHomeLocalTracks(list, 'born to die').length, 1);
});

test('filter with empty query returns the same order', () => {
  const sb = loadHelpers();
  const list = [song('b'), song('a')];
  assert.deepStrictEqual(sb.filterHomeLocalTracks(list, '').map((s) => s.name), ['b', 'a']);
  assert.deepStrictEqual(sb.filterHomeLocalTracks(list, '   ').map((s) => s.name), ['b', 'a']);
});

test('sort by title/artist/duration without mutating the input', () => {
  const sb = loadHelpers();
  const list = [song('c 曲', 'B', '', 100), song('a 曲', 'C', '', 300), song('b 曲', 'A', '', 200)];
  const byTitle = sb.sortHomeLocalTracks(list, 'title').map((s) => s.name);
  assert.deepStrictEqual(byTitle, ['a 曲', 'b 曲', 'c 曲']);
  const byArtist = sb.sortHomeLocalTracks(list, 'artist').map((s) => s.artist);
  assert.deepStrictEqual(byArtist, ['A', 'B', 'C']);
  const byDuration = sb.sortHomeLocalTracks(list, 'duration').map((s) => s.duration);
  assert.deepStrictEqual(byDuration, [100, 200, 300]);
  assert.deepStrictEqual(list.map((s) => s.name), ['c 曲', 'a 曲', 'b 曲'], 'input must not be mutated');
});

test('sort default keeps original order and unknown modes fall back to default', () => {
  const sb = loadHelpers();
  const list = [song('z'), song('y')];
  assert.deepStrictEqual(sb.sortHomeLocalTracks(list, 'default').map((s) => s.name), ['z', 'y']);
  assert.deepStrictEqual(sb.sortHomeLocalTracks(list, 'nonsense').map((s) => s.name), ['z', 'y']);
});

test('modal skeleton uses the master-detail containers', () => {
  const html = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  assert.match(html, /local-library-rail/);
  assert.match(html, /local-library-list/);
  assert.match(html, /local-library-search/);
  assert.match(html, /home-local-modes-grid/);
});

test('locked identifiers from persistence tests survive the redesign', () => {
  assert.match(source, /renderHomeDashboardLocalMusic/);
  assert.match(source, /openHomeLocalMusicModal/);
  assert.match(source, /continueHomeLocalPlayback/);
  assert.match(source, /playHomeLocalPlaylistAt/);
  assert.match(source, /home-local-modes-grid/);
});
