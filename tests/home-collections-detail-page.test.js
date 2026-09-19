'use strict';

/**
 * 精选片单 · 弹窗二级页（参照移动端片单页设计，用户 2026-09-19 裁定：先改弹窗二级页）
 * 结构：hero 头图（首海报 CSS blur 底 + 片单名 + 共N部 + 返回）
 *      + 四列海报网格（左上=年份胶囊，右上=地区胶囊，底部=类型串压图，标题在图下）
 * 数据：tmdb.js normalizeList 补 originalLanguage；getDetails 补 genres；
 *      静态 GENRE_NAMES 字典 + genreNames()/regionLabel()（零额外请求）
 * 运行：node --test tests/home-collections-detail-page.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const tmdbSrc = read('public/video/tmdb.js');
const overlaySrc = read('public/video/home-collections-overlay.js');
const indexCss = read('public/css/index.css');

// ---------------------------------------------------------------- 数据层

test('normalizeList 保留 originalLanguage（地区胶囊零额外请求）', () => {
  const fn = /function\s+normalizeList[\s\S]*?\n  \}/.exec(tmdbSrc);
  assert.ok(fn, 'expected normalizeList()');
  assert.match(fn[0], /originalLanguage:\s*r\.original_language/);
});

test('getDetails 返回 genres 中文名数组（static-list 片单的类型串）', () => {
  const fn = /function\s+getDetails[\s\S]*?\n  \}/.exec(tmdbSrc);
  assert.ok(fn, 'expected getDetails()');
  assert.match(fn[0], /genres:\s*\(r\.genres\s*\|\|\s*\[\]\)\.map/);
});

test('GENRE_NAMES 静态字典存在且含常用 ID', () => {
  assert.match(tmdbSrc, /var\s+GENRE_NAMES\s*=\s*\{/);
  ['28: ', '16: ', '35: ', '18: ', '10749: ', '878: ', '53: ', '9648: ', '10751: ', '10765: '].forEach((k) => {
    assert.ok(tmdbSrc.includes(k), 'GENRE_NAMES 须含 genre id ' + k.trim());
  });
  // 中文值
  assert.match(tmdbSrc, /28:\s*'动作'/);
  assert.match(tmdbSrc, /16:\s*'动画'/);
});

test('genreNames(ids) 输出顿号串，未知 ID 跳过，空数组得空串', () => {
  const fn = /function\s+genreNames\s*\([\s\S]*?\n  \}/.exec(tmdbSrc);
  assert.ok(fn, 'expected genreNames()');
  assert.match(fn[0], /GENRE_NAMES\s*\[/);
  assert.match(fn[0], /\.filter\s*\(/);
  assert.match(fn[0], /\.join\s*\(/);
  assert.match(tmdbSrc, /genreNames:\s*genreNames/);
});

test('regionLabel(lang) 语言码→中文地区，未知语言返回空串（缺字段即隐藏，不学参照图渲染 0）', () => {
  const fn = /function\s+regionLabel\s*\([\s\S]*?\n  \}/.exec(tmdbSrc);
  assert.ok(fn, 'expected regionLabel()');
  assert.match(tmdbSrc, /var\s+LANG_REGION\s*=\s*\{/);
  assert.match(tmdbSrc, /zh:\s*'内地'/);
  assert.match(tmdbSrc, /en:\s*'美国'/);
  assert.match(tmdbSrc, /ja:\s*'日本'/);
  assert.match(tmdbSrc, /regionLabel:\s*regionLabel/);
});

// ---------------------------------------------------------------- 视图层：进入二级页

test('点片单卡改为弹窗内二级页：openCollectionById 调 openCollectionDetail，不再跳浏览层', () => {
  const fn = /function\s+openCollectionById\s*\([\s\S]*?\n  \}/.exec(overlaySrc);
  assert.ok(fn, 'expected openCollectionById()');
  assert.match(fn[0], /openCollectionDetail\s*\(/);
  assert.equal(fn[0].includes('openCollectionItems'), false, '弹窗卡点击不得再跳浏览层 openCollectionItems');
});

test('二级页数据：openCollectionDetail 用 collections.getItems 拉列表并缓存到 state', () => {
  const fn = /function\s+openCollectionDetail\s*\([\s\S]*?\n  \}/.exec(overlaySrc);
  assert.ok(fn, 'expected openCollectionDetail()');
  assert.match(fn[0], /collections\.getItems\s*\(/);
  assert.match(fn[0], /state\.collection\s*=/);
  assert.match(fn[0], /renderItemsPage|renderCollectionDetail/);
  // 无 Key / 网络失败：catch 分支渲染空态而非白屏
  assert.match(fn[0], /\.catch\s*\(/);
});

test('二级页结构：hero 头图 + 返回按钮 + 条目网格 + 年份/地区胶囊 + 类型串', () => {
  assert.match(overlaySrc, /home-video-collections-hero\b/);
  assert.match(overlaySrc, /home-video-collections-back/);
  assert.match(overlaySrc, /home-video-collections-items-grid/);
  assert.match(overlaySrc, /home-video-collections-item-year/);
  assert.match(overlaySrc, /home-video-collections-item-region/);
  assert.match(overlaySrc, /home-video-collections-item-genres/);
  assert.match(overlaySrc, /home-video-collections-item-title/);
});

test('胶囊条件渲染：年份/地区/类型缺失即整段省略（不渲染空胶囊或 0）', () => {
  // item 卡构造函数内须以 if/三元 守卫三个字段
  const fn = /function\s+itemCardHtml\s*\([\s\S]*?\n  \}/.exec(overlaySrc);
  assert.ok(fn, 'expected itemCardHtml()');
  assert.match(fn[0], /it\.year\s*&&|\(it\.year\s*\?/);
  assert.match(fn[0], /region\s*&&|\(region\s*\?/);
  assert.match(fn[0], /genres\s*&&|\(genres\s*\?/);
});

test('二级页交互：点条目走 openDetailFromMeta；返回/Esc 先回一级，一级才关弹窗', () => {
  assert.match(overlaySrc, /openDetailFromMeta\s*\(/);
  const back = /function\s+closeCollectionDetail\s*\([\s\S]*?\n  \}/.exec(overlaySrc);
  assert.ok(back, 'expected closeCollectionDetail()');
  assert.match(back[0], /state\.collection\s*=\s*null/);
  assert.match(back[0], /renderList\s*\(\s*\)/);
  // Esc 处理须先判二级页（level/collection 打开时返回一级，不关整个弹窗）
  const esc = /Escape[\s\S]{0,240}/.exec(overlaySrc);
  assert.ok(esc, 'expected Escape handling');
  assert.match(esc[0], /state\.collection/);
});

test('二级页 hero 标题含「共N部」计数与片单名', () => {
  assert.match(overlaySrc, /共.{0,6}部/);
  // hero 底 = 首条目海报 CSS 背景图（禁 canvas）
  const hero = /function\s+renderItemsPage[\s\S]*?function\s+\w+/.exec(overlaySrc) ||
    /function\s+renderCollectionDetail[\s\S]*?function\s+\w+/.exec(overlaySrc);
  assert.ok(hero, 'expected items-page render function');
  assert.match(hero[0], /background-image/);
  assert.equal(/getContext|drawImage|canvas/i.test(hero[0]), false, 'hero 底禁用 canvas');
});

// ---------------------------------------------------------------- CSS

test('CSS：二级页四列网格 + hero 用 filter blur（禁 canvas 红线）', () => {
  const grid = /\.home-video-collections-items-grid\s*\{[^}]*\}/s.exec(indexCss);
  assert.ok(grid, '缺少 .home-video-collections-items-grid 规则');
  assert.match(grid[0], /grid-template-columns:\s*repeat\(\s*4/);
  const hero = /\.home-video-collections-hero-bg\s*\{[^}]*\}/s.exec(indexCss);
  assert.ok(hero, '缺少 .home-video-collections-hero-bg 规则');
  assert.match(hero[0], /filter:\s*blur\(/);
  // 胶囊样式存在且为深色半透明底
  const pill = /\.home-video-collections-item-year\s*\{[^}]*\}/s.exec(indexCss);
  assert.ok(pill, '缺少 .home-video-collections-item-year 胶囊规则');
  assert.match(pill[0], /border-radius/);
});
