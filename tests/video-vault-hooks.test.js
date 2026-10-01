'use strict';
// 挂钩点测试：model.writeJSON / watch-history.writeAll 触发 vault.mirror。
// 运行：node --test tests/video-vault-hooks.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeLocalStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

function loadModel(ls, vaultStub) {
  const g = {
    localStorage: ls, console: { warn() {} },
    setTimeout, clearTimeout,
    document: { addEventListener() {}, querySelector() { return null; } },
  };
  g.window = g;
  if (vaultStub) g.StellaflixVideo = { vault: vaultStub };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'video', 'model.js'), 'utf8'), g);
  return g.StellaflixVideo.model;
}

test('model 写库触发 vault.mirror', () => {
  let n = 0;
  const model = loadModel(makeLocalStorage(), { mirror() { n += 1; } });
  model.addToLibrary({ id: 'url:a', title: 'A' });
  assert.ok(n >= 1, 'writeJSON 应调用 SFV.vault.mirror()');
});

test('无 vault（浏览器直开）时 model 写入不报错', () => {
  const model = loadModel(makeLocalStorage(), null);
  assert.doesNotThrow(() => model.addToLibrary({ id: 'url:b', title: 'B' }));
});

test('SFV_SCRIPTS 加载顺序：data-vault 早于全部消费方（model/watch-history/hex-wall）', () => {
  // vault 必须在消费方之前初始化，否则首屏读取拿不到回填数据（终审 T3-M3 回归守卫）
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const marker = html.indexOf('SFV_SCRIPTS');
  assert.ok(marker >= 0, 'public/index.html 必须存在 SFV_SCRIPTS 数组');
  const scripts = html.slice(marker);
  const idxOf = (needle, label) => {
    const i = scripts.indexOf(needle);
    assert.ok(i >= 0, `SFV_SCRIPTS 缺少条目 ${label}（${needle}）`);
    return i;
  };
  const vaultIdx = idxOf('"video/data-vault.js"', 'data-vault');
  assert.ok(vaultIdx < idxOf('"video/model.js"', 'model'), 'data-vault 必须排在 model.js 之前');
  assert.ok(vaultIdx < idxOf('"video/watch-history.js"', 'watch-history'), 'data-vault 必须排在 watch-history.js 之前');
  // hex-wall 实际登记为 video/poster-wall/hex-wall.js，按文件名匹配兼容前缀变化
  const hexIdx = scripts.search(/"video\/[^"]*hex-wall\.js"/);
  assert.ok(hexIdx >= 0, 'SFV_SCRIPTS 缺少 hex-wall.js 条目');
  assert.ok(vaultIdx < hexIdx, 'data-vault 必须排在 hex-wall.js 之前');
  const pcIdx = scripts.indexOf('"video/poster-cache.js"');
  if (pcIdx >= 0) assert.ok(vaultIdx > pcIdx, 'data-vault 应排在 poster-cache.js 之后');
});
