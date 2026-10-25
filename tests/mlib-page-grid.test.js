// tests/mlib-page-grid.test.js —— Task 5：本地音乐资料库三轴网格渲染（vm + 假 DOM）
// 覆盖：payload Map（不进 DOM 属性）/ 文本转义 / 封面与艺人头像三级兜底 / other 分界条 /
//       状态盒（empty·engine-missing·error·轴为空）/ 切轴同步清场 / 迟到响应丢弃 / body 类真相源 /
//       hover 探测 / 卡数组只读（缓存共享引用）。
// 运行：node --test tests/mlib-page-grid.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');            // 宽松断言：vm 跨 realm 下 deepStrictEqual 会误报（仓内约定）
const fs = require('node:fs');
const path = require('node:path');
const { createFakeDom, fire, SHELL } = require('./helpers/mlib-fake-dom');

const DIR = path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf');
const READ_SRC = fs.readFileSync(path.join(DIR, '07-mlib-readlayer.js'), 'utf8');
const PAGE_SRC = fs.readFileSync(path.join(DIR, '08-mlib-page.js'), 'utf8');

// ---- boot：假 DOM + 真读层文件；默认把 getAxisData 换成立即返回的测试数据（页面只见这个契约形状），
//      传 seam 则走「真缝 → 真读层 → 页面」全链（端到端一条）。
// axisData 两种写法都收：单轴结果 { axis, status, cards }（brief 用法），或以轴为键的结果表。
function bootPageWithFakeDom(options) {
  const opts = options || {};
  const fake = createFakeDom({ hover: opts.hover, mount: opts.mount || SHELL });
  const { win, doc } = fake;
  win.loadScript(READ_SRC, '07-mlib-readlayer.js');
  fake.readCalls = [];
  if (opts.seam) {
    win.stellaMlibSeam = opts.seam;
  } else {
    const raw = opts.axisData || {};
    const single = typeof raw.status === 'string';   // 单轴结果 vs 以轴为键的结果表
    win.stellaMlibRead.getAxisData = async function (axis) {
      fake.readCalls.push(axis);
      if (single) return raw;
      if (!Object.prototype.hasOwnProperty.call(raw, axis)) {
        return { axis, cards: [], status: 'error', message: '测试未给该轴数据：' + axis };
      }
      return raw[axis];
    };
  }
  win.loadScript(PAGE_SRC, '08-mlib-page.js');
  fake.read = win.stellaMlibRead;
  fake.card = (id) => doc.querySelector('[data-mlib-id="' + id + '"]');
  fake.cards = () => doc.querySelectorAll('.stella-mlib-album-card');
  fake.grid = () => doc.getElementById('mlib-grid');
  fake.stateBox = () => doc.getElementById('mlib-state-box');
  return fake;
}

const albumCard = (id, title, extra) => Object.assign({
  id, title, sub: '歌手甲', cover: 'https://cdn/a.jpg', count: 3, playable: true,
  sortKey: String(title).toLowerCase(), sortBucket: 'album', meta: { releaseYear: 2021 },
}, extra || {});

const artistCard = (id, title, extra) => Object.assign({
  id, title, sub: '5 首', cover: '', count: 5, playable: true,
  sortKey: String(title).toLowerCase(), sortBucket: 'latin', meta: { avatar: '', sortKeyPinyin: '' },
}, extra || {});

const playlistCard = (id, title, extra) => Object.assign({
  id, title, sub: '', cover: 'https://cdn/p.jpg', count: 8, playable: true,
  sortKey: String(id).toLowerCase(), sortBucket: 'playlist', meta: { addedAt: 10 },
}, extra || {});

const okAlbums = (cards) => ({ axis: 'albums', status: 'ok', cards });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ 卡片渲染 */

test('卡渲染：payload 进 Map 不进 DOM 属性', async () => {
  const cards = [
    { id: 'AL1', title: 'X', sub: 'A', cover: 'c.jpg', count: 2, playable: true, sortBucket: 'album' },
  ];
  const { win, doc, card } = bootPageWithFakeDom({ axisData: { axis: 'albums', status: 'ok', cards } });
  await win.stellaMlibPage.openAxis('albums');
  const el = doc.querySelector('[data-mlib-id="AL1"]');   // DOM 只有 id
  assert.ok(el, '卡片必须已挂进 DOM');
  assert.ok(!el.getAttribute('data-title'), '标题不得进属性');
  assert.equal(win.__mlibGridPayloadForTests.get(el).title, 'X');
  // 属性面锁死：卡根只允许标识＋ARIA/焦点入口，数据字段一律不进属性。
  // R4（第2轮回批，测试面诚实化）：08 buildCard 里是 `node.tabIndex = 0`（属性赋值，不是 setAttribute），
  // 假 DOM 不把属性反射进 attributes（helpers/mlib-fake-dom.js 的已知取舍），所以这里 attributes 看不到 tabindex；
  // **真 DOM 会反射成 tabindex="0"**——即真机上卡根的属性集是 data-mlib-id / class / tabindex 三者并存。
  // 因此白名单必须把 tabindex 也算成合法属性（写成只许 data-mlib-id 会在移植到真 DOM 时误红），
  // 同时把「卡根可聚焦」这件事在本夹具里按 tabIndex 显式验一遍，别让它只活在真机上。
  const cardAttrKeys = Object.keys(el.attributes);
  const ALLOWED_CARD_ATTRS = ['data-mlib-id', 'class', 'tabindex'];
  assert.deepEqual(
    cardAttrKeys.filter((k) => ALLOWED_CARD_ATTRS.indexOf(k) === -1),
    [],
    '卡根属性面只允许 data-mlib-id / class / tabindex（数据字段一律不进 DOM）',
  );
  assert.ok(cardAttrKeys.includes('data-mlib-id'), '卡根必须带 data-mlib-id 标识');
  assert.equal(el.tabIndex, 0, '卡根 tabIndex=0 与上面的属性集并存（真 DOM 里反射成 tabindex="0"）');
  // payload 存的就是读层那张卡本身（同一引用），不是页面复制出来的副本
  assert.equal(win.__mlibGridPayloadForTests.get(el), cards[0]);
  assert.equal(card('AL1'), el, '一张卡只可能有一个 DOM 节点');
});

