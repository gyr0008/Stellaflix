'use strict';

/**
 * tests/lx-quality-vocabulary.test.js — 批 T12：播放音质词汇统一 LX 五档 + VIP 门槛退役 + probeWarning 态
 *
 * 手法：沿用 tests/local-quality-switch-branch.test.js 的 vm 片段 harness——把
 * 00-api-quality-output.js 的 `normalizePlaybackQuality … toggleQualityPanel` 片段
 * 拼进 vm 上下文执行（依赖全部走沙箱 fixture 注入）；00-core-stores.js 的重写产物
 * （PLAYBACK_QUALITY_OPTIONS / PLAYBACK_QUALITY_DEFAULTS）与 08-account 的
 * hasProviderSvip 门槛函数用源码切片 + vm 求值；13 的 probeWarning→pill 接线与
 * 门槛退役用源码静态钉桩（参考 lx-playback-chain 尾部静态断言惯例）。
 *
 * 覆盖（brief Step 1 四件套）：
 *  ①词汇表：jymaster/hires/lossless/exhigh/standard → LX master/flac24bit/flac/320k/128k
 *    （normalizePlaybackQuality / rank / provider 直通，旧持久化值经词汇表迁移不炸）；
 *  ②provider-VIP 门槛退役：hasProviderSvip 恒通过（不再按 cookie 判定），
 *    setPlaybackQuality('master') 无 SVIP 也不再拦截/不开登录；
 *  ③canReloadCurrentTrackForQuality provider 白名单退役（lx-custom-source 可重载）；
 *  ④probeWarning 驱动 pill tooltip「在线音源按平台能力自动降级」（上游 index.html:23228）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const P_00 = 'public/js/modules/05-playback/00-api-quality-output.js';
const P_STORES = 'public/js/modules/00-state/00-core-stores.js';
const P_13 = 'public/js/modules/05-playback/13-playback-start-audio.js';

const LX_TIERS = ['master', 'flac24bit', 'flac', '320k', '128k'];

function sliceBetween(text, startMarker, endMarker, label) {
  const s = text.indexOf(startMarker);
  assert.notStrictEqual(s, -1, 'start marker missing in ' + label + ': ' + startMarker);
  const e = text.indexOf(endMarker, s);
  assert.notStrictEqual(e, -1, 'end marker missing in ' + label + ': ' + endMarker);
  return text.slice(s, e);
}

// ---------- 00 行为沙箱（词汇函数 + 面板/门槛/重载/pill） ----------

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
  const calls = { toasts: [], notices: [], playQueueAt: [], prefSaves: [] };
  const sandbox = Object.assign({
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Promise, setTimeout, clearTimeout, encodeURIComponent, AbortController,
    calls,
    document: {
      getElementById: fakeEl,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ set textContent(v) { this._t = v; }, get innerHTML() { return String(this._t || ''); } }),
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    escHtml: (v) => String(v == null ? '' : v),
    showToast: (msg) => { calls.toasts.push(String(msg)); },
    showSourceFallbackNotice: (t, b) => { calls.notices.push({ title: t, body: b }); },
    forcePlaybackControlsInteractive: () => {},
    hasProviderSvip: () => false,
    hasPlatformLogin: () => false,
    songProviderKey: (song) => (song && (song.provider || song.source)) || 'netease',
    playQueueAt: async (idx, opts) => { calls.playQueueAt.push({ idx, opts }); return true; },
    invalidateLxResolvedAudioCache: () => {},
    PLAYBACK_QUALITY_OPTIONS: {
      netease: [
        { key: 'master', title: '超清母带', sub: 'Master / 最高规格' },
        { key: 'flac24bit', title: 'Hi-Res FLAC', sub: '24bit FLAC' },
        { key: 'flac', title: '无损', sub: 'FLAC 无损' },
        { key: '320k', title: '极高', sub: '320kbps' },
        { key: '128k', title: '标准', sub: '128kbps' },
      ],
      qq: [
        { key: 'master', title: '超清母带', sub: 'Master / 最高规格' },
        { key: 'flac24bit', title: 'Hi-Res FLAC', sub: '24bit FLAC' },
        { key: 'flac', title: '无损', sub: 'FLAC 无损' },
        { key: '320k', title: '极高', sub: '320kbps' },
        { key: '128k', title: '标准', sub: '128kbps' },
      ],
      kugou: [{ key: 'flac', title: '无损', sub: 'FLAC 无损' }],
      qishui: [{ key: '128k', title: '标准', sub: '128kbps' }],
      spotify: [{ key: '128k', title: '标准', sub: '128kbps' }],
      'lx-custom-source': [
        { key: 'master', title: '超清母带', sub: 'Master / 最高规格' },
        { key: 'flac24bit', title: 'Hi-Res FLAC', sub: '24bit FLAC' },
        { key: 'flac', title: '无损', sub: 'FLAC 无损' },
        { key: '320k', title: '极高', sub: '320kbps' },
        { key: '128k', title: '标准', sub: '128kbps' },
      ],
    },
    PLAYBACK_QUALITY_DEFAULTS: { netease: 'flac24bit', qq: 'flac', kugou: 'flac', qishui: '128k', spotify: '128k', 'lx-custom-source': 'flac24bit' },
    PLAYBACK_QUALITY_STORE_KEY: 'stellaflix-playback-quality-v1',
    playbackQualityPrefs: {},
    playbackQualityRuntimeCaps: {},
    playbackQuality: 'flac24bit',
    loginStatus: {},
    currentIdx: 0,
    playQueue: [],
    audio: null,
  }, overrides || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const source00 = read(P_00);
  const SEGMENT = sliceBetween(source00, 'function normalizePlaybackQuality(', 'function toggleQualityPanel', P_00);
  vm.runInContext(SEGMENT, sandbox, { filename: 'lx-quality-vocabulary-segment.js' });
  sandbox.__els = els;
  return sandbox;
}

// ---------- ① 词汇映射：旧词 → LX 五档 ----------

test('T12①：normalizePlaybackQuality 旧词映射到 LX 五档（master/flac24bit/flac/320k/128k）', () => {
  const sb = makeSandbox();
  assert.equal(sb.normalizePlaybackQuality('jymaster'), 'master');
  assert.equal(sb.normalizePlaybackQuality('hires'), 'flac24bit');
  assert.equal(sb.normalizePlaybackQuality('lossless'), 'flac');
  assert.equal(sb.normalizePlaybackQuality('exhigh'), '320k');
  assert.equal(sb.normalizePlaybackQuality('standard'), '128k');
  // LX 词自身直通（协议词汇即内部键）
  LX_TIERS.forEach((tier) => {
    assert.equal(sb.normalizePlaybackQuality(tier), tier, 'LX 词汇必须直通: ' + tier);
  });
  // 旧同义别名继续兼容
  assert.equal(sb.normalizePlaybackQuality('svip'), 'master');
  assert.equal(sb.normalizePlaybackQuality('hi-res'), 'flac24bit');
  assert.equal(sb.normalizePlaybackQuality('sq'), 'flac');
  assert.equal(sb.normalizePlaybackQuality('hq'), '320k');
  assert.equal(sb.normalizePlaybackQuality('std'), '128k');
  // 未识别值回退最高可用默认档（原 hires 档语义 → LX flac24bit）
  assert.equal(sb.normalizePlaybackQuality('nonsense'), 'flac24bit');
  // provider 直通：qq 母带降级钳制随 VIP 门槛一起退役（脚本源供 URL，能力由降级链兜底）
  assert.equal(sb.normalizePlaybackQualityForProvider('master', 'qq'), 'master');
  assert.equal(sb.normalizePlaybackQualityForProvider('jymaster', 'qq'), 'master');
});

test('T12①：rank/降级判定/标签按 LX 五档单调', () => {
  const sb = makeSandbox();
  assert.ok(sb.playbackQualityRank('master') > sb.playbackQualityRank('flac24bit'));
  assert.ok(sb.playbackQualityRank('flac24bit') > sb.playbackQualityRank('flac'));
  assert.ok(sb.playbackQualityRank('flac') > sb.playbackQualityRank('320k'));
  assert.ok(sb.playbackQualityRank('320k') > sb.playbackQualityRank('128k'));
  assert.equal(sb.playbackQualityRank('jymaster'), sb.playbackQualityRank('master'), '旧词与新词同秩（词汇表迁移等价）');
  assert.equal(sb.playbackQualityWasDowngraded('master', 'flac'), true);
  assert.equal(sb.playbackQualityWasDowngraded('flac', 'master'), false);
  assert.equal(sb.playbackQualityLabel('master', 'netease'), '超清母带');
  assert.equal(sb.playbackQualityLabel('jymaster', 'netease'), '超清母带', '旧词经词汇表命中同一标签');
  assert.equal(sb.playbackQualityLabel('flac', 'qq'), '无损 FLAC');
});

test('T12①：旧持久化偏好经词汇表迁移（localStorage 旧值不炸档）', () => {
  const legacyJson = {
    netease: 'jymaster',
    qq: 'lossless',
    kugou: 'exhigh',
    qishui: 'standard',
    spotify: 'standard',
  };
  const sb = makeSandbox({
    localStorage: {
      getItem: () => JSON.stringify(legacyJson),
      setItem: () => {},
      removeItem: () => {},
    },
  });
  const prefs = sb.readPlaybackQualityPreference();
  assert.equal(prefs.netease, 'master');
  assert.equal(prefs.qq, 'flac');
  assert.equal(prefs.kugou, '320k');
  assert.equal(prefs.qishui, '128k');
  // 裸字符串旧值（v0 形态）
  const sb2 = makeSandbox({ localStorage: { getItem: () => 'exhigh', setItem: () => {}, removeItem: () => {} } });
  assert.equal(sb2.readPlaybackQualityPreference().netease, '320k');
});

test('T12①：PLAYBACK_QUALITY_OPTIONS 重写为 LX 五档（求值 00-core-stores.js 声明块）', () => {
  const stores = read(P_STORES);
  const blockText = sliceBetween(stores, 'var LX_PLAYBACK_QUALITY_TIERS', 'var UPLOAD_TIP_STORE_KEY', P_STORES);
  const ctx = vm.runInNewContext(blockText + '\n({ PLAYBACK_QUALITY_OPTIONS, PLAYBACK_QUALITY_DEFAULTS });', {});
  const options = ctx.PLAYBACK_QUALITY_OPTIONS;
  const defaults = ctx.PLAYBACK_QUALITY_DEFAULTS;
  ['netease', 'qq', 'kugou', 'qishui', 'spotify', 'lx-custom-source'].forEach((provider) => {
    assert.ok(Array.isArray(options[provider]), 'provider 档位表存在: ' + provider);
    const keys = options[provider].map((item) => item.key);
    // vm 上下文产物跨 realm，deepStrictEqual 会比原型——用 join 比较值。
    assert.equal(keys.join(','), LX_TIERS.join(','), '词汇统一：' + provider + ' 档 = LX 五档');
    options[provider].forEach((item) => {
      assert.ok(!item.svip, 'VIP 锁定标记退役：档位不得再含 svip 标志');
    });
  });
  Object.keys(defaults).forEach((provider) => {
    assert.ok(LX_TIERS.includes(defaults[provider]), '默认值必须是 LX 词汇: ' + provider + '=' + defaults[provider]);
  });
});

// ---------- ② provider-VIP 门槛恒通过 ----------

test('T12②：setPlaybackQuality("master") 不再被 SVIP 门槛拦截、不开登录弹窗', () => {
  const sb = makeSandbox({
    playQueue: [{ provider: 'netease', id: 1, name: 'x', artist: 'y' }],
    currentIdx: 0,
  });
  sb.setPlaybackQuality('master');
  assert.equal(sb.playbackQualityPrefs.netease, 'master', '母带档直接落偏好');
  assert.ok(!sb.calls.toasts.some((t) => t.includes('SVIP')), '不得出现 SVIP 拦截 toast: ' + sb.calls.toasts.join(' / '));
});

// ---------- ③ canReloadCurrentTrackForQuality 白名单退役 ----------

test('T12③：canReloadCurrentTrackForQuality 不再按 provider 白名单拦截', () => {
  const sb = makeSandbox({
    playQueue: [{ source: 'lx-custom-source', id: 'lx-1', name: 'n', artist: 'a' }],
    currentIdx: 0,
    audio: { src: 'https://play.example/x', paused: false, ended: false, currentTime: 1 },
  });
  assert.equal(sb.canReloadCurrentTrackForQuality(), true, '脚本源在线曲目必须可音质重载（旧白名单只放 netease/qq/kugou）');
  sb.playQueue = [{ source: 'wy', id: '1', name: 'n', artist: 'a' }];
  assert.equal(sb.canReloadCurrentTrackForQuality(), true, 'wy 源名同样放行');
  sb.playQueue = [{ source: 'local', id: '1' }];
  assert.equal(sb.canReloadCurrentTrackForQuality(), false, '本地文件仍走短路（保留意图）');
  sb.playQueue = [{ source: 'wy', id: '1' }];
  sb.audio = null;
  assert.equal(sb.canReloadCurrentTrackForQuality(), false, '未在播则不重载（保留意图）');
});

// ---------- ④ probeWarning 驱动 pill tooltip ----------

test('T12④：song.lxProbeWarning 置位时 pill tooltip 带「在线音源按平台能力自动降级」', () => {
  const sb = makeSandbox({
    playQueue: [{ provider: 'netease', id: 1, name: 'x', artist: 'y', lxProbeWarning: true }],
    playbackQualityPrefs: { netease: 'master' },
  });
  sb.updatePlaybackQualityUi();
  const btn = sb.__els['quality-btn'];
  assert.ok(btn.title.includes('在线音源按平台能力自动降级'), 'probeWarning 态必须提示自动降级: ' + btn.title);
  // 无 probeWarning 不挂降级文案
  const clean = makeSandbox({
    playQueue: [{ provider: 'netease', id: 2, name: 'x', artist: 'y' }],
    playbackQualityPrefs: { netease: 'master' },
  });
  clean.updatePlaybackQualityUi();
  assert.ok(!clean.__els['quality-btn'].title.includes('自动降级'), '无 probeWarning 不得挂降级文案');
});

test('T12④：13 起播消费 resolve probeWarning → song.lxProbeWarning（静态钉桩接线）', () => {
  const src13 = read(P_13);
  assert.ok(src13.includes('lxProbeWarning: !!lxResolved.probeWarning'), 'resolve 结果 probeWarning 已在 data 上（T9/T10 既有）');
  assert.ok(/song\.lxProbeWarning\s*=/.test(src13), '播放链必须把 data.lxProbeWarning 落到 song 供 pill tooltip 消费');
  // VIP 门槛退役（13 侧）：不再存在 jymaster×SVIP cookie 降级行
  assert.ok(!src13.includes("requestedQuality === 'jymaster'"), '13 的 jymaster SVIP 降级行必须退役');
  assert.ok(!src13.includes("hasProviderSvip('netease'"), '13 不再调用 SVIP 门槛');
});

test('T12④：00 面板不再渲染 SVIP 锁定/登录引导（静态钉桩）', () => {
  const src00 = read(P_00);
  assert.ok(!src00.includes('超清母带需网易云 SVIP'), 'pill 不再挂 SVIP 提示');
  assert.ok(!src00.includes('需要网易云 SVIP 账号'), '档位不再锁定');
  assert.ok(!src00.includes("hasProviderSvip('netease'"), '00 不再调用 SVIP 门槛');
  assert.ok(!src00.includes('svip-only'), 'svip-only 样式类退役');
});
