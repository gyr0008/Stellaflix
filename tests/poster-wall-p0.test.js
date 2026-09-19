'use strict';

/**
 * 片库海报墙：TMDB 多品类数据层 + 蜂窝墙接线
 * 运行：node --test tests/poster-wall-p0.test.js
 *
 * 行排几何用例随 Lattice 行墙删除；蜂窝几何/衰减由 tests/hex-card-wall.test.js 覆盖，
 * DOM 层行为由 tests/hex-wall.test.js 覆盖。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('adapter：主路径为 TMDB 多品类，历史只作补充', () => {
  const calls = [];
  const sandbox = { console, Math, Number, Array, Object, String, Promise };
  sandbox.window = sandbox;
  sandbox.StellaflixVideo = {
    tmdb: {
      hasKey() { return true; },
      popular() { calls.push('popular'); return Promise.resolve([{ id: 1, title: 'A', year: '2020', poster: '/a.jpg', rating: 8 }]); },
      trending(mt) { calls.push('trending:' + mt); return Promise.resolve([{ id: mt === 'tv' ? 2 : 3, title: 'T' + mt, poster: '/t.jpg', rating: 7 }]); },
      upcoming() { calls.push('upcoming'); return Promise.resolve([{ id: 4, title: 'U', poster: '/u.jpg' }]); },
      discover(params) {
        calls.push('discover:' + (params && params.with_genres));
        return Promise.resolve([{ id: 100 + Number(params.with_genres), title: 'G' + params.with_genres, poster: '/g.jpg' }]);
      }
    },
    collections: { listUserFolders() { return [{ id: 'f', name: '我的片单', items: [] }]; } },
    watchHistory: { getAll() { return [{ key: 'x', title: '旧历史', pic: 'p', progress: 0.3 }]; } },
    model: {
      getKeysByFlag() { return []; },
      getLibrary() { return []; },
      getHistory() { return []; },
      getMeta() { return null; },
      getProgress() { return null; }
    },
    online: { openDetailFromMeta() { return true; } }
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/poster-wall/wall-adapter.js'), sandbox, { filename: 'wall-adapter.js' });

  return sandbox.StellaflixVideo.posterWallAdapter.collectWallItemsAsync().then((res) => {
    assert.strictEqual(res.keyMissing, false);
    assert.ok(res.items.length >= 4);
    assert.ok(calls.some((c) => c === 'popular'));
    assert.ok(calls.some((c) => c.startsWith('discover:')));
    // TMDB 条目在前
    assert.ok(res.items[0].source === 'tmdb');
    assert.ok(res.items[0].sectionLabel);
    // 历史补充存在但不主导
    const hist = res.items.find((i) => i.source === 'history');
    if (hist) {
      assert.ok(res.items.indexOf(hist) > 0);
    }
  });
});

test('adapter：无 TMDB Key 时返回 keyMissing', () => {
  const sandbox = { console, Math, Number, Array, Object, String, Promise };
  sandbox.window = sandbox;
  sandbox.StellaflixVideo = {
    tmdb: { hasKey() { return false; } },
    collections: { listUserFolders() { return []; } },
    watchHistory: { getAll() { return []; } },
    model: { getKeysByFlag() { return []; }, getLibrary() { return []; }, getHistory() { return []; } }
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/poster-wall/wall-adapter.js'), sandbox, { filename: 'wall-adapter.js' });
  return sandbox.StellaflixVideo.posterWallAdapter.collectWallItemsAsync().then((res) => {
    assert.strictEqual(res.keyMissing, true);
  });
});

test('接线：蜂窝墙模块 / 深色片库 / 首页 LIBRARY', () => {
  const html = read('public/index.html');
  assert.match(html, /video\/poster-wall\/wall-adapter\.js/);
  assert.match(html, /video\/poster-wall\/hex-wall\.js/);
  assert.match(html, /video\/poster-wall\/poster-wall\.css/);
  assert.ok(!/wall-geometry\.js|wall-dom\.js/.test(html), '旧行墙脚本应已从 index.html 移除');
  const page = read('public/video/page-library.js');
  assert.match(page, /posterWall\.mount/);
  assert.match(page, /双态隔离/);
  const dom = read('public/video/poster-wall/hex-wall.js');
  assert.match(dom, /collectWallItemsAsync/);
  assert.match(dom, /TMDB/);
  assert.match(dom, /StellaflixHexGrid/);
  assert.match(dom, /StellaflixHexCard/);
  const css = read('public/video/poster-wall/poster-wall.css');
  assert.match(css, /sfv-library-chrome/);
  assert.match(css, /#070707/);
  assert.match(css, /sfv-hex-card/);
  const cards = read('public/video/home-cards.js');
  assert.match(cards, /title:\s*'片库'/);
  assert.match(cards, /openLibrary/);
});

test('片库整屏：无页内标题区，顶部浏览条仅片库页隐藏', () => {
  const page = read('public/video/page-library.js');
  assert.doesNotMatch(page, /sfv-library-head/, '页内 LIBRARY/片库/说明 标题区应已删除');
  assert.doesNotMatch(page, /sfv-library-eyebrow/);

  const css = read('public/video/poster-wall/poster-wall.css');
  assert.match(
    css,
    /\.sfv-library-chrome\.sfv-browse--fullscreen \.sfv-browse-head\s*\{[^}]*display:\s*none\s*!important/,
    '仅片库全屏态隐藏顶部浏览条'
  );
  // 隐藏规则只作用于片库 chrome，不得全局隐藏浏览条
  assert.doesNotMatch(css, /^\s*\.sfv-browse-head\s*\{[^}]*display:\s*none/m);
});
