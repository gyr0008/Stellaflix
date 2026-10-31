'use strict';
// tests/lx-source-routes.test.js — 批 T7：/api/lx-source/* 路由族 + 本地信任闸 e2e
// 起服方式沿用 tests/local-api-origin-guard.test.js 的进程内 require 范式（PORT 需先于
// server.js 模块加载就位）；测试端口 3999 与既有 e2e 的 398xx 段互不冲突（run-all.js 逐文件串行）。
// 封闭网络：globalThis.fetch 在 require('../server.js') 之前替换为路由表 stub ——
// lx-source-host / lx-search 单例都在 server 模块加载时捕获 fetch（工厂默认参求值时刻），
// 因此爬虫、脚本下载与音频探测全部离线可测。
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = 3999;
process.env.PORT = String(PORT);
delete process.env.HOST;

// 裁决7：host 单例 userDataPath 取 env STELLAFLIX_USER_DATA —— 指向临时目录。
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-lx-routes-'));
process.env.STELLAFLIX_USER_DATA = USER_DATA;
// 隔离本机真实 lx-music-desktop LxDatas 自动迁移目录（同 tests/lx-source-host.test.js:18-19 手法）。
process.env.APPDATA = path.join(USER_DATA, 'isolated-appdata');
process.env.LOCALAPPDATA = process.env.APPDATA;

const realFetch = globalThis.fetch;
const stubRoutes = new Map(); // url 前缀 -> (url, init) => response
globalThis.fetch = async (input, init) => {
  const url = String((input && input.url) || input);
  if (url.startsWith('http://127.0.0.1:' + PORT)) return realFetch(input, init);
  for (const [prefix, make] of stubRoutes) {
    if (url.startsWith(prefix)) return make(url, init);
  }
  throw new Error('LX_TEST_FETCH_UNROUTED:' + url);
};

const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;

after(() => {
  globalThis.fetch = realFetch;
  server.close();
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
});

async function waitListening() {
  if (server.listening) return;
  await new Promise(resolve => server.once('listening', resolve));
}

async function apiJson(pathname, options = {}) {
  await waitListening();
  const res = await realFetch(BASE + pathname, options);
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, body };
}

// 错误路径会被宿主/路由 console.warn（[LXSourceResolve] 等），测试内静音保持输出纯净。
async function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
}

function jsonResponse(payload, status = 200) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { forEach() {} },
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

// 测试脚本：musicUrl 返回固定 URL（探测走 unrouted 桩 → advisory probeWarning，URL 仍返回）；
// lyric 返回歌词 —— tests/fixtures/lx-fake-source.js（T1）无 lyric 分支，故本文件内联扩展。
function lxScript(name, mode = 'ok') {
  const musicUrlReply = mode === 'fail'
    ? "{ ok: false, msg: 'LX_TEST_URL_FAIL' }"
    : mode === 'headers'
      ? "{ ok: true, url: 'https://fake.example/song-h.mp3', quality: task.info && task.info.quality, headers: { 'user-agent': 'lx-fixture-ua', referer: 'https://fixture.example/', cookie: 'k=1', 'x-evil': 'should-be-sanitized' } }"
      : "{ ok: true, url: 'https://fake.example/song.mp3', quality: task.info && task.info.quality }";
  return [
    '/*',
    ` * @name ${name}`,
    ' * @description route fixture',
    ' * @version 1.0.0',
    ' * @author test',
    ' */',
    ';(function () {',
    '  if (typeof lx === "undefined") return',
    '  lx.on("request", function (task) {',
    '    if (task.action === "musicUrl") return ' + musicUrlReply,
    '    if (task.action === "lyric") return { lyric: "[00:00.00]测试歌词", tlyric: "[00:00.00]trans" }',
    '    return { ok: false, msg: "LX_TEST_UNKNOWN_ACTION" }',
    '  })',
    `  lx.send("inited", { name: "${name}", sources: { kg: { qualitys: ["128k", "320k", "flac"] } } })`,
    '})()',
  ].join('\n');
}

