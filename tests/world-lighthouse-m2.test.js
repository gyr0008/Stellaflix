'use strict';

/**
 * 世界页 M2 — 灯塔上球
 * 运行：node --test tests/world-lighthouse-m2.test.js
 *
 * 覆盖：加载链 / GLB 产物 / 缩放档位换算 / Rim shader 四段机制 / 演示信标 / 挂载接线
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function makeSandbox() {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.document = {
    createElement() {
      return {
        width: 0, height: 0,
        getContext() {
          return {
            createRadialGradient() { return { addColorStop() {} }; },
            fillRect() {}, set fillStyle(v) {}
          };
        }
      };
    }
  };
  sandbox.StellaflixVideo = { worldCesium: { CESIUM_ROOT: 'vendor/cesium/' } };
  return sandbox;
}

function loadLighthouse() {
  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/world-params.js'), sandbox);
  vm.runInContext(read('public/video/_archive/world-lighthouse.js'), sandbox);
  return sandbox.StellaflixVideo.worldLighthouse;
}

test('index.html：world-lighthouse.js 已摘除归档（Task 9），world-globe.js 仍在 page-world.js 之前', () => {
  const html = read('public/index.html');
  assert.ok(!/video\/world-lighthouse\.js"/.test(html), 'world-lighthouse.js 应已从 SFV_SCRIPTS 摘除（归档 _archive/）');
  const iWg = html.indexOf('"video/world-globe.js"');
  const iPw = html.indexOf('"video/page-world.js"');
  assert.ok(iWg >= 0 && iWg < iPw, 'world-globe.js 应先于 page-world.js');
});

test('lighthouse.glb 已 vendor 且是合法 glTF 2.0 二进制', () => {
  const p = path.join(root, 'public/models/lighthouse.glb');
  assert.ok(fs.existsSync(p), 'public/models/lighthouse.glb 应存在');
  const buf = fs.readFileSync(p);
  assert.ok(buf.length > 50000, 'GLB 不应过小: ' + buf.length);
  assert.strictEqual(buf.toString('ascii', 0, 4), 'glTF', 'magic 应为 glTF');
  const version = buf.readUInt32LE(4);
  assert.strictEqual(version, 2, 'glTF 版本应为 2');
  const length = buf.readUInt32LE(8);
  assert.strictEqual(length, buf.length, '声明长度应与文件长度一致');
  // GLB 布局：0-4 magic | 4-8 version | 8-12 length | 12-16 chunk0 length | 16-20 chunk0 type
  const chunkType = buf.toString('ascii', 16, 20);
  assert.strictEqual(chunkType, 'JSON', '首块类型应为 JSON');
});

test('OBJ 源模型高度 9.22 与 shader 的 modelHeight 一致', () => {
  const obj = read('public/models/lighthouse.obj');
  const ys = [];
  for (const m of obj.matchAll(/^v\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/gm)) {
    ys.push(parseFloat(m[2]));
  }
  assert.ok(ys.length > 5000, '顶点数应足够: ' + ys.length);
  const maxY = Math.max(...ys);
  assert.ok(Math.abs(maxY - 9.22) < 0.01, `OBJ 最大 y 应≈9.22，实际 ${maxY}`);

  const lh = loadLighthouse();
  assert.strictEqual(lh.MODEL_HEIGHT, 9.22);
});

test('缩放档位：MapLibre zoom 11 / 13.5 换算为相机高度', () => {
  const lh = loadLighthouse();
  // 推导：h = 156543.03 * W / (2^z * 2 * tan(fovy/2))，W=800, fovy=60°
  // z=11 → ≈52943m；z=13.5 → ≈9359m
  const h11 = 156543.03 * 800 / (Math.pow(2, 11) * 2 * Math.tan(Math.PI / 6));
  const h135 = 156543.03 * 800 / (Math.pow(2, 13.5) * 2 * Math.tan(Math.PI / 6));
  assert.ok(Math.abs(lh.TIER_GLOW_MAX_H - h11) / h11 < 0.05,
    `GLOW_MAX_H ${lh.TIER_GLOW_MAX_H} 应≈${Math.round(h11)}`);
  assert.ok(Math.abs(lh.TIER_DETAIL_MIN_H - h135) / h135 < 0.05,
    `DETAIL_MIN_H ${lh.TIER_DETAIL_MIN_H} 应≈${Math.round(h135)}`);

  // 档位取值（vm 沙箱里建的对象原型不同，用浅拷贝归一后再比）
  const hi = { ...lh.tierOf(100000) };
  const lo = { ...lh.tierOf(1000) };
  const mid = { ...lh.tierOf(30000) };
  assert.deepStrictEqual(hi, { glow: 1, detail: 0 }, '高空应只显示光晕');
  assert.deepStrictEqual(lo, { glow: 0, detail: 1 }, '低空应只显示实体');
  assert.ok(mid.glow > 0 && mid.glow < 1, '中间档光晕应部分可见');
  assert.ok(mid.detail > 0 && mid.detail < 1, '中间档实体应部分可见');
  assert.ok(Math.abs(mid.glow + mid.detail - 1) < 1e-6, '光晕与实体应互补');
});

test('Rim shader 四段机制齐全', () => {
  const src = read('public/video/_archive/world-lighthouse.js');
  // 1. Rim 描边
  assert.match(src, /rimIntensity = pow\(rim, 6\.0\)/);
  // 2. 垂直渐变（modelHeight 9.22 + colorBottom→colorTop）
  assert.match(src, /ratio = clamp\(y \/ u_modelHeight, 0\.0, 1\.0\)/);
  assert.match(src, /mix\(u_colorBottom, u_colorTop, ratio\)/);
  // 3. 激活扫描（scanY = mix(-3,13,activation)）
  assert.match(src, /scanY = mix\(-3\.0, 13\.0, u_activation\)/);
  assert.match(src, /scanLine = exp\(/);
  // 4. 入场扫描
  assert.match(src, /entranceScanY = mix\(-3\.0, 13\.0, u_entrance\)/);
  assert.match(src, /entranceVisibility = 1\.0 - smoothstep/);
  // 动态亮度防过曝
  assert.match(src, /maxSafeGain = 1\.0 \/ max\(0\.01, maxComponent\)/);
  // 选中动画常量改由 world-params.js 注入（对齐 hearthere 的 yh hook）
  assert.match(src, /PSEL\.ELEV_REST \|\| 80/);
  assert.match(src, /PSEL\.ELEV_ACTIVE \|\| 290/);
  assert.match(src, /PSEL\.DWELL_MS \|\| 1000/);
  assert.match(src, /1 - Math\.pow\(1 - k, 3\)/);
});

test('演示信标：10 城，经纬度与颜色合法', () => {
  const lh = loadLighthouse();
  assert.strictEqual(lh.DEMO_STATIONS.length, 10);
  for (const s of lh.DEMO_STATIONS) {
    assert.ok(s.id && s.name, 'id/name 必填');
    assert.ok(s.lon >= -180 && s.lon <= 180, `${s.id} 经度越界`);
    assert.ok(s.lat >= -90 && s.lat <= 90, `${s.id} 纬度越界`);
    assert.strictEqual(s.colorTop.length, 3);
    assert.strictEqual(s.colorBottom.length, 3);
    for (const c of s.colorTop.concat(s.colorBottom)) {
      assert.ok(c >= 0 && c <= 1, `${s.id} 颜色分量越界`);
    }
    assert.ok(['playing', 'online', 'offline'].includes(s.status), `${s.id} status 非法`);
  }
  // 至少一座 playing（激活态）
  assert.ok(lh.DEMO_STATIONS.some((s) => s.status === 'playing'));
});

test('page-world.js 挂载灯塔层并在 unmount 时清理', () => {
  const src = read('public/video/page-world.js');
  // Task 6 反转（灯塔层换代）：
  //   原：/SFV\.worldLighthouse\.mount\(/ + /SFV\.worldLighthouse\.unmount\(\)/（Cesium 实体层）
  //   新：deck 层 SFV.worldLighthouseDeck.mount(...)/unmount()；老模块留盘仅 Cesium 回退链用
  assert.match(src, /SFV\.worldLighthouseDeck\.mount\(/);
  assert.match(src, /SFV\.worldLighthouseDeck\.unmount\(\)/);
  assert.ok(!/SFV\.worldLighthouse\.mount\(/.test(src),
    'page-world 不得再调老 Cesium 灯塔 mount（Task 6 退役）');
  // 切页竞态守卫：卸载后不得再挂
  assert.match(src, /mySeq !== seq/);
});

test('GLB 模型路径指向 public/models/lighthouse.glb', () => {
  const src = read('public/video/_archive/world-lighthouse.js');
  assert.match(src, /models\/lighthouse\.glb/);
  assert.ok(!/vendor\/cesium\/.*lighthouse/.test(src), '不应拼出 vendor/cesium/.../lighthouse 路径');
});

test('光晕参数对齐 hearthere compact 星点 shader', () => {
  const lh = loadLighthouse();
  assert.strictEqual(lh.GLOW_ALTITUDE_M, 80);
  assert.ok(Math.abs(lh.GLOW_ALPHA - 220 / 255) < 1e-6, 'alpha 应为 220/255');

  const src = read('public/video/_archive/world-lighthouse.js');
  // compact 星点三段衰减 + 权重（这是「克制而不失质感」的关键）
  assert.match(src, /STAR_CORE_SIZE/);
  assert.match(src, /smoothstep/);
  assert.match(src, /core \* W\.core \+ inner \* W\.inner \+ outer \* W\.outer/);
  // 不得再用柔和径向渐变
  assert.ok(!/createRadialGradient/.test(src), '不应再用柔和径向渐变');
});

test('光晕颜色必须保色相：RGB 不得被 boost 冲白', () => {
  const src = read('public/video/_archive/world-lighthouse.js');
  // 禁止逐通道夹到 255 —— 那是「绿光变白光」的直接原因
  assert.ok(!/data\[o\] = Math\.min\(255, Math\.round\(rgb\[0\]/.test(src),
    'RGB 不得做 Math.min(255, rgb*boost) 的逐通道截断');
  // 必须有保色相的归一化
  assert.match(src, /var mx = Math\.max\(cr, cg, cb, 0\.0001\)/);
  assert.match(src, /if \(mx > 1\) \{ cr \/= mx; cg \/= mx; cb \/= mx; \}/);
  // RENDER_BOOST 只能作用在 alpha 上
  assert.match(src, /alphaLift \* GLOW_ALPHA \* alphaBoost/);
  assert.ok(!/rgb\[0\] \* 255 \* boost/.test(src), 'boost 不得再乘到 RGB');
});

test('glowTexture 不得用 g/r/b 做变量名（会覆盖 canvas 2D 上下文）', () => {
  const src = read('public/video/_archive/world-lighthouse.js');
  const i = src.indexOf('function glowTexture');
  const j = src.indexOf('function glowPixelSize');
  const fn = src.slice(i, j);
  // g 是 canvas 2D 上下文；var 是函数作用域，循环里 var g 会把它冲掉
  assert.ok(!/var r = rgb/.test(fn), '不得用 r 做 RGB 变量名');
  assert.ok(!/var g = rgb/.test(fn), '不得用 g 做 RGB 变量名（会覆盖 2D 上下文）');
  assert.ok(!/var b = rgb/.test(fn), '不得用 b 做 RGB 变量名');
  assert.match(fn, /var cr = rgb\[0\] \* intensity, cg = rgb\[1\] \* intensity, cb = rgb\[2\] \* intensity/);
  assert.match(fn, /g\.putImageData\(img, 0, 0\)/);
});

test('world-params.js 固化 hearthere 全部图层细节参数', () => {
  const src = read('public/video/world-params.js');
  // 尺度
  for (const k of ['IN: 5e4', 'MT: 5e-4', 'ZR: 50', 'MESH_SCALE: 25', 'MODEL_HEIGHT: 9.22',
                   'SPOTLIGHT_HEIGHT: 175', 'BLINK_LIGHT_HEIGHT: 213.75',
                   'PARTICLE_RADIUS_METERS: 2.5', 'PARTICLE_MAX_DISTANCE: 500',
                   'PARTICLE_RINGS: 30', 'PARTICLES_PER_RING: 60']) {
    assert.ok(src.includes(k), `SCALE 应含 ${k}`);
  }
  // 光晕
  for (const k of ['SRC_RADIUS_MIN_PX: 17', 'SRC_RADIUS_MAX_PX: 70', 'RADIUS_MIN_PX: 35', 'RADIUS_MAX_PX: 110',
                   'ALTITUDE_M: 80', 'RENDER_BOOST: 2',
                   'DEPTH_COMPARE: \'always\'', 'STAR_CORE_SIZE: 0.25']) {
    assert.ok(src.includes(k), `GLOW 应含 ${k}`);
  }
  // 档位
  for (const k of ['ST: 12.5', 'XT: 1', 'SC: 11.0']) {
    assert.ok(src.includes(k), `TIER 应含 ${k}`);
  }
  // 选中
  for (const k of ['ELEV_ACTIVE: 290', 'ELEV_REST: 80', 'DWELL_MS: 1000', 'EASE_MS: 700']) {
    assert.ok(src.includes(k), `SELECT 应含 ${k}`);
  }
  // 其余图层
  for (const k of ['CYCLE_S: 4', 'MAX_RADIUS_M: 500', 'POINT_SIZE: 26',
                   'RISE_HEIGHT_M: 42', 'GLOW_RADIUS: 30', 'ATLAS_WIDTH: 4096',
                   'RADIUS_KM: 50', 'THROTTLE_MS: 500', 'HEIGHT: 5']) {
    assert.ok(src.includes(k), `应含 ${k}`);
  }
  // 太阳高度角色表 11 档
  const stops = src.match(/\[\s*-?\d+,\s*\[\s*\d+,\s*\d+,\s*\d+\s*\],\s*\[\s*\d+,\s*\d+,\s*\d+\s*\]\s*\]/g) || [];
  assert.strictEqual(stops.length, 11, 'SKY.STOPS 应有 11 档，实际 ' + stops.length);
});

test('index.html 先加载 world-params.js（world-lighthouse.js 已归档，不再有先后关系）', () => {
  const html = read('public/index.html');
  const iParams = html.indexOf('"video/world-params.js"');
  assert.ok(iParams >= 0, 'world-params.js 应在 SFV_SCRIPTS 中');
});

test('光晕必须深度常显 + 球面剔除（hearthere 的成对机制，缺一半就错）', () => {
  const src = read('public/video/_archive/world-lighthouse.js');
  // hearthere: depthCompare:"always" → Cesium 等价 disableDepthTestDistance: Infinity
  assert.match(src, /disableDepthTestDistance:\s*Number\.POSITIVE_INFINITY/,
    '必须深度常显，否则光晕会被地表深度遮掉（太空看不到灯塔）');
  // 对应 hearthere 的 project_globe_is_occluded 顶点剔除
  assert.match(src, /isFacingCamera/);
  assert.match(src, /project_globe_is_occluded|球面剔除/);
});

test('光晕尺寸：radiusMin/Max 是「半径」，billboard 直径要 ×2', () => {
  const lh = loadLighthouse();
  // hearthere 原值 17/70 保留在 world-params 作参照；渲染值上调（Cesium alpha 混合补偿）
  assert.strictEqual(lh.GLOW_RADIUS_PX_MIN, 35);
  assert.strictEqual(lh.GLOW_RADIUS_PX_MAX, 110);
  assert.strictEqual(lh.glowPixelSize(18000000), 35);
  assert.strictEqual(lh.glowDiameter(18000000), 70);
  // h≈226m 时 50m 半径投影到 110px，再低就夹到上限
  assert.strictEqual(lh.glowPixelSize(150), 110);
  assert.strictEqual(lh.glowDiameter(150), 220);
  for (const h of [18000000, 53000, 9400, 3000, 700, 300, 150]) {
    assert.strictEqual(lh.glowDiameter(h), lh.glowPixelSize(h) * 2, '直径应为半径的 2 倍');
    assert.ok(lh.glowPixelSize(h) >= 35 && lh.glowPixelSize(h) <= 110,
      '半径应夹在 [35,110]: ' + lh.glowPixelSize(h));
  }
  const src = read('public/video/_archive/world-lighthouse.js');
  assert.match(src, /glowPixelSize\(cameraHeight\) \* 2/);
  const params = read('public/video/world-params.js');
  assert.match(params, /SRC_RADIUS_MIN_PX: 17/, '应保留 hearthere 原值 17 作参照');
  assert.match(params, /SRC_RADIUS_MAX_PX: 70/, '应保留 hearthere 原值 70 作参照');
});

test('光晕属性必须写在 billboard 上，不得写在 Entity 上', () => {
  const src = read('public/video/_archive/world-lighthouse.js');
  // Entity 没有 alpha/width/height，写了等于没写（灯塔会「不随档位变化」甚至消失）
  assert.ok(!/st\.glow\.alpha\s*=/.test(src), '不得写 st.glow.alpha（Entity 上无效）');
  assert.ok(!/st\.glow\.width\s*=/.test(src), '不得写 st.glow.width（Entity 上无效）');
  assert.ok(!/st\.glow\.height\s*=/.test(src), '不得写 st.glow.height（Entity 上无效）');
  assert.match(src, /st\.glow\.billboard/);
  assert.match(src, /bb\.alpha\s*=/);
  assert.match(src, /bb\.width\s*=/);
  // applyElevation 的 multiplyByPoint result 必须是新 Cartesian3，
  // 不能传 st.glow.position（那是 ConstantPositionProperty）
  assert.ok(!/multiplyByPoint\(\s*st\.baseMatrix[\s\S]{0,120}st\.glow\.position\s*\)/.test(src),
    'multiplyByPoint 的 result 不得传 st.glow.position');
  assert.match(src, /st\.glow\.position = pos/);
});
