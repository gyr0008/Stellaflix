'use strict';

/**
 * 歌曲详情"播放次数"（完整播完计数 + 本地歌合并在线匹配键）行为测试
 * 运行：node --test tests/local-play-count-detail.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.join(__dirname, '..');
const detailPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '06-track-detail-lyrics-actions.js');
const source = fs.readFileSync(detailPath, 'utf8');

function sliceBetween(startMarker, endMarker) {
  const s = source.indexOf(startMarker);
  assert.notStrictEqual(s, -1, 'start marker missing: ' + startMarker);
  const e = source.indexOf(endMarker, s);
  assert.notStrictEqual(e, -1, 'end marker missing: ' + endMarker);
  return source.slice(s, e);
}

const SEGMENT = sliceBetween('function songCompletedPlayCount(', 'function openTrackDetailModal');

function makeSandbox(listenSongs, matchEntry) {
  const sandbox = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Promise,
    listenStatsState: { songs: listenSongs || {}, history: [], artists: {} },
    queueItemKey: (song) => {
      if (!song) return '';
      if (song.localKey) return 'local:' + song.localKey;
      if (song.provider) return song.provider + ':' + song.id;
      return 'song:' + song.id;
    },
  };
  sandbox.window = {
    localOnlineMatchStore: matchEntry === undefined ? null : { get: () => matchEntry },
  };
  vm.createContext(sandbox);
  vm.runInContext(SEGMENT, sandbox, { filename: 'play-count-segment.js' });
  return sandbox;
}

const LK = 'd'.repeat(24);

test('online song counts its own completed plays only', () => {
  const sb = makeSandbox({ 'netease:123': { completed: 4, plays: 9 } }, null);
  assert.strictEqual(sb.songCompletedPlayCount({ provider: 'netease', id: 123 }), 4);
});

test('missing stats yield 0, not undefined', () => {
  const sb = makeSandbox({}, null);
  assert.strictEqual(sb.songCompletedPlayCount({ provider: 'netease', id: 999 }), 0);
  assert.strictEqual(sb.songCompletedPlayCount(null), 0);
});

test('local song counts its own completed plays', () => {
  const sb = makeSandbox({ ['local:' + LK]: { completed: 2, plays: 3 } }, null);
  assert.strictEqual(sb.songCompletedPlayCount({ type: 'local', localKey: LK }), 2);
});

test('local song merges completed plays of its cached online match', () => {
  const sb = makeSandbox(
    { ['local:' + LK]: { completed: 2 }, 'netease:556': { completed: 3 } },
    { provider: 'netease', key: 'netease:556', snapshot: {}, matchedAt: 1 }
  );
  assert.strictEqual(sb.songCompletedPlayCount({ type: 'local', localKey: LK }), 5);
});

test('online clone of a local song does not double count (single key only)', () => {
  const sb = makeSandbox(
    { ['local:' + LK]: { completed: 2 }, 'netease:556': { completed: 3 } },
    null
  );
  const clone = { provider: 'netease', id: 556, localOriginKey: LK };
  assert.strictEqual(sb.songCompletedPlayCount(clone), 3);
});

test('detail modal renders the 播放次数 row in the album grid', () => {
  assert.ok(source.indexOf("detailRow('播放次数'") > -1, 'album detail must include 播放次数 row');
});
