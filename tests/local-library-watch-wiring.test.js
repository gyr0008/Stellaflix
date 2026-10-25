'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
const PRELOAD_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');

const EXT_START = MAIN_SOURCE.indexOf('const LOCAL_LIBRARY_EXTS = new Set([');
const EXT_END = MAIN_SOURCE.indexOf('const LOCAL_LIBRARY_MIME = {', EXT_START);
assert.ok(EXT_START > 0 && EXT_END > EXT_START, 'local library extension constants not found');

const extContext = { Set };
vm.runInNewContext(
  `${MAIN_SOURCE.slice(EXT_START, EXT_END)}
this.all = LOCAL_LIBRARY_EXTS;
this.audio = LOCAL_LIBRARY_AUDIO_EXTS;`,
  extContext,
);

const ALL_EXTS = Array.from(extContext.all);
const AUDIO_EXTS = Array.from(extContext.audio);

test('LOCAL_LIBRARY_AUDIO_EXTS 覆盖 APE 与 DSD', () => {
  // 这两个扩展名一直在扫描白名单里，却漏在音频集合外，导致 APE/DSD 被扫到但不计入
  // SQLite 的 audio 计数与曲库签名 —— 右下角"已同步 N 首歌曲"报的正是这个数。
  assert.ok(AUDIO_EXTS.includes('.ape'), '.ape must count as audio');
  assert.ok(AUDIO_EXTS.includes('.dsf'), '.dsf must count as audio');
  assert.ok(ALL_EXTS.includes('.ape'));
  assert.ok(ALL_EXTS.includes('.dsf'));
});

test('音频集合完全落在扫描白名单内', () => {
  const missing = AUDIO_EXTS.filter((ext) => !ALL_EXTS.includes(ext));
  assert.deepEqual(missing, [], `audio exts missing from scan whitelist: ${missing.join(', ')}`);
  assert.ok(AUDIO_EXTS.length >= 17);
  // 歌词与封面扩展名不能混进音频集合，否则曲库数量会把 .lrc 和 .jpg 也算进去。
  assert.equal(AUDIO_EXTS.includes('.lrc'), false);
  assert.equal(AUDIO_EXTS.includes('.jpg'), false);
  assert.equal(AUDIO_EXTS.includes('.txt'), false);
});

test('主进程接上文件夹监控模块，并在退出时关掉它', () => {
  assert.ok(MAIN_SOURCE.includes("require('./local-library-watcher')"), 'watcher module not required');
  assert.ok(MAIN_SOURCE.includes('function applyLocalLibraryWatchRoots('));
  assert.ok(MAIN_SOURCE.includes('function localLibraryWatchStatusSnapshot('));
  assert.ok(MAIN_SOURCE.includes('function broadcastLocalLibraryWatchChange('));
  // 监控句柄不关会把退出流程吊住，所以必须排在关闭 SQLite 之前。
  const closeWatcher = MAIN_SOURCE.indexOf('closeLocalLibraryWatcher();');
  const closeStore = MAIN_SOURCE.indexOf('closeLocalLibraryStore();', closeWatcher);
  assert.ok(closeWatcher > 0, 'closeLocalLibraryWatcher() not called');
  assert.ok(closeStore > closeWatcher, 'watcher must be closed before the sqlite store');
});

test('监控 IPC 走可信主框架网关，并逐个校验监控根授权', () => {
  const channels = [
    'stellaflix-local-library-watch-set-roots',
    'stellaflix-local-library-watch-status',
  ];
  channels.forEach((channel) => {
    assert.match(
      MAIN_SOURCE,
      new RegExp(`ipcMain\\.handle\\('${channel}',[\\s\\S]{0,240}isTrustedMainWindowIpc`),
      `${channel} must be wrapped by isTrustedMainWindowIpc`,
    );
  });
  // 监控根必须先过 rememberLocalMusicRoot 授权，否则渲染层能借监控读任意目录。
  const applyStart = MAIN_SOURCE.indexOf('function applyLocalLibraryWatchRoots(');
  const applyEnd = MAIN_SOURCE.indexOf('\nfunction ', applyStart + 1);
  const applyBody = MAIN_SOURCE.slice(applyStart, applyEnd);
  assert.ok(applyBody.includes('rememberLocalMusicRoot('), 'watch roots must be authorized');
  assert.ok(applyBody.includes('rejected'), 'unauthorized roots must be reported back');
});

test('preload 暴露监控三件套并保留退订函数', () => {
  assert.ok(PRELOAD_SOURCE.includes("invoke('stellaflix-local-library-watch-set-roots'"));
  assert.ok(PRELOAD_SOURCE.includes("invoke('stellaflix-local-library-watch-status'"));
  assert.ok(PRELOAD_SOURCE.includes("ipcRenderer.on('stellaflix-local-library-watch-changed'"));
  // 订阅必须回一个退订函数，不然重挂监控会越挂越多。
  assert.ok(PRELOAD_SOURCE.includes("removeListener('stellaflix-local-library-watch-changed'"));
  const start = PRELOAD_SOURCE.indexOf('setLocalLibraryWatchRoots:');
  const end = PRELOAD_SOURCE.indexOf('getLocalLibraryWatchStatus:', start);
  assert.ok(start > 0 && end > start);
  // 只往主进程送数组，避免把渲染层的意外类型直接透给 fs.watch。
  assert.ok(PRELOAD_SOURCE.slice(start, end).includes('Array.isArray(folders) ? folders : []'));
});

test('主进程序列出门牌号统一为 stellaflix-，不残留参照库前缀', () => {
  const start = MAIN_SOURCE.indexOf('const LOCAL_LIBRARY_EXTS = new Set([');
  const stop = MAIN_SOURCE.indexOf('\nconst ', MAIN_SOURCE.indexOf('function closeLocalLibraryWatcher('));
  assert.ok(start > 0 && stop > start);
  assert.doesNotMatch(MAIN_SOURCE.slice(start, stop), /mineradio/i, '监控接线段残留参照库门牌号');
});