test('esc 文本注入防御', async () => {
  const evilTitle = '<img src=x onerror=alert(1)>';
  const evilSub = '<b onmouseover="bad()">粗</b>';
  const evilId = '<img src=y id=hook>';
  const { win, doc, card } = bootPageWithFakeDom({ axisData: okAlbums([
    albumCard('AL1', evilTitle, { sub: evilSub }),
    albumCard(evilId, '正常标题', { cover: '' }),   // id 也是攻击面：只进属性，不进 HTML 串
  ]) });
  await win.stellaMlibPage.openAxis('albums');
  const el = card('AL1');
  const meta = el.querySelector('.stella-mlib-album-meta');
  assert.ok(meta, '文案区必须存在');
  assert.ok(meta.innerHTML.indexOf('<img') === -1, '标题里的 <img 不得成为标签');
  assert.ok(meta.innerHTML.indexOf('&lt;img src=x') >= 0, '标题必须按实体转义输出');
  assert.ok(meta.innerHTML.indexOf('<b ') === -1, '副标题里的 <b 不得成为标签');
  assert.ok(meta.innerHTML.indexOf('&lt;b ') >= 0, '副标题必须按实体转义输出');
  assert.ok(card(evilId), '怪 id 照样按属性取回自己那张卡');
  assert.ok(win.__mlibGridPayloadForTests.get(card(evilId)), '怪 id 的卡数据也进了 payload Map');
});

test('无封面卡：stella-mlib-art 无 has-cover 类，用底色占位（不生成蓝盘 SVG）', async () => {
  const { win, card } = bootPageWithFakeDom({ axisData: okAlbums([
    albumCard('AL1', '无封面专辑', { cover: '' }),
  ]) });
  await win.stellaMlibPage.openAxis('albums');
  const art = card('AL1').querySelector('.stella-mlib-art');
  assert.ok(art, '封面容器必须是 .stella-mlib-art');
  assert.equal(art.classList.contains('has-cover'), false, 'has-cover 是首页卡的类，资料库不得借用');
  assert.equal(art.children.length, 1, '无封面＝不生成 img，只剩悬停播放钮');
  assert.equal(art.children[0].tagName, 'BUTTON', '封面容器里除播放钮不得有别的节点（尤其不得画蓝盘）');
  assert.equal(art.querySelector('img'), null, '不得有破图 img');
  assert.equal(art.classList.contains('is-loaded'), true, '占位底色直接进 is-loaded，微光不空转');
});

test('封面加载态：img load → is-loaded；error → 摘掉 img 并露出底色', async () => {
  const { win, card } = bootPageWithFakeDom({ axisData: okAlbums([albumCard('AL1', '有封面')]) });
  await win.stellaMlibPage.openAxis('albums');
  const art = card('AL1').querySelector('.stella-mlib-art');
  const img = art.querySelector('img');
  assert.ok(img, '有封面必须渲染 img');
  assert.equal(img.src, 'https://cdn/a.jpg', '封面走属性赋值，不经 HTML 字符串拼接');
  assert.equal(art.classList.contains('is-loaded'), false, '加载完成前不得提前置 is-loaded');
  fire(img, 'load');
  assert.equal(art.classList.contains('is-loaded'), true, '加载完成才淡入封面');

  const booted = bootPageWithFakeDom({ axisData: okAlbums([albumCard('AL2', '坏封面')]) });
  await booted.win.stellaMlibPage.openAxis('albums');
  const art2 = booted.card('AL2').querySelector('.stella-mlib-art');
  const img2 = art2.querySelector('img');
  fire(img2, 'error');
  assert.equal(art2.querySelector('img'), null, '加载失败要摘掉破图');
  assert.equal(art2.classList.contains('is-loaded'), true, '失败后停掉微光，退回底色占位');
});

test('专辑/歌单卡带悬停播放钮；不可播卡播放钮置灰且 title=unplayableHint()', async () => {
  const { win, card, read } = bootPageWithFakeDom({ axisData: okAlbums([
    albumCard('AL1', '可播'),
    albumCard('AL2', '不可播', { playable: false }),
  ]) });
  await win.stellaMlibPage.openAxis('albums');
  const btn = card('AL1').querySelector('.stella-mlib-play-btn');
  assert.ok(btn, '专辑卡必须有 .stella-mlib-play-btn');
  assert.equal(btn.parentNode.classList.contains('stella-mlib-art'), true, '播放钮定位相对封面容器');
  assert.equal(btn.getAttribute('type'), 'button', '按钮不得有表单语义');
  assert.equal(btn.innerHTML.indexOf('<svg'), 0, '播放三角用内联 SVG（静态图标片段，不含卡数据）');
  assert.equal(btn.disabled, false);
  const muted = card('AL2').querySelector('.stella-mlib-play-btn');
  assert.equal(muted.disabled, true, '整张无可播来源时播放钮置灰');
  assert.equal(muted.getAttribute('title'), read.unplayableHint(), 'title 必须取读层文案表');
});

test('页面模块不得自带「未匹配到可播来源」字面量（文案归读层）', () => {
  assert.equal(PAGE_SRC.indexOf('未匹配到可播来源'), -1);
  assert.equal(PAGE_SRC.indexOf('曲库还是空的'), -1);
  assert.equal(PAGE_SRC.indexOf('这个板块还没有内容'), -1);
});

