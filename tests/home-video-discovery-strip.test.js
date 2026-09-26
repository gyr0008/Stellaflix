'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!declaration) return '';
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  if (bodyStart < 0) return '';
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.index, index + 1);
    }
  }
  return '';
}

test('index-loader 在仪表盘模块之前加载 home-video-discovery.js', () => {
  const loader = read('public', 'js', 'index-loader.js');
  const mod = loader.indexOf('js/home-video-discovery.js');
  const dash = loader.indexOf('js/modules/05-playback/03a-home-dashboard.js');
  assert.ok(mod >= 0, 'home-video-discovery.js 必须在 loader 清单中');
  assert.ok(dash >= 0, '仪表盘模块必须在 loader 清单中');
  assert.ok(mod < dash, '选卡模块必须先于仪表盘加载');
});

test('renderHomeDashboardDiscovery 影视态走三卡分支，音乐态原逻辑保留（T118）', () => {
  const src = read('public', 'js', 'modules', '05-playback', '03a-home-dashboard.js');
  const body = namedFunctionSource(src, 'renderHomeDashboardDiscovery');
  assert.ok(body.length > 0, 'renderHomeDashboardDiscovery 必须存在');
  assert.match(body, /video-space-active/, '影视态判定必须存在');
  assert.match(body, /renderHomeDashboardVideoDiscovery\(root\)/, '影视态必须委托三卡渲染');
  assert.match(body, /homeDashboardDiscoverySongs\(\)/, '音乐态原数据源不得丢失');
  assert.match(body, /playHomeDashboardDiscoverySong/, '音乐态点击路径不得丢失');
  assert.match(body, /换一首，也许正合心意/, '切回音乐态必须还原被影视态覆写的文案（T118）');
  assert.match(body, /home-discovery-rotate/, '切回音乐态必须隐藏换一批按钮');
});

test('影视态三卡渲染：取卡/文案/换一批/代理封面/空态隐藏', () => {
  const src = read('public', 'js', 'modules', '05-playback', '03a-home-dashboard.js');
  const body = namedFunctionSource(src, 'renderHomeDashboardVideoDiscovery')
    + namedFunctionSource(src, 'homeDashboardVideoPosterUrl');
  assert.ok(namedFunctionSource(src, 'renderHomeDashboardVideoDiscovery').length > 0, 'renderHomeDashboardVideoDiscovery 必须存在');
  assert.match(body, /StellaflixHomeVideoDiscovery/, '必须调用选卡模块');
  assert.match(body, /\.getCards\(\)/);
  assert.match(body, /挑一部，今晚就开映/, '文案区必须换成影视态标题');
  assert.match(body, /换一批/, '必须有换一批入口');
  assert.match(body, /\.rotate\(\)/, '换一批必须走模块轮换');
  assert.match(body, /\/api\/proxy\?url=/, 'TMDB 海报必须走本地代理');
  assert.match(body, /style\.display = 'none'/, '无卡可出时整条隐藏，不留音乐空态');
  assert.doesNotMatch(body, /等待你的音乐/, '影视态不得出现音乐空态文案');
});

test('影视态卡片点击经 openDetailFromMeta 进详情页', () => {
  const src = read('public', 'js', 'modules', '05-playback', '03a-home-dashboard.js');
  const body = namedFunctionSource(src, 'openHomeDashboardVideoDiscoveryCard');
  assert.ok(body.length > 0, 'openHomeDashboardVideoDiscoveryCard 必须存在');
  assert.match(body, /openDetailFromMeta/);
  assert.match(body, /homeDashboardVideoDiscoveryCache/);
});

test('模式切换强制指纹失效（修复：切回音乐态残留影视卡片）', () => {
  const src = read('public', 'js', 'modules', '05-playback', '03a-home-dashboard.js');
  const gate = namedFunctionSource(src, 'homeDashboardDiscoveryModeGate');
  assert.ok(gate.length > 0, 'homeDashboardDiscoveryModeGate 必须存在');
  const harness = [
    'var homeDashboardDiscoveryLastMode = "";',
    'var homeDashboardDiscoveryFingerprint = "";',
    'var homeDashboardVideoDiscoveryFingerprint = "";',
    gate,
    'result = (function () {',
    '  homeDashboardDiscoveryModeGate("music");',
    '  homeDashboardDiscoveryFingerprint = "A";',
    '  homeDashboardVideoDiscoveryFingerprint = "B";',
    '  var sameMode = homeDashboardDiscoveryModeGate("music");',
    '  var kept = [homeDashboardDiscoveryFingerprint, homeDashboardVideoDiscoveryFingerprint];',
    '  var switched = homeDashboardDiscoveryModeGate("video");',
    '  var cleared = [homeDashboardDiscoveryFingerprint, homeDashboardVideoDiscoveryFingerprint];',
    '  return { sameMode, kept, switched, cleared };',
    '})();',
  ].join('\n');
  const ctx = vm.createContext({});
  vm.runInContext(harness, ctx);
  assert.equal(ctx.result.sameMode, false, '同模式不得清指纹');
  assert.equal(ctx.result.kept.join(','), 'A,B');
  assert.equal(ctx.result.switched, true, '跨模式必须强制失效');
  assert.equal(ctx.result.cleared.join(','), ',');
  const body = namedFunctionSource(src, 'renderHomeDashboardDiscovery');
  assert.match(body, /homeDashboardDiscoveryModeGate\(/, '渲染入口必须调用模式 gate');
});

test('影视态恢复「每周新番」radio 卡（用户 09-24 决定：与 FOR YOU 条带并存）', () => {
  const src = read('public', 'js', 'modules', '05-playback', '03a-home-dashboard.js');
  const dock = namedFunctionSource(src, 'renderHomeInsightDock');
  const radioStart = dock.indexOf('home-radio-entry');
  assert.ok(radioStart >= 0);
  const radioBlock = dock.slice(radioStart, dock.indexOf('home-ranking-entry:not', radioStart));
  assert.doesNotMatch(radioBlock, /radioCard\.style\.display = 'none'/, '不得再隐藏新番卡');
  assert.match(radioBlock, /BANGUMI · 放送表/, '影视态必须还原新番卡文案');
  assert.match(radioBlock, /每周新番/, '影视态标题必须为每周新番');
  assert.match(radioBlock, /openCalendar/, '影视态点击必须打开放送表');
  assert.match(radioBlock, /RADIO MODES/, '音乐态原文案保留');
});
