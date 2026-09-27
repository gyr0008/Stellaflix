'use strict';

/**
 * 世界页 底座契约回归 — world-globe.js（步骤② hearthere parity 后的一般契约）
 * 运行：node --test tests/world-globe.test.js
 *
 * hearthere cd() 逐字行为（Map options/Fa/ld/衰减族/wheel/webgl2/竞态）已由
 * tests/world-globe-hearthere-basemap.test.js 全面接管；本文件只守：
 *  - SFV.worldGlobe 导出面与空态行为
 *  - 桥缺失时的失败口径（reject，不静默降级 —— 步骤② 起无降级链）
 *  - index.html 启动链（esm 桥 + 经典脚本次序）
 *  - page-world.js 接线面
 *  - 语法合法
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function makeEl(tag) {
  return {
    tagName: tag,
    style: {},
    className: '',
    children: [],
    innerHTML: '',
    src: '',
    rel: '',
    href: '',
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    getContext(kind) { return kind === 'webgl2' ? {} : null; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    },
    querySelector() { return null; }
  };
}

function loadWorldGlobe(extra) {
  const sandbox = Object.assign({
    console: { warn() {}, log() {}, error() {} },
    Promise,
    setTimeout,
    clearTimeout,
    document: { createElement: makeEl, querySelector: () => null, head: makeEl('head') },
    deck: { MapboxOverlay: function () { this.finalize = () => {}; } },
    StellaflixVideo: {}
  }, extra || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/world-globe.js'), sandbox);
  return sandbox.StellaflixVideo.worldGlobe;
}

test('world-globe.js 注册 SFV.worldGlobe：mount/unmount/getMap 契约齐备，空态安全', async () => {
  const wg = loadWorldGlobe();
  assert.ok(wg, 'SFV.worldGlobe 应已导出');
  assert.strictEqual(typeof wg.mount, 'function');
  assert.strictEqual(typeof wg.unmount, 'function');
  assert.strictEqual(typeof wg.getMap, 'function');
  assert.strictEqual(wg.getMap(), null, '未 mount 时 getMap 应为 null');
  wg.unmount();
  wg.unmount(); // 幂等
  await assert.rejects(() => wg.mount(null), /host 为空/);
});

test('步骤② 无降级链：桥缺失时 mount reject 上报（不再静默跳自研底图）', async () => {
  const wg = loadWorldGlobe(); // sandbox 无 StellaflixVideo.maptilerGlobe
  await assert.rejects(() => wg.mount(makeEl('div')), /maptilerGlobe|桥未加载/);
});

test('index.html：esm 桥 + world-globe.js 双链齐备且次序正确，world-cesium.js 退役', () => {
  const html = read('public/index.html');
  const iBridge = html.indexOf('video/world-globe-esm.js');
  const iWg = html.indexOf('"video/world-globe.js"');
  const iPw = html.indexOf('"video/page-world.js"');
  assert.ok(iBridge >= 0, '步骤① ESM 桥应在 index.html');
  assert.ok(/<script type="module" src="video\/world-globe-esm\.js"><\/script>/.test(html),
    '桥必须是 type=module 脚本');
  assert.ok(iWg >= 0, 'world-globe.js 应在 SFV_SCRIPTS 中');
  assert.ok(iPw >= 0, 'page-world.js 应在 SFV_SCRIPTS 中');
  assert.ok(iWg < iPw, 'world-globe.js 必须先于 page-world.js 加载');
  assert.strictEqual((html.match(/video\/world-globe\.js"/g) || []).length, 1, '不得重复登记');
  assert.ok(!/world-cesium\.js/.test(html), '启动链不得再出现 world-cesium.js');
});

test('page-world.js 接线面：底座走 SFV.worldGlobe，deck 层直收 map/overlay', () => {
  const src = read('public/video/page-world.js');
  assert.match(src, /SFV\.worldGlobe\.mount/, 'mount 应走 worldGlobe');
  assert.match(src, /SFV\.worldGlobe\.unmount/, 'unmount 应走 worldGlobe');
  assert.ok(!/worldCesium/.test(src), '不得再引用 SFV.worldCesium');
  assert.match(src, /video\/world-globe\.js/, '错误文案应指向 video/world-globe.js');
  assert.match(src, /worldLighthouseDeck\.mount\(info\.map, info\.overlay/);
  assert.match(src, /worldMapActions\.mount\(info\.map/);
  // 步骤②：basemap 标签收敛为 maptiler 单档
  assert.match(src, /info\.basemap === 'maptiler'/);
  assert.ok(!/darkgray|esri' \?/.test(src), '旧降级档标签应退役');
});

test('world-globe.js 语法合法', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['--check', path.join(root, 'public/video/world-globe.js')], {
    encoding: 'utf8', stdio: 'pipe'
  });
});
