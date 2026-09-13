/*
 * 校验 source-adapter-hls.js 的 makeProxyLoader 对 hls.js 1.7.1 的兼容性。
 * 关键问题：hls.js 的 DefaultConfig.loader 若为 ES class，则 `Base.call(this, config)`
 * 会抛 "Class constructor cannot be invoked without 'new'"，导致 HLS 全部播放失败。
 * 运行：node tests/verify-proxy-loader.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

const hlsCode = fs.readFileSync(path.join(ROOT, 'public/vendor/hls.min.js'), 'utf8');
const sandbox = {
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
  navigator: { userAgent: 'node' }, TextDecoder: TextDecoder,
  performance: { now: () => Date.now() },
  XMLHttpRequest: function () { this.open = function () {}; this.send = function () {}; },
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.runInNewContext(hlsCode, sandbox, { filename: 'hls.min.js', timeout: 10000 });

const Hls = sandbox.Hls;
console.log('=== makeProxyLoader 兼容性校验 ===');
console.log('Hls 存在:', !!Hls);
console.log('Hls.DefaultConfig 存在:', !!(Hls && Hls.DefaultConfig));
const Base = (Hls.DefaultConfig && Hls.DefaultConfig.loader) || null;
console.log('Hls.DefaultConfig.loader 存在:', !!Base);
if (Base) {
  const srcHead = String(Base).slice(0, 80);
  console.log('loader 源码开头:', srcHead);
  const isEsClass = /^class\s/.test(String(Base).trim());
  console.log('是否为 ES class:', isEsClass);
  console.log('prototype.load 存在:', !!(Base.prototype && Base.prototype.load));
  console.log('prototype.constructor === Base:', !!(Base.prototype && Base.prototype.constructor === Base));

  // 复刻 source-adapter-hls.js 的 makeProxyLoader
  function makeProxyLoader(HlsRef) {
    var B = (HlsRef.DefaultConfig && HlsRef.DefaultConfig.loader) || global.XMLHttpRequest;
    function ProxyLoader(config) {
      B.call(this, config);
      this._sfvBase = B;
    }
    if (B.prototype) {
      ProxyLoader.prototype = Object.create(B.prototype);
      ProxyLoader.prototype.constructor = ProxyLoader;
    }
    ProxyLoader.prototype.load = function (context, config, callbacks) {
      context.url = '/api/proxy?url=' + encodeURIComponent(context.url);
      this._sfvBase.prototype.load.call(this, context, config, callbacks);
    };
    return ProxyLoader;
  }

  let ok = false, err = null;
  try {
    const L = makeProxyLoader(Hls);
    const inst = new L({});
    console.log('new ProxyLoader({}) 构造成功:', !!inst);
    console.log('实例继承 load 方法:', typeof inst.load === 'function');
    ok = true;
  } catch (e) {
    err = e;
    console.log('构造失败:', e.message);
  }
  if (!ok) {
    console.error('FAIL: makeProxyLoader 与 hls.js 1.7.1 不兼容 ——', err && err.message);
  }
} else {
  console.error('FAIL: Hls.DefaultConfig.loader 不存在，makeProxyLoader 会回退到 XMLHttpRequest（错误基类）');
}
