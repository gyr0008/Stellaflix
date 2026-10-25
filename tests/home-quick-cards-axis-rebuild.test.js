'use strict';
/**
 * tests/home-quick-cards-axis-rebuild.test.js —— Task 7 F1：数量不一致「重建」后 data-mlib-axis 必须仍在
 *
 * 与 tests/home-quick-cards-library-entries.test.js 成对：
 *   · library-entries 那份锁 **静态** index.html 的三卡属性（首屏 HTML 由它拥有）；
 *   · 本文件锁 **运行时** 03a-home-dashboard.js 的 cards 表（重建 HTML 由它拥有）。
 *   只看静态markup 会给假绿：03a 的 count-parity 分支在首屏就会 innerHTML 重建整张网格
 *   （静态 6 卡含 IMPORT vs 运行时 5 卡无 IMPORT → 6≠5 是常态），
 *   而 homeDashboardCardHtml 不发 data-mlib-axis → 重建后 `closest('[data-mlib-axis]')` 永不命中，
 *   09-mlib-bindings.js 的委托点击整条死掉（三卡点了没反应）。
 * 本文件只测「属性跟着卡表活下来」这一件事；6-vs-5 的数量错配本身归批A，不在本任务修。
 *
 * 夹具说明（假 DOM 的两条已知取舍，见 helpers/mlib-fake-dom.js 头注释）：
 *   · innerHTML setter 不解析 → 重建后 children 清空，产物只能断言 **HTML 字符串**（真浏览器正是解析这段字符串）；
 *   · 03a 用的是 `document.querySelector('#empty-home .home-grid')` 后代选择器，假 DOM 只支持单段复合选择器，
 *     故本文件自带一个 **仅测试内** 的多段（后代）选择器适配器，不去动共享 harness。
 * 运行：node --test tests/home-quick-cards-axis-rebuild.test.js
 */

const test = require('node:test');
const assert = require('node:assert');            // 宽松断言：vm 跨 realm 下 deepStrictEqual 会误报（仓内约定）
const fs = require('node:fs');
const path = require('node:path');
const { createFakeDom, matches } = require('./helpers/mlib-fake-dom');

const DASH_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '03a-home-dashboard.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// index.html:210-249 的静态 6 卡（CONTINUE / PLAYLISTS / IMPORT / ALBUMS / ARTISTS / Video），
// 三张资料库入口卡携带 data-mlib-axis；其余卡不带。顺序即 DOM 顺序。
const STATIC_CARDS = [
  { tone: 'search', axis: null, label: 'CONTINUE', cls: 'home-card home-card-featured', onclick: 'resumeHomeDashboardPlayback()' },
  { tone: 'library', axis: 'playlists', label: 'PLAYLISTS', cls: 'home-card home-card-quick', onclick: null },
  { tone: 'mix', axis: null, label: 'IMPORT', cls: 'home-card home-card-quick', onclick: 'openPlatformPlaylistImport()' },
  { tone: 'mix', axis: 'albums', label: 'ALBUMS', cls: 'home-card home-card-quick', onclick: null },
  { tone: 'playlist', axis: 'artists', label: 'ARTISTS', cls: 'home-card home-card-quick', onclick: null },
  { tone: 'local', axis: null, label: 'Video', cls: 'home-card home-card-quick', onclick: 'x' },
];

function staticCardSpec(def) {
  const attrs = { type: 'button' };
  if (def.axis) attrs['data-mlib-axis'] = def.axis;   // 与 index.html:218/231/237 一致
  if (def.onclick) attrs.onclick = def.onclick;
  return {
    tag: 'button', class: def.cls, attrs,
    children: [
      { tag: 'div', class: 'home-card-label', text: def.label },
      { tag: 'div', class: 'home-card-title', text: def.label + ' 标题' },
      { tag: 'div', class: 'home-card-sub', text: '副文案' },
      { tag: 'div', class: 'home-card-art' },
    ],
  };
}

