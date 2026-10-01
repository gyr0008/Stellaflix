'use strict';
/** 运行：node --test tests/huilian-queue.test.js */
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');

function load() {
  const sandbox = { window: {}, URL: require('url').URL };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('public/video/huilian-queue.js', 'utf8'), sandbox, { filename: 'huilian-queue.js' });
  return sandbox.window.StellaflixVideo.huilianQueue;
}

test('makeAddParams: magnet 串走 url', () => {
  const q = load();
  const m = 'magnet:?xt=urn:btih:abc123';
  assert.deepStrictEqual(q.makeAddParams(m, null), { url: m });
});
test('makeAddParams: base64 文件走 torrentBase64+fileName', () => {
  const q = load();
  assert.deepStrictEqual(q.makeAddParams('', { base64: 'QUJD', name: 'a.torrent' }),
    { torrentBase64: 'QUJD', fileName: 'a.torrent' });
});
test('makeAddParams: 非 magnet 文本 → null', () => {
  const q = load();
  assert.strictEqual(q.makeAddParams('http://nope', null), null);
});
test('matchHash: 按 magnet url 认领', () => {
  const q = load();
  const ts = [{ hash: 'h1', url: 'magnet:?xt=urn:btih:abc123' }, { hash: 'h2', url: 'x' }];
  assert.strictEqual(q.matchHash(ts, 'magnet:?xt=urn:btih:abc123'), 'h1');
  assert.strictEqual(q.matchHash(ts, 'magnet:?xt=urn:btih:zzz'), null);
});
test('isPlayable: progress 阈值 5%（0~1 制）', () => {
  const q = load();
  assert.strictEqual(q.isPlayable({ progress: 0.049, size: 10 }), false);
  assert.strictEqual(q.isPlayable({ progress: 0.05, size: 10 }), true);
  assert.strictEqual(q.isPlayable({ progress: 0.9, size: 0 }), false);
});
test('reduceTasks: 视图模型字段与百分比', () => {
  const q = load();
  const rows = q.reduceTasks([{ hash: 'h1', name: '片A', state: 'downloading', progress: 0.5, dlspeed: 1024, upspeed: 0, size: 2048, downloaded: 1024 }]);
  assert.deepStrictEqual(rows, [{ hash: 'h1', name: '片A', state: 'downloading', progress: 0.5, pct: 50, dlspeed: 1024, upspeed: 0 }]);
});
