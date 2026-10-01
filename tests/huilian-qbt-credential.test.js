'use strict';
/** 运行：node --test tests/huilian-qbt-credential.test.js */
const test = require('node:test');
const assert = require('node:assert');
const dm = require('../desktop/download-manager');

test('已有存储 → 不 login 不 setPassword', async () => {
  let calls = [];
  const cred = await dm.ensureCredential({
    stored: { username: 'admin', password: 'old' },
    login: () => { calls.push('login'); return Promise.resolve(true); },
    setPassword: () => { calls.push('set'); return Promise.resolve(true); },
    saveCred: () => calls.push('save'),
    genPw: () => 'newpw',
  });
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(cred, { username: 'admin', password: 'old' });
});
test('首启 → 默认口令 login，setPassword 随机并落盘', async () => {
  let calls = [];
  const cred = await dm.ensureCredential({
    stored: null,
    login: (u, p) => { calls.push(['login', u, p]); return Promise.resolve(true); },
    setPassword: (newPw) => { calls.push(['set', newPw]); return Promise.resolve(true); },
    saveCred: (c) => calls.push(['save', c]),
    genPw: () => 'R'.repeat(32),
    defaults: { username: 'admin', password: 'adminadmin' },
  });
  assert.deepStrictEqual(calls[0], ['login', 'admin', 'adminadmin']);
  assert.deepStrictEqual(calls[1], ['set', 'R'.repeat(32)]);
  assert.deepStrictEqual(calls[2], ['save', { username: 'admin', password: 'R'.repeat(32) }]);
  assert.strictEqual(cred.password, 'R'.repeat(32));
});
test('login 失败 → reject 且不落盘', async () => {
  let saved = 0;
  await assert.rejects(dm.ensureCredential({
    stored: null, login: () => Promise.reject(new Error('403')),
    setPassword: () => Promise.resolve(true), saveCred: () => saved++, genPw: () => 'x',
    defaults: { username: 'admin', password: 'adminadmin' },
  }));
  assert.strictEqual(saved, 0);
});

// ---- 以下为补充契约断言（不改变上面三条 brief 测试）----

// 失败序约定：setPassword 失败与 login 失败同理 —— 口令未改成，绝不能把新口令落盘
test('setPassword 失败 → reject 且不落盘', async () => {
  let saved = 0;
  let setCalled = 0;
  await assert.rejects(dm.ensureCredential({
    stored: null,
    login: () => Promise.resolve(true),
    setPassword: () => { setCalled++; return Promise.reject(new Error('500')); },
    saveCred: () => saved++, genPw: () => 'x'.repeat(32),
    defaults: { username: 'admin', password: 'adminadmin' },
  }));
  assert.strictEqual(setCalled, 1);
  assert.strictEqual(saved, 0);
});

// ---- 真实适配器（desktop/qbt-credential.js）：headless 可测部分 ----
const fs = require('fs');
const os = require('os');
const path = require('path');
const qc = require('../desktop/qbt-credential');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sfv-qbt-cred-'));
}

test('genPw = 32 位十六进制随机串，两次不同', () => {
  const a = qc.genPw();
  const b = qc.genPw();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notStrictEqual(a, b);
});

test('credStorePath：优先取 video-config qbt.credStorePath，缺省兜底同名文件', () => {
  assert.strictEqual(qc.resolveCredStorePath({ credStorePath: 'D:/x/huilian-qbt-cred.json' }), 'D:/x/huilian-qbt-cred.json');
  const fallback = qc.resolveCredStorePath({});
  assert.ok(fallback.endsWith(path.join('', 'huilian-qbt-cred.json')), '兜底文件名固定：' + fallback);
});

