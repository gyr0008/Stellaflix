'use strict';

/**
 * 追片 canonical 键（tmdb:<mt>:<id>）+ 多键读写原语行为测试
 * 运行：node --test tests/track-canonical-key.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModel() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'video', 'model.js'), 'utf8');
  const store = {};
  const sandbox = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Promise, parseInt, setTimeout,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'model.js' });
  return sandbox.StellaflixVideo.model;
}

test('canonicalTrackKey：TMDB 墙视图（id+mediaType）得 tmdb 键', () => {
  const m = loadModel();
  assert.strictEqual(m.canonicalTrackKey({ id: 284054, mediaType: 'movie' }), 'tmdb:movie:284054');
  assert.strictEqual(m.canonicalTrackKey({ id: 1399, mediaType: 'tv' }), 'tmdb:tv:1399');
});

test('canonicalTrackKey：_tmdb 优先；tmdb: 前缀 key 直通；源键/无 id 得 null', () => {
  const m = loadModel();
  assert.strictEqual(m.canonicalTrackKey({ _tmdb: { id: 5, mediaType: 'tv' }, id: 9, mediaType: 'movie' }), 'tmdb:tv:5');
  assert.strictEqual(m.canonicalTrackKey({ key: 'tmdb:movie:77' }), 'tmdb:movie:77');
  assert.strictEqual(m.canonicalTrackKey({ key: 's1:1048', vodId: 1048 }), null);
  assert.strictEqual(m.canonicalTrackKey(null), null);
  assert.strictEqual(m.canonicalTrackKey({ title: '无id' }), null);
});

test('getTrackStatusForKeys：按候选顺序取首个命中；全 miss 得 null', () => {
  const m = loadModel();
  m.setTrackStatus('s1:1048', 'watching');
  assert.strictEqual(m.getTrackStatusForKeys(['tmdb:movie:284054', 's1:1048']), 'watching');
  assert.strictEqual(m.getTrackStatusForKeys(['tmdb:movie:1']), null);
  assert.strictEqual(m.getTrackStatusForKeys([]), null);
});

test('setTrackStatusForKeys：写主键、清别名键（惰性迁移）、按主键播种 meta', () => {
  const m = loadModel();
  m.setTrackStatus('s1:1048', 'watching');
  const r = m.setTrackStatusForKeys(
    ['tmdb:movie:284054', 's1:1048'], 'planToWatch',
    { title: '末世橡樹街', pic: 'https://x/p.jpg', year: '2026' }
  );
  assert.strictEqual(r, 'planToWatch');
  assert.strictEqual(m.getTrackStatus('tmdb:movie:284054'), 'planToWatch');
  assert.strictEqual(m.getTrackStatus('s1:1048'), null, '别名键必须被清除，避免追片页双条目');
  const meta = m.getMeta('tmdb:movie:284054');
  assert.ok(meta, 'TMDB 主键首次追片须播种 meta，供追片页渲染标题封面');
  assert.strictEqual(meta.title, '末世橡樹街');
});

test('setTrackStatusForKeys(null)：循环回未追时两键全清', () => {
  const m = loadModel();
  m.setTrackStatusForKeys(['tmdb:movie:9', 's2:1'], 'watched', { title: 't' });
  m.setTrackStatusForKeys(['tmdb:movie:9', 's2:1'], null);
  assert.strictEqual(m.getTrackStatus('tmdb:movie:9'), null);
  assert.strictEqual(m.getTrackStatus('s2:1'), null);
});

test('setTrackStatusForKeys：无候选键得 null 且不抛', () => {
  const m = loadModel();
  assert.strictEqual(m.setTrackStatusForKeys([], 'watching'), null);
  assert.strictEqual(m.setTrackStatusForKeys(null, 'watching'), null);
});

// ---- 审查修复 I-1 / I-2 / I-3 + 非字符串候选键 ----

test('setTrackStatusForKeys(null)：clear 恒返 null，两键与主键 meta 全清', () => {
  const m = loadModel();
  m.setMeta({ key: 'tmdb:movie:9', title: '标题', pic: '', year: '' });
  m.setTrackStatusForKeys(['tmdb:movie:9', 's2:1'], 'watched');
  m.setTrackStatus('s2:1', 'watched'); // 存量脏数据：别名键仍有状态
  const r = m.setTrackStatusForKeys(['tmdb:movie:9', 's2:1'], null);
  assert.strictEqual(r, null, '清除动作必须返回 null，不得回吐别名旧状态');
  assert.strictEqual(m.getTrackStatus('tmdb:movie:9'), null);
  assert.strictEqual(m.getTrackStatus('s2:1'), null);
  assert.strictEqual(m.getMeta('tmdb:movie:9'), null, '取消追片须同步清理主键 meta');
});

test('setTrackStatusForKeys：无效状态整体短路——主键与别名键及其 meta 均不触碰', () => {
  const m = loadModel();
  m.setTrackStatus('tmdb:movie:9', 'watching');
  m.setTrackStatus('s2:1', 'planToWatch');
  m.setMeta({ key: 's2:1', title: '別名標題', pic: 'https://x/a.jpg', year: '2024' });
  const r = m.setTrackStatusForKeys(['tmdb:movie:9', 's2:1'], 'banana');
  assert.strictEqual(r, 'watching', '无效状态返回当前状态，等价于无操作');
  assert.strictEqual(m.getTrackStatus('tmdb:movie:9'), 'watching');
  assert.strictEqual(m.getTrackStatus('s2:1'), 'planToWatch', '无效状态不得清除别名键');
  const aliasMeta = m.getMeta('s2:1');
  assert.ok(aliasMeta && aliasMeta.title === '別名標題', '无效状态不得删除别名键 meta');
});

test('setTrackStatusForKeys：无 meta 入参时把别名键 meta 携带到主键，避免合并后未命名', () => {
  const m = loadModel();
  m.setTrackStatus('s2:1', 'watching');
  m.setMeta({ key: 's2:1', title: '異形', pic: 'https://x/a.jpg', year: '1979' });
  const r = m.setTrackStatusForKeys(['tmdb:movie:9', 's2:1'], 'watching');
  assert.strictEqual(r, 'watching');
  assert.strictEqual(m.getTrackStatus('s2:1'), null, '别名键仍须清除');
  const meta = m.getMeta('tmdb:movie:9');
  assert.ok(meta, '清别名键前须把其 meta 携带到 TMDB 主键，供追片页渲染');
  assert.strictEqual(meta.title, '異形');
  assert.strictEqual(meta.pic, 'https://x/a.jpg');
  assert.strictEqual(meta.year, '1979');
});

test('setTrackStatusForKeys：非字符串候选键被忽略且不抛', () => {
  const m = loadModel();
  let r;
  assert.doesNotThrow(() => {
    r = m.setTrackStatusForKeys([undefined, 123, {}, null, 'tmdb:movie:9', 'tmdb:movie:9'], 'watching');
  });
  assert.strictEqual(r, 'watching');
  assert.strictEqual(m.getTrackStatus('tmdb:movie:9'), 'watching');
  assert.strictEqual(m.setTrackStatusForKeys([0, false, {}], 'watching'), null, '全非字符串候选等价于无候选');
});

// ---- 终审修复批（2026-09-25）：C1 tmdbKey 再入 / M6 id 数字校验 / I2 别名清除边界
//      / I3+M10 播种字段级合并 / I4 跨面一致性 ----

// 从发布源码里抽出真实函数体放进 vm 执行：跑的是 shipped 代码本体，不是测试内镜像复刻。
function extractFnSrc(file, fnName) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'video', file), 'utf8');
  const hit = new RegExp('function\\s+' + fnName + '\\s*\\([\\s\\S]*?\\n  \\}').exec(src);
  assert.ok(hit, 'expected ' + fnName + '() in public/video/' + file);
  return hit[0];
}

// detail 侧候选键组装：SFV.model 注入真 model，view 走参数传入
function detailTrackKeys(model, view) {
  const sandbox = {
    JSON, Math, Date, String, Number, Array, Object, Boolean, RegExp,
    SFV: { model: model }, __arg: view, __result: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extractFnSrc('detail.js', 'trackKeysForView') + '\n__result = trackKeysForView(__arg);',
    sandbox,
    { filename: 'detail.js:trackKeysForView' }
  );
  // vm 沙箱里 new 出来的数组原型与宿主不同，展开成宿主数组再返回，便于 deepStrictEqual
  return Array.prototype.slice.call(sandbox.__result);
}

// player 侧候选键组装：meta 由 SFV.player.getMeta 提供；
// lastHeartTmdb 取 player-controller.js 的真实初始化，可注入记忆值模拟窗口期。
function playerTrackKeys(meta, memory) {
  const ctrlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'video', 'player-controller.js'), 'utf8');
  const init = /var\s+lastHeartTmdb\s*=\s*\{[^}]*\};/.exec(ctrlSrc);
  assert.ok(init, 'expected module-level `var lastHeartTmdb = { seriesKey: ..., tmdbKey: ... };`');
  const sandbox = {
    JSON, Math, Date, String, Number, Array, Object, Boolean, RegExp,
    __meta: meta, __memory: memory || null, __result: null,
    SFV: { player: { getMeta: () => sandbox.__meta } },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    init[0] + '\n' + extractFnSrc('player-controller.js', 'getHeartTrackKeys') +
      '\nif (__memory) { lastHeartTmdb.seriesKey = __memory.seriesKey; lastHeartTmdb.tmdbKey = __memory.tmdbKey; }' +
      '\n__result = getHeartTrackKeys();',
    sandbox,
    { filename: 'player-controller.js:getHeartTrackKeys' }
  );
  return Array.prototype.slice.call(sandbox.__result);
}

test('canonicalTrackKey：认 view.tmdbKey —— 播放器返回详情页的再入形态（只带 key+tmdbKey）', () => {
  const m = loadModel();
  // online-detail.openDetailFromMeta 展开 detail-source v2 后的视图：无 id/_tmdb/mediaType
  assert.strictEqual(m.canonicalTrackKey({ key: 'srcA:9', tmdbKey: 'tmdb:movie:42' }), 'tmdb:movie:42');
  assert.strictEqual(m.canonicalTrackKey({ key: 's1:1048', tmdbKey: 'tmdb:tv:1399', title: '破局' }), 'tmdb:tv:1399');
  // tmdbKey 分支位于 view.key 直通分支之前（播放器透传的 canonical 键优先于历史 key 字段）
  assert.strictEqual(m.canonicalTrackKey({ key: 'tmdb:movie:1', tmdbKey: 'tmdb:tv:2' }), 'tmdb:tv:2');
  // _tmdb 仍是最高优先级（enrich 后的视图口径不变）
  assert.strictEqual(m.canonicalTrackKey({ _tmdb: { id: 5, mediaType: 'tv' }, tmdbKey: 'tmdb:movie:42' }), 'tmdb:tv:5');
  // 端到端：详情页对「播放器返回后再入」的视图组装候选键，主键必须是 canonical（原始回归场景）
  const reentryKeys = detailTrackKeys(m, { key: 'srcA:9', tmdbKey: 'tmdb:movie:42', title: '片名' });
  assert.strictEqual(reentryKeys[0], 'tmdb:movie:42', '再入 view 的主键不得退化成源键，否则双键分裂回归');
  assert.deepStrictEqual(reentryKeys, ['tmdb:movie:42', 'srcA:9']);
});

test('canonicalTrackKey：无效 tmdbKey 形态不被采纳，继续走原有分支', () => {
  const m = loadModel();
  // tmdb:anime 不在 canonical 形态内（归一化明确不做）→ 退化到 id+mediaType 分支
  assert.strictEqual(m.canonicalTrackKey({ key: 'srcA:9', tmdbKey: 'tmdb:anime:1', id: 7, mediaType: 'movie' }), 'tmdb:movie:7');
  assert.strictEqual(m.canonicalTrackKey({ key: 'srcA:9', tmdbKey: 'tmdb:anime:1' }), null);
  // id 非数字
  assert.strictEqual(m.canonicalTrackKey({ key: 'srcA:9', tmdbKey: 'tmdb:movie:x', id: 8, mediaType: 'tv' }), 'tmdb:tv:8');
  assert.strictEqual(m.canonicalTrackKey({ key: 'srcA:9', tmdbKey: 'tmdb:movie:x' }), null);
  // 非字符串：对象/数字/null 一律跳过，原有 key 直通不受影响
  assert.strictEqual(m.canonicalTrackKey({ key: 'tmdb:movie:77', tmdbKey: 42 }), 'tmdb:movie:77');
  assert.strictEqual(m.canonicalTrackKey({ key: 'tmdb:movie:77', tmdbKey: { id: 42 } }), 'tmdb:movie:77');
  assert.strictEqual(m.canonicalTrackKey({ key: 'srcA:9', tmdbKey: null, id: 9, mediaType: 'movie' }), 'tmdb:movie:9');
  // 缺 mediaType / 前缀不完整
  assert.strictEqual(m.canonicalTrackKey({ key: 'srcA:9', tmdbKey: 'tmdb:movie' }), null);
  assert.strictEqual(m.canonicalTrackKey({ key: 'srcA:9', tmdbKey: 'movie:42' }), null);
});

test('canonicalTrackKey：id 必须是纯数字（防脏数据进存储键）；id 0 仍按现语义产出', () => {
  const m = loadModel();
  assert.strictEqual(m.canonicalTrackKey({ id: 'a/b', mediaType: 'movie' }), null);
  assert.strictEqual(m.canonicalTrackKey({ id: '1;DROP', mediaType: 'tv' }), null);
  assert.strictEqual(m.canonicalTrackKey({ id: '12 34', mediaType: 'movie' }), null);
  assert.strictEqual(m.canonicalTrackKey({ id: '42:9', mediaType: 'movie', key: 's1:42' }), null);
  assert.strictEqual(m.canonicalTrackKey({ id: 42.5, mediaType: 'movie' }), null);
  assert.strictEqual(m.canonicalTrackKey({ id: '42', mediaType: 'movie' }), 'tmdb:movie:42', '数字串仍有效');
  assert.strictEqual(m.canonicalTrackKey({ id: 0, mediaType: 'movie' }), 'tmdb:movie:0', 'id 0 不特判拒绝');
  assert.strictEqual(m.canonicalTrackKey({ id: 0, mediaType: 'tv' }), 'tmdb:tv:0');
});

test('别名合并写：别名只删 track，其 meta 保留；主键 meta 携带别名 sourceId/vodId/year', () => {
  const m = loadModel();
  m.setTrackStatus('srcA:9', 'watching');
  m.setMeta({ key: 'srcA:9', title: '源标题', pic: 'https://x/a.jpg', year: '2019', sourceId: 'srcA', vodId: '9' });
  m.setFlag('srcA:9', 'liked', true);
  const r = m.setTrackStatusForKeys(['tmdb:movie:42', 'srcA:9'], 'planToWatch', { title: '源标题' });
  assert.strictEqual(r, 'planToWatch');
  assert.strictEqual(m.getTrackStatus('tmdb:movie:42'), 'planToWatch', '状态落主键');
  assert.strictEqual(m.getTrackStatus('srcA:9'), null, '别名 track 必须消失（避免追片页双条目）');
  const aliasMeta = m.getMeta('srcA:9');
  assert.ok(aliasMeta, '别名 meta 不得被连带删除 —— 源键同时是 FLAG(心动)/首页封面池主键');
  assert.strictEqual(aliasMeta.title, '源标题');
  assert.strictEqual(aliasMeta.pic, 'https://x/a.jpg');
  const flag = m.getFlag('srcA:9'); // FLAG 与 META 共用源键命名空间
  assert.strictEqual(flag.liked, true, '心动旗必须健在，追片合并不得牵连 FLAG');
  assert.strictEqual(flag.inList, false);
  const primaryMeta = m.getMeta('tmdb:movie:42');
  assert.ok(primaryMeta, '主键须播种 meta，否则追片页显示未命名');
  assert.strictEqual(primaryMeta.sourceId, 'srcA', '须携带别名 sourceId，否则 online-track 无法重开源');
  assert.strictEqual(primaryMeta.vodId, '9');
  assert.strictEqual(primaryMeta.year, '2019');
});

test('真·取消追片（主键清除）保留完整 teardown：主键 meta 一并删除、别名 meta 保留', () => {
  const m = loadModel();
  m.setTrackStatus('srcA:9', 'watching'); // 存量：源键已追过，其 meta 同时服务 FLAG / 封面池
  m.setMeta({ key: 'srcA:9', title: '源标题', pic: '', year: '', sourceId: 'srcA', vodId: '9' });
  m.setTrackStatusForKeys(['tmdb:movie:42', 'srcA:9'], 'watching', { title: '源标题' });
  assert.ok(m.getMeta('tmdb:movie:42'));
  m.setTrackStatusForKeys(['tmdb:movie:42', 'srcA:9'], null);
  assert.strictEqual(m.getTrackStatus('tmdb:movie:42'), null);
  assert.strictEqual(m.getTrackStatus('srcA:9'), null);
  assert.strictEqual(m.getMeta('tmdb:movie:42'), null, '取消追片须清主键 meta（防膨胀语义保留）');
  assert.ok(m.getMeta('srcA:9'), '别名 meta 仍不得被牵连删除');
});

test('播种字段级合并：入参 meta 的空值不得清空别名 meta 已有字段', () => {
  const m = loadModel();
  m.setTrackStatus('src:1', 'watching');
  m.setMeta({ key: 'src:1', title: '舊標題', pic: 'https://x/old.jpg', year: '2019', sourceId: 'src', vodId: '1' });
  // 播放器侧 onHeartClick 固定传 { title, pic: cover||'', year: '' }：year 为空不得清空 carry.year
  const r = m.setTrackStatusForKeys(['tmdb:movie:7', 'src:1'], 'planToWatch', { title: 'T', pic: '', year: '' });
  assert.strictEqual(r, 'planToWatch');
  const meta = m.getMeta('tmdb:movie:7');
  assert.strictEqual(meta.title, 'T', '入参有标题时以入参为准');
  assert.strictEqual(meta.year, '2019', '入参 year 为空 → 回退别名 meta.year，不得清空');
  assert.strictEqual(meta.pic, 'https://x/old.jpg', '入参 pic 为空 → 回退别名 meta.pic');
  assert.strictEqual(meta.sourceId, 'src');
  assert.strictEqual(meta.vodId, '1');
});

test('播种：入参字段齐全时以入参为准，别名值仅作回退', () => {
  const m = loadModel();
  m.setMeta({ key: 'src:1', title: '舊標題', pic: 'https://x/old.jpg', year: '2019', sourceId: 'src', vodId: '1' });
  m.setTrackStatusForKeys(['tmdb:movie:7', 'src:1'], 'watching',
    { title: '新標題', pic: 'https://x/new.jpg', year: '2026' });
  const meta = m.getMeta('tmdb:movie:7');
  assert.strictEqual(meta.title, '新標題');
  assert.strictEqual(meta.pic, 'https://x/new.jpg');
  assert.strictEqual(meta.year, '2026');
  assert.strictEqual(meta.sourceId, 'src', '入参未提供的 sourceId 仍从别名补齐');
});

test('player 侧 tmdbKey 记忆：meta 丢掉 tmdbKey 的窗口期内主键仍是 canonical', () => {
  // 窗口期形态：setCurrentMeta 整体重建后只剩 seriesKey
  const healed = playerTrackKeys({ seriesKey: 'srcA:9' }, { seriesKey: 'srcA:9', tmdbKey: 'tmdb:movie:42' });
  assert.strictEqual(healed[0], 'tmdb:movie:42', '须用记忆的 tmdbKey 顶作主键（顺序锁不变：tmdb 先于 seriesKey）');
  assert.strictEqual(healed[1], 'srcA:9');
  // seriesKey 不匹配（换片了）→ 不得套用记忆，防串片
  assert.deepStrictEqual(playerTrackKeys({ seriesKey: 'srcB:1' }, { seriesKey: 'srcA:9', tmdbKey: 'tmdb:movie:42' }), ['srcB:1']);
  // 无记忆 → 维持原行为
  assert.deepStrictEqual(playerTrackKeys({ seriesKey: 'srcA:9' }), ['srcA:9']);
  // meta 自带 tmdbKey → 直接优先，记忆不参与
  assert.deepStrictEqual(playerTrackKeys({ seriesKey: 'srcA:9', tmdbKey: 'tmdb:movie:42' }, { seriesKey: 'srcA:9', tmdbKey: 'tmdb:movie:99' }),
    ['tmdb:movie:42', 'srcA:9']);
});

test('跨面一致：detail 与 player 对同一部片组装出的候选键首元素全等且状态互通', () => {
  const m = loadModel();
  const detailKeys = detailTrackKeys(m, {
    key: 'srcA:9', id: 42, mediaType: 'movie', tmdbKey: 'tmdb:movie:42',
    title: '片名', pic: 'https://x/42.jpg', year: '2024',
  });
  const playerKeys = playerTrackKeys({ key: 'srcA:9', seriesKey: 'srcA:9', tmdbKey: 'tmdb:movie:42' });
  assert.ok(Array.isArray(detailKeys) && detailKeys.length, 'detail 侧须组装出候选键');
  assert.ok(Array.isArray(playerKeys) && playerKeys.length, 'player 侧须组装出候选键');
  assert.strictEqual(detailKeys[0], playerKeys[0], '两侧主键必须全等，否则双键分裂回归');
  assert.strictEqual(detailKeys[0], 'tmdb:movie:42');
  assert.strictEqual(detailKeys[1], playerKeys[1], '别名键（源键）次序也须一致');
  // 真互通：播放器写 → 详情页读同一状态
  m.setTrackStatusForKeys(playerKeys, 'watching', { title: '片名', pic: 'https://x/42.jpg', year: '2024' });
  assert.strictEqual(m.getTrackStatusForKeys(detailKeys), 'watching');
  assert.strictEqual(m.getTrackStatus('tmdb:movie:42'), 'watching', '状态必须落在 canonical 主键上');
  // 详情页反向改写 → 播放器读到新值（互斥单值，别名键已被惰性清除）
  m.setTrackStatusForKeys(detailKeys, 'planToWatch', { title: '片名', pic: 'https://x/42.jpg', year: '2024' });
  assert.strictEqual(m.getTrackStatusForKeys(playerKeys), 'planToWatch');
});
