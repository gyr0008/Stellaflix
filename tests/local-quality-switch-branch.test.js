'use strict';

/**
 * 本地歌在线切音质（00-api-quality-output.js 本地分支）行为测试
 * 运行：node --test tests/local-quality-switch-branch.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.join(__dirname, '..');
const qualityPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '00-api-quality-output.js');
const source = fs.readFileSync(qualityPath, 'utf8');

function sliceBetween(startMarker, endMarker) {
  const s = source.indexOf(startMarker);
  assert.notStrictEqual(s, -1, 'start marker missing: ' + startMarker);
  const e = source.indexOf(endMarker, s);
  assert.notStrictEqual(e, -1, 'end marker missing: ' + endMarker);
  return source.slice(s, e);
}

const SEGMENT = sliceBetween('function normalizePlaybackQuality(', 'function toggleQualityPanel');

const VALID_KEY = 'a'.repeat(24);

function makeEl(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    title: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    contains: () => false,
  };
}

function makeSandbox(overrides) {
  const els = {};
  function fakeEl(id) {
    if (!els[id]) els[id] = makeEl(id);
    return els[id];
  }
  const calls = { toasts: [], notices: [], playQueueAt: [], match: 0 };
  const sandbox = Object.assign({
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Promise, setTimeout, clearTimeout, encodeURIComponent, AbortController,
    calls,
    document: { getElementById: fakeEl, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ set textContent(v) {}, innerHTML: '' }) },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    escHtml: (v) => String(v == null ? '' : v),
    showToast: (msg) => { calls.toasts.push(String(msg)); },
    showSourceFallbackNotice: (t, b) => { calls.notices.push(t); },
    forcePlaybackControlsInteractive: () => {},
    hasProviderSvip: () => true,
    hasPlatformLogin: () => true,
    openProviderLogin: () => {},
    songProviderKey: (song) => (song && (song.provider || song.source)) || 'netease',
    playQueueAt: async (idx, opts) => { calls.playQueueAt.push({ idx, opts }); return true; },
    PLAYBACK_QUALITY_OPTIONS: {
      netease: [
        { key: 'hires', title: '高清臻音', sub: '默认 / 细节优先' },
        { key: 'lossless', title: '无损 SQ', sub: 'FLAC 优先' },
        { key: 'exhigh', title: '极高 HQ', sub: '320kbps' },
        { key: 'standard', title: '标准', sub: '128kbps' },
      ],
      qq: [
        { key: 'lossless', title: '无损 FLAC', sub: 'FLAC 优先' },
        { key: 'exhigh', title: '320k MP3', sub: '320kbps' },
      ],
      kugou: [{ key: 'lossless', title: '酷狗无损', sub: 'FLAC' }],
    },
    PLAYBACK_QUALITY_DEFAULTS: { netease: 'hires', qq: 'lossless', kugou: 'lossless', qishui: 'standard', spotify: 'standard' },
    PLAYBACK_QUALITY_STORE_KEY: 'stellaflix-playback-quality-v1',
    playbackQualityPrefs: { netease: 'hires', qq: 'lossless' },
    playbackQualityRuntimeCaps: {},
    playbackQuality: 'hires',
    loginStatus: {},
    currentIdx: 0,
    playQueue: [],
    audio: { currentTime: 42.5, src: 'stellaflix-local://x', paused: false, ended: false, duration: 180 },
  }, overrides || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SEGMENT, sandbox, { filename: 'quality-segment.js' });
  sandbox.__els = els;
  return sandbox;
}

function localSong() {
  return { type: 'local', source: 'local', localKey: VALID_KEY, localUrl: 'stellaflix-local://x', name: 'demo song', artist: 'EKKSTACY' };
}

function matchedClone() {
  return { provider: 'netease', id: 556, name: 'demo song', artist: 'EKKSTACY', localOriginKey: VALID_KEY };
}

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
}

test('isLocalPlaybackSong distinguishes local files, online clones and plain online songs', () => {
  const sb = makeSandbox();
  assert.strictEqual(sb.isLocalPlaybackSong(localSong()), true);
  assert.strictEqual(sb.isLocalPlaybackSong(matchedClone()), false);
  assert.strictEqual(sb.isLocalPlaybackSong({ provider: 'netease', id: 1 }), false);
  assert.strictEqual(sb.isLocalOriginPlaybackSong(localSong()), true);
  assert.strictEqual(sb.isLocalOriginPlaybackSong(matchedClone()), true);
  assert.strictEqual(sb.isLocalOriginPlaybackSong({ provider: 'netease', id: 1 }), false);
});

test('quality panel for a local file shows an active 本地文件 option first', () => {
  const sb = makeSandbox({
    localOnlineMatchStore: { get: () => null, matchLocalSong: async () => null },
    playQueue: [localSong()],
  });
  sb.updatePlaybackQualityUi();
  const list = sb.__els['quality-option-list'];
  assert.strictEqual(sb.__els['quality-btn-label'].textContent, '本地');
  assert.ok(list.innerHTML.startsWith('<button class="quality-option local-file active"'), 'local option must come first: ' + list.innerHTML.slice(0, 80));
  assert.ok(list.innerHTML.indexOf('data-quality="local"') > 0);
  assert.ok(list.innerHTML.indexOf('无损 SQ') > 0, 'online options still listed');
});

test('quality panel uses the matched provider options for a local file with a cached qq match', () => {
  const sb = makeSandbox({
    localOnlineMatchStore: { get: () => ({ provider: 'qq', key: 'qq:9', snapshot: {}, matchedAt: 1 }), matchLocalSong: async () => null },
    playQueue: [localSong()],
  });
  sb.updatePlaybackQualityUi();
  const list = sb.__els['quality-option-list'];
  assert.ok(list.innerHTML.indexOf('无损 FLAC') > 0, 'qq option titles expected: ' + list.innerHTML);
  assert.ok(list.innerHTML.startsWith('<button class="quality-option local-file'), 'local option must come first');
});

test('quality panel for an online clone of a local file lists local option inactive', () => {
  const clone = matchedClone();
  clone.localOriginSong = localSong();
  const sb = makeSandbox({
    localOnlineMatchStore: { get: () => ({ provider: 'netease', key: 'netease:556', snapshot: {}, matchedAt: 1 }), matchLocalSong: async () => null },
    playQueue: [clone],
  });
  sb.updatePlaybackQualityUi();
  const list = sb.__els['quality-option-list'];
  assert.ok(list.innerHTML.startsWith('<button class="quality-option local-file"'), 'local option must come first');
  assert.ok(!/local-file active/.test(list.innerHTML), 'local option must not be active while online clone plays');
});

test('setPlaybackQuality on a local file matches online and replays with qualitySwitch + resumeAt', async () => {
  const song = localSong();
  const sb = makeSandbox({
    playQueue: [song],
    localOnlineMatchStore: { get: () => null, matchLocalSong: async () => { sb.calls.match += 1; return matchedClone(); } },
  });
  sb.setPlaybackQuality('lossless');
  await settle();
  assert.strictEqual(sb.calls.match, 1);
  assert.strictEqual(sb.playQueueAt.length >= 0, true);
  assert.strictEqual(sb.calls.playQueueAt.length, 1);
  const call = sb.calls.playQueueAt[0];
  assert.strictEqual(call.idx, 0);
  assert.strictEqual(call.opts.qualityOverride, 'lossless');
  assert.strictEqual(call.opts.qualitySwitch, true);
  assert.strictEqual(call.opts.resumeAt, 42.5);
  assert.strictEqual(call.opts.preserveHomeState, true);
  assert.strictEqual(sb.playQueue[0].localOriginSong, song);
});

test('setPlaybackQuality on a local file stays on local when no online match (offline)', async () => {
  const song = localSong();
  const sb = makeSandbox({
    playQueue: [song],
    localOnlineMatchStore: { get: () => null, matchLocalSong: async () => null },
  });
  sb.setPlaybackQuality('lossless');
  await settle();
  assert.strictEqual(sb.calls.playQueueAt.length, 0);
  assert.strictEqual(sb.playQueue[0], song);
  assert.ok(sb.calls.toasts.some((t) => t.indexOf('本地') >= 0), 'expected a keep-local toast: ' + sb.calls.toasts.join(' / '));
});

test('setPlaybackQuality("local") on an online clone restores the local file and replays', async () => {
  const song = localSong();
  const clone = matchedClone();
  clone.localOriginSong = song;
  const sb = makeSandbox({
    playQueue: [clone],
    localOnlineMatchStore: { get: () => null, matchLocalSong: async () => null },
  });
  sb.setPlaybackQuality('local');
  await settle();
  assert.strictEqual(sb.playQueue[0], song);
  assert.strictEqual(sb.calls.playQueueAt.length, 1);
  assert.strictEqual(sb.calls.playQueueAt[0].opts.qualitySwitch, true);
  assert.strictEqual(sb.calls.playQueueAt[0].opts.resumeAt, 42.5);
});

test('setPlaybackQuality("local") while already on local file only toasts', async () => {
  const sb = makeSandbox({
    playQueue: [localSong()],
    localOnlineMatchStore: { get: () => null, matchLocalSong: async () => null },
  });
  sb.setPlaybackQuality('local');
  await settle();
  assert.strictEqual(sb.calls.playQueueAt.length, 0);
  assert.ok(sb.calls.toasts.some((t) => t.indexOf('本地文件') >= 0));
});

test('failed online switch restores the local queue item', async () => {
  const song = localSong();
  const sb = makeSandbox({
    playQueue: [song],
    localOnlineMatchStore: { get: () => null, matchLocalSong: async () => matchedClone() },
    playQueueAt: async () => { throw new Error('Failed to fetch'); },
  });
  sb.setPlaybackQuality('lossless');
  await settle();
  assert.strictEqual(sb.playQueue[0], song);
  assert.ok(sb.calls.toasts.some((t) => t.indexOf('本地') >= 0), 'expected fallback toast: ' + sb.calls.toasts.join(' / '));
});

test('plain online songs keep the existing quality-switch path (no local matching)', async () => {
  const sb = makeSandbox({
    playQueue: [{ provider: 'netease', id: 1, name: 'x', artist: 'y' }],
    localOnlineMatchStore: { get: () => null, matchLocalSong: async () => { sb.calls.match += 1; return null; } },
  });
  sb.setPlaybackQuality('lossless');
  await settle();
  assert.strictEqual(sb.calls.match, 0);
  assert.strictEqual(sb.calls.playQueueAt.length, 1);
  assert.strictEqual(sb.calls.playQueueAt[0].opts.qualityOverride, 'lossless');
});
