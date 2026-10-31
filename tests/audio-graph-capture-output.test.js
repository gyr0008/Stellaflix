'use strict';

// captureStream 兜底支路改为「图形真出声」的契约测试。
// 参照内核取证（Electron 42.4.1 / Chromium 148）：
//   1) captureStream 出来的音轨不受 <audio>.muted / .volume 影响（静音后 RMS 不变）；
//   2) createMediaElementSource 支路的元素音量会乘进图形（0.25 → RMS 0.0883，静音 → 0）。
// 所以兜底支路必须把主元素静音、让图形独占出声，且音量律与常规支路不同（图形吃全量，不做 sqrt 拆分）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const graphModulePath = path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '08-audio-graph-controls.js');
const outputModulePath = path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '00-api-quality-output.js');
const coreStorePath = path.join(__dirname, '..', 'public', 'js', 'modules', '00-state', '00-core-stores.js');

function readSource(file) {
  return fs.readFileSync(file, 'utf8');
}

function extractFunction(sourceText, functionName) {
  let start = sourceText.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `missing ${functionName}`);
  if (sourceText.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const bodyStart = sourceText.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `missing body for ${functionName}`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    const next = sourceText[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return sourceText.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated function ${functionName}`);
}

function makeParam(initial) {
  const param = {
    value: initial == null ? 1 : initial,
    cancelScheduledValues() {},
    cancelAndHoldAtTime() {},
    setValueAtTime(value) {
      param.value = value;
    },
    linearRampToValueAtTime(value) {
      param.value = value;
    },
  };
  return param;
}

function makeGraphHarness(options) {
  options = options || {};
  const nodes = [];
  function makeNode(kind) {
    const node = {
      kind,
      connections: [],
      disconnectCount: 0,
      connect(target) {
        this.connections.push(target);
      },
      disconnect() {
        this.disconnectCount += 1;
      },
    };
    nodes.push(node);
    return node;
  }
  const destination = makeNode('destination');
  const audioContext = {
    state: 'running',
    currentTime: 0,
    destination,
    createMediaElementSource() {
      return makeNode('media-element');
    },
    createMediaStreamSource(stream) {
      assert.ok(stream && stream.id, 'capture stream missing');
      return makeNode('capture');
    },
    createAnalyser() {
      const node = makeNode('analyser');
      node.fftSize = 0;
      node.smoothingTimeConstant = 0;
      node.getByteTimeDomainData = (target) => target.fill(128);
      node.getByteFrequencyData = (target) => target.fill(0);
      return node;
    },
    createGain() {
      const node = makeNode('gain');
      node.gain = makeParam(1);
      return node;
    },
  };
  destination.context = audioContext;
  const audio = {
    src: 'https://local.invalid/audio?id=alpha',
    currentSrc: 'https://local.invalid/audio?id=alpha',
    readyState: 4,
    paused: false,
    muted: false,
    volume: 1,
    playbackRate: 1,
    currentTime: 1.5,
    duration: 200,
    pause() {},
    captureStream() {
      return { id: 'capture-alpha' };
    },
    addEventListener() {},
    // 生产里这条支路由 rebuildPlaybackGraphWithCapture() 置位后调 initAudio()，照它的样子进入兜底。
    __stellaflixForceCaptureSource: !!options.captureBranch,
  };
  const context = vm.createContext({
    audio,
    audioCtx: null,
    source: null,
    audioSourceMedia: null,
    analyser: null,
    beatAnalyser: null,
    gainNode: null,
    replayGainNode: null,
    // 兜底支路旧的「只读分析静音坑」。重构后源码不再引用它，这里留一个 undefined 让断言能分辨。
    analysisSinkNode: undefined,
    audioReady: false,
    audioFadeEnvelope: 1,
    targetVolume: options.targetVolume == null ? 1 : options.targetVolume,
    AUDIO_SILENCE_GAIN: 0.0001,
    replayGainActive: { linear: 1 },
    FFT_SIZE: 2048,
    BEAT_FFT_SIZE: 512,
    frequencyData: new Uint8Array(1024),
    beatFrequencyData: new Uint8Array(256),
    beatTimeDomainData: new Uint8Array(512),
    timeDomainData: new Uint8Array(2048),
    clampRange: (value, min, max) => Math.min(max, Math.max(min, value)),
    window: { AudioContext: function Ctor() { return audioContext; }, webkitAudioContext: null },
    AudioContext: function Ctor() { return audioContext; },
    Audio: function Ctor() {
      return audio;
    },
    setReplayGainNodeGain() {},
    applyAudioOutputDevice() {},
    bindPlaybackProgressEvents() {},
    resetRealtimeBeatEngine() {},
    clearAudioFadeTimers() {},
    console: { log() {}, warn() {}, error() {} },
    setTimeout() { return 0; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    isFinite,
    Math,
    Number,
    Object,
    Promise,
  });
  const graphSource = readSource(graphModulePath);
  const executable = [
    'audioGraphHealthy',
    'disconnectAudioGraphNodes',
    'initAudio',
    'currentAudioOutputGain',
    'audioSilentFloor',
    'normalizeAudioFadeTarget',
    'audioGraphRunsOutput',
    'writeAudioOutputGain',
    'applyVolumeToAudio',
    'setAudioOutputGainImmediate',
  ].map((name) => extractFunction(graphSource, name)).join('\n\n');
  vm.runInContext(executable, context, { filename: graphModulePath });
  return { context, audio, audioContext, destination, nodes };
}

function gainNodes(harness) {
  return harness.nodes.filter((node) => node.kind === 'gain');
}

// 沿 connect 边走图，判断某个节点是否真的能出声到 destination。
function reachesDestination(node) {
  const seen = new Set();
  const queue = [node];
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (current.kind === 'destination') return true;
    (current.connections || []).forEach((next) => queue.push(next));
  }
  return false;
}

/**
 * 兜底支路（captureStream）必须让图形成为唯一出声路径。
 * @returns {void}
 */
function testCaptureBranchGraphIsAudiblePath() {
  const harness = makeGraphHarness({ captureBranch: true });
  assert.equal(harness.context.initAudio(), true, 'capture 兜底支路没能建图');
  const { context, audio, nodes } = harness;

  assert.equal(context.source.__stellaflixUsesCapture, true, '本用例没有走到 captureStream 兜底支路');
  assert.ok(context.gainNode, '兜底支路仍然没有 gainNode，图形出声无处落脚');
  assert.equal(nodes.filter((node) => node.kind === 'analyser').length, 2, '频谱与节拍分析器应当各挂一路');

  // 出声链：source → analyser → replayGainNode → gainNode → destination
  assert.ok(context.analyser.connections.includes(context.replayGainNode), 'analyser 没有接进均衡节点');
  assert.ok(context.replayGainNode.connections.includes(context.gainNode), '均衡节点没有接进音量节点');
  assert.ok(context.gainNode.connections.includes(harness.destination), '音量节点没有接进 destination');
  assert.ok(reachesDestination(context.replayGainNode), 'ReplayGain 不在出声链上，兜底支路依旧听不到均衡');

  // 图形独占出声 ⇒ 主元素必须静音，否则双份声音且不衰减。
  assert.equal(audio.muted, true, '兜底支路图形出声后主元素仍未静音');
  assert.equal(gainNodes(harness).length, 2, '兜底支路不该再建 analysisSinkNode 静音坑（音量+均衡之外的增益）');
}

/**
 * 常规支路（MediaElementSource）保持原有图形语义：元素不出声之外仍走 sqrt 分摊。
 * @returns {void}
 */
function testMediaElementBranchStaysUnmuted() {
  const harness = makeGraphHarness({});
  assert.equal(harness.context.initAudio(), true);
  assert.equal(harness.context.source.__stellaflixUsesCapture, false, '本用例没建在常规支路上');
  assert.equal(harness.audio.muted, false, '常规支路把主元素静音了，会出现双份声音或音量律错乱');
  assert.ok(reachesDestination(harness.context.replayGainNode));
}

/**
 * 两支路的音量律不同：兜底支路图形吃全量，常规支路按 sqrt 分摊到元素与图形。
 * @returns {void}
 */
function testVolumeLawIsBranchDependent() {
  const capture = makeGraphHarness({ captureBranch: true, targetVolume: 0.25 });
  assert.equal(capture.context.initAudio(), true);
  capture.context.setAudioOutputGainImmediate(0.25);
  assert.ok(Math.abs(capture.context.gainNode.gain.value - 0.25) < 1e-9, '兜底支路图形应独占全量音量（元素已静音，不再 sqrt 拆分）');

  const normal = makeGraphHarness({ targetVolume: 0.25 });
  assert.equal(normal.context.initAudio(), true);
  normal.context.setAudioOutputGainImmediate(0.25);
  assert.ok(Math.abs(normal.context.gainNode.gain.value - 0.5) < 1e-9, '常规支路的 sqrt 分摊被改坏了');
  assert.ok(Math.abs(normal.audio.volume - 0.5) < 1e-9);
}

/**
 * 图没了（建图失败或已拆图）就必须把出声权还给元素，不能留着一个静音的哑巴播放器。
 * @returns {void}
 */
function testGainWriteWithoutGraphReturnsAudioToElement() {
  const harness = makeGraphHarness({ captureBranch: true, targetVolume: 0.6 });
  assert.equal(harness.context.initAudio(), true);
  assert.equal(harness.audio.muted, true);
  harness.context.disconnectAudioGraphNodes(false);
  assert.equal(harness.audio.muted, false, '拆掉图形后主元素仍静音，用户会彻底听不到声音');

  harness.context.setAudioOutputGainImmediate(0.6);
  assert.equal(harness.audio.muted, false);
  assert.ok(Math.abs(harness.audio.volume - 0.6) < 1e-9, '无图时元素要吃到全量音量');
}

/**
 * 多设备镜像播放器不能继承主元素的静音，否则兜底支路上副设备全部哑掉。
 * @returns {void}
 */
function testMirrorSinksIgnoreElementMute() {
  const outputSource = readSource(outputModulePath);
  const mirrors = {
    'sink-beta': {
      _stellaflixSinkId: 'sink-beta',
      _stellaflixSinkReady: true,
      _stellaflixSinkBusy: false,
      src: 'https://local.invalid/audio?id=alpha',
      currentSrc: 'https://local.invalid/audio?id=alpha',
      // 镜像元素天生是出声的（new Audio() 默认未静音）；这里断言它别被主元素的图形静音带下水。
      muted: false,
      volume: 0.5,
      paused: false,
      ended: false,
      playbackRate: 1,
      currentTime: 1.5,
      load() {},
      play() {},
      pause() {},
      setSinkId() { return Promise.resolve(); },
    },
  };
  const context = vm.createContext({
    audio: { muted: true, volume: 1, currentSrc: 'https://local.invalid/audio?id=alpha', src: '', paused: false, ended: false, currentTime: 1.5, playbackRate: 1 },
    audioOutputMirrorDeviceIds: ['sink-beta'],
    audioOutputDeviceId: '',
    audioOutputMirrorElements: mirrors,
    audioOutputMirrorRuntime: { 'sink-beta': { state: 'playing' } },
    audioOutputMirrorSyncTimer: 1,
    normalizeAudioOutputIdList: (ids) => ids.slice(),
    audioOutputMirrorSinkSupported: () => true,
    audioOutputMirrorRuntimeFor: (id) => context.audioOutputMirrorRuntime[id],
    markAudioOutputMirrorRuntime() {},
    clearAudioOutputMirrors() {},
    removeAudioOutputMirror() {},
    applyAudioOutputMirrorSink: () => Promise.resolve(true),
    audioOutputMirrorReadableError: () => '',
    currentAudioOutputGain: () => 0.25,
    setInterval: () => 0,
    clearInterval() {},
    isFinite,
    Math,
    Number,
    Object,
    Promise,
    Audio: function Ctor() { return {}; },
    console: { log() {}, warn() {}, error() {} },
  });
  vm.runInContext(extractFunction(outputSource, 'syncAudioOutputMirrors'), context, { filename: outputModulePath });
  context.syncAudioOutputMirrors('test-mirror-mute');

  assert.equal(mirrors['sink-beta'].muted, false, '副设备镜像继承了主元素静音，兜底支路上第二块设备会没声');
  assert.ok(Math.abs(mirrors['sink-beta'].volume - 0.25) < 1e-9, '副设备要用有效出声音量，而不是被图形分摊过的元素音量');
}

/**
 * 静音分析坑已经随「图形真出声」一起退休，源码里不该再留着这条死支路。
 * @returns {void}
 */
function testAnalysisSinkNodeRetired() {
  const graphSource = readSource(graphModulePath);
  const coreSource = readSource(coreStorePath);
  assert.doesNotMatch(graphSource, /analysisSinkNode/, '08-audio-graph-controls.js 还留着 analysisSinkNode');
  assert.doesNotMatch(coreSource, /analysisSinkNode/, '00-core-stores.js 还声明着 analysisSinkNode');
  const harness = makeGraphHarness({ captureBranch: true });
  assert.equal(harness.context.initAudio(), true);
  assert.equal(harness.context.analysisSinkNode, undefined, '兜底支路仍在建只读分析用的静音增益节点');
}

const tests = {
  testCaptureBranchGraphIsAudiblePath,
  testMediaElementBranchStaysUnmuted,
  testVolumeLawIsBranchDependent,
  testGainWriteWithoutGraphReturnsAudioToElement,
  testMirrorSinksIgnoreElementMute,
  testAnalysisSinkNodeRetired,
};

const names = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const queue = names.length ? names : Object.keys(tests);
(async function run() {
  for (const name of queue) {
    const fn = tests[name];
    assert.ok(fn, `unknown test ${name}`);
    await fn();
    console.log(`ok - ${name}`);
  }
})().catch((error) => {
  console.error(`FAIL ${error && (error.message || error)}`);
  process.exitCode = 1;
});