test('credStorePath 由 video-config 解析 __appData__ 占位符', () => {
  const vc = require('../desktop/video-config');
  const cfg = vc.init({ appData: 'X:\\AppData' });
  assert.ok(cfg.qbt.credStorePath, 'qbt 节须含 credStorePath');
  assert.ok(cfg.qbt.credStorePath.indexOf('huilian-qbt-cred.json') !== -1);
  assert.ok(/appdata/i.test(cfg.qbt.credStorePath), '__appData__ 应被替换：' + cfg.qbt.credStorePath);
});

test('saveCred/loadCred 往返；loadCred 对缺失或损坏文件返回 null', () => {
  const dir = mkTmpDir();
  const p = path.join(dir, 'sub', 'huilian-qbt-cred.json');
  assert.strictEqual(qc.loadCred(p), null);
  qc.saveCred(p, { username: 'admin', password: 'p@ss' });
  assert.deepStrictEqual(qc.loadCred(p), { username: 'admin', password: 'p@ss' });
  fs.writeFileSync(p, '{损坏的 json');
  assert.strictEqual(qc.loadCred(p), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会话：takeSession 从 set-cookie 提取 SID/qbt_response_sid；非 GET 带 CSRF 头', () => {
  qc.resetSession();
  assert.deepStrictEqual(qc.sessionHeaders('POST'), {});
  qc.takeSession(['SID=abc123; path=/; HttpOnly', 'qbt_response_sid=csrf1; SameSite=None']);
  assert.deepStrictEqual(qc.sessionHeaders('GET'), { Cookie: 'SID=abc123' });
  const h = qc.sessionHeaders('POST');
  assert.strictEqual(h.Cookie, 'SID=abc123');
  // qbt 4.6.1+ CSRF 防护：X-CSRF-Token 值 = qbt_response_sid cookie 的值（非整段 name=value）
  assert.strictEqual(h['X-CSRF-Token'], 'csrf1');
  qc.resetSession();
});

test('ensureReal 首启：默认口令仅一次登录，setPassword 后会话回放且覆写 config.qbt', async () => {
  qc.resetSession();
  const dir = mkTmpDir();
  const store = path.join(dir, 'huilian-qbt-cred.json');
  // 假 http：模拟 qbt WebAPI —— login 成功时下发 SID/qbt_response_sid cookie
  const http = (method, pathname, body) => {
    const form = String(body || '');
    if (pathname === '/api/v2/auth/login') {
      if (form === 'username=admin&password=adminadmin') {
        return Promise.resolve({ status: 200, body: 'Ok.', headers: { 'set-cookie': ['SID=sid1; path=/', 'qbt_response_sid=csrf1; SameSite=None'] } });
      }
      return Promise.resolve({ status: 200, body: 'Fails.' });
    }
    if (pathname === '/api/v2/app/setPassword') {
      return Promise.resolve({ status: 200, body: '' });
    }
    return Promise.resolve({ status: 404, body: 'Not Found' });
  };
  // 记录每个请求实际携带的 Cookie / X-CSRF-Token，验证会话在改密请求上回放
  const sessionLog = [];
  const wrappedHttp = (method, pathname, body) => {
    sessionLog.push({ method, pathname, body: String(body || ''), session: qc.sessionHeaders(method) });
    return http(method, pathname, body);
  };
  const config = { qbt: { username: 'admin', password: 'adminadmin', credStorePath: store } };
  const cred = await qc.ensureReal({ config, http: wrappedHttp, ensureCredential: dm.ensureCredential });
  assert.match(cred.password, /^[0-9a-f]{32}$/, '默认 genPw 走 crypto.randomBytes(16)');
  // 调用序：login(默认口令) → setPassword(新口令)
  assert.strictEqual(sessionLog[0].pathname, '/api/v2/auth/login');
  assert.strictEqual(sessionLog[0].body, 'username=admin&password=adminadmin');
  assert.strictEqual(sessionLog[1].pathname, '/api/v2/app/setPassword');
  assert.strictEqual(sessionLog[1].body, 'username=admin&password=' + cred.password);
  // 关键：setPassword 请求带上了 login 拿到的 SID 会话与 CSRF token（Basic 旧口令在改密后不再可用）
  assert.strictEqual(sessionLog[1].session.Cookie, 'SID=sid1');
  assert.strictEqual(sessionLog[1].session['X-CSRF-Token'], 'csrf1');
  // 成功后覆写 _config.qbt 且落盘，供后续 _http Basic 认证使用
  assert.strictEqual(config.qbt.password, cred.password);
  assert.deepStrictEqual(qc.loadCred(store), { username: 'admin', password: cred.password });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureReal 改密失败 → reject、不落盘、口令不泄漏到错误消息', async () => {
  qc.resetSession();
  const dir = mkTmpDir();
  const store = path.join(dir, 'huilian-qbt-cred.json');
  const http = (method, pathname, body) => {
    if (pathname === '/api/v2/auth/login') {
      return Promise.resolve({ status: 200, body: 'Ok.', headers: { 'set-cookie': ['SID=sid2; path=/'] } });
    }
    // setPassword 返回 403：随机口令未生效，绝不允许写进 cred store
    return Promise.resolve({ status: 403, body: 'Forbidden' });
  };
  const config = { qbt: { username: 'admin', password: 'adminadmin', credStorePath: store } };
  let err;
  try { await qc.ensureReal({ config, http, ensureCredential: dm.ensureCredential }); }
  catch (e) { err = e; }
  assert.ok(err, 'setPassword 403 必须 reject');
  assert.ok(!/[0-9a-f]{32}/.test(err.message), '错误消息不得含 32 位随机口令：' + err.message);
  assert.ok(!err.message.includes('adminadmin'), '错误消息不得含默认口令');
  assert.strictEqual(qc.loadCred(store), null, '失败不得落盘');
  assert.strictEqual(fs.existsSync(store), false);
  assert.strictEqual(config.qbt.password, 'adminadmin', '失败不覆写运行配置');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureReal：改密成功但落盘失败 → reject，但运行配置已切到新口令（不会继续用旧口令认证）', async () => {
  qc.resetSession();
  const dir = mkTmpDir();
  const store = path.join(dir, 'huilian-qbt-cred.json');
  fs.mkdirSync(store); // 让 storePath 本身是目录 → writeFileSync 抛 EISDIR
  const http = (method, pathname) => {
    if (pathname === '/api/v2/auth/login') return Promise.resolve({ status: 200, body: 'Ok.' });
    if (pathname === '/api/v2/app/setPassword') return Promise.resolve({ status: 200, body: '' });
    return Promise.resolve({ status: 404, body: 'Not Found' });
  };
  const config = { qbt: { username: 'admin', password: 'adminadmin', credStorePath: store } };
  await assert.rejects(() => qc.ensureReal({ config, http, ensureCredential: dm.ensureCredential }));
  assert.strictEqual(qc.loadCred(store), null, '目录路径读不出凭据，视为无存储');
  assert.match(config.qbt.password, /^[0-9a-f]{32}$/, '改密已生效，运行配置必须用新口令而非旧默认');
  assert.notStrictEqual(config.qbt.password, 'adminadmin');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureReal 二启：stored 命中 → 零 HTTP 调用，直接用落盘口令', async () => {
  qc.resetSession();
  const dir = mkTmpDir();
  const store = path.join(dir, 'huilian-qbt-cred.json');
  qc.saveCred(store, { username: 'admin', password: 'savedpw' });
  let called = 0;
  const http = () => { called++; return Promise.resolve({ status: 200, body: '' }); };
  const config = { qbt: { username: 'admin', password: 'adminadmin', credStorePath: store } };
  const cred = await qc.ensureReal({ config, http, ensureCredential: dm.ensureCredential });
  assert.deepStrictEqual(cred, { username: 'admin', password: 'savedpw' });
  assert.strictEqual(called, 0);
  assert.strictEqual(config.qbt.password, 'savedpw', 'stored 口令须覆写回 _config.qbt');
  fs.rmSync(dir, { recursive: true, force: true });
});