// 假 DOM 只认单段复合选择器；03a 传的是 '#empty-home .home-grid' 这种后代式串。
// 逐段下钻（首段允许自身命中，其余段按后代命中）——只在测试文件内扩展，不改共享 harness。
function upgradeDescendantQuery(doc) {
  const html = doc.documentElement;
  const single = (scope, sel) => (matches(scope, sel) ? scope : scope.querySelector(sel));
  doc.querySelector = function (sel) {
    const parts = String(sel || '').trim().split(/\s+/);
    let scope = html;
    for (let i = 0; i < parts.length && scope; i++) {
      if (i === 0) { scope = single(scope, parts[0]); continue; }
      scope = scope.querySelector(parts[i]);
    }
    return scope || null;
  };
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// boot：挂静态 6 卡（复现真实首屏）→ 载入 03a（顶层函数声明全部就位；03a 文件末尾的顶层
// renderHomeDashboard() 就是首屏那次渲染，真实浏览器同样是这么走到重建分支的）。
function boot() {
  const fake = createFakeDom({
    hover: true,
    mount: [{
      tag: 'div', id: 'empty-home', children: [{
        tag: 'div', class: 'home-grid',
        children: STATIC_CARDS.map(staticCardSpec),
      }],
    }],
  });
  upgradeDescendantQuery(fake.doc);
  fake.grid = fake.doc.querySelector('#empty-home .home-grid');
  fake.before = {
    cards: fake.grid.children.length,          // 载入前＝静态 6 卡（与 index.html 同数）
    axes: fake.grid.children.map((n) => n.getAttribute('data-mlib-axis')),
  };
  Object.assign(fake.win, {
    // 真 escHtml（00-api-quality-output.js）借 document 转义，假 DOM 的 innerHTML 不解析 → 这里同表自带一份
    escHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]),
    cssImageUrl: (u) => String(u || ''),
    Image: function () {
      return { decoding: '', set src(_v) { }, decode: () => Promise.resolve() };
    },
    localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    // 03a 顶层 renderHomeDashboard() 会读到这些兄弟模块的全局：给最小值，别让加载期抛错掩盖被测行为
    playQueue: [], playlist: [], userPlaylists: [], homeDiscoverState: null,
    emptyHomeActive: false, currentIdx: -1, playing: false, audio: null,
    loginStatus: null, qishuiLoginStatus: null, kugouLoginStatus: null, spotifyLoginStatus: null,
  });
  fake.win.loadScript(DASH_SRC, '03a-home-dashboard.js');
  fake.grid = fake.doc.querySelector('#empty-home .home-grid');
  fake.render = () => fake.win.renderHomeDashboardQuickCards();
  fake.tagAxis = (tag) => {
    const m = /data-mlib-axis="([^"]*)"/.exec(tag);
    return m ? m[1] : null;
  };
  return fake;
}

// 把重建产物按 <button 切段，返回 [{ label, axis }]（真浏览器就是把这段字符串解析成这些卡）。
function emittedCards(html) {
  return String(html).split('<button').slice(1).map((chunk) => {
    const open = chunk.split('>')[0];
    const label = (/class="home-card-label">([^<]*)</.exec(chunk) || [, ''])[1];
    return { label, axis: /data-mlib-axis="([^"]*)"/.test(open) ? /data-mlib-axis="([^"]*)"/.exec(open)[1] : null };
  });
}

/* ---------------------------------------------------- ① 重建后属性仍在（真实首屏条件） */

test('首屏数量错配必然重建网格：03a 的 innerHTML 重建分支是常态路径（不是边缘）', () => {
  const f = boot();
  assert.equal(f.before.cards, STATIC_CARDS.length, '夹具＝静态 6 卡（与 index.html 同数）');
  assert.equal(f.before.axes.filter(Boolean).length, 3, '载入前三卡带 data-mlib-axis（静态 markup 那一半归成对测试锁）');
  // 03a 文件末尾的顶层 renderHomeDashboard() 就是首屏那次渲染：children(6) !== cards(5) → 必走重建分支。
  // 本断言同时给后面几条测试兜底：若哪天数量对上、走了 patch 路径，这里会先红，避免「重建契约」被假绿掩盖。
  assert.notEqual(f.grid.innerHTML, '', '首屏即走 innerHTML 重建（6≠5 是常态）：旧卡连同属性一起被替换');
  assert.equal(f.grid.children.length, 0, '假 DOM 不解析 innerHTML：重建产物只存在于字符串里（真浏览器正是解析这段字符串）');
});

test('重建后的三张资料库卡仍携带 data-mlib-axis；不带轴的卡不带该属性', () => {
  const f = boot();
  f.render();
  const cards = emittedCards(f.grid.innerHTML);
  assert.equal(cards.length, 5, '运行时卡表 5 张（CONTINUE/PLAYLISTS/ALBUMS/ARTISTS/Video）');
  const axisByLabel = {};
  cards.forEach((c) => { axisByLabel[c.label] = c.axis; });
  assert.equal(axisByLabel.PLAYLISTS, 'playlists', '重建后歌单卡必须仍带 data-mlib-axis="playlists"');
  assert.equal(axisByLabel.ALBUMS, 'albums', '重建后专辑卡必须仍带 data-mlib-axis="albums"');
  assert.equal(axisByLabel.ARTISTS, 'artists', '重建后艺人卡必须仍带 data-mlib-axis="artists"');
  // 入口面＝三卡：CONTINUE / Video 不得混挂（挂上就是第二个映射源）
  assert.equal(axisByLabel.CONTINUE, null, 'CONTINUE 卡不得携带 data-mlib-axis');
  assert.equal(axisByLabel.Video, null, 'Video 卡不得携带 data-mlib-axis');
  assert.equal((f.grid.innerHTML.match(/data-mlib-axis=/g) || []).length, 3, '整张重建产物里 data-mlib-axis 恰三枚');
});