test('歌单轴同样走三轴共用渲染器（卡类名与封面容器一致，副标题为空时不出 .stella-mlib-album-sub）', async () => {
  const { win, card, cards } = bootPageWithFakeDom({ axisData: {
    axis: 'playlists', status: 'ok',
    cards: [playlistCard('P1', '我的晨跑'), playlistCard('P2', '空歌单', { cover: '' })],
  } });
  await win.stellaMlibPage.openAxis('playlists');
  assert.equal(cards().length, 2);
  const el = card('P1');
  assert.equal(el.classList.contains('stella-mlib-album-card'), true, '三轴共用同一张卡');
  assert.ok(el.querySelector('.stella-mlib-art'), '歌单封面容器同 .stella-mlib-art');
  assert.ok(el.querySelector('.stella-mlib-play-btn'), '歌单卡也有播放钮');
  const meta = el.querySelector('.stella-mlib-album-meta');
  assert.ok(meta.innerHTML.indexOf('stella-mlib-album-name') > 0, '标题行必须有');
  assert.ok(meta.innerHTML.indexOf('我的晨跑') > 0, '标题文本上屏');
  assert.equal(meta.innerHTML.indexOf('stella-mlib-album-sub'), -1, 'sub 为空串就不该出这一行');
});

/* ------------------------------------------------------------ 艺人轴 */

test('艺人头像兜底：avatar 图→首字母 span（class 含 stella-mlib-artist-art）', async () => {
  const { win, card } = bootPageWithFakeDom({ axisData: {
    axis: 'artists', status: 'ok', cards: [
      artistCard('AR1', 'Adele', { meta: { avatar: 'https://cdn/avatar.jpg' } }),
      artistCard('AR2', '张三'),
    ],
  } });
  await win.stellaMlibPage.openAxis('artists');
  const art = card('AR1').querySelector('.stella-mlib-artist-art');
  assert.ok(art, '头像容器必须是 .stella-mlib-artist-art（圆形）');
  assert.equal(art.classList.contains('stella-mlib-art'), false, '不得同时挂方形封面类');
  const initial = art.querySelector('.stella-mlib-artist-initial');
  const img = art.querySelector('.stella-mlib-artist-img');
  assert.ok(initial, '图加载前必须已有首字母占位');
  assert.ok(img, 'meta.avatar 有值时渲染代表图');
  assert.equal(img.tagName, 'IMG');
  assert.equal(initial.textContent, 'A');
  fire(img, 'load');
  assert.equal(art.classList.contains('has-image'), true, '代表图加载成功才置 has-image');

  const noAvatar = card('AR2').querySelector('.stella-mlib-artist-art');
  assert.equal(noAvatar.querySelector('img'), null, '无 meta.avatar 不渲染图，直接首字母');
  assert.equal(noAvatar.querySelector('.stella-mlib-artist-initial').textContent, '张');
});

test('艺人头像第三级兜底：取不到首字母时用音乐图标，绝不留空框', async () => {
  const { win, card } = bootPageWithFakeDom({ axisData: {
    axis: 'artists', status: 'ok', cards: [artistCard('AR1', '！！！')],
  } });
  await win.stellaMlibPage.openAxis('artists');
  const ph = card('AR1').querySelector('.stella-mlib-artist-initial');
  assert.ok(ph.classList.contains('is-icon'), '空首字母必须退回 is-icon 分支');
  assert.ok(ph.innerHTML.indexOf('<svg') >= 0, 'is-icon 分支渲染音乐图标（静态 SVG 片段）');
  assert.equal(ph.textContent, '', '图标分支不放文字');
});

test('头像代表图加载失败：摘掉 img 后首字母占位仍在（三级兜底链不断链）', async () => {
  const { win, card } = bootPageWithFakeDom({ axisData: {
    axis: 'artists', status: 'ok', cards: [artistCard('AR1', 'The Weeknd', { meta: { avatar: 'https://cdn/x.jpg' } })],
  } });
  await win.stellaMlibPage.openAxis('artists');
  const art = card('AR1').querySelector('.stella-mlib-artist-art');
  fire(art.querySelector('.stella-mlib-artist-img'), 'load');
  assert.equal(art.classList.contains('has-image'), true);
  fire(art.querySelector('.stella-mlib-artist-img'), 'error');
  assert.equal(art.querySelector('.stella-mlib-artist-img'), null, '失败图必须摘掉，不留破图');
  assert.equal(art.classList.contains('has-image'), false, 'img 已没了，has-image 必须撤');
  assert.equal(art.querySelector('.stella-mlib-artist-initial').textContent, 'T', '首字母占位自动露出');
});

test('艺人卡绝不用专辑封面冒充头像，也不带悬停播放钮', async () => {
  const { win, card, cards } = bootPageWithFakeDom({ axisData: {
    axis: 'artists', status: 'ok', cards: [artistCard('AR1', '歌手', { cover: 'https://cdn/album-cover.jpg' })],
  } });
  await win.stellaMlibPage.openAxis('artists');
  const el = card('AR1');
  assert.equal(el.querySelector('img'), null, 'card.cover 不得进艺人头像');
  assert.equal(el.querySelector('.stella-mlib-play-btn'), null, '圆形头像不压播放角标');
  assert.equal(el.classList.contains('stella-mlib-artist-card'), true, '艺人卡另有 .stella-mlib-artist-card');
  assert.equal(cards()[0], el);
});

