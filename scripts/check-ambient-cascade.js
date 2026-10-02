#!/usr/bin/env node
'use strict';

/**
 * 真实内核层叠验证：二级页「环境色底色」在 Chromium 里到底画没画出来。
 *
 * 为什么需要它：tests/home-collections-ambient-cascade.test.js 用的是自实现的层叠求解器
 * （因为 jsdom 不认 !important，会给出假结论）。本脚本用仓库自带的 Electron 跑真实 Chromium，
 * 既读 getComputedStyle 的**解析后**值，也抓帧缓冲采样**真实渲染像素**，并内置负向对照
 * （把 --detail 的 !important 剥掉 = 修复前状态），两个结果必须不同，否则说明验证失效。
 *
 * 用法：
 *   node scripts/check-ambient-cascade.js            # 对照验证，成功 exit 0
 *   node scripts/check-ambient-cascade.js --verbose  # 打印全部候选/采样点
 *
 * 退出码：0 = 通过；1 = 层叠没生效（环境色没画出来）；2 = 环境/依赖不可用。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const verbose = process.argv.includes('--verbose');

const cssPath = path.join(root, 'public/css/index.css');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
if (!fs.existsSync(cssPath)) { console.error('缺少 ' + cssPath); process.exit(2); }
if (!fs.existsSync(electronExe)) { console.error('未找到 Electron 可执行文件：' + electronExe); process.exit(2); }

const css = fs.readFileSync(cssPath, 'utf8');
const DETAIL_RE = /\.home-video-collections-modal\.home-video-collections--detail\s*\{[^}]*\}/s;
const detailRule = DETAIL_RE.exec(css);
if (!detailRule) { console.error('未找到 ' + '.home-video-collections-modal.home-video-collections--detail 规则'); process.exit(2); }
// 负向对照：剥掉本条的 !important = 模拟修复前（玻璃 !important 重新掌权）
const prefixCss = css.replace(detailRule[0], detailRule[0].replace(/!important/g, ''));

// ── 环境色来源：直接跑项目自己的 ambientFrom()，输入取「真实海报像素」──
// 输入 #3d575c = 用户实机截图（clipboard-2026-10-01T12-46-39-065Z-48697425.jpg，漫威电影宇宙二级页）
// 里 hero 图片区的平均色（实测），即本项目 /api/image-color 那条链路会拿到的同类输入。
// 故意不用手挑的「好看颜色」——避免用自选输入跑出好看输出、再当效果演示。
const POSTER_AVG_FROM_USER_SHOT = '#3d575c';

function loadAmbientFrom() {
  const overlay = fs.readFileSync(path.join(root, 'public/video/home-collections-overlay.js'), 'utf8');
  const grab = (re, name) => { const m = re.exec(overlay); if (!m) throw new Error('源码里缺少 ' + name); return m[0]; };
  const isHex = grab(/function\s+isHexColor\s*\([\s\S]*?\n  \}/, 'isHexColor()');
  const lum = grab(/function\s+srgbLuminance\s*\([\s\S]*?\n  \}/, 'srgbLuminance()');
  const amb = grab(/function\s+ambientFrom\s*\([\s\S]*?\n  \}/, 'ambientFrom()');
  const maxM = /AMBIENT_MAX_LUM\s*=\s*([\d.]+)/.exec(overlay);
  if (!maxM) throw new Error('源码里缺少 AMBIENT_MAX_LUM');
  return new Function('AMBIENT_MAX_LUM',
    'return (function(){' + isHex + lum + amb + '; return ambientFrom;})()')(Number(maxM[1]));
}

const ambientFrom = loadAmbientFrom();
const AMBIENT = ambientFrom(POSTER_AVG_FROM_USER_SHOT);
if (!/^#[0-9a-f]{6}$/i.test(AMBIENT)) {
  console.error('ambientFrom(' + POSTER_AVG_FROM_USER_SHOT + ') 未返回合法色值：' + JSON.stringify(AMBIENT));
  process.exit(2);
}

// ── 临时工作目录（优先 _scratch，已被 .gitignore 忽略；失败则退回系统临时目录）──
let tmpDir;
try {
  tmpDir = path.join(root, '_scratch', '_ambient-cascade');
  fs.mkdirSync(tmpDir, { recursive: true });
} catch (e) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-cascade-'));
}

const PROBE_MAIN = `
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

const htmlPath = path.resolve(process.argv[2]);
const outPath = path.resolve(process.argv[3]);
const pngPath = path.resolve(process.argv[4]);

function pxAt(img, x, y) {
  const size = img.getSize();
  if (x < 0 || y < 0 || x >= size.width || y >= size.height) return null;
  const bmp = img.getBitmap();
  const i = (y * size.width + x) * 4;
  return [bmp[i + 2], bmp[i + 1], bmp[i]];
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 760, webPreferences: { offscreen: false } });
  try {
    await win.loadFile(htmlPath);
    await new Promise(function (r) { setTimeout(r, 400); });
    const info = await win.webContents.executeJavaScript(
      "(function(){var el=document.querySelector('.home-video-collections-modal');" +
      "if(!el)return{error:'modal not found'};var cs=getComputedStyle(el);var r=el.getBoundingClientRect();" +
      "var hero=document.querySelector('.home-video-collections-hero');var hr=hero?hero.getBoundingClientRect():null;" +
      "return{background:cs.background,backgroundColor:cs.backgroundColor,padding:cs.padding," +
      "ambientVar:cs.getPropertyValue('--wc-ambient').trim()," +
      "rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}," +
      "heroRect:hr?{y:Math.round(hr.y),h:Math.round(hr.height)}:null};})()"
    );
    let shots = null;
    if (info && info.rect && info.rect.w > 0) {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(pngPath, img.toPNG());
      const cx = Math.round(info.rect.x + info.rect.w / 2);
      const heroBottom = info.heroRect ? info.heroRect.y + info.heroRect.h : info.rect.y + 200;
      const from = Math.round(heroBottom + 8);
      const to = Math.round(info.rect.y + info.rect.h - 8);
      const step = Math.max(1, Math.floor((to - from) / 5));
      const samples = [];
      for (let i = 0; i < 6; i++) samples.push({ y: Math.min(to, from + i * step), rgb: null });
      samples.forEach(function (s) { s.rgb = pxAt(img, cx, s.y); });
      shots = { centerX: cx, heroBottom: Math.round(heroBottom), samples: samples };
    }
    fs.writeFileSync(outPath, JSON.stringify({ info: info, shots: shots }));
  } catch (e) {
    fs.writeFileSync(outPath, JSON.stringify({ fatal: String((e && e.stack) || e) }));
  } finally {
    app.quit();
  }
});
`;

const DOM = `
<div class="modal-mask show">
  <div class="modal home-video-collections-modal home-video-collections--detail"
       style="--wc-warm:#534AB7;--wc-ambient:{{AMBIENT}}">
    <div class="home-video-collections-list">
      <div class="home-video-collections-hero">
        <span class="home-video-collections-hero-copy"><strong>漫威电影宇宙</strong></span>
      </div>
      <div class="home-video-collections-items-grid">
        ${Array.from({ length: 6 }).map(() => '<div class="home-video-collections-item"><span class="home-video-collections-item-poster"></span><span class="home-video-collections-item-title">复仇者联盟</span></div>').join('')}
      </div>
    </div>
  </div>
</div>`;

// 免责横幅直接烧进截图，避免这张图被误当成实机截图
function banner(label, color) {
  return '<div style="position:fixed;top:0;left:0;right:0;z-index:9999;background:#111;color:#ffd166;' +
    'font:12px/1.6 monospace;padding:5px 10px;border-bottom:1px solid #444">' +
    '真实 Chromium 渲染本仓库 index.css 的二级页结构（最小复现，非实机截图，无真实海报） ── 状态: ' +
    label + ' ── --wc-ambient=' + color + '</div>';
}

function writeHtml(name, cssText, label) {
  const p = path.join(tmpDir, '_ambient_' + name + '.html');
  fs.writeFileSync(p, '<!doctype html><html><head><meta charset="utf-8"><style>' + cssText +
    '\nbody{padding-top:30px}</style></head><body>' +
    banner(label, AMBIENT) + DOM.replace('{{AMBIENT}}', AMBIENT) + '</body></html>');
  return p;
}

function probe(htmlFile) {
  const mainFile = path.join(tmpDir, '_ambient_probe_main.js');
  fs.writeFileSync(mainFile, PROBE_MAIN);
  const outFile = htmlFile.replace(/\.html$/, '.result.json');
  const pngFile = htmlFile.replace(/\.html$/, '.png');
  try { fs.unlinkSync(outFile); } catch (e) { /* 首次运行无文件 */ }
  try { fs.unlinkSync(pngFile); } catch (e) { /* 首次运行无文件 */ }
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE; // 有值即被 Electron 当成「以 node 模式运行」，必须彻底删除
  // 不能用管道：Electron 的 GPU/渲染子进程会占住继承的管道句柄，spawnSync 会一直等到超时且拿不到输出
  const r = spawnSync(electronExe, [mainFile, htmlFile, outFile, pngFile], { env: env, stdio: 'ignore', timeout: 90000 });
  if (!fs.existsSync(outFile)) {
    return { parseError: 'Electron 未产出结果（status=' + r.status + ' signal=' + r.signal + ' error=' + ((r.error && r.error.message) || '') + '）' };
  }
  try { return JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { return { parseError: String(e) }; }
}