// ---------- 闸：isTrustedLocalApiRequest 分支直测（移植上游 server.js:311-323） ----------
test('isTrustedLocalApiRequest：cross-site 拒 / 无 Origin 放行 / 本机端口匹配放行 / 异端口与异协议拒', () => {
  assert.equal(typeof server.isTrustedLocalApiRequest, 'function');
  const g = server.isTrustedLocalApiRequest;
  assert.equal(g({ headers: { 'sec-fetch-site': 'cross-site' } }), false);
  assert.equal(g({ headers: { 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:' + PORT } }), false);
  assert.equal(g({ headers: {} }), true);                       // 本机无头流量（curl / Electron 主进程）
  assert.equal(g({ headers: { origin: 'null' } }), true);       // file:// 等 null origin 放行（上游同款）
  assert.equal(g({ headers: { origin: 'http://127.0.0.1:' + PORT } }), true);
  assert.equal(g({ headers: { origin: 'http://localhost:' + PORT } }), true);
  assert.equal(g({ headers: { origin: 'http://evil.example.com' } }), false);
  assert.equal(g({ headers: { origin: 'http://127.0.0.1:19999' } }), false); // 端口不符
  assert.equal(g({ headers: { origin: 'https://localhost:' + PORT } }), false); // 非 http 协议
  assert.equal(g({ headers: { origin: 'not-a-url' } }), false);
});

test('闸 HTTP 层：GET /api/lx-source/search 携带 cross-site 或外部 Origin 一律 403', async () => {
  await waitListening();
  const a = await apiJson('/api/lx-source/search?q=x', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(a.status, 403);
  assert.equal(a.body.ok, false);
  assert.equal(a.body.code, 'FORBIDDEN_ORIGIN');
  const b = await apiJson('/api/lx-source/search?q=x', { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(b.status, 403);
  assert.equal(b.body.code, 'FORBIDDEN_ORIGIN');
  // 同源窗口不被误伤（走到业务层而非闸口）。
  const c = await apiJson('/api/lx-source/status', { headers: { Origin: 'http://127.0.0.1:' + PORT } });
  assert.equal(c.status, 200);
});

// ---------- 引导态：空库 status / resolve LX_NO_SOURCES（裁决6 我方新增码） ----------
test('GET /api/lx-source/status 空库返回 {ok:true, sources:[], active:null}', async () => {
  const { status, body } = await apiJson('/api/lx-source/status');
  assert.equal(status, 200);
  assert.deepEqual({ ok: body.ok, sources: body.sources, active: body.active }, { ok: true, sources: [], active: null });
});

test('POST /api/lx-source/resolve 未装脚本时 200 + ok:false 且带引导码 LX_NO_SOURCES', async () => {
  const { status, body } = await apiJson('/api/lx-source/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'kg', quality: '320k', musicInfo: { name: 't', singer: 's' } }),
  });
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'LX_NO_SOURCES');
  assert.equal(typeof body.error, 'string');
});

// ---------- import ----------
let idA = '';
let idB = '';
test('POST /api/lx-source/import 脚本正文导入成功返回 {ok,id,meta}', async () => {
  const { status, body } = await apiJson('/api/lx-source/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: '主脚本.js', script: lxScript('主脚本') }),
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.id, 'string');
  assert.equal(body.meta.name, '主脚本');
  idA = body.id;
});

test('POST /api/lx-source/import url 通道经 host 下载器导入', async () => {
  stubRoutes.set('http://script.example/lx.js', () => jsonResponse(lxScript('URL脚本')));
  const { status, body } = await apiJson('/api/lx-source/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://script.example/lx.js' }),
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.meta.name, 'URL脚本');
  idB = body.id;
  assert.notEqual(idA, idB);
});

test('POST /api/lx-source/import 下载 HTTP 500 → 400 + code LX_SOURCE_DOWNLOAD_HTTP_500', async () => {
  stubRoutes.set('http://bad-script.example/lx.js', () => jsonResponse('nope', 500));
  const { status, body } = await apiJson('/api/lx-source/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://bad-script.example/lx.js' }),
  });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'LX_SOURCE_DOWNLOAD_HTTP_500');
});

