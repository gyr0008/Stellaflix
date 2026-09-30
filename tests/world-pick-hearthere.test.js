'use strict';

/**
 * 世界页 步骤④-2 — 拾取分档 + flyTo 序列 hearthere 保真（public/video/world-pick.js）
 * 运行：node --test tests/world-pick-hearthere.test.js
 *
 * 基准：_scratch/hearthere/main.pretty.js
 *   · GPU 拾取 om :11691-11705（临时开 _pickable → pickObject radius:0 → 取 .object.id）
 *   · CPU 拾取 _c :16645-16662（screen 平方距 < radius²；背侧守卫 |Δlng|/|Δlat|>1 跳过）
 *   · 半径 Cc :16681-16688（far 50m→px clamp[8,70]，near 36m→px min 15；11.5/13.5 分档）
 *   · 米→px nl :16670-16679（111320·cos(lat)）
 *   · 合并 dy :16690（GPU 优先）；GPU 门限 py/fy :16693-16697（zoom≥11.5）
 *   · 决策 el :16620-16641
 *   · flyTo wt/zn :19601-19653（F0=16/O0=60/B0=2800 + 程序化飞行 flag）
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const PICK = require(path.join(__dirname, '..', 'public', 'video', 'world-pick.js'));

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

test('拾取/飞行常量逐字（sy/tl/ry/ay/iy/ly/cy/uy :16642-16668 + F0/O0/B0 :19643-19650 + fy=11.5）', () => {
  assert.strictEqual(PICK.CPU_RADIUS_DEFAULT_PX, 40);   // sy
  assert.strictEqual(PICK.GUARD_DEG, 1);                 // tl
  assert.strictEqual(PICK.FAR_RADIUS_M, 50);             // ay
  assert.strictEqual(PICK.FAR_MIN_PX, 8);                // iy
  assert.strictEqual(PICK.FAR_MAX_PX, 70);               // ly
  assert.strictEqual(PICK.NEAR_RADIUS_M, 36);            // cy
  assert.strictEqual(PICK.NEAR_MIN_PX, 15);              // uy
  assert.strictEqual(PICK.RADIUS_BIAS_PX, 0);            // ry
  assert.strictEqual(PICK.GPU_PICK_MIN_ZOOM, 11.5);      // fy = St - xt
  assert.strictEqual(PICK.FLY_ZOOM, 16);                 // F0
  assert.strictEqual(PICK.FLY_PITCH, 60);                // O0
  assert.strictEqual(PICK.FLY_DURATION_MS, 2800);        // B0
});

// ---------------------------------------------------------------------------
// Cc 半径分档（nl 依赖 project 注入）
// ---------------------------------------------------------------------------

// 线性投影桩：1px = 1 单位，仅用于验证「越近屏幕半径越小」的钳位路径
function makeProject(zoomPxPerDeg) {
  return (pos) => ({ x: pos[0] * zoomPxPerDeg, y: pos[1] * zoomPxPerDeg });
}

test('Cc 半径分档（:16681-16688）：zoom<11.5 用 far、zoom>13.5 用 near、中间取 max(far,near)', () => {
  const center = [0, 0];
  const pxPerDeg = 300; // 高像素密度 → 米级半径落到 px 明显
  const project = makeProject(pxPerDeg);
  const farOnly = PICK.pickRadiusPx(10, center, project);      // zoom<11.5 → far
  const nearOnly = PICK.pickRadiusPx(14, center, project);     // zoom>13.5 → near
  assert.ok(Number.isFinite(farOnly) && Number.isFinite(nearOnly));
  // 中间档 = max(far, near)
  const mid = PICK.pickRadiusPx(12.5, center, project);
  assert.ok(Math.abs(mid - Math.max(farOnly, nearOnly)) < 1e-9, '11.5~13.5 取 max(far,near)');
});

test('Cc far 档 clamp 到 [8,70]px，near 档 min 15px（nl→clamp :16684-16685）', () => {
  const center = [0, 0];
  // 极低像素密度：far 原始 px < 8 → 钳到 8；near 原始 < 15 → 抬到 15
  const sparse = makeProject(0.5);
  assert.ok(PICK.pickRadiusPx(10, center, sparse) <= 70);
  assert.ok(PICK.pickRadiusPx(10, center, sparse) >= 8);
  // near 档恒 >= 15
  assert.ok(PICK.pickRadiusPx(14, center, sparse) >= 15);
});

test('metersToPx 用 111320·cos(lat)（nl :16670-16679）：墨卡托等距经度下高纬同米数占更多经度、px 更长', () => {
  const project = makeProject(200);
  const eq = PICK.metersToPx([0, 0], 37, project);     // 赤道
  const high = PICK.metersToPx([0, 60], 37, project);  // 60°N（cos=0.5 → 经度差×2 → px×2）
  assert.ok(Math.abs(high / eq - 2) < 0.05, `60°N/赤道 px 比≈2：${high}/${eq}=${high / eq}`);
});

// ---------------------------------------------------------------------------
// _c CPU 最近点 + 背侧守卫
// ---------------------------------------------------------------------------

test('_c：屏幕平方距命中最近站，超 radius 不命中（:16645-16662）', () => {
  const project = makeProject(10);
  const stations = [
    { id: 'a', position: [121, 31] },
    { id: 'b', position: [139, 35] }
  ];
  const hit = PICK.cpuPick({ x: 1210 + 3, y: 310 + 3 }, stations, project, 10, null);
  assert.strictEqual(hit && hit.id, 'a');
  const miss = PICK.cpuPick({ x: 0, y: 0 }, stations, project, 5, null);
  assert.strictEqual(miss, null);
});

test('_c 背侧守卫：unproject 回投 |Δ|>1° 的站跳过（球面背面防误捕 :16650-16655）', () => {
  const project = makeProject(1);
  const stations = [{ id: 'back', position: [121, 31] }];
  const point = { x: 121, y: 31 }; // 屏幕距=0，本应命中
  // 守卫：该站屏幕点对应回投到别处（Δ>1°）→ 视为背面 → 跳过
  const guard = () => ({ lng: 0, lat: 0 });
  assert.strictEqual(PICK.cpuPick(point, stations, project, 40, guard), null);
  const okGuard = (p) => ({ lng: p.x, lat: p.y });
  assert.strictEqual((PICK.cpuPick(point, stations, project, 40, okGuard) || {}).id, 'back');
});

// ---------------------------------------------------------------------------
// GPU 拾取 om
// ---------------------------------------------------------------------------

test('om：临时置 deckPicker._pickable=true，pickObject radius:0，取 object.id，finally 复位（:11691-11705）', () => {
  let seenRadius = null; let pickableDuring = null;
  const deck = {
    deckPicker: { _pickable: false },
    pickObject(o) {
      seenRadius = o.radius;
      pickableDuring = deck.deckPicker._pickable;
      return { object: { id: 'station-42' } };
    }
  };
  assert.strictEqual(PICK.gpuPick(deck, { x: 5, y: 6 }), 'station-42');
  assert.strictEqual(seenRadius, 0);
  assert.strictEqual(pickableDuring, true, '拾取瞬间必须临时开 _pickable');
  assert.strictEqual(deck.deckPicker._pickable, false, '拾取后必须 finally 复位 false');
});

test('om 无 deckPicker → null；pickObject 抛错 → null 且仍复位（catch/finally :11692,11700-11704）', () => {
  assert.strictEqual(PICK.gpuPick(null, { x: 0, y: 0 }), null);
  assert.strictEqual(PICK.gpuPick({ deckPicker: { _pickable: false }, pickObject() { throw new Error('x'); } }, { x: 0, y: 0 }), null);
  const d = { deckPicker: { _pickable: false }, pickObject() { throw new Error('x'); } };
  PICK.gpuPick(d, { x: 0, y: 0 });
  assert.strictEqual(d.deckPicker._pickable, false);
});

// ---------------------------------------------------------------------------
// dy 合并 + 分档派发
// ---------------------------------------------------------------------------

test('dy：GPU 命中优先，否则落 CPU（:16690）', () => {
  assert.strictEqual(PICK.mergePick('gpu-id', 'cpu-id'), 'gpu-id');
  assert.strictEqual(PICK.mergePick(null, 'cpu-id'), 'cpu-id');
  assert.strictEqual(PICK.mergePick(null, null), null);
});

test('分档门限：zoom≥11.5 才走 GPU，低倍只 CPU（py :16695-16697）', () => {
  assert.strictEqual(PICK.shouldGpuPick(11.4), false);
  assert.strictEqual(PICK.shouldGpuPick(11.5), true);
  assert.strictEqual(PICK.shouldGpuPick(16), true);
});

// ---------------------------------------------------------------------------
// el 点击决策
// ---------------------------------------------------------------------------

test('el 决策：自己站→开面板不自动调频；广播中点他站→确认停播；其余→开面板并判 autoTune（:16620-16641）', () => {
  assert.deepStrictEqual(
    PICK.decideClick({ clickedStationId: 'm', myStationId: 'm', isBroadcasting: true, stationStatus: 'playing', listeningStationId: null, isMusicAuthorized: true }),
    { type: 'open_station_panel', stationId: 'm', autoTune: false }
  );
  assert.deepStrictEqual(
    PICK.decideClick({ clickedStationId: 'o', myStationId: 'm', isBroadcasting: true }),
    { type: 'confirm_stop_broadcast', stationId: 'o' }
  );
  const t = PICK.decideClick({ clickedStationId: 'o', myStationId: 'm', isBroadcasting: false, stationStatus: 'playing', listeningStationId: null, isMusicAuthorized: true });
  assert.strictEqual(t.type, 'open_station_panel');
  assert.strictEqual(t.autoTune, true, '已授权+非正在听+playing → autoTune');
  const idle = PICK.decideClick({ clickedStationId: 'o', myStationId: null, isBroadcasting: false, stationStatus: 'online', isMusicAuthorized: true });
  assert.strictEqual(idle.autoTune, false, 'online（非 playing/live_idle）→ 不自动调频');
});
