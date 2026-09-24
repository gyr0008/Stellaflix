'use strict';

/**
 * desktop/hls-ad-filter.js 单元测试
 * 运行：node tests/hls-ad-filter.test.js
 */

const assert = require('assert');
const {
  filterHlsAds,
  parseSegments,
  identifyAdGroups,
  looksLikeM3u8Url,
  looksLikeM3u8Text,
} = require('../desktop/hls-ad-filter');

function runGroup(groupLabel, count, segDuration, prefix) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push('#EXTINF:' + segDuration.toFixed(3) + ',');
    lines.push('https://cdn.test/' + prefix + '/g' + groupLabel + '_' + i + '.ts');
  }
  return lines;
}

function playlist(parts) {
  // B6 配套：真实 VOD 清单以 #EXT-X-ENDLIST 收尾；缺 ENDLIST = 直播/截断清单，
  // 过滤器现按 live-playlist 原样放行，故测试夹具必须带上 ENDLIST 才走过滤分支。
  return ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:120'].concat(parts).concat(['#EXT-X-ENDLIST']).join('\n') + '\n';
}

function countSegs(text) {
  return (text.match(/\.ts(\?|#|$)/gm) || []).length;
}

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('[PASS]', name);
  } catch (e) {
    failed += 1;
    console.error('[FAIL]', name, '—', e.message);
  }
}

check('empty returns unchanged', () => {
  const r = filterHlsAds('', 'https://cdn.test/a.m3u8');
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.reason, 'empty');
});

check('master playlist passthrough', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000',
    'https://cdn.test/low.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000',
    'https://cdn.test/hi.m3u8',
  ].join('\n');
  const r = filterHlsAds(master, 'https://cdn.test/master.m3u8');
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.reason, 'master-playlist');
  assert.ok(r.content.indexOf('hi.m3u8') !== -1);
});

check('single group no filter', () => {
  const text = playlist(runGroup(0, 4, 10, 'main'));
  const r = filterHlsAds(text, 'https://cdn.test/p.m3u8');
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.reason, 'no-ads');
});

check('pre-roll + post-roll removed, main kept', () => {
  const parts = []
    .concat(['#EXT-X-DISCONTINUITY'])
    .concat(runGroup(0, 1, 15, 'pre'))
    .concat(['#EXT-X-DISCONTINUITY'])
    .concat(runGroup(1, 12, 120, 'main'))
    .concat(['#EXT-X-DISCONTINUITY'])
    .concat(runGroup(2, 1, 20, 'post'));
  const text = playlist(parts);
  const r = filterHlsAds(text, 'https://cdn.test/p.m3u8');
  assert.strictEqual(r.changed, true);
  assert.strictEqual(countSegs(r.content), 12);
  assert.ok(r.content.indexOf('pre/') === -1);
  assert.ok(r.content.indexOf('post/') === -1);
  assert.ok(r.content.indexOf('main/') !== -1);
});

check('mid-roll <30% removed', () => {
  const parts = []
    .concat(runGroup(0, 12, 120, 'main'))
    .concat(['#EXT-X-DISCONTINUITY'])
    .concat(runGroup(1, 2, 30, 'mid'))
    .concat(['#EXT-X-DISCONTINUITY'])
    .concat(runGroup(2, 12, 120, 'main2'));
  const text = playlist(parts);
  const r = filterHlsAds(text, 'https://cdn.test/p.m3u8');
  assert.strictEqual(countSegs(r.content), 24);
  assert.ok(r.content.indexOf('mid/') === -1);
});

check('~90s edge ED preserved', () => {
  const parts = []
    .concat(runGroup(0, 12, 120, 'main'))
    .concat(['#EXT-X-DISCONTINUITY'])
    .concat(runGroup(1, 1, 90, 'ed'));
  const text = playlist(parts);
  const r = filterHlsAds(text, 'https://cdn.test/p.m3u8');
  assert.strictEqual(countSegs(r.content), 13);
  assert.ok(r.content.indexOf('ed/') !== -1);
});

