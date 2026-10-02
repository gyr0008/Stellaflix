'use strict';

/**
 * 精选片单 · 二级页「环境色底色」层叠守卫（2026-10-01 实机缺陷回归）
 *
 * ── 缺陷 ──────────────────────────────────────────────────────────────
 * 二级页卡片区完全没染色。实机截图实测：卡片区众数色 #000000~#0b0b0d，
 * 红蓝通道差 0（零色相），亮度 0.000~0.003，白字对比度 19.7~21:1 —— 即「没染色」的数值指纹。
 *
 * ── 根因 ──────────────────────────────────────────────────────────────
 * index.css 里有两条把 `.modal` 钉死的玻璃规则，均带 !important：
 *   行 ~14929  `.modal { background: var(--saved-panel-glass-bg) !important }`   spec(0,1,0)
 *   行 ~15422  `.modal { background: var(--panel-glass-bg)      !important }`   spec(0,1,0)（更靠后 → 它胜出）
 * !important 压过一切普通声明，与选择器权重无关。二级页的
 * `.home-video-collections-modal.home-video-collections--detail { background: var(--wc-ambient) }`
 * 权重再高也永远不生效。
 *
 * ── 修复 ──────────────────────────────────────────────────────────────
 * --detail 规则的 background 也加 !important。同为 !important 时按权重 → 顺序定胜负，
 * 本条 spec(0,2,0) > (0,1,0)，且位置更靠后 → 胜出。
 *
 * ── 为什么不用 jsdom ──────────────────────────────────────────────────
 * 实测 jsdom 的 getComputedStyle 只按特异度排序、**不认 `!important`**：剥掉本条的
 * !important 后它照样报 var(--wc-ambient)（即修复前它也会「通过」）→ 用 jsdom 写这条
 * 测试是假守卫。故本文件自带一个按 CSS 规范（!important → 特异度 → 源码顺序）实现的
 * 层叠求解器，并配负向对照证明它认得 !important。
 * 真实内核（Electron/Chromium）的交叉验证见 scripts/check-ambient-cascade.js。
 *
 * 运行：node --test tests/home-collections-ambient-cascade.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexCss = fs.readFileSync(path.join(root, 'public/css/index.css'), 'utf8');

const DETAIL_SEL = '.home-video-collections-modal.home-video-collections--detail';
// 修复前胜出的那条（负向对照的期望结果）
const GLASS_FALLBACK = 'var(--panel-glass-bg)';

// ─────────────────────────────────────────────── 极简 CSS 解析 + 层叠求解

function stripComments(t) { return t.replace(/\/\*[\s\S]*?\*\//g, ''); }

function parseRules(text) {
  const t = stripComments(text);
  const rules = [];
  const atStack = [];
  let i = 0, buf = '';
  while (i < t.length) {
    const ch = t[i];
    if (ch === '{') {
      const prelude = buf.trim();
      buf = '';
      if (prelude.startsWith('@')) { atStack.push(prelude); i++; continue; }
      let depth = 1, j = i + 1;
      while (j < t.length && depth > 0) {
        if (t[j] === '{') depth++;
        else if (t[j] === '}') { depth--; if (depth === 0) break; }
        j++;
      }
      rules.push({ sel: prelude, body: t.slice(i + 1, j), at: atStack.slice(), index: i, order: rules.length });
      i = j + 1;
      continue;
    }
    if (ch === '}') { atStack.pop(); buf = ''; i++; continue; }
    buf += ch; i++;
  }
  return rules;
}

function parseCompound(s) {
  const out = { tag: null, classes: [], ids: [], attrs: [], pseudoEl: [], other: [] };
  const re = /(::[a-zA-Z-]+(?:\([^)]*\))?)|(:[a-zA-Z-]+(?:\([^)]*\))?)|(\.[a-zA-Z0-9_-]+)|(#[a-zA-Z0-9_-]+)|(\[[^\]]*\])|(\*)|(^|[^a-zA-Z0-9_-])([a-zA-Z][a-zA-Z0-9-]*)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) out.pseudoEl.push(m[1]);
    else if (m[2]) out.other.push(m[2]);
    else if (m[3]) out.classes.push(m[3].slice(1));
    else if (m[4]) out.ids.push(m[4].slice(1));
    else if (m[5]) out.attrs.push(m[5]);
    else if (m[6]) { /* 通配 */ }
    else if (m[8]) out.tag = m[8];
  }
  return out;
}

function specOf(sel) {
  let a = 0, b = 0, c = 0;
  sel.trim().split(/\s+/).forEach((p) => {
    const cp = parseCompound(p);
    a += cp.ids.length;
    b += cp.classes.length + cp.attrs.length + cp.other.length;
    c += cp.pseudoEl.length + (cp.tag ? 1 : 0);
  });
  return [a, b, c];
}

