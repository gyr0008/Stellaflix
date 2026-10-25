'use strict';
/**
 * 媒体请求头覆盖通道测试（drpy/T4 规则自带的 Referer、User-Agent 要能打到 CDN）。
 * 运行：node --test tests/media-header-override.test.js
 * ① 前端：setMediaHeaders 只收 Referer/UA，按媒体 origin 记账，toProxyUrl 现拼 sfv 参数
 * ② 服务端：同域族的 sfvReferer 覆盖生效；外域 Referer / 含控制字符的 UA / 超长值被忽略
 */
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');

const PORT = 39881;
process.env.PORT = String(PORT);
delete process.env.HOST;

const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;
const realFetch = globalThis.fetch;

function loadCore() {
  // 模块内部把 window 当 global 用（parseUrl 取 global.URL），故 URL 必须挂在 window 上
  const sandbox = { window: {}, URL: require('url').URL };
  sandbox.window.URL = require('url').URL;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('public/video/source-adapter-core.js', 'utf8'), sandbox, { filename: 'source-adapter-core.js' });
  return sandbox.window.StellaflixVideo.sourceAdapterCore;
}

async function waitListening() {
  if (server.listening) return;
  await new Promise((resolve) => server.once('listening', resolve));
}

let upstreamHeaders = null;
function stubUpstream() {
  globalThis.fetch = async (input, init) => {
    upstreamHeaders = (init && init.headers) || {};
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
}

after(() => {
  globalThis.fetch = realFetch;
  try { server.close(); } catch (e) {}
});

// ---------- 前端：登记与地址拼装 ----------
test('setMediaHeaders：仅收 Referer/UA，按 origin 记账并拼进代理地址', () => {
  const c = loadCore();
  c.clearMediaHeaders();
  const ok = c.setMediaHeaders('https://cdn.example.com/a/m3u8?sign=1', {
    Referer: 'https://example.com/',
    'User-Agent': 'RuleUA/1.0',
    Cookie: 'secret=1',
  });
  assert.equal(ok, true);
  // vm 沙箱与宿主不同 realm，条目只做字段比对
  const seg = c.getMediaHeaders('https://cdn.example.com/b/seg0.ts');
  assert.equal(seg && seg.referer, 'https://example.com/');
  assert.equal(seg && seg.ua, 'RuleUA/1.0');
  assert.equal(seg && seg.cookie, undefined, '同 origin 的分片复用同一条目');
  const u = c.toProxyUrl('https://cdn.example.com/a/m3u8?sign=1');
  assert.equal(u.indexOf('/api/proxy?url='), 0);
  assert.match(u, /&sfvReferer=https%3A%2F%2Fexample\.com%2F/);
  assert.match(u, /&sfvUA=RuleUA%2F1\.0/);
  assert.doesNotMatch(u, /secret/, 'Cookie 不进代理地址');
});

test('setMediaHeaders：无关 host 与空输入不影响代理地址', () => {
  const c = loadCore();
  c.clearMediaHeaders();
  assert.equal(c.setMediaHeaders('https://other.site/x.mp4', { Referer: 'https://other.site/' }), true);
  assert.equal(c.toProxyUrl('https://third.site/y.mp4'), '/api/proxy?url=' + encodeURIComponent('https://third.site/y.mp4'));
  assert.equal(c.setMediaHeaders('https://no-headers.site/z.mp4', {}), false);
  assert.equal(c.setMediaHeaders('magnet:?xt=urn:btih:abc', { Referer: 'https://a.com/' }), false, '非 http(s) 不登记');
});

test('setMediaHeaders：容量上限按插入序淘汰，不无界增长', () => {
  const c = loadCore();
  c.clearMediaHeaders();
  for (let i = 0; i < 40; i++) c.setMediaHeaders('https://h' + i + '.example.com/x.mp4', { Referer: 'https://h' + i + '.example.com/' });
  assert.equal(c.getMediaHeaders('https://h0.example.com/x.mp4'), null, '最旧条目已淘汰');
  assert.notEqual(c.getMediaHeaders('https://h39.example.com/x.mp4'), null);
});

// ---------- 服务端：覆盖生效与越权拦截 ----------
async function proxyFor(target, params) {
  upstreamHeaders = null;
  const r = await realFetch(BASE + '/api/proxy?url=' + encodeURIComponent(target) + (params || ''));
  assert.equal(r.status, 200);
  return upstreamHeaders;
}

test('/api/proxy：同域族 sfvReferer 覆盖 Referer 并跟随 Origin', async () => {
  await waitListening();
  stubUpstream();
  const h = await proxyFor('https://cdn.example.com/v.mp4',
    '&sfvReferer=' + encodeURIComponent('https://www.example.com/play/1') + '&sfvUA=' + encodeURIComponent('RuleUA/1.0'));
  assert.equal(h.Referer, 'https://www.example.com/play/1');
  assert.equal(h.Origin, 'https://www.example.com');
  assert.equal(h['User-Agent'], 'RuleUA/1.0');
});

test('/api/proxy：外域 Referer 被拒，保持伪造的通用头', async () => {
  await waitListening();
  stubUpstream();
  const h = await proxyFor('https://cdn.example.com/v.mp4',
    '&sfvReferer=' + encodeURIComponent('https://evil-other.com/'));
  assert.equal(h.Referer, 'https://cdn.example.com/');
  assert.equal(h.Origin, 'https://cdn.example.com');
});

test('/api/proxy：带凭据的 Referer 与含控制字符/超长的 UA 被忽略', async () => {
  await waitListening();
  stubUpstream();
  const h = await proxyFor('https://cdn.example.com/v.mp4',
    '&sfvReferer=' + encodeURIComponent('https://u:p@example.com/') + '&sfvUA=' + encodeURIComponent('UA\r\nX-Injected: 1'));
  assert.equal(h.Referer, 'https://cdn.example.com/');
  assert.match(h['User-Agent'], /^Mozilla\//, 'UA 保持默认，未注入');
  const long = 'A'.repeat(600);
  const h2 = await proxyFor('https://cdn.example.com/v.mp4', '&sfvUA=' + long);
  assert.match(h2['User-Agent'], /^Mozilla\//);
});

test('/api/proxy：两段式公共后缀下的不同租户被拒', async () => {
  await waitListening();
  stubUpstream();
  const bad = await proxyFor('https://video.example.co.uk/a.mp4',
    '&sfvReferer=' + encodeURIComponent('https://other.co.uk/'));
  assert.equal(bad.Referer, 'https://video.example.co.uk/');
  const ok = await proxyFor('https://video.example.co.uk/a.mp4',
    '&sfvReferer=' + encodeURIComponent('https://example.co.uk/home'));
  assert.equal(ok.Referer, 'https://example.co.uk/home', '同站家族放行');
});

test('/api/proxy：无 sfv 参数时行为与原先一致', async () => {
  await waitListening();
  stubUpstream();
  const h = await proxyFor('https://cdn.example.com/v.mp4');
  assert.equal(h.Referer, 'https://cdn.example.com/');
  assert.match(h['User-Agent'], /^Mozilla\/5\.0/);
});
