/*
 * 验证脚本 (方案A 后)：影视态保留 data-home-tone，应与音乐态同位置 tone-a / label color 一致。
 * 关键事实：
 *  - 音乐态：5 张卡带 data-home-tone = search/library/mix/playlist/local
 *  - 影视态 (方案A)：home.js 不再 removeAttribute，保留模板写死的 data-home-tone
 *  - 因此两态 DOM 属性完全相同 → tone-a 计算值应完全相同 → label color 完全相同
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
<body>
<div id="empty-home">
  <div class="home-grid home-quick-grid">
    <article class="home-card home-card-featured" data-home-tone="search">
      <div class="home-card-label">CONTINUE</div>
      <div class="home-card-art"></div>
    </article>
    <article class="home-card home-card-quick" data-home-tone="library">
      <div class="home-card-label">LIBRARY</div>
      <div class="home-card-art"></div>
    </article>
    <article class="home-card home-card-quick" data-home-tone="mix">
      <div class="home-card-label">DAILY MIX</div>
      <div class="home-card-art"></div>
    </article>
    <article class="home-card home-card-quick" data-home-tone="playlist">
      <div class="home-card-label">RECENT</div>
      <div class="home-card-art"></div>
    </article>
    <article class="home-card home-card-quick" data-home-tone="local">
      <div class="home-card-label">VIDEO</div>
      <div class="home-card-art"></div>
    </article>
  </div>
</div>
</body></html>`;

function dump(label, doc) {
  console.log('\n===== ' + label + ' =====');
  const cards = Array.from(doc.querySelectorAll('.home-card'));
  let allSame = true;
  cards.forEach((card, i) => {
    const toneA = doc.defaultView.getComputedStyle(card).getPropertyValue('--tone-a').trim();
    const lbl = card.querySelector('.home-card-label');
    const color = doc.defaultView.getComputedStyle(lbl).color;
    const hasToneAttr = card.hasAttribute('data-home-tone');
    const toneVal = card.getAttribute('data-home-tone');
    console.log('  card#' + (i + 1) + '  data-home-tone=' + (hasToneAttr ? toneVal : '(无)') +
      '  --tone-a=' + (toneA || '(空)') +
      '  label.color=' + color);
  });
}

// 态 1: 音乐态（body 无 video-space-active）
let dom1 = new JSDOM(minimalHTML, { pretendToBeVisual: true });
dump('音乐态 (body 无 video-space-active, 保留 data-home-tone)', dom1.window.document);

// 态 2: 影视态（body.video-space-active，但按方案A 保留 data-home-tone，不删）
let dom2 = new JSDOM(minimalHTML.replace('<body>', '<body class="video-space-active">'), { pretendToBeVisual: true });
dump('影视态 (body.video-space-active, 保留 data-home-tone [方案A])', dom2.window.document);

// 态 3: 验证"若误删 data-home-tone" 会怎样（复刻旧 bug，说明 root cause）
let dom3 = new JSDOM(minimalHTML.replace('<body>', '<body class="video-space-active">'), { pretendToBeVisual: true });
dom3.window.document.querySelectorAll('.home-card').forEach(c => c.removeAttribute('data-home-tone'));
dump('对照: 影视态 + 误删 data-home-tone (旧 root cause，应全部回退青色)', dom3.window.document);