test('other 组前插分界条跨整行（class stella-mlib-artist-divider）', async () => {
  const { win, card, grid } = bootPageWithFakeDom({ axisData: {
    axis: 'artists', status: 'ok', cards: [
      artistCard('AR_L1', 'Adele'),
      artistCard('AR_C1', '张三', { sortBucket: 'cjk' }),
      artistCard('AR_O1', '100%', { sortBucket: 'other' }),
      artistCard('AR_O2', '#tag', { sortBucket: 'other' }),
    ],
  } });
  await win.stellaMlibPage.openAxis('artists');
  const dividers = grid().querySelectorAll('.stella-mlib-artist-divider');
  assert.equal(dividers.length, 1, '只插一条分界，不每个 other 卡插一次');
  const d = dividers[0];
  assert.equal(d.parentNode, grid(), '分界条必须是网格直接子节点（才能 grid-column:1/-1 跨整行）');
  assert.equal(d.textContent, '其他');
  const kids = grid().children;
  assert.equal(kids.indexOf(d) < kids.indexOf(card('AR_O1')), true, '分界必须插在 other 组之前');
  assert.equal(kids.indexOf(d) > kids.indexOf(card('AR_C1')), true, '不得插到 cjk 之前');
  assert.equal(kids.indexOf(card('AR_O2')) > kids.indexOf(card('AR_O1')), true, '组内顺序照读层，不重排');
});

test('分界条只属于艺人轴：专辑/歌单轴按读层顺序铺平，不插分界', async () => {
  const albums = bootPageWithFakeDom({ axisData: okAlbums([
    albumCard('AL1', '甲'), albumCard('AL2', '乙'),
  ]) });
  await albums.win.stellaMlibPage.openAxis('albums');
  assert.equal(albums.grid().querySelectorAll('.stella-mlib-artist-divider').length, 0);
  assert.equal(albums.grid().children.length, 2, '两张卡，没有别的节点');

  const pl = bootPageWithFakeDom({ axisData: {
    axis: 'playlists', status: 'ok', cards: [playlistCard('P1', '甲'), playlistCard('P2', '乙')],
  } });
  await pl.win.stellaMlibPage.openAxis('playlists');
  assert.equal(pl.grid().querySelectorAll('.stella-mlib-artist-divider').length, 0);
});

test('读层缓存是共享引用：渲染不得就地排序/改写 cards（冻结数组与卡对象）', async () => {
  const cards = [albumCard('AL1', 'B 专辑'), albumCard('AL2', 'A 专辑')];
  cards.forEach(Object.freeze);
  Object.freeze(cards);
  const keysBefore = Object.keys(cards[0]);
  const { win, card, grid } = bootPageWithFakeDom({ axisData: okAlbums(cards) });
  await win.stellaMlibPage.openAxis('albums');
  assert.deepEqual(grid().children.map((el) => el.getAttribute('data-mlib-id')), ['AL1', 'AL2'],
    '顺序照读层，页面不重排');
  assert.equal(card('AL1').classList.contains('stella-mlib-album-card'), true, '类只加在 DOM 节点上，不写回卡对象');
  assert.deepEqual(Object.keys(cards[0]), keysBefore, '卡对象字段不得被页面追加或删改');
});

/* ------------------------------------------------------------ 状态盒 */

test('status=empty → state-box 显示 getStateCopy 文案且带去导入钮', async () => {
  const { win, stateBox, grid } = bootPageWithFakeDom({ axisData: { axis: 'albums', status: 'empty', cards: [] } });
  await win.stellaMlibPage.openAxis('albums');
  const box = stateBox();
  assert.equal(box.querySelector('.stella-mlib-state-heading').textContent, '曲库还是空的');
  assert.equal(box.querySelector('.stella-mlib-state-hint').textContent, '从首页「导入」卡片开始');
  const btn = box.querySelector('.stella-mlib-state-btn');
  assert.ok(btn, '空态要有动作按钮');
  assert.equal(btn.textContent, '去导入');
  assert.equal(btn.getAttribute('data-mlib-action'), 'import', 'Task 7 按这个属性接线');
  assert.equal(box.getAttribute('data-tone'), null, '诚实空态不是警告色');
  assert.equal(grid().children.length, 0, '空态不得留卡');
});

test('engine-missing → 引擎未就绪文案、无按钮、warn 色', async () => {
  const { win, stateBox } = bootPageWithFakeDom({ axisData: { axis: 'artists', status: 'engine-missing', cards: [] } });
  await win.stellaMlibPage.openAxis('artists');
  const box = stateBox();
  assert.equal(box.querySelector('.stella-mlib-state-heading').textContent, '曲库引擎尚未就绪');
  assert.equal(box.querySelector('.stella-mlib-state-hint').textContent, '导入歌单或本地音乐后这里会自动出现');
  assert.equal(box.querySelector('.stella-mlib-state-btn'), null, '引擎未就绪不给按钮（等 subscribe，不轮询）');
  assert.equal(box.getAttribute('data-tone'), 'warn');
});

test('error → heading 原样显示缝 message + 重试钮（手动触发一次）', async () => {
  const msg = '索引重建中，请稍后再试：ENGINE_BOOT(503)';
  const { win, stateBox } = bootPageWithFakeDom({
    axisData: { axis: 'albums', status: 'error', cards: [], message: msg },
  });
  await win.stellaMlibPage.openAxis('albums');
  const box = stateBox();
  assert.equal(box.querySelector('.stella-mlib-state-heading').textContent, msg);
  assert.equal(box.querySelector('.stella-mlib-state-hint'), null, 'hint 空串就不出这一行');
  const btn = box.querySelector('.stella-mlib-state-btn');
  assert.equal(btn.textContent, '重试');
  assert.equal(btn.getAttribute('data-mlib-action'), 'retry');
  assert.equal(box.getAttribute('data-tone'), 'warn');
});

