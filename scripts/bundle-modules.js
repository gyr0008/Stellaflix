#!/usr/bin/env node
'use strict';

/**
 * scripts/bundle-modules.js — 前端模块「连续段」bundle 构建脚本（B1）
 *
 * 作用：
 *   读取 public/js/index-loader.js 里的 modulePaths 数组（单一事实源，绝不复制第二份顺序），
 *   把【相邻且同组】的模块按 modulePaths 顺序原样拼接为 public/js/bundles/<段名>.bundle.js，
 *   并产出 bundle-manifest.json。index-loader 运行时读 manifest 走 bundle 模式，
 *   缺失/损坏/过期（manifest 与 modulePaths 不一致）时自动回退原逐文件同步 XHR 模式。
 *
 * 红线（违反即退回）：
 *   1. 只按 modulePaths 顺序原样拼接 —— 禁止重排、去重、tree-shake、压缩。
 *      模块间靠全局变量通信，顺序 = 执行顺序 = 语义。
 *   2. 每个文件原样进产物，不包 IIFE、不加 per-module try/catch。
 *   3. modulePaths 引用的文件缺失 → 立刻报错退出，绝不静默跳过。
 *   4. 任何校验失败 → 非零退出，且**不落地任何产物**（旧 bundle 与 manifest 分毫不动）。
 *      理由：loader 的自动回退只覆盖「读取失败」，不覆盖「bundle 内容报错」——
 *      半写入的语法坏产物会被直接注入，外层 try 抛出后整条模块链中止。
 *
 * 用法：
 *   npm run bundle                 生成/刷新产物
 *   node scripts/bundle-modules.js --check   只读校验产物是否与源码一致（发版门禁，不写盘）
 *   测试用：--out <publicDir> 覆盖产物根目录
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_PUBLIC_DIR = path.join(ROOT, 'public');
const MODULES_SUBDIR = path.join('js', 'modules');
const BUNDLES_SUBDIR = path.join('js', 'bundles');
const MANIFEST_NAME = 'bundle-manifest.json';

// 与 .gitignore 的 `*_1.*` / electron-builder `!**/*_1.js` 保持一致：
// 这些是并排放置的历史副本，不参与加载，也不该在孤儿警告里刷屏。
const SUFFIX_COPY_RE = /_1\.js$/;

function readModulePaths(publicDir) {
  const loaderPath = path.join(publicDir, 'js', 'index-loader.js');
  const src = fs.readFileSync(loaderPath, 'utf8');
  const m = src.match(/const modulePaths = \[([\s\S]*?)\];/);
  if (!m) throw new Error('index-loader.js 中找不到 modulePaths 数组');
  const paths = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]);
  if (paths.length === 0) throw new Error('modulePaths 为空数组');
  return paths;
}

// ---------- 分段：连续同组合并（严格保序，绝不交错） ----------
// 实测 modulePaths 存在组间交错（sonic-*-preset.js 插在 02-visual 与 03-beat 之间、
// js/home-video-discovery.js 插在 05-playback 中间），因此不能按「组」整体拼——
// 只把相邻且同组的文件合并为一段，跨组边界立即切段，展平后与 modulePaths 逐位一致。
// 同组出现多段时段名加序号后缀（misc-root / misc-root-2 / …）。
function groupKey(modulePath) {
  const parts = modulePath.split('/');
  if (parts[0] === 'js' && parts[1] === 'modules') {
    if (parts.length === 4) return parts[2]; // js/modules/<组>/<文件>
    return 'misc-root'; // js/modules/<散文件>
  }
  return 'misc-root'; // modules/ 之外的条目（sonic-*-preset.js、js/home-video-discovery.js）
}

function buildRuns(paths) {
  const runs = [];
  const seenKeys = new Map();
  for (const p of paths) {
    const k = groupKey(p);
    const prev = runs[runs.length - 1];
    if (prev && prev.key === k) {
      prev.files.push(p);
      continue;
    }
    const n = (seenKeys.get(k) || 0) + 1;
    seenKeys.set(k, n);
    runs.push({ key: k, name: n === 1 ? k : `${k}-${n}`, files: [p] });
  }
  return runs;
}

// 磁盘 modules/ 下未被 modulePaths 收录的 .js（排除 *_1.js 历史副本）
function collectOrphans(paths, onDiskFiles) {
  const inList = new Set(paths);
  return onDiskFiles.filter((f) => !inList.has(f) && !SUFFIX_COPY_RE.test(f));
}

function listModuleFiles(publicDir) {
  const dir = path.join(publicDir, MODULES_SUBDIR);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  (function walk(sub) {
    for (const name of fs.readdirSync(path.join(publicDir, sub))) {
      const rel = sub + '/' + name;
      if (fs.statSync(path.join(publicDir, rel)).isDirectory()) walk(rel);
      else if (name.endsWith('.js')) out.push(rel);
    }
  })(MODULES_SUBDIR.split(path.sep).join('/'));
  return out;
}

// 把一段模块文件渲染为 bundle 文本（段头 + 每模块分隔标记 + 原样内容）
function renderGroup(key, files, readText) {
  const chunks = [
    `/* Stellaflix module bundle: ${key} — 由 scripts/bundle-modules.js 生成，勿手改。\n` +
    `   段内成员（顺序 = modulePaths）:\n` +
    files.map((f) => `   - ${f}`).join('\n') + ` */\n`,
  ];
  for (const f of files) {
    const content = readText(f);
    chunks.push(`\n// ===== ${f} =====\n`);
    chunks.push(content);
    if (!content.endsWith('\n')) chunks.push('\n');
  }
  return chunks.join('');
}

