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
const httpMod = require('http');
const qc = require('../desktop/qbt-credential');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sfv-qbt-cred-'));
}

// 用 stub 的 http.request 驱动「真实 _http」，验证生产捕获+复放链路（I2：非注入 wrappedHttp）
// handler(opts) 返回 { statusCode?, cookies?, body? }；记录每次请求的 opts（含 headers）到 reqs
function stubHttp(handler) {
  const orig = httpMod.request;
  const reqs = [];
  httpMod.request = (opts, cb) => {
    reqs.push(opts);
    const handlers = {};
    const spec = handler(opts) || {};
    const res = {
      statusCode: spec.statusCode == null ? 200 : spec.statusCode,
      headers: spec.cookies ? { 'set-cookie': spec.cookies } : {},
      on(ev, fn) { handlers[ev] = fn; return this; },
    };
    setImmediate(() => {
      cb(res);
      setImmediate(() => {
        if (handlers.data) handlers.data(spec.body == null ? 'Ok.' : spec.body);
        if (handlers.end) handlers.end();
      });
    });
    return { on() { return this; }, setTimeout() { return this; }, write() {}, end() {} };
  };
  return { reqs, restore() { httpMod.request = orig; } };
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

// I1：双提交 CSRF 需整体复放 cookie jar（含 qbt_response_sid），而非只带 SID
test('会话：takeSession 捕获完整 cookie jar；非 GET 带 CSRF，GET 不带', () => {
  qc.resetSession();
  assert.deepStrictEqual(qc.sessionHeaders('POST'), {});
  qc.takeSession(['SID=abc123; path=/; HttpOnly', 'qbt_response_sid=csrf1; SameSite=None']);
  const gh = qc.sessionHeaders('GET');
  const gck = String(gh.Cookie || '').split('; ');
  assert.ok(gck.includes('SID=abc123'), 'GET 复放含 SID：' + gh.Cookie);
  assert.ok(gck.includes('qbt_response_sid=csrf1'), 'GET 复放含 qbt_response_sid（完整 jar）：' + gh.Cookie);
  assert.ok(!('X-CSRF-Token' in gh), 'GET 不参与 CSRF 校验');
  const ph = qc.sessionHeaders('POST');
  const pck = String(ph.Cookie || '').split('; ');
  assert.ok(pck.includes('SID=abc123') && pck.includes('qbt_response_sid=csrf1'), 'POST 复放完整 jar：' + ph.Cookie);
  // qbt 4.6.1+ CSRF 防护：X-CSRF-Token 值 = qbt_response_sid cookie 的值（非整段 name=value）
  assert.strictEqual(ph['X-CSRF-Token'], 'csrf1');
  qc.resetSession();
  assert.deepStrictEqual(qc.sessionHeaders('POST'), {}, 'resetSession 应清空 jar');
});

test('ensureReal 首启：默认口令仅一次登录，改密请求经 http 层捕获的会话回放且覆写 config.qbt', async () => {
  qc.resetSession();
  const dir = mkTmpDir();
  const store = path.join(dir, 'huilian-qbt-cred.json');
  // 假 http：模拟 qbt WebAPI —— login 成功时下发 SID/qbt_response_sid cookie
  const base = (method, pathname, body) => {
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
  // 注入 http 忠实模拟真实 _http：set-cookie 捕获归 http 层（I2：loginWith 不再重复捕获）
  const wrappedHttp = (method, pathname, body) => {
    sessionLog.push({ method, pathname, body: String(body || ''), session: qc.sessionHeaders(method) });
    return Promise.resolve(base(method, pathname, body)).then(r => { qc.takeSession(r.headers && r.headers['set-cookie']); return r; });
  };
  const config = { qbt: { username: 'admin', password: 'adminadmin', credStorePath: store } };
  const cred = await qc.ensureReal({ config, http: wrappedHttp, ensureCredential: dm.ensureCredential });
  assert.match(cred.password, /^[0-9a-f]{32}$/, '默认 genPw 走 crypto.randomBytes(16)');
  // 调用序：login(默认口令) → setPassword(新口令)
  assert.strictEqual(sessionLog[0].pathname, '/api/v2/auth/login');
  assert.strictEqual(sessionLog[0].body, 'username=admin&password=adminadmin');
  assert.strictEqual(sessionLog[1].pathname, '/api/v2/app/setPassword');
  assert.strictEqual(sessionLog[1].body, 'username=admin&password=' + cred.password);
  // 关键：setPassword 请求带上了 login 拿到的完整会话 jar 与 CSRF token（Basic 旧口令在改密后不再可用）
  const sc = String(sessionLog[1].session.Cookie || '').split('; ');
  assert.ok(sc.includes('SID=sid1') && sc.includes('qbt_response_sid=csrf1'), '改密请求带完整 jar：' + sessionLog[1].session.Cookie);
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

// ---- 复审修正新增覆盖（I1~I4 / M2）----

// I2：驱动「真实 _http」（stub http.request，非注入 wrappedHttp），证明生产捕获+复放链路
test('真实 _http：login set-cookie 被捕获；非 GET 复放完整 cookie jar+CSRF，GET 无 CSRF，复位后清空', async () => {
  qc.resetSession();
  dm.setConfig({ qbt: { port: 8080, username: 'admin', password: 'adminadmin' }, network: { timeout: 1000 } });
  const stub = stubHttp((opts) => opts.path === '/api/v2/auth/login'
    ? { cookies: ['SID=real1; path=/', 'qbt_response_sid=csrfreal; SameSite=None'], body: 'Ok.' }
    : { body: '' });
  try {
    const r1 = await dm._http('POST', '/api/v2/auth/login', 'username=admin&password=adminadmin');
    assert.strictEqual(r1.status, 200);
    // (a) 捕获后：(b) 后续非 GET 复放完整 jar（SID + qbt_response_sid）且带 X-CSRF-Token
    await dm._http('POST', '/api/v2/app/setPassword', 'username=admin&password=x');
    const h2 = stub.reqs[1].headers;
    const c2 = String(h2.Cookie || '').split('; ');
    assert.ok(c2.includes('SID=real1'), '复放应含 SID：' + h2.Cookie);
    assert.ok(c2.includes('qbt_response_sid=csrfreal'), '复放应含 qbt_response_sid（完整 jar）：' + h2.Cookie);
    assert.strictEqual(h2['X-CSRF-Token'], 'csrfreal');
    // (c) GET 回放 cookie 但不带 CSRF 头
    await dm._http('GET', '/api/v2/torrents/info');
    const h3 = stub.reqs[2].headers;
    assert.ok(!('X-CSRF-Token' in h3), 'GET 不应带 CSRF 头');
    assert.ok(String(h3.Cookie || '').split('; ').includes('SID=real1'), 'GET 仍回放 SID：' + h3.Cookie);
    // (d) 复位后 jar 清空，不再携带 Cookie
    qc.resetSession();
    await dm._http('POST', '/api/v2/torrents/delete', 'hashes=x');
    assert.ok(!stub.reqs[3].headers.Cookie, 'resetSession 后不应带 Cookie 头');
  } finally {
    stub.restore();
  }
});

// I4：改密会作废改密前的 SID，轮换后必须清 jar，防后续复放死会话
test('I4：改密轮换后清空会话 jar，不再复放改密前的旧 SID', async () => {
  qc.resetSession();
  const dir = mkTmpDir();
  const store = path.join(dir, 'huilian-qbt-cred.json');
  const base = (method, pathname) => Promise.resolve(
    pathname === '/api/v2/auth/login'
      ? { status: 200, body: 'Ok.', headers: { 'set-cookie': ['SID=oldsid; path=/', 'qbt_response_sid=oldcsrf'] } }
      : { status: 200, body: '' });
  const http = (m, p, b) => Promise.resolve(base(m, p, b)).then(r => { qc.takeSession(r.headers && r.headers['set-cookie']); return r; });
  const config = { qbt: { username: 'admin', password: 'adminadmin', credStorePath: store } };
  await qc.ensureReal({ config, http, ensureCredential: dm.ensureCredential });
  assert.deepStrictEqual(qc.sessionHeaders('POST'), {}, '轮换后 jar 必须清空');
  fs.rmSync(dir, { recursive: true, force: true });
});

// M2：stored 为空且缺默认口令 → 明确抛错，绝不拿 undefined 去登录
test('ensureCredential：stored 为空且无默认口令 → 明确抛错，不发起登录', async () => {
  let loginCalled = 0;
  await assert.rejects(
    dm.ensureCredential({
      stored: null, genPw: () => 'x'.repeat(32),
      login: () => { loginCalled++; return Promise.resolve(true); },
      setPassword: () => Promise.resolve(true), saveCred: () => {},
    }),
    /默认凭据|无法/
  );
  assert.strictEqual(loginCalled, 0, '缺默认口令时不得发起登录');
});

// I3：saveCred 原子落盘（同目录 temp + renameSync），成功只剩最终文件、无临时残片
test('saveCred 原子落盘：写临时文件再 rename，成功后目录只剩最终文件', () => {
  const dir = mkTmpDir();
  const p = path.join(dir, 'huilian-qbt-cred.json');
  const renameOrig = fs.renameSync;
  let renamed = null;
  fs.renameSync = (from, to) => { renamed = { from, to }; return renameOrig(from, to); };
  try {
    qc.saveCred(p, { username: 'admin', password: 'pw1' });
  } finally {
    fs.renameSync = renameOrig;
  }
  assert.ok(renamed, 'saveCred 必须走 rename（temp+rename），不能就地覆盖写');
  assert.strictEqual(renamed.to, p, 'rename 目标须为最终路径');
  assert.notStrictEqual(renamed.from, p, '先写临时文件再改名到最终路径');
  assert.strictEqual(path.dirname(renamed.from), path.dirname(p), '临时文件须与最终文件同目录（同卷才原子）');
  assert.deepStrictEqual(fs.readdirSync(dir), ['huilian-qbt-cred.json'], '不得残留临时文件');
  assert.deepStrictEqual(qc.loadCred(p), { username: 'admin', password: 'pw1' });
  qc.saveCred(p, { username: 'admin', password: 'pw2' });
  assert.deepStrictEqual(fs.readdirSync(dir), ['huilian-qbt-cred.json']);
  assert.strictEqual(qc.loadCred(p).password, 'pw2');
  fs.rmSync(dir, { recursive: true, force: true });
});

// I3：rename 失败（目标为已存在目录）→ 抛错且清理临时文件，不留半写残片
test('saveCred 失败清理临时文件：目标为目录 → 抛错且不残留 .tmp', () => {
  const dir = mkTmpDir();
  const storeDir = path.join(dir, 'locked');
  fs.mkdirSync(storeDir);
  assert.throws(() => qc.saveCred(storeDir, { username: 'admin', password: 'x' }));
  assert.ok(!fs.readdirSync(dir).some(n => n.indexOf('tmp') !== -1), '失败应清理临时文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

// I3：torn/corrupt store → loadCred 返回 null 且编排走首启改密不崩溃
test('torn/corrupt store → loadCred null，ensureReal 视作首启改密不崩溃', async () => {
  qc.resetSession();
  const dir = mkTmpDir();
  const store = path.join(dir, 'huilian-qbt-cred.json');
  fs.writeFileSync(store, '{"username":"admin","pass'); // 截断/损坏
  assert.strictEqual(qc.loadCred(store), null, '损坏 store 视为无存储');
  const http = (method, pathname) => Promise.resolve(
    pathname === '/api/v2/auth/login' ? { status: 200, body: 'Ok.' } : { status: 200, body: '' });
  const config = { qbt: { username: 'admin', password: 'adminadmin', credStorePath: store } };
  const cred = await qc.ensureReal({ config, http, ensureCredential: dm.ensureCredential });
  assert.match(cred.password, /^[0-9a-f]{32}$/, '损坏 store → 视作首启，随机改密成功');
  assert.deepStrictEqual(qc.loadCred(store), { username: 'admin', password: cred.password }, '重新原子落盘修复 store');
  fs.rmSync(dir, { recursive: true, force: true });
});

// I3：真实入口 _ensureCredentialReal 上浮改密后落盘失败（不再吞进日志静默变砖），口令不入错误消息
test('_ensureCredentialReal 上浮改密后落盘失败（不再吞进日志），且错误消息不含口令', async () => {
  qc.resetSession();
  const dir = mkTmpDir();
  const storeDir = path.join(dir, 'locked');
  fs.mkdirSync(storeDir); // 目录占位 → saveCred rename 抛错
  dm.setConfig({ qbt: { port: 8080, username: 'admin', password: 'adminadmin', credStorePath: storeDir }, network: { timeout: 1000 } });
  const stub = stubHttp(() => ({ body: 'Ok.' })); // login 200 'Ok.'，setPassword 200
  try {
    let err;
    try { await dm._ensureCredentialReal(); } catch (e) { err = e; }
    assert.ok(err, '落盘失败必须上浮（reject），而非静默返回');
    assert.ok(!/[0-9a-f]{32}/.test(err.message), '错误消息不得含随机口令：' + err.message);
    assert.ok(!err.message.includes('adminadmin'), '错误消息不得含默认口令');
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
