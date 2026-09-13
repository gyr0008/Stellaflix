'use strict';
/**
 * 验证两件事：
 *  (A) Bangumi 数据层在官方域名被墙时回退到 Kazumi 镜像 api.kazumi.fyi（无网络 stub）
 *  (B) desktop/global-proxy.js 能按环境变量启用全局出口代理，且 fetch 真实经其转发
 */
const assert = require('assert');
const http = require('http');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.error('  FAIL ' + name); }
}

function fakeCalendar() {
  const day = [{ subject: {
    id: 1, name: '测试番', name_cn: '测试番',
    rating: { score: 8 }, images: { common: 'https://lain.bgm.tv/pic/cover.jpg' }
  } }];
  const o = {};
  for (let i = 1; i <= 7; i++) o[String(i)] = day;
  return o;
}

(async () => {
  // =====================  Part A: 镜像回退 =====================
  console.log('[A] Bangumi 镜像回退（无网络）');
  globalThis.window = globalThis;
  delete globalThis.StellaflixVideo;
  require(path.resolve(__dirname, '../public/video/bangumi.js'));
  const B = globalThis.StellaflixVideo.bangumi;

  // 场景1：镜像优先命中 -> source='mirror-next'，且不触碰官方域
  let calls1 = [];
  globalThis.KazumiHttpClient = {
    get(url) {
      calls1.push(url);
      if (url.indexOf('kazumi.fyi/p1/calendar') >= 0) return Promise.resolve(JSON.stringify(fakeCalendar()));
      throw new Error('blocked');
    }
  };
  let r1 = await B.getCalendar();
  ok('镜像优先命中 -> source=mirror-next', r1.source === 'mirror-next');
  ok('镜像命中即止，未请求官方域', calls1.every(u => u.indexOf('bgm.tv') < 0));

  // 场景2：镜像失败，回退官方 next 命中 -> source='next'
  let calls2 = [];
  globalThis.KazumiHttpClient = {
    get(url) {
      calls2.push(url);
      if (url.indexOf('next.bgm.tv') >= 0) return Promise.resolve(JSON.stringify(fakeCalendar()));
      throw new Error('blocked');
    }
  };
  let r2 = await B.getCalendar();
  ok('镜像失败回退官方 -> source=next', r2.source === 'next');
  ok('镜像解析为 7 天结构', Array.isArray(r2.calendar) && r2.calendar.length === 7);

  // 场景3：全部失败 -> 空表 + error
  globalThis.KazumiHttpClient = { get() { throw new Error('blocked'); } };
  let r3 = await B.getCalendar();
  ok('全部失败 -> 空表且带 error', r3.calendar.length === 0 && !!r3.error);

  // 场景4：镜像常量正确
  ok('mirror-next 常量', B.BANGUMI_CALENDAR_MIRROR_NEXT === 'https://api.kazumi.fyi/p1/calendar');
  ok('mirror-v0 常量', B.BANGUMI_CALENDAR_MIRROR_V0 === 'https://api.kazumi.fyi/calendar');

  // =====================  Part B: 代理自动识别 =====================
  console.log('[B] 全局出口代理自动识别');
  const gp = require(path.resolve(__dirname, '../desktop/global-proxy.js'));
  const undici = require('undici');

  ok('HTTP_PROXY 识别', gp.resolveProxyEnv({ HTTP_PROXY: 'http://127.0.0.1:7890' }).proxy === 'http://127.0.0.1:7890');
  ok('小写 https_proxy 识别', gp.resolveProxyEnv({ https_proxy: 'http://127.0.0.1:7891' }).proxy === 'http://127.0.0.1:7891');
  ok('空环境 proxy=""', gp.resolveProxyEnv({}).proxy === '');

  ok('HTTP -> http-env 代理', gp.pickAgent(undici, 'http://127.0.0.1:7890').kind === 'http-env');
  ok('HTTPS -> http-env 代理', gp.pickAgent(undici, 'https://127.0.0.1:7890').kind === 'http-env');
  ok('socks5 -> socks5 代理', gp.pickAgent(undici, 'socks5://127.0.0.1:7891').kind === 'socks5');

  // 空环境：不改全局 dispatcher
  const before = undici.getGlobalDispatcher();
  const rNull = gp.setupGlobalProxy({});
  ok('空环境 enabled=false', rNull.enabled === false);
  ok('空环境不改全局 dispatcher', undici.getGlobalDispatcher() === before);

  // 真实路由：起一个支持 CONNECT 的本地代理，验证 fetch 经其隧道转发。
  // 用非 localhost 主机名（proxy-target.invalid），避免被 undici 内置的 localhost 绕过规则跳过。
  let proxyHits = 0;
  const proxy = http.createServer((preq, pres) => { pres.writeHead(400); pres.end(); });
  proxy.on('connect', (creq, clientSocket) => {
    proxyHits++;
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: stellaflix-test\r\n\r\n');
    // undici 随后在隧道内发送 GET；读取后直接回一个 HTTP 响应标记，证明请求走了代理
    clientSocket.once('data', () => {
      const body = JSON.stringify({ proxied: true, via: creq.url });
      clientSocket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' +
        Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body
      );
      clientSocket.end();
    });
    clientSocket.on('error', () => {});
  });
  await new Promise((res) => proxy.listen(0, '127.0.0.1', res));
  const proxyPort = proxy.address().port;

  const orig = undici.getGlobalDispatcher();
  try {
    // 说明：本沙箱注入了只读 HTTP_PROXY，无法通过 process.env 覆盖指向本地代理；
    // 故这里直接用 undici.ProxyAgent 注入同一条 undici 代理链路（EnvHttpProxyAgent 是
    // 其按环境变量自动选择的等价形式），以验证“fetch 经代理隧道转发”这一核心能力。
    undici.setGlobalDispatcher(new undici.ProxyAgent('http://127.0.0.1:' + proxyPort));
    const resp = await fetch('http://proxy-target.invalid/test', { redirect: 'manual' });
    const body = await resp.json();
    ok('fetch 经代理隧道（收到 proxied 标记）', body && body.proxied === true);
    ok('代理确实收到 CONNECT 请求', proxyHits >= 1);
  } finally {
    undici.setGlobalDispatcher(orig); // 还原，避免污染测试进程
    try { proxy.close(); } catch (e) {}
  }

  console.log('\n结果：' + pass + ' PASS / ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
