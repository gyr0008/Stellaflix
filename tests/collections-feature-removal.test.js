'use strict';

/**
 * 「片单页 + 我的片单（片单夹）」删除完整性断言
 * 范围：仅影视态；音乐态（public/js/modules/04-shelf、shelfPane 'mine' 等）不得触碰。
 * 运行：node --test tests/collections-feature-removal.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

test('片单页与播放器收藏弹窗文件已删除且不再注册', () => {
  assert.equal(exists('public/video/page-collections.js'), false, 'page-collections.js 须删除');
  assert.equal(exists('public/video/player-collect.js'), false, 'player-collect.js 须删除');
  assert.equal(exists('tests/collection-poster-check.js'), false, 'collection-poster-check.js 须删除');
  const html = read('public/index.html');
  assert.equal(html.includes('video/page-collections.js'), false, 'index.html 不得再注册 page-collections');
  assert.equal(html.includes('video/player-collect.js'), false, 'index.html 不得再注册 player-collect');
});

test('collections.js 移除用户片单夹（C 玩法），保留观看标记（MARKS）', () => {
  const src = read('public/video/collections.js');
  assert.equal(src.includes('listUserFolders'), false, 'listUserFolders 须删除');
  assert.equal(src.includes("'mine'"), false, '「我的片单」tab 须删除');
  assert.equal(src.includes("'user-folder'"), false, 'user-folder 类型须删除');
  assert.equal(src.includes('createUserFolder'), false);
  assert.equal(src.includes('deleteUserFolder'), false);
  assert.equal(src.includes('addUserItem'), false);
  assert.equal(src.includes('USER_KEY'), false, 'stellaflix-user-collections 读写键须删除');
  // 保留：看过/弃 标记与内置目录
  assert.match(src, /MARKS_KEY/);
  assert.match(src, /stellaflix-view-marks/);
  assert.match(src, /\{ id: 'calendar'/, '每周新番目录项保留');
});

test('online-collections.js 保留 items 视图与片库/时间表，删除片单页跳转', () => {
  const src = read('public/video/online-collections.js');
  assert.equal(src.includes('openCollections'), false, 'openCollections 须删除');
  assert.equal(src.includes('reopenCollections'), false, 'reopenCollections 须删除');
  assert.equal(src.includes('showPickFolderDialog'), false, '加入我的片单弹窗须删除');
  assert.equal(src.includes('pageCollections'), false, '不得再引用已删除的 page-collections 模块');
  assert.equal(src.includes('listUserFolders'), false);
  assert.match(src, /function\s+openLibrary/);
  assert.match(src, /function\s+openCollectionItems/);
  assert.match(src, /function\s+renderCollectionItems/);
});

test('online.js 导出面收敛', () => {
  const src = read('public/video/online.js');
  assert.equal(src.includes('openCollections:'), false);
  assert.equal(src.includes('reopenCollections:'), false);
  assert.equal(src.includes('showPickFolderDialog:'), false);
  assert.match(src, /openLibrary:/);
  assert.match(src, /openCollectionItems:/);
});

test('online-nav.js 无 pageCollections 残留；fullscreen 分支仅片库', () => {
  const src = read('public/video/online-nav.js');
  assert.equal(src.includes('pageCollections'), false, '文件夹弹窗 Esc 逻辑须随功能删除');
  assert.equal(src.includes("key === 'collections'"), false, 'goToNav 不再特判 collections 页');
  assert.match(src, /key === 'library'/);
});

test('detail.js 收藏图标改为不可点占位', () => {
  const src = read('public/video/detail.js');
  assert.equal(src.includes('openCollectPanel'), false);
  assert.equal(src.includes('listUserFolders'), false);
  assert.equal(src.includes('refreshCollectBtn'), false);
  assert.equal(src.includes('collectItemPayload'), false);
  // 保留图标占位：disabled + title，不绑定 click
  assert.match(src, /btnColl\.disabled\s*=\s*true/);
  assert.equal(/btnColl\.addEventListener\(\s*['"]click/.test(src), false, '占位图标不得可点');
});

test('hall.js / bangumi / home-cards / page-library / wall-adapter 无片单夹残留', () => {
  const files = [
    'public/video/hall.js',
    'public/video/bangumi-timeline.js',
    'public/video/bangumi-info.js',
    'public/video/home-cards.js',
    'public/video/page-library.js',
    'public/video/poster-wall/wall-adapter.js',
  ];
  for (const f of files) {
    const src = read(f);
    assert.equal(/playerCollect|listUserFolders|openCollections\b|reopenCollections/.test(src), false,
      `${f} 不得再引用片单夹/片单页 API`);
  }
});

test('player.css 播放器收藏弹窗样式随文件删除', () => {
  const css = read('public/video/player.css');
  assert.equal(css.includes('sfv-collect-modal-mask'), false, 'player-collect 弹窗样式须删除');
});

test('音乐态片架（shelfPane mine）不在删除面内', () => {
  const shelf = read('public/js/modules/04-shelf/01-manager-core.js');
  assert.match(shelf, /shelfPane\s*===\s*'mine'/, '音乐态片架逻辑保持原样');
});
