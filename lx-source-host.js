'use strict';

/**
 * lx-source-host.js — LX user_api 脚本 VM 沙箱宿主 + 脚本存储（Stellaflix）
 *
 * 移植自 Mineradio-LX-Music 1.7.0 `lx-source-host.js`（批 T1：沙箱核心+存储）。
 * 身份转换：
 *  - 上游 `%APPDATA%\Mineradio\sources` 存储目录 → `path.join(userDataPath, 'sources')`；
 *  - 协议错误前缀 `LX_*` 与 `ALLOWED_SOURCES/ALLOWED_ACTIONS` 为协议词汇，原样保留；
 *  - `%APPDATA%\lx-music-desktop\LxDatas` 自动迁移（上游 :22-27,95-161）读取的是
 *    第三方应用数据而非本应用身份，原样保留；
 *  - 本 task 只落地 list/import/select + 白名单/超时/回滚；resolve/探测/删除/
 *    URL 导入由后续任务（T2-T4）补齐，当前以 LX_SOURCE_NOT_IMPLEMENTED 占位。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');

// —— 协议常量（上游 :16-21,31-34；:22-30 的 Mineradio 路径改由 userDataPath 提供）——
const EVENT_NAMES = Object.freeze({
  request: 'request',
  inited: 'inited',
  updateAlert: 'updateAlert',
});

// lx-music-desktop 自动迁移数据目录（第三方应用数据，非身份项，原样保留，上游 :22-27）
const APPDATA_DIR = process.env.APPDATA || '';
const LOCALAPPDATA_DIR = process.env.LOCALAPPDATA || '';
const LX_DATA_DIRS = [
  APPDATA_DIR && path.join(APPDATA_DIR, 'lx-music-desktop', 'LxDatas'),
  LOCALAPPDATA_DIR && path.join(LOCALAPPDATA_DIR, 'Programs', 'lx-music-desktop', 'portable', 'LxDatas'),
].filter(Boolean);

const ALLOWED_SOURCES = new Set(['kw', 'kg', 'tx', 'wy', 'mg', 'xm', 'local']);
const ALLOWED_ACTIONS = new Set(['musicUrl', 'lyric', 'pic']);
const LX_HTTP_TIMEOUT_MS = 12000;
const LX_ACTION_TIMEOUT_MS = 14000;

// —— 通用无状态助手（上游 :49-76）——
function safeConsoleMethod(method) {
  return (...args) => {
    try {
      const fn = console && typeof console[method] === 'function' ? console[method] : console.log;
      if (typeof fn === 'function') fn.apply(console, args);
    } catch (err) {
      if (err && err.code === 'EPIPE') return;
      throw err;
    }
  };
}

const safeSourceConsole = Object.freeze({
  log: safeConsoleMethod('log'),
  info: safeConsoleMethod('info'),
  warn: safeConsoleMethod('warn'),
  error: safeConsoleMethod('error'),
  debug: safeConsoleMethod('debug'),
  trace: safeConsoleMethod('trace'),
});

function withTimeout(promise, timeoutMs, code) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code || 'LX_SOURCE_TIMEOUT')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

// —— JSON/迁移读取助手（上游 :82-105）——
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonIfExists(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return readJson(file);
  } catch (_err) {
    return null;
  }
}

function lxDataFileCandidates(fileName) {
  return LX_DATA_DIRS.map(dir => path.join(dir, fileName));
}

function readFirstLxJson(fileName) {
  for (const file of lxDataFileCandidates(fileName)) {
    const value = readJsonIfExists(file);
    if (value != null) return value;
  }
  return null;
}

// —— HTTP 栈（上游 :179-228,272-385；User-Agent 产品名改 Stellaflix）——
function decodeResponseBody(buffer, encoding) {
  return new Promise((resolve, reject) => {
    const done = (err, value) => err ? reject(err) : resolve(value);
    if (/\bgzip\b/i.test(encoding || '')) return zlib.gunzip(buffer, done);
    if (/\bdeflate\b/i.test(encoding || '')) return zlib.inflate(buffer, done);
    if (/\bbr\b/i.test(encoding || '') && zlib.brotliDecompress) return zlib.brotliDecompress(buffer, done);
    resolve(buffer);
  });
}

function encodeRequestData(options, headers) {
  if (options.body != null) {
    if (Buffer.isBuffer(options.body) || typeof options.body === 'string') return options.body;
    headers['content-type'] ||= 'application/json';
    return JSON.stringify(options.body);
  }
  if (options.form && typeof options.form === 'object') {
    headers['content-type'] ||= 'application/x-www-form-urlencoded';
    return new URLSearchParams(options.form).toString();
  }
  if (options.formData && typeof options.formData === 'object') {
    headers['content-type'] ||= 'application/json';
    return JSON.stringify(options.formData);
  }
  return null;
}

function sanitizeHeaderValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(sanitizeHeaderValue).join(', ');
  const text = String(value).replace(/[\r\n]+/g, ' ');
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 9 || (code >= 32 && code <= 255)) out += text[i];
    else out += encodeURIComponent(text[i]);
  }
  return out;
}

function sanitizeHeaders(headers) {
  const safe = {};
  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const key = String(rawKey || '').trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) continue;
    safe[key.toLowerCase()] = sanitizeHeaderValue(rawValue);
  }
  return safe;
}

// —— 脚本内名兼容（上游 :243-248；第三方脚本名兼容，非身份项）——
function normalizeCurrentScriptInfoName(name) {
  name = String(name || '');
  // 兼容部分玉宁熙脚本：注释里的 @name 带 -Pro，但脚本内部校验用的是 lx-玉宁熙。
  if (/玉宁熙/i.test(name)) return name.replace(/-?Pro$/i, '').trim() || 'lx-玉宁熙';
  return name;
}

// —— lx.utils.crypto（上游 :387-404）——
function cryptoUtils() {
  return {
    aesEncrypt(buffer, mode, key, iv) {
      const cipher = crypto.createCipheriv(mode, key, iv);
      return Buffer.concat([cipher.update(buffer), cipher.final()]);
    },
    rsaEncrypt(buffer, key) {
      buffer = Buffer.concat([Buffer.alloc(Math.max(0, 128 - buffer.length)), buffer]);
      return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, buffer);
    },
    randomBytes: size => crypto.randomBytes(size),
    md5: value => crypto.createHash('md5').update(value).digest('hex'),
    sha1: value => crypto.createHash('sha1').update(value).digest('hex'),
    sha256: value => crypto.createHash('sha256').update(value).digest('hex'),
    hmacSha1: (key, value) => crypto.createHmac('sha1', key).update(value).digest('hex'),
    hmacSha256: (key, value) => crypto.createHmac('sha256', key).update(value).digest('hex'),
  };
}

// —— 源配置归一化（上游 :406-413）——
function normalizeSourceConfig(value) {
  if (!value || typeof value !== 'object') return value || {};
  const out = { ...value };
  const qualitys = out.qualitys || out.qualities || out.quality || out.types;
  if (Array.isArray(qualitys)) out.qualitys = qualitys.map(item => String(item || '')).filter(Boolean);
  else if (qualitys && typeof qualitys === 'object') out.qualitys = Object.keys(qualitys).filter(Boolean);
  return out;
}

// —— @ 注释元数据解析（上游 :544-558；id 前缀与默认名做身份转换）——
function metadataFromScript(script, fallbackName) {
  const readTag = tag => {
    const match = script.match(new RegExp('@' + tag + '\\s+([^\\r\\n*]+)', 'i'));
    return match ? match[1].trim() : '';
  };
  return {
    id: `stellaflix_${Date.now()}`,
    name: readTag('name') || String(fallbackName || 'Stellaflix 导入音源').replace(/\.js$/i, ''),
    description: readTag('description'),
    version: readTag('version') || 'unknown',
    author: readTag('author'),
    homepage: readTag('homepage'),
    script,
  };
}

/**
 * 工厂：每个实例持有独立的存储目录与运行时缓存。
 * initTimeoutMs / fetchImpl 为我方测试注入点（上游硬编码 10s 与 electron fetch）。
 */