function makeReader(publicDir) {
  return (rel) => fs.readFileSync(path.join(publicDir, rel), 'utf8');
}

// 渲染全部段 + 顺序守恒校验；返回 { runs, manifest }
function renderAll(publicDir) {
  const paths = readModulePaths(publicDir);
  for (const p of paths) {
    if (!fs.existsSync(path.join(publicDir, p))) {
      throw new Error(`modulePaths 引用的文件不存在: ${p}（先更新 index-loader.js 的数组）`);
    }
  }

  const runs = buildRuns(paths);
  const flattened = runs.flatMap((r) => r.files);
  if (flattened.length !== paths.length || flattened.some((f, i) => f !== paths[i])) {
    throw new Error('分段后顺序与 modulePaths 不一致（内部 bug，禁止产物）');
  }

  const readText = makeReader(publicDir);
  const groups = runs.map((run) => ({
    name: run.name,
    file: `${BUNDLES_SUBDIR.split(path.sep).join('/')}/${run.name}.bundle.js`,
    modules: run.files,
    bytes: Buffer.byteLength(renderGroup(run.name, run.files, readText), 'utf8'),
  }));

  const manifest = {
    builtAt: new Date().toISOString(),
    mode: 'contiguous-runs',
    moduleCount: paths.length,
    groups,
  };
  return { paths, runs, manifest, readText };
}

function syntaxCheck(filePath) {
  const r = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') };
}

