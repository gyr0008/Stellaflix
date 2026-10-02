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