function createLxSourceHost({ userDataPath, initTimeoutMs = 10000, fetchImpl = fetch } = {}) {
  if (!userDataPath) throw new Error('LX_SOURCE_USER_DATA_PATH_REQUIRED');

  // 身份转换（上游 :28-30）：%APPDATA%\Mineradio\sources → userDataPath/sources
  const SOURCE_DIR = path.join(userDataPath, 'sources');
  const SOURCE_FILE = path.join(SOURCE_DIR, 'active-source.json');
  const SOURCES_FILE = path.join(SOURCE_DIR, 'sources.json');

  let runtime = null;
  let loading = null;
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : null;

  // —— 存储（上游 :121-142）——
  function readSourceStore() {
    const saved = readJsonIfExists(SOURCES_FILE);
    const records = Array.isArray(saved?.records)
      ? saved.records
        .filter(item => item && typeof item.script === 'string' && item.script.trim())
        .map(item => ({ ...item, enabled: item.enabled !== false }))
      : [];
    const legacy = readJsonIfExists(SOURCE_FILE);
    if (legacy && typeof legacy.script === 'string' && legacy.script.trim() &&
        !records.some(item => item.id === legacy.id || item.script === legacy.script)) {
      records.push(legacy);
    }
    return { activeId: String(saved?.activeId || legacy?.id || ''), records };
  }

  function writeSourceStore(store) {
    fs.mkdirSync(SOURCE_DIR, { recursive: true });
    fs.writeFileSync(SOURCES_FILE, JSON.stringify({
      activeId: String(store?.activeId || ''),
      records: Array.isArray(store?.records) ? store.records : [],
    }), 'utf8');
  }

  // —— lx-music-desktop 自动迁移（上游 :107-119,144-162，保留第三方目录读取）——
  function saveMigratedSource(record) {
    if (!record || typeof record.script !== 'string' || !record.script.trim()) return;
    try {
      fs.mkdirSync(SOURCE_DIR, { recursive: true });
      fs.writeFileSync(SOURCE_FILE, JSON.stringify(record), 'utf8');
      const store = readSourceStore();
      if (!store.records.some(item => item.id === record.id || item.script === record.script)) {
        store.records.push(record);
      }
      store.activeId = record.id;
      writeSourceStore(store);
    } catch (_err) {}
  }

  function activeScriptRecord() {
    const store = readSourceStore();
    const imported = store.records.find(item => item.id === store.activeId && item.enabled !== false) ||
      store.records.find(item => item.enabled !== false);
    if (imported && typeof imported.script === 'string' && imported.script.trim()) return imported;

    const saved = readFirstLxJson('user_api.json');
    const records = saved && (Array.isArray(saved) ? saved : saved.userApis);
    if (!Array.isArray(records) || !records.length) throw new Error('LX_SOURCE_NOT_CONFIGURED');

    let selectedId = '';
    const config = readFirstLxJson('config_v2.json');
    if (config) selectedId = String(config?.setting?.common?.apiSource || '');
    const selected = records.find(item => item && item.id === selectedId) ||
      records.slice().reverse().find(item => item && typeof item.script === 'string' && item.script.trim());
    if (!selected) throw new Error('LX_SOURCE_NOT_CONFIGURED');
    saveMigratedSource(selected);
    return selected;
  }

  // —— 脚本内 HTTP（上游 :272-385；electronFetch 分支改 fetchImpl 注入）——
  function lxRequest(url, options, callback, redirectCount = 0) {
    options = options || {};
    let callbackDone = false;
    const done = (err, resp, body) => {
      if (callbackDone) return;
      callbackDone = true;
      callback(err, resp, body);
    };
    let target;
    try {
      target = new URL(String(url));
    } catch (err) {
      queueMicrotask(() => done(err));
      return () => {};
    }
    if (!/^https?:$/.test(target.protocol)) {
      queueMicrotask(() => done(new Error('Unsupported protocol')));
      return () => {};
    }
    let headers = sanitizeHeaders(Object.assign({
      'accept': '*/*',
      'accept-encoding': 'gzip, deflate, br',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Stellaflix/LXSource',
    }, options.headers || {}));
    const body = encodeRequestData(options, headers);
    headers = sanitizeHeaders(headers);
    if (fetchFn) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(Number(options.timeout) || 60000, 1000), 60000));
      fetchFn(target.href, {
        method: String(options.method || 'GET').toUpperCase(),
        headers,
        body: body == null ? undefined : body,
        redirect: 'follow',
        signal: controller.signal,
      }).then(async response => {
        const raw = Buffer.from(await response.arrayBuffer());
        const text = raw.toString('utf8');
        let parsed = text;
        try { parsed = JSON.parse(text); } catch (_err) {}
        const responseHeaders = {};
        response.headers.forEach((value, key) => { responseHeaders[key] = value; });
        done(null, {
          statusCode: response.status,
          statusMessage: response.statusText,
          headers: responseHeaders,
          bytes: raw.length,
          raw,
          body: parsed,
        }, parsed);
      }).catch(err => done(err)).finally(() => clearTimeout(timeout));
      return () => {
        clearTimeout(timeout);
        controller.abort();
      };
    }
    if (body != null && !Object.keys(headers).some(key => key.toLowerCase() === 'content-length')) {
      headers['content-length'] = Buffer.byteLength(body);
    }
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, {
      method: String(options.method || 'GET').toUpperCase(),
      headers,
      timeout: Math.min(Math.max(Number(options.timeout) || LX_HTTP_TIMEOUT_MS, 1000), 20000),
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectCount < 5) {
        res.resume();
        return lxRequest(new URL(res.headers.location, target).href, options, callback, redirectCount + 1);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', async () => {
        try {
          const raw = await decodeResponseBody(Buffer.concat(chunks), res.headers['content-encoding']);
          const text = raw.toString('utf8');
          let parsed = text;
          try { parsed = JSON.parse(text); } catch (_err) {}
          const response = {
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            bytes: raw.length,
            raw,
            body: parsed,
          };
          done(null, response, parsed);
        } catch (err) {
          done(err);
        }
      });
    });
    req.on('error', err => done(err));
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    if (body != null) req.write(body);
    req.end();
    return () => req.destroy();
  }

  function lxRequestCompat(url, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const promise = new Promise((resolve, reject) => {
      lxRequest(url, options || {}, (err, response, body) => {
        if (err) return reject(err);
        resolve({ ...response, body });
      });
    });
    if (typeof callback === 'function') {
      promise.then(response => callback(null, response, response.body), callback);
    }
    return promise;
  }

  // —— 沙箱运行时（上游 :415-530；gz_ 解码、lx 对象、vm 注入、白名单与三拒绝码）——
  async function createRuntime(recordOverride) {
    const record = recordOverride || activeScriptRecord();
    if (!record || typeof record.script !== 'string') throw new Error('LX_SOURCE_SCRIPT_INVALID');
    const script = record.script.startsWith('gz_')
      ? zlib.inflateSync(Buffer.from(record.script.substring(3), 'base64')).toString('utf8')
      : record.script;
    const state = { handler: null, info: null };
    let finishInit;
    let failInit;
    const initialized = new Promise((resolve, reject) => {
      finishInit = resolve;
      failInit = reject;
    });
    // 上游 :424-427 在 vm 同步抛错路径 failInit 后直接 throw，initialized 无人 await
    // 会触发 unhandledRejection；本移植补一个空 catch 销雷（不改变 race 语义）。
    initialized.catch(() => {});
    const lx = {
      EVENT_NAMES,
      request: lxRequest,
      on(eventName, handler) {
        if (eventName === EVENT_NAMES.request && typeof handler === 'function') {
          state.handler = handler;
        }
        // Some third-party LX sources register optional events that the host does
        // not need. Treat them as supported no-ops so import validation does not
        // fail before playback can use the request handler.
        return Promise.resolve();
      },
      send(eventName, data) {
        if (eventName === EVENT_NAMES.inited) {
          state.info = data || {};
          finishInit(state.info);
        }
        return Promise.resolve();
      },
      utils: {
        request: lxRequestCompat,
        fetch: lxRequestCompat,
        httpFetch: lxRequestCompat,
        crypto: cryptoUtils(),
        buffer: {
          from: (...args) => Buffer.from(...args),
          bufToString: (buf, format) => Buffer.from(buf, 'binary').toString(format),
        },
        zlib: {
          inflate: data => new Promise((resolve, reject) => zlib.inflate(data, (err, buf) => err ? reject(err) : resolve(buf))),
          deflate: data => new Promise((resolve, reject) => zlib.deflate(data, (err, buf) => err ? reject(err) : resolve(buf))),
        },
      },
      currentScriptInfo: {
        name: normalizeCurrentScriptInfoName(record.name || ''),
        description: record.description || '',
        version: record.version || '',
        author: record.author || '',
        homepage: record.homepage || '',
        rawScript: script,
      },
      version: '2.0.0',
      env: 'desktop',
    };
    const sandbox = {
      lx,
      console: safeSourceConsole,
      Buffer,
      process: { platform: process.platform, versions: process.versions, env: {} },
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      AbortController,
      fetch: fetchFn || undefined,
      crypto: crypto.webcrypto,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      queueMicrotask,
      atob: value => Buffer.from(String(value), 'base64').toString('binary'),
      btoa: value => Buffer.from(String(value), 'binary').toString('base64'),
    };
    sandbox.globalThis = sandbox;
    sandbox.global = sandbox;
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    try {
      vm.runInNewContext(script, sandbox, {
        filename: `lx-source-${record.id || 'active'}.js`,
        timeout: 5000,
        displayErrors: true,
      });
    } catch (err) {
      failInit(err);
      throw err;
    }
    // 上游硬编码 10000ms，这里用注入点 initTimeoutMs（默认仍 10s）
    await withTimeout(initialized, initTimeoutMs, 'LX_SOURCE_INIT_TIMEOUT');
    if (typeof state.handler !== 'function') throw new Error('LX_SOURCE_REQUEST_HANDLER_MISSING');
    const sources = {};
    for (const [key, value] of Object.entries(state.info.sources || {})) {
      if (ALLOWED_SOURCES.has(key)) sources[key] = normalizeSourceConfig(value);
    }
    return {
      id: record.id,
      name: record.name || 'LX source',
      version: record.version || '',
      sources,
      async request(source, action, info) {
        if (!ALLOWED_SOURCES.has(source) || !sources[source]) throw new Error('LX_SOURCE_UNSUPPORTED');
        if (!ALLOWED_ACTIONS.has(action)) throw new Error('LX_ACTION_UNSUPPORTED');
        return withTimeout(
          Promise.resolve(state.handler({ source, action, info })),
          LX_ACTION_TIMEOUT_MS,
          'LX_SOURCE_ACTION_TIMEOUT'
        );
      },
    };
  }

  async function getRuntime(forceReload = false) {
    if (forceReload) runtime = null;
    if (runtime) return runtime;
    if (!loading) {
      loading = createRuntime().then(value => {
        runtime = value;
        return value;
      }).finally(() => { loading = null; });
    }
    return loading;
  }

  function persistActiveSources(record, sources) {
    // 把白名单过滤后的源能力写回存储，供 listSources 展示（无需二次起沙箱）。
    try {
      const store = readSourceStore();
      const item = store.records.find(r => r.id === record.id);
      if (item) { item.sources = sources; writeSourceStore(store); }
      const active = readJsonIfExists(SOURCE_FILE);
      if (active && active.id === record.id) fs.writeFileSync(SOURCE_FILE, JSON.stringify({ ...record, sources }), 'utf8');
    } catch (_err) {}
  }

  // —— importSource 校验回滚（上游 :560-591；签名改 (name, script) → {id, meta}）——
  async function importSource(name, script) {
    script = String(script || '').replace(/^\uFEFF/, '');
    if (!script.trim() || script.length > 5 * 1024 * 1024) throw new Error('LX_SOURCE_FILE_INVALID');
    const record = metadataFromScript(script, name);
    record.enabled = true;
    fs.mkdirSync(SOURCE_DIR, { recursive: true });
    const previousStore = readSourceStore();
    const store = { activeId: record.id, records: previousStore.records.slice() };
    const duplicateIndex = store.records.findIndex(item => item.script === record.script);
    if (duplicateIndex >= 0) {
      record.id = store.records[duplicateIndex].id;
      store.records[duplicateIndex] = record;
    } else {
      store.records.push(record);
    }
    store.activeId = record.id;
    writeSourceStore(store);
    fs.writeFileSync(SOURCE_FILE, JSON.stringify(record), 'utf8');
    try {
      const hostRuntime = await getRuntime(true);
      persistActiveSources(record, hostRuntime.sources);
      return { id: record.id, meta: sourceMeta(record, hostRuntime.sources) };
    } catch (err) {
      writeSourceStore(previousStore);
      const previous = previousStore.records.find(item => item.id === previousStore.activeId);
      try {
        if (previous) fs.writeFileSync(SOURCE_FILE, JSON.stringify(previous), 'utf8');
        else fs.unlinkSync(SOURCE_FILE);
      } catch (_err) {}
      runtime = null;
      throw err;
    }
  }

  function sourceMeta(record, sources) {
    return {
      id: record.id,
      name: record.name || '未命名音源',
      description: record.description || '',
      version: record.version || '',
      author: record.author || '',
      homepage: record.homepage || '',
      enabled: record.enabled !== false,
      sources: sources && typeof sources === 'object' ? sources : record.sources || {},
    };
  }

  // —— listSources（上游 :593-603 基础上补齐 description/sources/current 字段，接口见计划）——
  function listSources() {
    const store = readSourceStore();
    return store.records.map(item => ({
      id: item.id,
      name: item.name || '未命名音源',
      description: item.description || '',
      version: item.version || '',
      author: item.author || '',
      enabled: item.enabled !== false,
      current: item.id === store.activeId,
      sources: item.sources && typeof item.sources === 'object' ? item.sources : {},
    }));
  }

  // —— selectSource（上游 :605-623；失败回滚 activeId）——
  async function selectSource(id) {
    const store = readSourceStore();
    const record = store.records.find(item => item.id === String(id || ''));
    if (!record) throw new Error('LX_SOURCE_NOT_FOUND');
    if (record.enabled === false) throw new Error('LX_SOURCE_DISABLED');
    const previousId = store.activeId;
    store.activeId = record.id;
    writeSourceStore(store);
    fs.writeFileSync(SOURCE_FILE, JSON.stringify(record), 'utf8');
    try {
      const hostRuntime = await getRuntime(true);
      persistActiveSources(record, hostRuntime.sources);
      return { ok: true, id: record.id, name: hostRuntime.name, version: hostRuntime.version, sources: hostRuntime.sources };
    } catch (err) {
      store.activeId = previousId;
      writeSourceStore(store);
      runtime = null;
      throw err;
    }
  }

  // —— 后续任务占位：接口名锁定本计划 Interfaces 块，实现落在 T2-T4 ——
  const notImplemented = task => () => { throw new Error(`LX_SOURCE_NOT_IMPLEMENTED:${task}`); };

  return {
    importSource,
    importSourceUrl: notImplemented('T4'),
    selectSource,
    setSourcesEnabled: notImplemented('T4'),
    deleteSource: notImplemented('T4'),
    deleteSources: notImplemented('T4'),
    listSources,
    checkSources: notImplemented('T4'),
    resolveMusicUrl: notImplemented('T2'),
    getLyric: notImplemented('T3'),
    picAction: notImplemented('T3'),
  };
}

module.exports = { createLxSourceHost };
