/**
 * 验证 desktop/custom-source/runtime.js 构造函数修复
 *
 * Root cause: 构造函数用对象解构但内部写了 `this.config = options.config`,
 * `options` 在作用域里没声明 -> ReferenceError: options is not defined.
 *
 * Fix: 在解构模式里加 `config,` 字段; this.config = (config && typeof config === 'object') ? config : {}
 *
 * 修复启用后:
 *  - URL / TEXT 路径: importScript 走完整流程不再炸
 *  - bundled "青听音乐" 安装: 同路径, 之前也 ReferenceError, 同样受益
 *
 * 用例:
 *  1. config=undefined -> this.config === {}
 *  2. config={}        -> this.config === {}
 *  3. config={url,foo} -> 原对象身份保留 (非新建)
 *  4. config=null      -> this.config === {} (null falsy 走默认)
 *  5. 回归: manager 传的 backendUrl 必须被存到 this.config
 *  6. 反向: 源码不再含 options.config 引用, 解构模式里有 config
 */
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const runtimePath = path.join(__dirname, '..', 'desktop', 'custom-source', 'runtime.js');
let LxSourceRuntime;
let loadErr = null;
try {
  ({ LxSourceRuntime } = require(runtimePath));
} catch (e) {
  loadErr = e;
}

if (loadErr) {
  console.error('[FAIL] require runtime.js threw:', loadErr && loadErr.message || loadErr);
  console.error('  说明源码仍有 ReferenceError, 测试无法加载即表示 fix 失败.');
  process.exit(1);
}

const stubElectron = {
  app: { getPath: () => '/tmp/x' },
  BrowserWindow: null,
  ipcMain: {
    on() {}, handle() {},
    removeListener() {}, removeHandler() {},
  },
};
const stubBroker = { request: async () => ({ response: { statusCode: 200 }, body: null }) };

function makeRuntime(config) {
  return new LxSourceRuntime({
    script: 'console.log("test")',
    currentScriptInfo: { name: 'test', version: '0.0.0', author: 'tester' },
    electron: stubElectron,
    broker: stubBroker,
    config,
  });
}

let pass = 0;
let total = 0;
function ok(name, fn) {
  total += 1;
  try { fn(); console.log('  PASS  ' + name); pass += 1; }
  catch (e) { console.error('  FAIL  ' + name + ': ' + (e && e.message || e)); }
}

console.log('Running LxSourceRuntime config fix verification...');

ok('CASE 1: config=undefined -> this.config === {}', () => {
  const r = makeRuntime(undefined);
  assert.deepStrictEqual(r.config, {});
});

ok('CASE 2: config={} -> this.config === {}', () => {
  const r = makeRuntime({});
  assert.deepStrictEqual(r.config, {});
});

ok('CASE 3: config={url,foo} -> 原对象身份保留', () => {
  const cfg3 = { url: 'http://example.invalid/x', foo: 'bar' };
  const r = makeRuntime(cfg3);
  assert.strictEqual(r.config, cfg3, '应直接持有传入对象 (而不是 { ...cfg } 复制)');
  assert.strictEqual(r.config.url, 'http://example.invalid/x');
  assert.strictEqual(r.config.foo, 'bar');
});

ok('CASE 4: config=null -> this.config === {} (null falsy 走默认)', () => {
  const r = makeRuntime(null);
  assert.deepStrictEqual(r.config, {});
});

ok('CASE 5: 回归 - manager 传入的 backendUrl 必须被存到 this.config', () => {
  const cfg = { backendUrl: 'http://192.168.1.1:8080/music-server' };
  const r = makeRuntime(cfg);
  assert.ok(r.config, 'this.config 必须已定义 (修前的 bug 会让整行未执行即抛错)');
  assert.strictEqual(r.config.backendUrl, 'http://192.168.1.1:8080/music-server');
});

ok('CASE 6 (反向回归): 源码不再含 options.config 引用, 解构模式里有 config', () => {
  const src = fs.readFileSync(runtimePath, 'utf8');
  assert.ok(!/options\.config/.test(src), '代码不应再出现 options.config 引用');
  assert.ok(/\{\s*config\s*,/.test(src) || /,\s*config\s*,/.test(src), '解构模式中应有 config, 字段');
  assert.ok(/this\.config\s*=\s*(?:\(\s*config\s*&&|config\s*&&)/.test(src),
    'this.config 应基于 config 局部变量赋值');
});

console.log('\nResult: ' + pass + '/' + total + ' passed');
if (pass !== total) process.exit(1);
