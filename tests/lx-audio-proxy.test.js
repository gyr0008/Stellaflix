'use strict';
// tests/lx-audio-proxy.test.js — 批 T8：/api/audio 上游差分增强
// 对照上游 Mineradio-LX-Music-1.7.0 server.js :3147-3204（路由）+ :366-383（audioProxyHeadersFromQuery /
// audioProxyUrl 助手）。注：计划简报引用的 :944-954 是勘误点，上游该段为无关代码，三条行为均在上述区间。
// 断言四条差分行为：
//   1) Range/If-Range 客户端头透传上游，206 + content-range/etag/last-modified 白名单回传；
//   2) url 参数 localhost 族主机名拒绝（上游 :3152 正则逐字移植，400 JSON）；
//   3) h 参数（base64url JSON）白名单头转发：accept/cookie/origin/referer/user-agent 覆盖宿主默认，
//      非白名单键丢弃、CRLF 消毒；无 h 参数 = 现状行为不回归；
//   4) HEAD 直读上游 HEAD 且不写 body；audioProxyUrl(url, headers) 生成带 h 的 proxyUrl，
//      headers 为空时回退旧 '/api/audio?url=' 形态（T7 resolve 路由债务闭环）。
// 起服方式沿用 tests/lx-source-routes.test.js 进程内 require 范式：PORT=3999 先于 server.js 加载就位，
// globalThis.fetch 在 require 之前替换为 stub（fetchWithTimeout 调用时读全局 fetch，故 /api/audio 出站全部离线）。
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = 3999;
process.env.PORT = String(PORT);
delete process.env.HOST;

// lx 宿主单例落位隔离（server.js 加载即建 lxSourceHost/lxSearch，纯卫生需要，与 T7 同款）。
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-lx-audio-'));
process.env.STELLAFLIX_USER_DATA = USER_DATA;
process.env.APPDATA = path.join(USER_DATA, 'isolated-appdata');
process.env.LOCALAPPDATA = process.env.APPDATA;

const realFetch = globalThis.fetch;
const audioRequests = []; // stub 捕获的 /api/audio 出站请求 { url, method, headers }
let upstreamReply = null; // () => { status, headers, body|null }
globalThis.fetch = async (input, init) => {
  const target = String((input && input.url) || input);
  if (target.startsWith('http://127.0.0.1:' + PORT)) return realFetch(input, init);
  audioRequests.push({
    url: target,
    method: (init && init.method) || 'GET',
    headers: Object.assign({}, (init && init.headers) || {}),
  });
  const reply = upstreamReply
    ? upstreamReply()
    : { status: 200, headers: { 'content-type': 'audio/mpeg' }, body: [Buffer.alloc(8, 1)] };
  return {
    status: reply.status,
    headers: { get: k => (Object.prototype.hasOwnProperty.call(reply.headers, String(k).toLowerCase()) ? reply.headers[String(k).toLowerCase()] : null) },
    body: reply.body === null ? null : makeBody(reply.body),
  };
};
function makeBody(chunks) {
  let index = 0;
  return {
    getReader() {
      return {
        read: async () => (index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true }),
        cancel: async () => {},
      };
    },
  };
}

const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;
const TARGET = 'https://audio.example/track.mp3';

after(() => {
  globalThis.fetch = realFetch;
  server.close();
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
});

async function waitListening() {
  if (server.listening) return;
  await new Promise(resolve => server.once('listening', resolve));
}

async function get(pathname, options = {}) {
  await waitListening();
  audioRequests.length = 0;
  const res = await realFetch(BASE + pathname, options);
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch (_) {}
  return { res, body: json, text: buf.toString('utf8'), bytes: buf };
}

