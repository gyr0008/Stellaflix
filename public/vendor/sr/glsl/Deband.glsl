//!HOOK LUMA
//!BIND HOOKED
// 自写去色带（Deband）：在 luma 链首运行，消除暗场天空/渐变大色块的"楼梯纹"。
// 引擎方言约束：别名 HOOKED 不声明 _pt，只能用已定义的 HOOKED_tex / HOOKED_pos / HOOKED_texOff。
// 默认 SAVE 回 LUMA，先于 FSRCNNX 运行，去带结果被超分链路与最终 recombine 采用。
vec4 hook() {
  vec2 pos = HOOKED_pos;
  // 静态 hash 随机相位（不用 u_time，引擎零改动）
  float h1 = fract(sin(dot(pos, vec2(12.9898, 78.233))) * 43758.5453);
  float h2 = fract(sin(dot(pos + 7.31, vec2(39.425, 11.28))) * 24634.6345);
  vec2 r = (vec2(h1, h2) - 0.5) * 1.5;            // 采样半径 1.5px
  vec4 orig = HOOKED_tex(pos);
  vec4 avg = 0.25 * ( HOOKED_texOff(vec2( r.x,  r.y))
                     + HOOKED_texOff(vec2(-r.x,  r.y))
                     + HOOKED_texOff(vec2( r.x, -r.y))
                     + HOOKED_texOff(vec2(-r.x, -r.y)) );
  vec4 diff = abs(avg - orig);
  vec4 thr  = vec4(0.030);                        // 去带强度（0.02~0.05 间调）
  vec4 k    = clamp((thr - diff) / thr, 0.0, 1.0) * 0.9;  // 低于阈值才混合，保细节
  return mix(orig, avg, k);
}
