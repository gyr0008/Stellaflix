'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadEnrichIdentity(tmdbBestMatch) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
    Math,
    JSON,
  };
  sandbox.global = sandbox;
  sandbox.window = sandbox;
  const doc = {
    getElementById: () => null,
    createElement: () => ({
      style: {},
      classList: { add() {}, remove() {} },
      appendChild() {},
      addEventListener() {},
      setAttribute() {},
    }),
    body: { classList: { add() {}, remove() {}, contains: () => false }, appendChild() {}, removeChild() {} },
    addEventListener() {},
  };
  sandbox.document = doc;
  sandbox.StellaflixVideo = {
    onlineShared: {
      d: () => doc,
      el: () => doc.createElement('div'),
      toast() {},
      sourceById: () => null,
      hasSources: () => true,
      isVideoSpace: () => false,
    },
    onlineCore: {
      esc: (s) => String(s == null ? '' : s),
      fmtAgo: () => '',
      trackLabel: () => '',
      TRACK_META: {},
    },
    tmdb: {
      hasKey: () => true,
      bestMatch: tmdbBestMatch,
    },
    SearchFilterCore: require(path.join(root, 'public', 'video', 'search-filter-core.js')),
  };
  const code = fs.readFileSync(path.join(root, 'public', 'video', 'online-detail.js'), 'utf8');
  vm.runInNewContext(code, sandbox, { filename: 'online-detail.js' });
  return sandbox.StellaflixVideo;
}

test('enrichIdentity never merges cards that share a TMDB series id', async () => {
  // 模拟 TMDB：本体与完结季命中同一 series id（多季常见）
  const SFV = loadEnrichIdentity(function bestMatch(title) {
    return Promise.resolve({
      id: 999001,
      mediaType: 'tv',
      title: '一念永恒',
      rating: 8.5,
      poster: 'https://example.org/poster.jpg',
    });
  });

  const cards = [
    {
      title: '一念永恒',
      year: '2020',
      variants: [{ id: 'a' }],
      cmsVars: [{ id: 'a' }],
      kzVars: [],
      _localKey: '一念永恒|2020',
    },
    {
      title: '一念永恒完结季',
      year: '2026',
      variants: [{ id: 'b' }],
      cmsVars: [{ id: 'b' }],
      kzVars: [],
      _localKey: '一念永恒|完结季|2026',
    },
    {
      title: '一念永恒 第二季',
      year: '2022',
      variants: [{ id: 'c' }],
      cmsVars: [{ id: 'c' }],
      kzVars: [],
      _localKey: '一念永恒|s2|2022',
    },
  ];

  const out = await SFV.onlineDetail.enrichIdentity(cards);
  assert.equal(out.length, 3, '三张身份卡必须原样保留，禁止因同 tmdbId 合并');
  const titles = out.map((x) => x.title).sort();
  assert.deepEqual(titles, ['一念永恒', '一念永恒 第二季', '一念永恒完结季']);
  out.forEach((c) => {
    assert.equal(c.tmdbId, 999001);
    assert.equal(c.tmdbRating, 8.5);
    assert.ok(c.pic.indexOf('poster.jpg') >= 0);
  });
});

test('enrichIdentity keeps per-card variant lists intact', async () => {
  const SFV = loadEnrichIdentity(() => Promise.resolve(null));
  const cards = [
    { title: '一念永恒', variants: [{ id: 1 }, { id: 2 }], cmsVars: [{ id: 1 }, { id: 2 }], kzVars: [] },
    { title: '一念永恒完结季', variants: [{ id: 3, isKazumi: true }], cmsVars: [], kzVars: [{ id: 3, isKazumi: true }] },
  ];
  const out = await SFV.onlineDetail.enrichIdentity(cards);
  assert.equal(out.length, 2);
  assert.equal(out[0].variants.length, 2);
  assert.equal(out[1].variants.length, 1);
  assert.equal(out[1].isKazumi, true);
});
