'use strict';

/**
 * HLS 客户端超时 与 /api/proxy 出站超时 对齐契约（2026-09-27 控制台审查·超时错配）
 * 契约：
 *   ① server.js /api/proxy 的 PROXY_TIMEOUT_MS（上游响应头等待上限）是固定值
 *   ② source-adapter-hls.js 走同一代理的 manifest/level/frag 三类 LoadingTimeOut
 *      必须【严格大于】PROXY_TIMEOUT_MS——否则 CDN 慢时 hls.js 先于代理 502 判超时，
 *      重试打同一慢源形成「超时→重试→再超时」循环，且旧上游请求在 server 侧悬挂浪费。
 * 运行：node --test tests/hls-proxy-timeout-alignment.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const serverSrc = read('server.js');
const hlsSrc = read('public/video/source-adapter-hls.js');

const num = (src, re, what) => {
  const m = re.exec(src);
  assert.ok(m, what + ' not found');
  return Number(m[1]);
};

test('server.js /api/proxy exposes PROXY_TIMEOUT_MS', () => {
  const v = num(serverSrc, /const PROXY_TIMEOUT_MS = (\d+);/, 'PROXY_TIMEOUT_MS');
  assert.ok(v > 0);
});

for (const key of ['manifestLoadingTimeOut', 'levelLoadingTimeOut', 'fragLoadingTimeOut']) {
  test(key + ' must exceed proxy upstream timeout', () => {
    const proxyTimeout = num(serverSrc, /const PROXY_TIMEOUT_MS = (\d+);/, 'PROXY_TIMEOUT_MS');
    const hlsTimeout = num(hlsSrc, new RegExp(key + ': (\\d+)'), key);
    assert.ok(hlsTimeout > proxyTimeout,
      key + '=' + hlsTimeout + 'ms <= PROXY_TIMEOUT_MS=' + proxyTimeout + 'ms, client aborts before proxy 502');
  });
}
