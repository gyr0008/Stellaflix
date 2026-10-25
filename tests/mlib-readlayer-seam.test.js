// tests/mlib-readlayer-seam.test.js —— 通用骨架
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '07-mlib-readlayer.js'), 'utf8');

// bootCtx：F1（watchSeam）要喂通知/数订阅次数，必须拿到 sandbox 本体；
// boot 保持原样（只要读层门面）以免动到既有 12 条测试。
function bootCtx(seam) {
  const sandbox = { console, setTimeout, Promise };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'readlayer' });
  if (seam) sandbox.window.stellaMlibSeam = seam;
  sandbox.window.__stellaMlibReadResetForTests();
  return { read: sandbox.window.stellaMlibRead, win: sandbox };
}
function boot(seam) { return bootCtx(seam).read; }
const track = (o) => Object.assign({ id: 't', name: 'n', artist: 'A', artistId: 'A1', album: 'X', albumId: 'AL1', cover: '', duration: 1, source: 'local-file', localFile: 'f', matched: true }, o);

test('engine-missing：缝未挂载 → status=engine-missing 空卡，不 throw', async () => {
  const read = boot(null);
  const r = await read.getAxisData('albums');
  assert.equal(r.status, 'engine-missing');
  assert.deepEqual(r.cards, []);
});

test('ok + 排序：专辑按 releaseYear 降序、无年份沉底按标题', async () => {
  const read = boot({
    getLibraryStats: async () => ({ ready: true, rev: 1 }),
    getTracks: async () => ({ tracks: [
      track({ albumId: 'a', album: 'B', releaseYear: 2001 }),
      track({ albumId: 'b', album: 'A', releaseYear: 2020 }),
      track({ albumId: 'c', album: 'Z' }),
    ], rev: 1 }),
    subscribe: () => () => {},
  });
  const r = await read.getAxisData('albums');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.cards.map((c) => c.id), ['b', 'a', 'c']);
});

test('rev 缓存命中：seam 只被调一次；rev 变化后重取', async () => {
  let calls = 0; let rev = 1;
  const read = boot({
    getLibraryStats: async () => ({ ready: true, rev }),
    getTracks: async () => { calls += 1; return { tracks: [track({})], rev }; },
    subscribe: () => () => {},
  });
  await read.getAxisData('albums'); await read.getAxisData('albums');
  assert.equal(calls, 1, 'rev 相同命中缓存');
  rev = 2;
  await read.getAxisData('albums');
  assert.equal(calls, 2, 'rev 变化缓存作废');
});

test('并发去重：同轴 in-flight 复用同一 promise', async () => {
  let calls = 0;
  const read = boot({
    getLibraryStats: async () => ({ ready: true, rev: 1 }),
    getTracks: async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); return { tracks: [track({})], rev: 1 }; },
    subscribe: () => () => {},
  });
  const [a, b] = await Promise.all([read.getAxisData('albums'), read.getAxisData('albums')]);
  assert.equal(calls, 1); assert.equal(a.cards.length, b.cards.length);
});

test('seq 丢弃：rev 中途变化时旧响应不污染缓存', async () => {
  let rev = 1;
  const read = boot({
    getLibraryStats: async () => ({ ready: true, rev }),
    getTracks: async () => {
      const mine = rev;
      await new Promise((r) => setTimeout(r, mine === 1 ? 20 : 1));
      return { tracks: [track({ albumId: 'v' + mine })], rev: mine };
    },
    subscribe: () => () => {},
  });
  const p1 = read.getAxisData('albums');       // rev 1 慢
  await new Promise((r) => setTimeout(r, 5));
  rev = 2;
  const p2 = read.getAxisData('albums');       // rev 2 快
  await p1; const r2 = await p2;
  assert.equal(r2.cards[0].id, 'v2');
  const r3 = await read.getAxisData('albums');
  assert.equal(r3.cards[0].id, 'v2', '慢旧响应不得覆盖缓存');
});

test('error 如实上浮：缝返回 error → status=error + message 透传', async () => {
  const read = boot({
    getLibraryStats: async () => ({ ready: true, rev: 1 }),
    getTracks: async () => ({ tracks: [], error: { code: 'ENGINE_BOOT', message: '索引重建中' } }),
    subscribe: () => () => {},
  });
  const r = await read.getAxisData('albums');
  assert.equal(r.status, 'error');
  assert.equal(r.message, '索引重建中');
});

// ---- Task 6 携带补测：getDetail 的态口径（此前 review 认定缺失）----

