/*
 * 验证脚本：删除 display:flex !important 后，"音乐空间"卡(第5张)内部子元素应纵向堆叠。
 * 关键事实：
 *  - 修复前：nth-child(5) 有 display:flex !important → label/title/sub 横向排成一行（用户报的 bug）
 *  - 修复后：仅保留 visibility/opacity，display 回到 .home-card 默认（label/title/sub 块级纵向）
 *  - .home-card-art 是 position:absolute，不参与纵向流，固定在右下角
 */
const { JSDOM } = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/jsdom');
const fs = require('fs');
const path = require('path');

const PROJECT = 'C:/Users/Administrator/Desktop/Stellaflix-2.1.0';
const CSS_PATH = path.join(PROJECT, 'public/css/index.css');

const minimalHTML = `
<!DOCTYPE html>
<html><head><style>
:root { --home-accent: #00f5d4; }
${fs.readFileSync(CSS_PATH, 'utf8')}
</style></head>
<body class="video-space-active">
<div id="empty-home">
  <div class="home-grid home-quick-grid">
    <article class="home-card home-card-featured" data-home-tone="search">
      <div class="home-card-label">CONTINUE</div><div class="home-card-title">浆果</div><div class="home-card-sub">TINY7</div><div class="home-card-art"></div>
    </article>
    <article class="home-card home-card-quick" data-home-tone="library">
      <div class="home-card-label">LIBRARY</div><div class="home-card-title">音乐库</div><div class="home-card-sub">sub</div><div class="home-card-art"></div>
    </article>
    <article class="home-card home-card-quick" data-home-tone="mix">
      <div class="home-card-label">DAILY MIX</div><div class="home-card-title">每日推荐</div><div class="home-card-sub">sub</div><div class="home-card-art"></div>
    </article>
    <article class="home-card home-card-quick" data-home-tone="playlist">
      <div class="home-card-label">RECENT</div><div class="home-card-title">最近播放</div><div class="home-card-sub">sub</div><div class="home-card-art"></div>
    </article>
    <article class="home-card home-card-quick" data-home-tone="local" id="music-space-card">
      <div class="home-card-label">MUSIC</div><div class="home-card-title">音乐空间</div><div class="home-card-sub">返回音乐空间 · 听歌</div><div class="home-card-art"></div>
    </article>
  </div>
</div>
</body></html>`;

const dom = new JSDOM(minimalHTML, { pretendToBeVisual: true });
const doc = dom.window.document;
const card = doc.getElementById('music-space-card');
const cs = doc.defaultView.getComputedStyle(card);
const label = card.querySelector('.home-card-label');
const title = card.querySelector('.home-card-title');
const sub = card.querySelector('.home-card-sub');
const art = card.querySelector('.home-card-art');

const cardDisplay = cs.display;
const cardVis = cs.visibility;
const cardOpacity = cs.opacity;
const labelDisplay = doc.defaultView.getComputedStyle(label).display;
const titleDisplay = doc.defaultView.getComputedStyle(title).display;
const subDisplay = doc.defaultView.getComputedStyle(sub).display;
const artPosition = doc.defaultView.getComputedStyle(art).position;

console.log('===== 第5张卡「音乐空间」布局验证 =====');
console.log('  .home-card display      =', cardDisplay, '  (期望: 非 flex，应为 block/inline-block/flex以外)');
console.log('  .home-card visibility   =', cardVis, '  (期望: visible)');
console.log('  .home-card opacity      =', cardOpacity, '  (期望: 1)');
console.log('  label display           =', labelDisplay, '  (期望: block → 纵向堆叠)');
console.log('  title display           =', titleDisplay, '  (期望: block)');
console.log('  sub display             =', subDisplay, '  (期望: block 或 -webkit-box → 纵向块级盒)');
console.log('  art position            =', artPosition, '  (期望: absolute → 固定在右下角)');

const isFlex = cardDisplay === 'flex';
const subOk = subDisplay === 'block' || subDisplay === '-webkit-box';
const ok =
  !isFlex &&
  cardVis === 'visible' &&
  cardOpacity === '1' &&
  labelDisplay === 'block' &&
  titleDisplay === 'block' &&
  subOk &&
  artPosition === 'absolute';

console.log('\n  >>>', ok ? '✅ 修复生效：第5张卡子元素纵向堆叠，art 绝对定位，可见性保留' : '❌ 仍有问题');
process.exit(ok ? 0 : 1);