function audioPathname(extra) {
  const params = new URLSearchParams({ url: TARGET });
  if (extra) for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return '/api/audio?' + params.toString();
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

// ---------- 行为 1：Range/If-Range 透传 + 206 + 响应头白名单回传 ----------
test('/api/audio：客户端 Range/If-Range 透传上游，206 与 content-range/etag/last-modified 白名单回传', async () => {
  upstreamReply = () => ({
    status: 206,
    headers: {
      'content-type': 'audio/mpeg',
      'content-length': '4',
      'content-range': 'bytes 0-3/999',
      'etag': '"seg-7"',
      'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
    },
    body: [Buffer.from([1, 2, 3, 4])],
  });
  const { res, bytes } = await get(audioPathname(), {
    headers: { Range: 'bytes=0-3', 'If-Range': '"seg-7"' },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 0-3/999');
  assert.equal(res.headers.get('etag'), '"seg-7"');
  assert.equal(res.headers.get('last-modified'), 'Wed, 21 Oct 2015 07:28:00 GMT');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(bytes.length, 4);
  assert.equal(audioRequests.length, 1);
  assert.equal(audioRequests[0].url, TARGET);
  assert.equal(audioRequests[0].headers.Range, 'bytes=0-3');
  assert.equal(audioRequests[0].headers['If-Range'], '"seg-7"');
  upstreamReply = null;
});

// ---------- 行为 2：localhost 族 url 拒绝（上游 :3152 正则逐字） ----------
test('/api/audio：url=localhost / 0.0.0.0 / [::1] 一律 400 + LOCAL_AUDIO_URL_BLOCKED；非法协议 400 + INVALID_AUDIO_URL', async () => {
  for (const bad of [
    'http://localhost:9999/song.mp3',
    'http://LOCALHOST/song.mp3',
    'http://0.0.0.0/song.mp3',
    'http://[::1]:8080/song.mp3',
  ]) {
    const { res, body } = await get(audioPathname({ url: bad }));
    assert.equal(res.status, 400, bad);
    assert.equal(body.ok, false, bad);
    assert.equal(body.error, 'LOCAL_AUDIO_URL_BLOCKED', bad);
  }
  const file = await get(audioPathname({ url: 'file:///C:/Windows/song.mp3' }));
  assert.equal(file.res.status, 400);
  assert.equal(file.body.error, 'INVALID_AUDIO_URL');
  // 校验发生在任何上游请求之前（SSRF 面覆盖 qishui #auth= 解密路径）。
  assert.equal(audioRequests.length, 0);
});

// ---------- 行为 3：h 参数白名单头转发 ----------
test('/api/audio：h 白名单头（accept/cookie/origin/referer/user-agent）覆盖宿主默认；非白名单键丢弃、CRLF 消毒', async () => {
  const h = base64urlJson({
    cookie: 'nse=T; other=1',
    'user-agent': 'lx-test-agent',
    referer: 'https://ref.example/page\r\nX-Injected: 1',
    origin: 'https://player.example',
    accept: 'audio/*',
    'x-evil': 'should-be-dropped',
    Range: 'bytes=9-9', // range 不在白名单：h 不得携带 Range
  });
  const { res } = await get(audioPathname({ h }));
  assert.equal(res.status, 200);
  assert.equal(audioRequests.length, 1);
  const hdr = audioRequests[0].headers;
  assert.equal(hdr.cookie, 'nse=T; other=1');
  assert.equal(hdr['user-agent'], 'lx-test-agent');
  assert.equal(hdr.origin, 'https://player.example');
  assert.equal(hdr.accept, 'audio/*');
  // 大小写无关覆盖：宿主默认 User-Agent/Referer 不得与被覆盖的旧值同时残留
  assert.equal(hdr['User-Agent'], undefined);
  assert.equal(hdr.Referer, undefined);
  // CRLF 消毒（上游 :373 replace(/[\r\n]+/g, ' ')）：转发值不含换行
  assert.equal(hdr.referer, 'https://ref.example/page X-Injected: 1');
  // 非白名单键丢弃
  assert.equal(hdr['x-evil'], undefined);
  assert.equal(JSON.stringify(hdr).includes('should-be-dropped'), false);
  // h 无 range 键 → 不注入 Range（客户端未带头时上游请求也不应有）
  assert.equal(hdr.Range, undefined);
});

test('/api/audio：无 h 参数 = 现状行为不回归（宿主默认 UA + 逐站 Referer 派生）', async () => {
  const { res } = await get(audioPathname());
  assert.equal(res.status, 200);
  const hdr = audioRequests[0].headers;
  assert.match(String(hdr['User-Agent']), /^Mozilla\/5\.0/);
  assert.equal(hdr.Referer, 'https://music.163.com/'); // audio.example 无特判 → 默认
  assert.equal(hdr.cookie, undefined);
});

// ---------- 行为 4：HEAD + audioProxyUrl/audioProxyHeadersFromQuery 助手（T7 债务） ----------
test('/api/audio：HEAD 直读上游 HEAD，状态与长度头回传且不写 body', async () => {
  upstreamReply = () => ({
    status: 200,
    headers: { 'content-type': 'audio/mpeg', 'content-length': '999' },
    body: null, // HEAD 上游无 body
  });
  await waitListening();
  audioRequests.length = 0;
  const res = await realFetch(BASE + audioPathname(), { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), '999');
  assert.equal(Buffer.from(await res.arrayBuffer()).length, 0);
  assert.equal(audioRequests[0].method, 'HEAD');
  upstreamReply = null;
});

test('server.audioProxyUrl / audioProxyHeadersFromQuery 助手暴露：带 headers 走 h，空 headers 回退旧 url= 形态', () => {
  assert.equal(typeof server.audioProxyUrl, 'function');
  assert.equal(typeof server.audioProxyHeadersFromQuery, 'function');
  // 空/缺省 headers → 与 T7 前 '/api/audio?url=' + encodeURIComponent(url) 逐字一致（旧形态仍工作）
  assert.equal(
    server.audioProxyUrl('https://fake.example/song.mp3', {}),
    '/api/audio?url=' + encodeURIComponent('https://fake.example/song.mp3'),
  );
  assert.equal(server.audioProxyUrl('', {}), '');
  // 带 headers → 追加 h（base64url JSON），且能被 audioProxyHeadersFromQuery 还原（白名单内键）
  const withHeaders = server.audioProxyUrl('https://fake.example/song.mp3', { cookie: 'k=1', 'user-agent': 'lx' });
  const params = new URL('http://base.local' + withHeaders).searchParams;
  assert.equal(params.get('url'), 'https://fake.example/song.mp3');
  assert.deepEqual(server.audioProxyHeadersFromQuery(params.get('h')), { cookie: 'k=1', 'user-agent': 'lx' });
  // 坏 h 值不炸：解析失败回退空对象（上游 :357-364 try/catch 语义）
  assert.deepEqual(server.audioProxyHeadersFromQuery('%%%not-base64%%%'), {});
  assert.deepEqual(server.audioProxyHeadersFromQuery(null), {});
});
