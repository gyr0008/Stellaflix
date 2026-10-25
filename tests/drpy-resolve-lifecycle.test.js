/*
 * tests/drpy-resolve-lifecycle.test.js — drpy(T4) 渲染层不变量（不依赖 drpy-lite）
 * 用假 sidecar/假 fetch 验证三件真机才会暴露的事：
 *   1) 端点按模块名现拼：持久化 api 的端口失效后搜索/详情仍打到当前 baseUrl
 *   2) 去重按模块名：重启换端口再导入，不得多出一套废源
 *   3) 二次解析：并发受限 + parse/jx/header 不被丢弃
 * 运行：node tests/drpy-resolve-lifecycle.test.js
 */
const assert = require('assert');
const path = require('path');

const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
global.window = global;
global.AbortController = AbortController;
global.URL = URL;
// sources.js 的 [SFV-DEBUG] 日志在本测试里是噪音：只吞它，保留 PASS/FAIL 输出
const log = console.log.bind(console);
console.log = (...a) => { if (!String(a[0] || '').startsWith('[SFV-DEBUG]')) log(...a); };

function loadScript(p) {
  const code = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'video', p), 'utf8');
  new Function('window', code)(global);
}

// 记录所有被请求过的 URL，并模拟 sidecar 端点的解析返回
// 注：sources.js 的 fetchJson 走 res.text()，垫片只实现 text()
const hits = [];
let inFlight = 0, peak = 0;
const jsonResponse = (obj) => ({ ok: true, text: () => Promise.resolve(JSON.stringify(obj)) });
global.fetch = (url, opts) => {
  const u = String(url);
  hits.push(u);
  if (u.includes('/api/mock测试源') && /[?&]play=/.test(u)) {
    inFlight += 1; peak = Math.max(peak, inFlight);
    return new Promise((resolve) => setTimeout(resolve, 20))
      .then(() => { inFlight -= 1; return jsonResponse({ url: 'http://cdn/x.m3u8', parse: 1, jx: 0, header: { Referer: 'http://site.test/' } }); });
  }
  if (u.includes('ac=videolist') || u.includes('ac=detail')) {
    return Promise.resolve(jsonResponse({ list: [{ vod_id: '1', vod_name: '测试片', vod_play_from: 'mock', vod_play_url: '第1集$1-1.m3u8' }] }));
  }
  return Promise.resolve(jsonResponse({}));
};

(async () => {
  loadScript('sources-core.js');
  loadScript('sources.js');
  const SFV = global.StellaflixVideo;

  // 假桥：只暴露 sources.js 用到的 resolveApi，端口固定为「当前」baseUrl
  SFV.drpy = {
    __bridge: true,
    resolveApi: (m) => Promise.resolve('http://127.0.0.1:40000/api/' + encodeURIComponent(m)),
    resolvePlay: () => Promise.resolve({ url: 'http://cdn/x.m3u8', parse: 1, jx: 0, header: null }),
  };

  // 1) 端口漂移：源里写死死端口 1，实际端点应由 resolveApi 现拼 40000
  const added = SFV.sources.addSource({ name: 'mock测试源(DS)', api: 'http://127.0.0.1:1/api/mock测试源', type: 'drpy', drpyModule: 'mock测试源', enabled: true });
  assert(added.ok, 'addSource 应成功: ' + added.reason);
  hits.length = 0;
  await SFV.sources.search('测试', { sources: [added.source], timeout: 5000 });
  assert(hits.some((h) => h.includes('127.0.0.1:40000')), '搜索应打到现拼端点: ' + JSON.stringify(hits));
  assert(!hits.some((h) => h.includes(':1/')), '不得再用死端口: ' + JSON.stringify(hits));
  console.log('PASS 端口漂移自愈（resolveApi 现拼端点）');

  // 2) 去重按模块名：api 不同、模块同名 → 不得新增
  const dup = SFV.sources.addSource({ name: 'mock测试源(DS)', api: 'http://127.0.0.1:5/api/mock测试源', type: 'drpy', drpyModule: 'mock测试源' });
  assert.strictEqual(dup.ok, false, '同模块重复导入应失败');
  assert.strictEqual(dup.reason, 'duplicate-module', '原因应为 duplicate-module，实际: ' + dup.reason);
  assert.strictEqual(SFV.sources.getSources().length, 1, '存储不得增长');
  // 不同模块即使 api 相同前缀也应各自入库
  const other = SFV.sources.addSource({ name: '另源', api: 'http://127.0.0.1:1/api/另源', type: 'drpy', drpyModule: '另源' });
  assert(other.ok, '不同模块应可入库: ' + other.reason);
  console.log('PASS drpy 按模块名去重');

  // 3) 二次解析字段不被丢：parse/jx/header/rawId 应带到集对象上
  SFV.drpy.resolvePlay = (api, flag, id) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    return new Promise((r) => setTimeout(r, 15)).then(() => {
      inFlight -= 1;
      return { url: 'http://cdn/' + id + '.m3u8', parse: 1, jx: 1, header: { Referer: 'http://site.test/' } };
    });
  };
  // 造一个 20 集 × 2 线路的详情
  const big = { list: [{ vod_id: '9', vod_name: '长剧', vod_play_from: 'a$$$b', vod_play_url: Array(2).fill(Array.from({ length: 20 }, (_, i) => `第${i + 1}集$id${i}`).join('#')).join('$$$') }] };
  const realFetch = global.fetch;
  global.fetch = (u, o) => (String(u).includes('ac=detail')
    ? Promise.resolve(jsonResponse(big))
    : realFetch(u, o));
  peak = 0; inFlight = 0;
  const src = SFV.sources.getSources()[0];
  const det = await SFV.sources.detail(src, '9', 8000);
  assert(det.ok, 'detail 应 ok: ' + det.reason);
  assert.strictEqual(det.plays.length, 2, '应有两条线路');
  const ep = det.plays[0].episodes[0];
  assert.strictEqual(ep.rawId, 'id0', '应保留 rawId');
  assert.strictEqual(ep.jx, 1, 'jx 不得丢');
  assert.strictEqual(ep.parse, 1, 'parse 不得丢');
  assert.strictEqual(ep.needsSniff, true, 'jx=1 应标 needsSniff');
  assert.deepStrictEqual(ep.header, { Referer: 'http://site.test/' }, '规则防盗链头应带出');
  assert.ok(peak > 1, '应确有并发，峰值: ' + peak);
  assert.ok(peak <= 4, '并发应受限 4，实际峰值 ' + peak);
  assert.strictEqual(det.plays[0].episodes.length, 20, '集数应完整');
  console.log('PASS 二次解析字段保全 + 并发受限（峰值 ' + peak + '/40 集）');

  console.log('ALL drpy-resolve-lifecycle TESTS PASSED');
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