test('ok + 零卡（轴为空）→ 按轴措辞文案且无按钮、非 warn', async () => {
  const { win, stateBox } = bootPageWithFakeDom({ axisData: { axis: 'artists', status: 'ok', cards: [] } });
  await win.stellaMlibPage.openAxis('artists');
  const box = stateBox();
  assert.equal(box.querySelector('.stella-mlib-state-heading').textContent, '这个板块还没有内容');
  assert.equal(box.querySelector('.stella-mlib-state-hint').textContent,
    '艺人按曲库里的艺人信息归组，导入匹配后自动出现');
  assert.equal(box.querySelector('.stella-mlib-state-btn'), null);
  assert.equal(box.getAttribute('data-tone'), null);
});

test('正常有卡时状态盒必须清空（:empty 才 display:none）', async () => {
  const { win, stateBox } = bootPageWithFakeDom({ axisData: okAlbums([albumCard('AL1', '甲')]) });
  await win.stellaMlibPage.openAxis('albums');
  const box = stateBox();
  assert.equal(box.children.length, 0);
  assert.equal(box.innerHTML, '');
});

/* ------------------------------------------------------------ 切轴 / 并发 */

test('openAxis 同步清场：新数据到位前不得残留上一轴的卡', async () => {
  let releaseArtists;
  const artistsResult = new Promise((resolve) => { releaseArtists = resolve; });
  const { win, grid, cards } = bootPageWithFakeDom({ axisData: {
    albums: okAlbums([albumCard('AL1', '上一轴的专辑')]),
    artists: artistsResult,
  } });
  await win.stellaMlibPage.openAxis('albums');
  assert.equal(cards().length, 1);
  const pending = win.stellaMlibPage.openAxis('artists');   // 不 await
  assert.equal(grid().children.length, 0, '切轴的同步帧网格必须已清空');
  assert.equal(cards().length, 0, '不得看到上一轴内容穿过遮罩');
  releaseArtists({ axis: 'artists', status: 'ok', cards: [artistCard('AR1', 'A')] });
  await pending;
  assert.equal(cards().length, 1);
});

test('迟到的旧轴响应被丢弃：不覆盖当前渲染、不复活 payload', async () => {
  let releaseAlbums;
  const albumsResult = new Promise((resolve) => { releaseAlbums = resolve; });
  const { win, card, cards, grid } = bootPageWithFakeDom({ axisData: {
    albums: albumsResult,
    artists: { axis: 'artists', status: 'ok', cards: [artistCard('AR1', '现在这个轴')] },
  } });
  const albumsPending = win.stellaMlibPage.openAxis('albums');
  await win.stellaMlibPage.openAxis('artists');
  assert.equal(cards().length, 1);
  releaseAlbums(okAlbums([albumCard('AL_LATE', '迟到的专辑')]));
  await albumsPending;
  assert.equal(card('AL_LATE'), null, '旧请求晚到不得插卡');
  assert.equal(cards().length, 1);
  assert.equal(grid().children.length, 1);
  assert.ok(win.__mlibGridPayloadForTests.get(card('AR1')));
  assert.equal(win.__mlibGridPayloadForTests.size, 1, 'payload 只跟着当前视图走');
});

test('body 类真相源：mlib-active + 当前轴，且上一轴类必须摘掉', async () => {
  const axisData = {
    albums: okAlbums([albumCard('AL1', '甲')]),
    playlists: { axis: 'playlists', status: 'ok', cards: [playlistCard('P1', '乙')] },
  };
  const { win, body } = bootPageWithFakeDom({ axisData });
  await win.stellaMlibPage.openAxis('albums');
  assert.equal(body.classList.contains('mlib-active'), true);
  assert.equal(body.classList.contains('mlib-axis-albums'), true);
  await win.stellaMlibPage.openAxis('playlists');
  assert.equal(body.classList.contains('mlib-axis-albums'), false, '轴类互斥');
  assert.equal(body.classList.contains('mlib-axis-playlists'), true);
  assert.equal(body.classList.contains('mlib-axis-artists'), false);
  assert.equal(win.document.getElementById('music-library').getAttribute('aria-hidden'), 'false',
    '打开的层不能还对读屏隐藏');
});

// F3（Task 7 修复轮）：本层曾自己排一枚 260ms 的 markInactive，和绑定层的 420ms 让位复位抢同一条生命周期
// ——真实观测到的离场是 260 而不是契约的 420，而且 260 走的是沙箱真 setTimeout，注入假 clock 的契约测试看不见它。
// 现在 body 类（active / leaving / 轴类）的摘除单一归 09-mlib-bindings.js，
// 断言在 tests/mlib-bindings-contract.test.js「让位复位单一属主」；本层只负责：
// 在途作废 + 网格/payload 清空 + #music-library 的 aria-hidden + 点亮 leaving 动画态。
test('close() 同步清网格/payload/aria 并点亮 leaving：body 类摘除不归本层（单一属主＝绑定层 420）', async () => {
  const { win, body, grid, cards } = bootPageWithFakeDom({ axisData: okAlbums([albumCard('AL1', '甲')]) });
  await win.stellaMlibPage.openAxis('albums');
  win.stellaMlibPage.close();
  assert.equal(grid().children.length, 0, '离场一开始就清空，动画期间不给穿帮');
  assert.equal(win.__mlibGridPayloadForTests.size, 0);
  assert.equal(body.classList.contains('mlib-leaving'), true, '点亮动画态：CSS 靠它起 .26s 过渡');
  assert.equal(body.classList.contains('mlib-active'), true, '动画期间 active 还在——但这是绑定层的职责，不是本层排了 timer');
  assert.equal(win.document.getElementById('music-library').getAttribute('aria-hidden'), 'true',
    'aria-hidden 归页面层，关闭即就位（不再等自己那枚离场 timer）');
  assert.equal(cards().length, 0);
  // 真时钟走过 420 契约窗口：页面层若还自建离场 timer，到这儿类早被摘光了（F3 前的红→绿就看这两行）
  await delay(450);
  assert.equal(body.classList.contains('mlib-active'), true, '页面层绝不自己摘 active');
  assert.equal(body.classList.contains('mlib-leaving'), true, '页面层绝不自己摘 leaving');
  assert.equal(body.classList.contains('mlib-axis-albums'), true, '页面层绝不自己摘轴类');
});

