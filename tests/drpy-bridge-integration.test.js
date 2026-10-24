/*
 * tests/drpy-bridge-integration.test.js — 批 2 集成测试
 * 在 node 中模拟浏览器环境（localStorage 垫片 + fetch），
 * 加载 sources-core.js / sources.js / drpy-bridge.js，
 * 对真 drpy-lite sidecar（含 mock 规则）做全链路验证：
 *   探测 → 列模块 → 导入 → 启用 → 搜索 → 详情(播放地址二次解析)
 * 运行：node tests/drpy-bridge-integration.test.js
 */
const assert = require('assert');
const path = require('path');
const {spawn} = require('child_process');

// drpy-lite 默认在仓库根（可选组件）；沙盒/其他布局用 DRPY_LITE_DIR_TEST 覆盖
const LITE_DIR = process.env.DRPY_LITE_DIR_TEST || path.join(__dirname, '..', 'drpy-lite');
const LITE_AVAILABLE = require('fs').existsSync(path.join(LITE_DIR, 'index.js'));
const SIDE_PORT = 5759;

// ---------------- 浏览器环境垫片 ----------------
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
global.window = global;
global.AbortController = AbortController;
global.URL = URL;

function loadScript(p) {
  // 这些脚本是 IIFE，直接 require 执行（global 传 window=this 分支也兼容）
  const code = require('fs').readFileSync(p, 'utf8');
  new Function('window', code)(global);
}

function get(url, timeout) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('https') : require('http');
    const req = mod.get(url, {timeout: timeout || 8000}, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({code: res.statusCode, body: b, json: () => JSON.parse(b)}));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

(async () => {
  if (!LITE_AVAILABLE) {
    console.log('SKIP drpy-bridge-integration: drpy-lite 未安装（可选组件，解压 drpy-lite/ 到仓库根后此测试生效）');
    process.exit(0);
  }
  // mock 规则自管理：出厂 drpy-lite 的 rules/js 为空（红线），测试临时放入、结束删回
  const fixtureRule = path.join(__dirname, 'fixtures', 'drpy-mock测试源.js');
  const targetRule = path.join(LITE_DIR, 'rules', 'js', 'mock测试源.js');
  const ruleCreatedHere = !require('fs').existsSync(targetRule);
  if (ruleCreatedHere) require('fs').copyFileSync(fixtureRule, targetRule);
  // 0) 环境：mock 站 + drpy-lite sidecar + 真实 server.js + 渲染层脚本
  const mock = spawn(process.execPath, [path.join(LITE_DIR, 'test', 'mockserver.mjs')], {stdio: 'ignore'});
  const lite = spawn(process.execPath, [path.join(LITE_DIR, 'index.js')], {
    cwd: LITE_DIR, env: Object.assign({}, process.env, {DRPY_PORT: String(SIDE_PORT)}), stdio: 'ignore',
  });
  // server.js 会自启自己的 sidecar 实例（DRPY_LITE_DIR 指向 lite 目录，端口让默认 5757）
  const srvEnv = Object.assign({}, process.env, {
    PORT: '8901', HOST: '127.0.0.1', DRPY_LITE_DIR: LITE_DIR,
  });
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {env: srvEnv, stdio: 'ignore'});
  try {
    await new Promise((r) => setTimeout(r, 4000));

    // 相对路径 fetch 垫片：指向真实 server.js（同时验证 /api/drpy/status 路由）
    const ORIGIN = 'http://127.0.0.1:8901';
    const realFetch = global.fetch;
    global.fetch = (u, o) => realFetch(typeof u === 'string' && u.startsWith('/') ? ORIGIN + u : u, o);

    loadScript(path.join(__dirname, '..', 'public', 'video', 'sources-core.js'));
    loadScript(path.join(__dirname, '..', 'public', 'video', 'sources.js'));
    loadScript(path.join(__dirname, '..', 'public', 'video', 'drpy-bridge.js'));
    const SFV = global.StellaflixVideo;
    assert(SFV.sources && SFV.drpy, 'facade 应就绪');

    // 1) 探测 sidecar（轮询等待：端口释放/首启回退有竞态）
    let st = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      st = await SFV.drpy.getStatus(true);
      if (st.running) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert(st && st.running, 'sidecar 应 running: ' + JSON.stringify(st));
    console.log('PASS getStatus', st.baseUrl);

    // 2) listModules
    const mods = await SFV.drpy.listModules();
    const mockMod = mods.find((m) => m.module === 'mock测试源');
    assert(mockMod, '应列出 mock测试源: ' + JSON.stringify(mods));
    console.log('PASS listModules ×' + mods.length);

    // 3) importModules（出厂 sources 为空 → 导入后 1 条、disabled）
    const imp = await SFV.drpy.importModules();
    assert.strictEqual(imp.added, mods.length, '导入数应等于模块数');
    const stored = SFV.sources.getSources();
    assert.strictEqual(stored.length, imp.added, '存储应落盘');
    assert.strictEqual(stored[0].enabled, false, '导入态应为 disabled');
    assert.strictEqual(stored[0].type, 'drpy', '类型应为 drpy');
    console.log('PASS importModules added=' + imp.added);

    // 4) 启用 + 搜索（search 的 opts.sources 接收源对象数组）
    const en = SFV.sources.setEnabled(stored[0].id, true);
    assert(en.ok, '启用应成功');
    const res = await SFV.sources.search('测试', {sources: [en.source], timeout: 15000});
    const flat = res.items || [];
    assert.ok(flat.length > 0, '聚合搜索应有结果: ' + JSON.stringify(res).slice(0, 200));
    console.log('PASS search ×' + flat.length);

    // 5) 详情 + 播放地址二次解析（drpy 源的核心差异点）
    // 注意：res.items 是 dedupe 归并层（vodId 在 variants 里），raw 才是原始 normalized vod
    const rawVod = (res.raw || []).find((r) => r.title === flat[0].title) || res.raw[0];
    assert(rawVod && rawVod.vodId, 'raw 层应有 vodId');
    const det = await SFV.sources.detail(en.source, rawVod.vodId, 20000);
    assert(det.ok, 'detail 应 ok: ' + (det.reason || ''));
    assert(det.plays && det.plays.length, 'plays 应非空');
    const ep = det.plays[0].episodes[0];
    assert(ep.url.includes('.m3u8'), '集地址应已解析为 m3u8 直链: ' + ep.url);
    assert(ep.rawId && ep.rawId !== ep.url, '应保留 rawId 供追溯');
    console.log('PASS detail+resolvePlay →', ep.url);

    // 6) 解析结果缓存：第二次 detail 命中 playCache（快路径不报错即可）
    const det2 = await SFV.sources.detail(en.source, rawVod.vodId, 20000);
    assert(det2.ok && det2.plays[0].episodes[0].url.includes('.m3u8'), '二次 detail 应仍 ok');
    console.log('PASS detail 二次调用（playCache 生效）');

    console.log('ALL drpy-bridge INTEGRATION TESTS PASSED');
  } finally {
    try { srv.kill('SIGKILL'); } catch (e) {}
    try { lite.kill('SIGKILL'); } catch (e) {}
    try { mock.kill('SIGKILL'); } catch (e) {}
    if (ruleCreatedHere) { try { require('fs').rmSync(targetRule, {force: true}); } catch (e) {} }
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
