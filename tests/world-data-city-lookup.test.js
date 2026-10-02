'use strict';

/**
 * 世界页 创建放映落塔语义（方案 A：离线城市词典 + 视野中心兜底）
 * 运行：node --test tests/world-data-city-lookup.test.js
 *
 * 背景（用户截图 092350 + 裁决方案 A）：
 *   创建面板「城市」输入框收集城市名（如「济宁」），旧实现仅把它当卡片标题，
 *   灯塔坐标实际取当前地图视野中心 → 「我创建的是济宁，但灯塔位置随机」。
 *   方案 A：内置离线城市词典（不联网、不新增依赖，符合仓库铁律），
 *   城市名命中词典 → 用词典坐标；未命中 → 调用方落回视野中心（本模块返回 null）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(root, 'public', 'video', 'world-data.js'), 'utf8');

function loadWorldData() {
  const sandbox = { console, fetch: undefined, setTimeout, clearTimeout, AbortController, Math, JSON, Object, Array, Number, String, Promise };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox.StellaflixVideo.worldData;
}

test('worldData 暴露 cityLookup（城市名 → {lon,lat} 或 null）', () => {
  const wd = loadWorldData();
  assert.strictEqual(typeof wd.cityLookup, 'function', '须导出 cityLookup');
});

test('济宁（山东省济宁市）命中词典 → 落在济宁坐标，不是零点、不是随机', () => {
  const wd = loadWorldData();
  const c = wd.cityLookup('济宁');
  assert.ok(c, '济宁应在词典内');
  assert.ok(Math.abs(c.lon - 116.59) < 1.5, `经度应≈116.59，实得 ${c.lon}`);
  assert.ok(Math.abs(c.lat - 35.41) < 1.5, `纬度应≈35.41，实得 ${c.lat}`);
});

test('世界名城命中（东京/纽约/伦敦），值与 DEMO_ROOMS 同源一致', () => {
  const wd = loadWorldData();
  const tk = wd.cityLookup('东京');
  assert.ok(tk && Math.abs(tk.lon - 139.69) < 1 && Math.abs(tk.lat - 35.69) < 1, '东京坐标');
  const ny = wd.cityLookup('纽约');
  assert.ok(ny && Math.abs(ny.lon - (-74.01)) < 1 && Math.abs(ny.lat - 40.71) < 1, '纽约坐标');
  const ld = wd.cityLookup('伦敦');
  assert.ok(ld && Math.abs(ld.lon - (-0.13)) < 1 && Math.abs(ld.lat - 51.51) < 1, '伦敦坐标');
});

test('英文名大小写不敏感（Tokyo / TOKYO / tokyo 同一结果）', () => {
  const wd = loadWorldData();
  const a = wd.cityLookup('Tokyo');
  const b = wd.cityLookup('TOKYO');
  const c = wd.cityLookup('tokyo');
  assert.ok(a && b && c, '英文城市名应命中');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(c)), JSON.parse(JSON.stringify(a)));
});

test('后缀容错：「济宁市」等同「济宁」；首尾空白忽略', () => {
  const wd = loadWorldData();
  const withSuffix = wd.cityLookup('济宁市');
  const bare = wd.cityLookup(' 济宁 ');
  assert.ok(withSuffix && bare, '带后缀/带空白应仍命中');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(withSuffix)), JSON.parse(JSON.stringify(bare)));
});

test('未命中城市名返回 null（由调用方落回视野中心，绝不臆造坐标）', () => {
  const wd = loadWorldData();
  assert.strictEqual(wd.cityLookup('某个不存在的小镇XYZ'), null);
  assert.strictEqual(wd.cityLookup(''), null);
  assert.strictEqual(wd.cityLookup(null), null);
  assert.strictEqual(wd.cityLookup(undefined), null);
});

test('词典所有坐标合法（经度 ±180、纬度 ±90），不得出现 (0,0) 零点条目', () => {
  const wd = loadWorldData();
  const table = wd.CITY_COORDS || null;
  if (!table) return; // 词典内部结构不强制暴露；若暴露则校验
  const entries = typeof table === 'object' ? Object.keys(table) : [];
  for (const k of entries) {
    const v = table[k];
    assert.ok(v && Number.isFinite(v.lon) && Number.isFinite(v.lat), `${k} 坐标缺失`);
    assert.ok(v.lon >= -180 && v.lon <= 180, `${k} 经度越界`);
    assert.ok(v.lat >= -90 && v.lat <= 90, `${k} 纬度越界`);
    assert.ok(!(v.lon === 0 && v.lat === 0), `${k} 不得是零点`);
  }
});

// 接线锁定：page-world 创建处理器必须先按名字查词典，命中即用城市坐标，
// 未命中才落回视野中心（防止「城市名被忽略、灯塔随机落点」回归）。
test('page-world 创建处理器接线 cityLookup(opts.name)，命中优先于视野中心兜底', () => {
  const pageSrc = fs.readFileSync(path.join(root, 'public', 'video', 'page-world.js'), 'utf8');
  assert.match(pageSrc, /worldData\.cityLookup\(/, '创建路径须调用 cityLookup');
  assert.match(pageSrc, /cityLookup\(opts\.name\)/, '以面板城市名 opts.name 查询');
  const cityIdx = pageSrc.indexOf('cityLookup(opts.name)');
  const viewIdx = pageSrc.indexOf('mapViewCenter()', cityIdx);
  assert.ok(cityIdx > -1 && viewIdx > cityIdx, '命中城市词典分支须在 mapViewCenter 兜底之前');
});
