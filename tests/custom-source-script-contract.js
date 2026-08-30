// 契约验证：内置音源脚本 bundled/qing_haitang_resolve.js
//
// 在 vm 沙箱中真实执行脚本（不联网），校验：
//   1. inited 时声明的线路集合与音质档位，是否与 QingMusic 官方公开配置一致
//   2. musicUrl 请求构造的 body（source / rid / level）是否正确
//   3. kw 线路在目标音质 hires 时是否降级为 flac（官方 kw 不支持 hires）
//
// 官方权威配置：https://13413.kstore.vip/QingMusic/music.json

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { selectLxQuality } = require('../desktop/custom-source/protocol');

const SCRIPT = path.join(__dirname, '..', 'desktop', 'custom-source', 'bundled', 'qing_haitang_resolve.js');

// 官方 music.json 中，洛雪四档能表达的 levels（2026-08-29 抓取）
const OFFICIAL_SUPPORTED = {
  kw: ['128k', '320k', 'flac'],
  kg: ['128k', '320k', 'flac', 'flac24bit'],
  wy: ['128k', '320k', 'flac', 'flac24bit'],
  tx: ['128k', '320k', 'flac'],
  mg: ['128k'],
};

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('  PASS  ' + label + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; console.log('  FAIL  ' + label + (detail ? '  (' + detail + ')' : '')); }
}

// 用 vm 沙箱加载真实脚本，捕获 inited 声明与请求回调
function loadScript() {
  const code = fs.readFileSync(SCRIPT, 'utf8');
  let inited = null;
  let handler = null;
  const calls = [];
  const lx = {
    EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
    request(url, options, callback) {
      calls.push({ url, options });
      callback(null, { statusCode: 200 }, { code: 0, data: { url: 'https://cdn.example.invalid/track.m4a' } });
      return () => {};
    },
    on(eventName, fn) { if (eventName === 'request') handler = fn; return Promise.resolve(); },
    send(eventName, data) { if (eventName === 'inited') inited = data; return Promise.resolve(); },
    env: 'desktop',
    version: '2.0.0',
  };
  const sandbox = { lx, JSON, Promise, Error, String, Number, Object, Array, console, URL, setTimeout };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { inited, handler, calls };
}

const { inited, handler, calls } = loadScript();

console.log('=== 1. 脚本初始化 ===');
check('已发送 inited', !!inited);
const sources = (inited && inited.sources) || {};
const declared = Object.keys(sources).sort();
check('线路集合 = kw/kg/tx/wy/mg', JSON.stringify(declared) === JSON.stringify(['kg', 'kw', 'mg', 'tx', 'wy']), declared.join(','));

console.log('\n=== 2. 音质档位对齐官方配置 ===');
for (const line of Object.keys(OFFICIAL_SUPPORTED)) {
  const actual = (sources[line] && sources[line].qualitys) || [];
  const expected = OFFICIAL_SUPPORTED[line];
  check(line + ' 档位 = ' + expected.join('/'),
    JSON.stringify(actual) === JSON.stringify(expected),
    '实际 ' + (actual.join('/') || '(空)'));
}

console.log('\n=== 3. kw 线路不得声明 flac24bit（官方 kw 无 hires）===');
const kwQualitys = (sources.kw && sources.kw.qualitys) || [];
check('kw 不含 flac24bit', !kwQualitys.includes('flac24bit'), kwQualitys.join('/'));

console.log('\n=== 4. 目标音质到实际档位的降级 ===');
const downgrade = [
  ['kw', 'hires', 'flac', 'kw 请求 hires 应降级为 flac'],
  ['kw', 'flac24bit', 'flac', 'kw 请求 flac24bit 应降级为 flac'],
  ['kw', 'flac', 'flac', 'kw 请求 flac 保持 flac'],
  ['kg', 'hires', 'flac24bit', 'kg 支持 hires，保持 flac24bit'],
  ['wy', 'hires', 'flac24bit', 'wy 支持 hires，保持 flac24bit'],
  ['tx', 'hires', 'flac', 'tx 上限无损，降级为 flac'],
  ['mg', 'hires', '128k', 'mg 仅标准，降级为 128k'],
];
for (const [line, target, expect, label] of downgrade) {
  const actual = selectLxQuality(target, (sources[line] && sources[line].qualitys) || []);
  check(label, actual === expect, 'selectLxQuality(' + target + ') = ' + actual);
}

console.log('\n=== 5. musicUrl 请求体契约 ===');
(async () => {
  for (const [line, quality, expectLevel, expectRid] of [
    ['kw', 'flac', 'lossless', '98765432'],
    ['kg', 'flac24bit', 'hires', 'a1b2c3d4e5f6'],
    ['tx', 'flac', 'lossless', '004Z8Ihr0JIu5s'],
    ['mg', '128k', 'standard', '77889900'],
  ]) {
    const before = calls.length;
    const url = await handler({
      action: 'musicUrl',
      source: line,
      info: { type: quality, musicInfo: { source: line, hash: expectRid, songmid: expectRid, name: 't', singer: 's' } },
    });
    const call = calls[calls.length - 1];
    const body = call && call.options && typeof call.options.body === 'string' ? JSON.parse(call.options.body) : null;
    check(line + ' @ ' + quality + ' → level=' + expectLevel,
      !!body && body.level === expectLevel && body.source === line && String(body.rid) === expectRid,
      body ? JSON.stringify(body) : '无请求体');
    check(line + ' 返回 URL', typeof url === 'string' && /^https:/.test(String(url)), url);
    if (calls.length === before) failed += 1;
  }

  console.log('\n=== 6. rid 为空时应明确报错 ===');
  let threw = false;
  let message = '';
  try {
    await handler({ action: 'musicUrl', source: 'tx', info: { type: 'flac', musicInfo: { source: 'tx', name: 'x', singer: 'y' } } });
  } catch (e) {
    threw = true;
    message = String(e && e.message || e);
  }
  check('空 rid 抛出 rid should not be empty', threw && /rid should not be empty/.test(message), message);

  console.log('\n----------------------------------------');
  console.log('PASS ' + passed + ' / FAIL ' + failed);
  if (failed > 0) process.exit(1);
  console.log('全部通过');
})();
