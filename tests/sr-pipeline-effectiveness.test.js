'use strict';

/*
 * SR 链路有效性核查：用真实 vendor shader + 真实解析/规划代码，
 * 断言各场景下 planPasses 实际排入的 pass，证明增强链是否真的在跑。
 * 场景取自真实观感问题：1080×608 源全屏到 1920×1080（应触发 2x 放大链），
 * 以及 1920×1080 源 1:1 全屏（放大链应被 WHEN 比例门槛跳过）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SR_DIR = path.join(ROOT, 'public', 'video', 'sr');
const GLSL_DIR = path.join(ROOT, 'public', 'vendor', 'sr', 'glsl');

function makeEl(tag) {
  return {
    tagName: tag, style: {},
    classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } },
    firstChild: null, parentNode: null,
    insertBefore(child) { child.parentNode = this; this.firstChild = child; },
    removeChild() { this.firstChild = null; },
    clientWidth: 1920, clientHeight: 1080, width: 0, height: 0,
    addEventListener() {}, removeEventListener() {},
  };
}

const glStub = new Proxy({}, { get(t, p) { if (!(p in t)) t[p] = function () { return 0; }; return t[p]; } });

function makeHarness(vw, vh) {
  const overlayHost = makeEl('div');
  const video = Object.assign(makeEl('video'), {
    videoWidth: vw, videoHeight: vh, currentTime: 0, paused: false, readyState: 4,
    src: '', currentSrc: '',
    requestVideoFrameCallback() { return 1; }, cancelVideoFrameCallback() {},
    getVideoPlaybackQuality() { return { totalVideoFrames: 0, droppedVideoFrames: 0 }; },
    addEventListener() {}, removeEventListener() {}, load() {}, play() { return Promise.resolve(); },
  });
  const core = {
    gl: glStub, maxTex: 8192,
    getProgram() { return { id: 'prog' }; },
    uploadVideoFrame() { return { id: 'src' }; },
    acquireTarget(w, h) { return { tex: { w, h }, w, h }; },
    drawPass() {}, resetTargets() {}, dispose() {},
  };
  const sfv = {};
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    performance: { now: () => 0 },
    devicePixelRatio: 1,
    setTimeout() { return 0; }, clearTimeout() {},
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    addEventListener() {}, removeEventListener() {},
    fetch(url) {
      const name = url.replace('vendor/sr/glsl/', '');
      return Promise.resolve({ ok: true, text: () => fs.readFileSync(path.join(GLSL_DIR, name), 'utf8') });
    },
    Promise: Promise,
    document: {
      hidden: false,
      getElementById(id) { return id === 'sfv-overlay' ? overlayHost : null; },
      createElement(tag) { return makeEl(tag); },
      addEventListener() {},
      body: makeEl('body'),
    },
    StellaflixVideo: sfv,
  };
  sandbox.window = sandbox;
  sfv.player = { getVideoEl: () => video };
  sfv.srUi = { toast() {} };
  sfv.srCore = { createCore() { return core; } };

  vm.runInNewContext(fs.readFileSync(path.join(SR_DIR, 'sr-hook-adapter.js'), 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync(path.join(SR_DIR, 'sr-presets.js'), 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync(path.join(SR_DIR, 'sr-engine.js'), 'utf8'), sandbox);
  return { sandbox, sfv, video, engine: sfv.srEngine };
}

async function planFor(presetId, vw, vh) {
  const h = makeHarness(vw, vh);
  const def = await h.sfv.srPresets.load(presetId);
  h.engine.setPreset(def);
  h.engine.renderFrame();
  const plan = h.engine._state.activePlan || [];
  return { plan, parsed: h.engine._state.parsed };
}

test('anime-4k（动漫·双倍）：1080×608 源全屏 1920×1080 时 2x 放大链真实排入执行计划', async () => {
  const { plan, parsed } = await planFor('anime-4k', 1080, 608);
  assert.ok(parsed.passes.length > 20, 'shader 解析出的总 pass 数应远超 20，实际 ' + parsed.passes.length);
  assert.ok(plan.length >= 20, '执行计划 pass 数应 ≥20（clamp+restoreVL+upscaleVL+downscalePre），实际 ' + plan.length);
  assert.ok(plan.some((p) => p.w >= 2160 && p.h >= 1216),
    '应存在 2x 中间纹理（≥2160×1216），实际最大 ' + Math.max(...plan.map((p) => p.w)) + '×' + Math.max(...plan.map((p) => p.h)));
  const last = plan[plan.length - 1];
  assert.ok(Math.abs(last.w - 1918) <= 2 && last.h === 1080,
    '末级应降回屏幕尺寸 ≈1918×1080，实际 ' + last.w + '×' + last.h);
});

test('anime-4k：1920×1080 源 1:1 全屏时放大链被 WHEN 门槛跳过（只剩修复链，观感提升有限）', async () => {
  const { plan } = await planFor('anime-4k', 1920, 1080);
  assert.ok(!plan.some((p) => p.w > 1920), '1:1 场景不应出现 >1920 宽的上采样中间纹理');
  assert.ok(plan.length > 0, '修复链（Restore，无 WHEN）仍应执行');
});

test('anime-4k：720×404 低清源全屏 1920×1080 时放大链必然执行（收益最大的场景）', async () => {
  const { plan } = await planFor('anime-4k', 720, 404);
  assert.ok(plan.some((p) => p.w >= 1440), '应存在 ≥1440 宽的 2x 中间纹理');
});

test('fsrcnnx（通用档）：1080×608→1920×1080 时亮度超分链排入执行计划', async () => {
  const { plan } = await planFor('fsrcnnx', 1080, 608);
  assert.ok(plan.length >= 10, 'FSRCNNX x2 链应有 ≥10 个 pass，实际 ' + plan.length);
  assert.ok(plan.some((p) => p.w >= 2160), '应存在 2x 亮度中间纹理');
});

test('fsrcnnx：1920×1080 源 1:1 全屏时整条链被 1.3x 门槛跳过（该档完全无效）', async () => {
  const { plan } = await planFor('fsrcnnx', 1920, 1080);
  assert.equal(plan.length, 0, '1:1 场景 FSRCNNX 无任何 pass，实际 ' + plan.length);
});
