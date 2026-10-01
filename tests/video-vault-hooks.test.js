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
