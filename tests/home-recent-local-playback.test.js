'use strict';

/**
 * 首页"最近播放"点击本地歌曲的回解析（05-home-actions.js）行为测试
 * 运行：node --test tests/home-recent-local-playback.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.join(__dirname, '..');
const actionsPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '05-home-actions.js');
const source = fs.readFileSync(actionsPath, 'utf8');

function sliceBetween(startMarker, endMarker) {
  const s = source.indexOf(startMarker);
  assert.notStrictEqual(s, -1, 'start marker missing: ' + startMarker);
  const e = source.indexOf(endMarker, s);
  assert.notStrictEqual(e, -1, 'end marker missing: ' + endMarker);
  return source.slice(s, e);
}

const SEGMENT = sliceBetween('function localTrackFromListenRecord', 'function openHomeInsight');

const LK = 'e'.repeat(24);

function libraryTrack(extra) {
  return Object.assign({
    type: 'local', source: 'local', provider: 'local',
    id: 'local:' + LK, localFileId: LK, localKey: LK,
    localUrl: 'stellaflix-local://media/audio/' + LK,
    name: 'i walk this earth all by myself', artist: 'EKKSTACY', duration: 242,
  }, extra || {});
}

function localRecord() {
  return { key: 'local:' + LK, id: 'local:' + LK, sourceKey: 'local', type: 'local', name: 'i walk this earth all by myself', artist: 'EKKSTACY' };
}

function makeSandbox(tracks) {
  const calls = { toasts: [], searches: [], playQueueAt: [] };
  const sandbox = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Promise, setTimeout,
    calls,
    persistentLocalLibraryTracks: tracks || [],
    showToast: (m) => { calls.toasts.push(String(m)); },
    runHomeSearch: (q) => { calls.searches.push(q); },
    homeListenSummary: () => ({ recent: null }),
    cloneSong: (s) => Object.assign({}, s),
    safeRenderQueuePanel: () => {},
    safeShelfRebuild: () => {},
    forcePlaybackControlsInteractive: () => {},
    playQueueAt: async (idx, opts) => { calls.playQueueAt.push({ idx, opts }); return true; },
    playQueue: [],
    currentIdx: -1,
    activeRadioContext: null,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SEGMENT, sandbox, { filename: 'home-actions-segment.js' });
  return sandbox;
}

test('local listen record resolves back to the library track with localUrl', () => {
  const sb = makeSandbox([libraryTrack()]);
  const song = sb.songFromListenRecord(localRecord());
  assert.ok(song, 'local record must resolve');
  assert.strictEqual(song.localUrl, libraryTrack().localUrl);
  assert.strictEqual(song.localKey, LK);
  assert.strictEqual(song.type, 'local');
});

test('local listen record for a removed file resolves to null (falls through to search)', () => {
  const sb = makeSandbox([]);
  assert.strictEqual(sb.songFromListenRecord(localRecord()), null);
});

test('playHomeRecent with a resolvable local record queues the library track and plays', async () => {
  const sb = makeSandbox([libraryTrack()]);
  await sb.playHomeRecent(localRecord());
  assert.strictEqual(sb.calls.searches.length, 0);
  assert.strictEqual(sb.calls.playQueueAt.length, 1);
  assert.strictEqual(sb.playQueue[0].localUrl, libraryTrack().localUrl);
});

test('playHomeRecent with an unresolvable local record searches by name instead of dead-playing', async () => {
  const sb = makeSandbox([]);
  await sb.playHomeRecent(localRecord());
  assert.strictEqual(sb.calls.searches.length, 1);
  assert.strictEqual(sb.calls.searches[0], 'i walk this earth all by myself');
  assert.strictEqual(sb.calls.playQueueAt.length, 0);
});

test('online listen records keep the existing mapping', () => {
  const sb = makeSandbox([]);
  const song = sb.songFromListenRecord({ key: 'netease:123', id: 123, sourceKey: 'netease', type: 'song', name: 'x', artist: 'y' });
  assert.strictEqual(song.provider, 'netease');
  assert.strictEqual(song.id, 123);
  assert.strictEqual(song.localUrl, undefined);
});
