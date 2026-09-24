'use strict';

/**
 * desktop/main.js Subsonic 配置 userData 迁移守卫测试
 * 运行：node tests/subsonic-config-userdata.test.js
 *
 * 验证两件事：
 * 1. configureLocalServerEnvironment 注入 STELLAFIX_SUBSONIC_CONFIG_FILE
 *    （指向 userData；历史遗漏——其余 9 个数据文件均已迁移，唯 subsonic 写安装目录）。
 * 2. migrateLegacyAuthStorage 内的 subsonic 迁移块行为正确：
 *    a) 旧配置存在+新配置不存在 → 复制到 userData 并删旧件
 *    b) 新旧都存在 → 不覆盖新件，仍删旧件
 *    c) 旧配置不存在 → 无操作不报错
 *
 * 迁移块从 main.js 源码中提取后在受控沙箱（临时目录+注入 fs/path/process/__dirname）
 * 真实执行——测的是产品代码文本本身，不是复刻逻辑。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');

function extractSubsonicMigrationBlock() {
  const start = mainText.indexOf('// Subsonic 配置迁移');
  assert.ok(start > 0, 'main.js 应包含 Subsonic 配置迁移块');
  const tryStart = mainText.lastIndexOf('try {', start);
  const endMarker = "console.warn('Subsonic config migration skipped:', e.message);";
  const end = mainText.indexOf(endMarker, start);
  assert.ok(end > 0, '迁移块应包含 catch 兜底');
  const blockEnd = mainText.indexOf('}', end + endMarker.length) + 1; // catch 块的收口 }
  return mainText.slice(tryStart, blockEnd);
}

function runMigrationInSandbox(installDir, userDataFile) {
  const block = extractSubsonicMigrationBlock();
  const sandboxProcess = { env: { STELLAFIX_SUBSONIC_CONFIG_FILE: userDataFile } };
  const fn = new Function('fs', 'path', 'process', '__dirname', block + `
    return { ok: true };
  `);
  return fn(fs, path, sandboxProcess, path.join(installDir, 'desktop'));
}

const OLD_CONFIG = JSON.stringify({
  version: 1,
  servers: [{ id: 'srv-legacy', name: '我的服务器', url: 'http://192.168.1.10:4040', username: 'demo' }],
});

test('main.js injects STELLAFIX_SUBSONIC_CONFIG_FILE into userData', () => {
  assert.match(
    mainText,
    /process\.env\.STELLAFIX_SUBSONIC_CONFIG_FILE = path\.join\(STABLE_USER_DATA_PATH, 'subsonic-servers\.json'\)/,
    'configureLocalServerEnvironment 必须把 subsonic 配置注入 userData'
  );
  // 注入必须发生在 require(server.js) 之前（server.js 顶层即加载 subsonic-api）
  const injectAt = mainText.indexOf('STELLAFIX_SUBSONIC_CONFIG_FILE =');
  const requireServerAt = mainText.indexOf('localServer = require(serverModulePath)');
  assert.ok(injectAt > 0 && requireServerAt > injectAt, '环境注入必须先于 server.js 加载');
});

test('migration: legacy config copied to userData, legacy file removed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-subsonic-mig-a-'));
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'subsonic-servers.json'), OLD_CONFIG);
    const target = path.join(root, 'user-data', 'subsonic-servers.json'); // userData 目录尚不存在

    runMigrationInSandbox(root, target);

    assert.ok(fs.existsSync(target), '迁移后 userData 下应存在配置文件');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), OLD_CONFIG, '内容应与旧配置逐字节一致');
    assert.ok(!fs.existsSync(path.join(root, 'data', 'subsonic-servers.json')), '旧文件应被删除');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration: existing userData config wins, legacy still cleaned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-subsonic-mig-b-'));
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'user-data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'subsonic-servers.json'), OLD_CONFIG);
    const target = path.join(root, 'user-data', 'subsonic-servers.json');
    const NEW_CONFIG = JSON.stringify({ version: 1, servers: [{ id: 'srv-new' }] });
    fs.writeFileSync(target, NEW_CONFIG);

    runMigrationInSandbox(root, target);

    assert.strictEqual(fs.readFileSync(target, 'utf8'), NEW_CONFIG, '已存在的新配置不得被旧配置覆盖');
    assert.ok(!fs.existsSync(path.join(root, 'data', 'subsonic-servers.json')), '旧文件仍应被清理');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration: no legacy file is a no-op without errors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-subsonic-mig-c-'));
  try {
    const target = path.join(root, 'user-data', 'subsonic-servers.json');
    const r = runMigrationInSandbox(root, target); // 不应抛错
    assert.ok(r.ok);
    assert.ok(!fs.existsSync(target), '不应凭空造出新文件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
