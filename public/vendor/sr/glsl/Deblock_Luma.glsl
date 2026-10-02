// Stellaflix SR — Deblock (luma)
//
// 自写去块：消除 8x8 编码块网格上出现的规则台阶（blocking artifact）。
// 典型症状：天空、暗部、墙面等平坦区域出现隐约的方格状台阶。
//
// 为什么需要它：Deband 管的是色带（banding，大范围渐变的阶梯），
// RCAS 管的是锐度，两者都不处理"按 8x8 网格排列"的压缩块台阶。
// 本 pass 是链上唯一按编码网格对齐工作的组件，且不带 //!WHEN，
// 因此无论源/屏比例是 1.0x 还是 2.0x 都始终生效（这对 1080p 源投 1080p 屏很关键，
// 那种情况下所有 doubler 都会因触及不到触发阈值而整体停摆）。
//
// 引擎方言约束（与 RCAS_Luma.glsl 同一套）：
//   * 别名 HOOKED 只声明 _raw/_mul/_pos/_tex/_texOff，不声明 HOOKED_pt / HOOKED_size；
//     网格对齐需要的像素坐标改用真实 uniform LUMA_size（引擎逐帧上传，已声明）。
//   * HOOKED_texOff(off) 内部展开为 texture(LUMA, v_uv + LUMA_pt * vec2(off))，
//     off 单位为像素，可直接使用。
//   * 本 pass 必须排在超分之前：此时 LUMA 仍是源分辨率，8x8 网格与编码块对齐；
//     放到超分之后网格间距会变成 16 像素，判据失准。
//
// 判据（借鉴 H.264 in-loop deblocking filter 的边界强度思想，做成无分支软权重）：
//   跨边界台阶小      → 像块效应（真实内容差异通常更大）
//   边界两侧内部都平  → 像块效应（真实纹理/边缘处梯度大）
//   两个条件同时成立才平滑，否则原样放行。权重用 smoothstep 连续过渡而非硬阈值，
//   防止处理过程本身制造新的不连续。
//
// 参数由 CPU 侧数值模拟标定（_scratch/sim-deblock3.js），实测：
//   块效应台阶 7.9/255 → 1.67/255（边界附近最大单步）
//   真实边缘 >=30/255、纯平坦、纹理梯度 >=5/255 → 改动恒为 0
//   噪点区仅轻微降噪（±6.4/255 时全图最大改动 3.19/255）
// STRENGTH 与 L1 必须配对调整：只提高 STRENGTH 会让边界第 0 层跑得比第 1 层快，
// 反而在两层之间制造新台阶（S=1.0 实测残留 1.95，比 S=0.80 的 1.67 更差）。

//!HOOK LUMA
//!BIND HOOKED
//!DESC Stellaflix Deblock (8x8 grid step remover)
//!COMPONENTS 1

#define BLOCK     8.0     // 编码块边长（H.264/HEVC 变换块）。源非 8 的倍数或带奇数列裁切时会错位，属已知局限。
#define STEP_MAX  0.070   // 跨边界台阶上限 ≈18/255；超过判为真实内容差异，不动
#define GRAD_MAX  0.020   // 边界两侧内部梯度上限 ≈5/255；超过判为纹理或真实边缘，不动
#define STRENGTH  0.80    // 修正强度：与 L1 配对标定，勿单独调大
#define L1        0.50    // 块内第 2 层的修正权重（0 = 只修紧贴边界的一层）

float sfvDbL(vec2 off) { return HOOKED_texOff(off).r; }

// 单个轴向的修正量。axis: vec2(1,0) 处理跨垂直边界，vec2(0,1) 处理跨水平边界。
// coord: 该轴向上的整数像素坐标。返回加到中心像素上的增量（未钳制）。
float sfvDbAxis(vec2 axis, float coord) {
  float b     = mod(coord, BLOCK);             // 块内坐标 0..BLOCK-1
  float layer = min(b, BLOCK - 1.0 - b);       // 距最近块边界的层数
  if (layer > 1.5) return 0.0;                 // 只处理紧贴边界的两层（H.264 滤波等效范围）
  float side = (b < BLOCK * 0.5) ? -1.0 : 1.0; // 块外邻居所在方向
  vec2  dir  = axis * side;
  float t    = layer;                          // 从本像素走到紧贴边界那一层的步数

  float B = sfvDbL(dir *  t);                  // 边界内侧第 0 层（紧贴边界）
  float C = sfvDbL(dir * (t + 1.0));           // 边界外侧第 0 层
  float A = sfvDbL(dir * (t - 1.0));           // 边界内侧第 1 层
  float D = sfvDbL(dir * (t + 2.0));           // 边界外侧第 1 层

  float d  = abs(B - C);                       // 跨边界台阶
  float gB = abs(B - A);                       // 内侧局部梯度
  float gC = abs(C - D);                       // 外侧局部梯度

  // 台阶越大越像真实内容差异 → 权重衰减到 0。
  // 衰减起点取 0.6*STEP_MAX（≈11/255）而非更低：实测若从 0.4 起衰减，
  // 12/255 的中等块效应只能修掉一半（真机实测 12→6/255）。
  float wStep = 1.0 - smoothstep(STEP_MAX * 0.6, STEP_MAX, d);
  // 两侧内部越不平（纹理/细节）→ 权重衰减到 0
  float wFlat = 1.0 - smoothstep(GRAD_MAX * 0.4, GRAD_MAX, max(gB, gC));
  // 完全无台阶时无需处理，避免对纯净平坦区产生无谓模糊
  float wNeed = smoothstep(0.0, GRAD_MAX * 0.5, d);

  float lw = (layer < 0.5) ? 1.0 : L1;         // 第 2 层按权重衰减，使过渡连续
  return (C - B) * 0.5 * (wStep * wFlat * wNeed * STRENGTH * lw);
}

vec4 hook() {
  vec2  pix = floor(HOOKED_pos * LUMA_size);   // 当前像素整数坐标（LUMA_size = 源分辨率）
  float c   = HOOKED_tex(HOOKED_pos).r;
  float dlt = sfvDbAxis(vec2(1.0, 0.0), pix.x)
            + sfvDbAxis(vec2(0.0, 1.0), pix.y);
  // 块角处两轴会叠加，钳到单轴最大修正量，避免角落过冲
  float MAXD = STEP_MAX * 0.5 * STRENGTH;
  float v    = clamp(c + clamp(dlt, -MAXD, MAXD), 0.0, 1.0);
  return vec4(v, v, v, 1.0);                   // 与内建 LUMA_FS 一致：三通道同值 + 不透明
}
