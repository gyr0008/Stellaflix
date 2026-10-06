'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const appRoot = path.resolve(__dirname, '..');
const Core = require(path.join(appRoot, 'public', 'video', 'search-filter-core.js'));

const vod = (title, year) => ({ title: title, year: year || '' });
const keysOf = (items) => items.map((it) => it.title + '|' + it.year).sort();

function pages(...lists) {
  const calls = [];
  return {
    calls,
    fetchPage: (page) => {
      calls.push(page);
      const list = lists[page - 2];
      return list === undefined ? Promise.reject(new Error('no such page ' + page)) : Promise.resolve(list);
    },
  };
}

test('结果已达 threshold 时不做任何续页请求', async () => {
  const p = pages();
  const res = await Core.collectMorePages({
    knownItems: [vod('A'), vod('B'), vod('C')],
    fetchPage: p.fetchPage,
    threshold: 3,
  });
  assert.equal(p.calls.length, 0);
  assert.deepEqual(res.added, []);
  assert.equal(res.reason, 'enough');
});

test('第 2 页全是重复条目：见新即停（no-fresh），不再拉第 3 页', async () => {
  const p = pages([vod('A')], [vod('Z')]);
  const res = await Core.collectMorePages({
    knownItems: [vod('A'), vod('B')],
    fetchPage: p.fetchPage,
    threshold: 24,
    maxPages: 3,
  });
  assert.deepEqual(p.calls, [2]);
  assert.deepEqual(res.added, []);
  assert.equal(res.reason, 'no-fresh');
});

test('页页有新条目时最多拉到第 3 页（fetchPage 恰好调 2 次）', async () => {
  const p = pages([vod('X')], [vod('Y')]);
  const res = await Core.collectMorePages({
    knownItems: [vod('A')],
    fetchPage: p.fetchPage,
    threshold: 24,
    maxPages: 3,
  });
  assert.deepEqual(p.calls, [2, 3]);
  assert.deepEqual(keysOf(res.added), ['X|', 'Y|']);
  assert.equal(res.reason, 'max-pages');
});

test('跨页累积去重：后页重复前页新条目时只保留一份', async () => {
  const p = pages([vod('X'), vod('A')], [vod('X'), vod('Y')]);
  const res = await Core.collectMorePages({
    knownItems: [vod('A')],
    fetchPage: p.fetchPage,
    threshold: 24,
    maxPages: 3,
  });
  assert.deepEqual(keysOf(res.added), ['X|', 'Y|']);
});

test('中途某页请求失败：保留已收的新条目并停止，不向外抛', async () => {
  const p = pages([vod('X')], undefined);
  const res = await Core.collectMorePages({
    knownItems: [vod('A')],
    fetchPage: p.fetchPage,
    threshold: 24,
    maxPages: 3,
  });
  assert.deepEqual(keysOf(res.added), ['X|']);
  assert.equal(res.reason, 'error');
});

test('online-search 胶水：不足 24 才续拉、仅强势源、翻页带 viewToken 防串台', () => {
  const searchSrc = fs.readFileSync(path.join(appRoot, 'public', 'video', 'online-search.js'), 'utf8');
  assert.match(searchSrc, /aggregated\.length < 24 && SFV\.SearchFilterCore && SFV\.SearchFilterCore\.collectMorePages/);
  assert.match(searchSrc, /strongIds\[rawCms\[ri\]\.sourceId\] = 1/);
  assert.match(searchSrc, /pg: pg, sources: strongSources/);
  assert.match(searchSrc, /moreP\.then\(function \(more\) \{\r?\n        if \(S\._currentSearchView !== viewToken\) return;/);
});

test('默认 threshold=24：第 2 页拉满即止，不再拉第 3 页', async () => {
  const many = [];
  for (let i = 0; i < 30; i++) many.push(vod('N' + i));
  const p = pages(many, [vod('NEVER')]);
  const res = await Core.collectMorePages({
    knownItems: [vod('A')],
    fetchPage: p.fetchPage,
  });
  assert.deepEqual(p.calls, [2]);
  assert.equal(res.reason, 'enough');
});
