'use strict';

// ReplayGain 解析结果落库回归：参照库 Mineradio-2.5.1 app.js:9299 把 localReplayGain 走
// 资产缓存的 extra JSON 列（零 DDL），且只在解析到时写入。本套件钉住三件事：
//   ① store 的 extra 合并是非破坏性的（不清封面、不抹已有 extra 键、缺行能建行）；
//   ② 轻量资产快照写回不得把已落盘的 RG 抹掉（同 localLyricTranslations 的既有教训）；
//   ③ 渲染层三个调用点齐全：解析后落库、水合回灌、启动补齐后落库。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const store = require('../desktop/local-library-store.js');

const ENGINE_REL = ['public', 'js', 'modules', '04-shelf', '13-local-library-engine.js'];
const GAIN_REL = ['public', 'js', 'modules', '05-playback', '22-replay-gain.js'];

/**
 * 读取源码；文件还没落地时返回空串，让断言以「找不到实现」的形式失败。
 * @param {string[]} parts 相对仓库根的路径片段。
 * @returns {string} 源码文本。
 */
function readSource(parts) {
  const abs = path.join(__dirname, '..', ...parts);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
}

const engineSource = readSource(ENGINE_REL);
const gainSource = readSource(GAIN_REL);
const preloadSource = readSource(['desktop', 'preload.js']);
const mainSource = readSource(['desktop', 'main.js']);

/**
 * 在临时目录里开一个真实 SQLite 曲库，跑完连 WAL/shm 一起删掉。
 * @param {Function} run 测试体，接收 store 句柄。
 * @returns {Promise<void>} 测试体结果。
 */
async function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-rg-persist-'));
  const handle = store.createLocalLibraryStore({ directory: dir });
  try {
    return await run(handle);
  } finally {
    try { handle.close(); } catch (_e) { /* 关闭失败交给 rm */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* 临时目录由系统回收 */ }
  }
}

/**
 * 按大括号配对截出一个顶层函数声明的完整源码。
 * @param {string} source 模块源码。
 * @param {string} name 函数名。
 * @returns {string} 函数源码；找不到时抛错（避免静默跑出假绿）。
 */
function extractFunction(source, name) {
  let start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '未找到函数 ' + name);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let depth = 0;
  let index = source.indexOf('{', start);
  assert.ok(index > start, name + ' 缺少函数体');
  for (; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('函数 ' + name + ' 括号不闭合');
}

const COVER_DATA_URL = 'data:image/png;base64,' + Buffer.from('cover-bytes').toString('base64');
const SAMPLE_GAIN = { trackGainDb: -6.5, trackPeak: 0.98, albumGainDb: -5.2, albumPeak: 1.0 };

test('解析到的 ReplayGain 落进 assets.extra，且不动已存的封面', async () => {
  await withStore(async (handle) => {
    assert.equal(handle.writeAssetRecord({
      id: 'rg-song', name: '曲名', artist: '歌手',
      localCoverThumbDataUrl: COVER_DATA_URL, localCoverLoaded: true, savedAt: Date.now(),
    }).ok, true);

    const merged = handle.mergeAssetExtraFields('rg-song', { localReplayGain: SAMPLE_GAIN });
    assert.equal(merged && merged.ok, true, 'mergeAssetExtraFields 写入失败: ' + JSON.stringify(merged));

    const asset = handle.readAssetRecords(['rg-song']).records['rg-song'];
    assert.deepEqual(asset.localReplayGain, SAMPLE_GAIN);
    assert.equal(asset.localCoverThumbDataUrl, COVER_DATA_URL, 'RG 写入把封面 BLOB 抹掉了');
    assert.equal(asset.name, '曲名');
    assert.equal(asset.artist, '歌手');
  });
});

test('没有资产行时 RG 也能建行落库', async () => {
  await withStore(async (handle) => {
    assert.equal(handle.mergeAssetExtraFields('no-cover-song', { localReplayGain: SAMPLE_GAIN }).ok, true);
    const asset = handle.readAssetRecords(['no-cover-song']).records['no-cover-song'];
    assert.ok(asset, 'RG 建行后读不回来');
    assert.deepEqual(asset.localReplayGain, SAMPLE_GAIN);
    assert.equal(asset.localCoverThumbDataUrl, '');
  });
});

test('extra 合并保留已有未知键，破损 JSON 直接替换不抛', async () => {
  await withStore(async (handle) => {
    handle.writeAssetRecord({ id: 'rg-keep', futureField: '别家字段', savedAt: Date.now() });
    handle.mergeAssetExtraFields('rg-keep', { localReplayGain: SAMPLE_GAIN });
    const kept = handle.readAssetRecords(['rg-keep']).records['rg-keep'];
    assert.equal(kept.futureField, '别家字段', '合并 extra 时把已有键抹掉了');
    assert.deepEqual(kept.localReplayGain, SAMPLE_GAIN);

    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(handle.filePath);
    try { db.prepare('UPDATE assets SET extra=? WHERE song_key=?').run('{坏掉的JSON', 'rg-keep'); } finally { db.close(); }
    assert.equal(handle.mergeAssetExtraFields('rg-keep', { localReplayGain: { trackGainDb: -1 } }).ok, true);
    assert.deepEqual(handle.readAssetRecords(['rg-keep']).records['rg-keep'].localReplayGain, { trackGainDb: -1 });
  });
});