function cmpSpec(x, y) {
  return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);
}

function matchCompound(cp, node) {
  if (cp.pseudoEl.length || cp.other.length || cp.attrs.length) return false;
  if (cp.ids.length && !(node.id && cp.ids.every((x) => x === node.id))) return false;
  if (cp.tag && cp.tag !== node.tag) return false;
  return cp.classes.every((x) => node.classes.has(x));
}

// 选择器列表按逗号拆成独立规则；返回命中的「单条」选择器
function matchSelector(sel, chain) {
  const target = chain[chain.length - 1];
  const out = [];
  sel.split(',').forEach((one) => {
    const s = one.trim();
    const parts = s.split(/\s+/).filter(Boolean);
    if (!parts.length || parts.some((p) => p === '>' || p === '+' || p === '~')) return;
    const cps = parts.map(parseCompound);
    if (!matchCompound(cps[cps.length - 1], target)) return;
    let ai = chain.length - 2;
    for (let k = cps.length - 2; k >= 0; k--) {
      let found = false;
      while (ai >= 0) { if (matchCompound(cps[k], chain[ai])) { found = true; ai--; break; } ai--; }
      if (!found) return;
    }
    out.push(s);
  });
  return out;
}

// 真实 DOM 祖先链：index.html 里是 <div class="modal home-video-collections-modal"> 套在 .modal-mask 里
function elementChain(htmlClasses) {
  return [
    { tag: 'html', classes: new Set(htmlClasses || []) },
    { tag: 'body', classes: new Set() },
    { tag: 'div', classes: new Set(['modal-mask', 'show']) },
    { tag: 'div', classes: new Set(['modal', 'home-video-collections-modal', 'home-video-collections--detail']) }
  ];
}

// 列出所有能命中该元素的 background 声明，按规范升序（末条 = 胜者）
function backgroundCandidates(cssText, htmlClasses) {
  const stripped = stripComments(cssText);
  const ch = elementChain(htmlClasses);
  const cands = [];
  parseRules(cssText).forEach((r) => {
    if (r.at.length) return;                       // @media 内规则不计
    if (!/background\s*:/.test(r.body)) return;
    const matched = matchSelector(r.sel, ch);
    if (!matched.length) return;
    let best = null;
    matched.forEach((s) => {
      const sp = specOf(s);
      if (!best || cmpSpec(sp, best.spec) > 0) best = { sel: s, spec: sp };
    });
    const decls = r.body.split(';').map((x) => x.trim()).filter((x) => /^background(-color|-image)?\s*:/.test(x));
    if (!decls.length) return;
    const last = decls[decls.length - 1];
    cands.push({
      order: r.order,
      line: stripped.slice(0, r.index).split('\n').length,
      sel: best.sel,
      spec: best.spec,
      important: /!important/.test(last),
      value: last.replace(/!important/, '').replace(/^background(-color|-image)?\s*:/, '').trim()
    });
  });
  cands.sort((x, y) =>
    (Number(x.important) - Number(y.important)) ||
    cmpSpec(x.spec, y.spec) ||
    (x.order - y.order));
  return cands;
}

function dump(cands) {
  return cands.map((c) =>
    '  行' + c.line + ' spec(' + c.spec.join(',') + ') ' + (c.important ? '!important' : '          ') +
    ' ' + c.value + '\n      selector: ' + c.sel).join('\n');
}

// ─────────────────────────────────────────────── 规则体提取

