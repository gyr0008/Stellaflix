'use strict';

/**
 * tests/stale-login-credential-purge.test.js — 任务 16e
 *
 * 公开分发口径：LX 世界观不持有平台 cookie。旧版本用户磁盘上可能残留
 * .cookie / .qq-cookie / .kugou-cookie / .qishui-* / .spotify-* 等明文凭证，
 * 升级后必须一次性清掉，且不能把旧凭证再抄进新的稳定目录。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const purgeModule = require('../desktop/stale-login-credential-purge.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-sfpurge-'));
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text || 'secret');
}

test('清单一：模块导出全部平台凭证文件名', () => {
  const names = purgeModule.STALE_LOGIN_CREDENTIAL_FILES;
  for (const expected of [
    '.cookie', '.qq-cookie', '.kugou-cookie', '.qishui-cookie', '.qishui-token',
    '.qishui-oauth.json', '.qishui-qr-identity.json', '.qishui-qr-login.json',
    '.spotify-token.json', '.spotify-credentials.json',
    '.kugou-vip-evidence.json',
  ]) {
    assert.ok(names.includes(expected), '凭证清单缺少 ' + expected);
  }
  assert.ok(!names.includes('current-fx-autosave.json'), '非凭证文件不得进清单');
});

test('一次性清理：多目录凭证全删、非凭证保留、写标记', () => {
  const base = makeTempDir();
  const stable = path.join(base, 'stable');
  const legacy = path.join(base, 'legacy');
  const markerFile = path.join(stable, '.stale-login-purge.json');
  write(path.join(stable, '.cookie'), 'netease');
  write(path.join(stable, '.qq-cookie'), 'qq');
  write(path.join(legacy, '.spotify-token.json'), '{"access_token":"x"}');
  write(path.join(legacy, '.qishui-qr-login.json'), '{"uid":"x"}');
  write(path.join(stable, 'cuefield-feedback.jsonl'), '{"a":1}\n');
  write(path.join(stable, 'current-fx-autosave.json'), '{}');

  const result = purgeModule.purgeStaleLoginCredentials({
    dirs: [stable, legacy],
    markerFile,
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false, '首次必须真正执行');
  assert.deepEqual(result.removed.slice().sort(), [
    '.cookie', '.qishui-qr-login.json', '.qq-cookie', '.spotify-token.json',
  ]);
  assert.equal(fs.existsSync(path.join(stable, '.cookie')), false);
  assert.equal(fs.existsSync(path.join(stable, '.qq-cookie')), false);
  assert.equal(fs.existsSync(path.join(legacy, '.spotify-token.json')), false);
  assert.equal(fs.existsSync(path.join(legacy, '.qishui-qr-login.json')), false);
  assert.ok(fs.existsSync(path.join(stable, 'cuefield-feedback.jsonl')), '非凭证文件必须保留');
  assert.ok(fs.existsSync(path.join(stable, 'current-fx-autosave.json')), '非凭证文件必须保留');
  assert.ok(fs.existsSync(markerFile), '清理后必须落标记');
});

test('二次启动：有标记即跳过，不碰新出现的凭证文件', () => {
  const base = makeTempDir();
  const stable = path.join(base, 'stable');
  const markerFile = path.join(stable, '.stale-login-purge.json');
  purgeModule.purgeStaleLoginCredentials({ dirs: [stable], markerFile });
  write(path.join(stable, '.cookie'), 'reappeared');

  const again = purgeModule.purgeStaleLoginCredentials({ dirs: [stable], markerFile });
  assert.equal(again.skipped, true);
  assert.deepEqual(again.removed, []);
  assert.ok(fs.existsSync(path.join(stable, '.cookie')), '一次性语义：有标记不再清');
});

test('force：显式用户动作无视标记再清一次', () => {
  const base = makeTempDir();
  const stable = path.join(base, 'stable');
  const markerFile = path.join(stable, '.stale-login-purge.json');
  purgeModule.purgeStaleLoginCredentials({ dirs: [stable], markerFile });
  write(path.join(stable, '.qishui-token'), 'token');

  const forced = purgeModule.purgeStaleLoginCredentials({ dirs: [stable], markerFile, force: true });
  assert.equal(forced.skipped, false);
  assert.deepEqual(forced.removed, ['.qishui-token']);
  assert.equal(fs.existsSync(path.join(stable, '.qishui-token')), false);
});

test('容错：目录不存在/不可读不抛错，仍写标记', () => {
  const base = makeTempDir();
  const markerFile = path.join(base, 'stable', '.stale-login-purge.json');
  const result = purgeModule.purgeStaleLoginCredentials({
    dirs: [path.join(base, 'nope'), path.join(base, 'stable')],
    markerFile,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, []);
  assert.ok(fs.existsSync(markerFile));
});

test('主进程接线：启动链调用一次性清理，且不再把平台凭证抄进稳定目录', () => {
  const main = read('desktop/main.js');
  assert.match(main, /require\(['"]\.\/stale-login-credential-purge(?:\.js)?['"]\)/, 'main 必须引用清理模块');
  assert.match(main, /purgeStaleLoginCredentials\(/, 'main 必须调用清理');
  assert.match(main, /migrateLegacyAuthStorage\(\);[\s\S]{0,1600}purgeStaleLoginCredentials\(/,
    '清理须挂在启动迁移链内');
  for (const deadCopy of ['legacyNeteaseCookie', 'legacyQQCookie', 'legacyKugouCookie',
    'legacyQishuiCookie', 'legacyQishuiToken', 'legacyQishuiOAuth', 'legacySpotifyToken',
    'legacySpotifyConfig']) {
    assert.ok(!main.includes(deadCopy), '不得再把旧平台凭证抄进稳定目录: ' + deadCopy);
  }
});

test('server 清理钩子覆盖 token/config/QR 凭证（不再只删 4 个 cookie）', () => {
  const server = read('server.js');
  for (const name of ['QISHUI_TOKEN_FILE', 'QISHUI_OAUTH_CONFIG_FILE',
    'SPOTIFY_TOKEN_FILE', 'SPOTIFY_CONFIG_FILE', '.qishui-qr-login.json']) {
    assert.ok(server.includes(name), 'server 清理清单缺少 ' + name);
  }
});

test('打包白名单不再列已不存在的 qishui-audio-decryptor', () => {
  const pkg = JSON.parse(read('package.json'));
  const files = pkg.build.files;
  assert.ok(!files.some((f) => String(f).includes('qishui-audio-decryptor')),
    '目录已不存在（git ls-files=0），白名单须摘除');
});

test('显式清理入口复用 purge(force)：登录态清除不依赖一次性标记', () => {
  const { namedFunctionSource } = require('./helpers/extract-fn');
  const fn = namedFunctionSource(read('desktop/main.js'), 'clearAllProviderLoginState');
  assert.match(fn, /purgeStaleLoginCredentials\(/, '显式清理必须复用同一清单');
  assert.match(fn, /force:\s*true/, '显式清理必须无视一次性标记');
});
