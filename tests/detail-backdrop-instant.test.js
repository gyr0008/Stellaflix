// 详情页大背景图"先显示、失败回退"helper 测试（detail-core.applyBackdropSafe）：
// 旧实现等整张 w1280 backdrop 经代理完全下载（0.2~1.3s）才替换背景；
// 新实现立即应用（浏览器渐进渲染提前首屏），仅加载失败时回退原背景。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadDetailCore() {
  const sandbox = {
    console, Promise, Date, Array, Object, String, Number, Boolean, Error, RegExp, Math, JSON,
    setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  // 可控 Image 桩：赋值 src 不自动触发 onload，测试手动调 onload/onerror
  const probes = [];
  sandbox.Image = function Image() {
    const self = this;
    let _src = '';
    Object.defineProperty(this, 'src', {
      get() { return _src; },
      set(v) { _src = v; probes.push(self); },
    });
  };
  sandbox.__probes = probes;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(root, 'public/video/detail-core.js'), 'utf8'),
    sandbox, { filename: 'detail-core.js' }
  );
  return sandbox;
}

const NEW_URL = '/api/proxy?url=' + encodeURIComponent('https://image.tmdb.org/t/p/w1280/bd.jpg');

test('applyBackdropSafe：调用即刻应用新背景，不等加载完成', () => {
  const sandbox = loadDetailCore();
  const bg = { style: { backgroundImage: 'url("old-poster.jpg")' } };
  sandbox.StellaflixVideo.detail.applyBackdropSafe(bg, NEW_URL);
  assert.match(bg.style.backgroundImage, /w1280/, '未等 onload 就应已应用 backdrop');
});

test('applyBackdropSafe：加载失败回退原背景', () => {
  const sandbox = loadDetailCore();
  const bg = { style: { backgroundImage: 'url("old-poster.jpg")' } };
  sandbox.StellaflixVideo.detail.applyBackdropSafe(bg, NEW_URL);
  assert.equal(sandbox.__probes.length, 1, '应发起一次探测加载');
  assert.equal(sandbox.__probes[0].src, NEW_URL);
  sandbox.__probes[0].onerror();
  assert.equal(bg.style.backgroundImage, 'url("old-poster.jpg")', 'onerror 应回退原背景');
});

test('applyBackdropSafe：加载成功保持新背景；空参数不动作', () => {
  const sandbox = loadDetailCore();
  const bg = { style: { backgroundImage: 'url("old-poster.jpg")' } };
  sandbox.StellaflixVideo.detail.applyBackdropSafe(bg, NEW_URL);
  if (typeof sandbox.__probes[0].onload === 'function') sandbox.__probes[0].onload();
  assert.match(bg.style.backgroundImage, /w1280/, '成功路径不得回退');

  const untouched = { style: { backgroundImage: 'url("keep.jpg")' } };
  sandbox.StellaflixVideo.detail.applyBackdropSafe(untouched, '');
  sandbox.StellaflixVideo.detail.applyBackdropSafe(null, NEW_URL);
  assert.equal(untouched.style.backgroundImage, 'url("keep.jpg")');
});
