'use strict';

// 批2-B-2：主进程目录扫描（全量/增量）+ SQLite 落库 + 失效探测的端到端契约测试。
// 直接从真实 main.js 切出扫描垂直切片在 vm 里跑（不复制实现），并注入真实 node:sqlite 存储验证落库。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const url = require('node:url');
const crypto = require('node:crypto');
const storeModule = require('../desktop/local-library-store');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');

// 切片起点：扩展名表；终点：SQLite 存储句柄注释（含全量/增量/编排/落库桥全部函数）。
const SLICE_START = 'const LOCAL_LIBRARY_EXTS = new Set(';
const SLICE_END = '// 本地曲库 SQLite 存储句柄';

function buildSlice(visitLimit) {
  const start = MAIN.indexOf(SLICE_START);
  const end = MAIN.indexOf(SLICE_END);
  assert.ok(start >= 0 && end > start, '本地曲库扫描实现缺失或接缝错乱');
  let scanSource = MAIN.slice(start, end);
  // 把一次性随机令牌改成固定串，避免 vm 里需要 crypto（同时让 localFileProxyUrl 可预测）。
  scanSource = scanSource.replace(
    /const LOCAL_FILE_TOKEN = crypto\.randomBytes\(\d+\)\.toString\('hex'\);/,
    "const LOCAL_FILE_TOKEN = 'test-token';",
  );
  scanSource = scanSource.replace(
    /const LOCAL_LIBRARY_SCAN_VISIT_LIMIT = \d+;/,
    `const LOCAL_LIBRARY_SCAN_VISIT_LIMIT = ${visitLimit || 60000};`,
  );
  return scanSource;
}

/**
 * 建立扫描切片的 vm 上下文，并注入真实 SQLite 存储（node:sqlite，无需 electron）。
 * @param {string} dbPath 真实 library.db 路径。
 * @param {number} [visitLimit] 访问上限覆盖值。
 * @returns {object} 暴露的扫描函数与上下文。
 */
function loadScanSandbox(dbPath, visitLimit) {
  const realStore = storeModule.createLocalLibraryStore({ filePath: dbPath });
  const context = {
    path,
    fs,
    Intl,
    Promise,
    Math,
    Number,
    Set,
    Map,
    Array,
    Date,
    String,
    Object,
    JSON,
    console,
    setImmediate,
    pathToFileURL: url.pathToFileURL,
    mainServerPort: 0,
    getLocalLibraryStore: () => realStore,
    normalizeStorePathKey: storeModule.normalizeStorePathKey,
    buildIndexRecordFromFileRow: storeModule.buildIndexRecordFromFileRow,
  };
  vm.runInNewContext(
    `${buildSlice(visitLimit)}\n` +
      'this.scanFull = scanLocalMusicFolderFull;\n' +
      'this.scanIncremental = scanLocalMusicFolderIncremental;\n' +
      'this.scanFolder = scanLocalMusicFolder;\n' +
      'this.loadRoot = loadLocalLibraryStoreRoot;\n' +
      'this.rememberRoot = rememberLocalMusicRoot;\n' +
      'this.probe = probeAuthorizedLocalFiles;\n',
    context,
  );
  context.closeStore = () => { try { realStore.close(); } catch (_e) { /* 未打开则无妨 */ } };
  return context;
}

