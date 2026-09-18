'use strict';
// model.clearProgressByPrefix 行为测试。运行：node --test tests/model-progress-prefix.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modelPath = path.join(__dirname, '..', 'public', 'video', 'model.js');

function makeLocalStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _dump: () => JSON.parse(JSON.stringify(data)),
  };
}

function loadModel(initial) {
  const source = fs.readFileSync(modelPath, 'utf8');
  const localStorage = makeLocalStorage(initial);
  const window = { localStorage, addEventListener() {} };
  window.window = window;
  vm.runInNewContext(source, { window, localStorage, console }, { filename: modelPath });
  return { model: window.StellaflixVideo.model, localStorage };
}

const KP = 'stellaflix-video-progress';

test('clearProgressByPrefix 只删匹配前缀的进度并返回删除数', () => {
  const init = { [KP]: JSON.stringify({
    'cms:s1:100:0': { position: 10, duration: 100, updatedAt: 1 },
    'cms:s1:100:1': { position: 20, duration: 100, updatedAt: 1 },
    'cms:s2:200:0': { position: 30, duration: 100, updatedAt: 1 },
  }) };
  const { model, localStorage } = loadModel(init);
  const n = model.clearProgressByPrefix('cms:s1:100:');
  assert.strictEqual(n, 2);
  const left = JSON.parse(localStorage.getItem(KP));
  assert.deepStrictEqual(Object.keys(left), ['cms:s2:200:0']);
});

test('clearProgressByPrefix 空参数/无命中均安全返回 0', () => {
  const { model } = loadModel({ [KP]: JSON.stringify({ 'a:0': { position: 1 } }) });
  assert.strictEqual(model.clearProgressByPrefix(''), 0);
  assert.strictEqual(model.clearProgressByPrefix(null), 0);
  assert.strictEqual(model.clearProgressByPrefix('zzz:'), 0);
});

test('前缀不以冒号结尾时拒绝删除（自身契约守卫），返回 0 且进度全留', () => {
  const init = { [KP]: JSON.stringify({
    'cms:s1:100:0': { position: 10, duration: 100, updatedAt: 1 },
    'cms:s1:100:1': { position: 20, duration: 100, updatedAt: 1 },
  }) };
  const { model, localStorage } = loadModel(init);
  assert.strictEqual(model.clearProgressByPrefix('cms:s1:100'), 0);
  assert.strictEqual(model.clearProgressByPrefix('cms'), 0);
  assert.deepStrictEqual(Object.keys(JSON.parse(localStorage.getItem(KP))),
    ['cms:s1:100:0', 'cms:s1:100:1']);
});

test('kazumi 源含冒号的 key 按完整 seriesKey 前缀删除', () => {
  const init = { [KP]: JSON.stringify({
    'kazumi:abc:77:2': { position: 5 },
    'kazumi:abc:7:2': { position: 5 },
  }) };
  const { model, localStorage } = loadModel(init);
  assert.strictEqual(model.clearProgressByPrefix('kazumi:abc:77:'), 1);
  assert.deepStrictEqual(Object.keys(JSON.parse(localStorage.getItem(KP))), ['kazumi:abc:7:2']);
});