test('运行时卡表与静态 markup 的轴集合完全一致（唯一映射源不得漂移）', () => {
  const f = boot();
  f.render();
  const runtime = emittedCards(f.grid.innerHTML).map((c) => c.axis).filter(Boolean).sort();
  const gridSeg = INDEX_HTML.slice(INDEX_HTML.indexOf('home-quick-grid'),
    INDEX_HTML.indexOf('<div class="home-rail home-insight-rail">'));
  const statics = [...gridSeg.matchAll(/data-mlib-axis="([^"]*)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(runtime, statics, '03a cards 表发出的轴集合必须与 index.html 静态三卡逐一对应');
  assert.equal(statics.length, 3, '静态入口卡恰三张');
});

/* ---------------------------------------------------- ② homeDashboardCardHtml 直调 */

test('homeDashboardCardHtml：有轴才发轴属性，无轴保持干净属性面，值走转义', () => {
  const f = boot();
  const html = f.win.homeDashboardCardHtml({
    label: 'ALBUMS', title: '专辑', sub: '资料库 · 建设中', cover: '',
    action: '', tone: 'mix', className: 'home-card-quick', axis: 'albums',
  });
  assert.match(html, /<button class="home-card home-card-quick" data-home-tone="mix" data-mlib-axis="albums"/,
    '轴属性紧跟 data-home-tone，且只在该卡有轴时出现');
  const plain = f.win.homeDashboardCardHtml({
    label: 'Video', title: '影视空间', sub: '', cover: '', action: '', tone: 'local', className: 'home-card-quick',
  });
  assert.equal(plain.includes('data-mlib-axis'), false, '无轴卡（含未来新卡）不得出现该属性');
  assert.equal(plain.includes('data-mlib-axis=""'), false, '不得发空值属性');
  const hostile = f.win.homeDashboardCardHtml({
    label: 'X', title: 'x', sub: '', cover: '', action: '', tone: 'mix', className: '', axis: 'a"><img src=x>',
  });
  assert.equal(hostile.includes('"><img'), false, '轴值必须与其它属性一样转义（不得裸拼进 HTML）');
  assert.match(hostile, /data-mlib-axis="a&quot;&gt;&lt;img src=x&gt;"/, '转义后的轴值原样可见');
});

/* ---------------------------------------------------- ③ homeDashboardPatchCard 同步该属性 */

test('homeDashboardPatchCard：patch 到有轴的卡＝置属性；patch 到无轴的卡＝摘掉残留属性', () => {
  const f = boot();
  const doc = f.doc;
  const mk = (attrs) => {
    const btn = doc.createElement('button');
    btn.className = 'home-card home-card-quick';
    btn.setAttribute('type', 'button');
    ['home-card-label', 'home-card-title', 'home-card-sub', 'home-card-art'].forEach((c) => {
      const d = doc.createElement('div');
      d.className = c;
      btn.appendChild(d);
    });
    Object.keys(attrs || {}).forEach((k) => btn.setAttribute(k, attrs[k]));
    return btn;
  };
  const base = { label: 'ALBUMS', title: '专辑', sub: '资料库', cover: 'https://cdn/a.png', tone: 'mix', className: 'home-card-quick' };

  const fresh = mk({ 'data-home-tone': 'mix' });
  f.win.homeDashboardPatchCard(fresh, Object.assign({ axis: 'albums' }, base));
  assert.equal(fresh.getAttribute('data-mlib-axis'), 'albums', '有轴的 patch 必须把轴写进属性（第二处映射源＝卡表本身）');

  const stale = mk({ 'data-home-tone': 'mix', 'data-mlib-axis': 'albums' });
  f.win.homeDashboardPatchCard(stale, base); // 同一张位置换成无轴卡（未来卡序调整）
  assert.equal(stale.getAttribute('data-mlib-axis'), null,
    '无轴卡必须摘掉残留的 data-mlib-axis：残留＝第二个映射源，brief 明令禁止');

  const moved = mk({ 'data-home-tone': 'mix', 'data-mlib-axis': 'albums' });
  f.win.homeDashboardPatchCard(moved, Object.assign({ axis: 'artists' }, base));
  assert.equal(moved.getAttribute('data-mlib-axis'), 'artists', '换轴时属性随之改写，不叠成两枚');
});