test('全量扫描递归找出三级目录里的 FLAC', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-scan-deep-')), 'library.db');
  const ctx = loadScanSandbox(dbPath, 50000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-scan-root-'));
  const nested = path.join(root, 'level1', 'level2', 'level3');
  try {
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'artist - title.flac'), 'x');
    const result = await ctx.scanFull(root);
    assert.equal(result.ok, true);
    assert.equal(result.truncated, false);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, 'artist - title.flac');
    assert.equal(result.files[0].type, 'audio/flac');
    assert.equal(result.files[0].relativePath, `${path.basename(root)}/level1/level2/level3/artist - title.flac`);
  } finally {
    ctx.closeStore();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('扫描识别 APE/DSF/FLAC 音频与 LRC 歌词并打对 MIME', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-scan-ext-')), 'library.db');
  const ctx = loadScanSandbox(dbPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-scan-extroot-'));
  try {
    fs.writeFileSync(path.join(root, 'a.flac'), 'x');
    fs.writeFileSync(path.join(root, 'b.ape'), 'x');
    fs.writeFileSync(path.join(root, 'c.dsf'), 'x');
    fs.writeFileSync(path.join(root, 'd.lrc'), 'x');
    fs.writeFileSync(path.join(root, 'e.txt'), 'x');
    fs.writeFileSync(path.join(root, 'f.xyz'), 'x');
    const result = await ctx.scanFull(root);
    const byName = Object.fromEntries(result.files.map((f) => [f.name, f]));
    assert.equal(byName['a.flac'].type, 'audio/flac');
    assert.equal(byName['b.ape'].type, 'audio/x-ape');
    assert.equal(byName['c.dsf'].type, 'audio/x-dsf');
    assert.equal(byName['d.lrc'].type, 'text/plain');
    // 文本/歌词类扩展名（.txt）也被收录，只是不是音频。
    assert.equal(byName['e.txt'].type, 'text/plain');
    // 非曲库扩展名（.xyz）不应进入扫描结果。
    assert.equal(byName['f.xyz'], undefined);
  } finally {
    ctx.closeStore();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('全量扫描落库后 db-load 能原样取回，二次扫描走增量并复用', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-scan-persist-')), 'library.db');
  const ctx = loadScanSandbox(dbPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-scan-persistroot-'));
  try {
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'one.flac'), 'x');
    fs.writeFileSync(path.join(root, 'sub', 'two.flac'), 'x');

    const first = await ctx.scanFolder(root);
    assert.equal(first.ok, true);
    assert.equal(first.scanMode, 'full', '首次应走全量');
    assert.equal(first.files.length, 2);
    assert.ok(first.db && first.db.ok, '扫描应自动落库 SQLite');
    assert.equal(first.db.total, 2, '落库文件数应为 2');
    assert.equal(first.db.audio, 2, '落库音频数应为 2');

    // 从 SQLite 还原，验证落库内容与原扫描一致。
    const loaded = ctx.loadRoot(root);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.files.length, 2);
    const types = loaded.files.map((f) => f.type).sort();
    assert.equal(types.length, 2);
    assert.equal(types[0], 'audio/flac');
    assert.equal(types[1], 'audio/flac');
    assert.equal(loaded.audioCount, 2);

    // 磁盘未变，二次扫描应走增量并全部复用，不再重新 stat。
    const second = await ctx.scanFolder(root);
    assert.equal(second.ok, true);
    assert.equal(second.scanMode, 'incremental', '有历史快照应走增量');
    assert.equal(second.files.length, 2);
    assert.equal(second.reused, 2, '未变的文件应被增量复用');
    assert.equal(second.refreshed, 0, '未变的文件不应重新 stat');
  } finally {
    ctx.closeStore();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('失效探测区分「还在/被删/越权」三种状态', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-scan-probe-')), 'library.db');
  const ctx = loadScanSandbox(dbPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-scan-proberoot-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-scan-outside-'));
  try {
    const insidePresent = path.join(root, 'keep.flac');
    const insideMissing = path.join(root, 'gone.flac');
    const outsideFile = path.join(outside, 'stranger.flac');
    fs.writeFileSync(insidePresent, 'x');
    fs.writeFileSync(outsideFile, 'x');
    // 只授权 root，outside 不在授权集合内。
    ctx.rememberRoot(root);
    const res = await ctx.probe([insidePresent, insideMissing, outsideFile]);
    assert.equal(res.ok, true);
    assert.equal(res.checked, 3);
    assert.equal(res.states[0], 'ok', '授权目录内存在的文件应判在');
    assert.equal(res.states[1], 'missing', '授权目录内不存在的文件应判删');
    assert.equal(res.states[2], 'blocked', '授权目录外的文件必须判越权，不能误报成删除');
  } finally {
    ctx.closeStore();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
