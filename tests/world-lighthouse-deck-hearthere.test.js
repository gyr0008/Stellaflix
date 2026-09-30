'use strict';

/**
 * 世界页 步骤③ — 灯塔层 hearthere 保真（public/video/world-lighthouse-deck.js）
 * 运行：node --test tests/world-lighthouse-deck-hearthere.test.js
 *
 * 基准：_scratch/hearthere/main.pretty.js（2026-09-27 线上包）
 *   · 常量 :10609-10611（St=12.5 / xt=1 / sc=11.5）、:10951-10969（xr.meshScale→Hr=25）、
 *     :5581-5582（Or/Vl）、:13168-13178（Zm/Xm/Jm 预热）、:13262（展开谓词）
 *   · ds()/Sr() 光晕↔细节交叉淡出 :10613-10635
 *   · OBJ 管线 cc()/Gh() :11323-11336（缓存 promise + 就绪前传 URL）
 *   · rim 层 Qh/zo() :11342-11536（GLSL 逐字：modelHeight 9.22、扫描带 -3→13、无 discard）
 *   · 光晕层 rc/Ah/Dh :10804-11015（bh 月球遮挡 + Sh 星点 + Ph zoom 淡出 + presenceGlow uniform）
 *   · 组装顺序 ht() :13462-13546（glow → warmup → Bt 门限 → expanded-batch）
 *
 * 风格：仓内惯例——纯函数直连 require；GLSL/props/组装用 vm 沙箱装载真实模块断言行为，
 *       源码正则只兜字符串常量（GLSL）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const MODULE_PATH = path.join(root, 'public', 'video', 'world-lighthouse-deck.js');
const API = require(MODULE_PATH);
const SRC = fs.readFileSync(MODULE_PATH, 'utf8');

// 注释剥离（负面正则专用，防止把「退役说明」当实现命中）
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------------------------
// 1) 逐字常量
// ---------------------------------------------------------------------------

test('zoom 分档常量逐字：St=12.5 / xt=1（:10609-10611）', () => {
  assert.strictEqual(API.TIER_ZOOM, 12.5);
  assert.strictEqual(API.TIER_FADE, 1);
  // sc = St - xt - 0.5 = 11（光晕独立淡出起点，步骤③以 ds/Sr 为准，sc 仅 pin 常量）
  assert.strictEqual(API.GLOW_PRELOAD_ZOOM, 11);
});

test('尺寸/颜色/预热常量逐字：Hr=25、Or/Vl、Zm/Xm/Jm（:10951-10969 / :5581 / :13168-13178）', () => {
  assert.strictEqual(API.RIM_SIZE_SCALE, 25); // In=5e4 × Mt=5e-4
  assert.deepStrictEqual(API.COLOR_TOP_DEFAULT, [223, 204, 251]);
  assert.deepStrictEqual(API.COLOR_BOTTOM_DEFAULT, [150, 200, 254]);
  assert.strictEqual(API.WARMUP.id, 'lighthouse-warmup-layer');
  assert.strictEqual(API.WARMUP.opacity, 0.001);
  assert.deepStrictEqual(API.WARMUP.data, [{
    id: '__lighthouse-warmup__',
    position: [0, 0],
    name: 'Lighthouse warmup',
    status: 'offline',
    ownerType: 'system',
    colorTop: [255, 255, 255],
    colorBottom: [255, 255, 255]
  }]);
});

// ---------------------------------------------------------------------------
// 2) 纯函数：ds()/Sr()/展开谓词
// ---------------------------------------------------------------------------

test('detailOpacity/glowOpacity 交叉淡出逐字（ds() :10613-10631）', () => {
  assert.strictEqual(API.detailOpacity(10), 0);
  assert.strictEqual(API.detailOpacity(11.5), 0);
  assert.strictEqual(API.detailOpacity(12.5), 0.5);
  assert.strictEqual(API.detailOpacity(13.5), 1);
  assert.strictEqual(API.detailOpacity(20), 1);
  assert.strictEqual(API.glowOpacity(10), 1);
  assert.strictEqual(API.glowOpacity(12.5), 0.5);
  assert.strictEqual(API.glowOpacity(13.5), 0);
});

test('Bt 门限逐字：zoom>=11.5 || detailOpacity>0.01（Sr() :10633-10635）', () => {
  assert.strictEqual(API.detailVisible(11.4, 0), false);
  assert.strictEqual(API.detailVisible(11.5, 0), true);  // >= 含等号
  assert.strictEqual(API.detailVisible(10, 0.02), true); // 淡出未归零仍保留塔身
  assert.strictEqual(API.detailVisible(10, 0.01), false);// > 不含等号
});

test('expanded 谓词逐字（:13262）：alwaysExpanded || (displayKind ?? ownerType)==="system" || hostUserId===me', () => {
  assert.strictEqual(API.isExpandedRecord({ id: 'a', alwaysExpanded: true }, null), true);
  assert.strictEqual(API.isExpandedRecord({ id: 'b', ownerType: 'system' }, null), true);
  assert.strictEqual(API.isExpandedRecord({ id: 'c', displayKind: 'system', ownerType: 'user' }, null), true);
  // displayKind 优先于 ownerType：displayKind!=='system' 时即便 ownerType==='system' 也不展开
  assert.strictEqual(API.isExpandedRecord({ id: 'd', displayKind: 'user', ownerType: 'system' }, null), false);
  assert.strictEqual(API.isExpandedRecord({ id: 'e', ownerType: 'user', hostUserId: 'me1' }, 'me1'), true);
  assert.strictEqual(API.isExpandedRecord({ id: 'f', ownerType: 'user', hostUserId: 'me1' }, 'me2'), false);
  assert.strictEqual(API.isExpandedRecord({ id: 'g', ownerType: 'user' }, null), false);
});

test('roomToStation 透传身份/展开字段（谓词数据面）', () => {
  const st = API.roomToStation({
    id: 'r1', longitude: 1, latitude: 2, status: 'online',
    ownerType: 'system', displayKind: 'system', hostUserId: 'u9', alwaysExpanded: true
  });
  assert.strictEqual(st.ownerType, 'system');
  assert.strictEqual(st.displayKind, 'system');
  assert.strictEqual(st.hostUserId, 'u9');
  assert.strictEqual(st.alwaysExpanded, true);
  // 缺省不得凭空造字段值
  const plain = API.roomToStation({ id: 'r2', longitude: 0, latitude: 0 });
  assert.strictEqual(plain.ownerType, undefined);
  assert.strictEqual(plain.alwaysExpanded, undefined);
});

// ---------------------------------------------------------------------------
// 3) GLSL / OBJ 管线源码逐字
// ---------------------------------------------------------------------------

test('rim GLSL 逐字：modelHeight 9.22 / 扫描带 mix(-3,13) / 无 discard（:11373-11449）', () => {
  const fs1 = API.SHADER_INJECT['fs:#main-end'];
  assert.match(fs1, /float modelHeight = 9\.22;/);
  assert.match(fs1, /float scanY = mix\(-3\.0, 13\.0, activationProgress\);/);
  assert.match(fs1, /float entranceScanY = mix\(-3\.0, 13\.0, entranceProgress\);/);
  assert.match(fs1, /float rimIntensity = pow\(rim, 6\.0\);/);
  assert.match(fs1, /float brightness = mix\(0\.7, targetActiveBrightness, activeness\);/);
  assert.match(fs1, /float alphaActive = rimIntensity \* 1\.5 \+ 0\.6;/);
  assert.match(fs1, /finalAlpha \*= entranceVisibility;/);
  assert.match(fs1, /finalAlpha \*= vLayerOpacity;/);
  assert.match(fs1, /DECKGL_FILTER_COLOR\(fragColor, geometry\);/);
  assert.ok(!/discard/.test(fs1), 'hearthere fs 无 discard（等比改写自研版退役）');
  assert.ok(!/-0\.325|1\.41|mix\(-0\.33, 1\.08/.test(CODE), '9.3 等比自研式必须全部退役（注释除外）');
  const vs = API.SHADER_INJECT['vs:#main-start'];
  assert.match(vs, /vModelHeight = positions\.y;/);
});

test('OBJ 管线逐字：vendor 路径 / fetchAndParse 语义 / 缓存 promise（:11323-11336 + vendor-loaders tn :22345）', () => {
  assert.strictEqual(API.OBJ_URL, 'vendor/hearthere/lighthouse-DPszrb1Q.obj');
  // hearthere Uu = vendor-loaders 导出 l = tn(e,t)：typeof e==='string' → 先 fetch 再 parse。
  // 我们 vendored 的 loaders UMD 无 fetchAndParse，等价 = fetchFile(url).arrayBuffer() → parse(buf)。
  assert.match(CODE, /fetchFile\(/);
  assert.match(CODE, /arrayBuffer\(/);
  assert.match(CODE, /parseFn\s*[:=][^;]*fetchAndParse\(/,
    'parseFn 必须是 fetchAndParse 包装（raw parse 收 URL 字符串会产出 0 顶点空壳，真机证伪）');
  assert.ok(!/parseFn:\s*L\.parse\b/.test(CODE), 'L.parse 裸绑定必须退役');
  assert.match(CODE, /meshPromise\s*=\s*parseFn/);
  assert.match(CODE, /parsedMesh\s*\?\?\s*OBJ_URL/); // Gh()：未就绪传 URL，deck 自带 loader 兜底
  assert.match(CODE, /loaders:\s*\[OBJLoader\]/);
  assert.match(CODE, /\.catch\(\s*function\s*\(\)\s*\{\s*\}\s*\)/); // cc().catch(()=>{}) 预热语义
});

test('rim 层 props 逐字：sizeScale 25 / getOrientation [0,0,90] / transitions 1000·100（:11509-11525）', () => {
  assert.match(CODE, /sizeScale:\s*RIM_SIZE_SCALE/);
  assert.match(CODE, /getOrientation:\s*\[0,\s*0,\s*90\]/);
  assert.match(CODE, /getColor:\s*1000/);
  assert.match(CODE, /getColorTop:\s*1000/);
  assert.match(CODE, /getColorBottom:\s*1000/);
  assert.match(CODE, /getLayerOpacity:\s*100/);
  assert.match(CODE, /getEntranceProgress:\s*1000/);
  // Ai()：/255 归一（:11338-11341）
  const v = API.toColorVec([223, 204, 251]);
  assert.ok(Math.abs(v[0] - 223 / 255) < 1e-9 && Math.abs(v[1] - 204 / 255) < 1e-9 &&
    Math.abs(v[2] - 251 / 255) < 1e-9);
});

test('光晕层 props 逐字（Dh :10981-11015）：compact / 半径 50·17·70 / 高度 80 / alpha 220 / 加法混合', () => {
  assert.match(CODE, /compact:\s*true/);
  assert.match(CODE, /GLOW_ELEVATION\s*=\s*80/);   // fs=80（:10692）→ getPosition [...position, 80]
  assert.match(CODE, /GLOW_ALPHA\s*=\s*220/);      // getFillColor alpha 220（:11000）
  assert.strictEqual(API.GLOW_RADIUS, 50);         // zr=50（:10952）
  assert.match(CODE, /getRadius:\s*GLOW_RADIUS/);
  assert.match(CODE, /radiusMinPixels:\s*17/);
  assert.match(CODE, /radiusMaxPixels:\s*70/);
  assert.match(CODE, /billboard:\s*true/);
  assert.match(CODE, /getFillColor:\s*300/); // transitions
  assert.match(CODE, /depthCompare:\s*'always'/);
  assert.match(CODE, /blendFunc:\s*\[770,\s*1\]/); // GL.ONE / GL.ONE（luma 数值枚举逐字）
});

test('光晕 GLSL 逐字：bh 球面遮挡 + Sh 星点三段 + Ph zoom 淡出 clamp(13.5-zoom,0,2)（:10804-10950）', () => {
  assert.match(API.SHADER_INJECT_GLOW_VS || '', /project_globe_is_occluded\(geometry\.position\.xyz\)/);
  assert.match(API.SHADER_INJECT_GLOW_VS || '', /gl_Position = vec4\(0\.0, 0\.0, 2\.0, 1\.0\);/);
  const fs = API.SHADER_INJECT_GLOW_FS || '';
  assert.match(fs, /float coreSize = 0\.25;/);
  assert.match(fs, /float combinedGlow = core \* 0\.8 \+ innerGlow \* 0\.15 \+ outerGlow \* 0\.05;/);
  assert.match(fs, /float glowIntensity = 1\.2;/);
  assert.match(fs, /fragColor\.a \*= clamp\(\(13\.5 - presenceGlow\.zoom\) \/ 2\.0, 0\.0, 1\.0\);/);
  assert.match(fs, /if \(picking\.isActive < 0\.5\)/);
});

// hearthere 线上 deck 是私有 patch 版：project 模块 GLSL 多出 project_globe_is_occluded
// （vendor-deck-core-BqZXgCow.js :546-566）。官方 deck 9.2.x 无此函数（9.2.5/9.2.7/9.3.1 核无），
// 我们 vendor 的官方 bundle 必须在光晕层自带同款定义，否则 VS 编译失败。
test('球面遮挡函数自带定义（deck 私有 patch 补齐）：glow 层 modules 含 project_globe_is_occluded', () => {
  const mod = API.SHADER_MODULE_GLOBE_OCCLUSION;
  assert.ok(mod, '必须导出遮挡函数模块');
  const src = mod.vertexSource || '';
  assert.match(src, /float project_globe_get_occlusion\(vec3 commonPosition\) \{/);
  assert.match(src, /if \(project\.projectionMode == PROJECTION_MODE_GLOBE\) \{/);
  assert.match(src, /vec3 normal = normalize\(commonPosition\);/);
  assert.match(src, /vec3 viewDir = normalize\(project\.cameraPosition - commonPosition\);/);
  assert.match(src, /float visibility = dot\(normal, viewDir\);/);
  assert.match(src, /return visibility > 0\.0 \? 0\.0 : 1\.0;/);
  assert.match(src, /bool project_globe_is_occluded\(vec3 commonPosition\) \{/);
  assert.match(src, /return project_globe_get_occlusion\(commonPosition\) > 0\.5;/);
  // 模块必须挂进光晕层 getShaders（与 PRESENCE_GLOW_MODULE 并列）
  assert.ok(/modules[\s\S]{0,160}GLOBE_OCCLUSION_MODULE/.test(CODE),
    'GlowLayer.getShaders 必须 concat 遮挡模块');
});

test('cullFace 数值枚举 so.BACK=1029（字符串 back 在本 deck bundle 触发 GL_INVALID_ENUM）', () => {
  assert.match(CODE, /GL_BACK\s*=\s*1029/);
  assert.match(CODE, /cullFace:\s*GL_BACK/);
  assert.ok(!/cullFace:\s*'back'/.test(CODE), '字符串形态必须退役');
});

// ---------------------------------------------------------------------------
// 4) 层组装（vm 沙箱真模块 + deck 桩）
// ---------------------------------------------------------------------------

function makeLayerStubCtor(name) {
  return class {
    constructor(props) {
      this.props = props;
      this.className = name;
    }
    getShaders() { return { inject: {}, modules: [] }; }
    getAttributeManager() { return null; }
  };
}

function loadSandbox(opts) {
  opts = opts || {};
  const created = [];
  function record(name) {
    const Base = makeLayerStubCtor(name);
    return class extends Base {
      constructor(props) { super(props); created.push(this); }
    };
  }
  const setPropsCalls = [];
  const overlay = {
    setProps(p) { setPropsCalls.push(p.layers); }
  };
  const maps = [];
  function FakeMap(zoom) {
    const m = this;
    this.zoom = zoom;
    this.handlers = {};
    this.on = (ev, fn) => { (m.handlers[ev] = m.handlers[ev] || []).push(fn); };
    this.off = (ev, fn) => { m.handlers[ev] = (m.handlers[ev] || []).filter((f) => f !== fn); };
    this.getZoom = () => m.zoom;
    this.emit = (ev) => (m.handlers[ev] || []).slice().forEach((f) => f());
  }
  const timers = [];
  let resolveParse = null;
  const sandbox = {
    console,
    Promise,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    deck: {
      SimpleMeshLayer: record('rim'),
      ScatterplotLayer: record('glow'),
      // ④-3 头像层基类桩（本沙箱 zoom=10：ensureLayerClasses 建类但不实例化）
      IconLayer: makeLayerStubCtor('icon'),
      CompositeLayer: makeLayerStubCtor('composite')
    },
    loaders: {
      // 可控 deferred：测试手动放行解析，钉死「URL 形态 → 对象形态」两拍
      parse: () => new Promise((res) => { resolveParse = res; }),
      fetchFile: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8))
      }),
      OBJLoader: function OBJLoader() {}
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const api = sandbox.StellaflixVideo.worldLighthouseDeck;
  return { api, created, setPropsCalls, overlay, timers, FakeMap, resolveParse: () => resolveParse && resolveParse({ attributes: {} }) };
}

const station = (id, lon, extra) => Object.assign({
  id, position: [lon, 31.2], status: 'online',
  colorTop: [223, 204, 251], colorBottom: [150, 200, 254]
}, extra || {});

test('组装顺序与常驻性逐字（ht :13501-13538）：glow → avatar(④-3) → warmup → expanded-batch；Bt 关门时只余 glow+avatar+warmup', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(10);
  await env.api.mount(map, env.overlay, {
    stations: [station('a', 121, { ownerType: 'system' }), station('b', 139, { alwaysExpanded: true })]
  });
  const last = env.setPropsCalls[env.setPropsCalls.length - 1];
  // vm 跨 realm 数组：JSON 规范化后比较（原型不参与）
  assert.strictEqual(JSON.stringify(last.map((l) => l.props.id)),
    JSON.stringify(['station-glow-layer', 'station-avatar-layer', 'lighthouse-warmup-layer']),
    'zoom=10（Bt 关）应只剩光晕层 + 头像层（④-3 :13506）+ 预热层（:13523 门限）');
  assert.strictEqual(last[0].props.visible, true, '光晕层恒 visible（:13504）');
  assert.strictEqual(last[0].props.pickable, false, '光晕层不可拾取（:10992）');
  assert.strictEqual(last[2].props.pickable, false, '预热层不可拾取（:13520）');
  assert.strictEqual(last[2].props.layerOpacity ?? last[2].props.getLayerOpacity(), 0.001,
    '预热层 opacity .001（Xm）');

  // 升 zoom 越 11.5：expanded 批进入，位置在 warmup 之后（:13534-13538）
  map.zoom = 11.6;
  map.emit('zoom');
  const layers2 = env.setPropsCalls[env.setPropsCalls.length - 1];
  assert.strictEqual(JSON.stringify(layers2.map((l) => l.props.id)),
    JSON.stringify(['station-glow-layer', 'station-avatar-layer', 'lighthouse-warmup-layer', 'lighthouse-expanded-batch']));
  const batch = layers2[3];
  assert.strictEqual(batch.props.pickable, true, 'zo() 默认 pickable（:11494）');
  assert.ok(Math.abs(batch.props.getLayerOpacity() - ((11.6 - 11.5) / 2)) < 1e-9,
    'layerOpacity = ds(zoom).detailOpacity（11.6 → 0.05）');
  assert.strictEqual(batch.props.sizeScale, 25, 'sizeScale=Hr 25 逐字（:11525）');
  env.api.unmount();
});

test('expanded-batch 数据 = 谓词命中集（:13262 + :13497 visibleIds 交集退化为谓词），非命中站只出光晕', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  await env.api.mount(map, env.overlay, {
    stations: [
      station('sys', 121, { ownerType: 'system' }),
      station('plain', 139),
      station('flag', 2.35, { alwaysExpanded: true })
    ]
  });
  const last = env.setPropsCalls[env.setPropsCalls.length - 1];
  const batch = last.find((l) => l.props.id === 'lighthouse-expanded-batch');
  assert.ok(batch, 'zoom14 应有 expanded-batch');
  assert.strictEqual(JSON.stringify(batch.props.data.map((d) => d.id).sort()),
    JSON.stringify(['flag', 'sys']));
  const glow = last.find((l) => l.props.id === 'station-glow-layer');
  assert.strictEqual(glow.props.data.length, 3, '光晕层吃全量站（b=全量 :13502）');
  env.api.unmount();
});

test('入场机制逐字：自研入场 rAF 循环退役；expanded 批 entranceProgress 恒 1（:13538），扫描动画由 transitions 承载', async () => {
  // ④-5a 修订守卫面：hearthere 本就有特效帧循环 _e.current=requestAnimationFrame(se)（:13576-13755），
  // 步骤③禁的是「自研入场逐帧推进」（archive: state.raf=requestAnimationFrame(step)→entranceProgress 每帧改值）。
  assert.ok(!/requestAnimationFrame\(\s*step\s*\)/.test(CODE),
    '自研入场 rAF 循环（step 每帧推进）必须退役（步骤③裁决）；特效驱动 rAF 归 ④-5a');
  assert.ok(!/ENTRANCE_FLIP_MS|runEntrance/.test(CODE), '自研翻转机制整体退役');
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  await env.api.mount(map, env.overlay, { stations: [station('a', 121, { ownerType: 'system' })] });
  const last = env.setPropsCalls[env.setPropsCalls.length - 1];
  const batch = last.find((l) => l.props.id === 'lighthouse-expanded-batch');
  assert.ok(batch, 'zoom14 应有 expanded 批');
  assert.strictEqual(batch.props.getEntranceProgress(), 1, 'expanded 批恒 1（:13538）');
  assert.strictEqual(batch.props.transitions.getEntranceProgress, 1000, '1000ms 过渡仍逐字（:11514）');
  env.api.unmount();
});

test('mesh 消费面：未就绪 mesh=URL，解析完成后重建为已解析对象（Gh/cc）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  await env.api.mount(map, env.overlay, { stations: [station('a', 121, { ownerType: 'system' })] });
  const last = env.setPropsCalls[env.setPropsCalls.length - 1];
  const rim = last.find((l) => l.props.id === 'lighthouse-expanded-batch');
  assert.ok(rim, '应有塔身批');
  assert.strictEqual(typeof rim.props.mesh, 'string', 'OBJ 未就绪时 mesh 为 URL 字符串（Gh()）');
  assert.strictEqual(rim.props.mesh, API.OBJ_URL);
  assert.strictEqual(JSON.stringify(rim.props.loaders.map((F) => F.name)), JSON.stringify(['OBJLoader']));
  // fetchAndParse 两拍（fetchFile→arrayBuffer）后才轮到 parse：先冲刷微任务
  await new Promise((r) => setImmediate(r));
  // 放行 cc() 的解析 promise → 触发一次重建，mesh 换成解析结果
  env.resolveParse();
  await new Promise((r) => setImmediate(r));
  const after = env.setPropsCalls[env.setPropsCalls.length - 1];
  const rim2 = after.find((l) => l.props.id === 'lighthouse-expanded-batch');
  assert.ok(rim2 && typeof rim2.props.mesh === 'object', '解析完成后 mesh 应为对象');
  env.api.unmount();
});

// 行为面（真机验收 bug 复现）：vendored loaders 的 parse 把字符串当内容——
// URL 字符串无 v 行 → 0 顶点空壳 mesh → SimpleMeshLayer 有层无线、塔身不可见。
// 修复语义 = fetchAndParse：fetchFile(url) → arrayBuffer → parse(buf)。
test('OBJ 行为面：层收到的已解析 mesh 必须含顶点（URL 直喂 parse 的 0 顶点回归钉）', async () => {
  const OBJ_BYTES = new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n').buffer;
  const geom = (n) => ({ header: { vertexCount: n }, attributes: { POSITION: { value: new Float32Array(n * 3), size: 3 } } });
  const created = [];
  function rec(name) {
    const Base = makeLayerStubCtor(name);
    return class extends Base { constructor(p) { super(p); created.push(this); } };
  }
  const sandbox = {
    console, Promise,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    TextEncoder,
    deck: { SimpleMeshLayer: rec('rim'), ScatterplotLayer: rec('glow'), IconLayer: makeLayerStubCtor('icon'), CompositeLayer: makeLayerStubCtor('composite') },
    loaders: {
      // 真实 vendored 语义：仅 ArrayBuffer 输入产出几何；字符串按内容解析（0 顶点）
      parse: (data) => Promise.resolve(
        data instanceof ArrayBuffer ? geom(3) : geom(0)),
      fetchFile: (url) => {
        sandbox.__fetched = url;
        return Promise.resolve({ arrayBuffer: () => Promise.resolve(OBJ_BYTES) });
      },
      OBJLoader: function OBJLoader() {}
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const api = sandbox.StellaflixVideo.worldLighthouseDeck;
  const map = { getZoom: () => 14, on: () => {}, off: () => {} };
  const setPropsCalls = [];
  await api.mount(map, { setProps: (p) => setPropsCalls.push(p.layers) }, {
    stations: [station('a', 121, { ownerType: 'system' })]
  });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sandbox.__fetched, API.OBJ_URL, '必须先 fetch OBJ_URL');
  const last = setPropsCalls[setPropsCalls.length - 1];
  const rim = last.find((l) => l.props.id === 'lighthouse-expanded-batch');
  assert.ok(rim && typeof rim.props.mesh === 'object', '解析后 mesh 应为对象');
  assert.ok(rim.props.mesh.attributes.POSITION.value.length === 9,
    'mesh 必须来自 ArrayBuffer 解析（9 float=3 顶点），不得是 URL 直喂的 0 顶点空壳');
  api.unmount();
});

// ---------------------------------------------------------------------------
// 5) 消费面契约保持（page-world / world-globe.test 接线不破）
// ---------------------------------------------------------------------------

test('对外契约保持：mount/unmount/refreshStations/setSelected/applyTier/getState/pickStation + 空载安全', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(13);
  const r = await env.api.mount(map, env.overlay, { stations: [station('a', 121)] });
  assert.strictEqual(r.count, 1);
  const s = env.api.getState();
  assert.strictEqual(s.stations.length, 1);
  assert.strictEqual(s.selectedId, null);
  assert.strictEqual(typeof s.visible, 'boolean');
  env.api.refreshStations([station('b', 139)]);
  assert.strictEqual(env.api.getState().stations[0].id, 'b');
  env.api.unmount();
  env.api.unmount(); // 幂等
  assert.strictEqual(env.api.pickStation(1, 1), null, '未挂载 pickStation 安全 null');
});