check('<10s group always removed', () => {
  const parts = []
    .concat(runGroup(0, 12, 120, 'main'))
    .concat(['#EXT-X-DISCONTINUITY'])
    .concat(runGroup(1, 1, 5, 'sting'))
    .concat(['#EXT-X-DISCONTINUITY'])
    .concat(runGroup(2, 12, 120, 'main2'));
  const text = playlist(parts);
  const r = filterHlsAds(text, 'https://cdn.test/p.m3u8');
  assert.ok(r.content.indexOf('sting/') === -1);
});

check('equal 3-part content fully kept', () => {
  const parts = []
    .concat(runGroup(0, 8, 60, 'p0'))
    .concat(['#EXT-X-DISCONTINUITY'])
    .concat(runGroup(1, 8, 60, 'p1'))
    .concat(['#EXT-X-DISCONTINUITY'])
    .concat(runGroup(2, 8, 60, 'p2'));
  const text = playlist(parts);
  const r = filterHlsAds(text, 'https://cdn.test/p.m3u8');
  assert.strictEqual(countSegs(r.content), 24);
});

check('preserves EXT-X-KEY and MAP tags', () => {
  const parts = [
    '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.test/k1.key"',
    '#EXT-X-MAP:URI="https://cdn.test/init.mp4"',
  ]
    .concat(runGroup(0, 2, 10, 'main'))
    .concat(['#EXT-X-DISCONTINUITY'])
    .concat(runGroup(1, 1, 5, 'ad'));
  const text = playlist(parts);
  const r = filterHlsAds(text, 'https://cdn.test/p.m3u8');
  assert.ok(r.content.indexOf('#EXT-X-KEY:METHOD=AES-128') !== -1);
  assert.ok(r.content.indexOf('#EXT-X-MAP:URI=') !== -1);
  assert.ok(r.content.indexOf('ad/') === -1);
});

check('relative URIs resolved against baseUrl', () => {
  const text = playlist([
    '#EXTINF:15.000,',
    'ad/pre.ts',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:120.000,',
    'main/s0.ts',
    '#EXTINF:120.000,',
    'main/s1.ts',
    '#EXTINF:120.000,',
    'main/s2.ts',
    '#EXTINF:120.000,',
    'main/s3.ts',
    '#EXTINF:120.000,',
    'main/s4.ts',
    '#EXTINF:120.000,',
    'main/s5.ts',
    '#EXTINF:120.000,',
    'main/s6.ts',
    '#EXTINF:120.000,',
    'main/s7.ts',
    '#EXTINF:120.000,',
    'main/s8.ts',
    '#EXTINF:120.000,',
    'main/s9.ts',
    '#EXTINF:120.000,',
    'main/s10.ts',
    '#EXTINF:120.000,',
    'main/s11.ts',
  ]);
  const r = filterHlsAds(text, 'https://cdn.test/path/p.m3u8');
  assert.ok(r.changed, 'should filter relative pre-roll');
  assert.ok(r.content.indexOf('ad/pre.ts') === -1);
  assert.ok(r.content.indexOf('main/s0.ts') !== -1);
});

check('parseSegments + identifyAdGroups basics', () => {
  const text = playlist(
    []
      .concat(runGroup(0, 1, 15, 'pre'))
      .concat(['#EXT-X-DISCONTINUITY'])
      .concat(runGroup(1, 4, 60, 'main'))
  );
  const segs = parseSegments(text, 'https://cdn.test/p.m3u8');
  assert.strictEqual(segs.length, 5);
  assert.strictEqual(segs[0].group, 0);
  assert.strictEqual(segs[1].group, 1);
  const { adGroups } = identifyAdGroups(segs);
  assert.ok(adGroups.has(0));
  assert.ok(!adGroups.has(1));
});

check('looksLikeM3u8 helpers', () => {
  assert.ok(looksLikeM3u8Url('https://a/b.m3u8?x=1'));
  assert.ok(!looksLikeM3u8Url('https://a/b.ts'));
  assert.ok(looksLikeM3u8Text('#EXTM3U\n#EXTINF:1,'));
  assert.ok(!looksLikeM3u8Text('not a playlist'));
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
