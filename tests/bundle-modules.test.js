'use strict';

/**
 * tests/bundle-modules.test.js — B1 bundle 构建脚本契约
 *
 * 覆盖四件事：
 *   ① 顺序守恒：分段展平后必须与 index-loader 的 modulePaths 逐位一致
 *   ② 噪音控制：磁盘上的 *_1.js 副本（.gitignore `*_1.*` 那套）不得算作孤儿
 *   ③ 原子性：任一段语法校验失败 → 非零退出，且旧产物一个字节都不许动
 *      （loader 的回退只覆盖"读取失败"，不覆盖"bundle 内容报错"，半写产物会炸整条模块链）
 *   ④ --check：产物过期/缺失 → 非零；刚构建完 → 零
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(APP_ROOT, 'scripts', 'bundle-modules.js');
const bundle = require(SCRIPT);

function readModulePathsFromLoader() {
  const src = fs.readFileSync(path.join(APP_ROOT, 'public', 'js', 'index-loader.js'), 'utf8');
  const m = src.match(/const modulePaths = \[([\s\S]*?)\];/);
  assert.ok(m, 'index-loader.js 里应能匹配到 modulePaths 数组');
  return [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]);
}

test('① 顺序守恒：buildRuns 展平结果与 modulePaths 逐位一致', () => {
  const paths = readModulePathsFromLoader();
  const runs = bundle.buildRuns(paths);
  assert.deepStrictEqual(runs.flatMap((r) => r.files), paths);
});

test('① 段名去重后缀：同组多段时按 misc-root-2 递增编号', () => {
  const runs = bundle.buildRuns([
    'js/modules/00-state/00-a.js',
    'js/home-video-discovery.js',
    'js/modules/01-scene/00-b.js',
    'js/other-loose.js',
  ]);
  assert.deepStrictEqual(runs.map((r) => r.name), ['00-state', 'misc-root', '01-scene', 'misc-root-2']);
});

test('② 孤儿扫描跳过 *_1.js 副本', () => {
  const orphans = bundle.collectOrphans(
    ['js/modules/00-state/00-core-stores.js'],
    [
      'js/modules/00-state/00-core-stores.js',
      'js/modules/00-state/00-core-stores_1.js',
      'js/modules/08-account/00-login-easter-egg.js',
    ]
  );
  assert.deepStrictEqual(orphans, ['js/modules/08-account/00-login-easter-egg.js']);
});

test('本仓库现场：modulePaths 全部存在且分段为 15 段/112 模块', () => {
  const paths = readModulePathsFromLoader();
  for (const p of paths) {
    assert.ok(fs.existsSync(path.join(APP_ROOT, 'public', p)), 'modulePaths 引用文件缺失: ' + p);
  }
  const runs = bundle.buildRuns(paths);
  assert.strictEqual(paths.length, 112);
  assert.strictEqual(runs.length, 15);
});

test('③ 原子性：语法坏的一段 → 非零退出且旧产物分毫不动', () => {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-bundle-atomic-'));
  try {
    const pub = path.join(stageRoot, 'public');
    const modulesDir = path.join(pub, 'js', 'modules', '00-state');
    fs.mkdirSync(modulesDir, { recursive: true });

    const loader = "const modulePaths = [\n  'js/modules/00-state/00-a.js',\n];\n";
    fs.writeFileSync(path.join(pub, 'js', 'index-loader.js'), loader);
    fs.writeFileSync(path.join(modulesDir, '00-a.js'), 'var ok = 1;\n');

    // 预置一份"上次的正确产物"，用于验证失败时不被破坏
    const bundlesDir = path.join(pub, 'js', 'bundles');
    fs.mkdirSync(bundlesDir, { recursive: true });
    const prevBundle = path.join(bundlesDir, '00-state.bundle.js');
    fs.writeFileSync(prevBundle, 'PREVIOUS GOOD ARTIFACT\n');

    // 注入语法错误
    fs.writeFileSync(path.join(modulesDir, '00-a.js'), 'function broken(\n');
    const r = spawnSync(process.execPath, [SCRIPT, '--out', pub], { encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, '语法错误必须非零退出');
    assert.match(r.stderr + r.stdout, /语法校验失败/);
    assert.strictEqual(fs.readFileSync(prevBundle, 'utf8'), 'PREVIOUS GOOD ARTIFACT\n', '失败时旧 bundle 不得被删改');
    assert.ok(!fs.existsSync(path.join(bundlesDir, 'bundle-manifest.json')), '失败时不得写出 manifest');

    // 修好后重跑：必须成功产出
    fs.writeFileSync(path.join(modulesDir, '00-a.js'), 'var ok = 2;\n');
    const ok = spawnSync(process.execPath, [SCRIPT, '--out', pub], { encoding: 'utf8' });
    assert.strictEqual(ok.status, 0, '修复后应构建成功: ' + ok.stderr);
    assert.match(fs.readFileSync(prevBundle, 'utf8'), /js\/modules\/00-state\/00-a\.js/);
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
});

test('④ --check：刚构建完为 0，改动源文件后为 1', () => {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-bundle-check-'));
  try {
    const pub = path.join(stageRoot, 'public');
    const modulesDir = path.join(pub, 'js', 'modules', '00-state');
    fs.mkdirSync(modulesDir, { recursive: true });
    fs.writeFileSync(path.join(pub, 'js', 'index-loader.js'), "const modulePaths = [\n  'js/modules/00-state/00-a.js',\n];\n");
    const mod = path.join(modulesDir, '00-a.js');
    fs.writeFileSync(mod, 'var ok = 1;\n');

    assert.strictEqual(spawnSync(process.execPath, [SCRIPT, '--out', pub]).status, 0);

    const check = (args) => spawnSync(process.execPath, [SCRIPT, '--out', pub, ...args], { encoding: 'utf8' });
    assert.strictEqual(check(['--check']).status, 0, '产物与源一致时 --check 必须通过');

    fs.writeFileSync(mod, 'var ok = 2;\n'); // 改了源、忘了 npm run bundle
    const stale = check(['--check']);
    assert.strictEqual(stale.status, 1, '产物过期时 --check 必须失败');
    assert.match(stale.stdout + stale.stderr, /过期|不一致/);
    assert.strictEqual(fs.readFileSync(mod, 'utf8'), 'var ok = 2;\n', '--check 只读，不得写盘');

    fs.rmSync(path.join(pub, 'js', 'bundles', 'bundle-manifest.json'));
    const missing = check(['--check']);
    assert.strictEqual(missing.status, 1, '缺产物时 --check 必须失败');
    assert.match(missing.stdout + missing.stderr, /npm run bundle/);
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
});

test('本仓库产物：存在则必须新鲜（改过模块要先 npm run bundle）', () => {
  const bundlesDir = path.join(APP_ROOT, 'public', 'js', 'bundles');
  if (!fs.existsSync(path.join(bundlesDir, 'bundle-manifest.json'))) {
    // 产物是生成物，暂未入库（本批只提交脚本/loader/测试/文档）→ 首次克隆无产物属正常，
    // 运行时 loader 读不到 manifest 自动回退逐文件；硬门禁在 build:win 前置的 bundle:check。
    return;
  }
  const r = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8', cwd: APP_ROOT });
  assert.strictEqual(r.status, 0, 'bundle 产物已过期，跑 npm run bundle 重建:\n' + (r.stdout || '') + (r.stderr || ''));
});

test('manifest 带 builtAt 与逐段 modules，供 loader 做新鲜度守卫', () => {
  const manifestPath = path.join(APP_ROOT, 'public', 'js', 'bundles', 'bundle-manifest.json');
  if (!fs.existsSync(manifestPath)) return; // 上一测已负责失败
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(typeof manifest.builtAt === 'string' && manifest.builtAt.length > 0);
  const flat = manifest.groups.flatMap((g) => g.modules);
  assert.deepStrictEqual(flat, readModulePathsFromLoader());
});

test('loader 守卫：bundle 段用 builtAt 版本、且 manifest 过期时回退逐文件', () => {
  const loader = fs.readFileSync(path.join(APP_ROOT, 'public', 'js', 'index-loader.js'), 'utf8');
  assert.match(loader, /__stellaflixBundleMode/, 'loader 应暴露 bundle 模式标记');
  assert.match(loader, /bundle-manifest\.json/);
  assert.match(loader, /builtAt/, 'bundle 请求应使用 manifest.builtAt 作版本，而不是 Date.now 每次全失效');
  assert.doesNotMatch(loader, /readModule\(bundleManifest\.groups\[.*\]\.file\)/, 'bundle 段不得沿用 Date.now cache-bust');
  // 新鲜度守卫：manifest 展平与 modulePaths 逐位比对
  assert.match(loader, /bundleModulesMatch|staleBundle|过期/, 'loader 缺少 manifest↔modulePaths 一致性守卫');
});
