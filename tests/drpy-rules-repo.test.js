/*
 * tests/drpy-rules-repo.test.js — 批 3 集成测试
 * 自建 mock 仓库（本地 http 静态服务 + manifest v1），验证：
 *   1) 首次同步：2 条规则落盘 + 台账
 *   2) 热加载：同步后 T4 直接可见新模块（不重启 sidecar）
 *   3) 增量更新：改 1 条 + 删 1 条 → added/updated/removed 对账
 *   4) 篡改拒绝：sha256 不符 → 同步失败且 rules 目录零变化（回滚语义）
 *   5) 仓库失联：manifest 404 → 失败且既有规则不受影响
 *   6) 路径穿越消毒
 *   7) 抓取加固（重定环/超大/协议逃逸/非 http）
 *   8) 只读预览 previewRules：下载前先在页面看见仓库里有哪些规则 + 每条文案，
 *      且只拉 manifest（规则正文 404 也不影响）、零写入、校验语义 = syncRules 的试跑
 * 运行：node tests/drpy-rules-repo.test.js
 */
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {syncRules, previewRules, _sha256} = require('../desktop/drpy-rules-repo.js');

// drpy-lite 默认在仓库根（可选组件）；沙盒/其他布局用 DRPY_LITE_DIR_TEST 覆盖
const LITE_DIR = process.env.DRPY_LITE_DIR_TEST || path.join(__dirname, '..', 'drpy-lite');
const LITE_AVAILABLE = fs.existsSync(path.join(LITE_DIR, 'index.js'));
const PORT = 5911;

const RULE_A = `var rule = { title: 'repo源A', host: 'http://127.0.0.1:5901', url: '/list/movie/fypage.html', class_name: '电影', class_url: 'movie', 一级: async function(){ return []; } };`;
const RULE_B = `var rule = { title: 'repo源B', host: 'http://127.0.0.1:5901', url: '/list/series/fypage.html', class_name: '剧集', class_url: 'series', 一级: async function(){ return []; } };`;