test('getDetail：缝未挂载 → status=engine-missing，不 throw', async () => {
  const read = boot(null); // 无任何缝
  const r = await read.getDetail('albums', 'AL1');
  assert.equal(r.status, 'engine-missing');
  assert.equal(r.entity, null);
  assert.deepEqual(r.tracks, []);
});

test('getDetail：缝缺该轴详情方法 → status=engine-missing（未知轴同口径）', async () => {
  const read = boot({ getAlbumDetail: async () => ({ entity: {}, tracks: [] }) });
  const r = await read.getDetail('artists', 'AR1'); // 只挂了专辑详情，艺人详情方法缺失
  assert.equal(r.status, 'engine-missing');
});

test('getDetail：缝返回 error → status=error 且 message 逐字透传（不得退化为通用兜底）', async () => {
  const msg = '专辑索引损坏：ALBUM_CORRUPT(409)';
  const read = boot({ getAlbumDetail: async () => ({ entity: { id: 'AL1', title: 'A' }, tracks: [], error: { code: 'ALBUM_CORRUPT', message: msg } }) });
  const r = await read.getDetail('albums', 'AL1');
  assert.equal(r.status, 'error');
  assert.equal(r.message, msg, '缝 message 必须原样上浮，不是通用「读取失败」');
  assert.equal(r.error.message, msg, 'error 对象也保留');
});

test('getDetail：缝方法抛异常 → status=error + message 取异常文本', async () => {
  const read = boot({ getPlaylistDetail: async () => { throw new Error('缝炸了'); } });
  const r = await read.getDetail('playlists', 'P1');
  assert.equal(r.status, 'error');
  assert.equal(r.message, '缝炸了');
});

test('getDetail：正常返回 → status=ok + entity/tracks 透传', async () => {
  const entity = { id: 'AL1', title: 'A' };
  const tracks = [track({ id: 't1' })];
  const read = boot({ getAlbumDetail: async () => ({ entity, tracks }) });
  const r = await read.getDetail('albums', 'AL1');
  assert.equal(r.status, 'ok');
  assert.equal(r.entity, entity);
  assert.equal(r.tracks, tracks);
});

/* ---- 批4 引擎形状兼容（10-25 主人拍板：兼容加在读层，不在页面） ----
 * spec §3 契约表写的是 `{ entity, tracks, error }`，而引擎侧 04-shelf/14-mlib-seam.js
 * 的 getAlbumDetail/getArtistDetail 返回**扁平** `{ id, title, artist, cover, tracks, rev }`。
 * 读层是缝的唯一消费方，故在缝边界上把扁平形状认作实体；页面层继续只认 entity。
 */

test('getDetail：引擎扁平专辑详情 → 合成 entity（title/sub=artist/count/发行年）', async () => {
  const tracks = [track({ id: 't1', album: '十一月的萧邦', artist: '周杰伦', releaseYear: 2005 }), track({ id: 't2' })];
  const read = boot({ getAlbumDetail: async () => ({ id: 'AL1', title: '十一月的萧邦', artist: '周杰伦', cover: 'c', tracks, rev: 7 }) });
  const r = await read.getDetail('albums', 'AL1');
  assert.equal(r.status, 'ok');
  assert.equal(r.tracks, tracks, 'tracks 仍是同一引用（不得复制/包装）');
  assert.equal(r.entity.title, '十一月的萧邦');
  assert.equal(r.entity.sub, '周杰伦', '专辑详情 eyebrow＝引擎 artist 原文');
  assert.equal(r.entity.count, 2, '曲目数由 tracks 长度派生');
  assert.equal(r.entity.meta.releaseYear, 2005, '发行年取首轨 releaseYear');
});

test('getDetail：引擎扁平艺人详情 → sub 留空、不拿专辑字段凑', async () => {
  const tracks = [track({ id: 't1' }), track({ id: 't2' }), track({ id: 't3' })];
  const read = boot({ getArtistDetail: async () => ({ id: 'AR1', title: '周杰伦', cover: '', tracks, rev: 1 }) });
  const r = await read.getDetail('artists', 'AR1');
  assert.equal(r.status, 'ok');
  assert.equal(r.entity.title, '周杰伦');
  assert.equal(r.entity.sub, '', '艺人无 sub 来源：留空，绝不发明文案');
  assert.equal(r.entity.count, 3);
  assert.equal(r.entity.meta.releaseYear, 0, '无发行年轨 → 0（页面据此不渲染年份）');
});

