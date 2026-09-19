'use strict';

/**
 * index-loader try 块内 async function 的 window 暴露测试
 * 背景（12-expose-inline-globals.js 头注，2026-09-12 实测结论）：
 *   index-loader.js 把模块源码拼进外层 try{} 块执行。sloppy mode 下 Annex B.3.3
 *   只让普通 function 声明泄漏到全局，async function 声明是纯块级绑定。
 *   agent-adapter.js / agent-music-tools.js 是独立 <script>，只能经 window 访问
 *   playQueueAt；若 12-expose-inline-globals.js 不显式补挂，AI 助手委托主通道会报
 *   PLAYER_NOT_READY。
 * 运行：node --test tests/playqueueat-global-exposure.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.join(__dirname, '..');
const exposePath = path.join(appRoot, 'public', 'js', 'modules', '12-expose-inline-globals.js');
const exposeSource = fs.readFileSync(exposePath, 'utf8');

function makeLoaderSandbox() {
  const sandbox = { console: { log() {}, warn() {}, error() {} }, JSON, Math, Date, String, Number, Array, Object, Boolean, Promise, setTimeout };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

// 复刻 index-loader 的注入结构：整个模块源码放进一个外层 try 块（sloppy mode）
function runInTryBlock(sandbox, declaredFns) {
  const body =
    'try {\n' +
    '  function plainLeakingFn() { return "plain"; }\n' +
    '  async function playQueueAt() { return "played"; }\n' +
    '  async function anotherAsyncFn() { return "other"; }\n' +
    '  ' + (declaredFns || '') + '\n' +
    '  ' + exposeSource.replace(/\n/g, '\n  ') + '\n' +
    '} catch (e) {}\n';
  vm.runInContext(body, sandbox, { filename: 'stellaflix-index-modules.js' });
}

test('harness models index-loader semantics: plain function leaks, async does not', () => {
  const sb = makeLoaderSandbox();
  runInTryBlock(sb, '');
  assert.strictEqual(typeof sb.plainLeakingFn, 'function', 'sanity: sloppy-mode plain fn must leak (Annex B.3.3)');
  assert.strictEqual(sb.anotherAsyncFn, undefined, 'sanity: async fn must NOT leak on its own');
});

test('12-expose-inline-globals must expose playQueueAt on window for external scripts', () => {
  const sb = makeLoaderSandbox();
  runInTryBlock(sb, '');
  assert.strictEqual(typeof sb.window.playQueueAt, 'function',
    'agent-adapter/agent-music-tools (separate <script>) reach playQueueAt only via window');
  assert.strictEqual(typeof sb.playQueueAt, 'function');
});

test('exposed playQueueAt is the real try-block function, not a stub', async () => {
  const sb = makeLoaderSandbox();
  runInTryBlock(sb, '');
  assert.strictEqual(await sb.window.playQueueAt(0, {}), 'played');
});
