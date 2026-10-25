'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BRIDGE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '20-local-library-db-bridge.js'),
  'utf8'
);
const STATS_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '02-listen-stats.js'),
  'utf8'
);
const TRACKMAP_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '11-local-track-map.js'),
  'utf8'
);

/**
 * 按函数名截取真实源码片段，测试不复制生产实现。
 * @param {string} source 源码文本。
 * @param {string} startMarker 起始标记。
 * @param {string|null} endMarker 结束标记，null 表示截到文件末尾。
 * @returns {string} 源码片段。
 */
function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, '未找到接缝: ' + startMarker);
  if (endMarker === null || endMarker === undefined) return source.slice(start);
  const end = source.indexOf(endMarker, start + 1);
  assert.ok(end > start, '未找到接缝结尾: ' + endMarker);
  return source.slice(start, end);
}

/**
 * 建立 SQLite 曲库桥接的 vm 上下文。
 * @param {object|null} desktopWindow 伪造的桌面壳桥接对象，null 表示纯浏览器环境。
 * @returns {object} vm 上下文。
 */
function createBridgeContext(desktopWindow) {
  const context = {
    Promise,
    Object,
    Array,
    String,
    Number,
    Math,
    Date,
    JSON,
    console: { warn: () => {} },
    localLibraryDbState: { probed: false, available: false, promise: null, status: null },
  };
  context.window = desktopWindow ? { desktopWindow: desktopWindow } : {};
  vm.runInNewContext(
    slice(BRIDGE_SOURCE, 'function localLibraryDbApi(', null)
      + '\nthis.api = { localLibraryDbApi, probeLocalLibraryDb, localLibraryDbActive, callLocalLibraryDb,'
      + ' normalizeLocalLibraryPathKey, localLibraryPathKeyFromSong, localLibraryDbSongKeyFromSong,'
      + ' syncLocalLibraryDbPlayStat };',
    context,
  );
  return context;
}

/**
 * 建立可记录调用的伪桌面壳。
 * @param {object} options 行为开关。
 * @returns {object} 伪桥接对象与调用记录。
 */
function createFakeShell(options) {
  const opts = options || {};
  const calls = [];
  const shell = {
    isDesktop: true,
    /** @returns {Promise<object>} 返回存储状态。 */
    localLibraryDbStatus: async () => {
      calls.push({ method: 'localLibraryDbStatus', args: [] });
      if (opts.statusThrows) throw new Error('status failed');
      return opts.status === undefined ? { ok: true, available: true, files: 3 } : opts.status;
    },
    /** @returns {Promise<object>} 返回落库结果。 */
    bumpLocalLibraryDbPlayStat: async (...args) => {
      calls.push({ method: 'bumpLocalLibraryDbPlayStat', args: args });
      if (opts.methodThrows) throw new Error('ipc failed');
      return opts.result === undefined ? { ok: true } : opts.result;
    },
    /** @returns {Promise<object>} 返回双参调用的透传结果。 */
    twoArgMethod: async (...args) => {
      calls.push({ method: 'twoArgMethod', args: args });
      return { ok: true };
    },
    /** @returns {Promise<object>} 返回无参调用的透传结果。 */
    noArgMethod: async (...args) => {
      calls.push({ method: 'noArgMethod', args: args });
      return { ok: true };
    },
  };
  return { shell: shell, calls: calls };
}

/**
 * 纯浏览器或旧壳环境下探测必须一次性 latch 成不可用，之后所有调用都不再过 IPC。
 * @returns {Promise<void>}
 */
async function testProbeLatchesUnavailableWithoutShell() {
  const noShell = createBridgeContext(null);
  assert.equal(noShell.api.localLibraryDbApi(), null);
  assert.equal(await noShell.api.probeLocalLibraryDb(), false);
  assert.equal(noShell.api.localLibraryDbActive(), false);
  assert.equal(await noShell.api.callLocalLibraryDb('bumpLocalLibraryDbPlayStat', { key: 'k' }), null);
  assert.equal(noShell.localLibraryDbState.probed, true);

  // 旧桌面壳没有这条通道：isDesktop 为真但缺 localLibraryDbStatus，同样按不可用处理。
  const oldShell = createBridgeContext({ isDesktop: true });
  assert.equal(oldShell.api.localLibraryDbApi(), null);
  assert.equal(await oldShell.api.probeLocalLibraryDb(), false);
  assert.equal(oldShell.api.localLibraryDbActive(), false);
}

/**
 * 探测只走一次 IPC：并发调用共享同一个在途 promise，结论落定后直接复用。
 * @returns {Promise<void>}
 */
