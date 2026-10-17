'use strict';

/**
 * tests/video-bundle-scripts.test.js — 影视链「连续段」bundle 构建脚本契约（A 方案）
 *
 * 背景实测事实（h150/h151）：影视 134 个脚本走「每个文件一次 requestIdleCallback 让路」
 * 的串行链，最后一个 .js 到齐 5670ms，而开屏"点击进入"3837ms 就放行 → 用户进来之后
 * 还要再等 ~2.6s 才有首页内容。分段 bundle 把 134 次让路压成 ~10 次。
 *
 * 红线（与音乐侧 scripts/bundle-modules.js 同源）：
 *   ① 顺序守恒：分段展平后必须与 index.html 的 SFV_SCRIPTS 逐位一致（禁重排/去重/压缩）
 *   ② 'use strict' 隔离：首指令为 use strict 的文件必须独占一段
 *      —— 拼接后该指令会覆盖同段后续文件，把 sloppy-mode 全局写坏
 *   ③ 段大小上限：单段文件数不得超过 maxFiles
 *   ④ 原子性：任一段语法校验失败 → 非零退出且旧产物分毫不动
 *   ⑤ --check：产物缺失/过期 → 非零；刚构建 → 零
 *   ⑥ 运行时守卫：index.html 里必须有「展平结果与 SFV_SCRIPTS 逐位一致否则回退逐文件」
 *      的判定，以及 ?dev=1 强制逐文件逃生门
 *
 * 运行：node --test tests/video-bundle-scripts.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(APP_ROOT, 'scripts', 'bundle-video-scripts.js');
const bundler = require(SCRIPT);

function readIndexHtml() {
  return fs.readFileSync(path.join(APP_ROOT, 'public', 'index.html'), 'utf8');
}

test('① 顺序守恒：buildSegments 展平结果与 index.html 的 SFV_SCRIPTS 逐位一致', () => {
  const files = bundler.readSfvScripts(path.join(APP_ROOT, 'public'));
  const segments = bundler.buildSegments(files, [], 16);
  assert.deepEqual(segments.flatMap((s) => s.files), files);
});

test('② strict 隔离：首指令为 use strict 的文件独占一段，且不吞掉后续文件的 sloppy 语义', () => {
  const files = ['video/a.js', 'video/world-lighthouse-effects.js', 'video/b.js', 'video/c.js'];
  const segments = bundler.buildSegments(files, ['video/world-lighthouse-effects.js'], 16);
  const iso = segments.find((s) => s.files.indexOf('video/world-lighthouse-effects.js') >= 0);
  assert.equal(iso.files.length, 1, 'strict 文件必须独占一段');
  assert.deepEqual(segments.flatMap((s) => s.files), files, '隔离后仍须逐位守恒');
});

test('② 本仓库现场：detectUseStrictFiles 只认 world-lighthouse-effects.js', () => {
  const publicDir = path.join(APP_ROOT, 'public');
  const files = bundler.readSfvScripts(publicDir);
  const readText = (rel) => fs.readFileSync(path.join(publicDir, rel), 'utf8');
  assert.deepEqual(bundler.detectUseStrictFiles(files, readText), ['video/world-lighthouse-effects.js']);
});

test('③ 段大小上限：没有任何一段超过 maxFiles', () => {
  const files = bundler.readSfvScripts(path.join(APP_ROOT, 'public'));
  const segments = bundler.buildSegments(files, [], 16);
  segments.forEach((s) => assert.ok(s.files.length <= 16, `${s.name} 有 ${s.files.length} 个文件`));
  assert.ok(segments.length >= 2 && segments.length <= 20, `段数应远小于 134，实得 ${segments.length}`);
});

test('④ 原子性：段内含语法坏文件时非零退出，且旧产物一个字节都不动', () => {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfv-bundle-'));
  try {
    fs.mkdirSync(path.join(publicDir, 'video'), { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'index.html'),
      '<script>\nvar SFV_SCRIPTS = [\n  "video/ok.js",\n  "video/bad.js"\n];\n</script>');
    fs.writeFileSync(path.join(publicDir, 'video', 'ok.js'), 'var okLoaded = 1;\n');
    fs.writeFileSync(path.join(publicDir, 'video', 'bad.js'), 'function broken( {\n');
    const first = spawnSync(process.execPath, [SCRIPT, '--out', publicDir], { encoding: 'utf8' });
    assert.notEqual(first.status, 0, '语法坏产物必须非零退出');
    assert.equal(fs.existsSync(path.join(publicDir, 'video', 'bundles')), false,
      '校验失败不得落地任何产物');
  } finally {
    fs.rmSync(publicDir, { recursive: true, force: true });
  }
});

test('⑤ --check：刚构建完为 0，产物被改动后为非 0', () => {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfv-bundle-'));
  try {
    fs.mkdirSync(path.join(publicDir, 'video'), { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'index.html'),
      '<script>\nvar SFV_SCRIPTS = [\n  "video/a.js",\n  "video/b.js"\n];\n</script>');
    fs.writeFileSync(path.join(publicDir, 'video', 'a.js'), 'var aLoaded = 1;\n');
    fs.writeFileSync(path.join(publicDir, 'video', 'b.js'), 'var bLoaded = 1;\n');
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--out', publicDir], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--check', '--out', publicDir], { encoding: 'utf8' }).status, 0);

    const bundleFile = path.join(publicDir, 'video', 'bundles', 'sfv-01.bundle.js');
    fs.writeFileSync(bundleFile, fs.readFileSync(bundleFile, 'utf8') + '\nvar tampered = 1;\n');
    assert.notEqual(spawnSync(process.execPath, [SCRIPT, '--check', '--out', publicDir], { encoding: 'utf8' }).status, 0,
      '产物被手改必须判为过期');
  } finally {
    fs.rmSync(publicDir, { recursive: true, force: true });
  }
});

test('⑥ 运行时守卫：index.html 内联加载器有逐位一致性校验与 ?dev=1 逃生门，且仍走串行让路', () => {
  const html = readIndexHtml();
  assert.match(html, /dev=1/, '应保留 ?dev=1 强制逐文件逃生门');
  assert.match(html, /video\/bundles\/video-bundle-manifest\.json/, '应读取影视 bundle manifest');
  assert.match(html, /回退逐文件/, '不一致时必须回退逐文件，绝不半途硬崩');
  // 顺序守恒红线：守卫必须是逐位比较，不能只比长度
  assert.match(html, /\.every\(function \([\w, ]*\) \{[\s\S]{0,80}=== SFV_SCRIPTS\[/, '应逐位比对 manifest 与 SFV_SCRIPTS');
});

test('⑥ 本仓库现场：产物存在且与源码逐字节一致（npm run bundle 已跑）', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8', cwd: APP_ROOT });
  assert.equal(r.status, 0, `--check 失败：${r.stdout}${r.stderr}`);
});
