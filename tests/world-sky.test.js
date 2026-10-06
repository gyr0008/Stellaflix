'use strict';

/**
 * 轮㉕-A：世界页天空三段链 —— SFV.worldSky
 * 运行：node --test tests/world-sky.test.js
 *
 * 裁决（主人 2026-10-03「确认，按这个方案动工」）：移植 hearthere 三段——
 *   ① StarColor 星野随播变色（main.pretty.js :19368-19386，驱动源=选中灯塔·已裁决）
 *   ② DynamicSky 昼夜天空（:10491-10610，SunCalc 高度角 + rh 11 档色表 + 60s/move500ms）
 *   ③ halo 换轨 1500ms 补间（:10406-10479）
 * 数值/时序/分支全部逐字；SunCalc 摘录含 hearthere 打包 literal 280.16（非标准 280.4606）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadWorldSky(opts) {
  const p = path.join(root, 'public', 'video', 'world-sky.js');
  assert.ok(fs.existsSync(p), 'public/video/world-sky.js 应存在（轮㉕ 待实现）');
  const rafQ = [];
  const timers = { intervals: [], cleared: [], moved: null, moveRemoved: false };
  const sandbox = {
    console, Math, Date, Object, Array, String, Number, Boolean, isFinite, JSON, Error,
    setInterval: (fn, ms) => { timers.intervals.push({ fn, ms, id: timers.intervals.length + 1 }); return timers.intervals.length; },
    clearInterval: (id) => { timers.cleared.push(id); },
    requestAnimationFrame: (fn) => { rafQ.push(fn); return rafQ.length; },
    cancelAnimationFrame: () => { rafQ.length = 0; },
    performance: { now: () => clock.t }
  };
  const clock = { t: 0 };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox);
  assert.ok(sandbox.StellaflixVideo && sandbox.StellaflixVideo.worldSky, '应挂 SFV.worldSky');
  return { sky: sandbox.StellaflixVideo.worldSky, rafQ, timers, clock };
}

function mapStub(extra) {
  const calls = { setSpace: [], setSky: [], repaints: 0, on: {}, handlers: [] };
  const m = {
    setSpace: (o) => calls.setSpace.push(o),
    setSky: (o) => calls.setSky.push(o),
    getCenter: () => ({ lng: 0, lat: 0 }),
    getHalo: () => (extra && 'halo' in extra ? extra.halo : { scale: 0, stops: [] }),
    triggerRepaint: () => { calls.repaints++; },
    on: (ev, fn) => { (calls.on[ev] = calls.on[ev] || []).push(fn); },
    off: (ev, fn) => {
      calls.handlers.push([ev, fn]);
      if (calls.on[ev]) calls.on[ev] = calls.on[ev].filter((f) => f !== fn);
    }
  };
  if (extra && extra.getCenter) m.getCenter = extra.getCenter;
  if (extra && extra.throwOn) {
    if (extra.throwOn === 'setSpace') m.setSpace = () => { throw new Error('boom'); };
    if (extra.throwOn === 'setSky') m.setSky = () => { throw new Error('boom'); };
    if (extra.throwOn === 'getHalo') m.getHalo = () => { throw new Error('boom'); };
  }
  m.__calls = calls;
  return m;
}

// 泵 rAF：按序执行队列并注入给定时间戳（每次全队列，模拟逐帧）
function pump(rafQ, tsList) {
  for (const ts of tsList) {
    const q = rafQ.splice(0, rafQ.length);
    if (q.length) q[0]();
    // clock 由调用方先改
    void ts;
  }
}

test('sunPosition 摘录逐字（含 280.16 literal）：北京夏至正午高度角≈+73.5°；同刻纽约夜里为深负', () => {
  const { sky } = loadWorldSky();
  const deg = (r) => r * 180 / Math.PI;
  const solsticeNoon = new Date('2026-06-21T04:00:00Z'); // 北京 116.4E ≈ 地方真太阳时正午
  const bj = sky.sunPosition(solsticeNoon, 39.9, 116.4);
  assert.ok(Math.abs(deg(bj.altitude) - 73.5) < 1.5, `北京夏至正午高度角应≈73.5°，实得 ${deg(bj.altitude).toFixed(2)}`);
  const ny = sky.sunPosition(solsticeNoon, 40.7, -74.0); // 同刻纽约≈地方夜半
  assert.ok(deg(ny.altitude) < -20, `纽约同刻应在深夜（<-20°），实得 ${deg(ny.altitude).toFixed(2)}`);
});

test('skyColorsForAltitude=ah(rh) 逐字：≤-18 钳夜班、≥70 钳白昼档、-9 精确半插值、0° 日出橙', () => {
  const { sky } = loadWorldSky();
  assert.deepEqual(sky.skyColorsForAltitude(-20), { skyColor: 'rgb(10,14,26)', horizonColor: 'rgb(13,17,23)' });
  assert.deepEqual(sky.skyColorsForAltitude(-18), { skyColor: 'rgb(10,14,26)', horizonColor: 'rgb(13,17,23)' });
  assert.deepEqual(sky.skyColorsForAltitude(80), { skyColor: 'rgb(65,135,210)', horizonColor: 'rgb(176,207,224)' });
  // -12→-6 中点 t=0.5：sky [15,27,45]→[30,39,68] = [22.5,33,56.5]→round [23,33,57]
  assert.deepEqual(sky.skyColorsForAltitude(-9), { skyColor: 'rgb(23,33,57)', horizonColor: 'rgb(33,38,70)' });
  assert.deepEqual(sky.skyColorsForAltitude(0), { skyColor: 'rgb(74,122,181)', horizonColor: 'rgb(255,107,53)' });
});

test('StarColor 逐字 :19371-19384：playing+colorTop→rgb(colorTop)；否则 #ffffff；setSpace 抛错吞掉返 false', () => {
  const { sky } = loadWorldSky();
  const m = mapStub();
  assert.equal(sky.applySpace(m, [87, 25, 23], true), true);
  assert.deepEqual(m.__calls.setSpace[0], { color: 'rgb(87,25,23)', preset: 'stars' });
  assert.equal(sky.applySpace(m, null, true), true);
  assert.deepEqual(m.__calls.setSpace[1], { color: '#ffffff', preset: 'stars' });
  assert.equal(sky.applySpace(m, [87, 25, 23], false), true);
  assert.deepEqual(m.__calls.setSpace[2], { color: '#ffffff', preset: 'stars' });
  const boom = mapStub({ throwOn: 'setSpace' });
  assert.equal(sky.applySpace(boom, [1, 2, 3], true), false, '[StarColor] try/catch 面');
});

test('updateSky 逐字 uh :10574-10578：playing 只写 sky-color；非 playing 双写 sky+horizon；高度角取自视野中心', () => {
  const { sky } = loadWorldSky();
  // 视野中心放北京夏至正午 → 只应写 sky-color（playing），且为白天蓝
  const m = mapStub({ getCenter: () => ({ lng: 116.4, lat: 39.9 }) });
  const realDate = Date;
  sky.__setNow(() => new realDate('2026-06-21T04:00:00Z'));
  sky.updateSky(m, true);
  assert.equal(m.__calls.setSky.length, 1);
  assert.deepEqual(Object.keys(m.__calls.setSky[0]), ['sky-color']);
  sky.updateSky(m, false);
  const last = m.__calls.setSky[1];
  assert.deepEqual(Object.keys(last).sort(), ['horizon-color', 'sky-color']);
  assert.equal(last['sky-color'], 'rgb(65,135,210)', '正午 73.5°>70 钳白昼末档（rh 逐字）');
  assert.equal(last['horizon-color'], 'rgb(176,207,224)');
  sky.__setNow(null);
});

test('applyHorizonColor 逐字 :19390-19396：setSky({horizon-color: rgb(colorTop)})；抛错吞掉', () => {
  const { sky } = loadWorldSky();
  const m = mapStub();
  sky.applyHorizonColor(m, [167, 185, 165]);
  assert.deepEqual(m.__calls.setSky[0], { 'horizon-color': 'rgb(167,185,165)' });
  const boom = mapStub({ throwOn: 'setSky' });
  assert.equal(sky.applyHorizonColor(boom, [1, 2, 3]), false);
});

test('haloStops=hi 逐字 + lerpColor=pi：3 档 stops 与线性取整', () => {
  const { sky } = loadWorldSky();
  assert.deepEqual(sky.haloStops([10, 20, 30], [40, 50, 60]), [
    [0, 'rgba(10, 20, 30, 0.35)'],
    [0.4, 'rgba(40, 50, 60, 0.18)'],
    [0.8, 'rgba(40, 50, 60, 0)']
  ]);
  assert.deepEqual(sky.lerpColor([0, 10, 255], [100, 0, 0], 0.5), [50, 5, 128]);
  assert.deepEqual(sky.lerpColor([0, 0, 0], [10, 10, 10], 2), [10, 10, 10], 't 钳 1');
});

test('transitionHalo 逐字 oh/th/sh：1500ms rAF 补间写 gradient(scale=1.2,stops)+triggerRepaint；同色短路；getHalo 缺位 warn 不抛', () => {
  const { sky, rafQ, clock } = loadWorldSky();
  const m = mapStub({ halo: { scale: 0, stops: [] } });
  assert.equal(sky.transitionHalo(m, [200, 0, 0], [0, 0, 200]), true);
  assert.equal(rafQ.length, 1, '应有 1 帧在途');
  clock.t = 750;
  pump(rafQ, [750]);
  const halo = m.getHalo();
  assert.equal(halo.scale, 1.2, 'nh 逐字');
  assert.deepEqual(halo.stops, [
    [0, 'rgba(228, 128, 128, 0.35)'],
    [0.4, 'rgba(128, 128, 228, 0.18)'],
    [0.8, 'rgba(128, 128, 228, 0)']
  ], 'white→目标 半程线性（pi 逐字 round-half-up：255→200 半程 227.5→228）');
  clock.t = 1500;
  pump(rafQ, [1500]);
  assert.deepEqual(m.getHalo().stops, [
    [0, 'rgba(200, 0, 0, 0.35)'],
    [0.4, 'rgba(0, 0, 200, 0.18)'],
    [0.8, 'rgba(0, 0, 200, 0)']
  ]);
  const repaintsAtEnd = m.__calls.repaints;
  assert.equal(rafQ.length, 1, '终帧后按 hearthere 链多排一帧 no-op（tick 返回 null 即止）');
  clock.t = 1600;
  pump(rafQ, [1600]);
  assert.equal(rafQ.length, 0, 'no-op 帧后彻底停排');
  assert.equal(m.__calls.repaints, repaintsAtEnd, 'no-op 帧不再 repaint');
  assert.ok(m.__calls.repaints >= 2, '逐帧 triggerRepaint');
  // 同色短路（:10466 等值 return）
  assert.equal(sky.transitionHalo(m, [200, 0, 0], [0, 0, 200]), false);
  assert.equal(rafQ.length, 0);
  // getHalo null → warn 不抛
  const noHalo = mapStub({ halo: null });
  assert.equal(sky.transitionHalo(noHalo, [1, 2, 3], [4, 5, 6]), false);
});

test('applyStation（选中灯塔=已裁决驱动源）：playing 站→星色+horizon+halo 三联动；null/非 playing→全回白且 halo 补间回白', () => {
  const { sky, rafQ } = loadWorldSky();
  const m = mapStub({ halo: { scale: 0, stops: [] } });
  sky.mount(m);
  sky.applyStation({ status: 'playing', colorTop: [219, 152, 69], colorBottom: [30, 30, 40] });
  assert.deepEqual(m.__calls.setSpace.slice(-1)[0], { color: 'rgb(219,152,69)', preset: 'stars' });
  const skies = m.__calls.setSky.filter((o) => o['horizon-color'] === 'rgb(219,152,69)');
  assert.ok(skies.length >= 1, 'horizon-color 应被接管为 colorTop');
  assert.equal(sky.peekState().isPlaying, true);
  assert.equal(rafQ.length, 1, 'halo 补间应启动');
  sky.applyStation(null);
  assert.deepEqual(m.__calls.setSpace.slice(-1)[0], { color: '#ffffff', preset: 'stars' });
  assert.equal(sky.peekState().isPlaying, false);
  sky.applyStation({ status: 'online', colorTop: [1, 2, 3], colorBottom: [4, 5, 6] });
  assert.deepEqual(m.__calls.setSpace.slice(-1)[0], { color: '#ffffff', preset: 'stars' }, '非 playing 门（fh/Es 逐字）');
  sky.unmount();
});

test('mount/unmount 调度逐字 dh：初始一拍 + setInterval 60000 + move 500ms 节流；unmount 清全部', () => {
  const { sky, timers } = loadWorldSky();
  const m = mapStub();
  sky.mount(m);
  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].ms, 60000, 'ch=6e4 逐字');
  assert.ok((m.__calls.on.move || []).length === 1, 'move 监听应挂上');
  const beatBase = m.__calls.setSky.length; // mount 初始一拍已写
  m.__calls.on.move[0](); // 第一次立即
  assert.equal(m.__calls.setSky.length, beatBase + 1);
  m.__calls.on.move[0](); // 500ms 内第二次被节流（lh=500 逐字）
  assert.equal(m.__calls.setSky.length, beatBase + 1);
  timers.intervals[0].fn(); // interval 拍不节流
  assert.equal(m.__calls.setSky.length, beatBase + 2);
  const moveFn = m.__calls.on.move[0];
  sky.unmount();
  assert.equal(timers.cleared.length, 1);
  assert.deepEqual(m.__calls.handlers, [['move', moveFn]], 'unmount off(move) 同一引用');
  assert.equal((m.__calls.on.move || []).length, 0);
});

test('接线源断言：index.html manifest 装载 world-sky.js；page-world mount/选中/关卡/刷新/unmount 五点', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(html, /"video\/world-sky\.js",/, 'manifest 行');
  const pw = fs.readFileSync(path.join(root, 'public', 'video', 'page-world.js'), 'utf8');
  assert.match(pw, /SFV\.worldSky\.mount\(info\.map\)/, 'mount 接线');
  assert.match(pw, /SFV\.worldSky\.unmount\(\)/, 'unmount 接线');
  assert.match(pw, /applySkyStation\(st\)/, 'openStation 驱动');
  assert.match(pw, /applySkyStation\(null\)/, 'closePanel 回白');
  assert.match(pw, /syncSelectedSky\(\)/, '轮询刷新跟随换片变色');
  assert.match(pw, /onClose: closePanel/, '面板×按钮回调接线（否则关卡不回白）');
});