async function testProbeRunsOnce() {
  const fake = createFakeShell({});
  const context = createBridgeContext(fake.shell);
  const [a, b] = await Promise.all([context.api.probeLocalLibraryDb(), context.api.probeLocalLibraryDb()]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(await context.api.probeLocalLibraryDb(), true);
  assert.equal(fake.calls.filter((call) => call.method === 'localLibraryDbStatus').length, 1);
  assert.equal(context.api.localLibraryDbActive(), true);
  assert.equal(context.localLibraryDbState.status.files, 3);
  assert.equal(context.localLibraryDbState.promise, null);
}

/**
 * 主进程回报存储不可用时 latch 成不可用；瞬时异常只让本次调用回落，不永久关掉 SQLite 路径。
 * @returns {Promise<void>}
 */
async function testUnavailableLatchAndTransientError() {
  const unavailable = createFakeShell({ result: { ok: false, error: 'LOCAL_LIBRARY_DB_UNAVAILABLE' } });
  const context = createBridgeContext(unavailable.shell);
  assert.equal(await context.api.callLocalLibraryDb('bumpLocalLibraryDbPlayStat', { key: 'k' }), null);
  assert.equal(context.api.localLibraryDbActive(), false);
  assert.equal(await context.api.callLocalLibraryDb('bumpLocalLibraryDbPlayStat', { key: 'k' }), null);
  // latch 之后不再重复过 IPC。
  assert.equal(unavailable.calls.filter((call) => call.method === 'bumpLocalLibraryDbPlayStat').length, 1);

  const throwing = createFakeShell({ methodThrows: true });
  const context2 = createBridgeContext(throwing.shell);
  assert.equal(await context2.api.callLocalLibraryDb('bumpLocalLibraryDbPlayStat', { key: 'k' }), null);
  assert.equal(context2.api.localLibraryDbActive(), true, '单次 IPC 异常不能永久关闭 SQLite 路径');

  const badStatus = createBridgeContext(createFakeShell({ statusThrows: true }).shell);
  assert.equal(await badStatus.api.probeLocalLibraryDb(), false);
  assert.equal(badStatus.api.localLibraryDbActive(), false);

  const notAvailable = createBridgeContext(createFakeShell({ status: { ok: true, available: false } }).shell);
  assert.equal(await notAvailable.api.probeLocalLibraryDb(), false);
}

/**
 * 参数个数必须原样转发：双参、单参、无参各自如实送达，缺方法时静默返回 null。
 * @returns {Promise<void>}
 */
async function testForwardsArgumentArity() {
  const fake = createFakeShell({});
  const context = createBridgeContext(fake.shell);
  await context.api.callLocalLibraryDb('twoArgMethod', 'D:\\Music', { index: true });
  await context.api.callLocalLibraryDb('bumpLocalLibraryDbPlayStat', { key: 'k' });
  await context.api.callLocalLibraryDb('noArgMethod');
  const calls = fake.calls.filter((call) => call.method !== 'localLibraryDbStatus');
  assert.deepEqual(calls[0], { method: 'twoArgMethod', args: ['D:\\Music', { index: true }] });
  assert.deepEqual(calls[1], { method: 'bumpLocalLibraryDbPlayStat', args: [{ key: 'k' }] });
  assert.deepEqual(calls[2], { method: 'noArgMethod', args: [] });
  // 壳里没有这个方法时直接返回 null，不该抛异常也不该多走一次探测。
  assert.equal(await context.api.callLocalLibraryDb('methodThatDoesNotExist', 1), null);
}

/**
 * 行键必须与参照库同构（绝对路径:大小:修改时间），并优先沿用引擎自己算好的 localKey。
 * @returns {void}
 */
function testSongKeyAndPathKeyShapes() {
  const context = createBridgeContext(createFakeShell({}).shell);
  assert.equal(
    context.api.localLibraryDbSongKeyFromSong({
      localFilePathAbsolute: 'D:\\Music\\A.mp3',
      localFileSize: 1024,
      localFileLastModified: 1700000000000,
    }),
    'D:\\Music\\A.mp3:1024:1700000000000',
  );
  // 曲库引擎产出的曲目自带 localKey，统计必须认同一行，不能各算一套键。
  assert.equal(
    context.api.localLibraryDbSongKeyFromSong({
      localKey: 'D:\\Music\\A.mp3:1024:1700000000000',
      localFilePathAbsolute: 'D:\\Music\\B.mp3',
      localFileSize: 2048,
    }),
    'D:\\Music\\A.mp3:1024:1700000000000',
  );
  // 大小与修改时间缺失时夹成 0，与参照库 localSongKeyFromFile 一致。
  assert.equal(context.api.localLibraryDbSongKeyFromSong({ localFilePathAbsolute: 'D:\\Music\\A.mp3' }), 'D:\\Music\\A.mp3:0:0');
  // 拿不到绝对路径（纯浏览器拖入的临时曲目）时用相对路径、再退回文件名。
  assert.equal(context.api.localLibraryDbSongKeyFromSong({ localPath: 'a\\A.mp3', localFileSize: 8 }), 'a\\A.mp3:8:0');
  assert.equal(context.api.localLibraryDbSongKeyFromSong({ name: 'A.mp3' }), 'A.mp3:0:0');
  assert.equal(context.api.localLibraryDbSongKeyFromSong(null), '');
}

/**
 * 路径归一化在 04-shelf/11（曲库引擎）与本桥接层各有一份同名声明，拼接时后加载者胜出。
 * 别家会话的注册烟测已把这份冗余判定为良性并逐字比对结果，所以这里不强求单一主人，
 * 只守住本层产出的口径：正斜杠 + 折叠重复斜杠 + trim + 小写。
 * @returns {void}
 */
function testPathKeyCaliber() {
  assert.ok(TRACKMAP_SOURCE.includes('function normalizeLocalLibraryPathKey'), '曲库引擎层也声明了同名 helper（拼接冗余，改动要同步两处）');
  const context = createBridgeContext(createFakeShell({}).shell);
  assert.equal(context.api.normalizeLocalLibraryPathKey('D:\\Music\\\\A.mp3 '), 'd:/music/a.mp3');
  assert.equal(context.api.localLibraryPathKeyFromSong({ localFilePathAbsolute: 'D:\\Music\\A.mp3' }), 'd:/music/a.mp3');
  assert.equal(context.api.localLibraryPathKeyFromSong({ localPath: 'Album\\\\Song.flac' }), 'album/song.flac');
  assert.equal(context.api.localLibraryPathKeyFromSong(null), '');
}

/**
 * 主进程水合记录经引擎 localSongKeyFromFile 得到的键，必须与统计桥现算的键逐字相等，
 * 否则 song_stats 与索引/封面/歌词会落在不同行。
 * @returns {void}
 */
function testSongKeyMatchesEngineRowIdentity() {
  const context = { String, Number };
  vm.runInNewContext(
    slice(TRACKMAP_SOURCE, 'function localFullPath(', 'function localFileUrlFromEntry(')
      + slice(TRACKMAP_SOURCE, 'function localFileSize(', 'function localFileLastModified(')
      + slice(TRACKMAP_SOURCE, 'function localFileLastModified(', 'function localFilePath(')
      + slice(TRACKMAP_SOURCE, 'function localSongKeyFromFile(', 'function makeLocalSongFromFile(')
      + slice(BRIDGE_SOURCE, 'function localLibrarySongPath(', 'function syncLocalLibraryDbPlayStat(')
      + '\nthis.engineKey = localSongKeyFromFile;'
      + '\nthis.bridgeKey = localLibraryDbSongKeyFromSong;',
    context,
  );
  // desktop/main.js 的 localLibraryStoreFileRecordFromRow 水合出的记录形状。
  const record = { fullPath: 'D:\\Music\\A.mp3', size: 1024, lastModified: 1700000000000 };
  const engineKey = context.engineKey(record);
  assert.equal(engineKey, 'D:\\Music\\A.mp3:1024:1700000000000');
  assert.equal(
    context.bridgeKey({
      localKey: engineKey,
      localFilePathAbsolute: record.fullPath,
      localFileSize: record.size,
      localFileLastModified: record.lastModified,
    }),
    engineKey,
  );
  // 引擎还没落 localKey 的旧记录（重启前落桶的曲目）也要现算出同一行。
  assert.equal(
    context.bridgeKey({
      localFilePathAbsolute: record.fullPath,
      localFileSize: record.size,
      localFileLastModified: record.lastModified,
    }),
    engineKey,
  );
}

/**
 * 播放结算只对本地曲目发 song_key，且 key 不带队列的 local: 前缀。
 * @returns {Promise<void>}
 */
async function testPlayStatPayload() {
  const fake = createFakeShell({});
  const context = createBridgeContext(fake.shell);
  const snap = {
    key: 'local:D:\\Music\\A.mp3:1024:1700000000000',
    type: 'local',
    localKey: 'D:\\Music\\A.mp3:1024:1700000000000',
    pathKey: 'd:/music/a.mp3',
    name: '歌名',
    artist: '歌手',
  };
  context.api.syncLocalLibraryDbPlayStat(snap, { listenMs: 45678.6, completed: true, playedAt: 1700000000123 });
  await context.api.probeLocalLibraryDb();
  const bump = fake.calls.filter((call) => call.method === 'bumpLocalLibraryDbPlayStat');
  assert.equal(bump.length, 1);
  // 载荷对象在 vm realm 里创建，原型不同，拷回本 realm 再比结构。
  assert.deepEqual(Object.assign({}, bump[0].args[0]), {
    key: 'D:\\Music\\A.mp3:1024:1700000000000',
    pathKey: 'd:/music/a.mp3',
    plays: 1,
    listenMs: 45679,
    completed: 1,
    lastPlayedAt: 1700000000123,
    name: '歌名',
    artist: '歌手',
  });
  assert.notEqual(bump[0].args[0].key, snap.key, 'song_key 不能带 local: 前缀');

  // 在线曲目、缺行键的本地曲目、空快照都不该发 IPC。
  context.api.syncLocalLibraryDbPlayStat({ type: 'song', localKey: 'x' }, {});
  context.api.syncLocalLibraryDbPlayStat({ type: 'local', localKey: '' }, {});
  context.api.syncLocalLibraryDbPlayStat(null, null);
  await context.api.probeLocalLibraryDb();
  assert.equal(fake.calls.filter((call) => call.method === 'bumpLocalLibraryDbPlayStat').length, 1);

  const partial = createFakeShell({});
  const context2 = createBridgeContext(partial.shell);
  context2.api.syncLocalLibraryDbPlayStat({ type: 'local', localKey: 'k' }, { listenMs: -5, completed: false });
  await context2.api.probeLocalLibraryDb();
  const payload = partial.calls.filter((call) => call.method === 'bumpLocalLibraryDbPlayStat')[0].args[0];
  assert.equal(payload.listenMs, 0, '负数时长必须夹到 0');
  assert.equal(payload.completed, 0);
  assert.ok(payload.lastPlayedAt > 0, '缺结算时间时回落当前时间');
}

/**
 * 播放统计在纯浏览器环境下必须彻底静默，不能因为缺桥接而抛错打断结算。
 * @returns {Promise<void>}
 */
async function testStatHookStaysQuietWithoutShell() {
  const context = createBridgeContext(null);
  context.api.syncLocalLibraryDbPlayStat({ type: 'local', localKey: 'k' }, { listenMs: 1 });
  assert.equal(await context.api.probeLocalLibraryDb(), false);
}

/**
 * 渲染层的调用点必须真的接上：listenSongSnapshot 带 localKey/pathKey，
 * finalizeListenSession 只在有效结算后落库一次。
 * @returns {void}
 */
function testRendererCallSitesWired() {
  const snapshot = slice(STATS_SOURCE, 'function listenSongSnapshot(', 'function beginListenSession(');
  assert.match(snapshot, /localKey: song\.type === 'local' \? localLibraryDbSongKeyFromSong\(song\) : ''/);
  assert.match(snapshot, /pathKey: song\.type === 'local' \? localLibraryPathKeyFromSong\(song\) : ''/);

  const finalize = slice(STATS_SOURCE, 'function finalizeListenSession(', 'function mostPlayedSong(');
  assert.match(finalize, /syncLocalLibraryDbPlayStat\(snap, \{ listenMs: record\.listenMs, completed: !!completed, playedAt: now \}\)/);
  // 结算门在前：无效收听不该记一次播放。
  assert.ok(finalize.indexOf('if (!effective) return;') < finalize.indexOf('syncLocalLibraryDbPlayStat('));
}

/**
 * 桥接模块必须进加载清单，否则运行时取不到 SQLite 通道。
 * @returns {void}
 */
function testModuleRegistered() {
  const loader = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'index-loader.js'), 'utf8');
  assert.ok(loader.includes('js/modules/05-playback/20-local-library-db-bridge.js'), '桥接模块未登记进 index-loader.js');
}

test('无桌面壳或旧壳时探测一次性降级', testProbeLatchesUnavailableWithoutShell);
test('SQLite 曲库探测只走一次 IPC', testProbeRunsOnce);
test('存储不可用才 latch 降级而瞬时异常只回落本次', testUnavailableLatchAndTransientError);
test('桥接调用原样转发参数个数', testForwardsArgumentArity);
test('行键与路径键构造与参照库同构', testSongKeyAndPathKeyShapes);
test('路径归一化 helper 两处同名且本层口径不变', testPathKeyCaliber);
test('统计行键与引擎 song_key 逐字相等', testSongKeyMatchesEngineRowIdentity);
test('播放结算按 song_key 落库且过滤非本地曲目', testPlayStatPayload);
test('缺桥接时播放统计静默跳过', testStatHookStaysQuietWithoutShell);
test('渲染层调用点已接上 SQLite 播放统计', testRendererCallSitesWired);
test('桥接模块已登记进加载清单', testModuleRegistered);
