'use strict';

/**
 * 首页「精选片单」浮层 v2 = 片单中心（5 tab + 参照式两列封面卡网格）
 * 运行：node --test tests/home-video-collections-overlay.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
const dashboardScript = fs.readFileSync(
  path.join(appRoot, 'public', 'js', 'modules', '05-playback', '03a-home-dashboard.js'),
  'utf8',
);
const overlayPath = path.join(appRoot, 'public', 'video', 'home-collections-overlay.js');
const overlayExists = fs.existsSync(overlayPath);
const overlayScript = overlayExists ? fs.readFileSync(overlayPath, 'utf8') : '';
const onlineCollectionsScript = fs.readFileSync(
  path.join(appRoot, 'public', 'video', 'online-collections.js'),
  'utf8',
);
const indexCss = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
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
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.index, index + 1);
    }
  }
  return '';
}

test('影视态 DISCOVER 卡反转为精选片单入口', () => {
  const dock = namedFunctionSource(dashboardScript, 'renderHomeInsightDock');
  assert.ok(dock, 'expected renderHomeInsightDock()');
  assert.match(dock, /精选片单/);
  assert.match(dock, /homeCollectionsOverlay/);
  assert.match(dock, /CURATED\s*·\s*精选片单/);
  // 反转分支必须调用浮层 open()
  assert.match(dock, /homeCollectionsOverlay[\s\S]{0,120}open\s*\(/);
});

test('音乐态 DISCOVER 卡原文案与行为 100% 保留（T118）', () => {
  // 静态 HTML 原文案不动
  assert.match(indexHtml, /<span class="home-ranking-entry-title">平台热歌与个人偏好<\/span>/);
  assert.match(indexHtml, /onclick="openHomeDashboardCharts\(\)"/);
  const openCharts = namedFunctionSource(dashboardScript, 'openHomeDashboardCharts');
  assert.match(openCharts, /openHomePlatformRecommendations\s*\(\s*['"]netease['"]\s*\)/);
  // 影视态反转后，非影视态分支必须还原原文案（否则切回音乐态残留影视文案）
  const dock = namedFunctionSource(dashboardScript, 'renderHomeInsightDock');
  assert.match(dock, /平台热歌与个人偏好/);
  assert.match(dock, /openHomeDashboardCharts/);
});

test('浮层壳在 index.html 且脚本按依赖顺序注册', () => {
  assert.match(indexHtml, /id="home-video-collections-mask"/);
  const scripts = indexHtml.slice(indexHtml.indexOf('SFV_SCRIPTS'));
  const overlayIdx = scripts.indexOf('"video/home-collections-overlay.js"');
  assert.ok(overlayIdx > -1, 'home-collections-overlay.js 必须列入 SFV_SCRIPTS');
  assert.ok(
    overlayIdx > scripts.indexOf('"video/collections.js"') &&
      overlayIdx > scripts.indexOf('"video/online.js"'),
    '浮层脚本须晚于 collections/online',
  );
});

test('浮层为片单中心：5 tab（推荐/主题/经典/高分/获奖），不含 mine/calendar', () => {
  assert.ok(overlayExists, 'public/video/home-collections-overlay.js 必须存在');
  assert.match(overlayScript, /SFV\.homeCollectionsOverlay\s*=/);
  const tabsArr = /var OVERLAY_TABS\s*=\s*\[[\s\S]*?\];/.exec(overlayScript);
  assert.ok(tabsArr, '须定义 OVERLAY_TABS 数组');
  const tabsSrc = tabsArr[0];
  for (const id of ['featured', 'theme', 'classic', 'highscore', 'awards']) {
    assert.ok(tabsSrc.includes(`'${id}'`), `tab 条须含 ${id}`);
  }
  for (const label of ['推荐', '主题', '经典', '高分', '获奖']) {
    assert.ok(overlayScript.includes(label), `tab 条须有文案 ${label}`);
  }
  assert.equal(overlayScript.includes("'mine'"), false, '浮层不得含「我的片单」tab');
  assert.equal(overlayScript.includes("'calendar'"), false, '每周新番走 BANGUMI 卡，不进片单浮层');
  // tab 数据源只读内置 CATALOG
  assert.match(overlayScript, /collections\.getByTab\s*\(/);
});

test('封面卡 v3：纯色 warm 场域 + 左置扇形叠卡 + 独立文案区（2026-09-25 参照截图，去海报模糊底）', () => {
  // JS 结构：cover 场域包住 stack，文案区在 cover 之外；模糊海报底层整体移除
  assert.match(overlayScript, /home-video-collections-grid/);
  assert.match(overlayScript, /home-video-collections-cover/);
  assert.equal(overlayScript.includes('home-video-collections-card-bg'), false, '海报模糊底层须移除');
  assert.match(overlayScript, /home-video-collections-stack/);
  assert.match(overlayScript, /共.{0,3}部/); // 「共N部/精选N部」
  const css = indexCss;
  assert.ok(/grid-template-columns:\s*repeat\(\s*2[^}]+\}/s.test(css), '两列网格保持');
  // 封面区 = warm 纯色场域（同色系 linear-gradient），禁 blur 海报底（canvas 红线不变）
  const coverRule = /\.home-video-collections-cover\s*\{[^}]*\}/s.exec(css);
  assert.ok(coverRule, '缺少 .home-video-collections-cover 规则');
  assert.match(coverRule[0], /linear-gradient\(/);
  assert.match(coverRule[0], /--wc-warm/);
  assert.equal(/filter:\s*blur/.test(coverRule[0]), false, '封面区不得再用模糊海报底');
  // 边缘渐晕层随模糊底一并移除（纯色场域无「外圈亮光」问题）
  const afterRule = /\.home-video-collections-card::after\s*\{[^}]*\}/s.exec(css);
  assert.ok(!afterRule || !/radial-gradient\(/.test(afterRule[0]), '边缘渐晕层须移除');
  // 卡面保持无外发光描边（用户 2026-09-19 裁定继续有效）
  const cardRule = /\.home-video-collections-card\s*\{[^}]*\}/s.exec(css);
  assert.ok(cardRule, '缺少 .home-video-collections-card 规则');
  assert.match(cardRule[0], /border:\s*1px solid transparent/);
  // 扇形叠卡：首卡最高在前，后卡阶梯下降露右缘（z-index 递减）
  const stack1 = /\.home-video-collections-stack img:nth-child\(1\)\s*\{[^}]*\}/s.exec(css);
  const stack2 = /\.home-video-collections-stack img:nth-child\(2\)\s*\{[^}]*\}/s.exec(css);
  assert.ok(stack1 && stack2, '缺少扇形叠卡 nth-child 规则');
  assert.match(stack1[0], /z-index:\s*3/);
  assert.match(stack2[0], /z-index:\s*2/);
  const h1 = /height:\s*(\d+)px/.exec(stack1[0]);
  const h2 = /height:\s*(\d+)px/.exec(stack2[0]);
  assert.ok(h1 && h2 && Number(h1[1]) > Number(h2[1]), '首卡须高于第二卡（阶梯下降）');
  // 文案区物理分离：封面下方独立区，不压图 → 标题不再需要 text-shadow
  const copyRule = /\.home-video-collections-copy\s*\{[^}]*\}/s.exec(css);
  assert.ok(copyRule, '缺少 .home-video-collections-copy 规则');
  assert.match(copyRule[0], /padding/);
  const strongRule = /\.home-video-collections-copy strong\s*\{[^}]*\}/s.exec(css);
  assert.ok(strongRule, '缺少标题规则');
  assert.equal(/text-shadow/.test(strongRule[0]), false, '文案不压图，标题不需要 text-shadow');
  assert.match(overlayScript, /<img/);
  assert.equal(/getContext|drawImage|createElement\(\s*['"]canvas/i.test(overlayScript), false, '封面底不得走 canvas 方案');
});

test('封面快照：getItems 成功后写 localStorage，渲染先读快照即时回填', () => {
  const SNAPSHOT_KEY = 'stellaflix-collection-cover-snapshot-v1';
  assert.ok(overlayScript.includes(SNAPSHOT_KEY), '须定义快照 localStorage 键');
  assert.match(overlayScript, /JSON\.stringify/);
  assert.match(overlayScript, /JSON\.parse/);
  // 打开时按当前 tab 逐卡拉 getItems 补封面/计数
  assert.match(overlayScript, /collections\.getItems\s*\(/);
  // 浮层自身零底层网络：不得触碰 fetch / XHR / posterCache；SFV.tmdb 只许用纯字典函数
  // （genreNames/regionLabel 无网络；取数仍只经 collections.getItems —— 二级页 2026-09-19 起放开）
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'posterCache']) {
    assert.equal(overlayScript.includes(forbidden), false, `浮层不得直接发起网络/缓存读取：${forbidden}`);
  }
  assert.equal(
    /tmdb\.(popular|discover|trending|search|getDetails|getCollection|upcoming)/.test(overlayScript),
    false, '浮层不得直调 TMDB 网络方法',
  );
  // getItems 失败（无 Key 的 TMDB_KEY_REQUIRED 等）→ warm 渐变兜底，不得冒泡
  assert.match(overlayScript, /catch/);
  assert.match(overlayScript, /warm/);
});

test('点卡进弹窗内二级页（不再跳浏览层）；浏览层 openCollectionItems 保留且自带初始化', () => {
  const openById = namedFunctionSource(overlayScript, 'openCollectionById');
  assert.ok(openById, 'expected openCollectionById()');
  // 2026-09-19 用户裁定：先改弹窗二级页——卡点击进弹窗内明细，不再跳浏览层
  assert.equal(openById.includes('openCollectionItems'), false, '卡点击不得再调 openCollectionItems');
  assert.match(openById, /openCollectionDetail\s*\(/);
  // 浏览层能力保留（后续或他处入口）：openCollectionItems 仍须先 ensureOverlayShown 再 pushView
  const items = namedFunctionSource(onlineCollectionsScript, 'openCollectionItems');
  assert.ok(items, 'expected openCollectionItems()');
  assert.match(items, /ensureOverlayShown\s*\(\s*\)/);
  assert.ok(
    items.indexOf('ensureOverlayShown(') < items.indexOf('pushView('),
    '须先 ensureOverlayShown 初始化浏览层，再 pushView 进入单片单',
  );
});

test('浮层关闭走既有 modal 范式（Esc/点遮罩/焦点归还）', () => {
  assert.match(overlayScript, /function\s+closeHomeVideoCollectionsOverlay\s*\(/);
  assert.match(overlayScript, /Escape/);
  assert.match(overlayScript, /event\.target\s*===\s*mask/);
  assert.match(overlayScript, /previousFocus/);
});