test('POST /api/lx-source/import 空脚本 → 400 + code LX_SOURCE_FILE_INVALID；GET → 405', async () => {
  const bad = await apiJson('/api/lx-source/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'LX_SOURCE_FILE_INVALID');
  const method = await apiJson('/api/lx-source/import');
  assert.equal(method.status, 405);
  assert.equal(method.body.code, 'METHOD_NOT_ALLOWED');
});

// ---------- status（有库存活态） ----------
test('导入后 status 返回 {sources:[两条], active:idB} 且保留兼容字段 installed/name/version', async () => {
  const { status, body } = await apiJson('/api/lx-source/status');
  assert.equal(status, 200);
  assert.equal(body.sources.length, 2);
  assert.equal(body.active, idB); // 最新导入者成为 active
  const row = body.sources.find(item => item.id === idB);
  assert.equal(row.current, true);
  assert.equal(row.enabled, true);
  assert.deepEqual(Object.keys(row.sources), ['kg']);
  // 兼容字段（旧桩形态，agent-music-tools.js:516 仍读 installed/name/version —— T9/T10 统一退役）
  assert.equal(body.installed.length, 2);
  assert.equal(body.name, 'URL脚本');
  assert.equal(body.enabledCount, 2);
});

// ---------- resolve ----------
const resolveBody = extra => JSON.stringify(Object.assign(
  { source: 'kg', quality: '320k', musicInfo: { type: 'music', name: '测试歌', singer: '测试歌手', songmid: 'KG123' } },
  extra || {}
));

test('POST /api/lx-source/resolve 成功返回 url/proxyUrl（/api/audio?url= 约定；headers 空则不带 h，T8 已闭环）', async () => {
  const { status, body } = await apiJson('/api/lx-source/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: resolveBody(),
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.source, 'kg');
  assert.equal(body.url, 'https://fake.example/song.mp3');
  assert.equal(body.quality, '320k');
  assert.equal(body.proxyUrl, '/api/audio?url=' + encodeURIComponent('https://fake.example/song.mp3'));
  // 探测桩 unrouted → advisory probeWarning（上游 :1163-1184 语义），URL 仍可用。
  assert.match(String(body.probeWarning), /LX_TEST_FETCH_UNROUTED/);
  assert.equal(body.code, undefined);
});

test('resolve 同参数 90s 内二次命中缓存 cached:true 且仍带 proxyUrl', async () => {
  const { body } = await apiJson('/api/lx-source/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: resolveBody(),
  });
  assert.equal(body.ok, true);
  assert.equal(body.cached, true);
  assert.equal(body.proxyUrl, '/api/audio?url=' + encodeURIComponent('https://fake.example/song.mp3'));
});

// ---------- T8 还债：resolve 播放头 headers 经 audioProxyUrl 随 proxyUrl h 参数透传 ----------
test('resolve 播放头非空时 proxyUrl 携带 h（base64url JSON 白名单头；批 T8，旧 url= 形态不变）', async () => {
  const imp = await apiJson('/api/lx-source/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: '带头脚本.js', script: lxScript('带头脚本', 'headers') }),
  });
  assert.equal(imp.status, 200);
  const idC = imp.body.id;
  try {
    const { status, body } = await apiJson('/api/lx-source/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kg', quality: '320k', musicInfo: { type: 'music', name: '带头测试歌', singer: 's', songmid: 'KG-H' } }),
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    // 宿主 sanitizePlaybackHeaders 白名单外键（x-evil）已被剔除
    assert.deepEqual(body.headers, { 'user-agent': 'lx-fixture-ua', referer: 'https://fixture.example/', cookie: 'k=1' });
    const params = new URLSearchParams(String(body.proxyUrl).replace('/api/audio?', ''));
    assert.equal(params.get('url'), 'https://fake.example/song-h.mp3');
    const h = Buffer.from(String(params.get('h')), 'base64url').toString('utf8');
    assert.deepEqual(JSON.parse(h), body.headers);
    // 二次命中缓存后 h 仍随 proxyUrl 在（缓存值含 headers）。
    const again = await apiJson('/api/lx-source/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kg', quality: '320k', musicInfo: { type: 'music', name: '带头测试歌', singer: 's', songmid: 'KG-H' } }),
    });
    assert.equal(again.body.cached, true);
    assert.equal(again.body.proxyUrl, body.proxyUrl);
  } finally {
    await apiJson('/api/lx-source/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: idC }),
    });
  }
});

