'use strict';

/**
 * 修复轮⑧b（2026-10-01 用户截图）：真实房间灯塔塔身/光点发黑
 * 运行：node --test tests/world-data-colors.test.js
 *
 * 根因【有来源】：world-data.js colorsFor() 的 hueToRgb 输出 0..1 分量，
 * 而渲染端 deck toColorVec（逐字 hearthere Ai() :11338-11341）按 0..255 输入 /255 归一
 * —— 实测 normalize 后 colorTop=[0,1,0.9] → /255 ≈ [0,0.004,0.004] = 黑。
 * 演示房不带 colorTop 走 COLOR_TOP_DEFAULT（[223,204,251]）所以不黑，掩盖了缺陷。
 *
 * 钉死语义：normalize 产出的 colorTop/colorBottom 必须是 0..255 刻度，
 * 且色相主分量=255、colorBottom=主色×0.32（散列语义不变，仅刻度对齐）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadWorldData() {
  const ctx = vm.createContext({ console, Promise, Object, Array, JSON, Math, Number, String, Error, RegExp, Date, setTimeout, clearTimeout, AbortController: undefined, fetch: undefined });
  ctx.window = ctx;
  ctx.self = ctx;
  vm.runInContext(fs.readFileSync(path.join(root, 'public/video/world-data.js'), 'utf8'), ctx, { filename: 'world-data.js' });
  return ctx.StellaflixVideo.worldData;
}

test('normalize 色值必须落在 0..255 刻度（deck toColorVec /255 后不得近黑）', () => {
  const wd = loadWorldData();
  const n = wd.normalize({ roomId: 'CQQ6B5', name: '济宁', lon: 116.59, lat: 35.41, status: 'playing', title: 'T', people: 1 });
  for (const c of n.colorTop.concat(n.colorBottom)) {
    assert.ok(c >= 0 && c <= 255, '分量必须 0..255：' + JSON.stringify(n.colorTop) + '/' + JSON.stringify(n.colorBottom));
  }
  // deck 消费端等价验算：toColorVec = v/255，主分量应归一到 1（彩色），而非 ≤1/255（黑）
  const vec = n.colorTop.map((v) => v / 255);
  assert.ok(Math.max(...vec) > 0.5, 'toColorVec 后主分量必须 >0.5，实测 ' + JSON.stringify(vec));
});

test('色相散列语义保持：同 roomId 稳定、colorBottom=colorTop×0.32（四舍五入到 0..255 整数）', () => {
  const wd = loadWorldData();
  const a = wd.normalize({ roomId: 'CQQ6B5', lon: 0, lat: 0 });
  const b = wd.normalize({ roomId: 'CQQ6B5', lon: 0, lat: 0 });
  assert.deepStrictEqual(a.colorTop, b.colorTop, '同 roomId 色相稳定');
  const c = wd.normalize({ roomId: 'ZZZZZZ', lon: 0, lat: 0 });
  assert.notDeepStrictEqual(a.colorTop, c.colorTop, '不同 roomId 散列区分');
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(a.colorBottom[i] - Math.round(a.colorTop[i] * 0.32)) <= 1,
      'colorBottom 应为主色 ×0.32：' + JSON.stringify(a));
  }
});

// ---------------- 轮㉓-C：FNV 高位聚集致十演示角色相全挤红黄绿段（0.057–0.379），蓝/紫/青整段缺失 ----------------

function rgbHue([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  let h;
  if (mx === r) h = ((g - b) / d + 6) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return h / 6;
}

test('轮㉓-C 十演示角色相须铺满全色环（雪崩终结器修 FNV 聚集，对齐 hearthere 每塔一色）', () => {
  const wd = loadWorldData();
  const ids = ['room-sh', 'room-tk', 'room-ny', 'room-ld', 'room-pr',
    'room-sy', 'room-ri', 'room-ct', 'room-mb', 'room-ms'];
  const hues = ids.map((id) => rgbHue(wd.normalize({ roomId: id, lon: 0, lat: 0 }).colorTop));
  const buckets = new Set(hues.map((h) => Math.floor(h * 6)));
  assert.ok(buckets.size >= 4,
    '色相六区覆盖须 ≥4（现全挤红黄绿段），实测 buckets=' + [...buckets] + ' hues=' + hues.map((h) => h.toFixed(3)));
  assert.ok(Math.max(...hues) > 0.45,
    '须存在蓝/紫段站（hue>0.45），实测 max=' + Math.max(...hues).toFixed(3));
});

test('轮㉓-C fetchRooms 降级/合并面的演示房须自带 colorTop（裸推致十塔同走默认薰衣草色=塔不变色根因）', async () => {
  const wd = loadWorldData();
  const info = await wd.fetchRooms({}); // vm 沙箱 fetch undefined → 降级演示房间支路
  assert.ok(Array.isArray(info.rooms) && info.rooms.length >= 10, '降级应回十演示房');
  for (const d of info.rooms) {
    assert.ok(Array.isArray(d.colorTop) && d.colorTop.length === 3,
      d.roomId + ' 须带 colorTop（现裸推 DEMO_ROOMS 无此字段 → roomToStation 落默认色）');
    for (const v of d.colorTop) assert.ok(v >= 0 && v <= 255, '分量 0..255：' + JSON.stringify(d.colorTop));
  }
  const hues = info.rooms.map((d) => rgbHue(d.colorTop));
  const buckets = new Set(hues.map((h) => Math.floor(h * 6)));
  assert.ok(buckets.size >= 4, '演示房实际下发色相亦须铺满全色环，实测 buckets=' + [...buckets]);
});