test('getDetail：entity 与扁平字段同时在场 → 以 entity 为准，绝不改写', async () => {
  const entity = { title: '契约形状', sub: '来自 entity', count: 9, meta: { releaseYear: 1999 } };
  const read = boot({ getAlbumDetail: async () => ({ entity, tracks: [track()], title: '扁平标题', artist: '扁平艺人' }) });
  const r = await read.getDetail('albums', 'AL1');
  assert.equal(r.entity, entity, 'entity 在场即透传（同引用、同内容）');
  assert.equal(r.entity.title, '契约形状', '扁平 title 不得覆盖 entity.title');
  assert.equal(r.entity.sub, '来自 entity', '扁平 artist 不得覆盖 entity.sub');
});

test('getDetail：既无 entity 也无任何实体字段 → entity 仍为 null，不凭空造', async () => {
  const read = boot({ getAlbumDetail: async () => ({ tracks: [track()] }) });
  const r = await read.getDetail('albums', 'AL1');
  assert.equal(r.status, 'ok');
  assert.equal(r.entity, null, '只有 tracks 不构成实体：保持 null，由页面走既有降级头部');
});

test('getDetail：error 优先于兼容 —— 扁平字段在场也不合成实体', async () => {
  const msg = '索引损坏';
  const read = boot({ getAlbumDetail: async () => ({ title: '不该出现', tracks: [], error: { code: 'E', message: msg } }) });
  const r = await read.getDetail('albums', 'AL1');
  assert.equal(r.status, 'error');
  assert.equal(r.message, msg);
  assert.equal(r.entity, null, 'error 态不得用扁平字段拼出半个头部');
});

/* ---- F1（终审回批）：seam.subscribe 接线 ----
 * spec §4 契约表 line 60 写死了 subscribe(fn)→unsubscribe，§5 line 74/83 更要求
 * 「subscribe 发现 rev 变化→三轴+详情缓存全废」「引擎未挂载态等 subscribe，不轮询」。
 * 读层的 engine-missing 文案承诺「导入……后这里会自动出现」，靠的就是这条订阅。
 */

test('F1 watchSeam：整模块只订一枚缝订阅（多调用方共享一个监听数组），补挂幂等', async () => {
  let subCalls = 0;
  const { read } = bootCtx({
    getLibraryStats: async () => ({ ready: true, rev: 1 }),
    getTracks: async () => ({ tracks: [track({})], rev: 1 }),
    subscribe: () => { subCalls += 1; return () => {}; },
  });
  assert.equal(typeof read.watchSeam, 'function', '读层必须导出 watchSeam(onChange)');
  read.watchSeam(() => {});
  read.watchSeam(() => {});
  assert.equal(subCalls, 1, '两个调用方共享同一枚 seam 订阅：subscribe 恰调用一次');
  await read.getAxisData('albums');
  await read.getAxisData('albums');
  assert.equal(subCalls, 1, 'getAxisData 每次补挂必须幂等，不得重订');
});

test('F1 缝通知：先 invalidate 再逐个回调（rev 没变也要重取，否则空态永远等不到真卡）', async () => {
  let notify = null;
  let calls = 0;
  const { read } = bootCtx({
    getLibraryStats: async () => ({ ready: true, rev: 1 }),
    getTracks: async () => { calls += 1; return { tracks: [track({ albumId: 'v' + calls })], rev: 1 }; },
    subscribe: (fn) => { notify = fn; return () => {}; },
  });
  const r1 = await read.getAxisData('albums');
  assert.equal(r1.cards[0].id, 'v1');
  assert.equal(typeof notify, 'function', '缝在场时 getAxisData 必须把订阅补挂上（缝可以晚于页面出现）');
  const seen = [];
  read.watchSeam(() => seen.push('a'));
  read.watchSeam(() => seen.push('b'));
  notify();
  assert.deepEqual(seen, ['a', 'b'], '一次通知逐个回调所有登记方');
  const r2 = await read.getAxisData('albums');
  assert.equal(calls, 2, '通知即 invalidate：rev 相同也不得命中那份旧缓存');
  assert.equal(r2.cards[0].id, 'v2');
});

test('F1 通知打在在途请求上：旧响应经 seq 自然作废，不得回写缓存', async () => {
  let notify = null;
  let calls = 0;
  const { read } = bootCtx({
    getLibraryStats: async () => ({ ready: true, rev: 1 }),
    getTracks: async () => {
      const mine = ++calls;
      await new Promise((r) => setTimeout(r, mine === 1 ? 20 : 1));
      return { tracks: [track({ albumId: 'v' + mine })], rev: mine };
    },
    subscribe: (fn) => { notify = fn; return () => {}; },
  });
  read.watchSeam(() => {});
  const p1 = read.getAxisData('albums');     // 第一发慢
  await new Promise((r) => setTimeout(r, 5));
  notify();                                  // 在途期间来通知
  await p1;
  const r2 = await read.getAxisData('albums');
  assert.equal(calls, 2, '通知后必须重新打缝');
  assert.equal(r2.cards[0].id, 'v2', '晚到的旧在途响应不得污染缓存');
});

