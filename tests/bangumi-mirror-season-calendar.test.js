'use strict';

/**
 * 每周新番「往季」主路径应为 Kazumi 镜像季度端点（2026-09-30 第三批）
 *
 * 根因补录（有来源）：本项目的往季取数只移植了 Kazumi 的**非镜像分支**
 *   timeline_controller.dart:79-99  _getSchedulesBySeason():
 *     if (_bangumiMirrorEnabled) { getBangumiMirrorSeasonCalendar(dateRange); return; }   // ← 主路径，漏移植
 *     for (page in 0..3) getCalendarBySearch(...)                                          // ← 我们只做了这条
 *   bangumi_api.dart:109-146  getBangumiMirrorSeasonCalendar():
 *     GET {mirror}/kazumi/v1/calendar/season?start=&end=  -> json['1']..json['7']，每项取 .subject
 *
 * 而搜索分支（POST /v0/search/subjects）在镜像上需 Kazumi 官方签名凭证（不可得 -> 401），
 * 官方 api.bgm.tv 国内直连不可达 -> 往季恒空。
 *
 * 实测镜像季度端点免签可用：2025 夏季窗口返回 7 桶共 87 条（HTTP 200）。
 *
 * 本批契约：
 *   M1 getSeasonCalendar 先打镜像季度端点（GET，带 start/end），成功即返回 7 桶数据，
 *      且不得再发 POST /api/bangumi/search；
 *   M2 镜像季度端点失败时回退到 POST 搜索分支（不回退掉上一批的错误上浮行为）；
 *   M3 镜像条目走 normSubject（图片经 wsrv.nl 重写、airWeekday 由 date 推导）。
 *
 * 运行：node --test tests/bangumi-mirror-season-calendar.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// 镜像季度端点的真实响应形态（截取实测结构：键 "1".."7"，每项 { subject: {...} }）
function seasonFixture() {
  const subject = (id, name, date) => ({
    subject: {
      id,
      name,
      name_cn: name + '中',
      date,
      rating: { score: 8.1, total: 2345 },
      images: { common: 'https://api.bgm.tv/v0/subjects/' + id + '/image?type=large' },
      tags: [{ name: '日本', count: 10 }],
    },
  });
  return {
    '1': [subject(500001, '周一番', '2025-07-07')],
    '2': [subject(500002, '周二番', '2025-07-01')],
    '3': [subject(500003, '周三番', '2025-07-02'), subject(500004, '周三番二', '2025-07-09')],
    '4': [],
    '5': [subject(500005, '周五番', '2025-07-04')],
    '6': [subject(500006, '周六番', '2025-07-05')],
    '7': [subject(500007, '周日番', '2025-07-06')],
  };
}

function loadBangumi(handler) {
  const sandbox = { console, setTimeout, clearTimeout, Date, Math, JSON, Promise, URL, encodeURIComponent };
  sandbox.window = sandbox;
  sandbox.StellaflixVideo = {};
  const calls = [];
  sandbox.fetch = function (url, init) {
    const bodyInit = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: (init && init.method) || 'GET', body: bodyInit });
    const res = handler(calls.length, bodyInit);
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

const RANGE = ['2025-06-01', '2025-09-01'];
const SEARCH_FAIL = { status: 502, json: { error: 'bangumi_search_upstream_failed', message: '全部源失败: api.kazumi.fyi HTTP 401' } };

test('M1 getSeasonCalendar 主路径打镜像季度端点，成功即返回 7 桶且不再走 POST 搜索', async () => {
  const { bangumi, calls } = loadBangumi((n) => {
    const c = calls[n - 1];
    const u = c ? decodeURIComponent(c.url) : '';
    if (c && c.method === 'GET' && /calendar\/season/.test(u)) return { status: 200, json: seasonFixture() };
    return SEARCH_FAIL;
  });
  const res = await bangumi.getSeasonCalendar(RANGE);
  assert.equal(res.error, null, '镜像成功时不得带 error: ' + res.error);
  assert.equal(res.calendar.length, 7);
  assert.equal(res.calendar.reduce((n, a) => n + a.length, 0), 7, '7 桶共 7 条（周三 2 条）');
  assert.equal(res.source, 'mirror-season');

  const first = calls[0];
  assert.equal(first.method, 'GET', '首个请求须为 GET（镜像季度端点）');
  const firstUrl = decodeURIComponent(first.url);
  assert.match(firstUrl, /api\.kazumi\.fyi\/kazumi\/v1\/calendar\/season/, '须命中镜像季度端点');
  assert.match(firstUrl, /start=2025-06-01/, '须带 start 窗口参数');
  assert.match(firstUrl, /end=2025-09-01/, '须带 end 窗口参数');
  assert.ok(!calls.some((c) => c.method === 'POST'), '镜像成功时不得再打 POST 搜索');
});

test('M2 镜像季度端点失败时回退 POST 搜索分支，且错误如实上浮', async () => {
  // 镜像 GET 挂掉（502），搜索 POST 返回 server 的「全部源失败」JSON —— 最终错误须来自搜索分支
  const { bangumi, calls } = loadBangumi((n, body) => {
    return body ? SEARCH_FAIL : { status: 502, json: { error: 'mirror-down' } };
  });
  const res = await bangumi.getSeasonCalendar(RANGE);
  assert.ok(res.error, '两路皆败时 error 须上浮');
  assert.match(res.error, /全部源失败/, '回退分支应携带 server 搜索错误信息，实际: ' + res.error);
  assert.ok(calls.some((c) => c.method === 'POST' && /\/api\/bangumi\/search/.test(c.url)), '镜像失败须回退 POST 搜索');
});

test('M2b 镜像返回非 7 桶形态时视为失败并回退（不得静默出空表）', async () => {
  const { bangumi, calls } = loadBangumi((n) => {
    const c = calls[n - 1];
    if (c && c.method === 'GET') return { status: 200, json: { foo: 'bar' } };
    return { status: 200, json: { total: 1, data: [{ id: 1, name: 'x', date: '2025-07-02', rating: {} }] } };
  });
  const res = await bangumi.getSeasonCalendar(RANGE);
  assert.ok(calls.some((c) => c.method === 'POST'), '形态异常须回退搜索分支');
  assert.equal(res.source, 'search');
});

test('M3 镜像条目经 normSubject 归一：图片走 wsrv.nl、airWeekday 由 date 推导', async () => {
  const { bangumi } = loadBangumi((n, body) => {
    void body;
    const isMirror = !body;
    return isMirror ? { status: 200, json: seasonFixture() } : SEARCH_FAIL;
  });
  const res = await bangumi.getSeasonCalendar(RANGE);
  assert.ok(res.calendar[2].length >= 1, '周三桶应有数据');
  const item = res.calendar[2][0];
  assert.equal(item.name, '周三番');
  assert.match(item.poster, /^https:\/\/wsrv\.nl\/\?url=/, '海报须经 wsrv.nl 重写');
  assert.equal(item.airWeekdayDart, 3, '2025-07-02 是周三 -> Dart weekday 3');
  assert.equal(item.votes, 2345);
});
