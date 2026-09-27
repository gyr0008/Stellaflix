'use strict';

/**
 * 世界页 hearthere parity 步骤① — globe SDK vendor 落盘 + ESM 桥接
 * 运行：node --test tests/world-globe-sdk-vendor.test.js
 *
 * 基准：hearthere 线上底座 = @maptiler/sdk 3.9.0 + maplibre-gl ~5.6.x
 * （证据：_hearthere_assets/vendor-maptiler-mo8yp7Jo.js 含版本串 "3.9.0"；
 *  npm registry @maptiler/sdk@3.9.0 deps maplibre-gl ~5.6.0；
 *  main.pretty.js:115-125 Eu.apiKey / Tu(style uuid, projection globe, space, halo)）
 *
 * 断言物：
 *  1) 自包含 ESM bundle（esbuild 一次性构建，非运行时 npm 依赖）
 *  2) 配套 CSS 两份（maplibre 5.6.2 / sdk 3.9.0）
 *  3) LICENSES.md（BSD-3-Clause @maptiler/sdk、ISC maplibre-gl 等原文归档 + 构建命令可追溯）
 *  4) 桥接 world-globe-esm.js：import bundle → window.StellaflixVideo.maptilerGlobe，
 *     动态注入 CSS link，暴露 ready promise
 *  5) index.html 恰一个 type="module" 桥接 script
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

const V = 'public/vendor/maptiler';
const BUNDLE = V + '/maptiler-sdk-3.9.0.bundle.mjs';

test('bundle 落盘：存在、体积合理、含 space/halo/Map 导出', () => {
  assert.ok(exists(BUNDLE), BUNDLE + ' 应存在');
  const buf = fs.readFileSync(path.join(root, BUNDLE));
  assert.ok(buf.length > 500000, 'sdk+maplibre 全量 bundle 应 >500KB，实际 ' + buf.length);
  const s = buf.toString('utf8');
  assert.ok(s.includes('resources/space'), 'space 星空资源路径应在（api.maptiler.com/resources/space）');
  assert.ok(/as Map[,}\s]/.test(s.slice(s.lastIndexOf('export'))), '应导出 Map');
  assert.ok(/as (SdkConfig|config)[,}\s]/.test(s.slice(s.lastIndexOf('export'))), '应导出 config/SdkConfig（apiKey 注入口）');
  assert.ok(s.includes('5.6.2'), '内联的 maplibre 版本串应为 5.6.2（与 hearthere 一致）');
});

test('CSS 两份落盘', () => {
  assert.ok(exists(V + '/maplibre-gl-5.6.2.css'), 'maplibre 5.6.2 css');
  assert.ok(exists(V + '/maptiler-sdk-3.9.0.css'), 'sdk 3.9.0 css');
  assert.ok(read(V + '/maplibre-gl-5.6.2.css').includes('maplibregl'), 'maplibre css 内容校验');
  assert.ok(read(V + '/maptiler-sdk-3.9.0.css').length > 100, 'sdk css 非空');
});

test('LICENSES.md：许可原文 + 构建命令可追溯', () => {
  assert.ok(exists(V + '/LICENSES.md'));
  const s = read(V + '/LICENSES.md');
  assert.ok(s.includes('BSD-3-Clause'), '@maptiler/sdk 许可');
  assert.ok(s.includes('ISC'), 'maplibre-gl 许可');
  assert.ok(s.includes('esbuild'), '构建命令留痕（一次性构建工具，非运行时依赖）');
});

test('桥接 world-globe-esm.js：import bundle + 全局挂载 + CSS 动态注入', () => {
  assert.ok(exists('public/video/world-globe-esm.js'));
  const s = read('public/video/world-globe-esm.js');
  assert.ok(s.includes('../vendor/maptiler/maptiler-sdk-3.9.0.bundle.mjs'), '应 import bundle');
  assert.ok(s.includes('maptilerGlobe'), '应挂 StellaflixVideo.maptilerGlobe');
  assert.ok(s.includes('maplibre-gl-5.6.2.css') && s.includes('maptiler-sdk-3.9.0.css'), '应动态注入两份 css');
  assert.ok(s.includes('ready'), '应暴露 ready promise 供后续步骤 gate');
});

test('index.html 恰一个 module 桥接 script，且在 SFV_SCRIPTS 之后注入', () => {
  const html = read('public/index.html');
  const m = html.match(/<script[^>]*type="module"[^>]*video\/world-globe-esm\.js[^>]*><\/script>/g) || [];
  assert.strictEqual(m.length, 1, '桥接 script 应恰好一个');
  assert.ok(html.indexOf('video/world-globe-esm.js') > html.indexOf('"video/world-globe.js"'),
    'module 桥接应在经典 SFV_SCRIPTS 序列之后（模块脚本天然 defer，顺序仅作可读性约束）');
});

// 用户实测（截图 111550）：app 的 3000 静态服务把 .mjs 落到 text/plain 兜底，
// 浏览器拒绝 module import（"Failed to fetch dynamically imported module"）。
test('server.js MIME 表须把 .mjs 作为 javascript 提供', () => {
  const s = read('server.js');
  const m = s.match(/const MIME = \{[\s\S]*?\};/);
  assert.ok(m, 'MIME 表应存在');
  assert.ok(/'\.mjs':\s*'application\/javascript'/.test(m[0]),
    "MIME 表应含 '.mjs': 'application/javascript'（否则 serveStatic 兜底 text/plain，module import 被拒）");
});
