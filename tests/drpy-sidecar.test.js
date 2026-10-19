/*
 * tests/drpy-sidecar.test.js — SidecarManager 单测（批 2）
 * 直接对真 drpy-lite（../drpy-lite-build，含 mock 规则）做拉起/握手/健康检查/重启验证。
 * 运行：node tests/drpy-sidecar.test.js
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const {spawn} = require('child_process');
const {createDrpySidecar} = require('../desktop/drpy-sidecar.js');

const LITE_DIR = process.env.DRPY_LITE_DIR_TEST || path.join(__dirname, '..', '..', 'drpy-lite-build');

// 自包含：先拉 mock 站（drpy-lite-build/test/mockserver.mjs），测完回收
function startMock() {
  const child = spawn(process.execPath, [path.join(LITE_DIR, 'test', 'mockserver.mjs')], {stdio: 'ignore'});
  return child;
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, {timeout: 8000}, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({code: res.statusCode, body: b}));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

(async () => {
  const mock = startMock();
  await new Promise((r) => setTimeout(r, 1200)); // 等 mock 就绪
  const mgr = createDrpySidecar({liteDir: LITE_DIR, port: 5758, quiet: true});
  try {
    // 1) 启动 + 握手
    mgr.start();
    const t0 = Date.now();
    let st = mgr.status();
    while (st.state !== 'running' && Date.now() - t0 < 25000) {
      await new Promise((r) => setTimeout(r, 300));
      st = mgr.status();
    }
    assert.strictEqual(st.state, 'running', '应进入 running，实际: ' + JSON.stringify(st));
    assert(st.baseUrl && st.baseUrl.startsWith('http://127.0.0.1:5758'), 'baseUrl 应指向 127.0.0.1:5758: ' + st.baseUrl);
    console.log('PASS 启动+握手', st.baseUrl, '(' + (Date.now() - t0) + 'ms)');

    // 2) 健康检查
    const hc = await mgr.healthCheck(8000);
    assert.ok(hc.ok, '健康检查应通过: ' + JSON.stringify(hc));
    console.log('PASS 健康检查');

    // 3) mock 规则可搜索（T4 链路经 sidecar ）
    const s = await get(st.baseUrl + '/api/' + encodeURIComponent('mock测试源') + '?wd=%E6%B5%8B%E8%AF%95');
    assert.strictEqual(s.code, 200, '搜索应 200');
    const list = JSON.parse(s.body).list || [];
    assert.ok(list.length > 0, '搜索应有结果');
    console.log('PASS T4 搜索经 sidecar，结果数', list.length);

    // 4) 崩溃自动重启：kill -9 后应回到 running
    const pidBefore = mgr.status().pid;
    process.kill(pidBefore, 'SIGKILL');
    const t1 = Date.now();
    // 先等状态离开 running（exit 事件异步派发）
    while (mgr.status().state === 'running' && Date.now() - t1 < 25000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    st = mgr.status();
    while (st.state !== 'running' && Date.now() - t1 < 25000) {
      await new Promise((r) => setTimeout(r, 300));
      st = mgr.status();
    }
    assert.strictEqual(st.state, 'running', 'kill -9 后应自动重启至 running');
    assert.notStrictEqual(st.pid, pidBefore, '重启后 pid 应变化');
    assert.ok(st.restarts >= 1, 'restarts 计数应 >=1');
    console.log('PASS 崩溃自动重启', '(' + (Date.now() - t1) + 'ms)');

    // 5) 显式 stop 后不再拉起
    mgr.stop();
    await new Promise((r) => setTimeout(r, 500));
    st = mgr.status();
    assert.ok(st.state === 'stopped' && !st.pid, 'stop 后应为 stopped');
    console.log('PASS 显式 stop');
  } finally {
    mgr.stop();
    try { mock.kill('SIGKILL'); } catch (e) { /* ignore */ }
  }
  console.log('ALL drpy-sidecar TESTS PASSED');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