// ---------- 构建（全量校验通过后才落地，失败不碰旧产物） ----------
function build(publicDir) {
  const { paths, runs, manifest, readText } = renderAll(publicDir);

  const orphans = collectOrphans(paths, listModuleFiles(publicDir));
  if (orphans.length) {
    console.warn('[bundle] 警告: modules/ 下有未被 modulePaths 收录的文件（不进 bundle，dev 模式 ?dev=1 下同样不加载）:');
    orphans.forEach((f) => console.warn('   - ' + f));
  }

  const bundlesDir = path.join(publicDir, BUNDLES_SUBDIR);

  // 先在临时目录里渲染 + 语法校验：任一失败就直接抛出，public/js/bundles/ 保持原样。
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-bundle-stage-'));
  const rendered = runs.map((run) => renderGroup(run.name, run.files, readText));
  try {
    runs.forEach((run, i) => {
      const text = rendered[i];
      const staged = path.join(stage, run.name + '.bundle.js');
      fs.writeFileSync(staged, text);
      const check = syntaxCheck(staged);
      if (!check.ok) {
        throw new Error(`语法校验失败: ${run.name}.bundle.js\n${check.output}`);
      }
      // 字节级比对：产物内容与源文件重建结果必须逐字节相等（防编码/截断漂移）
      if (fs.readFileSync(staged, 'utf8') !== text) {
        throw new Error(`字节级比对失败: ${run.name}.bundle.js`);
      }
    });

    // 全部通过 → 落地
    fs.mkdirSync(bundlesDir, { recursive: true });
    for (const f of fs.readdirSync(bundlesDir)) {
      if (f.endsWith('.bundle.js')) fs.unlinkSync(path.join(bundlesDir, f));
    }
    runs.forEach((run, i) => {
      fs.writeFileSync(path.join(bundlesDir, run.name + '.bundle.js'), rendered[i]);
    });
    fs.writeFileSync(path.join(bundlesDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  console.log(`[bundle] 完成: ${runs.length} 个 bundle，${paths.length} 个模块 → public/js/bundles/`);
  console.log('[bundle] 校验通过: 顺序守恒 + 逐 bundle node --check + 产物与源文件重建逐字节比对');
}

// ---------- --check：只读校验产物是否与当前源码一致（不写盘） ----------
function check(publicDir) {
  const bundlesDir = path.join(publicDir, BUNDLES_SUBDIR);
  const manifestPath = path.join(bundlesDir, MANIFEST_NAME);
  const fail = (msg) => {
    console.error('[bundle:check] 失败: ' + msg);
    process.exitCode = 1;
  };

  let expected;
  try {
    expected = renderAll(publicDir);
  } catch (e) {
    fail(e.message);
    return;
  }
  if (!fs.existsSync(manifestPath)) {
    fail(`缺少 ${BUNDLES_SUBDIR.split(path.sep).join('/')}/${MANIFEST_NAME} —— 跑 npm run bundle 生成并提交产物`);
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    fail('manifest JSON 损坏: ' + e.message);
    return;
  }
  const expectedGroups = expected.manifest.groups;
  if (!Array.isArray(manifest.groups) ||
      manifest.groups.map((g) => g.name).join('|') !== expectedGroups.map((g) => g.name).join('|')) {
    fail('产物过期：分段结构与当前 modulePaths 不一致 —— 跑 npm run bundle 重建');
    return;
  }

  for (let i = 0; i < manifest.groups.length; i++) {
    const g = manifest.groups[i];
    const exp = expectedGroups[i];
    if ((g.modules || []).join('|') !== exp.modules.join('|')) {
      fail(`产物过期：段 ${g.name} 的成员清单与源码不一致 —— 跑 npm run bundle 重建`);
      return;
    }
    const bundlePath = path.join(publicDir, g.file);
    if (!fs.existsSync(bundlePath)) {
      fail(`产物缺失: ${g.file}`);
      return;
    }
    const onDisk = fs.readFileSync(bundlePath, 'utf8');
    if (onDisk !== renderGroup(g.name, g.modules, expected.readText)) {
      fail(`产物过期：${g.file} 内容与源文件重建结果不一致（字节级）—— 跑 npm run bundle 重建`);
      return;
    }
  }

  if (process.exitCode !== 1) {
    console.log(`[bundle:check] 通过: ${manifest.groups.length} 段 / ${expected.paths.length} 个模块，产物与源码逐字节一致（builtAt=${manifest.builtAt}）`);
  }
}

function parseArgs(argv) {
  const opts = { publicDir: DEFAULT_PUBLIC_DIR, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') opts.check = true;
    else if (argv[i] === '--out') {
      opts.publicDir = path.resolve(argv[++i]);
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('用法: node scripts/bundle-modules.js [--check] [--out <publicDir>]');
      opts.help = true;
    } else {
      throw new Error('未知参数: ' + argv[i]);
    }
  }
  return opts;
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) process.exitCode = 0;
    else if (opts.check) check(opts.publicDir);
    else build(opts.publicDir);
  } catch (e) {
    console.error('[bundle] 失败: ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
} else {
  module.exports = { groupKey, buildRuns, collectOrphans, renderGroup, readModulePaths, listModuleFiles };
}
