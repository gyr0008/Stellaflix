'use strict';

/**
 * Stellaflare 影视态 — qBt WebUI 凭据适配器 (qbt-credential.js) — Task6/D3
 * ----------------------------------------------------------------------------
 * 按「单文件 ≤350 行」自律线从 download-manager.js 拆出的 fs/WebAPI 真实适配层
 * （纯编排 ensureCredential 仍留在 download-manager.js，由调用方经 ctx 注入，避免循环依赖）：
 *   - 凭据落盘：路径取 video-config 的 qbt.credStorePath（默认 userData/huilian-qbt-cred.json）
 *   - 真实 login/setPassword 接线 + WebUI 会话（SID cookie / X-CSRF-Token）捕获回放
 *   - 随机口令生成：crypto.randomBytes(16) 的 32 位十六进制（spec §7 D-6）
 * 安全红线：随机口令绝不写入日志 / 错误消息 / 用户可见文案。
 * 本模块不 require electron 与 download-manager，可 headless 单测。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CRED_FILENAME = 'huilian-qbt-cred.json';

// -----------------------------------------------------------------------
//  WebUI 会话：login 成功后 qbt 下发 SID（会话 cookie）与 qbt_response_sid（CSRF 令牌源）
// -----------------------------------------------------------------------
let _jar = {};        // 完整 cookie jar：name -> value（SID / qbt_response_sid 等，双提交 CSRF 需整体复放）
let _csrfToken = '';  // 仅 qbt_response_sid 的 value（与 jar 内 qbt_response_sid 同源，用于 X-CSRF-Token）

/** 从响应 set-cookie 数组捕获全部 cookie（无会话时传 undefined 安全） */
function takeSession(setCookies) {
  for (const raw of setCookies || []) {
    const kv = String(raw).split(';')[0].trim();
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const name = kv.slice(0, eq);
    const value = kv.slice(eq + 1);
    _jar[name] = value;
    if (name === 'qbt_response_sid') _csrfToken = value;
  }
}

/** 供 _http 附加的会话头（无会话时为空对象；GET 不参与 CSRF 校验，但仍回放整份 jar） */
function sessionHeaders(method) {
  const h = {};
  const pairs = Object.keys(_jar).map(k => k + '=' + _jar[k]);
  if (pairs.length) h.Cookie = pairs.join('; ');
  if (_csrfToken && method !== 'GET') {
    h['X-CSRF-Token'] = _csrfToken;        // qbt 4.6.1+ 默认开启 CSRF 防护
    h['X-Header-Over-Auth-Check'] = '1';   // 兼容 4.5.x—4.6.0 的 SameSite 缓解期
  }
  return h;
}

/** qbt 进程重启后旧会话失效，start 前复位 */
function resetSession() { _jar = {}; _csrfToken = ''; }

/** 随机口令：32 位十六进制 */
function genPw() { return crypto.randomBytes(16).toString('hex'); }

// -----------------------------------------------------------------------
//  凭据落盘（JSON，单文件只存 {username, password}）
// -----------------------------------------------------------------------
/** credStorePath 缺失时兜底：平台 AppData/Stellaflix 下同名文件（与 __appData__ 约定一致的文件名） */
function resolveCredStorePath(qbt) {
  if (qbt && qbt.credStorePath) return qbt.credStorePath;
  const base = process.env.APPDATA || (process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(base, 'Stellaflix', CRED_FILENAME);
}

/** 读落盘凭据；文件缺失/损坏/形状不合 → null（视为首启） */
function loadCred(storePath) {
  try {
    const obj = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (obj && typeof obj.username === 'string' && typeof obj.password === 'string' && obj.password) {
      return { username: obj.username, password: obj.password };
    }
  } catch (e) { /* 首启或损坏：走默认口令改密流程 */ }
  return null;
}

/** 写落盘凭据（原子写：同目录临时文件 + renameSync，失败清理残片，杜绝 torn-file）
 *  mode 0600 仅 POSIX 生效；Windows 上 NTFS 忽略该位（见任务报告说明） */
function saveCred(storePath, cred) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = storePath + '.tmp.' + process.pid + '.' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(tmp, JSON.stringify(cred), { mode: 0o600 });
    fs.renameSync(tmp, storePath);   // 同目录改名在同卷上是原子操作
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}   // 清理半写临时文件，防残留
    throw e;
  }
}

