'use strict';

/**
 * 世界页 M0 — Cesium 地球底座接入
 * 运行：node --test tests/world-cesium-m0.test.js
 *
 * 覆盖：加载链顺序 / CESIUM_BASE_URL / 懒加载 / 建毁生命周期 / 连切 20 次不泄漏
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function makeDom() {
  const nodes = [];
  function el(tag) {
    const n = {
      tagName: String(tag).toUpperCase(),
      className: '',
      id: '',
      innerHTML: '',
      textContent: '',
      src: '',
      style: {},
      parentNode: null,
      children: [],
      classList: {
        add() {}, remove() {}, toggle() {}, contains() { return false; }
      },
      setAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      getContext(kind) { return kind === 'webgl2' ? {} : null; },
      appendChild(c) {
        if (c && c.parentNode) c.parentNode.removeChild(c);
        this.children.push(c);
        if (c) c.parentNode = this;
        nodes.push(c);
        return c;
      },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        if (c) c.parentNode = null;
        return c;
      }
    };
    return n;
  }
  return {
    nodes,
    document: {
      createElement: el,
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      head: el('head'),
      body: el('body'),
      addEventListener() {}
    }
  };
}

// 浏览器沙箱：补齐 world-cesium 依赖的定时器等全局
function makeSandbox(dom) {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  sandbox.document = dom.document;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setImmediate = setImmediate;
  sandbox.Promise = Promise;
  return sandbox;
}

// 极简 Cesium 桩：只留 world-cesium 用得到的接口
function makeCesiumStub() {
  const log = { created: 0, destroyed: 0, layers: [] };
  class EllipsoidTerrainProvider {}
  class UrlTemplateImageryProvider {
    constructor(o) {
      this.options = o;
      log.layers.push({ kind: (o.url.indexOf('arcgisonline') >= 0 || o.url.indexOf('map-tile') >= 0) ? 'esri' : 'osm', url: o.url });
    }
  }
  class Viewer {
    constructor(container, options) {
      log.created++;
      this.container = container;
      this.options = options;
      this._destroyed = false;
      this.imageryLayers = {
        addImageryProvider(p) { log.layers.push({ kind: 'added', p }); }
      };
      this.scene = { skyAtmosphere: { show: true }, sun: { show: true } };
      this.camera = { setView() {} };
    }
    isDestroyed() { return this._destroyed; }
    destroy() {
      if (this._destroyed) throw new Error('double destroy');
      this._destroyed = true;
      log.destroyed++;
    }
  }
  return {
    log,
    Viewer,
    EllipsoidTerrainProvider,
    UrlTemplateImageryProvider,
    Cartesian3: { fromDegrees: (a, b, c) => ({ a, b, c }) }
  };
}

function loadWorldCesium(sandbox) {
  const code = read('public/video/_archive/world-cesium.js');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.StellaflixVideo.worldCesium;
}

function loadPageWorld(sandbox) {
  const code = read('public/video/page-world.js');
  vm.runInContext(code, sandbox);
  return sandbox.StellaflixVideo.router;
}

// 极简 maptiler-sdk/deck 桩：只留 world-globe 用得到的接口（步骤② 起底座为 @maptiler/sdk）
function makeGlobeStub() {
  const log = { created: 0, destroyed: 0, overlays: 0, finalized: 0, controls: 0 };
  class SdkMapStub {
    constructor(options) {
      log.created++;
      this.options = options;
      this._handlers = {};
      this._destroyed = false;
      this.canvasEl = { addEventListener() {}, removeEventListener() {} };
      this.dragRotate = { enable() {} };
      const self = this;
      // 步骤② 成功口径与 hearthere cd() 一致：'load' 即成（无 idle/dataCount 判定）
      setTimeout(function () { self.emit('load'); }, 0);
    }
    on(ev, h) { (this._handlers[ev] = this._handlers[ev] || []).push(h); }
    off(ev, h) {
      const arr = this._handlers[ev] || [];
      const i = arr.indexOf(h);
      if (i >= 0) arr.splice(i, 1);
    }
    emit(ev, e) { (this._handlers[ev] || []).slice().forEach(function (h) { h(e || {}); }); }
    addControl() { log.controls++; }
    flyTo(o) { this.lastFlyTo = o; return this; }
    resize() {}
    getStyle() { return { layers: [] }; }
    getLayoutProperty() { return undefined; }
    setLayoutProperty() {}
    getCanvas() { return this.canvasEl; }
    getZoom() { return 2.5; }
    getPitch() { return 0; }
    getBearing() { return 0; }
    getMaxPitch() { return 85; }
    remove() {
      if (this._destroyed) throw new Error('double remove');
      this._destroyed = true;
      log.destroyed++;
    }
  }
  class MapboxOverlayStub {
    constructor(options) { log.overlays++; this.options = options; }
    finalize() { log.finalized++; }
  }
  return {
    log,
    maptilerGlobe: { Map: SdkMapStub, config: {}, ready: Promise.resolve({}) },
    deck: { MapboxOverlay: MapboxOverlayStub }
  };
}

function loadWorldGlobe(sandbox) {
  if (!vm.isContext(sandbox)) vm.createContext(sandbox);
  vm.runInContext(read('public/video/world-globe.js'), sandbox);
  return sandbox.StellaflixVideo.worldGlobe;
}

// 推进若干宏任务：等 world-globe 的 vendor→建图→idle→then 链跑完
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

// Task 2 起底座换为 world-globe.js（world-cesium.js 仍在盘上，仅从启动链摘除）
test('index.html 按序加载 world-globe.js 与 page-world.js', () => {
  const html = read('public/index.html');
  const iWg = html.indexOf('"video/world-globe.js"');
  const iPw = html.indexOf('"video/page-world.js"');
  assert.ok(iWg >= 0, 'world-globe.js 应在 SFV_SCRIPTS 中');
  assert.ok(iPw >= 0, 'page-world.js 应在 SFV_SCRIPTS 中');
  assert.ok(iWg < iPw, 'world-globe.js 必须先于 page-world.js 加载');
  // 不应重复
  assert.strictEqual((html.match(/video\/world-globe\.js/g) || []).length, 1);
  assert.strictEqual((html.match(/video\/page-world\.js/g) || []).length, 1);
  assert.ok(!/video\/world-cesium\.js/.test(html), '启动链不得再加载 world-cesium.js');
});

test('world-cesium 懒加载：启动不拉 Cesium.js，mount 才拉', async () => {
  const dom = makeDom();
  const sandbox = makeSandbox(dom);
  sandbox.Cesium = undefined;

  const wc = loadWorldCesium(sandbox);
  assert.ok(wc, 'SFV.worldCesium 应已导出');

  // 此时不应有任何 script 注入
  const scripts = dom.document.head.children.filter((c) => c.tagName === 'SCRIPT');
  assert.strictEqual(scripts.length, 0, 'ensure 之前不应插入 script');

  // ensureBaseUrl 应写入全局
  const base = wc.ensureBaseUrl();
  assert.strictEqual(base, 'vendor/cesium/');
  assert.strictEqual(sandbox.CESIUM_BASE_URL, 'vendor/cesium/');

  // 注入脚本后应解析
  const cesium = makeCesiumStub();
  const p = wc.ensure();
  const scripts2 = dom.document.head.children.filter((c) => c.tagName === 'SCRIPT');
  assert.strictEqual(scripts2.length, 1, 'ensure 应插入 1 个 script');
  assert.strictEqual(scripts2[0].src, 'vendor/cesium/Cesium.js');

  // 模拟加载完成
  sandbox.Cesium = cesium;
  scripts2[0].onload();
  const got = await p;
  assert.strictEqual(got, cesium);

  // 二次 ensure 不重复插 script
  await wc.ensure();
  assert.strictEqual(
    dom.document.head.children.filter((c) => c.tagName === 'SCRIPT').length,
    1,
    '重复 ensure 不应重复插入 script'
  );
});

test('mount/unmount 生命周期：建一次毁一次，unmount 幂等', async () => {
  const dom = makeDom();
  const sandbox = makeSandbox(dom);

  const cesium = makeCesiumStub();
  sandbox.Cesium = cesium;

  const wc = loadWorldCesium(sandbox);
  const host = dom.document.createElement('div');

  await wc.mount(host);
  assert.strictEqual(cesium.log.created, 1, '应创建 1 个 viewer');
  assert.strictEqual(cesium.log.destroyed, 0);
  assert.ok(cesium.log.layers.some((l) => l.kind === 'esri'), '应挂 Esri 底图');

  wc.unmount();
  assert.strictEqual(cesium.log.destroyed, 1, 'unmount 应销毁 viewer');

  // 幂等：再调不应抛、不应重复 destroy
  wc.unmount();
  wc.unmount();
  assert.strictEqual(cesium.log.destroyed, 1, '重复 unmount 不应重复销毁');

  const st = wc.getState();
  assert.strictEqual(st.hasViewer, false);
});

test('连切 20 次：每次建毁配对，无残留 viewer', async () => {
  const dom = makeDom();
  const sandbox = makeSandbox(dom);

  const cesium = makeCesiumStub();
  sandbox.Cesium = cesium;

  const wc = loadWorldCesium(sandbox);

  for (let i = 0; i < 20; i++) {
    const host = dom.document.createElement('div');
    await wc.mount(host);
    assert.strictEqual(cesium.log.created, i + 1, `第 ${i + 1} 次应创建 viewer`);
    wc.unmount();
    assert.strictEqual(cesium.log.destroyed, i + 1, `第 ${i + 1} 次应销毁 viewer`);
    assert.strictEqual(wc.getState().hasViewer, false, `第 ${i + 1} 次 unmount 后不应有 viewer`);
  }
  assert.strictEqual(cesium.log.created, 20);
  assert.strictEqual(cesium.log.destroyed, 20);
});

test('mount 中途 unmount：Cesium 就绪后不应创建已卸载实例', async () => {
  const dom = makeDom();
  const sandbox = makeSandbox(dom);
  const cesium = makeCesiumStub();
  // 不预置 Cesium：让 ensureCesium 走脚本注入，制造异步竞态窗口
  sandbox.Cesium = undefined;

  const wc = loadWorldCesium(sandbox);
  const host = dom.document.createElement('div');
  const p = wc.mount(host);

  // ensureCesium 已插入 script 但尚未 onload
  const scripts = dom.document.head.children.filter((c) => c.tagName === 'SCRIPT');
  assert.strictEqual(scripts.length, 1);

  // 立刻 unmount（用户切走世界页）
  wc.unmount();

  // 之后 Cesium 才加载完成
  sandbox.Cesium = cesium;
  scripts[0].onload();
  const info = await p;

  assert.strictEqual(info, null, '已卸载时 mount 应返回 null');
  assert.strictEqual(cesium.log.created, 0, '不应为已卸载实例创建 viewer');
  assert.strictEqual(wc.getState().hasViewer, false);
});

// Task 2：page-world 底座调用从 worldCesium 换到 worldGlobe，本测试随迁
test('page-world.js 走 worldGlobe.mount/unmount，切页后丢弃过期回调', async () => {
  const dom = makeDom();
  const sandbox = makeSandbox(dom);

  const globe = makeGlobeStub();
  sandbox.deck = globe.deck;
  sandbox.fetch = function () {
    return Promise.resolve({
      ok: true,
      text: function () {
        return Promise.resolve(JSON.stringify({ version: 8, projection: { type: 'globe' }, sources: {}, layers: [] }));
      }
    });
  };

  const registered = [];
  sandbox.StellaflixVideo = {
    maptilerGlobe: globe.maptilerGlobe,
    router: {
      register(p) { registered.push(p); },
      go() {},
      currentId() { return 'world'; }
    },
    ui: { setTitle() {} }
  };

  loadWorldGlobe(sandbox);
  registered.length = 0;
  const page = (function () {
    const code = read('public/video/page-world.js');
    const before = sandbox.StellaflixVideo.router.register;
    sandbox.StellaflixVideo.router.register = (p) => registered.push(p);
    vm.runInContext(code, sandbox);
    sandbox.StellaflixVideo.router.register = before;
    return registered[0];
  })();

  assert.ok(page, 'page-world 应注册路由页');
  assert.strictEqual(page.id, 'world');

  const host = dom.document.createElement('div');
  page.mount(host, {});
  await flush();
  assert.strictEqual(globe.log.created, 1, 'mount 应创建 maplibre Map');
  assert.strictEqual(globe.log.overlays, 1, 'mount 应挂 deck MapboxOverlay');

  // 切走
  page.unmount();
  await flush();
  assert.strictEqual(globe.log.destroyed, 1, 'unmount 应销毁地图');
  assert.strictEqual(globe.log.finalized, 1, 'unmount 应 finalize overlay');

  // 再进再出
  const host2 = dom.document.createElement('div');
  page.mount(host2, {});
  await flush();
  page.unmount();
  await flush();
  assert.strictEqual(globe.log.created, 2);
  assert.strictEqual(globe.log.destroyed, 2);
});

test('config.js 不含任何地图厂商密钥', () => {
  const src = read('public/video/lighthouse/config.js');
  assert.ok(!/nMcdjIXAW4OMjZZnckds/.test(src), '不得出现 MapTiler 密钥');
  assert.ok(!/mapTilerKey/.test(src), '不应再有 mapTilerKey 字段');
  assert.match(src, /MAP_CONFIG\.basemap = LH\.MAP_CONFIG\.basemap \|\| 'esri'/);
  assert.match(src, /cesiumToken/);
  assert.match(src, /googleKey/);
});

test('地形三档：keyless 真实地形优先，回退纯平面', () => {
  const src = read('public/video/_archive/world-cesium.js');
  // 1) keyless 真实地形（Re:Earth / Mapterhorn，CC BY 4.0，免 token）
  assert.match(src, /terrain\.reearth\.land\/cesium-mesh\/ellipsoid/);
  assert.match(src, /CesiumTerrainProvider\.fromUrl/);
  // 2) 有 ion token → Cesium World Terrain
  assert.match(src, /createWorldTerrainAsync/);
  // 3) 兜底纯平面
  assert.match(src, /new C\.EllipsoidTerrainProvider\(\)/);
  // 失败必须回退，不得抛裸异常
  assert.match(src, /keyless 地形不可用，回退纯平面/);
});

test('Google 3D Tiles 是「用户自填 key 才启用」的可选增强', () => {
  const src = read('public/video/_archive/world-cesium.js');
  assert.match(src, /attachGoogle3D/);
  assert.match(src, /if \(!cfg\.googleKey\) return null/);
  assert.match(src, /tile\.googleapis\.com\/v1\/3dtiles\/root\.json/);
  assert.match(src, /Cesium3DTileset\.fromUrl/);
  // 不得硬编码任何 key
  assert.ok(!/key=[A-Za-z0-9_-]{10,}/.test(src), '不得硬编码 Google key');
});

test('地形/3D 是异步升级，不阻塞首屏', () => {
  const src = read('public/video/_archive/world-cesium.js');

  // 顺序契约：先解析地形 → 再建 viewer → 最后铺影像
  // （建完 viewer 再换 terrainProvider 会触发地球重铺，影像层会丢——实测踩过）
  assert.match(src, /先解析地形，再建 viewer，最后铺影像/);
  assert.match(src, /createViewer\(hostEl, C, tr\.provider\)/);
  // 顺序契约：先解析地形 → 再建 viewer → 最后铺影像
  // （建完 viewer 再换 terrainProvider 会触发地球重铺，影像层会丢——实测踩过）
  assert.match(src, /先解析地形，再建 viewer，最后铺影像/);
  assert.match(src, /createViewer\(hostEl, C, tr\.provider\)/);
  // resolveTerrain 后替换
  assert.ok(!/v\.terrainProvider\s*=/.test(src), '不得运行时换 terrainProvider（会丢影像层）');
  // 竞态守卫：切换页面后不再写入（mountToken 变更即视为已卸载）
  assert.match(src, /if \(token !== mountToken\) return null/);
  // 导出诊断口
  assert.match(src, /resolveTerrain: resolveTerrain/);
  assert.match(src, /KEYLESS_TERRAIN_URL/);
});

test('world-params 记录地形与 3D 建筑的能力与合规边界', () => {
  const src = read('public/video/world-params.js');
  assert.match(src, /TERRAIN|terrain/i);
  assert.match(src, /BUILDINGS|buildings/i);
  // 合规边界：ion 个人非商业 / Google 计费
  assert.match(src, /非商业|non-commercial/i);
  assert.match(src, /计费|metered/i);
});

test('Cesium 预构建产物已 vendor 到位', () => {
  const dir = path.join(root, 'public/vendor/cesium');
  for (const f of ['Cesium.js', 'Widgets/widgets.css']) {
    const p = path.join(dir, f);
    assert.ok(fs.existsSync(p), `${f} 应存在于 public/vendor/cesium/`);
    assert.ok(fs.statSync(p).size > 1000, `${f} 不应是空文件`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'Workers')), 'Workers/ 应存在');
  assert.ok(fs.existsSync(path.join(dir, 'Assets')), 'Assets/ 应存在');
  const main = fs.statSync(path.join(dir, 'Cesium.js')).size;
  assert.ok(main > 4_000_000, `Cesium.js 体积异常: ${main}`);
});

test('影像瓦片走本地代理（消除 CORS / Map data not yet available）', () => {
  const cs = read('public/video/_archive/world-cesium.js');
  // 应指向本地代理，不再直连 server.arcgisonline.com
  assert.match(cs, /\/api\/map-tile\//);
  assert.ok(!/server\.arcgisonline\.com/.test(cs), '不得直连 Esri 瓦片域名');
  // server.js 提供瓦片代理 + 内存缓存
  const sv = read('server.js');
  assert.match(sv, /\/api\/map-tile\//);
  assert.match(sv, /mapTileCache/);
  assert.match(sv, /server\.arcgisonline\.com/);
});

test('行政边界层：步骤②停挂 → 步骤⑤归档（MapTiler HearThereMap 样式自带国界）', () => {
  // 模块已移入 _archive（留档不删），留档面仍可解析
  const bw = read('public/video/_archive/world-boundaries.pre-hearthere-20260930.js');
  assert.match(bw, /worldBoundaries/);
  assert.match(bw, /addSource/);
  assert.match(bw, /addLayer/);
  // 装载链不得再引用（步骤⑤）；globe 仍在
  const html = read('public/index.html');
  assert.ok(!/video\/world-boundaries\.js"/.test(html), '步骤⑤：boundaries 不得再进 SFV_SCRIPTS');
  assert.ok(html.indexOf('world-globe.js') >= 0, 'globe 仍应在 SFV_SCRIPTS');
  assert.ok(!/video\/world-lighthouse\.js"/.test(html), 'world-lighthouse.js 已归档（_archive/），启动链不得再引用');
  // page-world 挂载/卸载（步骤② 反转：MapTiler 样式自带国界，自绘边界层已停挂）
  const pw = read('public/video/page-world.js');
  assert.ok(!/worldBoundaries\.mount/.test(pw), '步骤②：page-world 不得再挂 worldBoundaries');
  assert.ok(!/worldBoundaries\.unmount/.test(pw), '步骤②：unmount 链同步摘除');
  // 边界 GeoJSON 数据资产保留（公共数据，不随代码归档）
  for (const f of ['world-countries.geojson', 'china-provinces.geojson', 'china-cities.geojson']) {
    const p = path.join(root, 'public/data/boundaries', f);
    assert.ok(fs.existsSync(p), `${f} 应存在`);
    assert.ok(fs.statSync(p).size > 50, `${f} 不应是空文件`);
  }
});
