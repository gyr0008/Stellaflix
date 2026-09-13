/*
 * 回归验证脚本：影视态播放器卡死 + 电影时长异常问题的修复验证
 *
 * 背景：
 *   1) public/vendor/hls.min.js 与 flv.min.js 原本缺失，但 source-adapter 会动态加载它们，
 *      导致 HLS/FLV 片源降级到原生 <video> 而无法播放（黑屏/卡死）。
 *   2) 电影源默认播放 episodes[0]，而 CMS 常返回「预告片#正片」，导致总时长只有几分钟。
 *
 * 运行：node tests/verify-video-player-issues.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/jsdom');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function fileExists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }
function read(p) { return fs.readFileSync(p, 'utf8'); }
function runInContext(code, ctx) { vm.runInNewContext(code, ctx, { filename: 'inline.js' }); }

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}

// ============================================================
// 1. vendor 播放器库存在性
// ============================================================
console.log('\n=== 1. vendor 播放器库存在性 ===');
const hlsPath = path.join(PUBLIC, 'vendor', 'hls.min.js');
const flvPath = path.join(PUBLIC, 'vendor', 'flv.min.js');
console.log('  hls.min.js:', hlsPath, '存在:', fileExists(hlsPath));
console.log('  flv.min.js:', flvPath, '存在:', fileExists(flvPath));
assert('public/vendor/hls.min.js 已就位', fileExists(hlsPath));
assert('public/vendor/flv.min.js 已就位', fileExists(flvPath));

// 静态服务路由：server.js 把 /xxx 映射到 public/xxx
assert('server.js 静态路由可映射到 public/vendor（public + pn 拼接）',
  read(path.join(ROOT, 'server.js')).indexOf("path.join(__dirname, 'public', filePath)") >= 0);

// ============================================================
// 2. source-adapter-core: HLS 识别
// ============================================================
console.log('\n=== 2. source-adapter-core HLS 识别 ===');
const dom1 = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost:3000/' });
const ctx1 = { window: dom1.window, document: dom1.window.document, localStorage: dom1.window.localStorage, console, URL: dom1.window.URL };
runInContext(read(path.join(PUBLIC, 'video', 'source-adapter-core.js')), ctx1);
const SAC = ctx1.window.StellaflixVideo.sourceAdapterCore;
const r = SAC.resolve('https://cdn.example.com/movie/index.m3u8?token=abc');
console.log('  resolve(m3u8) =>', JSON.stringify({ kind: r.kind, requiresHlsLib: r.requiresHlsLib, ok: r.ok }));
assert('m3u8 被识别为 HLS 且需要 hls.js', r.kind === 'hls' && r.requiresHlsLib === true);

// ============================================================
// 3. 电影默认起播集：跳过预告片
// ============================================================
console.log('\n=== 3. 电影默认起播集选择（pickMainEpisode）===');
const dom2 = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost:3000/' });
const ctx2 = { window: dom2.window, document: dom2.window.document, localStorage: dom2.window.localStorage, console, URL: dom2.window.URL };
runInContext(read(path.join(PUBLIC, 'video', 'sources-core.js')), ctx2);
const SRC = ctx2.window.StellaflixVideo.sources;

const plays = SRC.parsePlayUrl('ckm3u8',
  '预告片$https://cdn.example.com/yourname_trailer.mp4#HD中字$https://cdn.example.com/yourname_hd.mp4');
console.log('  parsePlayUrl 解析出集：', plays[0].episodes.map(function (e) { return e.name; }).join(' / '));
const picked = SRC.pickMainEpisode(plays[0].episodes);
console.log('  pickMainEpisode 选中：', picked && picked.name, '=>', picked && picked.url);
assert('不再选中第一集（预告片）', !!picked && picked.name !== '预告片');
assert('选中正片 HD中字', !!picked && picked.name === 'HD中字');

// detail-source.js 已改为经 pickEpisode 选集
const dsCode = read(path.join(PUBLIC, 'video', 'detail-source.js'));
assert('detail-source.js 定义了 pickEpisode 辅助函数', dsCode.indexOf('function pickEpisode(episodes)') >= 0);
assert('detail-source.js 的 CMS 分支改用 pickEpisode', dsCode.indexOf('var mainEp = pickEpisode(play0.episodes);') >= 0);
assert('detail-source.js 的 Kazumi 分支改用 pickEpisode', dsCode.indexOf('var ep0 = pickEpisode(episodes);') >= 0);
assert('detail-source.js 的回退分支改用 pickEpisode', dsCode.indexOf('var mainEp2 = pickEpisode(play.episodes);') >= 0);

// hall.js 同样改造，且修复了把 play 当单集传入的 bug
const hallCode = read(path.join(PUBLIC, 'video', 'hall.js'));
assert('hall.js 定义了 pickEpisode 辅助函数', hallCode.indexOf('function pickEpisode(episodes)') >= 0);
assert('hall.js CMS 分支不再把 play 对象当作单集传入',
  hallCode.indexOf('doPlay(view, res.plays[0], res.plays);') === -1);
assert('hall.js CMS 分支改为传单集 + 集列表',
  hallCode.indexOf('doPlay(view, mainEp, play0.episodes);') >= 0);

// ============================================================
// 4. hls.js 库可用性与 makeProxyLoader 兼容性
// ============================================================
console.log('\n=== 4. hls.js / flv.js 库可用性与代理 loader 兼容性 ===');
function evalLib(label, file, globalName) {
  const sandbox = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    navigator: { userAgent: 'node' }, TextDecoder: TextDecoder,
    performance: { now: () => Date.now() },
    XMLHttpRequest: function () { this.open = function () {}; this.send = function () {}; },
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.runInNewContext(read(file), sandbox, { filename: label, timeout: 15000 });
  return sandbox[globalName];
}

const Hls = evalLib('hls.min.js', hlsPath, 'Hls');
assert('hls.min.js 可执行并挂载全局 Hls', !!Hls);
assert('Hls.isSupported 是函数', !!Hls && typeof Hls.isSupported === 'function');
assert('Hls.DefaultConfig.loader 存在（makeProxyLoader 依赖）',
  !!(Hls && Hls.DefaultConfig && Hls.DefaultConfig.loader));

const flvjs = evalLib('flv.min.js', flvPath, 'flvjs');
assert('flv.min.js 可执行并挂载全局 flvjs', !!flvjs);
assert('flvjs.isSupported 是函数', !!flvjs && typeof flvjs.isSupported === 'function');

// makeProxyLoader 复刻（与 source-adapter-hls.js 一致），验证与 hls.js 1.7.1 兼容
if (Hls && Hls.DefaultConfig && Hls.DefaultConfig.loader) {
  let constructed = false, err = null;
  try {
    const Base = Hls.DefaultConfig.loader;
    function ProxyLoader(config) { Base.call(this, config); this._sfvBase = Base; }
    if (Base.prototype) {
      ProxyLoader.prototype = Object.create(Base.prototype);
      ProxyLoader.prototype.constructor = ProxyLoader;
    }
    ProxyLoader.prototype.load = function (context, config, callbacks) {
      context.url = '/api/proxy?url=' + encodeURIComponent(context.url);
      this._sfvBase.prototype.load.call(this, context, config, callbacks);
    };
    const inst = new ProxyLoader({});
    constructed = typeof inst.load === 'function';
  } catch (e) { err = e; }
  assert('makeProxyLoader 可构造（hls.js 1.7.1 的 loader 非 ES class，Base.call 可用）',
    constructed, err ? '错误: ' + err.message : '');
}

console.log('\n=== 结果：PASS=' + pass + '  FAIL=' + fail + ' ===');
if (fail > 0) process.exitCode = 1;
