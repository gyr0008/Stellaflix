'use strict';

/**
 * 网易云「临时档案」不刷新 bug（2026-10-17）· 服务端部分。
 *
 * 根因：getLoginInfo 把「失败/超时」的 loggedIn:false 也写进 30s 结果缓存
 * （NETEASE_LOGIN_INFO_CACHE_TTL_MS）。桌面 reused 秒登时网易云复验一旦超时，
 * 前端拿到 pendingProfile 兜底档案后哪怕立刻重查 /api/login/status，
 * 也会被这份负缓存按死 30 秒——自愈窗口被缓存堵死。
 *
 * 契约：只缓存成功结果；失败结果不缓存，下一次请求必须真的打上游。
 *
 * 运行：node --test tests/netease-login-no-negative-cache.test.js
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 39878;
process.env.PORT = String(PORT);
delete process.env.HOST;

const COOKIE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ne-cookie-')), '.cookie');
fs.writeFileSync(COOKIE_FILE, 'MUSIC_U=stubtestcookie', 'utf8');
process.env.COOKIE_FILE = COOKIE_FILE;

const axios = require('axios');
const originalAdapter = axios.defaults.adapter;

let mode = 'fail';
let upstreamHits = 0;
axios.defaults.adapter = async (config) => {
  upstreamHits += 1;
  if (mode === 'fail') {
    throw Object.assign(new Error('upstream down'), { config });
  }
  return {
    status: 200,
    statusText: 'OK',
    config,
    headers: {},
    data: {
      // 200 才会被 NeteaseCloudMusicApi 的 answer.status 判定放行（2000001 会被折算成 400 拒掉）
      code: 200,
      profile: { userId: 12895532729, nickname: 'Pure-gr', avatarUrl: 'https://p3.music.126.net/x/1.jpg' },
      account: { id: 12895532729, vipType: 0 },
    },
  };
};

const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;

async function waitListening() {
  if (server.listening) return;
  await new Promise((resolve) => server.once('listening', resolve));
}

async function loginStatus() {
  const r = await fetch(BASE + '/api/login/status?t=' + Date.now() + Math.random());
  assert.equal(r.status, 200);
  return r.json();
}

test('复验超时后紧接着恢复：下一次 /api/login/status 必须立刻反映成功，不被 30s 负缓存按死', async () => {
  await waitListening();
  mode = 'fail';
  upstreamHits = 0;
  const down = await loginStatus();
  assert.equal(down.loggedIn, false, '上游全挂时如实返回未登录');
  assert.ok(upstreamHits > 0, '失败路径确实打过上游');

  mode = 'ok';
  const hitsBefore = upstreamHits;
  const up = await loginStatus();
  assert.equal(up.loggedIn, true, '负缓存会把这份完整资料挡在 30 秒外 → pendingProfile 自愈窗口被堵死');
  assert.equal(up.nickname, 'Pure-gr');
  assert.equal(String(up.userId), '12895532729');
  assert.ok(upstreamHits > hitsBefore, '第二次请求必须真的重新打上游，而不是回放缓存的 false');
});

test('成功结果仍然享受 30s 正缓存：连续两次 status 只打一次上游资料查询', async () => {
  await waitListening();
  mode = 'ok';
  // 清一次缓存等价于新窗口首个请求：直接改 cookie 文件再触发读取代价太高，
  // 这里只断言「连续两次都成功」且第二次不再新增 user_account/login_status 上游命中。
  const first = await loginStatus();
  assert.equal(first.loggedIn, true);
  const hitsBefore = upstreamHits;
  const second = await loginStatus();
  assert.equal(second.loggedIn, true);
  assert.equal(upstreamHits, hitsBefore, '正缓存保留：成功结果 30s 内不重复打上游');
});

after(() => {
  axios.defaults.adapter = originalAdapter;
  server.close();
});