function makeRepoServer(rulesMap) {
  return http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const body = p === '/manifest.json'
      ? JSON.stringify({
          manifest_version: 1,
          version: rulesMap.__version || 't1',
          updated_at: new Date().toISOString(),
          rules: Object.keys(rulesMap).filter(k => !k.startsWith('__')).map(file => ({
            name: file.replace('.js', ''),
            file,
            sha256: _sha256(Buffer.from(rulesMap[file], 'utf8')),
            size: Buffer.byteLength(rulesMap[file]),
          })),
        })
      : (rulesMap[p.replace(/^\//, '')] ?? null);
    if (body === null) { res.statusCode = 404; return res.end('no'); }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(body);
  });
}

function lsRules(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
}

(async () => {
  // 独立临时 rules 目录（不污染正式 rules）
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drpy-repo-test-'));
  const rulesJsDir = path.join(tmpRoot, 'rules', 'js');
  fs.mkdirSync(rulesJsDir, {recursive: true});
  // 放一个用户手放的文件，验证同步永不触碰非托管文件
  fs.writeFileSync(path.join(rulesJsDir, '用户手放.js'), '// user owned\n');

  const repo = makeRepoServer({
    'repo源A.js': RULE_A,
    'repo源B.js': RULE_B,
  });
  await new Promise(r => repo.listen(PORT, '127.0.0.1', r));

  if (!LITE_AVAILABLE) {
    console.log('SKIP 热加载段: drpy-lite 未安装（可选组件），同步/回滚/消毒断言继续用本地目录验证');
  }
  // 也拉起真 sidecar（指向临时 rules 目录）验证热加载；drpy-lite 缺席时跳过此子进程
  let lite = null;
  if (LITE_AVAILABLE) {
    lite = spawn(process.execPath, [path.join(LITE_DIR, 'index.js')], {
      cwd: LITE_DIR,
      env: Object.assign({}, process.env, {DRPY_PORT: '5757'}),
      stdio: 'ignore',
    });
    lite.on('error', () => {}); // 可选组件缺席/异常退出不崩测试进程
  }
  try {
    await new Promise(r => setTimeout(r, 4000));

    // 1) 首次同步
    const r1 = await syncRules(`http://127.0.0.1:${PORT}`, rulesJsDir);
    assert.strictEqual(r1.ok, true, '首次同步应 ok: ' + r1.reason);
    assert.strictEqual(r1.added, 2, '应新增 2');
    assert.deepStrictEqual(lsRules(rulesJsDir), ['repo源A.js', 'repo源B.js', '用户手放.js'], '落盘清单应正确且保留用户文件');
    console.log('PASS 首次同步 added=2，用户手放文件未被触碰');

    // 2) 热加载：sidecar 的 /config 应看到新模块（不重启）——需 drpy-lite 就位
    if (LITE_AVAILABLE) {
      const cfg = await (await fetch('http://127.0.0.1:5757/config?healthy=1')).json();
      const names = (cfg.sites || []).map(s => s.name);
      // 注意：sidecar 用的是 drpy-lite/rules/js（非临时目录），这里验证机制本身：
      // 临时目录场景改用同步到真实目录的对照——见下方「真目录热加载」段
      console.log('PASS /config 可访问（热加载对照见真目录段）', names.length);

      // 2b) 真目录热加载：同步 mock 仓库到 sidecar 实际 rules/js
      const realRulesDir = path.join(LITE_DIR, 'rules', 'js');
      const before = lsRules(realRulesDir);
      const repo2 = makeRepoServer({'热加载验证源.js': RULE_A});
      await new Promise(r => repo2.listen(PORT + 1, '127.0.0.1', r));
      const r2 = await syncRules(`http://127.0.0.1:${PORT + 1}`, realRulesDir);
      assert.strictEqual(r2.ok, true, '真目录同步应 ok: ' + r2.reason);
      await new Promise(r => setTimeout(r, 2500)); // 等热加载
      const cfg2 = await (await fetch('http://127.0.0.1:5757/config?healthy=1')).json();
      const names2 = (cfg2.sites || []).map(s => s.title || s.name);
      assert(names2.some(n => n.includes('热加载验证源') || n.includes('repo源A')), '热加载应可见新模块: ' + JSON.stringify(names2));
      console.log('PASS 热加载：新规则不重启即生效');
      // 清理真目录：回滚到同步前状态
      try { fs.rmSync(path.join(realRulesDir, '热加载验证源.js'), {force: true}); } catch (e) {}
      try { fs.rmSync(path.join(realRulesDir, '.drpy-sync-managed.json'), {force: true}); } catch (e) {}
      repo2.close();
    }

    // 3) 增量更新：改 A 内容 + 删 B
    const RULE_A2 = RULE_A.replace('repo源A', 'repo源A-v2');
    const repo3 = makeRepoServer({'repo源A.js': RULE_A2});
    await new Promise(r => repo3.listen(PORT + 2, '127.0.0.1', r));
    const r3 = await syncRules(`http://127.0.0.1:${PORT + 2}`, rulesJsDir);
    assert.strictEqual(r3.ok, true, '增量同步应 ok: ' + r3.reason);
    assert.strictEqual(r3.updated, 1, '应更新 1');
    assert.strictEqual(r3.removed, 1, '应移除 1（B 不在新 manifest）');
    assert.deepStrictEqual(lsRules(rulesJsDir), ['repo源A.js', '用户手放.js'], 'B 应被移除');
    assert.ok(fs.readFileSync(path.join(rulesJsDir, 'repo源A.js'), 'utf8').includes('repo源A-v2'), 'A 内容应已更新');
    console.log('PASS 增量更新 updated=1 removed=1');
    repo3.close();

    // 4) 篡改拒绝：manifest 的 sha256 与实际内容不符 → 失败且零写入
    const before4 = lsRules(rulesJsDir);
    const statBefore = fs.statSync(path.join(rulesJsDir, 'repo源A.js')).mtimeMs;
    const evil = makeRepoServer(null); // 占位
    const evilRules = {'repo源A.js': RULE_A};
    const evilSrv = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/manifest.json') {
        // 故意给错误 sha256
        return res.end(JSON.stringify({
          manifest_version: 1, version: 'evil',
          rules: [{name: 'repo源A', file: 'repo源A.js', sha256: '0'.repeat(64), size: 1}],
        }));
      }
      res.end(evilRules[p.replace(/^\//, '')] ?? '');
    });
    await new Promise(r => evilSrv.listen(PORT + 3, '127.0.0.1', r));
    const r4 = await syncRules(`http://127.0.0.1:${PORT + 3}`, rulesJsDir);
    assert.strictEqual(r4.ok, false, '篡改同步应失败');
    assert.ok((r4.reason || '').includes('sha256'), '失败原因应指向 sha256: ' + r4.reason);
    assert.deepStrictEqual(lsRules(rulesJsDir), before4, '失败后 rules 目录应零变化');
    assert.strictEqual(fs.statSync(path.join(rulesJsDir, 'repo源A.js')).mtimeMs, statBefore, '原文件 mtime 不变（零写入）');
    console.log('PASS 篡改拒绝 + 零写入回滚');
    evilSrv.close();

    // 5) 仓库失联：404 → 失败但既有规则不受影响
    const r5 = await syncRules(`http://127.0.0.1:${PORT}/not-exist`, rulesJsDir);
    assert.strictEqual(r5.ok, false, '失联同步应失败');
    assert.deepStrictEqual(lsRules(rulesJsDir), before4, '失联后既有规则不受影响');
    console.log('PASS 仓库失联 → 既有规则不受影响');

    // 6) 路径穿越消毒：basename 化后永远落在 rulesJsDir 根内
    const m = require('../desktop/drpy-rules-repo.js');
    assert.strictEqual(m.safeRuleFileName('../evil.js'), 'evil.js', '穿越段应被剥除');
    assert.strictEqual(m.safeRuleFileName('sub/dir/x.js'), 'x.js', '子目录应被剥除');
    // 反斜杠在 win32 是路径分隔符（basename 剥成 evil.js），在 posix 是文件名的一部分（. 开头 → 拒绝）。
    // 两平台的不变量都是：要么拒绝，要么结果是不含分隔符/穿越段的裸 .js 名。
    const bs = m.safeRuleFileName('..\\evil.js');
    if (bs !== null) {
      assert.strictEqual(bs, 'evil.js', 'win32 下应剥成裸文件名');
      assert.ok(!/[\\/]/.test(bs) && !bs.includes('..'), '结果不可含分隔符或穿越段');
    }
    assert.strictEqual(m.safeRuleFileName('notjs.txt'), null, '非 .js 应拒绝');
    assert.strictEqual(m.safeRuleFileName(''), null, '空名应拒绝');
    assert.strictEqual(m.safeRuleFileName('.drpy-sync-managed.json'), null, '台账文件名不可被规则占用');
    console.log('PASS 路径穿越消毒');

    // 7) 抓取加固：重定环、超大响应、跳离 http(s) 协议 —— 均须失败且零写入
    const before6 = lsRules(rulesJsDir);
    const MAL_PORT = 5912;
    const mal = http.createServer((req, res) => {
      const p = req.url.split('?')[0];
      if (p === '/loop/manifest.json') {           // 自我 302 = 环
        res.statusCode = 302; res.setHeader('Location', '/loop/manifest.json'); return res.end();
      }
      if (p === '/big/manifest.json') {            // 跳到 5MB 负载
        res.statusCode = 302; res.setHeader('Location', '/big/blob'); return res.end();
      }
      if (p === '/big/blob') {
        res.statusCode = 200; return res.end(Buffer.alloc(5 * 1024 * 1024, 0x61));
      }
      if (p === '/esc/manifest.json') {            // 跳离 http(s) 协议
        res.statusCode = 302; res.setHeader('Location', 'file:///c:/windows/win.ini'); return res.end();
      }
      res.statusCode = 404; res.end('no');
    });
    await new Promise(r => mal.listen(MAL_PORT, '127.0.0.1', r));
    try {
      const rl = await syncRules(`http://127.0.0.1:${MAL_PORT}/loop`, rulesJsDir);
      assert.strictEqual(rl.ok, false, '重定环应失败');
      assert.ok(/redirect-loop/.test(rl.reason), '原因应是重定向次数超限: ' + rl.reason);
      const rb = await syncRules(`http://127.0.0.1:${MAL_PORT}/big`, rulesJsDir);
      assert.strictEqual(rb.ok, false, '超大响应应失败');
      assert.ok(/too-large/.test(rb.reason), '原因应是体积超限: ' + rb.reason);
      const re = await syncRules(`http://127.0.0.1:${MAL_PORT}/esc`, rulesJsDir);
      assert.strictEqual(re.ok, false, '跳到 file: 应失败');
      assert.ok(/redirect-to-file/.test(re.reason), '原因应是协议逃逸: ' + re.reason);
      const rf = await syncRules('ftp://127.0.0.1:9/x', rulesJsDir);
      assert.strictEqual(rf.ok, false, '非 http(s) 仓库地址应拒绝');
      assert.deepStrictEqual(lsRules(rulesJsDir), before6, '三类失败均须零写入');
      console.log('PASS 抓取加固（重定环/超大/协议逃逸 → 失败且零写入）');
    } finally {
      mal.close();
    }

    // 8) 只读预览：下载前先在页面上看见「仓库里有什么 + 每条规则的文案」
    //    规则正文一律 404 —— 预览必须只拉 manifest，否则这条断言就失去意义
    function makeManifestOnlyServer(manifest) {
      return http.createServer((req, res) => {
        const p = decodeURIComponent(req.url.split('?')[0]);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (p === '/manifest.json') return res.end(JSON.stringify(manifest));
        res.statusCode = 404; res.end('no');
      });
    }
    const shaA = _sha256(Buffer.from(RULE_A, 'utf8'));
    const shaB = _sha256(Buffer.from(RULE_B, 'utf8'));
    const before8 = fs.readdirSync(rulesJsDir).sort();
    const pvSrv = makeManifestOnlyServer({
      manifest_version: 1,
      version: 'pv-1',
      description: '本仓库用于预览断言',
      rules: [
        {name: 'repo源A', file: 'repo源A.js', sha256: shaA, size: Buffer.byteLength(RULE_A), desc: 'A 文案：电影列表源，日更'},
        {name: 'repo源B', file: 'repo源B.js', sha256: shaB, size: Buffer.byteLength(RULE_B), description: 'B 文案：剧集列表源'},
      ],
    });
    await new Promise(r => pvSrv.listen(PORT + 4, '127.0.0.1', r));
    try {
      const pv = await previewRules(`http://127.0.0.1:${PORT + 4}`);
      assert.strictEqual(pv.ok, true, '预览应 ok: ' + pv.reason);
      assert.strictEqual(pv.version, 'pv-1', '应带回仓库版本');
      assert.strictEqual(pv.description, '本仓库用于预览断言', '应带回仓库级文案');
      assert.strictEqual(pv.rules.length, 2, '应列出 2 条规则');
      assert.deepStrictEqual(pv.rules.map(r => r.name), ['repo源A', 'repo源B'], '规则名顺序应与 manifest 一致');
      assert.deepStrictEqual(pv.rules.map(r => r.file), ['repo源A.js', 'repo源B.js'], '应带回文件名供对账');
      assert.strictEqual(pv.rules[0].desc, 'A 文案：电影列表源，日更', '每条规则的文案（desc）应在返回里');
      assert.strictEqual(pv.rules[1].desc, 'B 文案：剧集列表源', 'description 应作为 desc 的别名生效');
      assert.strictEqual(pv.rules[0].sha256, shaA, '应带回 sha256（供页面显示校验状态）');
      assert.strictEqual(pv.rules[0].size, Buffer.byteLength(RULE_A), '应带回 size');
      assert.deepStrictEqual(fs.readdirSync(rulesJsDir).sort(), before8, '预览须零写入（规则正文 404 也没被拉）');
      console.log('PASS 只读预览：manifest 文案 + 元数据 + 零写入');

      // 校验语义 = syncRules 的试跑：同一个坏 manifest，两者 reason 必须逐字相同
      const badManifest = {
        manifest_version: 1, version: 'bad',
        rules: [{name: '坏名', file: 'notjs.txt', sha256: shaA, size: 1, desc: '不该出现在页面上'}],
      };
      const badSrv = makeManifestOnlyServer(badManifest);
      await new Promise(r => badSrv.listen(PORT + 5, '127.0.0.1', r));
      const pb = await previewRules(`http://127.0.0.1:${PORT + 5}`);
      const sb = await syncRules(`http://127.0.0.1:${PORT + 5}`, rulesJsDir);
      badSrv.close();
      assert.strictEqual(pb.ok, false, '非法规则名预览应失败');
      assert.strictEqual(sb.ok, false, '非法规则名同步应失败');
      assert.strictEqual(pb.reason, sb.reason, '预览文案应与下载同口径: ' + pb.reason + ' vs ' + sb.reason);
      assert.deepStrictEqual(fs.readdirSync(rulesJsDir).sort(), before8, '预览失败同样须零写入');

      // 缺 sha256：预览即拒绝（否则下载时才失败，用户白跑一趟）
      const noShaSrv = makeManifestOnlyServer({
        manifest_version: 1, version: 'nosh',
        rules: [{name: '无摘要', file: 'repo源A.js', size: 1}],
      });
      await new Promise(r => noShaSrv.listen(PORT + 6, '127.0.0.1', r));
      const pn = await previewRules(`http://127.0.0.1:${PORT + 6}`);
      noShaSrv.close();
      assert.strictEqual(pn.ok, false, '缺 sha256 应失败');
      assert.ok(/sha256/.test(pn.reason), '原因应指向 sha256: ' + pn.reason);

      // 地址闸与失联：与 syncRules 同集合
      const pf = await previewRules('ftp://127.0.0.1:9/x');
      assert.strictEqual(pf.ok, false, '非 http(s) 应拒绝');
      assert.ok(/http\(s\)/.test(pf.reason), '原因应是协议闸: ' + pf.reason);
      const p404 = await previewRules(`http://127.0.0.1:${PORT}/not-exist`);
      assert.strictEqual(p404.ok, false, 'manifest 失联应失败');
      assert.ok(/manifest/.test(p404.reason), '原因应指向 manifest: ' + p404.reason);
      console.log('PASS 预览=下载试跑（坏名同 reason / 缺 sha256 / 协议闸 / 失联）');
    } finally {
      pvSrv.close();
    }

    console.log('ALL drpy-rules-repo TESTS PASSED');
  } finally {
    try { lite.kill('SIGKILL'); } catch (e) {}
    try { repo.close(); } catch (e) {}
    try { fs.rmSync(tmpRoot, {recursive: true, force: true}); } catch (e) {}
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
