'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
const PRELOAD_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');

/**
 * 主进程要常驻打开 SQLite 曲库并在退出时收口，通道必须走我方信任闸。
 * @returns {void}
 */
function testMainStoreGlueAndChannels() {
  assert.match(MAIN_SOURCE, /require\('\.\/local-library-store'\)/);
  assert.match(MAIN_SOURCE, /createLocalLibraryStore\(\{ filePath: path\.join\(app\.getPath\('userData'\), LOCAL_LIBRARY_DB_FILE_NAME\) \}\)/);
  // 运行时没有 node:sqlite 时整层降级，不许在建库上抛错拖垮主进程。
  assert.match(MAIN_SOURCE, /if \(!isLocalLibraryStoreSupported\(\)\)/);
  assert.match(MAIN_SOURCE, /return \{ ok: false, error: 'LOCAL_LIBRARY_DB_UNAVAILABLE' \}/);
  assert.match(MAIN_SOURCE, /ipcMain\.handle\('stellaflix-local-library-db-status',[\s\S]{0,200}isTrustedMainWindowIpc[\s\S]{0,200}store\.getStatus\(\)/);
  assert.match(MAIN_SOURCE, /ipcMain\.handle\('stellaflix-local-library-db-bump-play',[\s\S]{0,240}isTrustedMainWindowIpc[\s\S]{0,200}store\.bumpPlayStat\(payload \|\| \{\}\)/);
  assert.match(MAIN_SOURCE, /app\.on\('before-quit'[\s\S]{0,1500}closeLocalLibraryStore\(\)/);
}

/**
 * preload 暴露的桥接名保持参照库原样，通道门牌号换成 stellaflix-。
 * @returns {void}
 */
function testPreloadBridgeSurface() {
  assert.match(PRELOAD_SOURCE, /localLibraryDbStatus: \(\) => ipcRenderer\.invoke\('stellaflix-local-library-db-status'\)/);
  assert.match(PRELOAD_SOURCE, /bumpLocalLibraryDbPlayStat: \(payload\) => ipcRenderer\.invoke\('stellaflix-local-library-db-bump-play', payload \|\| \{\}\)/);
}

/**
 * 参照库门牌号不得残留在本次移植的任何一层。
 * @returns {void}
 */
function testNoUpstreamBrandLiteral() {
  const bridge = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '20-local-library-db-bridge.js'),
    'utf8',
  );
  for (const [name, source] of [['main.js', MAIN_SOURCE], ['preload.js', PRELOAD_SOURCE], ['bridge', bridge]]) {
    assert.doesNotMatch(source, /mineradio/i, name + ' 残留参照库门牌号');
  }
}

/**
 * 主进程从 SQLite 水合出的文件记录必须带全「路径:大小:修改时间」三要素与代理播放地址：
 * 渲染层 localSongKeyFromFile 用它算 song_key，统计/索引/封面/歌词都靠这一个键对齐。
 * @returns {void}
 */
function testHydratedRecordCarriesStatsIdentity() {
  const recordSlice = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf('function localLibraryStoreFileRecordFromRow'),
    MAIN_SOURCE.indexOf('function loadLocalLibraryStoreRoot'),
  );
  assert.ok(recordSlice.length > 0, '未找到主进程曲库记录组装函数');
  for (const field of ['fullPath:', 'size:', 'lastModified:', 'url: localFileProxyUrl(abs)']) {
    assert.ok(recordSlice.includes(field), '水合记录缺少统计所需字段: ' + field);
  }
  // 键的权威在引擎侧：桥接层不再自算路径键，避免与索引/收藏行分裂。
  const bridge = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '20-local-library-db-bridge.js'),
    'utf8',
  );
  assert.match(bridge, /var engineKey = String\(song\.localKey \|\| ''\);/);
}

test('主进程 SQLite 曲库胶水与统计通道已就位', testMainStoreGlueAndChannels);
test('preload 统计桥接面与门牌号一致', testPreloadBridgeSurface);
test('移植层不残留参照库门牌号', testNoUpstreamBrandLiteral);
test('主进程水合记录带全统计行键三要素与代理播放地址', testHydratedRecordCarriesStatsIdentity);