function lum(rgb) {
  const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
const hex = (rgb) => '#' + rgb.map((v) => ('0' + v.toString(16)).slice(-2)).join('');
const contrast = (rgb) => 1.05 / (lum(rgb) + 0.05);

function report(title, res) {
  console.log('\n===== ' + title + ' =====');
  if (res.parseError) { console.log('探针失败：' + res.parseError); return; }
  if (res.fatal || !res.info || res.info.error) { console.log('原始返回：' + JSON.stringify(res).slice(0, 1200)); return; }
  const i = res.info;
  console.log('  getComputedStyle(modal).background = ' + JSON.stringify(i.background));
  console.log('  解析后 --wc-ambient               = ' + JSON.stringify(i.ambientVar));
  console.log('  padding                            = ' + JSON.stringify(i.padding));
  if (res.shots) {
    console.log('  hero 底 y=' + res.shots.heroBottom + '，以下为 hero 下方中轴各点真实渲染像素：');
    res.shots.samples.forEach((s) => {
      if (!s.rgb) { console.log('    y=' + s.y + '  越界'); return; }
      const L = lum(s.rgb);
      console.log('    y=' + String(s.y).padStart(4) + '  ' + hex(s.rgb) +
        '  R-B差=' + String(s.rgb[0] - s.rgb[2]).padStart(4) +
        '  L=' + L.toFixed(4) +
        '  白字对比度=' + contrast(s.rgb).toFixed(2) + ':1');
    });
  }
}

const fixedHtml = writeHtml('fixed', css, 'FIXED');
const brokenHtml = writeHtml('prefix', prefixCss, 'BROKEN（剥掉 --detail 的 !important = 修复前）');
const fixed = probe(fixedHtml);
const broken = probe(brokenHtml);

console.log('环境色来源：ambientFrom(' + POSTER_AVG_FROM_USER_SHOT + ') = ' + AMBIENT +
  '（POSTER_AVG_FROM_USER_SHOT 取用户实机截图的 hero 区平均色，非手挑颜色）');
console.log('截图（真实 Chromium 渲染，最小复现结构）：');
console.log('  修复后：' + fixedHtml.replace(/\.html$/, '.png'));
console.log('  修复前：' + brokenHtml.replace(/\.html$/, '.png'));

report('① 现状（index.css 当前内容）', fixed);
report('② 负向对照（剥掉 --detail 的 !important = 修复前状态）', broken);

// ── 判定 ──
let failed = 0;
function judge(label, ok, detail) {
  console.log((ok ? '  [通过] ' : '  [失败] ') + label + (detail ? ' —— ' + detail : ''));
  if (!ok) failed += 1;
}

console.log('\n===== 判定 =====');
if (fixed.parseError || !fixed.info || fixed.info.error || !fixed.shots) {
  console.error('无法取得现状结果，验证不成立。');
  process.exit(2);
}
if (broken.parseError || !broken.info || broken.info.error || !broken.shots) {
  console.error('无法取得负向对照结果，验证不成立。');
  process.exit(2);
}

// 浏览器会把 var(--wc-ambient) 解析成具体色值 —— 正好可以直接比对 RGB
function rgbFromHex(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
const ambHex = fixed.info.ambientVar;
const [ar, ag, ab] = /^#[0-9a-f]{6}$/i.test(ambHex) ? rgbFromHex(ambHex) : [NaN, NaN, NaN];
const gotRgb = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(fixed.info.background);

judge('现状：--wc-ambient 解析为具体十六进制色值', /^#[0-9a-f]{6}$/i.test(ambHex), ambHex);
judge('现状：background 计算出的 RGB === --wc-ambient 的 RGB',
  !!gotRgb && +gotRgb[1] === ar && +gotRgb[2] === ag && +gotRgb[3] === ab,
  'background=' + JSON.stringify(fixed.info.background) + ' / --wc-ambient=' + ambHex);
judge('现状：background 不含任何渐变层（玻璃规则的多层渐变已被完全顶掉）',
  !/gradient/i.test(fixed.info.background), fixed.info.background);

const fixedPx = fixed.shots.samples.filter((s) => s.rgb);
const chromatic = fixedPx.filter((s) => Math.abs(s.rgb[0] - s.rgb[2]) >= 20);
judge('现状：hero 下方采样点存在明显色偏（|R-B| ≥ 20）', chromatic.length >= 3,
  fixedPx.map((s) => hex(s.rgb) + '(Δ' + (s.rgb[0] - s.rgb[2]) + ')').join(' '));

const brokenPx = broken.shots.samples.filter((s) => s.rgb);
const brokenChromatic = brokenPx.filter((s) => Math.abs(s.rgb[0] - s.rgb[2]) >= 20);
judge('负向对照：剥掉 !important 后必须变成无明显色偏（证明本验证有牙齿）', brokenChromatic.length === 0,
  brokenPx.map((s) => hex(s.rgb) + '(Δ' + (s.rgb[0] - s.rgb[2]) + ')').join(' '));

judge('对照有区分度：修复前后胜出的 background 不是同一个值',
  fixed.info.background !== broken.info.background);

if (!verbose) console.log('\n（加 --verbose 可查看完整采样明细；本脚本已默认打印全部采样点）');
if (failed) { console.error('\n结论：不通过（' + failed + ' 项失败）'); process.exit(1); }
console.log('\n结论：通过 —— 二级页卡片区底色确实被染成环境色，且判定依据能区分修复前后。');
