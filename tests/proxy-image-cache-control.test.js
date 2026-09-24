// /api/proxy 图片缓存头测试（海报墙 3s+ 延迟根因之一：代理剥掉上游 Cache-Control
// 且自己不设，浏览器每次开墙都重新远程拉全部海报图）。
// 约定：
//   ① 上游带 cache-control 的图片响应 → 原样透传（含 no-store/private，不得覆盖）
//   ② 上游无 cache-control 的图片响应 → 补设 'public, max-age=86400'
//   ③ 非图片响应 → 不新增 cache-control（视频/API 语义不变）
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');

const PORT = 39873;
process.env.PORT = String(PORT);
delete process.env.HOST;

const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;
const realFetch = globalThis.fetch;

const STUB_HOST = 'https://cdn.stub.test';

function stubUpstream(headers, status) {
  return async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (!url.startsWith(STUB_HOST)) return realFetch(input, init);
    return new Response('IMGDATA', { status: status || 200, headers });
  };
}

async function waitListening() {
  if (server.listening) return;
  await new Promise((resolve) => server.once('listening', resolve));
}

function proxied(targetUrl) {
  return realFetch(BASE + '/api/proxy?url=' + encodeURIComponent(targetUrl));
}

test('上游图片带 Cache-Control → 代理原样透传', async () => {
  await waitListening();
  globalThis.fetch = stubUpstream({
    'content-type': 'image/jpeg',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  try {
    const res = await proxied(STUB_HOST + '/p/w342/poster.jpg');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    await res.arrayBuffer();
  } finally { globalThis.fetch = realFetch; }
});

test('上游图片无 Cache-Control → 代理补设 public, max-age=86400', async () => {
  await waitListening();
  globalThis.fetch = stubUpstream({ 'content-type': 'image/png' });
  try {
    const res = await proxied(STUB_HOST + '/p/w342/logo.png');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
    await res.arrayBuffer();
  } finally { globalThis.fetch = realFetch; }
});

test('上游图片显式 no-store → 不得被默认值覆盖', async () => {
  await waitListening();
  globalThis.fetch = stubUpstream({
    'content-type': 'image/jpeg',
    'cache-control': 'no-store',
  });
  try {
    const res = await proxied(STUB_HOST + '/p/w342/private.jpg');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    await res.arrayBuffer();
  } finally { globalThis.fetch = realFetch; }
});

test('非图片（JSON API）→ 不新增 cache-control', async () => {
  await waitListening();
  globalThis.fetch = stubUpstream({
    'content-type': 'application/json',
    'cache-control': 'public, max-age=60',
  });
  try {
    const res = await proxied(STUB_HOST + '/3/movie/popular');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('cache-control'), null);
    await res.json().catch(() => {});
  } finally { globalThis.fetch = realFetch; }
});

after(() => { server.close(); });
