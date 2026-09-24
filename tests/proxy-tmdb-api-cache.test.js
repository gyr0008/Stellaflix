// TMDB API 响应服务端缓存测试（detail/海报墙二次打开仍要等远程 JSON 往返）：
//   ① api.tmdb.org /3/ 路径的 GET JSON 200 → 第二次请求命中内存缓存，不再打上游
//   ② 缓存键不含 api_key（换 key 不误 miss；key 不落缓存元数据）
//   ③ 非 /3/ 目标不缓存；带 Range 不缓存；非 200 不缓存
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');

const PORT = 39876;
process.env.PORT = String(PORT);
delete process.env.HOST;

const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;
const realFetch = globalThis.fetch;

let upstreamCalls = [];
function stubUpstream(headers, body, status) {
  globalThis.fetch = async (input) => {
    upstreamCalls.push(String(typeof input === 'string' ? input : input.url));
    return new Response(body, { status: status || 200, headers });
  };
}

async function waitListening() {
  if (server.listening) return;
  await new Promise((resolve) => server.once('listening', resolve));
}

const JSON_HDRS = { 'content-type': 'application/json; charset=utf-8' };

test('TMDB /3/ JSON GET：二次请求命中缓存，不再打上游', async () => {
  await waitListening();
  upstreamCalls = [];
  stubUpstream(JSON_HDRS, '{"page":1,"results":[1,2,3]}');
  try {
    const target = encodeURIComponent('https://api.tmdb.org/3/movie/popular?api_key=K1&page=1');
    const r1 = await realFetch(BASE + '/api/proxy?url=' + target);
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { page: 1, results: [1, 2, 3] });
    assert.equal(r1.headers.get('x-tmdb-cache'), null, '首次为 MISS');

    const r2 = await realFetch(BASE + '/api/proxy?url=' + target);
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('x-tmdb-cache'), 'HIT');
    assert.deepEqual(await r2.json(), { page: 1, results: [1, 2, 3] });
    assert.equal(upstreamCalls.length, 1, '第二次不应再打上游');
  } finally { globalThis.fetch = realFetch; }
});

test('缓存键剥离 api_key：换 key 不产生第二份上游请求', async () => {
  await waitListening();
  upstreamCalls = [];
  stubUpstream(JSON_HDRS, '{"ok":true}');
  try {
    await realFetch(BASE + '/api/proxy?url=' + encodeURIComponent('https://api.tmdb.org/3/trending/movie/week?api_key=AAA'));
    const r = await realFetch(BASE + '/api/proxy?url=' + encodeURIComponent('https://api.tmdb.org/3/trending/movie/week?api_key=BBB'));
    assert.equal(r.headers.get('x-tmdb-cache'), 'HIT');
    assert.equal(upstreamCalls.length, 1);
    await r.json();
  } finally { globalThis.fetch = realFetch; }
});

test('非 /3/ 路径不缓存；带 Range 不缓存；非 200 不缓存', async () => {
  await waitListening();
  upstreamCalls = [];
  stubUpstream(JSON_HDRS, '{"x":1}');
  try {
    // 非 /3/ 目标
    const other = BASE + '/api/proxy?url=' + encodeURIComponent('https://other.example.com/data.json');
    await (await realFetch(other)).json();
    const rOther2 = await realFetch(other);
    assert.equal(rOther2.headers.get('x-tmdb-cache'), null);
    await rOther2.json();

    // 带 Range
    const t = encodeURIComponent('https://api.tmdb.org/3/movie/upcoming?page=2');
    const rRange = await realFetch(BASE + '/api/proxy?url=' + t, { headers: { Range: 'bytes=0-10' } });
    assert.equal(rRange.headers.get('x-tmdb-cache'), null);
    await rRange.json();

    // 非 200（401 认证失败不得进缓存）
    const t401 = BASE + '/api/proxy?url=' + encodeURIComponent('https://api.tmdb.org/3/configuration?api_key=BAD');
    globalThis.fetch = async (input) => {
      upstreamCalls.push(String(typeof input === 'string' ? input : input.url));
      return new Response('{"status_code":7}', { status: 401, headers: JSON_HDRS });
    };
    const r401a = await realFetch(t401);
    assert.equal(r401a.status, 401);
    await r401a.text();
    const r401b = await realFetch(t401);
    assert.equal(r401b.headers.get('x-tmdb-cache'), null, '401 不该命中缓存');
    await r401b.text();
    const cacheableCalls = upstreamCalls.filter((u) => u.includes('/data.json') || u.includes('/movie/upcoming') || u.includes('/configuration'));
    assert.equal(cacheableCalls.length, 5, '三种场景每次都打了上游');
  } finally { globalThis.fetch = realFetch; }
});

after(() => { server.close(); });