function detailRuleFull() {
  const m = /\.home-video-collections-modal\.home-video-collections--detail\s*\{[^}]*\}/s.exec(indexCss);
  assert.ok(m, '缺少 ' + DETAIL_SEL + ' 规则');
  return m[0];
}
function detailRuleBody() { return detailRuleFull().replace(/^[^{]*\{/, '').replace(/\}$/, ''); }

// ─────────────────────────────────────────────── 正向：胜者

test('层叠胜者：命中二级页 .modal 的 background 胜者必须是环境色 var(--wc-ambient)', () => {
  const cands = backgroundCandidates(indexCss, []);
  const winner = cands[cands.length - 1];
  assert.ok(winner, '未解析出任何命中该元素的 background 声明');
  assert.match(
    winner.value,
    /var\(--wc-ambient/,
    '实际胜者 = ' + JSON.stringify(winner.value) + '（来自 ' + winner.sel + '，行 ' + winner.line + '，' +
    (winner.important ? '!important' : '普通') + '）\n' +
    '—— 环境色没赢层叠，二级页卡片区会是纯黑（2026-10-01 实机缺陷复现）。候选清单：\n' + dump(cands)
  );
});

// ─────────────────────────────────────────────── 反向：证明求解器认得 !important

test('负向对照：剥掉 --detail 的 !important 后胜者必须变回玻璃变量（证明本条不是假守卫）', () => {
  const full = detailRuleFull();
  assert.match(full, /!important/, '--detail 规则自身须带 !important');
  const stripped = indexCss.replace(full, full.replace(/!important/g, ''));
  assert.notStrictEqual(stripped, indexCss, '替换须真实发生');

  const cands = backgroundCandidates(stripped, []);
  const winner = cands[cands.length - 1];
  assert.strictEqual(
    winner.value,
    GLASS_FALLBACK,
    '剥掉 !important 后胜者应为玻璃变量 ' + GLASS_FALLBACK + '，实际 = ' + JSON.stringify(winner.value) + '\n' + dump(cands)
  );
  // 复刻实机：负向态下 --detail 仍然在候选里，但被 !important 压住
  const ours = cands.find((c) => c.sel === DETAIL_SEL);
  assert.ok(ours, '--detail 规则须仍在候选清单中');
  assert.strictEqual(ours.important, false);
  assert.ok(ours.order < winner.order || cmpSpec(ours.spec, winner.spec) < 0 || !ours.important);
});

// ─────────────────────────────────────────────── 前向：防止后来者反超

test('前向守卫：不存在「特异度不低于本条、且排在更后面」的 !important 竞争者', () => {
  const cands = backgroundCandidates(indexCss, []);
  const ours = cands.find((c) => c.sel === DETAIL_SEL);
  assert.ok(ours, '--detail 规则须命中该元素');
  const later = cands.filter((c) =>
    c !== ours && c.important && c.order > ours.order && cmpSpec(c.spec, ours.spec) >= 0);
  assert.deepStrictEqual(
    later.map((c) => c.sel + ' @行' + c.line),
    [],
    '有声明会在本条之后反超（同为 !important、特异度 ≥ 本条、位置更靠后）：\n' + dump(later)
  );
});

test('前向守卫：本条必须已是「!important 组」里特异度最高 + 顺序最后的那条', () => {
  const cands = backgroundCandidates(indexCss, []);
  const importants = cands.filter((c) => c.important);
  const winner = importants[importants.length - 1];
  assert.strictEqual(winner.sel, DETAIL_SEL, '!important 组胜者应为 ' + DETAIL_SEL + '，实际 ' + winner.sel + '\n' + dump(cands));
});

test('依赖快照：html 上挂 control-glass-svg-ok 时结论不变（该开关不影响本元素）', () => {
  const off = backgroundCandidates(indexCss, []);
  const on = backgroundCandidates(indexCss, ['control-glass-svg-ok']);
  assert.strictEqual(off[off.length - 1].value, on[on.length - 1].value);
  assert.match(on[on.length - 1].value, /var\(--wc-ambient/);
});

// ─────────────────────────────────────────────── 结构约束

test('结构：--detail 规则体内不得出现花括号（注释须在规则块外，否则 [^}]* 提取会被截断）', () => {
  const idx = indexCss.indexOf(DETAIL_SEL);
  const open = indexCss.indexOf('{', idx);
  const body = indexCss.slice(open + 1, indexCss.indexOf('}', open));
  assert.doesNotMatch(body, /[{]/, '规则体内出现花括号 —— 会截断 /\\{([^}]*)\\}/ 提取');
});

test('结构：--detail 规则内每一条 background 都须带 !important，末条取环境色变量', () => {
  const bgLines = detailRuleBody()
    .split(';').map((s) => s.trim()).filter((s) => /^background(-color)?:/.test(s));
  assert.ok(bgLines.length >= 2, '须保留纯色回退行 + var(--wc-ambient) 行，实际 ' + bgLines.length + ' 条');
  bgLines.forEach((l) => assert.match(l, /!important$/, '每条 background 都须 !important：' + l));
  assert.match(bgLines[bgLines.length - 1], /var\(--wc-ambient/);
});

test('结构：--wc-ambient 须有纯色回退 + color-mix 两条定义（与 background 同款双行防御）', () => {
  const lines = detailRuleBody()
    .split(';').map((s) => s.trim()).filter((s) => /^--wc-ambient:/.test(s));
  assert.ok(lines.length >= 2, '--wc-ambient 须有纯色回退 + color-mix 两条定义，实际 ' + lines.length);
  assert.match(lines[lines.length - 1], /color-mix\(in srgb,\s*var\(--wc-warm/);
});
