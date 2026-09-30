'use strict';

/**
 * 世界页 M3 — 交互补齐
 * 运行：node --test tests/world-ui-m3.test.js
 *
 * 覆盖：加载链 / 品牌叠层 / 信标卡片 / 统计面板 / toast / 快捷键 / 收藏 / 烟花 / 接线
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('index.html：M3 换代后启动链 —— 旧渲染项摘除，world-social/world-ui 在 page-world 之前', () => {
  const html = read('public/index.html');
  const iSocial = html.indexOf('"video/world-social.js"');
  const iUi = html.indexOf('"video/world-ui.js"');
  const iPw = html.indexOf('"video/page-world.js"');
  assert.ok(iSocial >= 0 && iUi >= 0, 'world-social.js / world-ui.js 都应在 SFV_SCRIPTS 中');
  assert.ok(iSocial < iUi, 'world-social.js 应先于 world-ui.js（消费方关系）');
  assert.ok(iUi < iPw, 'world-ui.js 应先于 page-world.js');
  assert.strictEqual((html.match(/video\/world-ui\.js/g) || []).length, 1);
  // Task 9 换代：旧 Cesium 时代渲染面已归档（_archive/），启动链不得再引用
  assert.ok(!/video\/world-actions\.js"/.test(html), 'world-actions.js 应已摘除（归档 _archive/）');
  assert.ok(!/video\/world-lighthouse\.js"/.test(html), 'world-lighthouse.js 应已摘除（归档 _archive/）');
  assert.ok(!/video\/world-cesium\.js/.test(html), 'world-cesium.js 应已摘除（归档 _archive/）');
});

test('world-ui.js 提供品牌叠层 / ON AIR / 统计 / toast / 加载 / 烟花画布（卡片面已退役）', () => {
  const src = read('public/video/world-ui.js');
  // Task 9 口号改版（用户裁决：听→看）：新口号必须在；旧英文标题/旧副标题仍禁
  assert.match(src, /看看世界都在看什么/, '新口号必须挂出');
  assert.ok(!/SEE THERE/.test(src), '不得再出现 SEE THERE 标题');
  assert.ok(!/看看世界都在听什么/.test(src), '旧「听什么」副标题不得回潮');
  assert.ok(!/world-earth-title/.test(src), '不得再挂标题容器');
  // ON AIR 保留（可点按钮）
  assert.match(src, /world-on-air/);
  assert.match(src, /world-on-air-dot/);
  // 统计面板（Task 9 文案：N 个放映厅 · N 正在放映）
  assert.match(src, /world-stats/);
  assert.match(src, /个放映厅/);
  assert.match(src, /正在放映/);
  assert.match(src, /setStats/);
  // toast
  assert.match(src, /world-toast/);
  assert.match(src, /function toast\(/);
  // ④-4 换代：旧 world-card 面整条退役（用户裁决「删」），开卡由 world-ht-panel 接管
  assert.ok(!/world-card/.test(src), 'world-ui 不再挂旧卡片面');
  assert.ok(!/function showCard/.test(src), 'showCard 已退役（卡片归 ht-panel）');
  assert.ok(!/function hideCard/.test(src), 'hideCard 已退役');
  // 加载态
  assert.match(src, /world-loading/);
  assert.match(src, /showLoading/);
  // 烟花画布
  assert.match(src, /world-fireworks/);
  // 导出
  for (const fn of ['mount', 'unmount', 'toast', 'setStats', 'setOnAir', 'showLoading', 'hideLoading', 'fireworksCanvas']) {
    assert.ok(new RegExp('\\b' + fn + '\\b').test(src), `应导出 ${fn}`);
  }
});

test('world-actions.js（已归档 _archive/）保留旧 Cesium 面回归：快捷键 / 收藏 / 烟花 / 定位 / 重置 / 自转', () => {
  const src = read('public/video/_archive/world-actions.js');
  // 快捷键：Esc / R / F / A（**不用空格**，那是 App 的播放/暂停）
  assert.match(src, /'Escape'/);
  assert.match(src, /'r' \|\| k === 'R'/);
  assert.match(src, /'f' \|\| k === 'F'/);
  assert.match(src, /'a' \|\| k === 'A'/);
  assert.ok(!/k === ' '/.test(src), '不得劫持空格（那是 App 的播放/暂停键）');
  // 必须吃掉事件，否则 App 的全局热键会同时触发
  assert.match(src, /stopImmediatePropagation/);
  assert.match(src, /function consume\(/);
  // 收藏持久化
  assert.match(src, /stellaflix-world-favorites/);
  assert.match(src, /localStorage/);
  assert.match(src, /isFavorite/);
  assert.match(src, /toggleFavorite/);
  // 烟花（对齐 hearthere：60~100 粒子、球面分布、重力、摩擦、加色）
  assert.match(src, /celebrate/);
  assert.match(src, /60 \+ Math\.floor\(Math\.random\(\) \* 40\)/);
  assert.match(src, /globalCompositeOperation = 'lighter'/);
  assert.match(src, /vy \+= 0\.045/);
  assert.match(src, /vx \*= 0\.985/);
  // 定位
  assert.match(src, /geolocation/);
  assert.match(src, /locateNearest/);
  // 重置视角（不得用 lookAtTransform(IDENTITY)——会干扰相机输入状态）
  assert.match(src, /resetView/);
  assert.ok(!/\.lookAtTransform\(/.test(src), '不得调 camera.lookAtTransform：世界页不走 lookAt 锁定');
  assert.match(src, /enableInputs = true/);
  // 自转必须真的跑起来（有 rAF 循环 + 绕地心公转）
  assert.match(src, /startRotateLoop/);
  assert.match(src, /Matrix3\.fromRotationZ/);
  assert.match(src, /Matrix3\.multiplyByVector/);
  // 输入框内不抢快捷键
  assert.match(src, /isTyping/);
  // 导出
  for (const fn of ['mount', 'unmount', 'isFavorite', 'toggleFavorite', 'celebrate', 'locateNearest', 'resetView', 'flyTo', 'setAutoRotate']) {
    assert.ok(new RegExp('\\b' + fn + '\\b').test(src), `应导出 ${fn}`);
  }
});

test('lighthouse.css 含 M3 视觉（统计/hints/toast/加载/烟花），旧卡片样式已归档', () => {
  const css = read('public/video/lighthouse/lighthouse.css');
  for (const cls of [
    'world-stats', 'world-hints', 'world-toast', 'world-fireworks',
    'world-loading', 'world-on-air'
  ]) {
    assert.ok(css.includes('.' + cls), `CSS 应含 .${cls}`);
  }
  // ④-4：.world-card* 已整块归档 _archive/world-card.pre-hearthere-20260927.css
  assert.ok(!/world-card/.test(css), 'lighthouse.css 不得再有旧卡片样式');
  // 毛玻璃质感（hearthere 的关键词）
  assert.match(css, /backdrop-filter/);
  assert.match(css, /world-pulse/);
});

test('page-world.js 把 onBeaconClick 接到 ht-panel 卡片，并在 unmount 时清理 M3', () => {
  const src = read('public/video/page-world.js');
  assert.match(src, /onBeaconClick/);
  // ④-4 换代：开卡面从 worldUi.showCard 迁到 SFV.worldHtPanel.open/close
  assert.match(src, /worldHtPanel\.open/);
  assert.match(src, /worldHtPanel\.close/);
  assert.ok(!/showCard/.test(src), '旧 showCard 接线已退役');
  // Task 6 反转（行为层换代）：收藏/挂载面从 Cesium 时代 worldActions 迁到
  // maplibre 版 worldMapActions（worldActions.* 四条 → worldMapActions.* 四条）。
  assert.match(src, /worldMapActions\.isFavorite/);
  assert.match(src, /worldMapActions\.toggleFavorite/);
  assert.match(src, /worldMapActions\.mount/);
  assert.match(src, /worldUi\.unmount/);
  assert.match(src, /worldMapActions\.unmount/);
  // 欢迎 toast + 统计（房间语义）
  assert.match(src, /发现 .* 个放映房间/);
  assert.match(src, /setStats/);
  // CTA 主按钮走本地房间语义（tune_in → joinWatchRoom），不是电台收听
  assert.match(src, /'tune_in'/);
  assert.match(src, /joinWatchRoom/);
  assert.ok(!/onListen/.test(src), '不得再有 onListen（电台已移除）');
  assert.ok(!/worldRadio/.test(src), '不得再引用 worldRadio（已移除）');
  assert.match(src, /fetchRooms/);
});

test('world-lighthouse.js 的点击回调会带上信标数据', () => {
  const src = read('public/video/_archive/world-lighthouse.js');
  assert.match(src, /onBeaconClick/);
  assert.match(src, /opts\.onBeaconClick\(st, movement\.position\)/);
});

test('ON AIR 是可点击按钮，并接了处理函数', () => {
  const ui = read('public/video/world-ui.js');
  assert.match(ui, /el\('button', 'world-on-air'\)/);
  assert.match(ui, /pointerEvents = 'auto'/);
  assert.ok(ui.includes('setOnAirHandler'), '应导出 setOnAirHandler');
  assert.match(ui, /onAirEl\.addEventListener\('click'/);

  const pw = read('public/video/page-world.js');
  assert.match(pw, /setOnAirHandler/);
  assert.match(pw, /onAirCursor/);
});

test('右下快捷键条是可点击按钮（含自转），不只是键盘提示', () => {
  const ui = read('public/video/world-ui.js');
  assert.match(ui, /world-hint-btn/);
  // 四项动作标识（数组里声明，setAttribute 统一绑定）
  for (const act of ["'reset'", "'favorite'", "'rotate'", "'esc'"]) {
    assert.ok(ui.includes(act), `应有动作 ${act}`);
  }
  assert.match(ui, /setAttribute\('data-act'/);
  assert.ok(ui.includes('setHintHandler'), '应导出 setHintHandler');
  assert.ok(ui.includes('setRotateState'), '应导出 setRotateState');

  const pw = read('public/video/page-world.js');
  assert.match(pw, /setHintHandler/);
  assert.match(pw, /setRotateState/);
  assert.match(pw, /act === 'rotate'/);

  const css = read('public/video/lighthouse/lighthouse.css');
  assert.match(css, /\.world-hint-btn/);
  assert.match(css, /\.world-hint-btn\.is-on/);
});

test('M3 模块语法合法', () => {
  const { execFileSync } = require('node:child_process');
  for (const f of ['public/video/world-ui.js', 'public/video/_archive/world-actions.js']) {
    const r = execFileSync(process.execPath, ['--check', path.join(root, f)], {
      encoding: 'utf8', stdio: 'pipe'
    });
    assert.ok(r === '' || r == null, `${f} 语法应通过`);
  }
});
