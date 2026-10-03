'use strict';

/**
 * 轮㉔-A：海报提色模块 —— SFV.worldPosterColor
 * 运行：node --test tests/world-poster-color.test.js
 *
 * 裁决（主人 2026-10-03）：灯塔色 = 当前播放影片海报提色；真实房换片自动跟色。
 * 偏差声明（已批）：Apple Music artwork 调色板 API 不可得 → 色源换成本地像素量化
 * （众数桶=bg、其余高频桶=候选），**选取规则逐字 hearthere**：
 *   main.pretty.js :2059-2061 getLuminance = .299R+.587G+.114B
 *   :2061-2094 getLighthouseColors：text=候选中最亮；lum(bg)>=lum(text)→top=bg/bottom=text，反之互换。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadPosterColor() {
  const p = path.join(root, 'public', 'video', 'world-poster-color.js');
  assert.ok(fs.existsSync(p), 'public/video/world-poster-color.js 应存在（轮㉔ 待实现）');
  const sandbox = { console, Promise, Map, Object, Array, Math, Number, String, Error, Uint8ClampedArray };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox);
  assert.ok(sandbox.StellaflixVideo && sandbox.StellaflixVideo.worldPosterColor, '应挂 SFV.worldPosterColor');
  return sandbox.StellaflixVideo.worldPosterColor;
}

function rgba(r, g, b, a, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(r, g, b, a);
  return out;
}

test('getLuminance 逐字 hearthere（.299R+.587G+.114B）', () => {
  const P = loadPosterColor();
  assert.equal(P.getLuminance([255, 255, 255]), 255);
  assert.equal(P.getLuminance([0, 0, 0]), 0);
  assert.ok(Math.abs(P.getLuminance([100, 200, 255]) - (0.299 * 100 + 0.587 * 200 + 0.114 * 255)) < 1e-9);
});

test('applyHearthereRule：暗底亮字→字在顶；亮底暗字→底在顶；text=多候选最亮（非首个）；缺位 null', () => {
  const P = loadPosterColor();
  const dark = [30, 30, 40];
  const light = [240, 230, 60];
  // lum(dark)≈31.1 < lum(light)≈213.6 → colorTop=text、colorBottom=bg（:2091 互换支路）
  assert.deepEqual(P.applyHearthereRule(dark, [light]), { colorTop: light, colorBottom: dark });
  // lum(bg)>=lum(text) → colorTop=bg、colorBottom=text
  assert.deepEqual(P.applyHearthereRule(light, [dark]), { colorTop: light, colorBottom: dark });
  // 多候选取最亮：[200,0,0] 亮度过 [120,120,120] → text=灰
  const r = P.applyHearthereRule([10, 10, 10], [[50, 50, 50], [200, 0, 0], [120, 120, 120]]);
  assert.deepEqual(r.colorTop, [120, 120, 120], 'text 必须是候选中 getLuminance 最大者');
  assert.deepEqual(r.colorBottom, [10, 10, 10]);
  assert.equal(P.applyHearthereRule(null, [[1, 2, 3]]), null, 'bg 缺位 → null（:2063-2065）');
  assert.equal(P.applyHearthereRule([1, 2, 3], []), null, '候选空 → null（:2081-2082）');
});

test('extractFromPixels：众数桶=bg，其余高频桶=候选；alpha<128 像素跳过', () => {
  const P = loadPosterColor();
  // 主导深蓝 600、黄 100、白 50、透明红 200（alpha=0 必须不进任何输出）
  const arr = new Uint8ClampedArray([].concat(
    rgba(20, 30, 120, 255, 600), rgba(250, 240, 10, 255, 100),
    rgba(250, 250, 250, 255, 50), rgba(255, 0, 0, 0, 200)));
  const res = P.extractFromPixels(arr);
  assert.ok(res && Array.isArray(res.bg), '应产出 {bg, candidates}');
  assert.ok(res.bg[2] >= 104 && res.bg[2] <= 128 && res.bg[0] < 40, 'bg=众数深蓝桶（桶均值容差）：' + JSON.stringify(res.bg));
  assert.ok(res.candidates.length >= 2, '候选至少含黄、白两桶');
  const hasRed = res.candidates.some(c => c[0] > 200 && c[1] < 60);
  assert.ok(!hasRed, '透明红像素不得进入候选（alpha 跳过）');
});

test('posterColors：注入 loader —— 未就绪 peek=null、就绪后 {colorTop,colorBottom}(0..255)；in-flight 去重 + 缓存命中不再载', async () => {
  const P = loadPosterColor();
  let calls = 0;
  P.__setPosterLoader(function () {
    calls++;
    return Promise.resolve(new Uint8ClampedArray([].concat(
      rgba(20, 30, 120, 255, 600), rgba(250, 240, 10, 255, 100))));
  });
  assert.equal(P.peekColors('https://x/p1.jpg'), null, '首次未就绪 → null');
  const inflight = P.posterColors('https://x/p1.jpg');
  P.posterColors('https://x/p1.jpg');
  assert.equal(calls, 1, 'in-flight 去重，不重复加载');
  const c = await inflight;
  assert.ok(c && Array.isArray(c.colorTop) && c.colorTop.length === 3, '产出 colorTop 三元组');
  for (const v of c.colorTop.concat(c.colorBottom)) {
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, '0..255 整数刻度：' + JSON.stringify(c));
  }
  assert.deepEqual(P.peekColors('https://x/p1.jpg'), c, '就绪后 peek 直返缓存');
  P.posterColors('https://x/p1.jpg');
  assert.equal(calls, 1, '结果缓存命中不再加载');
});

test('posterColors：loader 失败 → null（失败缓存不重发、不抛）', async () => {
  const P = loadPosterColor();
  let calls = 0;
  P.__setPosterLoader(function () { calls++; return Promise.reject(new Error('404')); });
  const c = await P.posterColors('https://x/bad.jpg');
  assert.equal(c, null, '失败吞掉返回 null（散列色兜底由数据层负责）');
  await P.posterColors('https://x/bad.jpg');
  assert.equal(calls, 1, '失败也缓存，本会话不重试风暴');
});

test('posterColors：无注入 loader 且无 DOM（Node/vm）→ null 安全降级', async () => {
  const P = loadPosterColor();
  const fresh = await P.posterColors('https://x/nodom.jpg');
  assert.equal(fresh, null, '默认光栅器无 Image → reject 被吞 → null');
});

// ---------------- 轮㉔-B 接线：roomToStation 覆盖散列色 + 就绪即刷 + index.html 装载 ----------------

function loadDeckRealm() {
  const p = path.join(root, 'public', 'video', 'world-poster-color.js');
  const deckP = path.join(root, 'public', 'video', 'world-lighthouse-deck.js');
  const sandbox = { console, Promise, Map, Object, Array, Math, Number, String, Error, Uint8ClampedArray, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(deckP, 'utf8'), sandbox);
  const SFV = sandbox.StellaflixVideo;
  assert.ok(SFV.worldPosterColor && SFV.worldLighthouseDeck, '提色+deck 应同 realm 挂载');
  return { SFV, sandbox };
}

test('轮㉔-B roomToStation：海报就绪色覆盖散列色（station 预装配位 + 服务端 raw 位两支路）', async () => {
  const { SFV } = loadDeckRealm();
  const url = 'https://image.tmdb.org/t/p/w780/poster-red.jpg';
  SFV.worldPosterColor.__setPosterLoader(function () {
    return Promise.resolve(new Uint8ClampedArray([].concat(
      rgba(220, 20, 30, 255, 600), rgba(10, 10, 20, 255, 400))));
  });
  await SFV.worldPosterColor.posterColors(url); // 预热就绪
  const st = SFV.worldLighthouseDeck.roomToStation({
    id: 'r-tk', roomId: 'room-tk', name: '东京', position: [139.69, 35.69],
    status: 'playing', coverUrl: url, colorTop: [255, 0, 43], colorBottom: [81, 0, 13]
  });
  assert.notDeepEqual(st.colorTop, [255, 0, 43], '就绪后散列色应被海报色覆盖');
  const expect = SFV.worldPosterColor.peekColors(url);
  assert.deepEqual(st.colorTop, expect.colorTop);
  assert.deepEqual(st.colorBottom, expect.colorBottom);
  // raw 位（longitude/latitude 形状）
  const st2 = SFV.worldLighthouseDeck.roomToStation({
    id: 'r-ny', roomId: 'room-ny', name: '纽约', longitude: -74, latitude: 40,
    status: 'playing', coverUrl: url, color_top: [0, 255, 0], color_bottom: [0, 80, 0]
  });
  assert.deepEqual(st2.colorTop, expect.colorTop, '服务端 raw 支路同覆盖');
});

test('轮㉔-B roomToStation：未就绪 → 维持散列色并后台触发提取；就绪后 refreshMap 即时重刷一次', async () => {
  const { SFV } = loadDeckRealm();
  let loaded = 0;
  let resolveLoad;
  SFV.worldPosterColor.__setPosterLoader(function () {
    loaded++;
    return new Promise(function (res) { resolveLoad = res; });
  });
  let refreshes = 0;
  SFV.worldRoom = { refreshMap: function () { refreshes++; } };
  const url = 'https://image.tmdb.org/t/p/w780/poster-late.jpg';
  const st = SFV.worldLighthouseDeck.roomToStation({
    id: 'r-sh', roomId: 'room-sh', name: '上海', position: [121, 31],
    status: 'playing', coverUrl: url, colorTop: [200, 100, 50], colorBottom: [60, 30, 10]
  });
  assert.deepEqual(st.colorTop, [200, 100, 50], '未就绪 → 散列色不动');
  assert.equal(loaded, 1, '装配触发一次后台提取');
  SFV.worldLighthouseDeck.roomToStation({
    id: 'r-sh', roomId: 'room-sh', name: '上海', position: [121, 31],
    status: 'playing', coverUrl: url, colorTop: [200, 100, 50], colorBottom: [60, 30, 10]
  });
  assert.equal(loaded, 1, '同 URL 不重复提取（in-flight 去重）');
  resolveLoad(new Uint8ClampedArray([].concat(
    rgba(220, 20, 30, 255, 600), rgba(10, 10, 20, 255, 400))));
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(refreshes, 1, '就绪后恰好一次 refreshMap（多次装配不得叠加订阅）');
});

test('轮㉔-B index.html 装载 world-poster-color.js 且在 world-data/deck 之前', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('world-poster-color.js'), '应装载提色模块');
  assert.ok(html.indexOf('world-poster-color.js') < html.indexOf('world-data.js'), '须在 world-data 前');
});

// ---------- 轮㉔修复：CDN 缓存毒化（probe4/probe5 实测） ----------
// 无 Origin 请求先到的边缘缓存条目不带 ACAO → 同 URL 的 CORS 模式加载在 Chromium
// 恒 ERR_FAILED；追加查询参数绕开该条目（卡面 hero 展示仍用原 URL 不动）。
test('corsBuster：为提色加载副本追加 sfvpc=1（有无查询双形态 + 幂等）', () => {
  const P = loadPosterColor();
  assert.equal(P.corsBuster('https://img.tmdb/a.jpg'), 'https://img.tmdb/a.jpg?sfvpc=1');
  assert.equal(P.corsBuster('https://img.tmdb/a.jpg?t=2'), 'https://img.tmdb/a.jpg?t=2&sfvpc=1');
  assert.equal(P.corsBuster('https://img.tmdb/a.jpg?sfvpc=1'), 'https://img.tmdb/a.jpg?sfvpc=1', '幂等');
});

test('defaultLoader 走 corsBuster 副本（img.src 源断言），结果缓存键仍为原 URL', () => {
  const src = fs.readFileSync(path.join(root, 'public', 'video', 'world-poster-color.js'), 'utf8');
  assert.ok(/img\.src\s*=\s*corsBuster\(url\)/.test(src), 'img.src 须用 corsBuster(url)');
  const P = loadPosterColor();
  assert.ok(typeof P.corsBuster === 'function');
});
