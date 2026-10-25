'use strict';

// 契约（2026-10-17 控制台实证）：getCalendar 源链里 mirror-v0 的 https://api.kazumi.fyi/calendar
// 是死路径（Kazumi 2.3.9 api_endpoints.dart:88 只有 /p1/calendar；真机恒 404），
// 每次失败链都白打一发。本批：源链不得再请求 kazumi.fyi/calendar（无 /p1 前缀）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function seasonWeek() {
  const subject = (id, name) => ({ subject: { id, name, date: '2026-10-12', rating: { score: 8, total: 9 }, images: {}, tags: [] } });
  const out = {};
  for (let i = 1; i <= 7; i++) out[String(i)] = i === 1 ? [subject(101, '周一番')] : [];
  return out;
}

function loadBangumi(handler) {
  const sandbox = { console, setTimeout, clearTimeout, Date, Math, JSON, Promise, URL, encodeURIComponent };
  sandbox.window = sandbox;
  sandbox.StellaflixVideo = {};
  const calls = [];
  sandbox.fetch = function (url, init) {
    calls.push(String(url));
    const res = handler(calls.length);
    return Promise.resolve({
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      text: () => Promise.resolve(typeof res.json === 'string' ? res.json : JSON.stringify(res.json)),
      json: () => Promise.resolve(res.json),
    });
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/bangumi.js'), sandbox, { filename: 'bangumi.js' });
  return { bangumi: sandbox.StellaflixVideo.bangumi, calls };
}

test('镜像成功路径：首发改打 /p1/calendar，全程不请求死路径 kazumi.fyi/calendar', async () => {
  const { bangumi, calls } = loadBangumi(() => ({ status: 200, json: seasonWeek() }));
  const res = await bangumi.getCalendar();
  assert.equal(res.error, null);
  assert.equal(res.source, 'mirror-next');
  assert.match(decodeURIComponent(calls[0]), /api\.kazumi\.fyi\/p1\/calendar/);
  assert.ok(!calls.some(u => /api\.kazumi\.fyi\/calendar/.test(decodeURIComponent(u))), '死路径 mirror-v0 不得再出现在源链');
});

test('镜像 502 时回退顺序：mirror-next → 官方 next（跳过死路径）', async () => {
  const { bangumi, calls } = loadBangumi((n) => {
    if (n === 1) return { status: 502, json: { error: 'bad gateway' } };
    return { status: 200, json: seasonWeek() };
  });
  const res = await bangumi.getCalendar();
  assert.equal(res.error, null, '第二源应救回: ' + res.error);
  const urls = calls.map(u => decodeURIComponent(u));
  assert.match(urls[0], /api\.kazumi\.fyi\/p1\/calendar/);
  assert.ok(!urls.slice(1).some(u => /api\.kazumi\.fyi\/calendar\b(?!\/)/.test(u)), '第二发不得是死路径');
  assert.match(urls[1], /next\.bgm\.tv\/p1\/calendar/);
});

// ---- 2026-10-18 Kazumi-2.3.9 对照 + 本机实测三修复：预算 25s / 死兜底降级 / season 第四源 ----
// 实测：api.kazumi.fyi 全量 JSON 需 16–22s 才回 200，旧 12s 预算是我们先掐死上游；
// 官方域本机恒 000（无代理），8+8s 纯空等 → 降为 4s。

function seasonWeekEmpty() {
  const out = {};
  for (let i = 1; i <= 7; i++) out[String(i)] = [];
  return out;
}

function loadBangumiViaHttp(handler, opts) {
  const sandbox = { console, setTimeout, clearTimeout, Date, Math, JSON, Promise, URL, encodeURIComponent };
  sandbox.window = sandbox;
  sandbox.StellaflixVideo = {};
  if (opts && opts.season) {
    sandbox.StellaflixVideo.bangumiSeason = { toSeasonStartAndEnd: () => ['2026-10-01', '2026-12-31'] };
  }
  const calls = [];
  sandbox.KazumiHttpClient = {
    get: function (url, o) {
      calls.push({ url: String(url), timeoutMs: o && o.timeoutMs });
      const r = handler(calls.length);
      if (!r || r.status >= 400) return Promise.reject(new Error('HTTP ' + (r ? r.status : 599)));
      return Promise.resolve(typeof r.json === 'string' ? r.json : JSON.stringify(r.json));
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/bangumi.js'), sandbox, { filename: 'bangumi.js' });
  return { bangumi: sandbox.StellaflixVideo.bangumi, calls };
}

const allFail = () => ({ status: 502, json: {} });

test('预算：镜像主源 25s 覆盖实测 16–22s 响应；官方域末位降级 4s', async () => {
  const { bangumi, calls } = loadBangumiViaHttp(allFail, { season: true });
  await bangumi.getCalendar();
  const byUrl = {};
  calls.forEach(c => { byUrl[c.url] = c.timeoutMs; });
  assert.equal(byUrl['https://api.kazumi.fyi/p1/calendar'], 25000);
  assert.equal(byUrl['https://next.bgm.tv/p1/calendar'], 4000);
  assert.equal(byUrl['https://api.bgm.tv/calendar'], 4000);
});

test('前三源全挂时第四源走镜像 season 端点（当季窗口），救回即成功', async () => {
  const { bangumi, calls } = loadBangumiViaHttp(
    (n) => (n <= 3 ? { status: 502, json: {} } : { status: 200, json: seasonWeek() }),
    { season: true }
  );
  const res = await bangumi.getCalendar();
  assert.equal(res.error, null, '第四源应救回: ' + res.error);
  assert.equal(res.source, 'mirror-season');
  assert.equal(calls.length, 4);
  assert.match(calls[3].url, /api\.kazumi\.fyi\/kazumi\/v1\/calendar\/season\?start=2026-10-01&end=2026-12-31/);
});

test('第四源 season 空表视为失败，不把空数据当成功', async () => {
  const { bangumi } = loadBangumiViaHttp(
    (n) => (n <= 3 ? { status: 502, json: {} } : { status: 200, json: seasonWeekEmpty() }),
    { season: true }
  );
  const res = await bangumi.getCalendar();
  assert.ok(res.error, 'season 全空应报错而非 source=mirror-season 成功');
  assert.equal(res.source, null);
  assert.equal(res.calendar.length, 0);
});

test('season 模块未加载时不挂第四源（旧行为保持三发）', async () => {
  const { bangumi, calls } = loadBangumiViaHttp(allFail, { season: false });
  await bangumi.getCalendar();
  assert.equal(calls.length, 3);
  assert.ok(!calls.some(c => /calendar\/season/.test(c.url)));
});
