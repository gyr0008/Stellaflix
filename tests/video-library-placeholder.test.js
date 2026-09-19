'use strict';

/**
 * 影视态「片库」占位页 + 首页「片单」→「片库」改名
 * 运行：node --test tests/video-library-placeholder.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('index.html 按序加载 page-library.js 且不重复', () => {
  const html = read('public/index.html');
  const matches = html.match(/video\/page-library\.js/g) || [];
  assert.strictEqual(matches.length, 1, 'page-library.js 应恰好加载一次');
  const coll = html.indexOf('video/page-collections.js');
  const lib = html.indexOf('video/page-library.js');
  // 片单页（page-collections.js）已随「我的片单」功能删除；片库占位页保留
  assert.ok(coll === -1 && lib >= 0, 'page-collections.js 应已删除，page-library.js 保留');
});

test('首页片库卡：文案改名 + 主入口 openLibrary', () => {
  const src = read('public/video/home-cards.js');
  assert.match(src, /label:\s*'LIBRARY'/);
  assert.match(src, /title:\s*'片库'/);
  const libraryCard = src.slice(src.indexOf("label: 'LIBRARY'"), src.indexOf("label: 'TRACKING'"));
  // 主入口必须先走片库占位页；openCollections 仅允许作为 openLibrary 缺失时的兜底
  assert.match(libraryCard, /openLibrary\(\)/);
  assert.match(libraryCard, /typeof SFV\.online\.openLibrary === 'function'/);
});

test('page-library.js 注册 router id=library 并预留墙挂载点', () => {
  const src = read('public/video/page-library.js');
  assert.match(src, /id:\s*'library'/);
  assert.match(src, /title:\s*'片库'/);
  assert.match(src, /sfv-library-wall-host/);
  assert.match(src, /getWallHost/);

  const sandbox = {
    console,
    document: {
      createElement(tag) {
        return {
          tagName: tag,
          className: '',
          innerHTML: '',
          textContent: '',
          style: {},
          children: [],
          classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
          setAttribute() {},
          appendChild(c) { this.children.push(c); return c; },
          addEventListener() {},
        };
      },
      getElementById() { return null; },
      body: { classList: { add() {}, remove() {}, contains() { return false; } } },
    },
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  const registered = [];
  sandbox.StellaflixVideo = {
    router: {
      register(p) { registered.push(p); },
    },
    ui: { setTitle() {}, setBrowseChrome() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/page-library.js'), sandbox, { filename: 'page-library.js' });

  assert.strictEqual(registered.length, 1);
  assert.strictEqual(registered[0].id, 'library');
  assert.strictEqual(registered[0].title, '片库');
  assert.strictEqual(typeof registered[0].mount, 'function');
  assert.strictEqual(sandbox.StellaflixVideo.pageLibrary.id, 'library');
});

test('online 链路：openLibrary 绑定 + goToNav 支持 library 全屏标题', () => {
  const coll = read('public/video/online-collections.js');
  assert.match(coll, /function openLibrary/);
  assert.match(coll, /S\.openLibrary\s*=\s*openLibrary/);
  assert.match(coll, /goToNav\('library'\)/);

  const online = read('public/video/online.js');
  assert.match(online, /openLibrary:\s*S\.openLibrary/);

  const nav = read('public/video/online-nav.js');
  // 片单页已删除，goToNav 仅保留 library 分支
  assert.match(nav, /key === 'library'/);
  assert.match(nav, /片库/);
  assert.match(nav, /sfv-library-chrome/);
});

test('片库占位样式与双态隔离注释存在', () => {
  const css = read('public/video/player.css');
  assert.match(css, /sfv-library-chrome\.sfv-browse--fullscreen/);
  assert.match(css, /sfv-library-wall-host/);
  const page = read('public/video/page-library.js');
  assert.match(page, /双态隔离/);
  assert.match(page, /Folia/);
});
