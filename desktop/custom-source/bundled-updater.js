/**
 * 内置音源清单与上游跟随更新(阶段:内置音源系统)。
 * manifest.json 声明每个内置脚本的上游仓库坐标(repo/ref/path),更新器:
 *  - 多线路拉取(raw.githubusercontent → cdn.jsdelivr.net → fastly.jsdelivr.net),适配直连不可达环境
 *  - 头部解析校验(parseScriptInfo)+ 大小上限(MAX_SCRIPT_BYTES)+ 名称一致性,防篡改/防错文件
 *  - 原子落盘(临时文件 rename),失败不破坏现有内置脚本
 * 网络实现由调用方注入(fetchImpl):主进程用 Electron net.fetch(遵循系统代理),测试注入桩。
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseScriptInfo } = require('./protocol');
const { MAX_SCRIPT_BYTES } = require('./store');

const BUNDLED_FILE_NAME_RE = /^[A-Za-z0-9._-]+$/;

// 上游信号探测缓存: 规避 GitHub API 未认证 60次/小时限流,且避免重复点击"检查更新"反复打 API。
// 注意: 本模块运行于 Electron 主进程,无 localStorage,故用进程内 Map(重启清空,单会话内生效)。
// 缓存成功 / 限流(403) 1 小时;其他瞬时错误 10 分钟(让其更快重试)。
var signalCache = (function () {
  const map = new Map();
  const DEFAULT_TTL = 60 * 60 * 1000;   // 成功 / 限流(403)
  const ERROR_TTL = 10 * 60 * 1000;     // 其他瞬时错误
  return {
    DEFAULT_TTL,
    ERROR_TTL,
    get: (k) => map.get(k),
    set: (k, v) => map.set(k, v),
    clear: () => map.clear(),
    _map: map, // 仅测试用
  };
})();

function signalCacheKey(entry) {
  const up = entry.upstream || {};
  return [up.repo || '', up.basedOn || '', up.signalUrl || ''].join('|');
}

function bundledDirFrom(defaultRoot) {
  return defaultRoot || path.join(__dirname, 'bundled');
}

function loadBundledManifest(bundledDir) {
  const manifestPath = path.join(bundledDirFrom(bundledDir), 'manifest.json');
  let raw;
  try { raw = fs.readFileSync(manifestPath, 'utf8'); }
  catch { throw new Error('BUNDLED_MANIFEST_MISSING'); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('BUNDLED_MANIFEST_INVALID'); }
  const sources = Array.isArray(parsed && parsed.sources) ? parsed.sources : [];
  const valid = [];
  const seen = new Set();
  for (const entry of sources) {
    if (!entry || typeof entry !== 'object') continue;
    const fileName = String(entry.fileName || '');
    const repo = String(entry.repo || '');
    const ref = String(entry.ref || 'master');
    const filePath = String(entry.path || '');
    if (!BUNDLED_FILE_NAME_RE.test(fileName) || seen.has(fileName)) continue;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) continue;
    if (!filePath || filePath.includes('..')) continue;
    seen.add(fileName);
    const upstream = entry.upstream && typeof entry.upstream === 'object'
      ? {
          repo: String(entry.upstream.repo || ''),
          kind: String(entry.upstream.kind || ''),
          basedOn: String(entry.upstream.basedOn || ''),
          signalUrl: String(entry.upstream.signalUrl || ''),
        }
      : null;
    valid.push({
      fileName,
      repo,
      ref,
      path: filePath,
      homepage: String(entry.homepage || ''),
      note: String(entry.note || ''),
      upstream,
    });
  }
  return { path: manifestPath, sources: valid };
}

function remoteUrlsFor(entry) {
  const repoPath = `${entry.repo}@${entry.ref}/${entry.path.replace(/^\/+/, '')}`;
  return [
    `https://raw.githubusercontent.com/${entry.repo}/${entry.ref}/${entry.path.replace(/^\/+/, '')}`,
    `https://cdn.jsdelivr.net/gh/${repoPath}`,
    `https://fastly.jsdelivr.net/gh/${repoPath}`,
  ];
}

function readLocalScriptInfo(bundledDir, entry) {
  const filePath = path.join(bundledDirFrom(bundledDir), entry.fileName);
  let script;
  try { script = fs.readFileSync(filePath, 'utf8'); }
  catch { return null; }
  if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) return null;
  try { return { info: parseScriptInfo(script), script, filePath }; }
  catch { return null; }
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response || !response.ok) throw new Error(`HTTP_${response && response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_SCRIPT_BYTES) throw new Error('SCRIPT_TOO_LARGE');
  return text;
}

/**
 * 拉取并校验上游脚本。任一线路成功即返回;全部失败时抛最后一个错误。
 * 校验:头部可解析 + @name 与本地一致(仓库结构调整/换脚本会被拒绝)。
 */
