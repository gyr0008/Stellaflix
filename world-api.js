'use strict';

/**
 * Stellaflix — 世界页服务端基础设施（M4 内容源已按产品转向移除）
 *
 * 保留的都是**可复用的工程件**，供 M5「房间信令服务」直接取用：
 *   · 上游主机白名单（防 SSRF）
 *   · TTL 内存缓存
 *   · 令牌桶限流
 *   · 带镜像回退 + 重试 + 单次 settle 的 fetchJson
 *
 * 已移除（产品转向：不做电台/地震/卫星数据源）：
 *   · Radio Browser / USGS / CelesTrak 三个内容端点
 *
 * 为什么保留这些：
 *   M5 的房间列表/加入/审批仍然要从服务端走 HTTP，同样需要
 *   「只请求可信上游 + 限流 + 缓存 + 可诊断的错误」。
 */

const http = require('http');
const https = require('https');

// ============================================================
//  上游白名单（防 SSRF：禁止任意外链）
// ============================================================
const ALLOWED_HOSTS = new Set([]);

// ============================================================
//  TTL 缓存
// ============================================================
const cache = new Map(); // key -> { at, ttl, value }
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value, ttl) {
  cache.set(key, { at: Date.now(), ttl: ttl || 60000, value });
}

// ============================================================
//  限流（令牌桶，按 key）
// ============================================================
const rateMap = new Map();
function rateOk(key, max, windowMs) {
  const now = Date.now();
  let rec = rateMap.get(key);
  if (!rec || now - rec.start > windowMs) {
    rec = { start: now, count: 0 };
    rateMap.set(key, rec);
  }
  rec.count++;
  return rec.count <= max;
}

// ============================================================
//  上游 fetch（超时 + 白名单 + 单次 settle）
// ============================================================
function fetchJson(targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { reject(new Error('BAD_URL')); return; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      reject(new Error('BAD_PROTOCOL')); return;
    }
    if (!ALLOWED_HOSTS.has(u.hostname)) {
      reject(new Error('HOST_NOT_ALLOWED:' + u.hostname)); return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; fn(v); };
    const req = lib.get(u, {
      timeout: timeoutMs || 20000,
      headers: { 'user-agent': 'Stellaflix-World/1.0', accept: 'application/json' }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchJson(new URL(res.headers.location, u).toString(), timeoutMs)
          .then((v) => done(resolve, v), (e) => done(reject, e));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        done(reject, new Error('UPSTREAM_' + res.statusCode + '@' + u.hostname));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        if (buf.length > 8 * 1024 * 1024) { req.destroy(); done(reject, new Error('UPSTREAM_TOO_LARGE')); }
      });
      res.on('end', () => {
        const ct = String((res.headers && res.headers['content-type']) || '');
        if (ct && !/json/i.test(ct)) {
          done(reject, new Error('NOT_JSON_CONTENT_TYPE:' + ct.split(';')[0] + '@' + u.hostname));
          return;
        }
        try { done(resolve, JSON.parse(buf)); }
        catch (e) {
          done(reject, new Error('BAD_JSON@' + u.hostname + ' ct=' + (ct || 'none') + ' head=' + buf.slice(0, 60)));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); done(reject, new Error('UPSTREAM_TIMEOUT@' + u.hostname)); });
    req.on('error', (e) => done(reject, new Error((e && e.message) || 'UPSTREAM_ERROR')));
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 镜像回退 + 每镜像重试：上游偶发 404/超时，退避后重试成功率很高。
async function fetchJsonWithMirrors(urls, timeoutMs, retries) {
  const errs = [];
  const attempts = Math.max(1, Number(retries) || 2);
  for (const u of urls) {
    for (let a = 0; a < attempts; a++) {
      try {
        return await fetchJson(u, timeoutMs);
      } catch (e) {
        errs.push(String((e && e.message) || e));
        if (a < attempts - 1) await sleep(350 * (a + 1));
      }
    }
  }
  // 汇总所有尝试的失败原因，别只留最后一个
  throw new Error('ALL_MIRRORS_FAILED: ' + (errs.join(' | ') || 'none'));
}

function clientKey(req, url) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] ||
    (req.socket && req.socket.remoteAddress) || 'unknown';
  return ip + '|' + url.pathname;
}

/**
 * 统一入口。内容端点已移除，返回 404 并明确说明。
 * M5 的房间信令在 server.js 里新建路由，复用本模块的缓存/限流/白名单。
 */
async function handle(req, res, url, sendJSON) {
  sendJSON(res, {
    ok: false,
    error: 'REMOVED',
    message: '世界页内容数据源已按产品转向移除；M5 房间信令将在这里提供'
  }, 404);
}

module.exports = {
  handle: handle,
  ALLOWED_HOSTS: ALLOWED_HOSTS,
  cacheGet: cacheGet,
  cacheSet: cacheSet,
  rateOk: rateOk,
  fetchJson: fetchJson,
  fetchJsonWithMirrors: fetchJsonWithMirrors,
  clientKey: clientKey,
  _cache: cache
};
