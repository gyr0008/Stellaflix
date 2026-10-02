// Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
// FidelityFX Super Resolution v1.0.2 -- RCAS (Robust Contrast Adaptive Sharpening)
// Original: AMD FidelityFX FSR, ported to mpv by agyild.
//
// Stellaflix SR port notes:
//   * Only the RCAS sharpening pass is kept. The EASU upscaling pass was stripped
//     because this engine already upscales luma with FSRCNNX before this stage.
//   * The original bound EASUTEX (EASU output). This port binds HOOKED instead
//     (the current luma plane) and stays 1:1, so no WIDTH/HEIGHT overrides.
//   * No *_gather macro exists here, so sampling uses the *_texOff fallback
//     branch already shipped in AMD's original source. Numerically equivalent.
//   * FSR_RCAS_DENOISE is enabled: sharpening is damped where the local
//     neighbourhood looks noisy, which matters for live-action grain.
//
// License: MIT (see header above). Copyright (c) 2021 Advanced Micro Devices, Inc.

//!HOOK LUMA
//!BIND HOOKED
//!DESC FidelityFX RCAS (luma sharpener)
//!COMPONENTS 1

// User variables - RCAS
#define SHARPNESS 0.0          // 0.0 = maximum, each step halves the sharpening
#define FSR_RCAS_DENOISE 1     // 1 = damp sharpening on noisy areas
#define FSR_PQ 0               // source is not PQ/HDR
#define FSR_RCAS_LIMIT (0.25 - (1.0 / 16.0))

float APrxMedRcpF1(float a) {
  float b = uintBitsToFloat(uint(0x7ef19fff) - floatBitsToUint(a));
  return b * (-b * a + 2.0);
}
float AMin3F1(float x, float y, float z) { return min(x, min(y, z)); }
float AMax3F1(float x, float y, float z) { return max(x, max(y, z)); }

vec4 hook() {
  // Algorithm uses minimal 3x3 pixel neighbourhood.
  //    b
  //  d e f
  //    h
  float b = HOOKED_texOff(vec2( 0.0, -1.0)).r;
  float d = HOOKED_texOff(vec2(-1.0,  0.0)).r;
  float e = HOOKED_tex(HOOKED_pos).r;
  float f = HOOKED_texOff(vec2( 1.0,  0.0)).r;
  float h = HOOKED_texOff(vec2( 0.0,  1.0)).r;

  // Min and max of ring.
  float mn1L = min(AMin3F1(b, d, f), h);
  float mx1L = max(AMax3F1(b, d, f), h);

  // Immediate constants for peak range.
  vec2 peakC = vec2(1.0, -1.0 * 4.0);

  // Limiters, these need to be high precision RCPs.
  float hitMinL = min(mn1L, e) / (4.0 * mx1L);
  float hitMaxL = (peakC.x - max(mx1L, e)) / (4.0 * mn1L + peakC.y);
  float lobeL = max(-hitMinL, hitMaxL);
  float lobe = max(float(-FSR_RCAS_LIMIT), min(lobeL, 0.0)) * exp2(-clamp(float(SHARPNESS), 0.0, 2.0));

  // Apply noise removal.
#if (FSR_RCAS_DENOISE == 1)
  // Noise detection.
  float nz = 0.25 * b + 0.25 * d + 0.25 * f + 0.25 * h - e;
  nz = clamp(abs(nz) * APrxMedRcpF1(AMax3F1(AMax3F1(b, d, e), f, h) - AMin3F1(AMin3F1(b, d, e), f, h)), 0.0, 1.0);
  nz = -0.5 * nz + 1.0;
  lobe *= nz;
#endif

  // Resolve, which needs the medium precision rcp approximation to avoid visible tonality changes.
  float rcpL = APrxMedRcpF1(4.0 * lobe + 1.0);
  vec4 pix = vec4(0.0, 0.0, 0.0, 1.0);
  pix.r = float((lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL);
  return pix;
}
