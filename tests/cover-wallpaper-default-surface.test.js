'use strict';

/**
 * tests/cover-wallpaper-default-surface.test.js — 壁纸模式默认展示面必须对齐 Mineradio 2.5.1
 *
 * 背景（2026-10-25 用户拍板 A+B+C 一步到位对齐）：
 *   - 参照库 public/app.js:2613 `wallpaperSurface: 'desktop'`（默认画到桌面壁纸层）；
 *     :7855-7857 normalizeWallpaperSurface 默认 desktop。
 *   - 我们曾把默认写成 'board'（播放器背景板），导致开箱观感是「壁纸铺满窗口」而不是
 *     「居中窗口浮在桌面壁纸上」。本文件锁死这个默认值。
 *
 * 额外锁一条内部不变量：**读路径与写路径的兜底必须一致**。
 * 修复前二者自相矛盾（读 416 行兜底 board、写 927 行兜底 desktop）——同一份存档读进来是
 * board、写回去变 desktop。这类撕裂只能靠「两处同时取值比对」抓出来。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');
const DEFAULTS_PATH = path.join(APP_ROOT, 'public/js/modules/00-state/04-fx-defaults.js');
const PERSIST_PATH = path.join(APP_ROOT, 'public/js/modules/02-visual/04-visual-settings-persistence.js');

const DEFAULTS_SRC = fs.readFileSync(DEFAULTS_PATH, 'utf8');
const PERSIST_SRC = fs.readFileSync(PERSIST_PATH, 'utf8');

/** 取 `coverWallpaperSurface: <expr>,` 的默认值表达式（fxDefaults 内只有一处）。 */
function readFxDefaultExpr() {
  const m = DEFAULTS_SRC.match(/coverWallpaperSurface:\s*('(?:desktop|board)'|\[[^\]]*\]|fxDefaults\.[\w.]+)/);
  assert.ok(m, 'fxDefaults 里找不到 coverWallpaperSurface 默认值');
  return m[1];
}

/** 把 `X === 'board' ? 'board' : 'desktop'` 这类三元式求值成它实际兜底的那一面。 */
function resolveFallback(expr, needle) {
  const idx = expr.indexOf(needle);
  assert.ok(idx >= 0, '无法在该表达式里定位 ' + needle);
  const ternary = expr.slice(idx).match(/\?\s*'([^']+)'\s*:\s*'([^']+)'/);
  assert.ok(ternary, '兜底表达式不是可解析的三元式');
  return { whenTrue: ternary[1], whenFalse: ternary[2] };
}

function collectSurfaceFallbacks() {
  const rows = [];
  const re = /coverWallpaperSurface:\s*([^,\n]+)/g;
  let m;
  while ((m = re.exec(PERSIST_SRC))) {
    const expr = m[1].trim();
    const lineNo = PERSIST_SRC.slice(0, m.index).split('\n').length;
    const ternary = expr.match(/'([^']+)'\s*\)\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/)
      || expr.match(/\?\s*'([^']+)'\s*:\s*'([^']+)'/);
    if (!ternary) continue;
    // 三元式形态：`String(x||'') === 'board' ? 'board' : 'desktop'`
    const condMatch = expr.match(/===\s*'([^']+)'/);
    let fallback;
    if (condMatch) {
      const condValue = condMatch[1];
      const whenTrue = expr.match(/\?\s*'([^']+)'/)[1];
      const whenFalse = expr.match(/:\s*'([^']+)'/)[1];
      fallback = condValue === whenTrue ? whenFalse : whenTrue;
    } else {
      const whenTrue = expr.match(/\?\s*'([^']+)'/)[1];
      const whenFalse = expr.match(/:\s*'([^']+)'/)[1];
      fallback = whenFalse;
    }
    rows.push({ lineNo, expr, fallback });
  }
  return rows;
}

test('① fxDefaults 默认展示面 = desktop（对齐 Mineradio 2.5.1 app.js:2613）', () => {
  assert.equal(readFxDefaultExpr(), "'desktop'",
    'fxDefaults.coverWallpaperSurface 必须是 desktop：否则开箱观感会退化成「壁纸铺满窗口」');
});

test('② 持久化读/写路径的兜底必须一致，且都是 desktop', () => {
  const rows = collectSurfaceFallbacks();
  assert.ok(rows.length >= 2, '预期至少两处（读路径 + 写路径），实际 ' + rows.length + ' 处');
  const distinct = [...new Set(rows.map((r) => r.fallback))];
  assert.deepEqual(distinct, ['desktop'],
    '读/写路径兜底必须统一为 desktop；若出现多个值说明同一份存档读进来与写回去不是同一面。实际：'
    + JSON.stringify(rows));
});

test('③ 归一化函数兜底 desktop（只认 board，其余回落 desktop）', () => {
  const coverSrc = fs.readFileSync(
    path.join(APP_ROOT, 'public/js/modules/02-visual/18-cover-wallpaper.js'), 'utf8');
  const m = coverSrc.match(/function normalizeCoverWallpaperSurface\(value\)\s*\{\s*return[^;]+;/);
  assert.ok(m, '找不到 normalizeCoverWallpaperSurface');
  assert.match(m[0], /===\s*'board'\s*\?\s*'board'\s*:\s*'desktop'/,
    '归一化必须默认 desktop');
});