async function fetchLatestScript(bundledDir, entry, fetchImpl) {
  const local = readLocalScriptInfo(bundledDir, entry);
  if (!local) throw new Error('BUNDLED_LOCAL_SCRIPT_INVALID');
  let lastError = null;
  for (const url of remoteUrlsFor(entry)) {
    let text;
    try { text = await fetchText(url, fetchImpl); }
    catch (error) { lastError = error; continue; }
    try {
      const info = parseScriptInfo(text);
      if (info.name && local.info.name && info.name !== local.info.name) {
        throw new Error(`NAME_MISMATCH: 上游名称「${info.name}」与内置「${local.info.name}」不一致`);
      }
      return { script: text, info, url };
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('FETCH_FAILED');
}

/**
 * 语义版本比较。接受 "v1.3.8" / "1.3.8" / "master" 等。
 * 任一端非数字版本(如 master)返回 0(不可比),调用方据此跳过。
 */
function normalizeVersion(v) {
  if (!v || typeof v !== 'string') return null;
  const s = v.replace(/^v/i, '').trim();
  if (!s) return null;
  const parts = s.split('.').map(function (x) { return parseInt(x, 10); });
  if (parts.some(function (n) { return Number.isNaN(n); })) return null;
  return parts;
}

function compareVersions(a, b) {
  const pa = normalizeVersion(a);
  const pb = normalizeVersion(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * 探测上游项目信号(如 QingMusic 的 GitHub Release 版本),与 basedOn 比对。
 * 独立 try/catch:上游探测失败只影响 upstreamSignal,绝不阻塞脚本更新主流程。
 * 返回 { available, latestVersion, basedOn, checkedAt, repo, error? }
 */
async function probeUpstreamSignal(entry, fetchImpl, opts) {
  opts = opts || {};
  const up = entry.upstream;
  if (!up || !up.signalUrl) return { available: false, skipped: true };
  if (typeof fetchImpl !== 'function') return { available: false, error: 'FETCH_UNAVAILABLE' };
  const cache = opts.cache || null;
  const now = (typeof opts.now === 'number') ? opts.now : Date.now();
  const key = signalCacheKey(entry);
  if (cache) {
    const cached = cache.get(key);
    if (cached && (now - cached.checkedAt) < (cached.__ttl || cache.DEFAULT_TTL)) {
      const out = Object.assign({}, cached);
      delete out.__ttl;
      out.cached = true;
      return out;
    }
  }
  try {
    const resp = await fetchImpl(up.signalUrl);
    if (!resp || !resp.ok) throw new Error('HTTP_' + (resp && resp.status));
    const data = await resp.json();
    let latestVersion = '';
    if (up.kind === 'github-release') {
      latestVersion = (data && (data.tag_name || data.name)) || '';
    } else if (typeof data === 'string') {
      latestVersion = data;
    }
    const basedOn = up.basedOn || '';
    const cmp = compareVersions(latestVersion, basedOn);
    const result = {
      available: cmp > 0,
      latestVersion: latestVersion,
      basedOn: basedOn,
      checkedAt: now,
      repo: up.repo || '',
    };
    if (cache) cache.set(key, Object.assign({}, result, { __ttl: cache.DEFAULT_TTL }));
    return result;
  } catch (error) {
    const errMsg = String(error && error.message || error);
    console.error('[upstream-signal]', up.repo, errMsg);
    const errResult = { available: false, error: errMsg, checkedAt: now };
    if (cache) cache.set(key, Object.assign({}, errResult, { __ttl: /403/.test(errMsg) ? cache.DEFAULT_TTL : cache.ERROR_TTL }));
    return errResult;
  }
}

function checkBundledUpdates(bundledDir, { fetchImpl, cache, now } = {}) {
  const manifest = loadBundledManifest(bundledDir);
  const probeOpts = { cache: cache || signalCache, now: now };
  return Promise.all(manifest.sources.map(async entry => {
    const local = readLocalScriptInfo(bundledDir, entry);
    if (!local) {
      const upstreamSignal = await probeUpstreamSignal(entry, fetchImpl, probeOpts);
      return { fileName: entry.fileName, ok: false, error: 'BUNDLED_LOCAL_SCRIPT_INVALID', upstreamSignal };
    }
    let scriptResult;
    try {
      const latest = await fetchLatestScript(bundledDir, entry, fetchImpl);
      scriptResult = {
        ok: true,
        localVersion: local.info.version,
        remoteVersion: latest.info.version,
        updateAvailable: latest.script !== local.script,
        fetchedVia: latest.url,
      };
    } catch (error) {
      scriptResult = { ok: false, error: String(error && error.message || error) };
    }
    const upstreamSignal = await probeUpstreamSignal(entry, fetchImpl, probeOpts);
    return { fileName: entry.fileName, ...scriptResult, upstreamSignal };
  }));
}

/** 原子写入:先写临时文件再 rename,校验失败/写失败都不影响现有脚本。 */
function applyBundledUpdate(bundledDir, entry, latest) {
  const dir = bundledDirFrom(bundledDir);
  const target = path.join(dir, entry.fileName);
  const temp = path.join(dir, `.${entry.fileName}.tmp-${Date.now()}`);
  fs.writeFileSync(temp, latest.script, 'utf8');
  try {
    // rename 前再验一次头部,保证落盘内容与校验内容一致
    parseScriptInfo(fs.readFileSync(temp, 'utf8'));
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  return { fileName: entry.fileName, version: latest.info.version, filePath: target };
}

async function checkAndUpdateBundledSource(bundledDir, fileName, { fetchImpl } = {}) {
  const manifest = loadBundledManifest(bundledDir);
  const entry = manifest.sources.find(item => item.fileName === String(fileName || ''));
  if (!entry) throw new Error('BUNDLED_SOURCE_NOT_TRACKED');
  const latest = await fetchLatestScript(bundledDir, entry, fetchImpl);
  const local = readLocalScriptInfo(bundledDir, entry);
  if (local && latest.script === local.script) {
    return { updated: false, version: latest.info.version };
  }
  const applied = applyBundledUpdate(bundledDir, entry, latest);
  return { updated: true, version: applied.version, script: latest.script, sourceFileName: entry.fileName };
}

module.exports = {
  loadBundledManifest,
  remoteUrlsFor,
  readLocalScriptInfo,
  fetchLatestScript,
  checkBundledUpdates,
  applyBundledUpdate,
  checkAndUpdateBundledSource,
  compareVersions,
  probeUpstreamSignal,
  signalCache,
  BUNDLED_FILE_NAME_RE,
};