test('F1 unsubscribe 摘干净：该回调不再收通知；最后一个摘除后连缝订阅一并释放', async () => {
  let notify = null;
  let subCalls = 0;
  let offCalls = 0;
  const { read } = bootCtx({
    getLibraryStats: async () => ({ ready: true, rev: 1 }),
    getTracks: async () => ({ tracks: [track({})], rev: 1 }),
    subscribe: (fn) => { subCalls += 1; notify = fn; return () => { offCalls += 1; }; },
  });
  await read.getAxisData('albums');
  const hits = [];
  const off1 = read.watchSeam(() => hits.push(1));
  const off2 = read.watchSeam(() => hits.push(2));
  assert.equal(typeof off1, 'function', 'watchSeam 返回 unsubscribe');
  off1();
  notify();
  assert.deepEqual(hits, [2], '已摘除的回调不再被调用，其余登记方照常');
  assert.equal(offCalls, 0, '还有别的监听方时不得释放整模块那枚缝订阅');
  off2();
  assert.equal(offCalls, 1, '最后一个监听方摘除＝缝订阅一并释放（不漏水）');
  hits.length = 0;
  notify();   // 缝若仍握着那枚旧 handler：不得再触发 invalidate/回调
  assert.deepEqual(hits, [], '已作废的订阅回调一律不干活');
  read.watchSeam(() => hits.push('again'));
  assert.equal(subCalls, 2, '释放后再来调用方＝重新补挂一枚');
  notify();
  assert.deepEqual(hits, ['again'], '重订后通知仍然送达');
});

test('F1 缝被换掉（第二份挂载）：先退旧订阅再订新的一枚，任意时刻至多一枚在册', async () => {
  const subs = [];
  const mkSeam = (albumId) => ({
    getLibraryStats: async () => ({ ready: true, rev: 1 }),
    getTracks: async () => ({ tracks: [track({ albumId })], rev: 1 }),
    subscribe: (fn) => { const rec = { fn, offs: 0 }; subs.push(rec); return () => { rec.offs += 1; }; },
  });
  const ctx = bootCtx(mkSeam('A'));
  const hits = [];
  ctx.read.watchSeam(() => hits.push(1));
  await ctx.read.getAxisData('albums');
  assert.equal(subs.length, 1, '第一份缝：恰一枚订阅');
  ctx.win.stellaMlibSeam = mkSeam('B');      // 并行会话换了第二份缝（引擎重启/重挂载）
  await ctx.read.getAxisData('albums');
  assert.equal(subs.length, 2, '换缝＝另订一枚（幂等只保证「同一枚缝不重订」）');
  assert.equal(subs[0].offs, 1, '旧那一枚必须先行释放：不漏水才有「至多一枚在册」');
  subs[0].fn();
  assert.deepEqual(hits, [], '已被取代的旧 handler 再进来一律空转');
  subs[1].fn();
  assert.deepEqual(hits, [1], '现役那枚订阅照常通知所有登记方');
});

test('F1 缝缺席／缝没实现 subscribe：静默不订、不抛，返回 no-op unsubscribe', async () => {
  const noSub = bootCtx({
    getLibraryStats: async () => ({ ready: true, rev: 1 }),
    getTracks: async () => ({ tracks: [track({})], rev: 1 }),
  });
  let hits = 0;
  const off = noSub.read.watchSeam(() => { hits += 1; });
  assert.equal(typeof off, 'function', '没有 subscribe 也要返回可调用的 unsubscribe');
  await noSub.read.getAxisData('albums');   // 补挂路径同样不得抛
  off();
  assert.equal(hits, 0);
  const absent = bootCtx(null);
  const off2 = absent.read.watchSeam(() => {});
  assert.equal(typeof off2, 'function', '缝缺席时同样是 no-op，不抛');
  off2();
  const r = await absent.read.getAxisData('albums');
  assert.equal(r.status, 'engine-missing', '缝缺席仍按既有口径回 engine-missing');
  // 非函数入参：不抛、不登记（没有回调可通知）
  const bad = bootCtx({
    getLibraryStats: async () => ({ ready: true, rev: 1 }),
    getTracks: async () => ({ tracks: [track({})], rev: 1 }),
    subscribe: () => () => {},
  });
  assert.equal(typeof bad.read.watchSeam(null), 'function', 'watchSeam 非函数入参返回 unsubscribe，不抛');
  await bad.read.getAxisData('albums');
});
