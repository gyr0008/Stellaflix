/**
 * N2（2026-10-04 奈飞工厂解析失败事故）：解析失败/超时不得把 HTML 播放页地址喂给播放器。
 *
 * 背景：mpv 报 MEDIA_ERROR_SRC_NOT_SUPPORTED / FFmpegDemuxer open context failed
 * 的源头是 https://netflixgc.org/vodplay/12024-6-1.html —— 一个 HTML 页面地址。
 * resolvePlayUrl 返回 null 的分支已有「仅媒体地址才降级直连」的门闸，
 * 但 30s 超时分支仍是无条件 doPlay(ep.url) —— 该分支把 HTML 页直喂了 mpv。
 * 契约：超时与失败共用同一门闸；非媒体地址超时 → 明确报错 + 换源信号，不起播。
 */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadOrchestrator(kazumi) {
  const timers = [];
  const sandbox = {
    console,
    Promise,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cancelled: false }); return timers.length; },
    clearTimeout: (id) => { if (id && timers[id - 1]) timers[id - 1].cancelled = true; },
    localStorage: { getItem: () => null, setItem: () => {} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/video/play-orchestrator.js'), 'utf8'), sandbox);
  const SFV = sandbox.StellaflixVideo;
  SFV.kazumi = kazumi;
  const opened = [];
  SFV.source = { open: (meta) => { opened.push(meta.url); return true; } };
  const toasts = [];
  const failArgs = [];
  SFV.detailSource = { failPlaybackSwitch: (m) => { failArgs.push(m); } };
  SFV.playOrchestrator.init({
    toast: (m) => { toasts.push(m); },
    recordMeta: () => {}, recordHistory: () => {}, resolvePic: () => '', captureReturn: () => {}, close: () => {}
  });
  // 冲出所有已挂起的定时器（含 30s/45s 超时兜底），等价于快进时间
  const flushTimers = () => {
    for (let i = 0; i < 4; i++) { // 最多两轮，防止重挂死循环
      const pending = timers.filter(t => !t.cancelled && !t.ran);
      if (!pending.length) break;
      pending.forEach(t => { t.ran = true; try { t.fn(); } catch (e) { /* 忽略 */ } });
    }
  };
  return { SFV, sandbox, opened, toasts, failArgs, flushTimers, timers };
}

const VIEW = { source: { id: 'kazumi:奈飞工厂', name: '奈飞工厂' }, vodId: '12024', title: '肖申克的救赎', key: 'k1' };

test('超时降级：ep.url 是 HTML 播放页时必须停止直连并报错（N2 红→绿）', async () => {
  const h = loadOrchestrator({ resolvePlayUrl: () => new Promise(() => {}) }); // 永不返回 → 只剩超时分支
  h.SFV.playOrchestrator.play(
    VIEW,
    { url: 'https://netflixgc.org/vodplay/12024-6-1.html', index: 0, name: 'HD' },
    null
  );
  h.flushTimers();
  await new Promise((r) => setImmediate(r));

  assert.equal(h.opened.length, 0,
    'HTML 播放页地址绝不允许被喂给播放器，实际 opened=' + JSON.stringify(h.opened));
  assert.ok(h.toasts.some(t => /解析/.test(t)), '应给出解析失败类提示，实际 toasts=' + JSON.stringify(h.toasts));
  assert.equal(h.failArgs.length, 1, '应触发换源失败信号 failPlaybackSwitch');
});

test('超时降级：ep.url 本身是媒体直链时仍允许降级直连（行为保持）', async () => {
  const h = loadOrchestrator({ resolvePlayUrl: () => new Promise(() => {}) });
  h.SFV.playOrchestrator.play(VIEW, { url: 'https://cdn.example.com/v/index.m3u8', index: 0, name: 'HD' }, null);
  h.flushTimers();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.opened, ['https://cdn.example.com/v/index.m3u8'], '媒体直链超时降级路径必须保持可用');
});
