'use strict';

// 批2-B-3：旧曲库（local-music-library.json → 新 SQLite 层）一次性迁移的契约测试。
// 直接从真实 main.js 切出迁移垂直切片在 vm 里跑（不复制实现），注入真实 node:sqlite 存储。
// store.overlayFileMetadata 的部分更新（不误伤其它列）用真实 store 直接单测，不走 vm。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const url = require('node:url');
const storeModule = require('../desktop/local-library-store');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');

// 同批2-B-2 切片：扩展名表 → SQLite 存储句柄注释（迁移函数就在该切片内）。
const SLICE_START = 'const LOCAL_LIBRARY_EXTS = new Set(';
const SLICE_END = '// 本地曲库 SQLite 存储句柄';

function buildSlice(visitLimit) {
  const start = MAIN.indexOf(SLICE_START);
  const end = MAIN.indexOf(SLICE_END);
  assert.ok(start >= 0 && end > start, '本地曲库迁移实现缺失或接缝错乱');
  let src = MAIN.slice(start, end);
  src = src.replace(
    /const LOCAL_FILE_TOKEN = crypto\.randomBytes\(\d+\)\.toString\('hex'\);/,
    "const LOCAL_FILE_TOKEN = 'test-token';",
  );
  src = src.replace(
    /const LOCAL_LIBRARY_SCAN_VISIT_LIMIT = \d+;/,
    `const LOCAL_LIBRARY_SCAN_VISIT_LIMIT = ${visitLimit || 60000};`,
  );
  return src;
}

function loadMigrationSandbox(dbPath) {
  const realStore = storeModule.createLocalLibraryStore({ filePath: dbPath });
  const context = {
    path, fs, Intl, Promise, Math, Number, Set, Map, Array, Date, String, Object, JSON, console,
    setImmediate,
    mainServerPort: 0,
    pathToFileURL: url.pathToFileURL,
    getLocalLibraryStore: () => realStore,
    normalizeStorePathKey: storeModule.normalizeStorePathKey,
    buildIndexRecordFromFileRow: storeModule.buildIndexRecordFromFileRow,
  };
  vm.runInNewContext(
    `${buildSlice(60000)}\n` +
      'this.legacyRoots = legacyLocalMusicRootsFromRecords;\n' +
      'this.isAncestor = isLocalMusicRootAncestor;\n' +
      'this.migrate = migrateLocalMusicLibraryFromLegacy;\n' +
      'this.scanFolder = scanLocalMusicFolder;\n' +
      'this.loadRoot = loadLocalLibraryStoreRoot;\n',
    context,
  );
  context.store = realStore;
  context.closeStore = () => { try { realStore.close(); } catch (_e) { /* 未打开则无妨 */ } };
  return context;
}

function writeLegacyJson(jsonPath, records, version) {
  fs.writeFileSync(jsonPath, JSON.stringify({ version: version == null ? 1 : version, mediaToken: 'x', records }));
}

function newHexId() { return crypto.randomBytes(12).toString('hex'); }