test('close() 之后迟到的渲染请求也被丢弃', async () => {
  let releaseAlbums;
  const albumsResult = new Promise((resolve) => { releaseAlbums = resolve; });
  const { win, cards } = bootPageWithFakeDom({ axisData: { albums: albumsResult } });
  const pending = win.stellaMlibPage.openAxis('albums');
  win.stellaMlibPage.close();
  releaseAlbums(okAlbums([albumCard('AL1', '关门后才到')]));
  await pending;
  assert.equal(cards().length, 0);
});

/* ------------------------------------------------------------ hover 探测 */

test('hover 能力探测：有 hover 才在 html 上置 stella-mlib-has-hover', async () => {
  const withHover = bootPageWithFakeDom({ hover: true, axisData: okAlbums([albumCard('AL1', '甲')]) });
  await withHover.win.stellaMlibPage.openAxis('albums');
  assert.equal(withHover.html.classList.contains('stella-mlib-has-hover'), true);
  assert.equal(withHover.win.matchMedia('(hover: hover)').matches, true);

  const touch = bootPageWithFakeDom({ hover: false, axisData: okAlbums([albumCard('AL1', '甲')]) });
  await touch.win.stellaMlibPage.openAxis('artists');
  assert.equal(touch.html.classList.contains('stella-mlib-has-hover'), false, '触屏不得置类');
});

test('matchMedia 缺失/抛错时按无 hover 处理，openAxis 不受影响', async () => {
  const { win, html, cards } = bootPageWithFakeDom({ axisData: okAlbums([albumCard('AL1', '甲')]) });
  delete win.matchMedia;
  await win.stellaMlibPage.openAxis('albums');
  assert.equal(html.classList.contains('stella-mlib-has-hover'), false);
  assert.equal(cards().length, 1);
});

/* ------------------------------------------------------------ 端到端 */

test('端到端（真读层 + 假缝）：缝里的曲目聚合出的专辑卡，页面按卡数据渲染', async () => {
  const track = (o) => Object.assign({
    id: 't1', name: '夜曲', artist: '周杰伦', artistId: 'AR_jay',
    album: '十一月的萧邦', albumId: 'AL_chopin', cover: 'https://cdn/1.jpg',
    duration: 240, source: 'local-file', localFile: 'x.mp3', matched: true, releaseYear: 2005,
  }, o || {});
  const seam = {
    getLibraryStats: async () => ({ ready: true, rev: 7 }),
    getTracks: async () => ({ rev: 7, tracks: [track(), track({ id: 't2', name: '发如雪' })] }),
    getPlaylists: async () => ({ rev: 7, playlists: [] }),
  };
  const { win, card, cards } = bootPageWithFakeDom({ seam });
  await win.stellaMlibPage.openAxis('albums');
  assert.equal(cards().length, 1, '同 albumId 并成一张卡');
  const el = card('AL_chopin');
  const payload = win.__mlibGridPayloadForTests.get(el);
  assert.equal(payload.title, '十一月的萧邦');
  assert.equal(payload.count, 2);
  assert.equal(payload.sortBucket, 'album');
  const metaHtml = el.querySelector('.stella-mlib-album-meta').innerHTML;
  assert.ok(metaHtml.indexOf('十一月的萧邦') > 0, '标题上屏');
  assert.ok(metaHtml.indexOf('周杰伦') > 0, '副标题＝读层给的歌手上屏');
  assert.ok(metaHtml.indexOf('stella-mlib-album-sub') > 0, '专辑卡有副标题行');
  assert.equal(win.document.getElementById('mlib-state-box').children.length, 0);
});

/* ---------------------------------------------------- F1 缝通知刷新（终审回批） */
// 读层的 engine-missing 文案写着「导入歌单或本地音乐后这里会自动出现」，兑现者＝seam.subscribe。
// 页面层职责：首次 openAxis 登记一个刷新回调（注册发生在 07 的 watchSeam 里，本层不碰缝），
// 库开着（body 有 mlib-active 且不在 mlib-leaving）才按 body 现值轴走「清场→async 填充」那条既有路径。

// 一枚「引擎先缺席、喂通知后才就绪」的缝：subscribe 把 handler 交出来供测试拨动。
function bootNotify() {
  const state = { ready: false, notify: null, playlistFetches: 0 };
  const seam = {
    getLibraryStats: async () => (state.ready ? { ready: true, rev: 2 } : { ready: false }),
    getPlaylists: async () => {
      state.playlistFetches += 1;
      return state.ready ? { playlists: [{ id: 'PL1', title: '甲', count: 2 }], rev: 2 } : { playlists: [] };
    },
    getTracks: async () => ({ tracks: [], rev: 2 }),
    subscribe: (fn) => { state.notify = fn; return () => { state.notify = null; }; },
  };
  const f = bootPageWithFakeDom({ seam });
  f.notify = state;
  f.scroll = () => f.doc.getElementById('music-library-scroll');
  return f;
}

