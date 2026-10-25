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

    // 7) 重启换端口：sidecar 每次随机端口，持久化 api 必然失效。
    //    把源里的 api 写成死端口，搜索/详情仍应成功 —— 端点按 drpyModule 现拼。
    const dead = SFV.sources.updateSource(en.source.id, { api: 'http://127.0.0.1:1/api/mock测试源' });
    assert(dead.ok && /127\.0\.0\.1:1\//.test(dead.source.api), '应已写入死端口 api');
    const res3 = await SFV.sources.search('测试', { sources: [dead.source], timeout: 15000 });
    assert.ok((res3.items || []).length > 0, '端口失效后搜索应仍命中（现拼端点）: ' + JSON.stringify(res3.errors || []));
    const det3 = await SFV.sources.detail(dead.source, rawVod.vodId, 20000);
    assert(det3.ok && det3.plays[0].episodes[0].url.includes('.m3u8'), '端口失效后详情二次解析应仍成功: ' + (det3.reason || ''));
    console.log('PASS 端口漂移自愈（死 api 仍可搜索+二次解析）');

    // 8) 重复导入去重：api 已变、模块名相同 → 不得再新增一套源
    const before = SFV.sources.getSources().length;
    const imp2 = await SFV.drpy.importModules();
    assert.strictEqual(imp2.added, 0, '同模块再导入应 0 新增，实际: ' + JSON.stringify(imp2));
    assert.strictEqual(SFV.sources.getSources().length, before, '存储条数不得增长');
    console.log('PASS 重复导入按模块名去重');

    // 9) 外置规则仓库页面单行「添加」：importModules(['名']) 只提交该模块，
    //    不在清单里的名字不得顺带导入其他模块。
    SFV.sources.removeSource(SFV.sources.getSources()[0].id);
    const only = await SFV.drpy.importModules(['不存在的模块']);
    assert.strictEqual(only.added, 0, '不存在的模块应 0 新增');
    assert.strictEqual(only.skipped, 0, '不存在的模块不该算跳过（根本没进循环）');
    const one = await SFV.drpy.importModules(['mock测试源']);
    assert.strictEqual(one.added, 1, '定向导入应恰好 1 条: ' + JSON.stringify(one));
    assert.strictEqual(one.sources[0].drpyModule, 'mock测试源', '添加的应是点中的模块');
    console.log('PASS importModules 按模块名定向添加');

    // 10) 预览仓库：走真 server.js 路由（POST /api/drpy/rules/preview）+ 真 drpy-rules-repo，
    //     只读：rules/js 清单不得变化。
    const previewRepo = require('http').createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (p === '/manifest.json') {
        return res.end(JSON.stringify({
          manifest_version: 1, version: 'preview-断言', description: '预览链路断言仓库',
          rules: [{ name: '预览源', file: '预览源.js', sha256: '0'.repeat(64), size: 1, desc: '预览文案：这条不必真下载' }],
        }));
      }
      res.statusCode = 404; res.end('no');
    });
    await new Promise((r) => previewRepo.listen(5961, '127.0.0.1', r));
    const realRulesJs = path.join(LITE_DIR, 'rules', 'js');
    const lsBeforePreview = require('fs').readdirSync(realRulesJs).sort();
    try {
      const pv = await SFV.drpy.previewRepo('http://127.0.0.1:5961');
      assert.ok(pv && pv.ok, '预览应 ok: ' + (pv && pv.reason));
      assert.strictEqual(pv.version, 'preview-断言', '应带回仓库版本');
      assert.strictEqual(pv.rules[0].desc, '预览文案：这条不必真下载', '每条规则的文案须穿链路到渲染层');
      assert.deepStrictEqual(require('fs').readdirSync(realRulesJs).sort(), lsBeforePreview, '预览须零写入');
      console.log('PASS 预览仓库（路由 → previewRules → 渲染层）零写入');
    } finally {
      previewRepo.close();
    }

    console.log('ALL drpy-bridge INTEGRATION TESTS PASSED');
  } finally {
    try { srv.kill('SIGKILL'); } catch (e) {}
    try { lite.kill('SIGKILL'); } catch (e) {}
    try { mock.kill('SIGKILL'); } catch (e) {}
    if (ruleCreatedHere) { try { require('fs').rmSync(targetRule, {force: true}); } catch (e) {} }
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
