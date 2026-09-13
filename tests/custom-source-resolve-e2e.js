// 端到端验证：custom-only（仅自定义）模式能否解析出可播放 URL
//
// 走完整真实链路（仅末段 HTTP 用桩）：
//   原生 song → 前端 songToLxMusicInfo（从源码提取）→ main.js 的 resolveFallback 入参
//   → CustomSourceManager.resolveFallback → toLxMusicInfo → 候选线路 → 内置音源脚本请求体
//
// 不联网：runtime.request 与 validateResolvedUrl 均用桩替换。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { CustomSourceManager } = require('../desktop/custom-source/manager');
const { filterInitPayload } = require('../desktop/custom-source/protocol');

const FRONTEND_FILE = path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '14-custom-source-integration.js');
const SCRIPT_FILE = path.join(__dirname, '..', 'desktop', 'custom-source', 'bundled', 'qing_music.js');

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('  PASS  ' + label + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; console.log('  FAIL  ' + label + (detail ? '  (' + detail + ')' : '')); }
}

// 从前端源码提取 songToLxMusicInfo 的真实实现
function loadFrontendSongToLxMusicInfo() {
  const src = fs.readFileSync(FRONTEND_FILE, 'utf8');
  const start = src.indexOf('function songToLxMusicInfo');
  const end = src.indexOf('\n  }\n', start);
  const body = src.slice(start, end + 4);
  const factory = new Function('normalizePlaybackQuality', body + '\nreturn songToLxMusicInfo;');
  return factory(q => String(q || 'hires'));
}

// 在沙箱中执行内置音源脚本，拿到它 inited 时声明的 sources，并接管它的 HTTP 层
function loadBundledScript() {
  const code = fs.readFileSync(SCRIPT_FILE, 'utf8');
  let inited = null;
  let handler = null;
  const outbound = [];
  const lx = {
    EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
    request(url, options, callback) {
      outbound.push({ url, options });
      callback(null, { statusCode: 200 }, { code: 0, data: { url: 'https://cdn.example.invalid/track.m4a' } });
      return () => {};
    },
    on(name, fn) { if (name === 'request') handler = fn; return Promise.resolve(); },
    send(name, data) { if (name === 'inited') inited = data; return Promise.resolve(); },
    env: 'desktop',
    version: '2.0.0',
  };
  const sandbox = { lx, JSON, Promise, Error, String, Number, Object, Array, console, URL, setTimeout };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { inited, handler, outbound };
}

const songToLxMusicInfo = loadFrontendSongToLxMusicInfo();
const bundled = loadBundledScript();
const declaredSources = filterInitPayload(bundled.inited).sources;

// 用真实脚本的 handler 充当 runtime.request
function buildManager() {
  const store = {
    getActive: () => ({ id: 'bundled:qing_music.js', name: '青听音乐' }),
    get: id => ({ id }),
    getScript: () => fs.readFileSync(SCRIPT_FILE, 'utf8'),
    list: () => [],
    setActive: () => {},
    setStatus: () => {},
    remove: () => [],
    importScript: () => ({}),
    replaceScript: () => ({}),
    setAllowUpdateAlert: () => {},
  };
  const manager = new CustomSourceManager({
    store,
    runtimeFactory: () => ({
      start: async () => ({ sources: filterInitPayload(bundled.inited).sources }),
      stop: async () => {},
      request: async ({ source, action, info }) => {
        if (action !== 'musicUrl') throw new Error('action not support');
        return bundled.handler({ action, source, info });
      },
    }),
    validateResolvedUrl: async url => url,
  });
  return manager;
}

const SAMPLES = [
  { label: 'QQ 音乐', song: { id: '001Qu4I30eVFYb', songmid: '001Qu4I30eVFYb', mid: '001Qu4I30eVFYb', mediaMid: '004Z8Ihr0JIu5s', strMediaMid: '004Z8Ihr0JIu5s', name: '晴天', artist: '周杰伦', album: { name: '叶惠美' }, duration: 269, provider: 'qq' }, expectSource: 'tx' },
  { label: '网易云', song: { id: '186855', name: '起风了', artist: '买辣椒也用券', album: { name: '起风了' }, duration: 325, provider: 'netease' }, expectSource: 'wy' },
  { label: '酷狗', song: { hash: 'A1B2C3D4E5F6', id: '1234567', name: '海阔天空', artist: 'Beyond', albumAudioId: '998877', duration: 326, provider: 'kugou' }, expectSource: 'kg' },
  { label: '酷我', song: { rid: '98765432', name: '稻香', artist: '周杰伦', duration: 223, provider: 'kuwo' }, expectSource: 'kw' },
];

(async () => {
  console.log('=== 内置音源脚本声明的线路 ===');
  console.log('  ' + Object.keys(declaredSources).sort().join(', '));

  for (const mode of ['custom-only', 'custom-first']) {
    console.log('\n=== 模式 ' + mode + ' ===');
    const manager = buildManager();
    await manager.startActive();
    check('音源已激活', manager.getStatus().active === true, 'activeId=' + manager.getStatus().activeId);

    for (const sample of SAMPLES) {
      bundled.outbound.length = 0;
      // 前端转换后的 wire payload，正是 IPC 真正传输的对象
      const wire = songToLxMusicInfo(sample.song, 'hires');
      const result = await manager.resolveFallback({ song: wire, quality: 'hires', mode, officialResult: {} });

      const ok = !!(result && result.url);
      check(sample.label + ' 解析出 URL', ok,
        ok ? 'source=' + result.source + ' lxQuality=' + result.lxQuality + ' level=' + result.level
           : 'reason=' + result.reason + ' error=' + String(result.error || '').slice(0, 120));

      if (ok) {
        check(sample.label + ' 命中自身平台线路', result.source === sample.expectSource,
          '命中 ' + result.source + ' / 期望 ' + sample.expectSource);
        const body = bundled.outbound.length ? JSON.parse(bundled.outbound[0].options.body) : null;
        check(sample.label + ' 请求体 rid 非空', !!body && String(body.rid || '') !== '',
          body ? JSON.stringify(body) : '无请求体');
        check(sample.label + ' level 在官方声明内', !!body && ['standard', 'exhigh', 'lossless', 'hires'].includes(body.level),
          body ? body.level : '-');
      }
    }
  }

  console.log('\n=== 修复前行为对照（模拟旧 wire：平台 ID 只在 _raw）===');
  {
    const manager = buildManager();
    await manager.startActive();
    const legacyWire = { name: '晴天', singer: '周杰伦', album: '叶惠美', interval: 269, _raw: SAMPLES[0].song, quality: 'hires' };
    const result = await manager.resolveFallback({ song: legacyWire, quality: 'hires', mode: 'custom-only', officialResult: {} });
    check('旧 wire 经 _raw 解包后仍能解析（向后兼容兜底）', !!result.url,
      'source=' + result.source + ' url 存在=' + !!result.url);
  }

  console.log('\n----------------------------------------');
  console.log('PASS ' + passed + ' / FAIL ' + failed);
  if (failed > 0) process.exit(1);
  console.log('全部通过');
})().catch(e => {
  console.error('运行异常:', e);
  process.exit(1);
});
