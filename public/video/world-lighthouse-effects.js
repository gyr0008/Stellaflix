'use strict';
/*
 * Stellaflix 世界页 — 选中特效三件套（步骤④-5a，hearthere 逐字移植）
 *
 * 基准 _scratch/hearthere/main.pretty.js（规格 _scratch/effects-spec-4-5.md；切片脚本 _scratch/gen45/build.js，勿手改本文件类体/GLSL）：
 *   · xr 尺寸包 :10951-10979（In=5e4 / Mt=5e-4 / Hr=25 / Rh=.5 / Ih=.0025 / Nh=30 / jh=60）
 *   · 粒子波 GLSL Ti/sm/rm/am/im/lm/cm + um 音频历史展开 :11706-12378
 *   · ParticleWaveLayer(dm)/fm :12379-12473 · 粒子数据 Cm :12907-12932 · rr/eg 缓存 :13158-13187
 *   · PulseRingLayer(vm)/wm + Li/pm/ym :12474-12646（hm=1 环、半径 mm*(1+uc)）
 *   · 锥体几何 bm / VolumetricSpotlightLayer Sm / mesh 缓存 xm / _m :12648-12905
 *
 * 已裁决等价改写：基类 mo/as → 参注入（deck.gl 全局晚到，同步骤③ ensureLayerClasses 模式）。
 * 不移植（Supabase 面，用户裁决 2026-09-30）：beacon-blink 两层、preactivate/warm 网络头像预热。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // ==================== xr 尺寸包（逐字 :10951-10979）====================

  const In = 5e4,
      zr = 50,
      Mt = 5e-4,
      xr = {
          meshScale: In * Mt,
          spotlightHeight: 7 * In * Mt,
          blinkLightHeight: 8.55 * In * Mt,
          particleRadiusMeters: 5e3 * Mt,
          particleRandomHeightMax: 5e4 * Mt,
          particleWaveAmplitude: 3e3 * Mt,
          particleMaxDistance: 1e6 * Mt,
          particleRadiusDeg: 5 * Mt,
          noiseFrequency: .8,
          noiseAmplitude: .4,
          particleRings: 30,
          particlesPerRing: 60
      },
      {
          meshScale: Hr,
          spotlightHeight: Eh,
          blinkLightHeight: Th,
          particleRadiusMeters: Lh,
          particleRandomHeightMax: xi,
          particleWaveAmplitude: ic,
          particleMaxDistance: Rh,
          particleRadiusDeg: Ih,
          particleRings: Nh,
          particlesPerRing: jh
      } = xr;

  var PARTICLE_MAX_DISTANCE = Rh;      // .5（1e6 × Mt）
  var PARTICLE_RINGS = Nh, PARTICLES_PER_RING = jh, PARTICLE_RADIUS_DEG = Ih;
  var WAVE_SPEED_DEFAULT = 1.5;        // fm props 默认（:12450；dm.draw 兜底 2 在类体内逐字）

  // ==================== 粒子数据 Cm + rr/eg 缓存（逐字）====================

  function Cm(t, e = .1, n = 20, o = 36) {
      const r = [],
          [i, l] = t;
      for (let c = 1; c <= n; c++) {
          const u = c / n * e,
              d = Math.floor(o * (c / n) * 1.5) + 6;
          for (let f = 0; f < d; f++) {
              const p = f / d * Math.PI * 2,
                  h = (Math.random() - .5) * .3,
                  m = p + h,
                  y = (Math.random() - .5) * .2 * u,
                  w = u + y,
                  g = i + Math.cos(m) * w,
                  v = l + Math.sin(m) * w,
                  b = c * .5 + Math.random() * Math.PI,
                  x = w * 111e3,
                  S = Math.random() * xi + xi * .5;
              r.push({
                  position: [g, v, S],
                  phase: b,
                  distance: x
              })
          }
      }
      return r
  }


  const rr = new Map,
      zm = 15,
      Hm = 45,
      qm = 200,
      Km = 180,
      Vm = 240,
      Ko = .15,
      Gm = 2,
      Qm = 96,
      Ym = 1100,
      Zm = "lighthouse-warmup-layer",
      Xm = .001,
      Jm = [{
          id: "__lighthouse-warmup__",
          position: [0, 0],
          name: "Lighthouse warmup",
          status: "offline",
          ownerType: "system",
          colorTop: [255, 255, 255],
          colorBottom: [255, 255, 255]
      }];
  
  function eg(t) {
      const e = `${t[0]},${t[1]}`;
      if (!rr.has(e)) {
          const n = Cm(t, Ih, Nh, jh);
          rr.set(e, n)
      }
      return rr.get(e)
  }


  // ==================== 粒子波 GLSL（逐字 :11706-12378）====================

  const Ti = `uniform particleWaveUniforms {
    float time;
    float waveAmplitude;
    float waveSpeed;
    float maxDistance;   // 粒子最大距离映射（米）
    float audioLow;      // 低频音频强度 (0-1) - 保留用于兼容
    float audioMid;      // 中频音频强度 (0-1) - 保留用于兼容
    float audioHigh;     // 高频音频强度 (0-1) - 保留用于兼容
    float noiseFrequency; // Curl Noise 空间频率
    float noiseAmplitude; // Curl Noise 影响强度
    float isIdle;        // 是否处于待机模式（无音频时为 1.0，有音频时为 0.0）
    float opacity;       // 透明度（用于渐入/渐隐动画，0.0-1.0）
    // 灯塔颜色（用于粒子变色）
    vec3 colorTop;       // 波峰颜色（灯塔顶部颜色）
    vec3 colorMiddle;    // 基础颜色（灯塔中间颜色 = top 和 bottom 的混合）
    // 音频历史（64帧，用于延迟传导，约1秒）
    float audio0;  float audio1;  float audio2;  float audio3;
    float audio4;  float audio5;  float audio6;  float audio7;
    float audio8;  float audio9;  float audio10; float audio11;
    float audio12; float audio13; float audio14; float audio15;
    float audio16; float audio17; float audio18; float audio19;
    float audio20; float audio21; float audio22; float audio23;
    float audio24; float audio25; float audio26; float audio27;
    float audio28; float audio29; float audio30; float audio31;
    float audio32; float audio33; float audio34; float audio35;
    float audio36; float audio37; float audio38; float audio39;
    float audio40; float audio41; float audio42; float audio43;
    float audio44; float audio45; float audio46; float audio47;
    float audio48; float audio49; float audio50; float audio51;
    float audio52; float audio53; float audio54; float audio55;
    float audio56; float audio57; float audio58; float audio59;
    float audio60; float audio61; float audio62; float audio63;
  } particleWave;
  `,
      sm = {
          name: "particleWave",
          vs: Ti,
          fs: Ti,
          uniformTypes: {
              time: "f32",
              waveAmplitude: "f32",
              waveSpeed: "f32",
              maxDistance: "f32",
              audioLow: "f32",
              audioMid: "f32",
              audioHigh: "f32",
              noiseFrequency: "f32",
              noiseAmplitude: "f32",
              isIdle: "f32",
              opacity: "f32",
              colorTop: "vec3<f32>",
              colorMiddle: "vec3<f32>",
              audio0: "f32",
              audio1: "f32",
              audio2: "f32",
              audio3: "f32",
              audio4: "f32",
              audio5: "f32",
              audio6: "f32",
              audio7: "f32",
              audio8: "f32",
              audio9: "f32",
              audio10: "f32",
              audio11: "f32",
              audio12: "f32",
              audio13: "f32",
              audio14: "f32",
              audio15: "f32",
              audio16: "f32",
              audio17: "f32",
              audio18: "f32",
              audio19: "f32",
              audio20: "f32",
              audio21: "f32",
              audio22: "f32",
              audio23: "f32",
              audio24: "f32",
              audio25: "f32",
              audio26: "f32",
              audio27: "f32",
              audio28: "f32",
              audio29: "f32",
              audio30: "f32",
              audio31: "f32",
              audio32: "f32",
              audio33: "f32",
              audio34: "f32",
              audio35: "f32",
              audio36: "f32",
              audio37: "f32",
              audio38: "f32",
              audio39: "f32",
              audio40: "f32",
              audio41: "f32",
              audio42: "f32",
              audio43: "f32",
              audio44: "f32",
              audio45: "f32",
              audio46: "f32",
              audio47: "f32",
              audio48: "f32",
              audio49: "f32",
              audio50: "f32",
              audio51: "f32",
              audio52: "f32",
              audio53: "f32",
              audio54: "f32",
              audio55: "f32",
              audio56: "f32",
              audio57: "f32",
              audio58: "f32",
              audio59: "f32",
              audio60: "f32",
              audio61: "f32",
              audio62: "f32",
              audio63: "f32"
          }
      },
      rm = `
    in float instanceDistance;   // 从 attribute 读取预计算的距离（米）
    out float vHeight;           // 传递给 fragment shader 的高度
    out float vDistanceRatio;    // 距离比例（用于颜色渐变）
    out float vHeightOffset;     // 高度偏移量（用于位置修改）
    out float vPhase;            // 粒子相位（用于闪烁）
    
    // ========== Simplex Noise Functions (Ashima WebGL Noise) ==========
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
    
    float snoise(vec3 v) {
      const vec2 C = vec2(1.0/6.0, 1.0/3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      
      vec3 i = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      
      i = mod289(i);
      vec4 p = permute(permute(permute(
        i.z + vec4(0.0, i1.z, i2.z, 1.0))
        + i.y + vec4(0.0, i1.y, i2.y, 1.0))
        + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      
      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;
      
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      
      vec4 x = x_ * ns.x + ns.yyyy;
      vec4 y = y_ * ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      
      vec4 s0 = floor(b0) * 2.0 + 1.0;
      vec4 s1 = floor(b1) * 2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      
      vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
      
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      
      vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
      p0 *= norm.x;
      p1 *= norm.y;
      p2 *= norm.z;
      p3 *= norm.w;
      
      vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
    }
    
    // ========== Curl Noise Function ==========
    // 计算 curl noise，产生无散度的向量场（类似流体运动）
    vec3 curlNoise(vec3 p) {
      const float e = 0.1;  // 微分步长
      
      // 计算偏导数
      float n1 = snoise(vec3(p.x, p.y + e, p.z));
      float n2 = snoise(vec3(p.x, p.y - e, p.z));
      float n3 = snoise(vec3(p.x, p.y, p.z + e));
      float n4 = snoise(vec3(p.x, p.y, p.z - e));
      float n5 = snoise(vec3(p.x + e, p.y, p.z));
      float n6 = snoise(vec3(p.x - e, p.y, p.z));
      
      // curl = (dFz/dy - dFy/dz, dFx/dz - dFz/dx, dFy/dx - dFx/dy)
      float x = (n1 - n2) - (n3 - n4);
      float y = (n3 - n4) - (n5 - n6);
      float z = (n5 - n6) - (n1 - n2);
      
      return normalize(vec3(x, y, z)) * 0.5;
    }
  `,
      am = `
    // 使用预计算的距离（从 attribute 读取，单位：米）
    float distance = instanceDistance;
    
    // 相位基于位置计算
    float phase = fract(instancePositions.x * 100.0 + instancePositions.y * 100.0) * 6.28318;
    
    // 根据距离计算比例
    float distanceRatio = clamp(distance / particleWave.maxDistance, 0.0, 1.0);
    
    // ========== 真正延迟传导（64帧 ≈ 1秒）==========
    // 根据 distanceRatio 采样音频历史：
    // - 内圈 (distanceRatio ≈ 0) → 当前音频 (audio0)
    // - 外圈 (distanceRatio ≈ 1) → 历史音频 (audio63，约 1 秒前)
    
    // 计算采样索引（0~63）和插值权重
    float historyIndex = distanceRatio * 63.0;
    int idx0 = int(floor(historyIndex));
    int idx1 = min(idx0 + 1, 63);
    float blend = fract(historyIndex);
    
    // 从 64 个 uniform 中采样（使用分支，GPU 会优化）
    float sample0, sample1;
    
    // 采样 idx0（使用嵌套分支减少比较次数）
    if (idx0 < 32) {
      if (idx0 < 16) {
        if (idx0 < 8) {
          if (idx0 == 0) sample0 = particleWave.audio0;
          else if (idx0 == 1) sample0 = particleWave.audio1;
          else if (idx0 == 2) sample0 = particleWave.audio2;
          else if (idx0 == 3) sample0 = particleWave.audio3;
          else if (idx0 == 4) sample0 = particleWave.audio4;
          else if (idx0 == 5) sample0 = particleWave.audio5;
          else if (idx0 == 6) sample0 = particleWave.audio6;
          else sample0 = particleWave.audio7;
        } else {
          if (idx0 == 8) sample0 = particleWave.audio8;
          else if (idx0 == 9) sample0 = particleWave.audio9;
          else if (idx0 == 10) sample0 = particleWave.audio10;
          else if (idx0 == 11) sample0 = particleWave.audio11;
          else if (idx0 == 12) sample0 = particleWave.audio12;
          else if (idx0 == 13) sample0 = particleWave.audio13;
          else if (idx0 == 14) sample0 = particleWave.audio14;
          else sample0 = particleWave.audio15;
        }
      } else {
        if (idx0 < 24) {
          if (idx0 == 16) sample0 = particleWave.audio16;
          else if (idx0 == 17) sample0 = particleWave.audio17;
          else if (idx0 == 18) sample0 = particleWave.audio18;
          else if (idx0 == 19) sample0 = particleWave.audio19;
          else if (idx0 == 20) sample0 = particleWave.audio20;
          else if (idx0 == 21) sample0 = particleWave.audio21;
          else if (idx0 == 22) sample0 = particleWave.audio22;
          else sample0 = particleWave.audio23;
        } else {
          if (idx0 == 24) sample0 = particleWave.audio24;
          else if (idx0 == 25) sample0 = particleWave.audio25;
          else if (idx0 == 26) sample0 = particleWave.audio26;
          else if (idx0 == 27) sample0 = particleWave.audio27;
          else if (idx0 == 28) sample0 = particleWave.audio28;
          else if (idx0 == 29) sample0 = particleWave.audio29;
          else if (idx0 == 30) sample0 = particleWave.audio30;
          else sample0 = particleWave.audio31;
        }
      }
    } else {
      if (idx0 < 48) {
        if (idx0 < 40) {
          if (idx0 == 32) sample0 = particleWave.audio32;
          else if (idx0 == 33) sample0 = particleWave.audio33;
          else if (idx0 == 34) sample0 = particleWave.audio34;
          else if (idx0 == 35) sample0 = particleWave.audio35;
          else if (idx0 == 36) sample0 = particleWave.audio36;
          else if (idx0 == 37) sample0 = particleWave.audio37;
          else if (idx0 == 38) sample0 = particleWave.audio38;
          else sample0 = particleWave.audio39;
        } else {
          if (idx0 == 40) sample0 = particleWave.audio40;
          else if (idx0 == 41) sample0 = particleWave.audio41;
          else if (idx0 == 42) sample0 = particleWave.audio42;
          else if (idx0 == 43) sample0 = particleWave.audio43;
          else if (idx0 == 44) sample0 = particleWave.audio44;
          else if (idx0 == 45) sample0 = particleWave.audio45;
          else if (idx0 == 46) sample0 = particleWave.audio46;
          else sample0 = particleWave.audio47;
        }
      } else {
        if (idx0 < 56) {
          if (idx0 == 48) sample0 = particleWave.audio48;
          else if (idx0 == 49) sample0 = particleWave.audio49;
          else if (idx0 == 50) sample0 = particleWave.audio50;
          else if (idx0 == 51) sample0 = particleWave.audio51;
          else if (idx0 == 52) sample0 = particleWave.audio52;
          else if (idx0 == 53) sample0 = particleWave.audio53;
          else if (idx0 == 54) sample0 = particleWave.audio54;
          else sample0 = particleWave.audio55;
        } else {
          if (idx0 == 56) sample0 = particleWave.audio56;
          else if (idx0 == 57) sample0 = particleWave.audio57;
          else if (idx0 == 58) sample0 = particleWave.audio58;
          else if (idx0 == 59) sample0 = particleWave.audio59;
          else if (idx0 == 60) sample0 = particleWave.audio60;
          else if (idx0 == 61) sample0 = particleWave.audio61;
          else if (idx0 == 62) sample0 = particleWave.audio62;
          else sample0 = particleWave.audio63;
        }
      }
    }
    
    // 采样 idx1（同样的嵌套分支结构）
    if (idx1 < 32) {
      if (idx1 < 16) {
        if (idx1 < 8) {
          if (idx1 == 0) sample1 = particleWave.audio0;
          else if (idx1 == 1) sample1 = particleWave.audio1;
          else if (idx1 == 2) sample1 = particleWave.audio2;
          else if (idx1 == 3) sample1 = particleWave.audio3;
          else if (idx1 == 4) sample1 = particleWave.audio4;
          else if (idx1 == 5) sample1 = particleWave.audio5;
          else if (idx1 == 6) sample1 = particleWave.audio6;
          else sample1 = particleWave.audio7;
        } else {
          if (idx1 == 8) sample1 = particleWave.audio8;
          else if (idx1 == 9) sample1 = particleWave.audio9;
          else if (idx1 == 10) sample1 = particleWave.audio10;
          else if (idx1 == 11) sample1 = particleWave.audio11;
          else if (idx1 == 12) sample1 = particleWave.audio12;
          else if (idx1 == 13) sample1 = particleWave.audio13;
          else if (idx1 == 14) sample1 = particleWave.audio14;
          else sample1 = particleWave.audio15;
        }
      } else {
        if (idx1 < 24) {
          if (idx1 == 16) sample1 = particleWave.audio16;
          else if (idx1 == 17) sample1 = particleWave.audio17;
          else if (idx1 == 18) sample1 = particleWave.audio18;
          else if (idx1 == 19) sample1 = particleWave.audio19;
          else if (idx1 == 20) sample1 = particleWave.audio20;
          else if (idx1 == 21) sample1 = particleWave.audio21;
          else if (idx1 == 22) sample1 = particleWave.audio22;
          else sample1 = particleWave.audio23;
        } else {
          if (idx1 == 24) sample1 = particleWave.audio24;
          else if (idx1 == 25) sample1 = particleWave.audio25;
          else if (idx1 == 26) sample1 = particleWave.audio26;
          else if (idx1 == 27) sample1 = particleWave.audio27;
          else if (idx1 == 28) sample1 = particleWave.audio28;
          else if (idx1 == 29) sample1 = particleWave.audio29;
          else if (idx1 == 30) sample1 = particleWave.audio30;
          else sample1 = particleWave.audio31;
        }
      }
    } else {
      if (idx1 < 48) {
        if (idx1 < 40) {
          if (idx1 == 32) sample1 = particleWave.audio32;
          else if (idx1 == 33) sample1 = particleWave.audio33;
          else if (idx1 == 34) sample1 = particleWave.audio34;
          else if (idx1 == 35) sample1 = particleWave.audio35;
          else if (idx1 == 36) sample1 = particleWave.audio36;
          else if (idx1 == 37) sample1 = particleWave.audio37;
          else if (idx1 == 38) sample1 = particleWave.audio38;
          else sample1 = particleWave.audio39;
        } else {
          if (idx1 == 40) sample1 = particleWave.audio40;
          else if (idx1 == 41) sample1 = particleWave.audio41;
          else if (idx1 == 42) sample1 = particleWave.audio42;
          else if (idx1 == 43) sample1 = particleWave.audio43;
          else if (idx1 == 44) sample1 = particleWave.audio44;
          else if (idx1 == 45) sample1 = particleWave.audio45;
          else if (idx1 == 46) sample1 = particleWave.audio46;
          else sample1 = particleWave.audio47;
        }
      } else {
        if (idx1 < 56) {
          if (idx1 == 48) sample1 = particleWave.audio48;
          else if (idx1 == 49) sample1 = particleWave.audio49;
          else if (idx1 == 50) sample1 = particleWave.audio50;
          else if (idx1 == 51) sample1 = particleWave.audio51;
          else if (idx1 == 52) sample1 = particleWave.audio52;
          else if (idx1 == 53) sample1 = particleWave.audio53;
          else if (idx1 == 54) sample0 = particleWave.audio54;
          else sample0 = particleWave.audio55;
        } else {
          if (idx1 == 56) sample1 = particleWave.audio56;
          else if (idx1 == 57) sample1 = particleWave.audio57;
          else if (idx1 == 58) sample1 = particleWave.audio58;
          else if (idx1 == 59) sample1 = particleWave.audio59;
          else if (idx1 == 60) sample0 = particleWave.audio60;
          else if (idx1 == 61) sample1 = particleWave.audio61;
          else if (idx1 == 62) sample1 = particleWave.audio62;
          else sample1 = particleWave.audio63;
        }
      }
    }
    
    // 线性插值得到低频音频振幅
    float audioAmplitude = mix(sample0, sample1, blend);
    
    // 【平滑算法】应用二次方衰减，过滤掉小波动
    // 这会让：0.1 → 0.01，0.5 → 0.25（非线性抑制小值）
    audioAmplitude = pow(audioAmplitude, 2.0);
    
    // 距离衰减（更温和）
    float distanceFalloff = 1.0 - distanceRatio * 0.7;
    audioAmplitude *= distanceFalloff;
    
    // ========== Curl Noise 计算（仅用于水平漂移）==========
    // 使用缓慢变化的时间，让漂移更平滑
    float slowTime = particleWave.time * 0.4;  // 比垂直波动慢，但比之前快
    vec3 driftNoiseInput = vec3(
      phase * particleWave.noiseFrequency,                    // 每个粒子不同
      distanceRatio * particleWave.noiseFrequency * 2.0,      // 基于距离
      slowTime                                                 // 缓慢变化的时间
    );
    
    // 计算水平漂移的 noise
    float driftNoise1 = snoise(driftNoiseInput);
    float driftNoise2 = snoise(driftNoiseInput + vec3(17.3, 31.7, 47.1));  // 偏移获取不同的noise
    
    // ========== 波纹效果（纯垂直）==========
    // ========== 波纹效果（纯垂直）==========
    
    float combinedWave = 0.0;
    
    if (particleWave.isIdle > 0.5) {
      // ========== 待机模式：尖锐脉冲波（调试模式）==========
      float idleWavePhase = distanceRatio * 4.0 - particleWave.time * 0.5;
      
      // 将 sin 波转换为尖锐脉冲：
      // 1. sin 值从 [-1, 1] 映射到 [0, 1]
      // 2. 使用高次幂让波峰变尖锐
      float sinVal = sin(idleWavePhase);
      float normalizedSin = (sinVal + 1.0) * 0.5;  // [0, 1]
      float sharpPulse = pow(normalizedSin, 32.0);  // 高次幂 = 尖锐波峰
      
      float idleWave = sharpPulse * 15.0;  // 振幅拉高
      
      combinedWave = idleWave;
    } else {
      // ========== 音频模式 ==========
      // 1. 基础背景层：更慢、更柔和的呼吸
      float wave1 = sin(distanceRatio * 8.0 - particleWave.time * particleWave.waveSpeed * 0.8 + phase * 0.1);
      float baseWave = wave1 * 0.1; // 仅保留 0.1 的微弱起伏
  
      // 2. 音频脉冲层：非线性放大（关键修改！）
      // 使用 pow(x, 3.0) 制造"门限效应"：
      // - 小噪音 (0.2) -> 0.008 (被吞没，消除鬼畜)
      // - 强节拍 (0.8) -> 0.512 (被放大)
      float cleanAudio = pow(audioAmplitude, 3.0);
      
      // 强度系数放大到 15.0 以补偿 pow 带来的数值压缩，同时获得更有力的突起
      float audioWave = cleanAudio * 15.0;
  
      // 3. 最终合成
      combinedWave = baseWave + audioWave;
    }
    
    // 传递给 fragment shader
    vHeight = clamp(combinedWave, -1.0, 1.0);  // 限制在 -1 到 1 范围
    vDistanceRatio = distanceRatio;
    vHeightOffset = combinedWave * particleWave.waveAmplitude;
    
    // ===== 计算最终位置偏移 =====
    // Z 轴：纯垂直波动（不受水平漂移影响）
    float heightMeters = combinedWave * particleWave.waveAmplitude;
    
    // 【关键修复】在 Globe View 中，不能直接沿着 Z 轴 (0,0,1) 偏移，那是地轴方向（指向北方）
    // 我们需要使用 project_normal 将 (0,0,1) 旋转到当前经纬度的"地表垂直向上"方向
    vec3 commonUp = project_normal(vec3(0.0, 0.0, 1.0));
    
    // 计算 Common Space 中的偏移向量
    vec3 commonOffset = commonUp * project_size(heightMeters);
    
    // 计算原始位置和偏移后位置的 clip space 差值
    // 使用差值法可以保留 ScatterplotLayer 原有的像素偏移（如 billboard 效果）
    vec4 originalClipPos = project_common_position_to_clipspace(vec4(geometry.position.xyz, 1.0));
    vec4 offsetClipPos = project_common_position_to_clipspace(vec4(geometry.position.xyz + commonOffset, 1.0));
    
    gl_Position += (offsetClipPos - originalClipPos);
    
    // ========== 水平漂移（独立于垂直跳动）==========
    // 使用 phase 作为粒子的角度位置
    float angle = phase;
    
    // 切线方向（tangential）- 让粒子"绕圈"
    vec2 tangent = vec2(-sin(angle), cos(angle));
    // 径向方向（radial）- 让粒子向内/外移动
    vec2 radial = vec2(cos(angle), sin(angle));
    
    // 缓慢的水平漂移
    float tangentialDrift = driftNoise1 * particleWave.noiseAmplitude * 2.0;
    float radialDrift = driftNoise2 * particleWave.noiseAmplitude * 0.5;
    
    // 合成世界空间偏移
    float driftAmplitude = particleWave.waveAmplitude * 0.8;
    vec2 worldOffset = (tangent * tangentialDrift + radial * radialDrift) * driftAmplitude;
    
    // 转换到 common space 并应用
    float worldOffsetX = project_size(worldOffset.x);
    float worldOffsetY = project_size(worldOffset.y);
    vec4 offsetXY = project.viewProjectionMatrix * vec4(worldOffsetX, worldOffsetY, 0.0, 0.0);
    gl_Position.xy += offsetXY.xy;
    
    // 传递相位给 fragment shader（用于闪烁）
    vPhase = phase;
  `,
      im = `
    in float vHeight;
    in float vDistanceRatio;
    in float vPhase;  // 粒子相位，用于闪烁
  `,
      lm = `
    // 提前计算距离，用于后续丢弃圆形外的像素
    float earlyDist = length(unitPosition);
    // 圆形外的像素直接丢弃（避免深色背景遮挡）
    if (earlyDist > 1.0) discard;
    
    // ========== 星星闪烁效果（用于基础波浪）==========
    // 使用 hash 函数让闪烁更随机
    float hashPhase = fract(sin(vPhase * 43758.5453) * 1000.0);
    float hashPhase2 = fract(sin(vPhase * 12345.6789 + 0.5) * 1000.0);
    
    // 多个不同频率的 sin 叠加（降低时间系数让闪烁更慢）
    float twinkle1 = sin(hashPhase * 17.3 + particleWave.time * 0.3);
    float twinkle2 = sin(hashPhase2 * 31.7 + particleWave.time * 0.5);
    float twinkle3 = sin((hashPhase + hashPhase2) * 53.1 + particleWave.time * 0.2);
    float twinkle4 = sin(hashPhase * 97.3 - particleWave.time * 0.4);
    
    // 组合闪烁值 [0, 1]
    float twinkleRaw = (twinkle1 + twinkle2 * 0.7 + twinkle3 * 0.5 + twinkle4 * 0.3) / 2.5;
    twinkleRaw = (twinkleRaw + 1.0) * 0.5;
    
    // 阈值 0.5 让约 50% 的粒子可见
    float twinkleThreshold = 0.5;
    float twinkleVisibility = smoothstep(twinkleThreshold - 0.05, twinkleThreshold + 0.05, twinkleRaw);
    
    // ========== 平滑过渡的可见度计算 ==========
    // 1. 基础可见度：vHeight 从 -0.1 到 0.1 渐变 (波浪边缘渐入渐出)
    float baseVisibility = smoothstep(-0.1, 0.1, vHeight);
    
    // 2. 脉冲强度：vHeight 从 0.1 到 0.3 渐变到完全可见
    float pulseStrength = smoothstep(0.1, 0.3, vHeight);
    
    // 3. 闪烁可见度（用于基础波浪）
    // 在基础波浪区域应用闪烁，在强脉冲区域完全可见
    float twinkleFactor = mix(twinkleVisibility, 1.0, pulseStrength);
    
    // 4. 最终可见度：基础可见度 × 闪烁因子
    float finalVisibility = baseVisibility * twinkleFactor;
    
    // 丢弃不可见的粒子（节省性能）
    if (finalVisibility < 0.01) discard;
  `,
      cm = `
    // ========== 梦幻光点效果 ==========
    
    // 1. 计算像素到圆心的距离
    float dist = length(unitPosition);
    
    // ========== 梦幻径向渐变（纯发光，无背景）==========
    
    // 核心层：小而明亮的中心点
    float coreSize = 0.2;
    float core = 1.0 - smoothstep(0.0, coreSize, dist);
    core = pow(core, 1.5);
    
    // 内光晕：柔和的第一层扩散
    float innerGlow = 1.0 - smoothstep(0.0, 0.5, dist);
    innerGlow = pow(innerGlow, 2.0);
    
    // 外光晕：更大范围的柔和光芒
    float outerGlow = 1.0 - smoothstep(0.0, 1.0, dist);
    outerGlow = pow(outerGlow, 4.0);  // 更快速衰减
    
    // 组合光晕（只有发光，没有填充背景）
    float combinedGlow = core * 0.7 + innerGlow * 0.25 + outerGlow * 0.15;
    
    // 波峰时增强发光
    float heightBoost = max(0.0, vHeight) * 0.4;
    combinedGlow += outerGlow * heightBoost;
    
    // 2. 颜色计算
    vec3 baseColor = particleWave.colorMiddle;
    vec3 peakColor = particleWave.colorTop;
    
    float heightVariability = 1.0 + vHeight * 0.1;
    vec3 adjustedBaseColor = baseColor * heightVariability;
    
    // 波峰时的颜色混合（只在强脉冲时使用）
    float heightFactor = clamp((vHeight + 1.0) * 0.5, 0.0, 1.0);
    float colorMixFactor = pow(heightFactor, 2.0);
    
    // ========== 星星眨眼：颜色随机闪烁 ==========
    // 在基础波浪时颜色也会随机变成塔顶色
    float colorTwinkle1 = sin(hashPhase * 19.3 + particleWave.time * 0.6) * 0.5 + 0.5;
    float colorTwinkle2 = sin(hashPhase2 * 37.9 + particleWave.time * 0.35) * 0.5 + 0.5;
    // 组合颜色闪烁因子 [0, 1]
    float colorFlicker = colorTwinkle1 * 0.6 + colorTwinkle2 * 0.4;
    
    // 使用阈值判断：超过 0.85 就变成 peakColor（约 15% 的粒子有机会变色）
    // smoothstep 提供一个小范围的过渡，避免硬切换
    float peakColorChance = smoothstep(0.75, 0.85, colorFlicker);
    
    // 【关键修复】基础波浪时完全由 peakColorChance 控制
    // 只在波峰（pulseStrength > 0）时才混入 colorMixFactor
    float finalColorMix;
    if (pulseStrength > 0.01) {
      // 波峰时：在 peakColorChance 和 colorMixFactor 之间选较大值
      finalColorMix = max(peakColorChance, colorMixFactor);
    } else {
      // 基础波浪时：纯粹由 peakColorChance 控制（0 或接近 1）
      finalColorMix = peakColorChance;
    }
    
    vec3 particleColor = mix(adjustedBaseColor, peakColor, finalColorMix);
    
    // 3. 发光强度
    float midIntensity = particleWave.audioMid;
    float baseGlowIntensity = 1.2 + (vHeight * 0.5) + (midIntensity * 2.0);
    
    // ========== 亮度与变色同步 ==========
    // 变成塔顶颜色时达到 130% 亮度，不变色时保持 100%
    // 范围：[1.0, 1.3]（即 100%~130%）
    float brightnessFlicker = 1.0 + peakColorChance * 0.3;
    
    // 根据脉冲强度混合：强脉冲时稳定亮度，基础波浪时应用变色亮度
    float glowIntensity = mix(baseGlowIntensity * brightnessFlicker, baseGlowIntensity, pulseStrength);
    
    // ========== 基础波浪闪烁时的大小增强 ==========
    // 当粒子闪烁变成塔顶色时，也增大光晕（模拟"眨眼"效果）
    // 幅度略小于波峰效果（0.35 vs 0.4），确保波峰始终最突出
    float twinkleSizeBoost = peakColorChance * 0.35;
    // 只在基础波浪时生效（pulseStrength ≈ 0），波峰时淡出此效果
    float twinkleSizeFactor = twinkleSizeBoost * (1.0 - pulseStrength);
    combinedGlow += outerGlow * twinkleSizeFactor;
    
    // 4. 应用闪烁可见度到透明度
    float alpha = combinedGlow * finalVisibility;
    
    // 应用渐入/渐隐动画的 opacity
    alpha *= particleWave.opacity;
    
    // 丢弃几乎透明的像素
    if (alpha < 0.02) discard;
    
    // 设置最终颜色（纯发光效果）
    fragColor = vec4(particleColor * glowIntensity, alpha);
    
    DECKGL_FILTER_COLOR(fragColor, geometry);
  `;
  
  function um(t) {
      const e = {};
      for (let n = 0; n < 64; n++) {
          const o = t[n];
          e[`audio${n}`] = o !== void 0 ? o : 0
      }
      return e
  }


  // ==================== ParticleWaveLayer 工厂（基类参注入）====================
  function createParticleWaveLayer(SCATTER_BASE) {

    class dm extends SCATTER_BASE {
        static layerName = "ParticleWaveLayer";
        initializeState() {
            super.initializeState();
            const e = this.getAttributeManager();
            e && e.addInstanced({
                instanceDistance: {
                    size: 1,
                    accessor: "getDistance",
                    defaultValue: 0
                }
            })
        }
        getShaders() {
            const e = super.getShaders();
            return e.modules = [...e.modules, sm], e.inject = {
                "vs:#decl": rm,
                "vs:#main-end": am,
                "fs:#decl": im,
                "fs:#main-start": lm,
                "fs:#main-end": cm
            }, e
        }
        draw(e) {
            const n = this.props,
                o = n.time || 0,
                r = n.waveAmplitude || ic,
                i = n.waveSpeed || 2,
                l = n.audioData || new Float32Array(64),
                c = n.audioHistory || new Array(64).fill(0),
                u = this.averageRange(l, 0, 20),
                d = n.audioMid !== void 0 ? n.audioMid : this.averageRange(l, 21, 42),
                f = this.averageRange(l, 43, 63),
                p = this.state.model;
            if (p && p.shaderInputs) {
                const h = {
                    time: o,
                    waveAmplitude: r,
                    waveSpeed: i,
                    maxDistance: Rh,
                    audioLow: u,
                    audioMid: d,
                    audioHigh: f,
                    noiseFrequency: xr.noiseFrequency,
                    noiseAmplitude: xr.noiseAmplitude,
                    isIdle: n.isIdle ? 1 : 0,
                    opacity: n.opacity !== void 0 ? n.opacity : 1,
                    colorTop: n.colorTop || [0, .9, 1],
                    colorMiddle: n.colorMiddle || [0, .45, .5],
                    ...um(c)
                };
                p.shaderInputs.setProps({
                    particleWave: h
                })
            }
            super.draw(e)
        }
        averageRange(e, n, o) {
            let r = 0;
            const i = o - n + 1;
            for (let l = n; l <= o && l < e.length; l++) r += e[l];
            return r / i
        }
    }

    function fm(t) {
        return new dm({
            id: "particle-wave-layer",
            data: t.data,
            time: t.time || 0,
            waveAmplitude: t.waveAmplitude || ic,
            waveSpeed: t.waveSpeed || 1.5,
            audioData: t.audioData || new Float32Array(64),
            audioHistory: t.audioHistory || new Array(16).fill(0),
            audioMid: t.audioMid || 0,
            isIdle: t.isIdle || !1,
            opacity: t.opacity !== void 0 ? t.opacity : 1,
            colorTop: t.colorTop,
            colorMiddle: t.colorMiddle,
            getPosition: e => e.position,
            getDistance: e => e.distance,
            getRadius: Lh,
            getFillColor: [0, 229, 255, 200],
            radiusUnits: "meters",
            radiusScale: 1,
            filled: !0,
            stroked: !1,
            antialiasing: !0,
            billboard: !0,
            pickable: !1,
            parameters: {
                depthWriteEnabled: !1
            }
        })
    }
    return { cls: dm, build: fm };
  }

  // ==================== PulseRingLayer（逐字 :12474-12646，基类参注入）====================
  var pulseBits = (function () {
    const Li = `uniform pulseRingUniforms {
      float time;           // 当前时间（秒）
      float cycleDuration;  // 单个波纹扩散周期（秒）
      float maxRadius;      // 最大半径（归一化，1.0 = RING_MAX_RADIUS）
      float fadeDistance;   // 消失过渡距离（归一化）
      float opacity;        // 透明度（用于渐入/渐隐动画，0.0-1.0）
      vec3 colorTop;        // 波峰颜色（归一化 0-1）
      vec3 colorBottom;     // 基础颜色（归一化 0-1）
    } pulseRing;
    `,
        pm = {
            name: "pulseRing",
            vs: Li,
            fs: Li,
            uniformTypes: {
                time: "f32",
                cycleDuration: "f32",
                maxRadius: "f32",
                fadeDistance: "f32",
                opacity: "f32",
                colorTop: "vec3<f32>",
                colorBottom: "vec3<f32>"
            }
        },
        hm = 1,
        mm = 1e6 * Mt,
        gm = 8,
        uc = .3;
    
    function ym(t) {
        const e = [];
        for (let n = 0; n < hm; n++) e.push({
            position: [t.position[0], t.position[1], .1 * n],
            ringIndex: n,
            phaseOffset: n * 1
        });
        return e
    }
    return { Li: Li, pm: pm, hm: hm, mm: mm, gm: gm, uc: uc, ym: ym };
  })();

  function createPulseRingLayer(SCATTER_BASE) {
    var pm = pulseBits.pm, uc = pulseBits.uc, mm = pulseBits.mm, gm = pulseBits.gm, ym = pulseBits.ym;
    class vm extends SCATTER_BASE {
        static layerName = "PulseRingLayer";
        initializeState() {
            super.initializeState();
            const e = this.getAttributeManager();
            e && e.addInstanced({
                instancePhaseOffset: {
                    size: 1,
                    accessor: "getPhaseOffset",
                    defaultValue: 0
                }
            })
        }
        getShaders() {
            const e = super.getShaders();
            return e.modules = [...e.modules, pm], e.inject = {
                "vs:#decl": `
                    in float instancePhaseOffset;
                    out float vPhase;        // 当前波纹相位 (0-1+)
                `,
                "vs:#main-end": `
                    // 直接传递时间，让 FS 使用正弦波计算光圈位置
                    // 与粒子波浪使用完全相同的公式
                    vPhase = pulseRing.time;  // 传递原始时间
                `,
                "fs:#decl": `
                    in float vPhase;      // 原始时间
                `,
                "fs:#main-end": `
                    // ========== 方案 C: 使用与粒子波浪相同的 sin 波公式 ==========
                    // 不再"跟踪波峰位置"，而是直接计算每个像素的"波高度"
                    
                    // 计算到圆心的距离
                    // deck.gl ScatterplotLayer 的 uv 范围是 [-0.5, 0.5]
                    // length(uv) 最大约 0.707，* 2.0 后范围约 [0, 1.4]
                    // 我们只关心 [0, 1] 范围，超出部分会被 fade 掉
                    vec2 uv = geometry.uv;
                    float dist = length(uv) * 2.0;
                    
                    // 将 dist 映射到 distanceRatio 空间 (0~1)
                    // 这里的 dist 约等于粒子的 distanceRatio
                    float distanceRatio = clamp(dist, 0.0, 1.0);
                    
                    // ========== 使用与粒子 IDLE 模式完全相同的公式 ==========
                    // 粒子 shader: sin(distanceRatio * 4.0 - time * 0.5)
                    float time = vPhase;
                    float PI = 3.14159265;
                    float wavePhase = distanceRatio * 4.0 - time * 0.5;
                    float sinVal = sin(wavePhase);
                    
                    // 将 sin 值从 [-1, 1] 映射到 [0, 1]
                    float normalizedSin = (sinVal + 1.0) * 0.5;
                    
                    // 使用高次幂让波峰变尖锐（与粒子 shader 的 pow(normalizedSin, 8.0) 一致）
                    float sharpPulse = pow(normalizedSin, 8.0);
                    
                    // 光圈强度基于尖锐脉冲
                    float ringIntensity = sharpPulse;
                    
                    // 边缘渐隐：在接近边界时淡出（distanceRatio > 0.8）
                    float fadeStart = 0.75;
                    if (distanceRatio > fadeStart) {
                        float fadeT = (distanceRatio - fadeStart) / (1.0 - fadeStart);
                        ringIntensity *= 1.0 - fadeT;
                    }
                    
                    // 中心渐入：刚从中心出来时淡入
                    float fadeInEnd = 0.05;
                    if (distanceRatio < fadeInEnd) {
                        ringIntensity *= distanceRatio / fadeInEnd;
                    }
                    
                    // 颜色：从 UBO uniform 读取（归一化 0-1）
                    vec3 ringColor = mix(pulseRing.colorBottom, pulseRing.colorTop, distanceRatio);
                    
                    // 发光效果：波峰处更亮
                    float brightness = 1.0 + ringIntensity * 1.5;
                    
                    // 应用颜色和透明度
                    fragColor.rgb = ringColor * brightness;
                    fragColor.a *= ringIntensity * 0.9 * pulseRing.opacity;
                `
            }, e
        }
        draw(e) {
            const n = this.props,
                o = n.time || 0,
                r = n.opacity !== void 0 ? n.opacity : 1,
                i = this.state.model;
            if (i && i.shaderInputs) {
                const l = {
                    time: o,
                    cycleDuration: gm,
                    maxRadius: 1,
                    fadeDistance: uc,
                    opacity: r,
                    colorTop: n.colorTop || [0, .9, 1],
                    colorBottom: n.colorBottom || [.2, .4, 1]
                };
                i.shaderInputs.setProps({
                    pulseRing: l
                })
            }
            super.draw(e)
        }
    }

    function wm(t) {
        const {
            data: e,
            time: n = 0,
            opacity: o = 1
        } = t, r = ym(e), i = mm * (1 + uc);
        return new vm({
            id: "pulse-ring-layer",
            data: r,
            time: n,
            opacity: o,
            colorTop: t.colorTop,
            colorBottom: t.colorBottom,
            getPosition: l => l.position,
            getRadius: i,
            radiusUnits: "meters",
            radiusScale: 1,
            filled: !0,
            stroked: !1,
            getFillColor: [255, 255, 255, 255],
            getPhaseOffset: l => l.phaseOffset,
            pickable: !1,
            antialiasing: !0,
            parameters: {
                depthWriteEnabled: !1
            }
        })
    }
    return { cls: vm, build: wm, data: pulseBits.ym, mm: pulseBits.mm, uc: uc };
  }

  // ==================== VolumetricSpotlightLayer（逐字 :12648-12905，基类参注入）====================
  // bm 锥体几何 + sr/xm mesh 缓存不依赖基类 → 置于模块顶层（Node 纯函数可测面）
    function bm(t = .1, e = 1.5, n = 5, o = 32, r = 20, i = !0, l = 0) {
        const c = [],
            u = [],
            d = [],
            f = (e - t) / n;
        for (let p = 0; p <= r; p++) {
            const h = p / r,
                m = h * (e - t) + t,
                y = h * n + l;
            for (let w = 0; w <= o; w++) {
                const v = w / o * Math.PI * 2,
                    b = Math.sin(v),
                    x = Math.cos(v);
                c.push(m * b, y, m * x);
                const S = b,
                    _ = f,
                    P = x,
                    M = Math.sqrt(S * S + _ * _ + P * P);
                u.push(S / M, _ / M, P / M)
            }
        }
        for (let p = 0; p < r; p++)
            for (let h = 0; h < o; h++) {
                const m = p * (o + 1) + h,
                    y = m + o + 1,
                    w = m + o + 2,
                    g = m + 1;
                d.push(m, g, y), d.push(y, g, w)
            }
        if (!i) {
            const p = c.length / 3;
            c.push(0, l, 0), u.push(0, -1, 0);
            const h = p;
            c.push(0, n + l, 0), u.push(0, 1, 0);
            const m = p + 1;
            for (let y = 0; y < o; y++) {
                const w = y,
                    g = y + 1;
                d.push(h, g, w)
            }
            for (let y = 0; y < o; y++) {
                const w = r * (o + 1) + y,
                    g = w + 1;
                d.push(m, w, g)
            }
        }
        return {
            positions: new Float32Array(c),
            normals: new Float32Array(u),
            indices: new Uint16Array(d)
        }
    }

    let sr = null;
    
    function xm() {
        if (!sr) {
            const {
                positions: t,
                normals: e,
                indices: n
            } = bm(.1, 6, 30, 32, 20, !1, 0);
            sr = {
                topology: "triangle-list",
                attributes: {
                    positions: {
                        value: t,
                        size: 3
                    },
                    normals: {
                        value: e,
                        size: 3
                    }
                },
                indices: {
                    value: n,
                    size: 1
                }
            }
        }
        return sr
    }

  function createSpotlightLayer(MESH_BASE) {
    class Sm extends MESH_BASE {
        static layerName = "VolumetricSpotlightLayer";
        static defaultProps = {
            ...MESH_BASE.defaultProps,
            debugMode: !1
        };
        initializeState() {
            super.initializeState();
            const e = this.getAttributeManager();
            e && e.addInstanced({
                instanceLayerOpacity: {
                    size: 1,
                    type: "float32",
                    accessor: "getLayerOpacity",
                    defaultValue: 1,
                    transition: !0
                }
            })
        }
        getShaders() {
            const e = super.getShaders();
            return this.props.debugMode ? e.inject = {
                "fs:#main-end": `
                        // Debug 模式：显示醒目的紫色锥体
                        fragColor = vec4(1.0, 0.0, 1.0, 0.8);
                        DECKGL_FILTER_COLOR(fragColor, geometry);
                    `
            } : e.inject = {
                "vs:#decl": `
                        in float instanceLayerOpacity;
                        out vec3 vLocalPosition;
                        out vec3 vConeAxisWorld;
                        out float vLayerOpacity;
                    `,
                "vs:#main-end": `
                        vLocalPosition = positions;
                        vLayerOpacity = instanceLayerOpacity;
                        
                        // 光锥轴线在模型空间是 Y 轴方向
                        vec3 axisModel = vec3(0.0, 1.0, 0.0);
                        
                        // 1. 使用实例矩阵变换到世界空间
                        vec3 axisWorld = mat3(instanceModelMatrix) * axisModel;
                        
                        // 2. 使用 project_normal 变换到 common space（与 viewDir 相同的坐标系）
                        vConeAxisWorld = normalize(project_normal(axisWorld));
                    `,
                "fs:#decl": `
                        in vec3 vLocalPosition;
                        in vec3 vConeAxisWorld;
                        in float vLayerOpacity;
                    `,
                "fs:#main-end": `
                        // ========== 动画进度 ==========
                        // vColor.a 由 getColor 的 alpha 驱动 (0 = 关闭, 1 = 完全展开)
                        float animProgress = vColor.a;
                        
                        // ========== 体积光参数（硬编码） ==========
                        vec3 spotColor = vec3(1.0, 0.95, 0.8);    // 淡黄色（灯塔光）
                        float spotAttenuation = 20.0;              // 距离衰减系数
                        float spotAnglePower = 2.0;               // 角度衰减幂次（rim 效果）
                        float extremePower = 3.0;                 // 极端角度判定幂次（约 ±30°~45° 生效）
    
                        // ========== 距离衰减 ==========
                        // 光源在本地坐标原点（锥体尖端）
                        vec3 spotPosition = vec3(0.0, 0.0, 0.0);
                        float dist = distance(vLocalPosition, spotPosition);
                        float distanceIntensity = 1.0 - clamp(dist / spotAttenuation, 0.0, 1.0);
    
                        // ========== 角度衰减 (基于视线) - Rim 效果 ==========
                        vec3 viewDir = normalize(cameraPosition - position_commonspace.xyz);
                        vec3 spotNormal = normalize(normals_commonspace);
                        
                        // NdotV: 面朝向相机(中心) -> 亮, 面垂直相机(边缘) -> 暗
                        float NdotV = abs(dot(spotNormal, viewDir));
                        float angleIntensity = pow(NdotV, spotAnglePower);
                        
                        // ========== 视角判断 ==========
                        // axisViewDot > 0: 正对光锥发射方向（光直射眼睛）
                        // axisViewDot < 0: 背对光锥发射方向（看光源背面）
                        float axisViewDot = dot(vConeAxisWorld, viewDir);
                        
                        // ========== 高度渐变（用于极端角度） ==========
                        float coneHeight = 30.0;
                        float heightGradient = 1.0 - (vLocalPosition.y / coneHeight); // 近光源亮，远处暗
                        
                        // ========== 统一亮度逻辑：极端角度用高度渐变，侧面用 rim ==========
                        // extremeFactor: |axisViewDot| 越接近 1，extremeFactor 越大
                        // pow(x, 5.0) 保持约 ±30°~45° 的生效角度
                        float extremeFactor = pow(abs(axisViewDot), extremePower);
                        
                        // 混合 rim 效果和高度渐变
                        float finalIntensity = mix(angleIntensity, heightGradient * 0.8, extremeFactor);
                        
                        // ========== 双面动态透明度（解决形状问题） ==========
                        // 根据 gl_FrontFacing 判断当前渲染的是正面还是背面
                        // 正面看时(axisViewDot > 0)：back面可见，front面透明
                        // 背面看时(axisViewDot < 0)：front面可见，back面透明
                        float faceVisibility;
                        if (gl_FrontFacing) {
                            // front 面：在背面看时（axisViewDot < 0）可见
                            faceVisibility = smoothstep(0.2, -0.2, axisViewDot);
                        } else {
                            // back 面：在正面看时（axisViewDot > 0）可见
                            faceVisibility = smoothstep(-0.2, 0.2, axisViewDot);
                        }
                        
                        // ========== 最终强度 ==========
                        float spotIntensity = distanceIntensity * finalIntensity;
    
                        // ========== 发射动画：从源头向外逐渐亮起 ==========
                        // vLocalPosition.y: 0 = 源头(锥尖), 30 = 末端(锥底)
                        float reachDistance = animProgress * coneHeight;
                        
                        // 使用 smoothstep 制造平滑的发射前沿
                        float reachFactor = smoothstep(reachDistance, reachDistance - 3.0, vLocalPosition.y);
    
                        // ========== 计算最终 alpha ==========
                        float finalAlpha = spotIntensity * reachFactor * faceVisibility;
                        
                        // ========== 应用图层整体透明度（3D ON/OFF 渐变） ==========
                        finalAlpha *= vLayerOpacity;
                        
                        // ========== 关键：丢弃透明片段 ==========
                        if ((animProgress < 0.01 && finalAlpha < 0.01) || vLayerOpacity < 0.01) {
                            discard;
                        }
    
                        // ========== 最终输出 ==========
                        fragColor = vec4(spotColor, finalAlpha);
    
                        DECKGL_FILTER_COLOR(fragColor, geometry);
                    `
            }, e
        }
    }

    function _m(t) {
        const {
            data: e,
            debugMode: n = !1,
            time: o = 0,
            layerOpacity: r = 1
        } = t, i = -(o * 6) % 360;
        return new Sm({
            id: `volumetric-spotlight-layer-${n?"debug":"normal"}`,
            data: e,
            mesh: xm(),
            getPosition: l => [l.position[0], l.position[1], Eh],
            getOrientation: [0, i, 0],
            sizeScale: Hr,
            getColor: l => l.status !== "offline" ? [255, 255, 255, 255] : [255, 255, 255, 0],
            getLayerOpacity: () => r,
            transitions: {
                getColor: 100
            },
            updateTriggers: {
                getOrientation: [o],
                getColor: e.map(l => l.status),
                getLayerOpacity: [r]
            },
            _lighting: void 0,
            debugMode: n,
            parameters: {
                cullMode: "none",
                depthWriteEnabled: !1,
                depthCompare: "always",
                blend: !0,
                blendColorOperation: "add",
                blendColorSrcFactor: "src-alpha",
                blendColorDstFactor: "one",
                blendAlphaOperation: "add",
                blendAlphaSrcFactor: "one",
                blendAlphaDstFactor: "one"
            }
        })
    }
    return { cls: Sm, build: _m, cone: bm, mesh: xm };
  }


  // ==================== 门控与时序（逐字语义；规格 D-6/D-7/D-8）====================
  // fh :10637-10639 —— 选中站存在、status playing、灯塔不透明度 > .01
  function effectsGateActive(station, lhOpacity) {
    return !!station && station.status === 'playing' && lhOpacity > .01;
  }
  // vo 三门 :13595（on && Fn && fh）
  function selectedEffectsGate(ready, sameArmedStation, fhPass) {
    return !!(ready && sameArmedStation && fhPass);
  }
  // Ge ramp :13676-13678（nt=方向、ge=2、ot=裁剪后帧间隔；越界吸附 target）
  var RAMP_STEP_PER_SEC = 2;
  function rampStep(state, dtSec) {
    var s = { current: state.current, target: state.target };
    if (s.current !== s.target) {
      var nt = s.target > s.current ? 1 : -1;
      s.current += nt * RAMP_STEP_PER_SEC * dtSec;
      s.current = Math.max(0, Math.min(1, s.current));
      if ((nt > 0 && s.current > s.target) || (nt < 0 && s.current < s.target)) s.current = s.target;
    }
    return s;
  }
  // 帧间隔裁剪 :13589-13590（ot = min(Ze, .025)）
  function clampFrameDelta(deltaSec) { return Math.min(deltaSec, .025); }
  // km/Mm/Am :12933-12949 —— 活跃恒真；空闲按 1000/30 节流
  var FRAME_THROTTLE_MS = 1000 / 30;
  function shouldUpdateFrame(st) {
    var timePassed = st.now - st.lastUpdateAt >= FRAME_THROTTLE_MS;
    if (st.hasActiveSelectedDynamicEffects || st.hasActiveExternalLayers ||
      st.hasSelectionAnimationWindow ||
      (st.isProgrammaticCameraFlight && st.hasVisibleSelectedOrExpandedLighthouse)) return true;
    return timePassed;
  }

  // ==================== 色归一化（:13684-13685 /255）====================
  function normalizeColor255(c, fallback) {
    return c ? [c[0] / 255, c[1] / 255, c[2] / 255] : fallback;
  }

  SFV.worldLighthouseEffects = {
    SIZE: xr, PARTICLE_MAX_DISTANCE: PARTICLE_MAX_DISTANCE,
    PARTICLE_RINGS: PARTICLE_RINGS, PARTICLES_PER_RING: PARTICLES_PER_RING,
    PARTICLE_RADIUS_DEG: PARTICLE_RADIUS_DEG, WAVE_SPEED_DEFAULT: WAVE_SPEED_DEFAULT,
    particleData: eg, pulseRingData: function (st) { return pulseBits.ym(st); },
    coneGeometry: bm, effectsGateActive: effectsGateActive,
    selectedEffectsGate: selectedEffectsGate, rampStep: rampStep,
    clampFrameDelta: clampFrameDelta, shouldUpdateFrame: shouldUpdateFrame,
    normalizeColor255: normalizeColor255,
    RING_RADIUS_M: pulseBits.mm * (1 + pulseBits.uc),
    createParticleWaveLayer: createParticleWaveLayer,
    createPulseRingLayer: createPulseRingLayer,
    createSpotlightLayer: createSpotlightLayer,
    spotlightMesh: xm
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined'
    ? window : globalThis).StellaflixVideo.worldLighthouseEffects;
}
