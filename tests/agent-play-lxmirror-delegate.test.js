'use strict';

/**
 * AI 助手播放通道（agent-adapter.js playLxMirrorSong）行为测试（T9 阶段2切换后契约）。
 * LX 镜像播放入口不再依赖已退役的第三方音源桥：直接委托主播放通道 playQueueAt
 * （其内部统一走 /api/lx-source/resolve 三级失败链）；不直连 audio.play()、不做聚合预解析。
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

function makeSandbox(options) {
  options = options || {};
  const calls = { playQueueAt: [], directPlay: [], toasts: [] };
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
  if (!options.noPlayQueueAt) {
    sandbox.playQueueAt = async (idx, opts) => {
      calls.playQueueAt.push({ idx, opts });
      if (typeof options.onPlayQueueAt === 'function') options.onPlayQueueAt(sandbox.playQueue[idx]);
      return options.playQueueAtResult !== undefined ? options.playQueueAtResult : true;
    };
  }
  if (options.playLxMirrorThrows) {
    sandbox.playQueueAt = async () => { throw new Error('chain terminal guidance'); };
  }
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'agent-adapter.js' });
  sandbox.__audioEl = audioEl;
  return sandbox;
}

const song = { name: '东风破', artist: '周杰伦', id: 123, source: 'wy', provider: 'wy', type: 'song' };

test('T9：playLxMirrorSong 源码不再引用 CustomSourceIntegration（第三方音源桥退役边）', () => {
  assert.ok(!source.includes('CustomSourceIntegration'), 'agent-adapter 不得再引用 CustomSourceIntegration');
  assert.ok(!source.includes('resolveOnlinePlaybackData'), '不得再走聚合预解析');
});

test('T9：playLxMirrorSong 直接委托 playQueueAt（统一播放链），不预解析', async () => {
  const sb = makeSandbox();
  const result = await sb.window.playLxMirrorSong(0, 0, song);
  assert.strictEqual(sb.calls.playQueueAt.length, 1, '必须恰好调用一次 playQueueAt');
  const [call] = sb.calls.playQueueAt;
  assert.strictEqual(call.idx, 0);
  assert.strictEqual(call.opts.manual, true);
  assert.ok(!call.opts.preResolvedPlaybackData, '不再传 preResolvedPlaybackData——解析由三级链完成');
  assert.strictEqual(result.ok, true);
});

test('T9：playLxMirrorSong 绝不直连 audio.play()——主通道独占播放', async () => {
  const sb = makeSandbox();
  await sb.window.playLxMirrorSong(0, 0, song);
  assert.strictEqual(sb.calls.directPlay.length, 0, '直连 play() 会漏写 queueItemKey/token 守卫——禁止');
});

test('T9：playLxMirrorSong 入队的是歌曲副本且队列索引一致（链内字段改写不污染调用方对象）', async () => {
  const sb = makeSandbox({
    onPlayQueueAt: (queued) => { queued._lxResolver = 'B'; queued.source = 'tx'; },
  });
  await sb.window.playLxMirrorSong(0, 0, song);
  assert.strictEqual(sb.window.playQueue.length, 1);
  assert.notStrictEqual(sb.window.playQueue[0], song, '必须拷贝入队，链内改写不回传调用方 song');
  assert.strictEqual(sb.window.playQueue[0].name, song.name);
  assert.strictEqual(sb.window.currentIdx, 0);
  assert.strictEqual(song._lxResolver, undefined, '原对象不受链内状态字段影响');
});

test('T9：playQueueAt 返回 false → PLAYBACK_FAILED', async () => {
  const sb = makeSandbox({ playQueueAtResult: false });
  const result = await sb.window.playLxMirrorSong(0, 0, song);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'PLAYBACK_FAILED');
});

test('T9：playQueueAt 缺失 → PLAYER_NOT_READY，不触碰音频', async () => {
  const sb = makeSandbox({ noPlayQueueAt: true });
  const result = await sb.window.playLxMirrorSong(0, 0, song);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'PLAYER_NOT_READY');
  assert.strictEqual(sb.calls.directPlay.length, 0);
});

test('T9：无歌曲信息 → NO_SONG', async () => {
  const sb = makeSandbox();
  const result = await sb.window.playLxMirrorSong(0, 0, null);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'NO_SONG');
  assert.strictEqual(sb.calls.playQueueAt.length, 0);
});

test('T9：成功后 source 取链内写回的标签（resolvedSourceLabel/sourceLabel 优先）', async () => {
  const sb = makeSandbox({
    onPlayQueueAt: (queued) => { queued.resolvedSourceLabel = '小秋（跨平台自动换源）'; },
  });
  const result = await sb.window.playLxMirrorSong(0, 0, song);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.source, '小秋（跨平台自动换源）');
});

test('T9：链抛终态错误 → PLAYBACK_FAILED 且 toast 带出引导文案', async () => {
  const sb = makeSandbox({ playLxMirrorThrows: true });
  const result = await sb.window.playLxMirrorSong(0, 0, song);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'PLAYBACK_FAILED');
  assert.ok(sb.calls.toasts.some((t) => t.includes('chain terminal guidance')), '异常文案必须经 toast 呈现');
});
