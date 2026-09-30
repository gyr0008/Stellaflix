/*
 * Stellaflix 影视模块 — 程序化灯塔模型（世界页 Task 3）
 *
 * 职责：生成【单座】灯塔网格（底座锥台 + 收分塔身 + 灯室 + 出挑檐 + 锥形顶），
 * 以 typed arrays 输出，供 Task 4 的 deck.gl SimpleMeshLayer 直接消费。
 * 纯数学，无 DOM / 无 WebGL，可被 Node 测试直接 require。
 *
 * 坐标系：局部米制，+Y 朝上，塔底圆心在原点（y=0），檐顶 y=modelHeight。
 *
 * 版权红线：本模块为**原创程序化几何**——不下载、不引用、不逐面复刻 HearThere
 * 的 lighthouse.obj。仅整体剪影比例参考计划中公开引用的顶点数据
 * （底座环 r≈0.83 @ y=0.22、r≈0.72 @ y≈0.29，main.pretty.js:11390 附近 OBJ
 * 顶点实测值 v -0.832708 0.220000 → v -0.725354 0.293041）与灯塔的通用人人
 * 可见外形（锥形塔身 + 灯室 + 出檐），塔高量级对齐其总高 9.22 → 本作 9.3。
 *
 * 输出契约（Task 4 消费）：
 *   SFV.worldLighthouseModel.build({segments}) ->
 *     { positions: Float32Array, normals: Float32Array, heights: Float32Array,
 *       indices: Uint16Array, modelHeight: number }
 *
 * 法线策略：逐面平面法线（flat shading）——灯塔切面感本就契合该造型；
 * 每三角形独占 3 顶点，因此法线天然单位化且无共享平滑歧义。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // ---- 轮廓母线（(r, y) 半平面折线，自轴线底部起、至轴线檐顶止）----
  // 折线不自交且两端都在轴线上 → 旋转后为闭合水密曲面；遍历方向保证
  // 侧面/台阶面法线朝外（水平环：r 递增段朝下、r 递减段朝上，与实体朝向一致）。
  var PROFILE = [
    [0.00, 0.00],  // 轴线：塔底中心
    [0.95, 0.00],  // 底缘
    [0.83, 0.22],  // 计划引用剪影数据：r≈0.83 @ y=0.22
    [0.72, 0.29],  // 计划引用剪影数据：r≈0.72 @ y≈0.29
    [0.72, 0.40],  // 底座小鼓段
    [0.55, 0.40],  // 台阶（朝上）→ 塔根部
    [0.36, 7.30],  // 塔身锥台收分（长段）
    [0.50, 7.30],  // 平台底（朝下环面）
    [0.50, 7.42],  // 平台外壁
    [0.40, 7.42],  // 平台面（朝上环面）
    [0.40, 8.55],  // 灯室壁
    [0.68, 8.55],  // 出挑檐底（朝下环面，出挑 0.28）
    [0.68, 8.68],  // 檐口侧壁
    [0.44, 8.68],  // 檐顶（朝上环面）
    [0.44, 8.85],  // 顶鼓小段
    [0.00, 9.30]   // 轴线：锥形顶收束（modelHeight）
  ];

  var DEFAULT_SEGMENTS = 16;
  var MIN_SEGMENTS = 3;    // 低于 3 无法构成回转体
  var MAX_SEGMENTS = 128;  // 每段 28 三角形 → 128 段 ≈ 10752 顶点，Uint16 安全
  var AXIS_EPS = 1e-9;

  function build(options) {
    options = options || {};
    var segments = Math.floor(options.segments == null ? DEFAULT_SEGMENTS : options.segments);
    if (!isFinite(segments)) segments = DEFAULT_SEGMENTS;
    segments = Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, segments));

    var positions = [];
    var normals = [];
    var indices = [];

    // 发射一个三角形：三点各自独占顶点，法线 = 归一化面法线（cross(b-a, c-a)）
    function tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy;
      var ny = uz * vx - ux * vz;
      var nz = ux * vy - uy * vx;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < AXIS_EPS) return; // 防御：退化三角形直接丢弃
      nx /= len; ny /= len; nz /= len;
      var base = positions.length / 3;
      positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      indices.push(base, base + 1, base + 2);
    }

    function px(r, theta) { return r * Math.cos(theta); }
    function pz(r, theta) { return r * Math.sin(theta); }

    var step = (Math.PI * 2) / segments;
    var modelHeight = 0;

    for (var k = 0; k + 1 < PROFILE.length; k++) {
      var r0 = PROFILE[k][0], y0 = PROFILE[k][1];
      var r1 = PROFILE[k + 1][0], y1 = PROFILE[k + 1][1];
      if (y0 > modelHeight) modelHeight = y0;
      if (y1 > modelHeight) modelHeight = y1;
      for (var i = 0; i < segments; i++) {
        var t0 = i * step, t1 = (i + 1) * step;
        // A,B 在下环（θ0,θ1）；C,D 在上环（θ1,θ0）
        var ax = px(r0, t0), az = pz(r0, t0);
        var bx = px(r0, t1), bz = pz(r0, t1);
        var cx = px(r1, t1), cz = pz(r1, t1);
        var dx = px(r1, t0), dz = pz(r1, t0);
        if (r0 <= AXIS_EPS) {
          // 底部扇面（A 在轴线）：绕序取 (A,D,C) → 法线 -Y 朝下
          tri(ax, y0, az, dx, y1, dz, cx, y1, cz);
        } else if (r1 <= AXIS_EPS) {
          // 顶部锥面（C 收束到轴线）：绕序取 (A,C,B) → 法线外上
          tri(ax, y0, az, cx, y1, cz, bx, y0, bz);
        } else {
          // 一般带（锥台/圆柱/水平环面）：(A,C,B) + (A,D,C) → 朝外
          tri(ax, y0, az, cx, y1, cz, bx, y0, bz);
          tri(ax, y0, az, dx, y1, dz, cx, y1, cz);
        }
      }
    }

    var heights = new Float32Array(positions.length / 3);
    for (var v = 0; v < heights.length; v++) heights[v] = positions[v * 3 + 1];

    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      heights: heights,
      indices: new Uint16Array(indices),
      modelHeight: modelHeight
    };
  }

  SFV.worldLighthouseModel = { build: build, PROFILE: PROFILE };

  // Node 直连 require（本测试与 Task 4 无关的纯数学模块无需 vm 沙箱）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SFV.worldLighthouseModel;
  }
})(typeof window !== 'undefined' ? window : globalThis);
