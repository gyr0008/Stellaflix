// 本地 API 跨站请求防护回放测试：
// 模拟"播放器自身窗口"与"陌生人浏览器里的恶意网页"两类请求，
// 验证恶意来源读不到响应（无通配 CORS 头）、写不进状态（403），
// 同时确认四条登录流依赖的同源/无头请求不被误伤。
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');

const PORT = 39871;
process.env.PORT = String(PORT);
delete process.env.HOST; // 走默认值，顺带验证默认绑定

const server = require('../server.js');

const BASE = 'http://127.0.0.1:' + PORT;
const OK_ORIGINS = ['http://127.0.0.1:' + PORT, 'http://localhost:' + PORT];
const EVIL_ORIGIN = 'https://evil.example.com';

async function waitListening() {
  if (server.listening) return;
  await new Promise((resolve) => server.once('listening', resolve));
}

test('默认 HOST 是 127.0.0.1，不再暴露局域网', async () => {
  await waitListening();
  assert.equal(server.address().address, '127.0.0.1');
});

test('GET API：恶意 Origin 不再拿到通配 CORS 头', async () => {
  await waitListening();
  const res = await fetch(BASE + '/api/app/version', { headers: { Origin: EVIL_ORIGIN } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('GET API：无 Origin（资源加载/curl）不带 CORS 头', async () => {
  await waitListening();
  const res = await fetch(BASE + '/api/app/version');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('GET API：白名单 Origin 得到回显 + Vary: Origin', async () => {
  await waitListening();
  for (const origin of OK_ORIGINS) {
    const res = await fetch(BASE + '/api/app/version', { headers: { Origin: origin } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.match(res.headers.get('vary') || '', /Origin/);
  }
});

test('POST /api/login/cookie：恶意 Origin 被 403 拦截（登录态不可被网页替换）', async () => {
  await waitListening();
  const res = await fetch(BASE + '/api/login/cookie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: EVIL_ORIGIN },
    body: JSON.stringify({ cookie: 'MUSIC_U=fake' }),
  });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error, 'FORBIDDEN_ORIGIN');
});

test('POST：无 Origin 但 Sec-Fetch-Site: cross-site 也被 403', async () => {
  await waitListening();
  const res = await fetch(BASE + '/api/qq/login/cookie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: '{}',
  });
  assert.equal(res.status, 403);
});

test('POST：同源窗口提交空 cookie → 走到业务校验 400，未被误伤', async () => {
  await waitListening();
  for (const origin of OK_ORIGINS) {
    const res = await fetch(BASE + '/api/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({}),
    });
    assert.notEqual(res.status, 403);
    const data = await res.json();
    assert.equal(data.error, 'INVALID_NETEASE_COOKIE'); // 缺 MUSIC_U，进到了原逻辑
  }
});

test('POST：本机无头流量（Electron 主进程 / curl 等价）不被误伤', async () => {
  await waitListening();
  const res = await fetch(BASE + '/api/login/cookie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.notEqual(res.status, 403);
});

test('SSRF 私网拦截保持：GET /api/proxy 指向内网仍被拒', async () => {
  await waitListening();
  const res = await fetch(BASE + '/api/proxy?url=' + encodeURIComponent('http://192.168.1.1/admin'));
  assert.equal(res.status, 403);
  assert.equal(await res.text(), 'Forbidden host');
});

test('静态页面照常返回（首页不被防护逻辑波及）', async () => {
  await waitListening();
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
});

after(() => { server.close(); });
