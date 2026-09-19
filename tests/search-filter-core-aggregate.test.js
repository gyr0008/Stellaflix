'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const core = require(path.resolve(__dirname, '..', 'public', 'video', 'search-filter-core.js'));

test('extractIdentityMarkers recognizes multi-form seasons', () => {
  assert.equal(core.extractIdentityMarkers('一念永恒 第二季'), 's2');
  assert.equal(core.extractIdentityMarkers('一念永恒2'), 's2');
  assert.equal(core.extractIdentityMarkers('一念永恒Ⅱ'), 's2');
  assert.equal(core.extractIdentityMarkers('一人之下S5'), 's5');
  assert.equal(core.extractIdentityMarkers('进击的巨人 最终季'), '最终季');
  assert.equal(core.extractIdentityMarkers('一念永恒完结季'), '完结季');
  assert.equal(core.extractIdentityMarkers('一念永恒完结篇'), '完结篇');
  assert.equal(core.extractIdentityMarkers('画江湖之不良人 第六季'), 's6');
  assert.equal(core.extractIdentityMarkers('第十一季'), 's11');
  // 纯数字片名不误判为季
  assert.equal(core.extractIdentityMarkers('2012'), '');
  // PS2 不吞成 S2
  assert.equal(core.extractIdentityMarkers('PS2'), '');
});

test('cleanTitleForAgg keeps season identity and strips noise', () => {
  assert.equal(core.cleanTitleForAgg('一念永恒 第二季'), '一念永恒|s2');
  assert.equal(core.cleanTitleForAgg('一念永恒2'), '一念永恒|s2');
  assert.equal(core.cleanTitleForAgg('一念永恒 国语版'), '一念永恒');
  assert.equal(core.cleanTitleForAgg('一念永恒'), '一念永恒');
  assert.equal(core.cleanTitleForAgg('一念永恒完结季'), '一念永恒|完结季');
});

test('aggregateByLocalKey keeps 完结季 separate from base work', () => {
  const merged = core.aggregateByLocalKey([
    { title: '一念永恒', year: '2020', variants: [{ id: 'base' }] },
    { title: '一念永恒完结季', year: '2026', variants: [{ id: 'fin' }] },
    { title: '一念永恒 第三季', year: '2024', variants: [{ id: 's3' }] },
  ]);
  assert.equal(merged.length, 3, '本体/完结季/第三季必须三张卡');
  const keys = merged.map((x) => core.cleanTitleForAgg(x.title)).sort();
  assert.deepEqual(keys, ['一念永恒', '一念永恒|s3', '一念永恒|完结季']);
});

test('aggregateByLocalKey does not fold empty-year base into later season', () => {
  const merged = core.aggregateByLocalKey([
    { title: '一念永恒 第二季', year: '2024', pic: 's2', variants: [{ id: 1 }] },
    { title: '一念永恒', year: '', pic: 'base', isKazumi: true, variants: [{ id: 2, isKazumi: true }] },
  ]);
  assert.equal(merged.length, 2, '本体与第二季必须分卡');
  const titles = merged.map((x) => x.title).sort();
  assert.ok(titles.some((t) => /第二季|一念永恒/.test(t)));
});

test('aggregateByLocalKey merges empty-year into same season identity', () => {
  const merged = core.aggregateByLocalKey([
    { title: '一念永恒 第二季', year: '2024', pic: 'cms', variants: [{ id: 'cms1' }] },
    { title: '一念永恒2', year: '', isKazumi: true, variants: [{ id: 'kz1', isKazumi: true }] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].variants.length, 2);
  assert.equal(merged[0].year, '2024');
});

test('aggregateByLocalKey keeps different years of same title separate', () => {
  const merged = core.aggregateByLocalKey([
    { title: '你的名字', year: '2016', variants: [{ id: 1 }] },
    { title: '你的名字', year: '2022', variants: [{ id: 2 }] },
  ]);
  assert.equal(merged.length, 2);
});

test('rankSearchResults keeps season family of a strong match', () => {
  const ranked = core.rankSearchResults([
    { title: '一念永恒' },
    { title: '一念永恒 第二季' },
    { title: '一念永恒2' },
    { title: '请以你的名字呼唤我' },
  ], '一念永恒');
  const titles = ranked.map((x) => x.title);
  assert.ok(titles.includes('一念永恒'));
  assert.ok(titles.includes('一念永恒 第二季') || titles.includes('一念永恒2'));
  assert.ok(!titles.includes('请以你的名字呼唤我'));
});

test('labelIdentityMarkers renders human season/edition labels', () => {
  assert.equal(core.labelIdentityMarkers('s2'), '第2季');
  assert.equal(core.labelIdentityMarkers('完结季'), '完结季');
  assert.equal(core.labelIdentityMarkers('s2+完结季'), '第2季 · 完结季');
  assert.equal(core.labelIdentityMarkers(''), '');
});

test('collectSeasonFamilyHits promotes raw hits missing from identity cards', () => {
  // 模拟：网格只有本体卡，raw 里另有完结季
  const raw = [
    { title: '一念永恒', year: '2020', variants: [{ id: 1 }] },
    { title: '一念永恒完结季', year: '2026', variants: [{ id: 2 }] },
    { title: '请以你的名字呼唤我', year: '2017', variants: [{ id: 3 }] },
  ];
  const cards = core.aggregateByLocalKey([raw[0]]);
  const family = core.collectSeasonFamilyHits(raw, cards, '一念永恒');
  assert.equal(family.length, 1);
  assert.equal(family[0].title, '一念永恒完结季');
  // 已有卡不再重复
  const again = core.collectSeasonFamilyHits(raw, cards.concat(family), '一念永恒');
  assert.equal(again.length, 0);
});

test('filterSeasonSiblings returns same-base seasons for detail rail', () => {
  const cards = core.aggregateByLocalKey([
    { title: '一念永恒', year: '2020' },
    { title: '一念永恒完结季', year: '2026' },
    { title: '一念永恒 第二季', year: '2022' },
    { title: '斗破苍穹', year: '2018' },
  ]);
  const sibs = core.filterSeasonSiblings(cards, '一念永恒');
  const titles = sibs.map((x) => x.title).sort();
  assert.deepEqual(titles, ['一念永恒 第二季', '一念永恒完结季']);
});
