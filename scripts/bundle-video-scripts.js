#!/usr/bin/env node
'use strict';

/**
 * scripts/bundle-video-scripts.js — 影视链「连续段」bundle 构建脚本（A 方案）
 *
 * 背景（h150/h151 实测）：public/index.html 内联的 SFV_SCRIPTS 有 134 项，逐个
 * `<script>` + `requestIdleCallback({timeout:60})` 串行让路，最后一个 .js 到齐 5670ms，
 * 而开屏"点击进入"3837ms 就放行 → 用户进来后还要再等 ~2.6s 才有首页内容。
 * 本脚本把 134 次让路压成 ~9 次。
 *
 * 与音乐侧 scripts/bundle-modules.js 同源的红线（违反即退回）：
 *   1. 只按 SFV_SCRIPTS 顺序原样拼接 —— 禁止重排、去重、tree-shake、压缩。
 *      模块间靠全局变量通信，顺序 = 执行顺序 = 语义。
 *   2. 每个文件原样进产物，不包 IIFE、不加 per-module try/catch。
 *   3. 首指令为 'use strict' 的文件必须独占一段：拼接后该指令会覆盖同段后续文件，
 *      把 sloppy-mode 的全局声明写坏（本仓库现场只有 video/world-lighthouse-effects.js）。
 *   4. SFV_SCRIPTS 引用的文件缺失 → 立刻报错退出，绝不静默跳过。
 *   5. 任何校验失败 → 非零退出，且不落地任何产物（旧 bundle 与 manifest 分毫不动）。
 *      理由：运行时加载器的自动回退只覆盖「读取失败」，不覆盖「bundle 内容报错」。
 *
 * 用法：
 *   node scripts/bundle-video-scripts.js            生成/刷新产物
 *   node scripts/bundle-video-scripts.js --check    只读校验产物与源码一致（发版门禁，不写盘）
 *   测试用：--out <publicDir> 覆盖产物根目录，--max <n> 覆盖单段文件数上限
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_PUBLIC_DIR = path.join(ROOT, 'public');
const BUNDLES_SUBDIR = 'video/bundles';
const MANIFEST_NAME = 'video-bundle-manifest.json';
const DEFAULT_MAX_FILES = 16;

function readSfvScripts(publicDir) {
  const src = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const m = src.match(/var SFV_SCRIPTS = \[([\s\S]*?)\];/);
  if (!m) throw new Error('index.html 中找不到 SFV_SCRIPTS 数组');
  const paths = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
  if (paths.length === 0) throw new Error('SFV_SCRIPTS 为空数组');
  return paths;
}

// 跳过首部注释与空白后，首条语句是否为 'use strict' 指令。
// 注释在前不影响指令生效，所以不能只看第一行。
function leadingUseStrict(src) {
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
    break;
  }
  return /^(['"])use strict\1/.test(src.slice(i, i + 24));
}

function detectUseStrictFiles(files, readText) {
  return files.filter((f) => leadingUseStrict(readText(f)));
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// 连续段切分：满 maxFiles 切段；strict 文件独占一段且成为切分点。
function buildSegments(files, strictFiles, maxFiles) {
  const limit = maxFiles || DEFAULT_MAX_FILES;
  const strict = new Set(strictFiles || []);
  const segs = [];
  for (const f of files) {
    if (strict.has(f)) { segs.push({ files: [f], strict: true }); continue; }
    const prev = segs[segs.length - 1];
    if (prev && !prev.strict && prev.files.length < limit) prev.files.push(f);
    else segs.push({ files: [f], strict: false });
  }
  segs.forEach((s, i) => {
    s.name = s.strict
      ? `sfv-${pad2(i + 1)}-${path.basename(s.files[0]).replace(/\.js$/, '')}`
      : `sfv-${pad2(i + 1)}`;
  });
  return segs;
}

function renderSegment(name, files, readText) {
  const chunks = [
    `/* Stellaflix video bundle: ${name} — 由 scripts/bundle-video-scripts.js 生成，勿手改。\n` +
    `   段内成员（顺序 = SFV_SCRIPTS）:\n` +
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

function renderAll(publicDir, maxFiles) {
  const files = readSfvScripts(publicDir);
  for (const f of files) {
    if (!fs.existsSync(path.join(publicDir, f))) {
      throw new Error(`SFV_SCRIPTS 引用的文件不存在: ${f}（先更新 index.html 的数组）`);
    }
  }
  const readText = makeReader(publicDir);
  const strictFiles = detectUseStrictFiles(files, readText);
  const segments = buildSegments(files, strictFiles, maxFiles);

  const flattened = segments.flatMap((s) => s.files);
  if (flattened.length !== files.length || flattened.some((f, i) => f !== files[i])) {
    throw new Error('分段后顺序与 SFV_SCRIPTS 不一致（内部 bug，禁止产物）');
  }
  for (const s of segments) {
    if (s.strict && s.files.length !== 1) throw new Error(`strict 段 ${s.name} 未独占（内部 bug）`);
  }

  const groups = segments.map((seg) => ({
    name: seg.name,
    file: `${BUNDLES_SUBDIR}/${seg.name}.bundle.js`,
    modules: seg.files,
    bytes: Buffer.byteLength(renderSegment(seg.name, seg.files, readText), 'utf8'),
  }));
  const manifest = {
    builtAt: new Date().toISOString(),
    mode: 'contiguous-segments',
    scriptCount: files.length,
    maxFilesPerSegment: maxFiles || DEFAULT_MAX_FILES,
    groups,
  };
  return { files, segments, manifest, readText };
}

function syntaxCheck(filePath) {
  const r = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') };
}

function build(publicDir, maxFiles) {
  const { segments, manifest, readText } = renderAll(publicDir, maxFiles);
  const rendered = segments.map((s) => renderSegment(s.name, s.files, readText));

  // 先暂存渲染 + 语法校验：任一失败直接抛出，public/video/bundles/ 保持原样。
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'sfv-bundle-stage-'));
  try {
    segments.forEach((seg, i) => {
      const staged = path.join(stage, seg.name + '.bundle.js');
      fs.writeFileSync(staged, rendered[i]);
      const check = syntaxCheck(staged);
      if (!check.ok) throw new Error(`语法校验失败: ${seg.name}.bundle.js\n${check.output}`);
      if (fs.readFileSync(staged, 'utf8') !== rendered[i]) {
        throw new Error(`字节级比对失败: ${seg.name}.bundle.js`);
      }
    });

    const bundlesDir = path.join(publicDir, ...BUNDLES_SUBDIR.split('/'));
    fs.mkdirSync(bundlesDir, { recursive: true });
    for (const f of fs.readdirSync(bundlesDir)) {
      if (f.endsWith('.bundle.js')) fs.unlinkSync(path.join(bundlesDir, f));
    }
    segments.forEach((seg, i) => {
      fs.writeFileSync(path.join(bundlesDir, seg.name + '.bundle.js'), rendered[i]);
    });
    fs.writeFileSync(path.join(bundlesDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  console.log(`[bundle:video] 完成: ${segments.length} 个 bundle，${manifest.scriptCount} 个脚本 → public/${BUNDLES_SUBDIR}/`);
  console.log('[bundle:video] 校验通过: 顺序守恒 + strict 段独占 + 逐 bundle node --check + 产物与源文件重建逐字节比对');
}

function check(publicDir, maxFiles) {
  const bundlesDir = path.join(publicDir, ...BUNDLES_SUBDIR.split('/'));
  const manifestPath = path.join(bundlesDir, MANIFEST_NAME);
  const fail = (msg) => {
    console.error('[bundle:video:check] 失败: ' + msg);
    process.exitCode = 1;
  };

  let expected;
  try {
    expected = renderAll(publicDir, maxFiles);
  } catch (e) {
    fail(e.message);
    return;
  }
  if (!fs.existsSync(manifestPath)) {
    fail(`缺少 public/${BUNDLES_SUBDIR}/${MANIFEST_NAME} —— 跑 npm run bundle 生成产物`);
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
    fail('产物过期：分段结构与当前 SFV_SCRIPTS 不一致 —— 跑 npm run bundle 重建');
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
    if (fs.readFileSync(bundlePath, 'utf8') !== renderSegment(g.name, g.modules, expected.readText)) {
      fail(`产物过期：${g.file} 内容与源文件重建结果不一致（字节级）—— 跑 npm run bundle 重建`);
      return;
    }
  }
  if (process.exitCode !== 1) {
    console.log(`[bundle:video:check] 通过: ${manifest.groups.length} 段 / ${expected.files.length} 个脚本，产物与源码逐字节一致（builtAt=${manifest.builtAt}）`);
  }
}

function parseArgs(argv) {
  const opts = { publicDir: DEFAULT_PUBLIC_DIR, check: false, maxFiles: DEFAULT_MAX_FILES };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') opts.check = true;
    else if (argv[i] === '--out') opts.publicDir = path.resolve(argv[++i]);
    else if (argv[i] === '--max') opts.maxFiles = Number(argv[++i]) || DEFAULT_MAX_FILES;
    else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
    else throw new Error('未知参数: ' + argv[i]);
  }
  return opts;
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) console.log('用法: node scripts/bundle-video-scripts.js [--check] [--out <publicDir>] [--max <n>]');
    else if (opts.check) check(opts.publicDir, opts.maxFiles);
    else build(opts.publicDir, opts.maxFiles);
  } catch (e) {
    console.error('[bundle:video] 失败: ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
} else {
  module.exports = {
    readSfvScripts, leadingUseStrict, detectUseStrictFiles,
    buildSegments, renderSegment, DEFAULT_MAX_FILES,
  };
}
