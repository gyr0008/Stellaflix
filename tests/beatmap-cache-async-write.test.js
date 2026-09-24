'use strict';

/**
 * B3 e2e 验证：beatmap 缓存异步写
 * 运行：node tests/beatmap-cache-async-write.test.js
 * 覆盖：POST /api/beatmap/cache 异步落盘（tmp+rename 原子性）+ GET 读回 + .tmp 不残留
 * 以及音频流代理与 beatmap 写并存的冒烟（B3 的核心诉求：写盘不阻塞事件循环）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 39873;
process.env.PORT = String(PORT);
// 产品策略禁止 beat 缓存落 C 盘（BEAT_CACHE_ON_C_DRIVE_DISABLED），
// 而 Windows 下 os.tmpdir() 通常在 C 盘，故优先选非 C 盘临时目录。
const cacheDir = makeBeatCacheDir();
process.env.STELLAFLIX_BEAT_CACHE_DIR = cacheDir;

function makeBeatCacheDir() {
  const fromTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-beat-cache-'));
  if (path.parse(fromTmp).root.toUpperCase() !== 'C:\\') return fromTmp;
  try { fs.rmSync(fromTmp, { recursive: true, force: true }); } catch (_) {}
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = letter + ':\\';
    if (!fs.existsSync(root)) continue;
    try {
      return fs.mkdtempSync(path.join(root, 'stellaflix-beat-cache-'));
    } catch (_) {}
  }
  throw new Error('beat cache policy forbids C: drive and no other writable drive is available');
}

const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;

async function ready() {
  if (server.listening) return;
  await new Promise((resolve) => server.once('listening', resolve));
}

test('beatmap cache: async write persists, read-back hits, no .tmp residue', async () => {
  await ready();
  const key = 'sf-b3-async-write-probe';
  const map = { beats: [0.5, 1.25, 2.0, 2.75], bpm: 128 };

  const post = await fetch(BASE + '/api/beatmap/cache', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, map, provider: 'probe', title: 'B3 Probe', artist: 'audit' }),
  });
  assert.equal(post.status, 200);
  const written = await post.json();
  assert.equal(written.ok, true, 'POST 应成功: ' + JSON.stringify(written));
  assert.equal(written.key, key);

  // 1. 落盘：目录里恰好一个 json，且无 .tmp 残留（rename 完成）
  const files = fs.readdirSync(cacheDir);
  assert.equal(files.length, 1, '应恰好 1 个缓存文件: ' + files.join(','));
  assert.ok(files[0].endsWith('.json'), '应为 .json: ' + files[0]);
  assert.ok(!files[0].endsWith('.tmp'), '不得残留 .tmp: ' + files[0]);

  // 2. 读回：GET hit
  const get = await fetch(BASE + '/api/beatmap/cache?key=' + encodeURIComponent(key));
  assert.equal(get.status, 200);
  const entry = await get.json();
  assert.equal(entry.ok, true);
  assert.equal(entry.hit, true, 'GET 应命中缓存');
  assert.deepEqual(entry.map, map, 'map 应逐字段一致');

  // 3. 非法 payload：返回结构化错误（不崩 server）
  const bad = await fetch(BASE + '/api/beatmap/cache', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: '', map: null }),
  });
  assert.equal(bad.status, 200);
  const badBody = await bad.json();
  assert.equal(badBody.ok, false);
  assert.equal(badBody.error, 'INVALID_BEATMAP_CACHE_PAYLOAD');

  // 4. 冒烟：写缓存期间事件循环仍可响应（并发请求全部 200）
  const burst = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    fetch(BASE + '/api/beatmap/cache', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key + '-burst-' + i, map }),
    }).then((r) => r.status)));
  assert.ok(burst.every((s) => s === 200), '并发 20 写全部 200: ' + burst.join(','));
});

test.after?.(() => {
  try { server.close(); } catch (_) {}
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
});