test('轻量资产快照写回不得抹掉已落盘的 ReplayGain', async () => {
  await withStore(async (handle) => {
    handle.mergeAssetExtraFields('rg-light', { localReplayGain: SAMPLE_GAIN });
    // 后续封面快照写入不带 localReplayGain：整列 extra 重建时必须先捞回，同 localLyricTranslations 的教训。
    handle.writeAssetRecord({ id: 'rg-light', name: '曲名', localCoverThumbDataUrl: COVER_DATA_URL, savedAt: Date.now() });
    const asset = handle.readAssetRecords(['rg-light']).records['rg-light'];
    assert.deepEqual(asset.localReplayGain, SAMPLE_GAIN, '封面快照写回把 RG 抹掉了');
    assert.equal(asset.localCoverThumbDataUrl, COVER_DATA_URL);
  });
});

test('RG 落库通道拒绝空键与非对象字段', async () => {
  await withStore(async (handle) => {
    assert.equal(handle.mergeAssetExtraFields('', { localReplayGain: SAMPLE_GAIN }).ok, false);
    assert.equal(handle.mergeAssetExtraFields('rg-bad', null).ok, false);
    assert.equal(handle.mergeAssetExtraFields('rg-bad', []).ok, false);
    assert.equal(handle.readAssetRecords(['rg-bad']).records['rg-bad'], undefined);
  });
});

test('渲染层解析后落库、水合回灌三处调用点齐全', () => {
  assert.ok(/async function persistLocalReplayGainAsset\(song\)/.test(engineSource),
    '13-local-library-engine.js 缺 persistLocalReplayGainAsset（RG 无落库入口）');
  assert.match(engineSource, /callLocalLibraryDb\('mergeLocalLibraryDbAssetExtra',\s*song\.localKey,\s*\{\s*localReplayGain:/,
    '落库辅助未走 mergeLocalLibraryDbAssetExtra 通道');
  assert.match(engineSource, /persistLocalTrackMetadata[\s\S]{0,1200}?persistLocalReplayGainAsset\(song\);/,
    '曲库解析链没有把 ReplayGain 落库（扫库解析到的标签会随会话丢失）');
  assert.match(engineSource, /asset\.localReplayGain[\s\S]{0,200}songs\[mi\]\.localReplayGain = asset\.localReplayGain;/,
    '水合阶段没把持久化的 ReplayGain 回灌到曲目（重启后仍要重解析）');
  assert.match(gainSource, /song\.localReplayGain = tags\.replayGain;[\s\S]{0,160}persistLocalReplayGainAsset\(song\);/,
    '播放时惰性补齐的 ReplayGain 没有落库');
});

test('persistLocalReplayGainAsset 只在有键有标签时发起一次落库', async () => {
  const calls = [];
  const context = vm.createContext({
    callLocalLibraryDb(method, key, fields) {
      calls.push({ method, key, fields });
      return Promise.resolve({ ok: true });
    },
    console: { warn() { }, log() { }, error() { } },
    Promise,
    Object,
  });
  vm.runInContext(extractFunction(engineSource, 'persistLocalReplayGainAsset'), context, { filename: ENGINE_REL.join('/') });

  await context.persistLocalReplayGainAsset({ localKey: 'k-1', localReplayGain: SAMPLE_GAIN });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'mergeLocalLibraryDbAssetExtra');
  assert.equal(calls[0].key, 'k-1');
  assert.deepEqual(calls[0].fields.localReplayGain, SAMPLE_GAIN);

  await context.persistLocalReplayGainAsset({ localKey: 'k-2' });
  await context.persistLocalReplayGainAsset({ localReplayGain: SAMPLE_GAIN });
  await context.persistLocalReplayGainAsset(null);
  assert.equal(calls.length, 1, '缺键/缺标签时不应发起落库');
});

test('preload 与主进程按同一通道名接通，且守住可信发送方', () => {
  assert.match(preloadSource, /mergeLocalLibraryDbAssetExtra:\s*\(key, fields\) => ipcRenderer\.invoke\('stellaflix-local-library-db-merge-asset-extra', key, fields\)/,
    'preload 未暴露 mergeLocalLibraryDbAssetExtra 通道');
  assert.match(mainSource, /ipcMain\.handle\('stellaflix-local-library-db-merge-asset-extra'[\s\S]{0,400}?isTrustedMainWindowIpc\(event\)[\s\S]{0,200}?store\.mergeAssetExtraFields/,
    '主进程缺 merge-asset-extra 句柄或未校验可信发送方');
  assert.match(mainSource, /'stellaflix-local-library-db-merge-asset-extra'[\s\S]{0,400}?LOCAL_LIBRARY_DB_KEY_EMPTY/,
    '主进程句柄未拒绝空键');
});

test('store 公开 API 暴露 mergeAssetExtraFields', async () => {
  await withStore(async (handle) => {
    assert.equal(typeof handle.mergeAssetExtraFields, 'function', 'store 未在公开 API 里暴露 mergeAssetExtraFields');
  });
});
