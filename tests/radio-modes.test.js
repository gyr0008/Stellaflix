'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/jsdom');

const appRoot = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
const radioModesScript = fs.readFileSync(
  path.join(appRoot, 'public', 'js', 'modules', '05-playback', '04a-radio-modes.js'),
  'utf8',
);
const indexCss = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
const indexLoader = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');

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

function hasIdAndClassTag(source, tagName, id, className) {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  const idPattern = new RegExp(`\\bid=["']${id}["']`, 'i');
  return Array.from(source.matchAll(tagPattern)).some((match) => {
    const classAttribute = match[0].match(/\bclass=["']([^"']*)["']/i);
    return idPattern.test(match[0])
      && classAttribute
      && classAttribute[1].split(/\s+/).includes(className);
  });
}

function cssRuleSelectors(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  const ruleStart = /([^{}]+)\{/g;
  let match;
  while ((match = ruleStart.exec(withoutComments))) {
    const header = match[1].trim();
    if (!header || header.startsWith('@')) continue;
    header.split(',').map((part) => part.trim()).filter(Boolean).forEach((part) => selectors.push(part));
  }
  return selectors;
}

test('radio modes module is registered in index-loader', () => {
  assert.match(indexLoader, /'js\/modules\/05-playback\/04a-radio-modes\.js'/);
  const dashboardIdx = indexLoader.indexOf('03a-home-dashboard.js');
  const radioIdx = indexLoader.indexOf('04a-radio-modes.js');
  assert.ok(dashboardIdx > 0 && radioIdx > dashboardIdx, 'radio-modes must load after dashboard');
});

test('radio modes modal DOM exists and homepage entry points to it', () => {
  assert.ok(hasIdAndClassTag(indexHtml, 'div', 'home-radio-modes-mask', 'modal-mask'));
  assert.ok(hasIdAndClassTag(indexHtml, 'div', 'radio-mode-grid', 'radio-mode-grid'));
  assert.ok(indexHtml.includes("onclick=\"openRadioModes('all')\""), 'home radio entry should open radio modes');
  assert.ok(indexHtml.includes('data-radio-category="all"'));
  assert.ok(indexHtml.includes('data-radio-category="personal"'));
  assert.ok(indexHtml.includes('data-radio-category="scene"'));
  assert.ok(indexHtml.includes('data-radio-category="style"'));
  assert.ok(indexHtml.includes('data-radio-category="energy"'));
});

test('radio modes CSS rules are present', () => {
  const selectors = cssRuleSelectors(indexCss);
  const required = [
    '.home-radio-modes-modal',
    '.home-radio-modes-tabs',
    '.radio-category-btn',
    '.radio-mode-grid',
    '.radio-mode-card',
    '.radio-mode-card.favorite',
    '.radio-mode-favorite',
    '.radio-mode-play',
    '.radio-mode-title',
    '.radio-mode-sub',
  ];
  for (const sel of required) {
    assert.ok(selectors.some((s) => s.includes(sel)), `expected CSS rule for ${sel}`);
  }
});

test('radio modes data and core functions are defined', () => {
  assert.ok(namedFunctionSource(radioModesScript, 'radioModeDefinition'));
  assert.ok(namedFunctionSource(radioModesScript, 'isRadioModeFavorite'));
  assert.ok(namedFunctionSource(radioModesScript, 'toggleRadioModeFavorite'));
  assert.ok(namedFunctionSource(radioModesScript, 'renderRadioModes'));
  assert.ok(namedFunctionSource(radioModesScript, 'openRadioModes'));
  assert.ok(namedFunctionSource(radioModesScript, 'selectRadioCategory'));
  assert.ok(namedFunctionSource(radioModesScript, 'refreshRadioModes'));
  assert.ok(namedFunctionSource(radioModesScript, 'closeRadioModes'));
  assert.ok(namedFunctionSource(radioModesScript, 'playRadioMode'));
  assert.ok(namedFunctionSource(radioModesScript, 'buildRadioModeSongs'));
  assert.ok(radioModesScript.includes('RADIO_MODE_DEFINITIONS = ['));
  assert.ok(radioModesScript.includes("id: 'personal'"));
  assert.ok(radioModesScript.includes("id: 'sleep'"));
  assert.ok(radioModesScript.includes("id: 'dj'"));
});

test('radio modes renders 29 cards and filters by category', () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="home-radio-modes-mask" class="modal-mask" aria-hidden="true">
      <div class="home-radio-modes-modal">
        <div class="home-radio-modes-tabs">
          <button data-radio-category="all">全部</button>
          <button data-radio-category="personal">为你推荐</button>
          <button data-radio-category="scene">场景</button>
          <button data-radio-category="style">风格</button>
          <button data-radio-category="energy">能量</button>
        </div>
        <div id="radio-mode-grid" class="radio-mode-grid"></div>
      </div>
    </div>
  </body></html>`, { url: 'http://localhost/' });
  const window = dom.window;
  const document = window.document;

  const sandbox = {
    console: console,
    document: document,
    window: window,
    setTimeout: window.setTimeout,
    setInterval: window.setInterval,
    clearTimeout: window.clearTimeout,
    localStorage: {
      _data: {},
      getItem(k) { return this._data[k] || null; },
      setItem(k, v) { this._data[k] = v; },
    },
    showToast: function () {},
    homeDashboardLocalSongs: function () { return []; },
    homeListenSummary: function () { return {}; },
    simpleSearchNorm: function (text) {
      return String(text || '').toLowerCase().replace(/[\s·・,，。.!！?？'"“”‘’|\-_/]+/g, '');
    },
    cloneSong: function (song) { return Object.assign({}, song); },
    queueItemKey: function (song) { return (song && song.id) || ''; },
    escHtml: function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    apiJson: async function () { return { songs: [] }; },
    playQueueAt: async function () {},
    safeRenderQueuePanel: function () {},
    forcePlaybackControlsInteractive: function () {},
  };

  vm.createContext(sandbox);
  vm.runInContext(radioModesScript, sandbox);

  // Initial render with default category 'all'
  sandbox.openRadioModes('all');
  const gridAll = document.getElementById('radio-mode-grid');
  assert.equal(gridAll.children.length, 29, 'all category should render 29 cards');

  // Filter to scene
  sandbox.selectRadioCategory('scene');
  const gridScene = document.getElementById('radio-mode-grid');
  assert.ok(gridScene.children.length > 0 && gridScene.children.length < 29, 'scene category should filter cards');
  assert.ok(Array.from(gridScene.children).every((card) => {
    const title = card.querySelector('.radio-mode-title');
    return title && (title.textContent === '今日漫游' || title.textContent === '通勤节拍' || title.textContent === '深夜氛围' || title.textContent === '专注电台' || title.textContent === '清晨唤醒' || title.textContent === '雨天咖啡馆' || title.textContent === '公路旅行' || title.textContent === '睡前轻音乐');
  }), 'scene cards should only contain scene-mode titles');
});

test('radio modes favorite toggles and persists', () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="home-radio-modes-mask" class="modal-mask" aria-hidden="true">
      <div class="home-radio-modes-modal">
        <div class="home-radio-modes-tabs">
          <button data-radio-category="all">全部</button>
        </div>
        <div id="radio-mode-grid" class="radio-mode-grid"></div>
      </div>
    </div>
  </body></html>`, { url: 'http://localhost/' });
  const window = dom.window;
  const document = window.document;

  const storage = {};
  const sandbox = {
    console: console,
    document: document,
    window: window,
    setTimeout: window.setTimeout,
    setInterval: window.setInterval,
    clearTimeout: window.clearTimeout,
    localStorage: {
      getItem(k) { return storage[k] || null; },
      setItem(k, v) { storage[k] = v; },
    },
    showToast: function () {},
    homeDashboardLocalSongs: function () { return []; },
    homeListenSummary: function () { return {}; },
    simpleSearchNorm: function (text) {
      return String(text || '').toLowerCase().replace(/[\s·・,，。.!！?？'"“”‘’|\-_/]+/g, '');
    },
    cloneSong: function (song) { return Object.assign({}, song); },
    queueItemKey: function (song) { return (song && song.id) || ''; },
    escHtml: function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    apiJson: async function () { return { songs: [] }; },
    playQueueAt: async function () {},
    safeRenderQueuePanel: function () {},
    forcePlaybackControlsInteractive: function () {},
  };

  vm.createContext(sandbox);
  vm.runInContext(radioModesScript, sandbox);
  sandbox.openRadioModes('all');

  let firstCard = document.querySelector('.radio-mode-card');
  assert.ok(firstCard, 'first card should exist');
  const firstModeId = firstCard.getAttribute('onclick').match(/playRadioMode\('([^']+)'\)/)[1];
  assert.ok(firstModeId, 'first card should have a mode id');

  // Favorite via API (DOM click simulation is flaky in jsdom)
  sandbox.toggleRadioModeFavorite(firstModeId, null);
  firstCard = document.querySelector('.radio-mode-card');
  assert.ok(firstCard.classList.contains('favorite'), 'card should have favorite class after toggle');
  assert.ok(storage['stellaflix-radio-mode-favorites-v1'], 'favorites should be persisted to localStorage');

  // Unfavorite via API
  sandbox.toggleRadioModeFavorite(firstModeId, null);
  firstCard = document.querySelector('.radio-mode-card');
  assert.ok(!firstCard.classList.contains('favorite'), 'card should lose favorite class after second toggle');
});

test('radio modes play path builds queue and calls playQueueAt', async () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="home-radio-modes-mask" class="modal-mask" aria-hidden="true">
      <div class="home-radio-modes-modal">
        <div class="home-radio-modes-tabs"><button data-radio-category="all">全部</button></div>
        <div id="radio-mode-grid" class="radio-mode-grid"></div>
      </div>
    </div>
  </body></html>`, { url: 'http://localhost/' });
  const window = dom.window;
  const document = window.document;

  let playQueueAtCalled = false;
  let capturedQueue = null;
  const sandbox = {
    console: console,
    document: document,
    window: window,
    setTimeout: window.setTimeout,
    setInterval: window.setInterval,
    clearTimeout: window.clearTimeout,
    localStorage: { getItem() { return null; }, setItem() {} },
    showToast: function () {},
    homeDashboardLocalSongs: function () {
      return [
        { id: 'local-1', name: 'Local Song', artist: 'Local Artist', type: 'local', localPath: '/a.mp3' },
      ];
    },
    homeListenSummary: function () { return {}; },
    simpleSearchNorm: function (text) {
      return String(text || '').toLowerCase().replace(/[\s·・,，。.!！?？'"“”‘’|\-_/]+/g, '');
    },
    cloneSong: function (song) { return Object.assign({}, song); },
    queueItemKey: function (song) { return (song && song.id) || ''; },
    escHtml: function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    apiJson: async function () {
      return {
        songs: [
          { id: 'net-1', name: 'Network Song', artist: 'Network Artist', source: 'wy' },
          { id: 'net-2', name: 'DJ Mix', artist: 'DJ Artist', source: 'kg' },
        ],
      };
    },
    playQueue: [],
    currentIdx: -1,
    playQueueAt: async function (idx, opts) {
      playQueueAtCalled = true;
      capturedQueue = sandbox.playQueue;
      assert.equal(idx, 0, 'playQueueAt should start at index 0');
      assert.ok(opts && opts.manual, 'playQueueAt should receive manual flag');
      assert.ok(opts && opts.context && opts.context.type === 'radio-mode', 'playQueueAt context type should be radio-mode');
    },
    safeRenderQueuePanel: function () {},
    forcePlaybackControlsInteractive: function () {},
  };

  vm.createContext(sandbox);
  vm.runInContext(radioModesScript, sandbox);
  sandbox.openRadioModes('all');

  // Trigger play via API (DOM click simulation is flaky in jsdom)
  await sandbox.playRadioMode('sleep');

  assert.ok(playQueueAtCalled, 'playQueueAt should be called');
  assert.ok(capturedQueue && capturedQueue.length > 0, 'queue should be populated');
  assert.ok(capturedQueue.every((song) => song.radioModeId === 'sleep'), 'all queued songs should have radioModeId sleep');
});
