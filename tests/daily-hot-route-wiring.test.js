'use strict';
// 排行榜 /api/daily-hot 路由接线源钉（Task 2）
// 断言的是「server.js 里 LX §1.10 那两个分支是否逐字落地」——不访问网络、不起服务。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'daily-hot-api.js'), 'utf8');

const dailyHotBranch = (() => {
  const at = serverSrc.indexOf("if (pn === '/api/daily-hot')");
  if (at < 0) return '';
  const end = serverSrc.indexOf("if (pn === '/api/platform-charts')", at);
  return serverSrc.slice(at, end < 0 ? at + 900 : end);
})();

test('server.js 以 ./daily-hot-api 形式 require 新根模块（build.files 的 *-api.js 通配可收编）', () => {
  assert.match(serverSrc, /const dailyHotApi = require\('\.\/daily-hot-api'\);/);
});

test('API 实例在模块作用域建一次，不在请求回调内建（否则 6h 缓存随实例蒸发）', () => {
  const createAt = serverSrc.indexOf('dailyHotApi.createDailyHotApi(');
  const serverAt = serverSrc.indexOf('http.createServer(');
  assert.ok(createAt > -1, '须有 createDailyHotApi() 调用');
  assert.ok(serverAt > -1, '须有 http.createServer(');
  assert.ok(createAt < serverAt, '实例化必须先于 createServer，即模块作用域单例');
  assert.match(serverSrc, /const dailyHot = dailyHotApi\.createDailyHotApi\(\);/);
  const insideServer = serverSrc.slice(serverAt);
  assert.doesNotMatch(insideServer, /createDailyHotApi\(\)/, '请求链内禁止再建实例');
});

test('GET /api/daily-hot 分支 = LX server.js:3060-3073 逐字（四参顺序、状态码、兜底文案）', () => {
  assert.ok(dailyHotBranch.length > 0, "server.js 缺 if (pn === '/api/daily-hot') 分支");
  assert.match(dailyHotBranch, /const result = await getDailyHotSongs\(/);
  assert.match(dailyHotBranch, /url\.searchParams\.get\('limit'\)/);
  assert.match(dailyHotBranch, /url\.searchParams\.get\('source'\)/);
  assert.match(dailyHotBranch, /url\.searchParams\.get\('refresh'\) === '1'/);
  assert.match(dailyHotBranch, /url\.searchParams\.get\('chart'\)/);
  assert.match(dailyHotBranch, /sendJSON\(res, result, result\.ok \? 200 : 502\)/);
  assert.match(dailyHotBranch, /sendJSON\(res, \{ ok: false, songs: \[\], error: err\.message \|\| 'DAILY_HOT_FAILED' \}, 502\)/);
  assert.match(dailyHotBranch, /^\s*return;\s*$/m);
});

test('GET /api/platform-charts 姊妹分支 = LX server.js:3075-3083 逐字（400 + UNSUPPORTED_CHART_SOURCE）', () => {
  const at = serverSrc.indexOf("if (pn === '/api/platform-charts')");
  assert.ok(at > -1, '缺 /api/platform-charts 分支');
  const block = serverSrc.slice(at, at + 700);
  assert.match(block, /String\(url\.searchParams\.get\('source'\) \|\| ''\)\.toLowerCase\(\)/);
  assert.match(block, /!PLATFORM_CHART_CATALOG\[source\]/);
  assert.match(block, /sendJSON\(res, \{ ok:false, charts:\[\], error:'UNSUPPORTED_CHART_SOURCE' \}, 400\)/);
  assert.match(block, /sendJSON\(res, \{ ok:true, source, charts:PLATFORM_CHART_CATALOG\[source\] \}\)/);
});

test('抓取实现复用 daily-hot-api 的 LX 缺省 UA/referer/redirect/超时，不在 server.js 抄第二份', () => {
  const defaultFetchers = apiSrc.match(/async function dailyHot(?:FetchJson|FetchText)Default/g) || [];
  assert.equal(defaultFetchers.length, 2, '模块须导出两个缺省抓取器');
  // server.js 未注入裸 fetcher = 走模块内 LX 缺省实现（偏离只留一处）
  assert.match(serverSrc, /createDailyHotApi\(\);/, '实例化须为零注入形态');
  assert.doesNotMatch(dailyHotBranch, /fetchJson\s*:/, '路由分支不得再自造 fetchJson');
  assert.doesNotMatch(dailyHotBranch, /fetchText\s*:/, '路由分支不得再自造 fetchText');
  assert.doesNotMatch(dailyHotBranch, /user-agent/i, '路由分支不得把 LX 默认 UA 抄第二份');
  assert.equal((apiSrc.match(/const fetchImpl = globalThis\.fetch;/g) || []).length, 2, '两个缺省抓取器都须留在模块内');
});

test('偏离留痕：纯 Node 无 electronNet 系统代理链路（源料 §4.1）', () => {
  const at = serverSrc.indexOf("const dailyHotApi = require('./daily-hot-api');");
  assert.ok(at > -1, '须有 daily-hot-api 的 require 行');
  // 只取 require 行紧邻的注释块 + 实例化区，避免把整份 server.js 当证据
  const region = serverSrc.slice(Math.max(0, at - 900), at + 400);
  assert.match(region, /偏离/, 'require/实例化区须写明与 LX 的偏离');
  assert.match(region, /electronNet|系统代理/, '偏离须点名 electronNet 系统代理链路缺失');
  assert.match(region, /createDailyHotApi\(\)/, '偏离区须覆盖实例化位置');
  assert.match(region, /UA|referer|超时/, '偏离须说明缺省 UA/referer/超时留在模块内');
});
