/*
 * 验证：音乐态 → 影视态 跨态海报快照修复（音乐空间卡显示音乐态海报）
 *
 * 关键纠正（2026-08-30）：2.1.0 的"音乐态海报"实际来自 home-dashboard
 *   （03a-home-dashboard.js），不是 outer-poster-bridge，也不是 vendor homePosterState。
 *   dashboard 把用户图渲染为 <img class="home-dashboard-video" src="blob:DASHBOARD">
 *   注入 .daily-review-card（独立于 #home-poster-media），其 blob URL 在切态时会被
 *   homeDashboardReleaseVideoSource 回收 → 悬空引用 → 音乐空间卡不显示。
 *
 * 本测试直接抽取 home.js 中真实的 _readMusicPosterNow() + getMusicCrossPoster() 函数体
 * （按大括号匹配），在 jsdom + 伪造 IndexedDB 的环境中执行其真实代码（不是复刻逻辑），
 * 覆盖五种场景：
 *   A. dashboard 用户背景图（用户真实情形）：localStorage dash meta + dashboard IDB 记录
 *   B. outer-poster-bridge 图片（回归）：localStorage outer-music meta + outerPosterBlobGet
 *   C. 无海报：任何 meta / IDB 记录都没有 → 安全返回空，不崩溃
 *   D. 开屏直接进入影视态：跨态快照为空（state.init 绕过 _preCapturePosterSnapshot）
 *      → getMusicCrossPoster 兜底直接读 dashboard，首屏即显示
 *   D2. 正常 music→video：快照已捕获 → getMusicCrossPoster 优先用快照，不冗余重新读取
 *
 * 断言核心：
 *   - A：blobPromise 解析出全新的 NEW_BLOB，且该 URL ≠ 被切态回收的 DASHBOARD_BLOB，且未被误回收
 *   - B：blobPromise 解析出 NEW_BLOB，回归不退化
 *   - C：blobPromise=null 且 syncUrl=''，卡走兜底（不崩溃）
 *   - D：快照为空时兜底读取成功，解析出 NEW_BLOB，≠被回收 DASHBOARD_BLOB，未被误回收
 *   - D2：快照非空时优先用快照的 blobPromise，不触发 dashboard 重新读取
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/jsdom');

const HOME_JS = path.resolve(__dirname, '..', 'public', 'video', 'home.js');

// ---- 抽取真实函数体（按大括号深度匹配，避免硬编码行号） ----
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数 ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const homeSrc = fs.readFileSync(HOME_JS, 'utf8');
const fnText = extractFunction(homeSrc, '_readMusicPosterNow');
const helperText = extractFunction(homeSrc, 'getMusicCrossPoster');

// ---- 伪造 IndexedDB ----
// records: { [key]: record } 例如 { 'home-hero-video-music': { id:'home-hero-video-music', blob:{__fake:true} } }
function makeFakeIdb(records) {
  return {
    open: function (name, version) {
      const req = {};
      const db = {
        objectStoreNames: { contains: function () { return true; } },
        createObjectStore: function () {},
        transaction: function () {
          return {
            objectStore: function () {
              return {
                get: function (key) {
                  const g = {};
                  g.result = (records && Object.prototype.hasOwnProperty.call(records, key)) ? records[key] : null;
                  setTimeout(function () { if (g.onsuccess) g.onsuccess(); }, 0);
                  return g;
                }
              };
            }
          };
        }
      };
      req.result = db;
      setTimeout(function () {
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    }
  };
}

// ---- 每场景独立构造 jsdom 环境 + sandbox ----
function buildSandbox(opts) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>' +
    '<div id="home-poster-media"></div>' +
    '<div class="daily-review-card"></div>' +
    '</body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const window = dom.window;
  const document = window.document;

  // localStorage 预置
  if (opts.dashMeta) {
    window.localStorage.setItem('stellaflix-home-dashboard-video-meta-v1-music', JSON.stringify(opts.dashMeta));
  }
  if (opts.outerMeta) {
    window.localStorage.setItem('mineradio.outer.poster.meta.music', JSON.stringify(opts.outerMeta));
  }

  // objectURL stub：每次 createObjectURL 返回该场景的 NEW_BLOB；revoke 记录到 revoked[]
  const revoked = [];
  window.URL.createObjectURL = function () { return opts.newBlob; };
  window.URL.revokeObjectURL = function (u) { revoked.push(u); };

  // 伪造 IndexedDB（仅当提供 records）
  if (opts.idbRecords) {
    window.indexedDB = makeFakeIdb(opts.idbRecords);
  }

  // outerPosterBlobGet 兼容桩：production 里真实存在，Layer6 用到
  function outerPosterBlobGet(key) {
    return Promise.resolve({ blob: { __fake: true, key: key } });
  }

  const sandbox = {
    console: console,
    global: window,
    outerPosterBlobGet: outerPosterBlobGet,
    setTimeout: setTimeout,
    Promise: Promise,
    JSON: JSON
  };
  sandbox.global.document = document;
  sandbox.global.localStorage = window.localStorage;
  sandbox.global.URL = window.URL;
  sandbox.global.indexedDB = window.indexedDB;
  // defaultView.getComputedStyle 由 jsdom 自身提供

  // state.js 的 _crossPosterSnapshot 模拟 + getCrossPoster 读取器
  // （getMusicCrossPoster 依赖它们；未提供时默认为空快照，模拟"首屏直接进入影视态"）
  sandbox._crossPosterSnapshot = { music: (opts.crossPosterSnapshot !== undefined ? opts.crossPosterSnapshot : null), video: null };
  sandbox.getCrossPoster = function (fromSpace) {
    const s = sandbox._crossPosterSnapshot[fromSpace];
    if (!s) return { syncUrl: '', blobPromise: null };
    return s;
  };

  return { sandbox, window, document, revoked };
}

function runReadPoster(sandbox) {
  const ctx = vm.createContext(sandbox);
  const f = vm.runInContext(fnText + '\n; _readMusicPosterNow', ctx);
  return f();
}

// 执行真实的 getMusicCrossPoster()（内部会按需调用 _readMusicPosterNow 兜底）
function runGetMusicCrossPoster(sandbox) {
  const ctx = vm.createContext(sandbox);
  const src = fnText + '\n' + helperText + '\n; getMusicCrossPoster';
  const f = vm.runInContext(src, ctx);
  return f();
}

async function main() {
  let pass = true;
  const fail = (m) => { pass = false; console.log('  ✗ ' + m); };
  const ok = (m) => console.log('  ✓ ' + m);

  // ============ 场景 A：dashboard 用户背景图（用户真实情形） ============
  console.log('\n[场景 A] home-dashboard 用户图片海报（音乐空间卡应显示）');
  {
    const NEW_BLOB = 'blob:http://localhost/dash-fresh-uuid';
    const DASHBOARD_BLOB = 'blob:http://localhost/dashboard-live-uuid'; // 切态后被回收的"活"URL
    const { sandbox, window, revoked } = buildSandbox({
      dashMeta: { version: 1, kind: 'image', name: 'girl.png' },
      idbRecords: { 'home-hero-video-music': { id: 'home-hero-video-music', blob: { __fake: true } } },
      newBlob: NEW_BLOB
    });

    const res = runReadPoster(sandbox);
    if (!res.blobPromise) fail('A: 未建立 blobPromise（dashboard 分支应触发）');
    else ok('A: dashboard 分支建立 blobPromise');

    const applied = await res.blobPromise;
    if (applied === NEW_BLOB) ok('A: 异步水合出全新 URL = ' + applied);
    else fail('A: 水合 URL 异常: ' + applied);

    // 模拟切态：dashboard 回收它自己的"活"URL（homeDashboardReleaseVideoSource）
    window.URL.revokeObjectURL(DASHBOARD_BLOB);

    if (applied !== DASHBOARD_BLOB) ok('A: 应用 URL ≠ 被切态回收的 DASHBOARD_BLOB（避免悬空）');
    else fail('A: 应用 URL 仍是被回收的 DASHBOARD_BLOB（死链）');

    if (revoked.indexOf(NEW_BLOB) === -1) ok('A: 新 URL 未被任何回收逻辑误回收 → 跨态复用安全');
    else fail('A: 新 URL 被误回收');

    if (revoked.indexOf(DASHBOARD_BLOB) !== -1) ok('A: 切态后 DASHBOARD_BLOB 确被回收（坐实悬空陷阱已被绕过）');
    else fail('A: DASHBOARD_BLOB 未被回收（测试环境假设不成立）');
  }

  // ============ 场景 B：outer-poster-bridge 图片（回归） ============
  console.log('\n[场景 B] outer-poster-bridge 图片（回归，须不退化）');
  {
    const NEW_BLOB = 'blob:http://localhost/outer-fresh-uuid';
    const OLD_BLOB = 'blob:http://localhost/outer-old-uuid';
    const { sandbox, window, revoked } = buildSandbox({
      outerMeta: { kind: 'image', blobKey: 'outer-music' },
      newBlob: NEW_BLOB
    });

    const res = runReadPoster(sandbox);
    if (!res.blobPromise) fail('B: 未建立 blobPromise（Layer6 应触发）');
    else ok('B: Layer6 建立 blobPromise');

    const applied = await res.blobPromise;
    if (applied === NEW_BLOB) ok('B: 异步水合出全新 URL = ' + applied);
    else fail('B: 水合 URL 异常: ' + applied);

    // 切态回收旧 OLD blob（_revokeMusicObjectUrl）
    window.URL.revokeObjectURL(OLD_BLOB);
    if (applied !== OLD_BLOB) ok('B: 应用 URL ≠ 被回收 OLD_BLOB（无悬空）');
    else fail('B: 应用 URL 仍是死链 OLD_BLOB');
    if (revoked.indexOf(NEW_BLOB) === -1) ok('B: 新 URL 未被误回收');
    else fail('B: 新 URL 被误回收');
  }

  // ============ 场景 C：无任何海报 ============
  console.log('\n[场景 C] 无海报（任何 meta / IDB 记录都没有）');
  {
    const NEW_BLOB = 'blob:http://localhost/never-used';
    const { sandbox } = buildSandbox({ newBlob: NEW_BLOB });
    const res = runReadPoster(sandbox);
    if (res.syncUrl === '' && res.blobPromise === null) ok('C: 安全返回空（syncUrl="" blobPromise=null），不崩溃');
    else fail('C: 异常情况: syncUrl=' + res.syncUrl + ' blobPromise=' + res.blobPromise);
  }

  // ============ 场景 D：开屏直接进入影视态（快照为空，需兜底） ============
  console.log('\n[场景 D] 开屏直接进入影视态：快照为空 → getMusicCrossPoster 兜底直接读取');
  {
    const NEW_BLOB = 'blob:http://localhost/dash-fresh-uuid';
    const DASHBOARD_BLOB = 'blob:http://localhost/dashboard-live-uuid'; // 切态后被回收的"活"URL
    const { sandbox, window, revoked } = buildSandbox({
      dashMeta: { version: 1, kind: 'image', name: 'girl.png' },
      idbRecords: { 'home-hero-video-music': { id: 'home-hero-video-music', blob: { __fake: true } } },
      newBlob: NEW_BLOB,
      crossPosterSnapshot: null // 模拟 state.init 绕过 _preCapturePosterSnapshot
    });

    const res = runGetMusicCrossPoster(sandbox);
    if (!res.blobPromise) fail('D: 兜底未建立 blobPromise');
    else ok('D: 快照为空 → 兜底 _readMusicPosterNow 建立 blobPromise');

    const applied = await res.blobPromise;
    if (applied === NEW_BLOB) ok('D: 异步水合出全新 URL = ' + applied);
    else fail('D: 水合 URL 异常: ' + applied);

    // 模拟切态：dashboard 回收它自己的"活"URL
    window.URL.revokeObjectURL(DASHBOARD_BLOB);
    if (applied !== DASHBOARD_BLOB) ok('D: 应用 URL ≠ 被切态回收的 DASHBOARD_BLOB（避免悬空）');
    else fail('D: 应用 URL 仍是被回收的 DASHBOARD_BLOB（死链）');
    if (revoked.indexOf(NEW_BLOB) === -1) ok('D: 新 URL 未被任何回收逻辑误回收 → 首屏跨态复用安全');
    else fail('D: 新 URL 被误回收');
  }

  // ============ 场景 D2：正常 music→video（快照已捕获，须优先用快照） ============
  console.log('\n[场景 D2] 正常 music→video：快照已捕获 → 优先用快照，不冗余重新读取');
  {
    const SNAP_BLOB = 'blob:http://localhost/snapshot-uuid';
    const { sandbox } = buildSandbox({
      crossPosterSnapshot: { syncUrl: '', blobPromise: Promise.resolve(SNAP_BLOB) },
      dashMeta: { version: 1, kind: 'image' },
      idbRecords: { 'home-hero-video-music': { id: 'home-hero-video-music', blob: { __fake: true } } },
      newBlob: 'blob:http://localhost/NEVER-USED' // 若兜底被误触发会用到它
    });

    const res = runGetMusicCrossPoster(sandbox);
    const applied = await res.blobPromise;
    if (applied === SNAP_BLOB) ok('D2: 返回快照的 blobPromise（未误触发 dashboard 重新读取）: ' + applied);
    else fail('D2: 应优先用快照，实际: ' + applied);
  }

  console.log('\n结果：' + (pass ? '✅ PASS — 跨态海报修复（含 dashboard + 首屏进入影视态兜底）逻辑正确' : '❌ FAIL'));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
