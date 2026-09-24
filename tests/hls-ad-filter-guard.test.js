'use strict';

/**
 * desktop/hls-ad-filter.js 守卫测试（B5 正片误删 / B6 直播保护）
 * 运行：node tests/hls-ad-filter-guard.test.js
 * 背景：0.1.3 审查报告 B5/B6 —— dropResolved 按 URI 全局去重会误删与广告组
 * 复用同一 URI 的正片分片；无 #EXT-X-ENDLIST 的直播清单被过滤会打乱 hls.js
 * 序列对齐。本文件锁定这两个行为契约。
 */

const assert = require('assert');
const { filterHlsAds } = require('../desktop/hls-ad-filter');

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2714 ' + label);
  } catch (e) {
    failed++;
    console.error('  \u2716 ' + label + '\n    ' + (e && e.message));
  }
}

function countSegs(text) {
  return (text.match(/\.ts(\?|#|$)/gm) || []).length;
}

// 广告组（2×10s）与正片组（4×120s + 120s）复用 main/s1.ts 的 VOD 清单
const VOD = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:120',
  '#EXTINF:120.000,',
  'main/s0.ts',
  '#EXTINF:120.000,',
  'main/s1.ts',
  '#EXTINF:120.000,',
  'main/s2.ts',
  '#EXT-X-DISCONTINUITY',
  '#EXTINF:10.000,',
  'ad/only.ts',
  '#EXTINF:10.000,',
  'main/s1.ts',
  '#EXT-X-DISCONTINUITY',
  '#EXTINF:120.000,',
  'main/s3.ts',
  '#EXT-X-ENDLIST',
].join('\n') + '\n';

const LIVE = VOD.replace('#EXT-X-ENDLIST\n', '');

console.log('B5：广告组与正片组复用同一分片 URI');
check('正片组分片必须保留，广告组出现（含复用 URI 的）照删', () => {
  const r = filterHlsAds(VOD, 'https://cdn.test/p.m3u8');
  assert.strictEqual(r.changed, true, '应发生过滤 changed=true');
  // 删除 2 处广告位出现：ad/only.ts + 广告组里复用的 main/s1.ts
  assert.strictEqual(r.removed, 2, '应删 2 处广告位出现，实际 removed=' + r.removed);
  assert.ok(r.content.indexOf('ad/only.ts') === -1, '广告独有分片应被删除');
  assert.ok(r.content.indexOf('main/s1.ts') !== -1, '正片组里的 main/s1.ts 原份必须保留');
  ['main/s0.ts', 'main/s2.ts', 'main/s3.ts'].forEach(function (u) {
    assert.ok(r.content.indexOf(u) !== -1, '正片分片 ' + u + ' 必须保留');
  });
  assert.strictEqual(countSegs(r.content), 4, '过滤后应剩 4 个分片，实际 ' + countSegs(r.content));
});

console.log('B6：直播/无 ENDLIST 清单原样放行');
check('无 #EXT-X-ENDLIST 的清单不得被过滤', () => {
  const r = filterHlsAds(LIVE, 'https://cdn.test/p.m3u8');
  assert.strictEqual(r.changed, false, '直播清单必须原样返回');
  assert.strictEqual(r.reason, 'live-playlist', 'reason 应为 live-playlist，实际 ' + r.reason);
  assert.strictEqual(r.content, LIVE, '内容必须逐字节一致');
});

check('带 ENDLIST 的同一清单仍正常过滤（防过度保守）', () => {
  const r = filterHlsAds(VOD, 'https://cdn.test/p.m3u8');
  assert.strictEqual(r.reason, 'filtered');
  assert.strictEqual(countSegs(r.content), 4);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