// -----------------------------------------------------------------------
//  真实 login / setPassword（走注入的 http，即 download-manager._http）
// -----------------------------------------------------------------------
async function loginWith(http, username, password) {
  const form = 'username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password);
  // 会话捕获的唯一真实路径是 download-manager._http（对每个响应的 set-cookie 调 takeSession）；
  // 此处不再重复捕获——注入的 http 结果无 headers，旧写法在生产是空操作（I2）。
  const res = await http('POST', '/api/v2/auth/login', form);
  // 错误消息只含状态码，不含任何口令（安全红线）
  if (res.status !== 200 || String(res.body).trim() === 'Fails.') {
    throw new Error('qbt WebUI login failed (status ' + res.status + ')');
  }
  return true;
}

async function setPasswordWith(http, username, newPw) {
  const form = 'username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(newPw);
  const res = await http('POST', '/api/v2/app/setPassword', form);
  if (res.status !== 200) throw new Error('qbt WebUI setPassword failed (status ' + res.status + ')');
  return true;
}

// -----------------------------------------------------------------------
//  编排入口
// -----------------------------------------------------------------------
/**
 * 先把落盘凭据灌进 config.qbt（就绪轮询/后续调用的 Basic 认证依赖最新口令），
 * 并复位会话状态（qbt 将作为新进程启动）。返回 stored（无则 null）。
 */
function applyStored(config) {
  const qbt = config && config.qbt;
  if (!qbt) return null;
  resetSession();
  const stored = loadCred(resolveCredStorePath(qbt));
  if (stored) { qbt.username = stored.username; qbt.password = stored.password; }
  return stored;
}

/**
 * 真实首启编排：download-manager.start() 就绪轮询成功后调用一次。
 * ctx = { config, http, ensureCredential, genPw? }
 *   stored 命中 → 零 HTTP 直接返回；否则默认口令 login → setPassword(genPw()) →
 *   saveCred → 覆写 config.qbt 供后续 _http Basic 认证使用。
 * 默认口令只在「首启且 stored 为空」这一次 login 中使用。
 */
async function ensureReal(ctx) {
  const qbt = ctx.config && ctx.config.qbt;
  if (!qbt) throw new Error('qbt config missing, credential setup skipped');
  const gen = ctx.genPw || genPw;
  resetSession();                 // 入口清 jar；M1：applyStored 已在 start() 里跑过，此处不再重复复位/读盘/覆写
  const stored = loadCred(resolveCredStorePath(qbt));
  const cred = await ctx.ensureCredential({
    stored,
    defaults: { username: qbt.username, password: qbt.password },
    genPw: gen,
    login: (u, p) => loginWith(ctx.http, u, p),
    setPassword: (pw) => setPasswordWith(ctx.http, qbt.username, pw),
    // 改密成功后运行配置立即跟上（先覆写再落盘）：即便 saveCred 抛错，本进程也不会拿旧口令认证
    saveCred: (c) => { qbt.username = c.username; qbt.password = c.password; saveCred(resolveCredStorePath(qbt), c); },
  });
  qbt.username = cred.username;
  qbt.password = cred.password;
  if (!stored) resetSession();     // I4：改密会作废改密前的 SID，轮换后清 jar 防复放死会话（stored 命中本就没发请求，无需清）
  return cred;
}

module.exports = {
  CRED_FILENAME, genPw,
  takeSession, sessionHeaders, resetSession,
  resolveCredStorePath, loadCred, saveCred,
  loginWith, setPasswordWith, applyStored, ensureReal,
};
