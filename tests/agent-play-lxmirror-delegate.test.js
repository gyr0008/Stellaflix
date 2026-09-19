'use strict';

/**
 * AI 助手播放通道（agent-adapter.js playLxMirrorSong）行为测试
 * 方案A：解析聚合音源后必须委托主播放通道 playQueueAt，而不是直接 audio.play()。
 * 运行：node --test tests/agent-play-lxmirror-delegate.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.join(__dirname, '..');
const adapterPath = path.join(appRoot, 'public', 'js', 'agent-adapter.js');
const source = fs.readFileSync(adapterPath, 'utf8');

const TICKET_URL = 'http://127.0.0.1:3000/api/custom-source/audio?ticket=abc123';

function makeSandbox(options) {
  options = options || {};
  const calls = { playQueueAt: [], directPlay: [], resolve: [], toasts: [] };
  const audioEl = {
    src: '',
    paused: false,
    ended: false,
    currentTime: 0,
    play() { calls.directPlay.push(this.src); this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    JSON, Math, Date, String, Number, Array, Object, Boolean, Promise, setTimeout, clearTimeout,
    Audio: function () { return audioEl; },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    calls,
  };
  sandbox.window = sandbox;
  sandbox.showToast = (m) => { calls.toasts.push(String(m)); };
  sandbox.playQueue = [];
  sandbox.currentIdx = -1;
  sandbox.trackSwitchToken = 0;
  sandbox.playing = false;
  sandbox.audio = options.audioInitiallyNull ? null : audioEl;
  const bridgeReady = options.bridgeReady !== false;
  sandbox.CustomSourceIntegration = {
    hasBridge: () => bridgeReady,
    resolveOnlinePlaybackData: async (song, ctx) => {
      calls.resolve.push(ctx);
      if (options.resolveFailure) return { override: false, reason: 'no-match' };
      return { override: true, data: { url: TICKET_URL, level: 'flac', source: '聚合解析 · 青听', sourceMatch: true } };
    },
  };
  if (!options.noPlayQueueAt) {
    sandbox.playQueueAt = async (idx, opts) => {
      calls.playQueueAt.push({ idx, opts });
      return options.playQueueAtResult !== undefined ? options.playQueueAtResult : true;
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'agent-adapter.js' });
  sandbox.__audioEl = audioEl;
  return sandbox;
}

const song = { name: '东风破', artist: '周杰伦', id: 123, provider: 'netease', type: 'song' };

test('playLxMirrorSong delegates to playQueueAt with the pre-resolved aggregate url', async () => {
  const sb = makeSandbox();
  const result = await sb.window.playLxMirrorSong(0, 0, song);
  assert.strictEqual(sb.calls.playQueueAt.length, 1, 'must call playQueueAt exactly once');
  const [call] = sb.calls.playQueueAt;
  assert.strictEqual(call.idx, 0);
  assert.strictEqual(call.opts.manual, true);
  assert.ok(call.opts.preResolvedPlaybackData, 'must pass preResolvedPlaybackData so aggregate is not re-run');
  assert.strictEqual(call.opts.preResolvedPlaybackData.url, TICKET_URL);
  assert.strictEqual(result.ok, true);
});

test('playLxMirrorSong never calls audio.play() directly — main channel owns playback', async () => {
  const sb = makeSandbox();
  await sb.window.playLxMirrorSong(0, 0, song);
  assert.strictEqual(sb.calls.directPlay.length, 0, 'direct audio.play() bypasses queueItemKey/token guards — forbidden');
});

test('playLxMirrorSong queues the song so playQueue state matches the delegated index', async () => {
  const sb = makeSandbox();
  await sb.window.playLxMirrorSong(0, 0, song);
  assert.strictEqual(sb.window.playQueue.length, 1);
  assert.strictEqual(sb.window.playQueue[0], song);
  assert.strictEqual(sb.window.currentIdx, 0);
});

test('playLxMirrorSong reports failure when playQueueAt returns false', async () => {
  const sb = makeSandbox({ playQueueAtResult: false });
  const result = await sb.window.playLxMirrorSong(0, 0, song);
  assert.strictEqual(result.ok, false);
});

test('playLxMirrorSong reports PLAYER_NOT_READY without touching audio when playQueueAt is missing', async () => {
  const sb = makeSandbox({ noPlayQueueAt: true });
  const result = await sb.window.playLxMirrorSong(0, 0, song);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'PLAYER_NOT_READY');
  assert.strictEqual(sb.calls.directPlay.length, 0);
});

test('playLxMirrorSong still reports resolve failure without delegating', async () => {
  const sb = makeSandbox({ resolveFailure: true });
  const result = await sb.window.playLxMirrorSong(0, 0, song);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no-match');
  assert.strictEqual(sb.calls.playQueueAt.length, 0);
});

test('playLxMirrorSong keeps aggregate pre-resolve semantics for the tool result', async () => {
  const sb = makeSandbox();
  const result = await sb.window.playLxMirrorSong(0, 0, song);
  assert.strictEqual(sb.calls.resolve.length, 1);
  assert.strictEqual(sb.calls.resolve[0].mode, 'aggregate');
  assert.strictEqual(sb.calls.resolve[0].preResolve, true);
  assert.strictEqual(result.url, TICKET_URL);
});
