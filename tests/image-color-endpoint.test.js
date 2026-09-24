'use strict';

/**
 * /api/image-color — 海报平均色端点（精选片单封面卡「色温跟随首张海报」的数据源）
 * 实现：wsrv.nl 把任意 TMDB 海报缩到 1×1 PNG，服务端 zlib 解像素得平均色。
 * 零新依赖、零 canvas（7c84045 跨源污染红线）。
 * 约定：
 *   ① url 仅允许 https://image.tmdb.org/t/p/<size>/<file>（SSRF 白名单），否则 400
 *   ② 成功返回 { color:'#rrggbb' }，进程内按 url 缓存（同 URL 不再打上游）
 *   ③ 上游失败 → 502，且不进缓存
 * 运行：node --test tests/image-color-endpoint.test.js
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

const PORT = 39874;
process.env.PORT = String(PORT);
delete process.env.HOST;

const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;
const realFetch = globalThis.fetch;

// 手工构造 1×1 RGB PNG（colorType 2），像素值即期望平均色
function png1x1(r, g, b) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xFFFFFFFF;
    for (const x of buf) c = table[(c ^ x) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const cc = Buffer.alloc(4);
    cc.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colorType = truecolor RGB
  const idat = zlib.deflateSync(Buffer.from([0, r, g, b]));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

let upstreamCalls = 0;
function stubWsrv(body, status) {
  return async (input, init) => {
    const u = String(typeof input === 'string' ? input : input.url);
    if (!u.startsWith('https://wsrv.nl/')) return realFetch(input, init);
    upstreamCalls += 1;
    return new Response(body, {
      status: status || 200,
      headers: { 'content-type': 'image/png' },
    });
  };
}

async function waitListening() {
  if (server.listening) return;
  await new Promise((resolve) => server.once('listening', resolve));
}

const TMDB_IMG = 'https://image.tmdb.org/t/p/w500/abcdef123456.jpg';

function getColor(target) {
  return realFetch(BASE + '/api/image-color?url=' + encodeURIComponent(target));
}

test('TMDB 海报 URL → 200 {color} 且等于 1×1 像素平均色', async () => {
  await waitListening();
  upstreamCalls = 0;
  globalThis.fetch = stubWsrv(png1x1(30, 60, 90));
  try {
    const res = await getColor(TMDB_IMG);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.color, '#1e3c5a'); // 30,60,90 → 1e,3c,5a
  } finally { globalThis.fetch = realFetch; }
});

test('非 image.tmdb.org 主机 → 400（SSRF 白名单）', async () => {
  await waitListening();
  const res = await getColor('https://evil.internal.example/x.jpg');
  assert.equal(res.status, 400);
  await res.text();
});

test('同 URL 二次请求命中进程内缓存，不再打上游', async () => {
  await waitListening();
  upstreamCalls = 0;
  globalThis.fetch = stubWsrv(png1x1(10, 20, 30));
  try {
    const a = await getColor('https://image.tmdb.org/t/p/w500/cached.jpg');
    const ja = await a.json();
    const b = await getColor('https://image.tmdb.org/t/p/w500/cached.jpg');
    const jb = await b.json();
    assert.equal(ja.color, jb.color);
    assert.equal(upstreamCalls, 1, '第二次须走缓存');
  } finally { globalThis.fetch = realFetch; }
});

test('上游失败 → 502 且不进缓存（下次重试仍打上游）', async () => {
  await waitListening();
  upstreamCalls = 0;
  globalThis.fetch = stubWsrv('boom', 500);
  try {
    const res = await getColor('https://image.tmdb.org/t/p/w500/fail.jpg');
    assert.equal(res.status, 502);
    await res.text();
    assert.equal(upstreamCalls, 1);
  } finally { globalThis.fetch = realFetch; }
  globalThis.fetch = stubWsrv(png1x1(1, 2, 3));
  try {
    const res = await getColor('https://image.tmdb.org/t/p/w500/fail.jpg');
    assert.equal(res.status, 200, '失败不得占用缓存位');
    await res.json();
    assert.equal(upstreamCalls, 2);
  } finally { globalThis.fetch = realFetch; }
});

after(() => { server.close(); });