test('resolve 全链失败 → 502 + 中文终态映射为机器码 LX_SOURCE_RESOLVE_ALL_FAILED', async () => {
  const { status, body } = await quiet(() => apiJson('/api/lx-source/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: resolveBody({ source: 'tx' }), // 已装脚本仅支持 kg → 每个 resolver 都 LX_QUALITY_UNSUPPORTED → 终态
  }));
  assert.equal(status, 502);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'LX_SOURCE_RESOLVE_ALL_FAILED');
  assert.equal(body.error, '当前音源及备用音源均解析失败，请切换音源后重试');
});

// ---------- lyric（getLyric 由 T7 移植，上游 lx-source-host.js:1220-1237） ----------
test('POST /api/lx-source/lyric 成功返回 {ok,source,lyric,tlyric,rlyric,lxlyric}', async () => {
  const { status, body } = await apiJson('/api/lx-source/lyric', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'kg', musicInfo: { type: 'music', name: '测试歌', singer: '测试歌手' } }),
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.source, 'kg');
  assert.equal(body.lyric, '[00:00.00]测试歌词');
  assert.equal(body.tlyric, '[00:00.00]trans');
  assert.equal(body.rlyric, '');
  assert.equal(body.lxlyric, '');
});

test('POST /api/lx-source/lyric 未支持源 → 502 + code LX_SOURCE_UNSUPPORTED', async () => {
  const { status, body } = await quiet(() => apiJson('/api/lx-source/lyric', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'wy', musicInfo: { name: 't' } }),
  }));
  assert.equal(status, 502);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'LX_SOURCE_UNSUPPORTED');
});

