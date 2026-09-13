// 方案 A 回归：解析后端地址可配置（全局单个，用户自填）
//
// 验证：
//   1. backend-config 模块读写/校验（无效 URL 抛错、空白回退默认、损坏 JSON 容错）
//   2. CustomSourceManager 透传 config 到运行时（激活 / 保存后重启都拿到最新 backendUrl）
//   3. 内置脚本优先使用 lx.config.backendUrl，否则回退内置默认

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { CustomSourceManager } = require('../desktop/custom-source/manager');
const { readBackendConfig, writeBackendConfig, isValidUrl } = require('../desktop/custom-source/backend-config');
const BUNDLED = path.join(__dirname, '..', 'desktop', 'custom-source', 'bundled', 'qing_music.js');
const DEFAULT_URL = 'https://musicserver.haitangw.cc/v1/music/resolve-url';

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('  PASS  ' + label + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; console.log('  FAIL  ' + label + (detail ? '  (' + detail + ')' : '')); }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-backend-'));
}

function loadScript(configOverride) {
  const code = fs.readFileSync(BUNDLED, 'utf8');
  let handler = null;
  const calls = [];
  const lx = {
    EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
    config: configOverride || {},
    request(url, options, callback) {
      calls.push({ url, options });
      callback(null, { statusCode: 200 }, { code: 0, data: { url: 'https://cdn.example.invalid/track.m4a' } });
      return () => {};
    },
    on(eventName, fn) { if (eventName === 'request') handler = fn; return Promise.resolve(); },
    send() { return Promise.resolve(); },
    env: 'desktop',
    version: '2.0.0',
  };
  const sandbox = { lx, JSON, Promise, Error, String, Number, Object, Array, console, URL, setTimeout };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { handler, calls };
}

async function main() {
  // ---------------- 1. backend-config 模块 ----------------
  console.log('=== 1. backend-config 模块读写 / 校验 ===');
  {
    const dir = makeTempDir();
    check('无效 URL 判定', isValidUrl('ftp://x') === false && isValidUrl('https://a.b/c') === true);
    check('缺文件返回 { backendUrl: "" }', readBackendConfig(dir).backendUrl === '');
    const written = writeBackendConfig(dir, { backendUrl: '  https://user.example/v1/music/resolve-url  ' });
    check('写入并去除首尾空白', written.backendUrl === 'https://user.example/v1/music/resolve-url', written.backendUrl);
    check('回读一致', readBackendConfig(dir).backendUrl === 'https://user.example/v1/music/resolve-url');
    let threw = false;
    try { writeBackendConfig(dir, { backendUrl: 'not-a-url' }); } catch (e) { threw = /INVALID_BACKEND_URL/.test(String(e && e.message || e)); }
    check('非法 URL 抛 INVALID_BACKEND_URL', threw);
    fs.writeFileSync(path.join(dir, 'custom-source-backend.json'), '{ bad json');
    check('损坏 JSON 容错为默认', readBackendConfig(dir).backendUrl === '');
  }

  // ---------------- 2. manager 透传 config ----------------
  console.log('\n=== 2. CustomSourceManager 透传 config 到运行时 ===');
  {
    const dir = makeTempDir();
    let lastOptions = null;
    const fakeRuntime = () => ({
      start: () => Promise.resolve({ sources: {} }),
      stop: () => Promise.resolve(),
    });
    const manager = new CustomSourceManager({
      userDataPath: dir,
      runtimeFactory: (options) => { lastOptions = options; return fakeRuntime(); },
    });

    check('默认 backendUrl 为空', manager.getBackendConfig().backendUrl === '');

    const sample = 'https://my.musicserver.example/v1/music/resolve-url';
    const saved = manager.setBackendConfig({ backendUrl: sample });
    check('setBackendConfig 返回保存值', saved.backendUrl === sample, saved.backendUrl);
    check('持久化文件可读回', readBackendConfig(dir).backendUrl === sample);

    const bundled = fs.readFileSync(BUNDLED, 'utf8');
    const imported = await manager.importScript(bundled, 'qing_music.js');
    const id = imported && imported.id;
    check('导入内置脚本成功', !!id, String(id));
    await manager.activate(id);
    check('激活时运行时 config.backendUrl 已注入', !!(lastOptions && lastOptions.config && lastOptions.config.backendUrl === sample),
      lastOptions && lastOptions.config && lastOptions.config.backendUrl);

    const sample2 = 'https://another.musicserver.example/v2/resolve';
    manager.setBackendConfig({ backendUrl: sample2 });
    await new Promise((r) => setTimeout(r, 50));
    check('保存新地址后重启运行时加载新 config', !!(lastOptions && lastOptions.config && lastOptions.config.backendUrl === sample2),
      lastOptions && lastOptions.config && lastOptions.config.backendUrl);

    let threw2 = false;
    try { manager.setBackendConfig({ backendUrl: 'javascript:alert(1)' }); } catch (e) { threw2 = /INVALID_BACKEND_URL/.test(String(e && e.message || e)); }
    check('manager 拒绝非法后端 URL', threw2);

    await manager.deactivate();
  }

  // ---------------- 3. 脚本优先使用 config.backendUrl ----------------
  console.log('\n=== 3. 内置脚本优先 config.backendUrl，否则回退默认 ===');
  {
    const { handler: h0, calls: c0 } = loadScript();
    await h0({ action: 'musicUrl', source: 'tx', info: { type: 'flac', musicInfo: { source: 'tx', songmid: '004Z8Ihr0JIu5s', name: 't', singer: 's' } } });
    check('无 config 时回退内置默认 URL', c0.length && c0[0].url === DEFAULT_URL, c0[0] && c0[0].url);

    const cfgUrl = 'https://cfg.musicserver.example/v1/music/resolve-url';
    const { handler: h1, calls: c1 } = loadScript({ backendUrl: cfgUrl });
    await h1({ action: 'musicUrl', source: 'tx', info: { type: 'flac', musicInfo: { source: 'tx', songmid: '004Z8Ihr0JIu5s', name: 't', singer: 's' } } });
    check('有 config.backendUrl 时优先使用', c1.length && c1[0].url === cfgUrl, c1[0] && c1[0].url);
  }
}

main().then(() => {
  console.log('\n----------------------------------------');
  console.log('PASS ' + passed + ' / FAIL ' + failed);
  if (failed > 0) process.exit(1);
  console.log('全部通过');
}).catch((e) => {
  console.error('测试运行异常:', e);
  process.exit(1);
});