test('F1 刷新回调在首次 openAxis 登记：通知到来时空态盒被真卡替换', async () => {
  const f = bootNotify();
  assert.equal(f.notify.notify, null, '未开库前谁都不许订缝（登记点＝首次 openAxis）');
  await f.win.stellaMlibPage.openAxis('playlists');
  assert.equal(f.stateBox().children.length > 0, true, '前置：engine-missing 渲染出状态盒');
  assert.equal(f.grid().children.length, 0);
  assert.equal(typeof f.notify.notify, 'function', '首次 openAxis 必须把刷新回调登记进读层');

  f.scroll().scrollTop = 640; // 主人正在看的位置
  f.notify.ready = true;
  f.notify.notify();
  await delay(10);
  assert.equal(f.grid().children.length, 1, '通知＝引擎就绪后这里真的会自动出现：网格被换成真卡');
  assert.equal(f.cards()[0].getAttribute('data-mlib-id'), 'PL1');
  assert.equal(f.stateBox().children.length, 0, '状态盒清空（空态不得和真卡并存）');
  assert.equal(f.scroll().scrollTop, 640, '同轴刷新不得滚动——把正在看的位置弹走是回归');
  assert.equal(f.body.classList.contains('mlib-axis-playlists'), true, '刷新按 body 现值轴走，不改轴类');
  assert.equal(f.body.classList.contains('mlib-active'), true, '刷新不重放入场动画（body 类一字未动）');
});

test('F1 通知落在关闭态：回调直接返回，零渲染、零缝请求', async () => {
  const f = bootNotify();
  await f.win.stellaMlibPage.openAxis('playlists');
  // 正向对照（同一条通知链在本夹具里确实是活的）：开着时喂通知＝真重渲染
  f.notify.ready = true;
  f.notify.notify();
  await delay(10);
  assert.equal(f.notify.playlistFetches, 1, '对照：开着喂通知确实重渲染了一次');
  assert.equal(f.grid().children.length, 1);
  // 现在关闭：页面 close() + 绑定层 420ms 把 body 真相源摘净（单一属主）
  f.win.stellaMlibPage.close();
  f.body.classList.remove('mlib-active', 'mlib-axis-playlists');
  f.notify.notify();
  await delay(10);
  assert.equal(f.notify.playlistFetches, 1, '库关着不得再打缝（一次都不许多）');
  assert.equal(f.grid().children.length, 0, '关闭态不产生任何渲染');
  assert.equal(f.stateBox().children.length, 0, 'close() 清空的状态盒不得复现');
});

test('F1 通知落在让位途中（mlib-leaving）：不重渲染，免得打断离场动画', async () => {
  const f = bootNotify();
  await f.win.stellaMlibPage.openAxis('playlists');
  f.body.classList.add('mlib-leaving');
  const boxRows = f.stateBox().children.length;
  f.notify.ready = true;
  f.notify.notify();
  await delay(10);
  assert.equal(f.notify.playlistFetches, 0, '让位途中一律不重渲染');
  assert.equal(f.grid().children.length, 0);
  assert.equal(f.stateBox().children.length, boxRows, '离场画面不得被中途换掉');
  // 对照：类摘掉后同一枚通知立刻打得通——证明上面那发是被 leaving 闸拦下的，不是通知本身没接线
  f.body.classList.remove('mlib-leaving');
  f.notify.notify();
  await delay(10);
  assert.equal(f.notify.playlistFetches, 1, '通知本身是活的：漏渲染的锅只可能是 leaving 闸');
  assert.equal(f.grid().children.length, 1);
});

/* ---------------------------------------------------- R2 通知刷新不得作废在途播放（第2轮回批） */
// 第1轮的 F1 接线把通知也走了 openAxis，而 openAxis 里的 clearGrid 顺带 bump 了 playSeq（那枚代数本来是
// 「用户切轴/关闭」的作废凭据）。探针②的观测值：playEntity returned 0, queueSong calls 0——
// 用户明明点了整张播放，后台一发通知就把他的播放意图吞了。R 裁2：后台数据变更不该取消用户已发出的播放。
// 口径：playSeq 只代表用户动作；通知刷新（含 R1 的返回脏补）一律不 bump。

test('R2 播放在途时来通知：仍照常入队并以首个新入队项索引起播（探针②）', async () => {
  const f = bootNotify();
  f.notify.ready = true; // 引擎就绪＝网格里有可播卡（playable 由 count>0 决定）
  await f.win.stellaMlibPage.openAxis('playlists');
  assert.equal(f.cards()[0].getAttribute('data-mlib-id'), 'PL1', '前置事实：网格里有可播卡');

  const queued = [];
  const playCalls = [];
  f.win.queueSong = function (song) { queued.push(song); return queued.length - 1; };
  f.win.playQueueAt = function (idx) { playCalls.push(idx); return true; };
  let releaseDetail;
  f.win.stellaMlibRead.getDetail = function () {
    return new Promise((resolve) => { releaseDetail = resolve; });
  };

  const inflight = f.win.stellaMlibPage.playEntity('playlists', 'PL1');
  await null; // playEntity 已进到 await getDetail
  f.notify.ready = true;
  f.notify.notify();          // 后台通知：网格要重绘，但用户的播放意图不作废（R 裁2）
  await delay(10);
  releaseDetail({ entity: { id: 'PL1', title: '甲' }, tracks: [{ id: 't1', name: '夜曲', matched: true }], status: 'ok' });
  const n = await inflight;

  assert.equal(queued.length, 1, 'queueSong 必须仍被调到——通知不吃播放');
  assert.equal(n, 1, 'playEntity 返回值＝实际入队首数（探针②的 0 是回归）');
  assert.deepEqual(playCalls, [0], '仍以首个新入队项的索引起播');
  assert.equal(f.grid().children.length, 1, '对照：通知本身的网格刷新照旧发生了');
});

