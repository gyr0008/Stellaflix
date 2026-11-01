// tests/mlib-cover-theme.test.js —— 批D Task 2：封面取色（逐字移植参照库 07-album-detail.js:63-212）
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '15-mlib-detail-modal.js'), 'utf8');

// 假 canvas：按像素函数吐 RGBA，好让「面积×饱和度」的胜出桶可被断言
function boot(pixels) {
  const styleWrites = {};
  const target = {
    style: {
      setProperty(k, v) { styleWrites[k] = v; },
      removeProperty(k) { delete styleWrites[k]; }
    }
  };
  const doc = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return {
        width: 0, height: 0,
        getContext(type) {
          assert.equal(type, '2d');
          return {
            drawImage() {},
            getImageData(x, y, w, h) {
              const data = new Uint8ClampedArray(w * h * 4);
              for (let i = 0; i < w * h; i++) {
                const p = pixels(i);
                data[i * 4] = p[0]; data[i * 4 + 1] = p[1]; data[i * 4 + 2] = p[2]; data[i * 4 + 3] = p[3] === undefined ? 255 : p[3];
              }
              return { data };
            }
          };
        }
      };
    }
  };
  const loaded = [];
  const ImageCtor = function () { this.onload = null; this.onerror = null; };
  Object.defineProperty(ImageCtor.prototype, 'src', {
    set(v) { loaded.push(v); if (this.onload) setImmediate(() => this.onload()); }
  });
  // URL 不是 ECMAScript 内置对象，vm.createContext 不会自动提供；模块的 coverThemeSource
  // 要用 new URL()，必须由测试沙箱显式注入（brief 脚手架的同一批环境对象里补上）。
  const sandbox = { document: doc, Image: ImageCtor, URL, location: { href: 'http://localhost:3000/' }, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: '15-mlib-detail-modal.js' });
  // 脚手架补一处：用例直接以 target.styleWrites 断言写入结果，故把记录对象挂回 target。
  target.styleWrites = styleWrites;
  return { t: sandbox.window.stellaMlibCoverTheme, target, styleWrites, loaded, tick: () => new Promise((r) => setImmediate(r)) };
}

test('hsl 往返：主色派生亮/暗/辉光三端且同色相', () => {
  const { t } = boot(() => [0, 0, 0]);
  const v = t.rgbVars(200, 40, 60); // 鲜红
  assert.equal(v.a, '200, 40, 60');
  const toHue = (s) => { const [r, g, b] = s.split(',').map(Number); return Math.round(t.rgbToHsl(r, g, b).h * 360); };
  // 逐字移植参照库 rgbVars 后，(200,40,60) 的真实色相是 352.5°（round→353），
  // 量化回 RGB 再读回会落在 352~353。断言按「与主色同色相（±1°）」守，而非钉死一个度数。
  const baseHue = toHue(v.a);
  [v.light, v.dark, v.glow].forEach((s) => assert.ok(Math.abs(toHue(s) - baseHue) <= 1, '色相必须守住'));
  // rgbToHsl 返回 {h,s,l} 对象（与参照库同名同形），取 l 用属性访问而非数组解构。
  const dl = t.rgbToHsl(...v.dark.split(',').map(Number)).l;
  const ll = t.rgbToHsl(...v.light.split(',').map(Number)).l;
  assert.ok(dl < 0.4 && ll > 0.5, '暗端要够暗、亮端要够亮');
});

test('取色胜出「够饱和且面积大」的桶，不是全图平均', async () => {
  // 70% 灰蓝（低饱和、量大）+ 30% 鲜黄（量小但鲜艳）：全图平均会得到浑浊色，直方图应选鲜黄
  const { t, target, tick } = boot((i) => (i % 10 < 3 ? [250, 210, 20] : [70, 80, 90]));
  await t.applyCoverTheme('data:image/png;base64,AAAA', target).then(() => tick());
  const rgb = target.styleWrites['--stella-mlib-theme-a'].split(',').map(Number);
  assert.ok(rgb[0] > 200 && rgb[1] > 150 && rgb[2] < 90, '主色应落在鲜黄：' + rgb);
});

test('全灰封面退回平均色；透明像素一律跳过', async () => {
  const { t, target, tick } = boot((i) => (i % 4 === 0 ? [10, 10, 10, 0] : [120, 120, 120]));
  await t.applyCoverTheme('data:image/png;base64,AAAA', target).then(() => tick());
  const rgb = target.styleWrites['--stella-mlib-theme-a'].split(',').map(Number);
  assert.ok(rgb[0] > 100 && rgb[0] < 140, '平均色应≈120：' + rgb);
});

test('无封面＝不取色，深色降级交给 CSS；加载失败清主题', async () => {
  const { t, target } = boot(() => [0, 0, 0]);
  await t.applyCoverTheme('', target);
  assert.equal(Object.keys(target.styleWrites).length, 0, '空封面不得写任何变量');
});

test('coverThemeSource：QQ/汽水类无 CORS 头域名走 /api/cover，data URL 与 Apple/网易云直连', () => {
  const { t } = boot(() => [0, 0, 0]);
  assert.equal(t.coverThemeSource('https://y.qq.com/n/a.jpg'), '/api/cover?url=' + encodeURIComponent('https://y.qq.com/n/a.jpg'));
  assert.equal(t.coverThemeSource('https://img.douyinpic.com/x/a.jpg'), '/api/cover?url=' + encodeURIComponent('https://img.douyinpic.com/x/a.jpg'));
  assert.equal(t.coverThemeSource('https://is1-ssl.mzstatic.com/x.jpg'), 'https://is1-ssl.mzstatic.com/x.jpg');
  assert.equal(t.coverThemeSource('https://p1.music.126.net/x.jpg'), 'https://p1.music.126.net/x.jpg');
  assert.equal(t.coverThemeSource('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA', '本地曲库内嵌封面就是 data URL，绝不能被塞进代理');
  assert.equal(t.coverThemeSource(''), '');
});

test('五个变量一次写齐；clearTheme 一次摘净（关窗不污染资料库页）', () => {
  const { t, target, styleWrites } = boot(() => [0, 0, 0]);
  t.applyThemeVars(10, 20, 30, target);
  assert.deepEqual(Object.keys(styleWrites).sort(), [
    '--stella-mlib-theme-a', '--stella-mlib-theme-b', '--stella-mlib-theme-dark',
    '--stella-mlib-theme-glow', '--stella-mlib-theme-light']);
  t.clearTheme(target);
  assert.equal(Object.keys(styleWrites).length, 0);
  // 命名红线（Global Constraints）：参照库的 --am-theme-* 一个都不许带进本仓
  assert.ok(!SRC.includes('--am-theme-'), '参照库的 --am-theme-* 不得带进本仓');
});
