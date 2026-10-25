'use strict';
/**
 * drpy 接口口令（API_PWD）通道测试。
 * 运行：node --test tests/drpy-api-pwd.test.js
 * ① sidecar：口令由宿主注入 spawn env 并在 status 里如实上报（未配置则不保护）
 * ② bridge：resolveApi 现拼 ?pwd=，resolvePlay 在 api 已带查询串时改用 & 追加
 * 不需要真实 drpy-lite。
 */
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('path');

const { createDrpySidecar } = require('../desktop/drpy-sidecar');

test('sidecar：status 上报口令保护态', () => {
  const bare = createDrpySidecar({ port: 0, quiet: true, liteDir: path.join(__dirname, 'fixtures', 'no-such-lite') });
  assert.equal(bare.status().pwdProtected, false);
  assert.equal(bare.status().pwd, '');

  const guarded = createDrpySidecar({ port: 0, quiet: true, apiPwd: 'sekret', liteDir: path.join(__dirname, 'fixtures', 'no-such-lite') });
  assert.equal(guarded.status().pwdProtected, true);
  assert.equal(guarded.status().pwd, 'sekret');
});

test('sidecar：STELLAFLIX_DRPY_API_PWD 环境变量同样生效', () => {
  process.env.STELLAFLIX_DRPY_API_PWD = 'fromEnv';
  try {
    const s = createDrpySidecar({ port: 0, quiet: true, liteDir: path.join(__dirname, 'fixtures', 'no-such-lite') });
    assert.equal(s.status().pwd, 'fromEnv');
  } finally {
    delete process.env.STELLAFLIX_DRPY_API_PWD;
  }
});

// ---------- bridge ----------
function loadBridge(statusPayload) {
  const calls = [];
  const sandbox = {
    window: {},
    fetch: (url, opt) => {
      calls.push(String(url));
      let payload = statusPayload;
      if (String(url).indexOf('/api/drpy/status') < 0) {
        payload = /\/config/.test(url) ? { sites: [] } : { url: 'https://cdn.example.com/v.m3u8', parse: 1, jx: 0 };
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    },
    setTimeout, clearTimeout, AbortController, Date, Object, Array, String, Number, Promise, encodeURIComponent, JSON,
  };
  sandbox.window.fetch = sandbox.fetch;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('public/video/drpy-bridge.js', 'utf8'), sandbox, { filename: 'drpy-bridge.js' });
  return { D: sandbox.window.StellaflixVideo.drpy, calls };
}

test('bridge：已设口令时 resolveApi 现拼 ?pwd=，resolvePlay 用 & 追加参数', async () => {
  const { D, calls } = loadBridge({ state: 'running', baseUrl: 'http://127.0.0.1:5757', pwd: 'sekret' });
  const api = await D.resolveApi('示例源');
  assert.equal(api, 'http://127.0.0.1:5757/api/' + encodeURIComponent('示例源') + '?pwd=sekret');
  const r = await D.resolvePlay(api, 'zz', '第1集$https://play/page');
  assert.equal(r.url, 'https://cdn.example.com/v.m3u8');
  const played = calls[calls.length - 1];
  assert.match(played, /\?pwd=sekret&play=/, '口令在前用 & 连接，不得出现第二个 ?');
  assert.ok(played.indexOf('?pwd=sekret&play=') < played.length);
});

test('bridge：未设口令时端点保持干净，resolvePlay 仍用 ? 起头', async () => {
  const { D, calls } = loadBridge({ state: 'running', baseUrl: 'http://127.0.0.1:5757', pwd: '' });
  const api = await D.resolveApi('m');
  assert.equal(api, 'http://127.0.0.1:5757/api/m');
  await D.resolvePlay(api, 'f', 'id1');
  assert.match(calls[calls.length - 1], /\/api\/m\?play=id1&flag=f$/);
});

test('bridge：/config 列表请求也带口令', async () => {
  const { D, calls } = loadBridge({ state: 'running', baseUrl: 'http://127.0.0.1:5757', pwd: 'pw9' });
  await D.listModules();
  assert.equal(calls[calls.length - 1], 'http://127.0.0.1:5757/config?healthy=1&pwd=pw9');
});
