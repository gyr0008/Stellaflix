'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { namedFunctionSource } = require('./helpers/extract-fn');

const appRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(appRoot, p), 'utf8');

const sharedSource = read('public/video/online-shared.js');
const filterSource = read('public/video/search-filter.js');
const indexHtml = read('public/index.html');

const HISTORY_KEY = 'stellaflix-video-search-history';

function makeLocalStorage(initial) {
  const store = new Map();
  if (initial !== undefined) store.set(HISTORY_KEY, initial);
  return {
    store,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

// 把 online-shared 的历史函数挂进沙箱：S / SFV.searchPrivacy / localStorage 均由 prelude 提供
function runHistorySandbox(privacyOn, ls) {
  const sandbox = { privacyOn, ls, out: {} };
  const code = [
    "var S = { SEARCH_HISTORY_KEY: 'stellaflix-video-search-history', MAX_SEARCH_HISTORY: 12 };",
    'var SFV = { searchPrivacy: { isNoSearchHistory: function () { return privacyOn; } } };',
    'var localStorage = ls;',
    namedFunctionSource(sharedSource, 'getSearchHistory'),
    namedFunctionSource(sharedSource, 'saveSearchHistory'),
    'out.getSearchHistory = getSearchHistory;',
    'out.saveSearchHistory = saveSearchHistory;',
  ].join('\n');
  vm.runInNewContext(code, sandbox);
  return sandbox.out;
}

test('search-privacy 模块：默认关闭，开启后持久化为 ON，关闭后清除', () => {
  const privacy = require(path.join(appRoot, 'public', 'video', 'search-privacy.js'));
  const ls = makeLocalStorage();
  assert.equal(privacy.isNoSearchHistory(ls), false, '无存储记录时默认不处于隐私态');
  privacy.setNoSearchHistory(true, ls);
  assert.equal(privacy.isNoSearchHistory(ls), true);
  assert.equal(ls.getItem(privacy.KEY), '1');
  privacy.setNoSearchHistory(false, ls);
  assert.equal(privacy.isNoSearchHistory(ls), false);
  assert.equal(ls.getItem(privacy.KEY), null);
});

test('隐私 ON 时 saveSearchHistory 完全不写入历史', () => {
  const ls = makeLocalStorage(JSON.stringify(['旧词']));
  const api = runHistorySandbox(true, ls);
  api.saveSearchHistory('鬼吹灯');
  assert.equal(ls.store.get(HISTORY_KEY), JSON.stringify(['旧词']), '隐私开启期间不得触碰历史存储');
});

test('隐私 OFF 时 saveSearchHistory 保持原行为：去重置顶', () => {
  const ls = makeLocalStorage(JSON.stringify(['A', 'B']));
  const api = runHistorySandbox(false, ls);
  api.saveSearchHistory('A');
  assert.deepEqual(JSON.parse(ls.store.get(HISTORY_KEY)), ['A', 'B']);
  api.saveSearchHistory('C');
  assert.deepEqual(JSON.parse(ls.store.get(HISTORY_KEY)), ['C', 'A', 'B']);
});

test('SFV_SCRIPTS 必须装载 video/search-privacy.js 且早于 online-shared.js', () => {
  const scripts = indexHtml.slice(indexHtml.indexOf('SFV_SCRIPTS'));
  const privacyIdx = scripts.indexOf('video/search-privacy.js');
  const sharedIdx = scripts.indexOf('video/online-shared.js');
  assert.ok(privacyIdx >= 0, 'video/search-privacy.js 必须列入 SFV_SCRIPTS');
  assert.ok(sharedIdx >= 0);
  assert.ok(privacyIdx < sharedIdx, 'search-privacy 必须先于 online-shared 加载');
});

test('排除筛选面板提供「不记录搜索历史」开关并经 onApply 回传', () => {
  assert.match(filterSource, /switchRow\('不记录搜索历史',\s*'privacy'/);
  assert.match(filterSource, /else if \(key === 'privacy'\) \{\s*flags\.noSearchHistory = on;/);
  assert.match(filterSource, /noSearchHistory: flags\.noSearchHistory/);
  assert.match(filterSource, /initialNoSearchHistory/);
});

test('openFilterPanel 注入当前隐私值并在应用时持久化', () => {
  assert.match(sharedSource, /initialNoSearchHistory:\s*SFV\.searchPrivacy\.isNoSearchHistory\(\)/);
  assert.match(sharedSource, /SFV\.searchPrivacy\.setNoSearchHistory\(!!res\.noSearchHistory\)/);
});