test('R2 用户动作的作废一律照旧：切轴与关闭仍作废在途播放（只放开通知这一路）', async () => {
  const f = bootNotify();
  f.notify.ready = true;
  await f.win.stellaMlibPage.openAxis('playlists');
  const queued = [];
  f.win.queueSong = function (song) { queued.push(song); return queued.length - 1; };

  let releaseA;
  f.win.stellaMlibRead.getDetail = () => new Promise((resolve) => { releaseA = resolve; });
  const a = f.win.stellaMlibPage.playEntity('playlists', 'PL1');
  await null;
  await f.win.stellaMlibPage.openAxis('albums'); // 用户切轴
  releaseA({ entity: {}, tracks: [{ id: 't1', name: '甲', matched: true }], status: 'ok' });
  assert.equal(await a, 0, '切轴＝用户动作：晚到响应一份都不入队');

  await f.win.stellaMlibPage.openAxis('playlists');
  let releaseB;
  f.win.stellaMlibRead.getDetail = () => new Promise((resolve) => { releaseB = resolve; });
  const b = f.win.stellaMlibPage.playEntity('playlists', 'PL1');
  await null;
  f.win.stellaMlibPage.close();                  // 用户关闭
  releaseB({ entity: {}, tracks: [{ id: 't2', name: '乙', matched: true }], status: 'ok' });
  assert.equal(await b, 0, '关闭＝用户动作：同样作废');
  assert.deepEqual(queued, [], '两条用户动作路径都零入队（R 裁2 只放开通知那一路）');
});

/* ---------------------------------------------------- F2 键盘可达：卡片本身可聚焦 */// 参照库 06-music-library.js:659 的卡带 tabindex="0"；移植时只搬了样式没搬焦点入口，
// 结果键盘用户 Tab 得进资料库却一张卡都停在「能聚焦的东西」上（曲目行早就 tabindex=0，卡却没有）。
// 归口：tabIndex 由 buildCard 给三轴一致的卡根；按键语义归 09-mlib-bindings.js。

test('F2 键盘可达：三轴卡根一律 tabIndex=0（与详情曲目行同一口径）', async () => {
  const axisData = {
    albums: { axis: 'albums', status: 'ok', cards: [albumCard('AL1', '甲')] },
    artists: { axis: 'artists', status: 'ok', cards: [artistCard('AR1', '乙')] },
    playlists: { axis: 'playlists', status: 'ok', cards: [playlistCard('PL1', '丙')] },
  };
  const f = bootPageWithFakeDom({ axisData });
  for (const axis of ['albums', 'artists', 'playlists']) {
    await f.win.stellaMlibPage.openAxis(axis);
    const el = f.cards()[0];
    assert.ok(el, axis + ' 轴渲染出卡');
    assert.equal(el.tabIndex, 0, axis + ' 轴卡根必须可聚焦（键盘进得去才谈得上按得动）');
    // 焦点入口是卡根本身（三轴一致），按键语义归绑定层那条唯一的 keydown 监听
    assert.equal(el.classList.contains('stella-mlib-album-card'), true);
  }
});

/* ---------------------------------------------------- F5 / R3 每次 open 都钉回顶部
   参照库 06-music-library.js:1547-1548 在 openMusicLibrary 里**每次打开**都把滚动钉回 0，没有「仅换轴才钉」
   这一档。第1轮自创的那档（同轴重开不碰 scrollTop）与本批 R 裁3 判为口径错位，已改回参照库做法：
   · 用户开轴（换轴、同轴重开、关闭后重开同轴、离场复活、retry 强制重读）＝openAxis＝钉回顶部；
   · 后台重绘（R1 的通知刷新、closeDetail 之后的脏网格补绘）**不钉**——那是把用户正在看的位置弹走的骚扰，
     也正是第1轮那档想保护的东西；保护点从「只在换轴时钉」搬到了「刷新路径不滚」。
*/

test('F5/R3 用户开轴每次都滚回顶部（参照库做法：换轴、同轴重开、关闭后重开都算 open）', async () => {
  const f = bootPageWithFakeDom({ axisData: {
    albums: { axis: 'albums', status: 'ok', cards: [albumCard('AL1', '甲')] },
    artists: { axis: 'artists', status: 'ok', cards: [artistCard('AR1', '乙')] },
  } });
  const sc = f.doc.getElementById('music-library-scroll');
  const page = f.win.stellaMlibPage;
  await page.openAxis('albums');
  sc.scrollTop = 820; // 主人滚到底去找最后一行
  await page.openAxis('artists');
  assert.equal(sc.scrollTop, 0, '换轴＝新版面从头看，不该停在上一轴的位置');
  sc.scrollTop = 640;
  await page.openAxis('artists');
  assert.equal(sc.scrollTop, 0, '同轴重开也回顶（参照库口径：openMusicLibrary 每次打开都钉 0）');
  page.close();
  f.body.classList.remove('mlib-active', 'mlib-axis-artists'); // 绑定层 420ms 的复位（单一属主）
  sc.scrollTop = 512;
  await page.openAxis('artists');
  assert.equal(sc.scrollTop, 0, '关闭后重开同一轴同样钉顶：关闭不是换轴判定的一部分');
});

test('F5/R3 钉顶只在 open 那一次：通知刷新与返回后的脏网格补绘都不许碰 scrollTop', async () => {
  const f = bootNotify();
  f.notify.ready = true;
  await f.win.stellaMlibPage.openAxis('playlists');
  const sc = f.scroll();
  sc.scrollTop = 300;
  f.notify.notify(); // 后台通知：重绘这一轴，但主人正看着的位置不动
  await delay(10);
  assert.equal(f.grid().children.length, 1, '对照：通知确实重绘了网格（不是没刷所以没滚）');
  assert.equal(sc.scrollTop, 300, '通知刷新不得把用户弹回顶部');
  sc.scrollTop = 480;
  await f.win.stellaMlibPage.openAxis('playlists'); // 用户重开同轴＝参照库那档，钉回 0
  assert.equal(sc.scrollTop, 0, '同一条轴的两次路径分别对口：open 钉、刷新不钉');
});