// ---------- select / toggle / check / delete ----------
test('POST /api/lx-source/select 切换当前脚本；未知 id 400 + LX_SOURCE_NOT_FOUND', async () => {
  const ok = await apiJson('/api/lx-source/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: idA }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.id, idA);
  assert.equal(ok.body.name, '主脚本');
  assert.equal(ok.body.installed.length, 2);
  const bad = await apiJson('/api/lx-source/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'nope' }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'LX_SOURCE_NOT_FOUND');
});

test('POST /api/lx-source/toggle 禁用非 active 脚本后回启用；未知 id 400', async () => {
  const off = await apiJson('/api/lx-source/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [idB], enabled: false }),
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.ok, true);
  assert.equal(off.body.installed.find(item => item.id === idB).enabled, false);
  // 试图禁用最后一个启用中的 active 脚本 → 保留至少一条（host LX_SOURCE_AT_LEAST_ONE_ENABLED）。
  const last = await quiet(() => apiJson('/api/lx-source/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [idA, idB], enabled: false }),
  }));
  assert.equal(last.status, 400);
  assert.equal(last.body.code, 'LX_SOURCE_AT_LEAST_ONE_ENABLED');
  const on = await apiJson('/api/lx-source/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: idB, enabled: true }),
  });
  assert.equal(on.status, 200);
  assert.equal(on.body.installed.find(item => item.id === idB).enabled, true);
  const bad = await apiJson('/api/lx-source/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ['nope'], enabled: false }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'LX_SOURCE_NOT_FOUND');
});

test('POST /api/lx-source/check 返回逐源结果数组；显式空 ids 400 + LX_SOURCE_IDS_REQUIRED', async () => {
  const ok = await apiJson('/api/lx-source/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [idA] }),
  });
  assert.equal(ok.status, 200);
  assert.equal(Array.isArray(ok.body), true);
  assert.equal(ok.body[0].id, idA);
  assert.equal(ok.body[0].ok, true);
  assert.deepEqual(ok.body[0].sources, ['kg']);
  const all = await apiJson('/api/lx-source/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(all.status, 200);
  assert.equal(all.body.length, 2);
  const bad = await apiJson('/api/lx-source/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [] }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'LX_SOURCE_IDS_REQUIRED');
});

// ---------- search（stub fetch 喂酷我爬虫，冻结 8 键 song 形状） ----------
test('GET /api/lx-source/search 聚合返回 {ok,songs,failures}，song 为冻结 8 键', async () => {
  stubRoutes.set('https://search.kuwo.cn/r.s', () => jsonResponse({
    abslist: [{
      MUSICRID: 'MUSIC_900001', SONGNAME: '酷我测试歌', ARTIST: '酷我歌手', ALBUM: '酷我专辑',
      DURATION: 240, picUrl: 'https://img1.kuwo.cn/star/albumcover/500/12/34/abcd.jpg',
    }],
  }));
  const { status, body } = await apiJson('/api/lx-source/search?q=' + encodeURIComponent('酷我测试歌') + '&sources=kw&limit=5');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.songs.length, 1);
  assert.deepEqual(Object.keys(body.songs[0]), ['source', 'id', 'songmid', 'name', 'singer', 'album', 'interval', 'pic']);
  assert.equal(body.songs[0].source, 'kw');
  assert.equal(body.songs[0].id, '900001');
  assert.equal(body.songs[0].interval, '4:00');
  assert.deepEqual(body.failures, []);
});

test('GET /api/lx-source/search 无 q → 200 空结果；全源失败 → 502 ok:false 带 failures', async () => {
  const empty = await apiJson('/api/lx-source/search');
  assert.equal(empty.status, 200);
  assert.deepEqual({ ok: empty.body.ok, songs: empty.body.songs, failures: empty.body.failures }, { ok: true, songs: [], failures: [] });
  stubRoutes.delete('https://search.kuwo.cn/r.s'); // unrouted 桩抛错 → 爬虫失败
  const fail = await quiet(() => apiJson('/api/lx-source/search?q=' + encodeURIComponent('全败测试') + '&sources=kw'));
  assert.equal(fail.status, 502);
  assert.equal(fail.body.ok, false);
  assert.deepEqual(fail.body.songs, []);
  assert.equal(fail.body.failures[0].source, 'kw');
});

// ---------- delete ----------
test('POST /api/lx-source/delete 单删返回剩余 installed；未知 id 400 + LX_SOURCE_NOT_FOUND', async () => {
  const del = await apiJson('/api/lx-source/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: idB }),
  });
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);
  assert.equal(del.body.installed.length, 1);
  const bad = await apiJson('/api/lx-source/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ['nope'] }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'LX_SOURCE_NOT_FOUND');
  const status = await apiJson('/api/lx-source/status');
  assert.equal(status.body.active, idA);
  assert.equal(status.body.sources.length, 1);
});

test('批删 delete ids 数组成功；仍未移植的子路径落 404', async () => {
  const second = await apiJson('/api/lx-source/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: '待批删.js', script: lxScript('待批删') }),
  });
  assert.equal(second.status, 200);
  const del = await apiJson('/api/lx-source/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [second.body.id] }),
  });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, 1);
  // 批 T15.5a 已补移植 playlist-search（形状断言见 tests/lx-metadata-routes.test.js）；
  // song-cover-search 经查本仓无消费方仍不建 → 前缀下未知子路径继续 404。
  const gone = await apiJson('/api/lx-source/trending');
  assert.equal(gone.status, 404);
  assert.equal(gone.body.code, 'LX_ROUTE_NOT_FOUND');
});
