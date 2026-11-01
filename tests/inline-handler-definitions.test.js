'use strict';

/**
 * tests/inline-handler-definitions.test.js — 内联回调必须有定义
 *
 * 覆盖什么：index.html 里所有 on*="..." 内联处理器引用的**裸函数调用**，
 * 在当前加载的模块里必须存在定义。
 *
 * 为什么需要（11-01 实锤）：T16d 整份删除 08-account/01-login-modal-utils.js 时，
 * 把 closeUserModal 一起删了，但 index.html 的「本地档案」弹窗关闭钮
 * 仍写着 onclick="closeUserModal()"（07-fx、10-shell 也在调）。
 * 结果：弹窗能打开、关不掉，点关闭抛 ReferenceError。
 * 当时的契约测试用 /closeUserModal|openGsapModal/ 的「或」写法，被 profile 里的
 * openGsapModal 命中而假绿——所以这里改为逐个符号独立判定。
 *
 * 判定口径：
 *   · 只认裸调用标识符：排除 obj.method() / window.a.b() 这类方法链（正则左侧不吃 . 和 $）
 *   · 排除 *_1.js 历史快照（.gitignore 的副本，加载器从不引用）
 *   · 定义形态：function x( / var|let|const x = function|( / window.x =
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(APP_ROOT, 'public', 'index.html');

const BUILTIN = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'function', 'new',
  'document', 'window', 'this', 'event', 'Array', 'Object', 'String', 'Number', 'Boolean', 'parseInt']);

function inlineHandlerCalls() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const calls = new Set();
  const attr = /on(?:click|change|input|mousedown|mouseup|keydown|keyup|blur|focus|submit|load)="([^"]*)"/g;
  let a;
  while ((a = attr.exec(html))) {
    const expr = a[1];
    // 左侧不允许 . 或标识符字符 ⇒ 排除 obj.method() 一类
    const call = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
    let c;
    while ((c = call.exec(expr))) {
      if (!BUILTIN.has(c[1])) calls.add(c[1]);
    }
  }
  return calls;
}

function liveModuleTexts() {
  const roots = [path.join(APP_ROOT, 'public', 'js', 'modules'), path.join(APP_ROOT, 'public', 'video')];
  const out = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'bundles' && e.name !== 'node_modules') walk(p);
      } else if (e.name.endsWith('.js') && !/_1\.js$/.test(e.name)) {
        out.push({ p, t: fs.readFileSync(p, 'utf8') });
      }
    }
  }
  roots.forEach(walk);
  return out;
}

function hasDefinition(texts, fn) {
  const name = fn.replace(/\$/g, '\\$');
  const re = new RegExp(
    '(?:function|var|let|const)\\s+' + name + '\\s*\\(|' +
    '(?:var|let|const)\\s+' + name + '\\s*=\\s*(?:function|\\()|' +
    '(?:window|global|self|globalThis)\\.' + name + '\\s*='
  );
  return texts.some((s) => re.test(s.t));
}

test('index.html 内联回调：每个裸函数调用在活模块里都有定义', () => {
  const calls = inlineHandlerCalls();
  assert.ok(calls.size > 50, '应能从 index.html 提取到足量内联回调（当前 ' + calls.size + '）');
  const texts = liveModuleTexts();
  const missing = [...calls].filter((fn) => !hasDefinition(texts, fn)).sort();
  assert.deepStrictEqual(missing, [], '以下内联回调在活模块中找不到定义（点了就抛 ReferenceError）: ' + missing.join(', '));
});

test('反证：已退役的 closeUserModal 必须有人接手（防再次整族误删）', () => {
  const texts = liveModuleTexts();
  assert.ok(hasDefinition(texts, 'closeUserModal'),
    'closeUserModal 必须由某个活模块提供——它是「本地档案」弹窗的关闭入口（index.html 内联 onclick + 07-fx + 10-shell 三处调用）');
  assert.ok(!texts.some((s) => /_1\.js$/.test(s.p) && /function closeUserModal/.test(s.t)),
    '定义不得只存在于 *_1.js 历史快照里（那些文件不加载）');
});
