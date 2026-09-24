'use strict';

/**
 * 追片 canonical 键接线测试：详情页 / 起播链路 / 播放器三处必须走
 * model.canonicalTrackKey + get/setTrackStatusForKeys，禁止再直接读写裸 view.key。
 * 运行：node --test tests/track-key-wiring.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const detailSrc = read('public/video/detail.js');

test('detail.js：trackKeysForView 以 canonical 键为主、view.key 兜底', () => {
  const fn = /function\s+trackKeysForView\s*\([\s\S]*?\n  \}/.exec(detailSrc);
  assert.ok(fn, 'expected trackKeysForView()');
  assert.match(fn[0], /canonicalTrackKey\s*\(/);
  assert.match(fn[0], /view\.key/);
});

test('detail.js：cycleTrackStatus 不再因缺 view.key 静默 return（原始 bug 回归锁）', () => {
  const fn = /function\s+cycleTrackStatus\s*\([\s\S]*?\n  \}/.exec(detailSrc);
  assert.ok(fn, 'expected cycleTrackStatus()');
  assert.match(fn[0], /trackKeysForView\s*\(/);
  assert.match(fn[0], /getTrackStatusForKeys\s*\(/);
  assert.match(fn[0], /setTrackStatusForKeys\s*\(/);
  assert.equal(/if\s*\(\s*!\s*key\s*\|\|/.test(fn[0]), false, '不得残留裸 key 早退守卫');
});

test('detail.js：首屏 curTrack 图标/标题也走候选键（进页即显示已追状态）', () => {
  const init = /var\s+curTrack\s*=[\s\S]{0,220}/.exec(detailSrc);
  assert.ok(init, 'expected curTrack init');
  assert.match(init[0], /getTrackStatusForKeys\s*\(/);
  assert.match(init[0], /trackKeysForView\s*\(/);
});

const detailSourceSrc = read('public/video/detail-source.js');
const orchestratorSrc = read('public/video/play-orchestrator.js');

test('detail-source.js：全部 4 处 v2 构造透传 tmdbKey（起播链路带 canonical 键）', () => {
  const hits = detailSourceSrc.match(/tmdbKey:\s*\(/g) || [];
  assert.strictEqual(hits.length, 4, 'v2 字面量应有且仅有 4 处注入 tmdbKey');
  assert.match(detailSourceSrc, /SFV\.model\.canonicalTrackKey/);
});

test('play-orchestrator.js：setMeta 透传 tmdbKey + seriesTitle 供 heart-btn 消费', () => {
  const call = /SFV\.player\.setMeta\(\{[^}]*\}\)/.exec(orchestratorSrc);
  assert.ok(call, 'expected setMeta({...}) call');
  assert.match(call[0], /tmdbKey:\s*view\.tmdbKey\s*\|\|/);
  assert.match(call[0], /seriesTitle:\s*view\.title/);
});

const playerCtrlSrc = read('public/video/player-controller.js');

test('player-controller：候选键组装 tmdbKey 优先、seriesKey 兜底', () => {
  const fn = /function\s+getHeartTrackKeys\s*\([\s\S]*?\n  \}/.exec(playerCtrlSrc);
  assert.ok(fn, 'expected getHeartTrackKeys()');
  assert.match(fn[0], /meta\.tmdbKey/);
  assert.match(fn[0], /meta\.seriesKey/);
});

test('player-controller：onHeartClick/refreshHeartBtn 走 ForKeys 原语，不再裸用 seriesKey 写读', () => {
  const click = /function\s+onHeartClick\s*\([\s\S]*?\n  \}/.exec(playerCtrlSrc);
  assert.ok(click, 'expected onHeartClick()');
  assert.match(click[0], /getTrackStatusForKeys\s*\(/);
  assert.match(click[0], /setTrackStatusForKeys\s*\(/);
  assert.match(click[0], /getHeartTrackKeys\s*\(/);
  const refresh = /function\s+refreshHeartBtn\s*\([\s\S]*?\n  \}/.exec(playerCtrlSrc);
  assert.ok(refresh, 'expected refreshHeartBtn()');
  assert.match(refresh[0], /getTrackStatusForKeys\s*\(/);
});

// ===== 加固锁（Task 4 审查裁定）：候选顺序 / 单键 API 负锁 / 写入载荷与兜底 =====

test('player-controller：getHeartTrackKeys 候选顺序锁 —— tmdbKey 必须先于 seriesKey push（顺序颠倒会写别名键并清主键）', () => {
  const fn = /function\s+getHeartTrackKeys\s*\([\s\S]*?\n  \}/.exec(playerCtrlSrc);
  assert.ok(fn, 'expected getHeartTrackKeys()');
  const body = fn[0];
  const tmdbIdx = body.indexOf('keys.push(meta.tmdbKey)');
  const seriesIdx = body.indexOf('keys.push(meta.seriesKey)');
  assert.notStrictEqual(tmdbIdx, -1, 'expected keys.push(meta.tmdbKey)');
  assert.notStrictEqual(seriesIdx, -1, 'expected keys.push(meta.seriesKey)');
  assert.equal(tmdbIdx < seriesIdx, true, 'tmdbKey 必须排在 seriesKey 之前（主键=canonical）');
  assert.match(body, /keys\.indexOf\(\s*meta\.seriesKey\s*\)/, 'seriesKey 入队前必须去重，避免同键重复 push');
});

test('player-controller：onHeartClick/refreshHeartBtn 禁再用单键原语 getTrackStatus/setTrackStatus（标题所称"不再裸用"的实证锁）', () => {
  const click = /function\s+onHeartClick\s*\([\s\S]*?\n  \}/.exec(playerCtrlSrc);
  assert.ok(click, 'expected onHeartClick()');
  const refresh = /function\s+refreshHeartBtn\s*\([\s\S]*?\n  \}/.exec(playerCtrlSrc);
  assert.ok(refresh, 'expected refreshHeartBtn()');
  for (const [name, body] of [['onHeartClick', click[0]], ['refreshHeartBtn', refresh[0]]]) {
    assert.equal(body.includes('SFV.model.getTrackStatus('), false, name + ' 不得调用单键 SFV.model.getTrackStatus(key)');
    assert.equal(body.includes('SFV.model.setTrackStatus('), false, name + ' 不得调用单键 SFV.model.setTrackStatus(key, status)');
    assert.match(body, /getTrackStatusForKeys\s*\(/, name + ' 必须保留 ForKeys 读原语');
  }
  assert.match(click[0], /setTrackStatusForKeys\s*\(/, 'onHeartClick 必须保留 ForKeys 写原语');
});

test('player-controller：onHeartClick 写入载荷锁（keys+next+meta 播种）与 refreshHeartBtn 主键回填兜底', () => {
  const click = /function\s+onHeartClick\s*\([\s\S]*?\n  \}/.exec(playerCtrlSrc);
  assert.ok(click, 'expected onHeartClick()');
  assert.match(click[0], /setTrackStatusForKeys\(\s*keys\s*,\s*next\s*,/, '必须把候选键数组与下一状态作为载荷写入');
  assert.match(click[0], /title:\s*\(meta\s*&&\s*meta\.seriesTitle\)/, 'meta 播种须带 seriesTitle');
  const refresh = /function\s+refreshHeartBtn\s*\([\s\S]*?\n  \}/.exec(playerCtrlSrc);
  assert.ok(refresh, 'expected refreshHeartBtn()');
  assert.equal(refresh[0].includes('currentSeriesKey = keys[0] || null'), true, 'refreshHeartBtn 须把主键回填 currentSeriesKey，供无 meta 时点击兜底');
});

// ===== 终审加固（I4）：detail 侧候选键顺序锁 —— 与 player 侧同款 indexOf 位置比较 =====

test('detail.js：trackKeysForView 候选顺序锁 —— canonical 主键必须先于 view.key 别名键 push', () => {
  const fn = /function\s+trackKeysForView\s*\([\s\S]*?\n  \}/.exec(detailSrc);
  assert.ok(fn, 'expected trackKeysForView()');
  const body = fn[0];
  const canonicalIdx = body.indexOf('keys.push(c)');
  const viewKeyIdx = body.indexOf('keys.push(view.key)');
  assert.notStrictEqual(canonicalIdx, -1, 'expected keys.push(c)（canonical 主键入队）');
  assert.notStrictEqual(viewKeyIdx, -1, 'expected keys.push(view.key)（源键别名入队）');
  assert.equal(canonicalIdx < viewKeyIdx, true,
    'canonical 必须排在 view.key 之前（主键=TMDB 键；顺序颠倒会把状态写进源键并清掉主键）');
  assert.match(body, /keys\.indexOf\(\s*view\.key\s*\)/, 'view.key 入队前必须去重，避免同键重复 push');
  // 与 player 侧同款约束：候选键组装函数不得使用单键原语（单键读写会绕过惰性合并）
  assert.equal(body.includes('SFV.model.getTrackStatus('), false, 'trackKeysForView 不得调用单键 getTrackStatus');
  assert.equal(body.includes('SFV.model.setTrackStatus('), false, 'trackKeysForView 不得调用单键 setTrackStatus');
});

// ===== 终审缓解项：player 侧 tmdbKey 记忆（setCurrentMeta 窗口期兜底）接线锁 =====

test('player-controller：lastHeartTmdb 记忆 —— refreshHeartBtn 记录、getHeartTrackKeys 消费', () => {
  assert.match(playerCtrlSrc, /var\s+lastHeartTmdb\s*=\s*\{[^}]*seriesKey[^}]*tmdbKey[^}]*\};/,
    '须有模块级记忆变量 var lastHeartTmdb = { seriesKey: ..., tmdbKey: ... };');
  const refresh = /function\s+refreshHeartBtn\s*\([\s\S]*?\n  \}/.exec(playerCtrlSrc);
  assert.ok(refresh, 'expected refreshHeartBtn()');
  assert.match(refresh[0], /lastHeartTmdb\.seriesKey\s*=/, 'refreshHeartBtn 须记录 seriesKey（认领凭据）');
  assert.match(refresh[0], /lastHeartTmdb\.tmdbKey\s*=/, 'refreshHeartBtn 须记录 tmdbKey');
  assert.match(refresh[0], /memMeta\.tmdbKey\s*&&\s*memMeta\.seriesKey/, '仅当两者同在才记录，避免脏映射');
  const keys = /function\s+getHeartTrackKeys\s*\([\s\S]*?\n  \}/.exec(playerCtrlSrc);
  assert.ok(keys, 'expected getHeartTrackKeys()');
  assert.match(keys[0], /lastHeartTmdb\.tmdbKey/, 'getHeartTrackKeys 须消费记忆的 tmdbKey');
  assert.match(keys[0], /meta\.seriesKey\s*===\s*lastHeartTmdb\.seriesKey/, '须按 seriesKey 相等认领，防跨片串键');
  // 顺序锁对兜底分支同样成立：记忆主键也必须排在别名键之前
  const memoryPush = keys[0].indexOf('keys.push(lastHeartTmdb.tmdbKey)');
  const seriesPush = keys[0].indexOf('keys.push(meta.seriesKey)');
  assert.notStrictEqual(memoryPush, -1, 'expected keys.push(lastHeartTmdb.tmdbKey) 兜底分支');
  assert.notStrictEqual(seriesPush, -1, 'expected keys.push(meta.seriesKey)');
  assert.equal(memoryPush < seriesPush, true, '记忆主键须排在 seriesKey 别名键之前');
});
