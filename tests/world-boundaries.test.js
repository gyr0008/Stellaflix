'use strict';

/**
 * 世界页 Task 5 — 边界层 Cesium→MapLibre 移植（public/video/world-boundaries.js）
 * 运行：node --test tests/world-boundaries.test.js
 *
 * 仓内惯例（tests/world-globe.test.js）：jsdom/node 无 WebGL/无真实 maplibre，
 * 用 vm 沙箱装载真实模块源码，注入「假 maplibre map」（记录
 * addSource/addLayer/removeLayer/removeSource 调用）+ stub 全局 fetch
 * （按 URL 子串返回罐头 geojson），直接跑模块的真实管线逻辑。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---------------- 假 maplibre map ----------------

// 假 map 可选面：
//  - styleLoaded:false → 带 isStyleLoaded()/styledata 事件的「样式未就绪」map
//  - failOn:'addSource'|'addLayer' → 对应操作恒抛（持续失败面）
function makeFakeMap(opts) {
  opts = opts || {};
  const calls = [];
  const sources = new Map();
  const layers = new Map();
  const handlers = {};
  let styleLoaded = opts.styleLoaded !== false;
  const map = {
    addSource(id, data) {
      if (opts.failOn === 'addSource') throw new Error('addSource boom ' + id);
      if (sources.has(id)) throw new Error('duplicate source: ' + id);
      calls.push({ op: 'addSource', id, args: data });
      sources.set(id, data);
    },
    addLayer(layer) {
      if (opts.failOn === 'addLayer') throw new Error('addLayer boom ' + layer.id);
      if (!sources.has(layer.source)) throw new Error('missing source for layer: ' + layer.id);
      if (layers.has(layer.id)) throw new Error('duplicate layer: ' + layer.id);
      calls.push({ op: 'addLayer', id: layer.id, args: layer });
      layers.set(layer.id, layer);
    },
    removeLayer(id) { calls.push({ op: 'removeLayer', id }); layers.delete(id); },
    removeSource(id) { calls.push({ op: 'removeSource', id }); sources.delete(id); },
    getLayer(id) { return layers.get(id) || null; },
    getSource(id) { return sources.get(id) || null; },
    setLayoutProperty() {},
    getZoom() { return 2.5; },
    on(ev, h) { (handlers[ev] = handlers[ev] || []).push(h); },
    off(ev, h) {
      const arr = handlers[ev] || [];
      const i = arr.indexOf(h);
      if (i >= 0) arr.splice(i, 1);
    },
    emit(ev, e) { (handlers[ev] || []).slice().forEach((h) => h(e || {})); },
    setStyleLoaded(v) { styleLoaded = v; },
    get styleDataHandlers() { return handlers; }
  };
  if (opts.styleLoaded === false || opts.alwaysStyleCheck) {
    map.isStyleLoaded = () => styleLoaded;
  }
  return { map, calls, sources, layers };
}

// ---------------- fetch stub（按 URL 子串返回罐头 geojson） ----------------

function cannedGeojson(tag) {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { name: tag },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [2, 0], [0, 0]]] }
    }]
  };
}

// mode 'auto'：立即 resolve；mode 'manual'：由返回的 resolve(url) 控制兑现时机
function makeFetchStub(mode) {
  const urls = [];
  const pending = [];
  const fetchImpl = function (url) {
    urls.push(url);
    const kind = /world-countries/.test(url) ? 'country'
      : /china-provinces/.test(url) ? 'province'
      : /china-cities/.test(url) ? 'city' : 'unknown';
    const body = cannedGeojson(kind);
    if (mode === 'manual') {
      let release;
      const p = new Promise((res) => { release = res; });
      pending.push({ url, kind, resolve: () => release({
        ok: true, status: 200, json: () => Promise.resolve(body)
      }) });
      return p;
    }
    return Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(body)
    });
  };
  return { fetchImpl, urls, pending };
}

function loadBoundaries(fetchImpl, consoleStub) {
  const sandbox = { console: consoleStub || console, Promise, fetch: fetchImpl };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/world-boundaries.js'), sandbox);
  return sandbox.StellaflixVideo.worldBoundaries;
}

const flush = async (n) => {
  for (let i = 0; i < (n || 20); i++) await new Promise((r) => setImmediate(r));
};

// ---------------- Step 1：三档 line layer + 缩放分带 ----------------

test('mount(map)：三档边界以 line layer 注入，minzoom 严格递增，样式为白色半透明', async () => {
  const { map, calls } = makeFakeMap();
  const stub = makeFetchStub('auto');
  const bw = loadBoundaries(stub.fetchImpl);
  bw.mount(map);
  await flush();

  const adds = calls.filter((c) => c.op === 'addSource');
  assert.strictEqual(adds.length, 3, '三档应各注入一个 geojson source');
  adds.forEach((s) => {
    assert.strictEqual(s.args.type, 'geojson', 'source 应为 geojson 类型');
    assert.strictEqual(s.args.data.type, 'FeatureCollection', 'fetch 到的 geojson 应原样入源');
  });

  const lines = calls.filter((c) => c.op === 'addLayer');
  assert.strictEqual(lines.length, 3, '三档应各注入一个 layer');
  assert.ok(lines.every((c) => c.args.type === 'line'), 'layer type 应全为 line');
  // 档位顺序 country → province → city：minzoom 严格递增（远景只见国家界）
  assert.ok(lines[0].args.minzoom < lines[1].args.minzoom, 'province minzoom 应高于 country');
  assert.ok(lines[1].args.minzoom < lines[2].args.minzoom, 'city minzoom 应高于 province');
  lines.forEach((c) => {
    assert.ok(c.args.maxzoom > c.args.minzoom, 'maxzoom 应高于本档 minzoom');
    assert.ok(c.args.maxzoom >= 18, '近景不得截断（原 Cesium 近档无上限）');
  });

  // 样式移植：白色系 + 半透明 + 原线宽常量（country #ffffff / 0.70 / 2.5）
  const byId = {};
  lines.forEach((c) => { byId[c.id] = c.args; });
  const country = byId[Object.keys(byId).find((k) => /country/.test(k))];
  assert.strictEqual(country.paint['line-color'], '#ffffff', '国家界应为白色');
  assert.strictEqual(country.paint['line-opacity'], 0.70, 'alpha 0.70 从原 stroke[3] 移植');
  assert.strictEqual(country.paint['line-width'], 2.5, 'line-width 从原 strokeWidth 移植');
  lines.forEach((c) => {
    assert.ok(c.args.paint['line-opacity'] > 0 && c.args.paint['line-opacity'] < 1,
      '三档均应为半透明（对齐现观感）');
  });
});

// ---------------- (b) unmount 精确回收 ----------------

test('unmount：恰好移除本次注入的全部 layer+source，无遗漏无多删', async () => {
  const { map, calls, sources, layers } = makeFakeMap();
  const stub = makeFetchStub('auto');
  const bw = loadBoundaries(stub.fetchImpl);
  bw.mount(map);
  await flush();

  const addedLayers = calls.filter((c) => c.op === 'addLayer').map((c) => c.id).sort();
  const addedSources = calls.filter((c) => c.op === 'addSource').map((c) => c.id).sort();
  assert.strictEqual(addedLayers.length, 3);
  assert.strictEqual(addedSources.length, 3);

  bw.unmount();
  const removedLayers = calls.filter((c) => c.op === 'removeLayer').map((c) => c.id).sort();
  const removedSources = calls.filter((c) => c.op === 'removeSource').map((c) => c.id).sort();
  assert.deepStrictEqual(removedLayers, addedLayers, 'removeLayer 应精确覆盖 addLayer 集');
  assert.deepStrictEqual(removedSources, addedSources, 'removeSource 应精确覆盖 addSource 集');
  assert.strictEqual(layers.size, 0, '假 map 上不应残留 layer');
  assert.strictEqual(sources.size, 0, '假 map 上不应残留 source');

  // unmount 幂等：重复调用不得再发移除、不得抛
  bw.unmount();
  assert.strictEqual(calls.filter((c) => c.op === 'removeLayer').length, 3);
});

// ---------------- (c) stale guard：unmount 后迟到的 fetch 不得注层 ----------------

test('stale guard：unmount 之后 fetch 才 resolve，不得再注入任何 layer/source', async () => {
  const { map, calls } = makeFakeMap();
  const stub = makeFetchStub('manual');
  const bw = loadBoundaries(stub.fetchImpl);
  bw.mount(map);
  await flush();
  assert.strictEqual(calls.length, 0, 'fetch 未兑现前不应有注入');

  bw.unmount();
  stub.pending.forEach((p) => p.resolve());
  await flush(30);

  assert.strictEqual(calls.filter((c) => c.op === 'addSource').length, 0,
    '过期 fetch 兑现后不得 addSource');
  assert.strictEqual(calls.filter((c) => c.op === 'addLayer').length, 0,
    '过期 fetch 兑现后不得 addLayer');
});

// ---------------- (d) 双 mount 去重（unmount-first 语义）+ dataCache 免重拉 ----------------

test('重复 mount 不重复挂源：第二次 mount 先清第一轮，活集恒为 3；geojson 走 dataCache 不重拉', async () => {
  const { map, calls, sources, layers } = makeFakeMap();
  const stub = makeFetchStub('auto');
  const bw = loadBoundaries(stub.fetchImpl);
  bw.mount(map);
  await flush();
  bw.mount(map); // 不先 unmount，直接重挂
  await flush();

  assert.strictEqual(sources.size, 3, '活 source 恒为 3（假 map 重复 id 会抛，能跑完即去重成功）');
  assert.strictEqual(layers.size, 3, '活 layer 恒为 3');
  assert.strictEqual(calls.filter((c) => c.op === 'addSource').length, 6, '两轮各注入 3 个');
  assert.strictEqual(calls.filter((c) => c.op === 'removeSource').length, 3,
    '第二轮 mount 前应已 unmount-first 清掉第一轮');
  // Task 6 携带修复（行为反转，原为两轮 6 fetch）：
  // dataCache[kind] 命中后第二轮直接渲染缓存，页面重进不再重拉 ~2.5MB geojson。
  assert.strictEqual(stub.urls.length, 3,
    'fetch 只发生第一轮 3 次；第二轮由模块级 dataCache 供数据');
});

// ---------------- Task 6 携带修复 1：dataCache 跨「换图重进」存活 ----------------

test('dataCache：unmount 换新 map 重进，从缓存渲染（fetch 总量仍 3），注入落在新 map 上', async () => {
  const first = makeFakeMap();
  const stub = makeFetchStub('auto');
  const bw = loadBoundaries(stub.fetchImpl);
  bw.mount(first.map);
  await flush();
  assert.strictEqual(stub.urls.length, 3);

  bw.unmount();
  const second = makeFakeMap();
  bw.mount(second.map);
  await flush();

  assert.strictEqual(stub.urls.length, 3, '重进页面不得重拉 geojson');
  assert.strictEqual(second.calls.filter((c) => c.op === 'addSource').length, 3,
    '第二轮仍要把三档源注进新 map');
  assert.strictEqual(second.layers.size, 3);
  bw.unmount();
});

// ---------------- Task 6 携带修复 2：renderBoundary 样式守卫（styledata 后补渲染） ----------------

test('样式守卫：isStyleLoaded=false 时不注层，等 styledata 事件后从缓存补渲染', async () => {
  const { map, calls, layers } = makeFakeMap({ styleLoaded: false });
  const stub = makeFetchStub('auto');
  const bw = loadBoundaries(stub.fetchImpl);
  bw.mount(map);
  await flush();

  assert.strictEqual(calls.filter((c) => c.op === 'addSource').length, 0,
    '样式未就绪时不得 addSource（maplibre 此时加层会抛）');
  assert.ok((map.styleDataHandlers['styledata'] || []).length >= 1,
    '应挂一次性 styledata 等待');

  map.setStyleLoaded(true);
  map.emit('styledata');
  await flush();

  assert.strictEqual(calls.filter((c) => c.op === 'addSource').length, 3, 'styledata 后补渲染三档');
  assert.strictEqual(calls.filter((c) => c.op === 'addLayer').length, 3);
  assert.strictEqual(layers.size, 3);
  assert.strictEqual(stub.urls.length, 3, '补渲染消费 dataCache，不二次 fetch');
  bw.unmount();
});

// ---------------- Task 6 携带修复 3：持续失败要「 surfaces」而非静默 ----------------

test('addLayer 持续失败：console.error 上报 + promise 清空成可重试态；重挂走缓存成功', async () => {
  const errors = [];
  const errConsole = {
    log() {}, warn() {}, error() { errors.push(Array.prototype.join.call(arguments, ' ')); }
  };
  const broken = makeFakeMap({ failOn: 'addLayer' });
  const stub = makeFetchStub('auto');
  const bw = loadBoundaries(stub.fetchImpl, errConsole);
  bw.mount(broken.map);
  await flush();

  assert.ok(errors.length >= 3, `三档各上报一次持续失败，实际 ${errors.length}`);
  assert.ok(errors.some((e) => /addLayer/.test(e)) && errors.some((e) => /country|province|city/.test(e)),
    '错误信息应含失败环节与档位');

  // 可重试：修好渲染面后重挂同一 map 面 → 从 dataCache 渲染成功，不再 fetch
  broken.map.addLayer = makeFakeMap().map.addLayer; // 去掉 boom
  const fixed = makeFakeMap();
  bw.mount(fixed.map);
  await flush();

  assert.strictEqual(fixed.layers.size, 3, '重试应把三档补回来');
  assert.strictEqual(stub.urls.length, 3, '重试不得重拉 geojson（dataCache）');
  bw.unmount();
});

// ---------------- Fix round 1 / I-1：cache 支路挂载 seq 守卫 ----------------

const KINDS_OK = ['country', 'province', 'city'];

test('Fix round 1 (I-1)：同 tick unmount+remount，dataCache 支路的过期渲染不得打上新图（每档恰渲染一次，无 duplicate 报错）', async () => {
  const errors = [];
  const errConsole = {
    log() {}, warn() {}, error() { errors.push(Array.prototype.join.call(arguments, ' ')); }
  };
  const a = makeFakeMap();
  const stub = makeFetchStub('auto');
  const bw = loadBoundaries(stub.fetchImpl, errConsole);
  bw.mount(a.map);
  await flush();
  bw.unmount();
  assert.strictEqual(stub.urls.length, 3, '前置：首轮 fetch 已把 dataCache 灌满');

  // 同一 tick 内：挂 b → 立刻 unmount+remount 到 c。b 代排队的 cache 渲染
  // 是微任务，兑现时模块 map 已是 c —— 无 seq 守卫则 b 支路先渲染成功、
  // c 支路自己再渲染即撞 duplicate addSource → failRender 冒 console.error。
  const b = makeFakeMap();
  const c = makeFakeMap();
  bw.mount(b.map);
  bw.unmount();
  bw.mount(c.map);
  await flush();

  assert.strictEqual(b.calls.filter((x) => x.op === 'addSource').length, 0, 'b 图从未存活，不得有注入');
  assert.strictEqual(c.calls.filter((x) => x.op === 'addSource').length, 3, 'c 图上每档恰注入一次');
  assert.strictEqual(c.calls.filter((x) => x.op === 'addLayer').length, 3);
  assert.deepStrictEqual(errors, [], '过期渲染不得触发 duplicate-addSource 报错');
  KINDS_OK.forEach((k) => {
    const e = bw.layers[k];
    assert.strictEqual(e.loaded, true, k + ' 正常渲染完成，不得被打成失败态');
    assert.strictEqual(e.renderFailed, false, k + ' 不得进入伪「可重试失败」态');
  });
  assert.strictEqual(stub.urls.length, 3, '全程零重拉（cache 供数据）');
  bw.unmount();
});

// ---------------- Fix round 1 / I-1：styledata 等待一次性化 + 身份校验 ----------------

test('Fix round 1 (I-1)：styledata  waiter 触发后必须自摘（off after fire），旧图不得残留监听', async () => {
  const { map, calls } = makeFakeMap({ styleLoaded: false });
  const stub = makeFetchStub('auto');
  const bw = loadBoundaries(stub.fetchImpl);
  bw.mount(map);
  await flush();

  assert.strictEqual((map.styleDataHandlers['styledata'] || []).length, 3,
    '三档各挂一个一次性等待');
  map.setStyleLoaded(true);
  map.emit('styledata');
  await flush();

  assert.strictEqual(calls.filter((c) => c.op === 'addSource').length, 3, '事件后照常补渲染');
  assert.strictEqual((map.styleDataHandlers['styledata'] || []).length, 0,
    '触发即 off：不得留匿名监听在图上');
  bw.unmount();
});

test('Fix round 1 (I-1)：旧 map 残存的 styledata 监听被唤醒时，不得搅动/重复渲染新 map', async () => {
  const errors = [];
  const errConsole = {
    log() {}, warn() {}, error() { errors.push(Array.prototype.join.call(arguments, ' ')); }
  };
  const stub = makeFetchStub('auto');
  const bw = loadBoundaries(stub.fetchImpl, errConsole);

  const oldMap = makeFakeMap({ styleLoaded: false });
  bw.mount(oldMap.map);
  await flush(); // fetch 兑现 → 样式未就绪 → oldMap 上 arm 三监听
  bw.unmount();

  const next = makeFakeMap({ styleLoaded: false });
  bw.mount(next.map);
  await flush(); // cache 支路 → next 上 arm 三监听

  // 旧图监听被唤醒（maplibre 样式切换可再派发）：有身份校验则整段止步
  oldMap.map.setStyleLoaded(true);
  oldMap.map.emit('styledata');
  await flush();
  assert.strictEqual((next.map.styleDataHandlers['styledata'] || []).length, 3,
    '过期监听不得顶掉 entry.styleWaitArmed 导致新图重复 arm');

  next.map.setStyleLoaded(true);
  next.map.emit('styledata');
  await flush();
  assert.strictEqual(next.calls.filter((c) => c.op === 'addSource').length, 3, '新图恰渲染一次');
  assert.strictEqual(next.calls.filter((c) => c.op === 'addLayer').length, 3);
  assert.deepStrictEqual(errors, [], '不得出现 duplicate 注入报错');
  bw.unmount();
});

// ---------------- 防御：非 maplibre map 输入静默降级 ----------------

test('mount(null)/mount(旧 Cesium adapter 面)：无 addSource 面时静默 no-op', async () => {
  const stub = makeFetchStub('auto');
  const bw = loadBoundaries(stub.fetchImpl);
  bw.mount(null);
  bw.mount({ camera: {}, scene: {} }); // 旧 viewer 形状：不应抛、不应注层
  await flush();
  assert.ok(true);
  bw.unmount();
});

// ---------------- 接线：步骤② 退役（MapTiler HearThereMap 样式自带国界） ----------------

test('步骤②：page-world 不再挂载 worldBoundaries（自绘边界层停挂，模块留档待步骤⑤归档）', () => {
  const pw = read('public/video/page-world.js');
  assert.ok(!/worldBoundaries\.mount/.test(pw),
    'page-world 不得再调 boundaries.mount（双重描线消除）');
  assert.ok(!/worldBoundaries\.unmount/.test(pw), 'unmount 链同步摘除');
});

// ---------------- 语法合法 ----------------

test('world-boundaries.js 语法合法', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['--check', path.join(root, 'public/video/world-boundaries.js')], {
    encoding: 'utf8', stdio: 'pipe'
  });
});
