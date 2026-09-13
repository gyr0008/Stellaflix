/*
 * 校验 public/vendor/hls.min.js 与 flv.min.js 完整性
 * 运行：node tests/verify-vendor-libs.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function check(p) {
  const full = path.join(ROOT, p);
  if (!fs.existsSync(full)) { console.log(p, '=> 缺失'); return null; }
  return { p: p, size: fs.statSync(full).size, code: fs.readFileSync(full, 'utf8') };
}

const hls = check('public/vendor/hls.min.js');
const flv = check('public/vendor/flv.min.js');

console.log('=== vendor 播放器库校验 ===');
if (hls) {
  console.log('hls.min.js 大小:', hls.size);
  console.log('  含 1.7.1 版本串:', hls.code.indexOf('1.7.1') >= 0);
  console.log('  含 DefaultConfig:', hls.code.indexOf('DefaultConfig') >= 0);
  console.log('  含 isSupported:', hls.code.indexOf('isSupported') >= 0);
  console.log('  含 ErrorTypes:', hls.code.indexOf('ErrorTypes') >= 0);
  console.log('  含 Worker:', hls.code.indexOf('Worker') >= 0);
  console.log('  含 MEDIA_ATTACHED:', hls.code.indexOf('MEDIA_ATTACHED') >= 0 || hls.code.indexOf('mediaAttached') >= 0);
}
if (flv) {
  console.log('flv.min.js 大小:', flv.size);
  console.log('  含 isSupported:', flv.code.indexOf('isSupported') >= 0);
  console.log('  含 createPlayer:', flv.code.indexOf('createPlayer') >= 0);
  console.log('  含 Events:', flv.code.indexOf('Events') >= 0);
}

// 用 vm 实际执行两个库，确认它们是合法的 UMD 并可挂载到 global
const vm = require('vm');
function tryEval(label, code, globalName) {
  const sandbox = {
    window: undefined,
    self: undefined,
    document: undefined,
    navigator: { userAgent: 'node' },
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    XMLHttpRequest: function () {},
    MediaSource: undefined,
    TextDecoder: TextDecoder,
    performance: { now: () => Date.now() },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  try {
    vm.runInNewContext(code, sandbox, { filename: label + '.js', timeout: 10000 });
    const g = sandbox[globalName];
    console.log(label, '=> 执行成功, global.' + globalName + ' 存在:', !!g);
    if (g) {
      console.log('   isSupported 为函数:', typeof g.isSupported === 'function');
      if (typeof g.isSupported === 'function') {
        try { console.log('   isSupported() =', g.isSupported()); } catch (e) { console.log('   isSupported() 抛错:', e.message); }
      }
    }
    return !!g;
  } catch (e) {
    console.log(label, '=> 执行失败:', e.message);
    return false;
  }
}

console.log('');
console.log('=== 库可执行性校验（vm 沙箱，无 DOM/MSE，isSupported 预期为 false）===');
if (hls) tryEval('hls.min.js', hls.code, 'Hls');
if (flv) tryEval('flv.min.js', flv.code, 'flvjs');
