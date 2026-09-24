// /api/proxy 图片服务端磁盘缓存测试（海报墙跨启动/跨端口不再重拉远程图）：
//   ① 图片 GET 200 首次 MISS → 落盘；二次请求 HIT
//   ② 新进程（模拟重启）仍 HIT：缓存持久化在 SFV_CACHE_DIR
//   ③ 带 Range 的图片请求不新增缓存对象；非图片 JSON 不落盘
//   ④ 上游 Cache-Control 透传（A 方案语义不回退）
// 用子进程起服务：SFV_CACHE_DIR/PORT 需在 server.js 模块加载前就位。
// 上游必须走真实公网小图（bing favicon，实测可达且 image/x-icon）——
// SSRF 守卫 isPrivateHost 会拦 127.0.0.1 桩服务，无法本地伪造。
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const PORT = 39878;
const CACHE_DIR = path.join(__dirname, '.tmp-proxy-img-cache');
const BASE = 'http://127.0.0.1:' + PORT;
const UPSTREAM_TARGET = 'https://www.bing.com/favicon.ico';

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      SFV_CACHE_DIR: CACHE_DIR,
      NODE_NO_WARNINGS: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.join(__dirname, '..'),
  });
  const log = { child, out: '' };
  child.stdout.on('data', (b) => { log.out += b.toString(); });
  child.stderr.on('data', (b) => { log.out += b.toString(); });
  log.waitPort = new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    (function poll() {
      const s = net.connect(PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        if (Date.now() > deadline) reject(new Error('server not up\n' + log.out));
        else setTimeout(poll, 150);
      });
    })();
  });
  log.stop = () => new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 3000);
  });
  return log;
}

async function proxyFetch(extraHeaders) {
  const target = encodeURIComponent(UPSTREAM_TARGET);
  return fetch(BASE + '/api/proxy?url=' + target, { headers: extraHeaders || {} });
}

function cacheFiles() {
  if (!fs.existsSync(CACHE_DIR)) return [];
  return fs.readdirSync(CACHE_DIR).filter((f) => !f.endsWith('.meta'));
}

test('图片经 /api/proxy：二次请求命中磁盘缓存且落盘，HIT 不再打上游', async () => {
  rmrf(CACHE_DIR);
  const log = startServer();
  try {
    await log.waitPort;
    const r1 = await proxyFetch();
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('x-sfv-img-cache'), null, '首次 MISS 不打 HIT 标');
    assert.match(r1.headers.get('cache-control') || '', /max-age/, 'A 方案透传语义保持');
    const b1 = Buffer.from(await r1.arrayBuffer());

    const r2 = await proxyFetch();
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('x-sfv-img-cache'), 'HIT');
    const b2 = Buffer.from(await r2.arrayBuffer());
    assert.deepEqual(b2, b1, '缓存字节内容必须一致');

    assert.ok(cacheFiles().length >= 1, '磁盘上有缓存对象');
  } finally { await log.stop(); }
});

test('新进程（模拟重启）仍命中磁盘缓存', async () => {
  const log = startServer();
  try {
    await log.waitPort;
    const r = await proxyFetch();
    assert.equal(r.headers.get('x-sfv-img-cache'), 'HIT', '跨进程持久命中');
    await r.arrayBuffer();
  } finally { await log.stop(); }
});

test('带 Range 的图片请求不写磁盘缓存', async () => {
  const log = startServer();
  try {
    await log.waitPort;
    const before = cacheFiles().length;
    const r = await proxyFetch({ Range: 'bytes=0-3' });
    assert.ok(r.status === 206 || r.status === 200);
    await r.arrayBuffer();
    assert.equal(cacheFiles().length, before, 'Range 请求不得新增缓存对象');
  } finally { await log.stop(); }
});

test('非图片 JSON 响应不进磁盘缓存目录', async () => {
  const log = startServer();
  try {
    await log.waitPort;
    const before = cacheFiles().length;
    const r = await fetch(BASE + '/api/proxy?url=' + encodeURIComponent('https://api.tmdb.org/3/configuration?api_key=x'));
    await r.arrayBuffer();
    assert.ok(r.status === 200 || r.status === 401);
    assert.equal(cacheFiles().length, before);
  } finally { await log.stop(); }
});

process.on('exit', () => rmrf(CACHE_DIR));
