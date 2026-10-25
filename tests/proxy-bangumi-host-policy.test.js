'use strict';

// 2026-10-18 对照 Kazumi-2.3.9 + 本机实测的两条 server 端契约：
// ① /api/proxy 对 Kazumi 镜像/官方 bgm 域的出站超时预算 12s→25s
//    （实测 api.kazumi.fyi 全量 JSON 16–22s 才回 200，12s 预算必先掐死上游；
//     Kazumi network_config.dart 为 12s connect + 12s receive 分段，总容许 ≈24s）
// ② Windows 系统代理跟随（Kazumi network_config.dart:30-38 直连也走 SystemProxyService）：
//    env HTTPS_PROXY 或注册表 ProxyEnable=1 时，官方域 next/api.bgm.tv 经代理出站；
//    镜像 api.kazumi.fyi 保持直连（国内可直连是它存在的前提，不能被半残代理拖累）。

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');

const PORT = 39867;
process.env.PORT = String(PORT);
delete process.env.HOST;

const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;
const realFetch = globalThis.fetch;

function policy() {
  return server.bangumiProxyPolicy;
}

// 收尾：不 close 会让 node 进程挂住，端口被残留服务占走（EADDRINUSE 传染后续测试）
after(() => { server.close(); });

async function waitListening() {
  if (server.listening) return;
  await new Promise((resolve) => server.once('listening', resolve));
}

test('host 预算：镜像与官方 bgm 域 25s，其他域名维持 12s', () => {
  assert.equal(policy().proxyTimeoutMsFor('api.kazumi.fyi'), 25000);
  assert.equal(policy().proxyTimeoutMsFor('next.bgm.tv'), 25000);
  assert.equal(policy().proxyTimeoutMsFor('api.bgm.tv'), 25000);
  assert.equal(policy().proxyTimeoutMsFor('image.tmdb.org'), 12000);
  assert.equal(policy().proxyTimeoutMsFor('example.com'), 12000);
});

test('注册表文本解析：ProxyEnable 0x1/0x0 都读得对', () => {
  const on = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '    ProxyEnable    REG_DWORD    0x1',
    '    ProxyServer    REG_SZ    127.0.0.1:10808',
    '',
  ].join('\r\n');
  const off = on.replace('0x1', '0x0');
  assert.deepEqual(policy().parseWindowsProxyQuery(on), { enabled: true, server: '127.0.0.1:10808' });
  assert.deepEqual(policy().parseWindowsProxyQuery(off), { enabled: false, server: '127.0.0.1:10808' });
});

test('官方域经系统代理出站；镜像保持直连；无关域不带 dispatcher', async () => {
  await waitListening();
  process.env.HTTPS_PROXY = 'http://127.0.0.1:10808';
  const seen = [];
  globalThis.fetch = async (input, init) => {
    seen.push({ url: String(input && input.url ? input.url : input), dispatcher: init && init.dispatcher });
    return new Response('{"1":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    for (const target of [
      'https://next.bgm.tv/p1/calendar',
      'https://api.kazumi.fyi/p1/calendar',
      'https://api.tmdb.org/3/configuration',
    ]) {
      const r = await realFetch(BASE + '/api/proxy?url=' + encodeURIComponent(target));
      assert.equal(r.status, 200, target);
    }
    assert.ok(seen[0].dispatcher, '官方域应带代理 dispatcher');
    assert.equal(seen[1].dispatcher, undefined, '镜像域不得被代理拖累');
    assert.equal(seen[2].dispatcher, undefined, '无关域不受本策略影响');
  } finally {
    delete process.env.HTTPS_PROXY;
    globalThis.fetch = realFetch;
  }
});