test('legacyLocalMusicRootsFromRecords 输出最小根覆盖集（去祖先、取文件所在目录）', () => {
  const ctx = loadMigrationSandbox(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-')), 'library.db'));
  try {
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-root-'));
    // 三个音频文件都在 R 的子目录里，R 应成为唯一根（吃掉两个子目录）。
    const p1 = path.join(R, 'b', 'song1.flac');
    const p2 = path.join(R, 'c', 'song2.flac');
    const p3 = path.join(R, 'song3.flac');
    const roots = ctx.legacyRoots([p1, p2, p3]);
    assert.equal(roots.length, 1, 'R 应覆盖全部子目录，只产出 1 个根');
    assert.equal(roots[0], path.resolve(R), '唯一根应为 R 的绝对路径');

    // 两个互不包容的独立目录应都保留。
    const A = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-a-'));
    const B = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-b-'));
    const roots2 = ctx.legacyRoots([path.join(A, 'x.flac'), path.join(B, 'y.flac')]);
    assert.equal(roots2.length, 2, '互不包容的两个目录应保留 2 个根');
    assert.ok(roots2.includes(path.resolve(A)) && roots2.includes(path.resolve(B)));

    // 空/非字符串输入应被忽略，不抛错（跨 realm 数组用 length 判断，避免 deepEqual 原型差异）。
    // 注意：任何非空字符串都会被 path.resolve 成合法路径并产根，所以只有 null/''/非字符串才该被忽略。
    assert.equal(ctx.legacyRoots([]).length, 0);
    assert.equal(ctx.legacyRoots([null, '', 42, undefined, {}]).length, 0);
    assert.equal(ctx.legacyRoots(['relative/song.flac']).length, 1, '非空字符串应按合法路径解析出 1 个根');
  } finally {
    ctx.closeStore();
  }
});

test('store.overlayFileMetadata 只写指定列，绝不误伤已解析的 title/genre/year', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-ov-')), 'library.db');
  const store = storeModule.createLocalLibraryStore({ filePath: dbPath });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-ovroot-'));
  try {
    const abs = path.join(root, 'a.flac');
    const pathKey = storeModule.normalizeStorePathKey(abs);
    const songKey = `${abs}:10:123`;
    const fingerprint = storeModule.makeStoreFingerprint(pathKey, 10, 123);
    // 先用扫描落一行（只写文件级字段，title/genre 等 FILE_INDEX 列为空）。
    await store.syncRoot({
      folderPath: root, truncated: false, scanMode: 'full', directories: [],
      files: [{ rel: 'a.flac', name: 'a.flac', ext: '.flac', mime: 'audio/flac', isAudio: true, size: 10, mtime: 123, pathKey, songKey }],
    });
    // 再模拟渲染层「标签已解析」全量回写（含 title/genre/year，迁移不会碰这些）。
    const seed = store.saveIndexRecords(root, [{
      key: songKey, fileSignature: fingerprint, name: 'My Title', artist: 'SeedArtist', album: 'SeedAlbum',
      genre: 'Jazz', year: '2020', duration: 100, localMetadataLoaded: true, updatedAt: 111,
    }]);
    assert.equal(seed.ok, true);

    // 迁移器叠加：只应改 artist/album/duration 与标记列。
    const ov = store.overlayFileMetadata(root, fingerprint, {
      artist: 'Old Artist', album: 'Old Album', duration: 222.5, localMetadataLoaded: 1, updatedAt: 222,
    });
    assert.equal(ov.ok, true);
    assert.equal(ov.saved, 1, '应按指纹命中 1 行');

    const loaded = store.loadRoot(root);
    assert.equal(loaded.ok, true);
    const row = loaded.files[0];
    assert.equal(row.artist, 'Old Artist', 'artist 应被叠加更新');
    assert.equal(row.album, 'Old Album', 'album 应被叠加更新');
    assert.equal(row.duration, 222.5, 'duration 应被叠加更新');
    // 关键不误伤证明：迁移没提供的列必须原样保留。
    assert.equal(row.title, 'My Title', 'title 必须保留，不得被清空');
    assert.equal(row.genre, 'Jazz', 'genre 必须保留，不得被清空');
    assert.equal(row.year, '2020', 'year 必须保留，不得被清空');
  } finally {
    try { store.close(); } catch (_e) { /* 未打开则无妨 */ }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('迁移把旧标签叠回新行，并通过 loadLocalLibraryStoreRoot 的 index 判据真正浮现', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-overlay-')), 'library.db');
  const ctx = loadMigrationSandbox(dbPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-ovroot-'));
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-legacy-'));
  const jsonPath = path.join(legacyDir, 'local-music-library.json');
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-ud-'));
  try {
    // 真文件 + 真扩展名，让扫描器能扫到并落库。
    fs.writeFileSync(path.join(root, 'song.flac'), 'audio-bytes');
    const id = newHexId();
    writeLegacyJson(jsonPath, [{
      id,
      audioPath: path.join(root, 'song.flac'),
      name: 'song.flac',
      artist: 'Old Artist',
      album: 'Old Album',
      duration: 222.5,
    }]);

    const res = await ctx.migrate({
      userDataPath: markerDir,
      legacyJsonPath: jsonPath,
      skipMarker: true,
    });
    assert.equal(res.ok, true, '迁移应成功');
    assert.equal(res.overlaid, 1, '应叠加 1 行标签');

    // 走真实读取路径：index 记录只有在 index_updated_at 置位后才会出现。
    const loaded = ctx.loadRoot(root);
    assert.equal(loaded.ok, true);
    const records = loaded.index && loaded.index.records ? Object.values(loaded.index.records) : [];
    assert.equal(records.length, 1, '迁移后应有 1 条 index 记录浮现（证明 index_updated_at 已置位）');
    const rec = records[0];
    assert.equal(rec.artist, 'Old Artist', '浮现的 index 记录 artist 应来自旧库');
    assert.equal(rec.album, 'Old Album', '浮现的 index 记录 album 应来自旧库');
    assert.equal(rec.duration, 222.5, '浮现的 index 记录 duration 应来自旧库');
    // 扫描写入的文件级 name 必须仍在（未被全列 UPDATE 清空）。
    assert.equal(loaded.files[0].name, 'song.flac', '文件级 name 必须保留');
  } finally {
    ctx.closeStore();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(markerDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('迁移幂等：marker 已存在则跳过，不会重复扫描/叠加', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-idem-')), 'library.db');
  const ctx = loadMigrationSandbox(dbPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-idemroot-'));
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-idem-legacy-'));
  const jsonPath = path.join(legacyDir, 'local-music-library.json');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-idem-ud-'));
  const markerPath = path.join(ud, 'local-music-library.migrated-v1');
  try {
    fs.writeFileSync(path.join(root, 'song.flac'), 'x');
    writeLegacyJson(jsonPath, [{ id: newHexId(), audioPath: path.join(root, 'song.flac'), artist: 'A', album: 'B', duration: 1 }]);

    const first = await ctx.migrate({ userDataPath: ud, legacyJsonPath: jsonPath });
    assert.equal(first.ok, true, '首次迁移应成功');
    assert.equal(fs.existsSync(markerPath), true, '首次迁移应写出 marker');
    assert.equal(first.skipped, undefined, '首次不应有 skipped');

    const second = await ctx.migrate({ userDataPath: ud, legacyJsonPath: jsonPath });
    assert.equal(second.ok, true, '二次迁移也应成功返回');
    assert.equal(second.skipped, 'already-migrated', '二次应跳过，不重复扫描');
  } finally {
    ctx.closeStore();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('旧 JSON 缺失时优雅跳过不报错', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-nofile-')), 'library.db');
  const ctx = loadMigrationSandbox(dbPath);
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-nofile-ud-'));
  try {
    const res = await ctx.migrate({ userDataPath: ud, legacyJsonPath: path.join(ud, 'does-not-exist.json') });
    assert.equal(res.ok, true, '无旧 JSON 也应成功返回');
    assert.equal(res.skipped, 'no-legacy-json', '应标记为 no-legacy-json');
  } finally {
    ctx.closeStore();
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('旧 JSON 版本/结构无法识别时优雅跳过', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-bad-')), 'library.db');
  const ctx = loadMigrationSandbox(dbPath);
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-bad-legacy-'));
  const jsonPath = path.join(legacyDir, 'local-music-library.json');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-mig-bad-ud-'));
  try {
    // 版本不为 1。
    writeLegacyJson(jsonPath, [], 2);
    const res = await ctx.migrate({ userDataPath: ud, legacyJsonPath: jsonPath });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 'legacy-json-unrecognized', '版本不为 1 应跳过');

    // records 非数组。
    fs.writeFileSync(jsonPath, JSON.stringify({ version: 1, records: 'nope' }));
    const res2 = await ctx.migrate({ userDataPath: ud, legacyJsonPath: jsonPath });
    assert.equal(res2.skipped, 'legacy-json-unrecognized');
  } finally {
    ctx.closeStore();
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
