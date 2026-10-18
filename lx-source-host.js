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
 *  - 本 task（T1）落地 list/import/select + 白名单/超时/回滚；T2 补齐 resolveMusicUrl
 *    回退链+90s LRU 缓存（上游 :1087-1218）；T3 补齐音质降级链+Range 魔数探测
 *    （上游 :980-1062/:1064-1084/:1092-1100/:1137-1146/:1163-1184；:1134-1136
 *    「念心音源」320k-first 硬编码按计划例外条款不移植）；T4 补齐 URL/APIKEY 导入、
 *    checkSources 试跑、批量启停与删除（上游 :230-270/:630-795/:797-831；删除/停用
 *    同步清 fallbackRuntimeCache 为 T2 审查携带项，上游 :727/:771 同款）；
 *    getLyric/picAction 归后续任务（裁决：getLyric→T7，pic 维持占位）。
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
// 我方调整：env 改为调用时惰性读取（上游为模块加载时快照），便于测试隔离本机真实 LxDatas。
function lxDataDirs() {
  const appdataDir = process.env.APPDATA || '';
  const localAppdataDir = process.env.LOCALAPPDATA || '';
  return [
    appdataDir && path.join(appdataDir, 'lx-music-desktop', 'LxDatas'),
    localAppdataDir && path.join(localAppdataDir, 'Programs', 'lx-music-desktop', 'portable', 'LxDatas'),
  ].filter(Boolean);
}

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
  return lxDataDirs().map(dir => path.join(dir, fileName));
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

// —— HTTPS 证书失败降级判定（上游 :230-240，ynx.de5.net 域证书常不匹配，端点为脚本生态公共服务非身份项）——
function sourceUrlHttpFallback(sourceUrl, err) {
  try {
    const target = new URL(String(sourceUrl || '').trim());
    const message = String((err && (err.code || err.message)) || err || '');
    if (target.protocol === 'https:' && target.hostname === 'ynx.de5.net' && /CERT|SSL|TLS|COMMON_NAME|certificate/i.test(message)) {
      target.protocol = 'http:';
      return target.href;
    }
  } catch (_err) {}
  return '';
}

// —— URL/APIKEY 导入归一（上游 :250-270 照抄：64-hex 展开 ynx 端点、裸域补协议、ynx https 预降级 http）——
function normalizeImportSourceUrl(input) {
  let text = String(input || '').trim();
  if (!text) throw new Error('LX_SOURCE_URL_INVALID');
  if (/^[a-f0-9]{64}$/i.test(text)) {
    text = 'http://ynx.de5.net/API/lx-ynx.php?APIKEY=' + text;
  } else if (/^ynx\.de5\.net\//i.test(text)) {
    text = 'http://' + text;
  }
  let target;
  try {
    target = new URL(text);
  } catch (_err) {
    throw new Error('LX_SOURCE_URL_INVALID');
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error('LX_SOURCE_URL_INVALID');
  if (target.protocol === 'https:' && target.hostname === 'ynx.de5.net') {
    // 这个域名的 https 证书经常不匹配，直接走官方注释给的 http。
    target.protocol = 'http:';
  }
  return target.href;
}

// —— 批量 ids 归一（上游 :625-628）——
function normalizeSourceIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [ids])
    .map(id => String(id || '').trim()).filter(Boolean))];
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
    // T1 审查携带整改：同毫秒导入会撞 id，追加随机短后缀；保留 stellaflix_ 前缀。
    id: `stellaflix_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    name: readTag('name') || String(fallbackName || 'Stellaflix 导入音源').replace(/\.js$/i, ''),
    description: readTag('description'),
    version: readTag('version') || 'unknown',
    author: readTag('author'),
    homepage: readTag('homepage'),
    script,
  };
}

// —— 音乐信息归一化（上游 :844-899，无状态）——
function normalizeMusicInfo(source, input) {
  const info = { ...(input || {}) };
  const fallbackIdPattern = /^(?:tx|wy|kw|kg|mg|song|row)_[0-9a-f]{12,}$/i;
  const hasFallbackId = info.importFallbackId === true ||
    fallbackIdPattern.test(String(info.songmid || '')) ||
    fallbackIdPattern.test(String(info.id || ''));
  if (hasFallbackId) {
    for (const key of ['id', 'songmid', 'mid', 'songId', 'rid', 'musicId', 'hash', 'FileHash', 'fileHash', 'copyrightId', 'copyrightid']) {
      if (info[key] != null) info[key] = '';
    }
    info.importFallbackId = true;
  }
  const id = info.songmid ?? info.id ?? info.hash ?? info.copyrightId ?? '';
  info.id ??= id;
  info.songmid ??= id;
  info.mid ??= info.songmid;
  info.songId ??= info.id;
  info.rid ??= info.songmid;
  info.musicId ??= info.songmid;
  info.name ??= info.songName ?? info.title ?? '';
  info.songName ??= info.name;
  info.title ??= info.name;
  info.singer ??= info.artist ?? info.singerName ?? '';
  info.artist ??= info.singer;
  info.albumName ??= info.album ?? '';
  info.album ??= info.albumName;
  info.meta = { ...(info.meta || {}) };
  if (hasFallbackId) {
    for (const key of ['mid', 'songmid', 'songid', 'id', 'hash', 'rid', 'musicId', 'copyrightId']) {
      if (info.meta[key] != null) info.meta[key] = '';
    }
    for (const platformKey of ['qq', 'wy', 'kw', 'kg', 'mg']) {
      if (info.meta[platformKey] && typeof info.meta[platformKey] === 'object') {
        info.meta[platformKey] = {};
      }
    }
  }
  info.meta.mid ??= info.songmid;
  info.meta.songmid ??= info.songmid;
  info.meta.songid ??= info.id;
  info.meta.id ??= info.id;
  info.meta.hash ??= info.hash;
  if (source === 'tx') {
    info.meta.qq = { ...(info.meta.qq || {}), mid: info.songmid, songmid: info.songmid, songid: info.id };
    info.strMediaMid ??= info.songmid;
  } else if (source === 'wy') {
    info.meta.wy = { ...(info.meta.wy || {}), id: info.id };
  } else if (source === 'kw') {
    info.meta.kw = { ...(info.meta.kw || {}), id: info.songmid, rid: info.songmid };
  } else if (source === 'kg') {
    info.meta.kg = { ...(info.meta.kg || {}), id: info.id, hash: info.hash };
  } else if (source === 'mg') {
    info.meta.mg = { ...(info.meta.mg || {}), id: info.id, copyrightId: info.copyrightId };
  }
  return info;
}

// —— 脚本返回值中提取播放 URL / headers（上游 :901-978，无状态）——
function normalizeExtractedHttpUrl(text) {
  text = String(text || '').trim();
  if (!text) return '';
  text = text.replace(/\\\//g, '/').replace(/^['"]|['"]$/g, '').trim();
  if (/^\/\//.test(text)) text = 'https:' + text;
  if (/^https?:\/\//i.test(text)) return text;
  const embedded = text.match(/https?:\\?\/\\?\/[^\s"'<>]+/i);
  if (embedded) return normalizeExtractedHttpUrl(embedded[0]);
  try {
    const decoded = decodeURIComponent(text);
    if (decoded !== text) return normalizeExtractedHttpUrl(decoded);
  } catch (_err) {}
  return '';
}

function extractHttpUrl(value, depth = 0) {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    const direct = normalizeExtractedHttpUrl(text);
    if (direct) return direct;
    try { return extractHttpUrl(JSON.parse(text), depth + 1); } catch (_err) { return ''; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractHttpUrl(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const key of ['url', 'musicUrl', 'music_url', 'playUrl', 'play_url', 'audio', 'src', 'link', 'location', 'href', 'file', 'purl']) {
      const found = extractHttpUrl(value[key], depth + 1);
      if (found) return found;
    }
    for (const key of ['data', 'body', 'result', 'music', 'song', 'info', 'response']) {
      const found = extractHttpUrl(value[key], depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function sanitizePlaybackHeaders(headers) {
  const out = {};
  const allowed = new Set(['accept', 'cookie', 'origin', 'referer', 'referrer', 'user-agent']);
  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const key = String(rawKey || '').trim().toLowerCase();
    if (!allowed.has(key) || rawValue == null) continue;
    const normalizedKey = key === 'referrer' ? 'referer' : key;
    out[normalizedKey] = sanitizeHeaderValue(rawValue);
  }
  return out;
}

function extractPlaybackHeaders(value, depth = 0) {
  if (depth > 5 || value == null) return {};
  if (typeof value === 'string') {
    try { return extractPlaybackHeaders(JSON.parse(value), depth + 1); } catch (_err) { return {}; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractPlaybackHeaders(item, depth + 1);
      if (Object.keys(found).length) return found;
    }
    return {};
  }
  if (typeof value !== 'object') return {};
  for (const key of ['headers', 'header', 'requestHeaders', 'playHeaders', 'audioHeaders', 'proxyHeaders']) {
    const headers = sanitizePlaybackHeaders(value[key]);
    if (Object.keys(headers).length) return headers;
  }
  for (const key of ['data', 'body', 'result', 'music', 'song', 'info', 'response']) {
    const found = extractPlaybackHeaders(value[key], depth + 1);
    if (Object.keys(found).length) return found;
  }
  return {};
}

// —— Range 魔数探测（批 T3：移植上游 :980-1062；electronFetch→注入点 fetchImpl 参数化，
//    :1019 User-Agent 'Mozilla/5.0 Mineradio/1.5' 做身份转换改 Stellaflix 探测 UA，
//    Range bytes=0-131071 前 128KB 采样与 FLAC/WAV/M4A 魔数、MP3 帧头解析照抄）——
function readMp3FrameInfo(bytes) {
  let offset = 0;
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    offset = 10 + ((bytes[6] & 0x7f) << 21) + ((bytes[7] & 0x7f) << 14) +
      ((bytes[8] & 0x7f) << 7) + (bytes[9] & 0x7f);
  }
  const mpeg1Rates = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
  const mpeg2Rates = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
  const sampleRates = {
    3: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    0: [11025, 12000, 8000],
  };
  for (let i = Math.max(0, offset); i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[i + 1] >> 3) & 3;
    const layer = (bytes[i + 1] >> 1) & 3;
    const bitrateIndex = (bytes[i + 2] >> 4) & 15;
    const sampleIndex = (bytes[i + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) continue;
    const rates = version === 3 ? mpeg1Rates : mpeg2Rates;
    return {
      codec: 'mp3',
      lossless: false,
      bitrate: rates[bitrateIndex] * 1000,
      sampleRate: sampleRates[version][sampleIndex],
    };
  }
  return null;
}

async function probeAudioUrl(url, playbackHeaders, fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new Error('LX_AUDIO_PROBE_UNAVAILABLE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = sanitizeHeaders(Object.assign({
      Range: 'bytes=0-131071',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Stellaflix/LXSource',
      Accept: 'audio/*,*/*;q=0.8',
    }, playbackHeaders || {}));
    headers.Range = 'bytes=0-131071';
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers,
    });
    if (!response.ok && response.status !== 206) throw new Error(`LX_AUDIO_PROBE_HTTP_${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
      let sampleRate = 0;
      let bitDepth = 0;
      if (bytes.length >= 26 && (bytes[4] & 0x7f) === 0) {
        sampleRate = (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4);
        bitDepth = (((bytes[20] & 1) << 4) | (bytes[21] >> 4)) + 1;
      }
      return { codec: 'flac', lossless: true, bitrate: 0, sampleRate, bitDepth };
    }
    if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
      return { codec: 'wav', lossless: true, bitrate: 0, sampleRate: 0 };
    }
    if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      return { codec: 'm4a', lossless: false, bitrate: 0, sampleRate: 0 };
    }
    const mp3 = readMp3FrameInfo(bytes);
    if (mp3) return mp3;
    throw new Error('LX_AUDIO_FORMAT_UNVERIFIED');
  } finally {
    clearTimeout(timer);
  }
}

function audioProbeSatisfiesQuality(probe, quality) {
  if (!probe) return false;
  if (['master', 'flac24bit'].includes(quality)) return probe.lossless === true && probe.bitDepth >= 24;
  if (quality === 'hires') {
    return probe.lossless === true && (probe.bitDepth >= 24 || probe.sampleRate > 48000);
  }
  if (quality === 'flac') return probe.lossless === true;
  if (quality === '320k') return probe.lossless === true || probe.bitrate >= 256000;
  return probe.lossless === true || probe.bitrate >= 96000;
}

// —— 音质变体与降级候选表（上游 :1064-1084，无状态；T3 已落探测判定）——
const QUALITY_ALIASES = Object.freeze({
  master: ['master', 'flac24bit', 'hires', 'lossless', 'flac'],
  atmos_plus: ['atmos_plus', 'atmos', 'master', 'flac24bit', 'hires', 'flac'],
  flac24bit: ['flac24bit', '24bit', '24BIT', 'hires', 'flac'],
  hires: ['hires', 'flac24bit', '24bit', 'flac'],
  flac: ['flac', 'lossless', 'ape'],
  '320k': ['320k', '320', '320K', 'high'],
  '128k': ['128k', '128', '128K', 'standard'],
});

function qualityVariants(quality) {
  const key = String(quality || '').trim();
  const variants = [key, ...(QUALITY_ALIASES[key] || [])].filter(Boolean);
  return variants.filter((item, index) => variants.indexOf(item) === index);
}

function sourceSupportsQuality(supported, quality) {
  if (!Array.isArray(supported) || !supported.length) return true;
  const normalized = new Set(supported.map(item => String(item || '').trim().toLowerCase()).filter(Boolean));
  return qualityVariants(quality).some(item => normalized.has(String(item || '').toLowerCase()));
}

// —— 音质降级链（上游 :1092-1100 fallbackMap；提为模块级并经 fallbackChainFor 导出，
//    供计划 T3 Interfaces/Task 9 前端词汇表经路由引用；未知档回退 :1136 默认链）——
const QUALITY_FALLBACK_MAP = Object.freeze({
  master: ['master', 'flac24bit', 'hires', 'flac', '320k', '128k'],
  atmos_plus: ['atmos_plus', 'master', 'flac24bit', 'hires', 'flac', '320k', '128k'],
  flac24bit: ['flac24bit', 'hires', 'flac', '320k', '128k'],
  hires: ['hires', 'flac', '320k', '128k'],
  flac: ['flac', '320k', '128k'],
  '320k': ['320k', '128k'],
  '128k': ['128k'],
});

function fallbackChainFor(quality) {
  const key = String(quality || '').trim();
  return (QUALITY_FALLBACK_MAP[key] || [key, 'flac', '320k', '128k']).slice();
}

/**
 * 工厂：每个实例持有独立的存储目录与运行时缓存。
 * initTimeoutMs / checkTimeoutMs / fetchImpl 为我方测试注入点
 * （上游硬编码 10s/12s 与 electron fetch；checkTimeoutMs 默认 12000 对齐上游 :685 封顶）。
 */
function createLxSourceHost({ userDataPath, initTimeoutMs = 10000, checkTimeoutMs = 12000, fetchImpl = fetch } = {}) {
  if (!userDataPath) throw new Error('LX_SOURCE_USER_DATA_PATH_REQUIRED');

  // 身份转换（上游 :28-30）：%APPDATA%\Mineradio\sources → userDataPath/sources
  const SOURCE_DIR = path.join(userDataPath, 'sources');
  const SOURCE_FILE = path.join(SOURCE_DIR, 'active-source.json');
  const SOURCES_FILE = path.join(SOURCE_DIR, 'sources.json');

  let runtime = null;
  let loading = null;
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : null;
  // 回退链惰性 runtime 缓存与 musicUrl 90s LRU 缓存（上游 :80,1086；实例级而非模块级）
  const fallbackRuntimeCache = new Map();
  const musicUrlCache = new Map();

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

  // —— 全部可轮换脚本记录（上游 :164-177；含 LxDatas 迁移记录，按脚本指纹去重）——
  function allScriptRecords() {
    const store = readSourceStore();
    const records = store.records.filter(item => item.enabled !== false).slice();
    const saved = readFirstLxJson('user_api.json');
    const userApis = saved && (Array.isArray(saved) ? saved : saved.userApis);
    if (Array.isArray(userApis)) records.push(...userApis.filter(item => item && typeof item.script === 'string'));
    const seen = new Set();
    return records.filter(record => {
      const fingerprint = crypto.createHash('sha1').update(record.script).digest('hex');
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    });
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
      // installed 快照对齐上游 :616；id 字段为我方新增。
      return { ok: true, id: record.id, name: hostRuntime.name, version: hostRuntime.version, sources: hostRuntime.sources, installed: listSources() };
    } catch (err) {
      store.activeId = previousId;
      writeSourceStore(store);
      runtime = null;
      throw err;
    }
  }

  // —— 批量启停（上游 :630-671；T2 审查携带：停用的脚本必须同步清 fallbackRuntimeCache，
  //    上游对等价缓存的操作见 :727/:771——否则停用脚本仍可被轮换命中）——
  async function setSourcesEnabled(ids, enabled) {
    const sourceIds = normalizeSourceIds(ids);
    if (!sourceIds.length) throw new Error('LX_SOURCE_IDS_REQUIRED');
    const nextEnabled = enabled !== false;
    const previousStore = readSourceStore();
    const existing = new Set(previousStore.records.map(item => item.id));
    if (sourceIds.some(id => !existing.has(id))) throw new Error('LX_SOURCE_NOT_FOUND');

    const nextRecords = previousStore.records.map(item =>
      sourceIds.includes(item.id) ? { ...item, enabled: nextEnabled } : item
    );
    let nextActiveId = previousStore.activeId;
    if (!nextEnabled && sourceIds.includes(nextActiveId)) {
      const fallback = nextRecords.find(item => item.enabled !== false);
      if (!fallback) throw new Error('LX_SOURCE_AT_LEAST_ONE_ENABLED');
      nextActiveId = fallback.id;
    }
    const nextStore = { activeId: nextActiveId, records: nextRecords };
    const previousActive = previousStore.records.find(item => item.id === previousStore.activeId);
    const nextActive = nextRecords.find(item => item.id === nextActiveId);
    writeSourceStore(nextStore);
    if (!nextEnabled) sourceIds.forEach(id => fallbackRuntimeCache.delete(id));
    if (nextActive) fs.writeFileSync(SOURCE_FILE, JSON.stringify(nextActive), 'utf8');
    const activeChanged = previousStore.activeId !== nextActiveId;
    if (activeChanged) runtime = null;
    try {
      const hostRuntime = await getRuntime(activeChanged);
      return {
        ok: true,
        name: hostRuntime.name,
        version: hostRuntime.version,
        sources: hostRuntime.sources,
        installed: listSources(),
      };
    } catch (err) {
      writeSourceStore(previousStore);
      try {
        if (previousActive) fs.writeFileSync(SOURCE_FILE, JSON.stringify(previousActive), 'utf8');
      } catch (_err) {}
      runtime = null;
      throw err;
    }
  }

  // —— checkSources 试跑（上游 :673-708；返回按计划 Interfaces 拍平的 [{id, ok, sources, error}] 数组）——
  // 语义：逐脚本起沙箱（createRuntime 要求 inited + request handler），单脚本 checkTimeoutMs（默认 12s）封顶；
  // 上游无逐源动作冒烟（:685-694 仅起运行时并枚举 sources），本移植照上游语义。
  async function checkSources(ids) {
    const store = readSourceStore();
    const sourceIds = (ids === undefined || ids === null)
      ? store.records.map(item => item.id)
      : normalizeSourceIds(ids);
    if (!sourceIds.length) throw new Error('LX_SOURCE_IDS_REQUIRED');
    const checked = [];
    for (const id of sourceIds) {
      const record = store.records.find(item => item.id === id);
      if (!record) {
        checked.push({ id, ok: false, error: 'LX_SOURCE_NOT_FOUND' });
        continue;
      }
      try {
        const hostRuntime = await withTimeout(createRuntime(record), checkTimeoutMs, 'LX_SOURCE_CHECK_TIMEOUT');
        checked.push({
          id,
          ok: true,
          name: record.name || hostRuntime.name || '未命名音源',
          version: record.version || hostRuntime.version || '',
          enabled: record.enabled !== false,
          current: record.id === store.activeId,
          sources: Object.keys(hostRuntime.sources || {}),
        });
      } catch (err) {
        checked.push({
          id,
          ok: false,
          name: record.name || '未命名音源',
          version: record.version || '',
          enabled: record.enabled !== false,
          current: record.id === store.activeId,
          error: err && err.message ? err.message : 'LX_SOURCE_CHECK_FAILED',
        });
      }
    }
    return checked;
  }

  // —— 删除（上游 :710-752 单删 / :754-795 批删；fallbackRuntimeCache 随删清见 :727/:771）——
  async function deleteSource(id) {
    id = String(id || '');
    const previousStore = readSourceStore();
    const target = previousStore.records.find(item => item.id === id);
    if (!target) throw new Error('LX_SOURCE_NOT_FOUND');

    const nextRecords = previousStore.records.filter(item => item.id !== id);
    const nextStore = {
      activeId: previousStore.activeId === id ? (nextRecords[0] && nextRecords[0].id || '') : previousStore.activeId,
      records: nextRecords,
    };
    if (nextStore.activeId && !nextRecords.some(item => item.id === nextStore.activeId)) {
      nextStore.activeId = nextRecords[0] && nextRecords[0].id || '';
    }

    const previousActive = previousStore.records.find(item => item.id === previousStore.activeId);
    writeSourceStore(nextStore);
    fallbackRuntimeCache.delete(id);

    if (!nextRecords.length) {
      try { fs.unlinkSync(SOURCE_FILE); } catch (_err) {}
      runtime = null;
      return { ok: true, name: '未配置', version: '', sources: {}, installed: [] };
    }

    const activeRecord = nextRecords.find(item => item.id === nextStore.activeId) || nextRecords[0];
    nextStore.activeId = activeRecord.id;
    writeSourceStore(nextStore);
    fs.writeFileSync(SOURCE_FILE, JSON.stringify(activeRecord), 'utf8');

    try {
      const hostRuntime = await getRuntime(previousStore.activeId === id);
      return { ok: true, name: hostRuntime.name, version: hostRuntime.version, sources: hostRuntime.sources, installed: listSources() };
    } catch (err) {
      writeSourceStore(previousStore);
      try {
        if (previousActive) fs.writeFileSync(SOURCE_FILE, JSON.stringify(previousActive), 'utf8');
        else fs.unlinkSync(SOURCE_FILE);
      } catch (_err) {}
      runtime = null;
      throw err;
    }
  }

  async function deleteSources(ids) {
    const uniqueIds = normalizeSourceIds(ids);
    if (!uniqueIds.length) throw new Error('LX_SOURCE_DELETE_IDS_REQUIRED');
    const deleteSet = new Set(uniqueIds);
    const previousStore = readSourceStore();
    const existingIds = new Set(previousStore.records.map(item => item.id));
    const missing = uniqueIds.filter(id => !existingIds.has(id));
    if (missing.length) throw new Error('LX_SOURCE_NOT_FOUND');

    const nextRecords = previousStore.records.filter(item => !deleteSet.has(item.id));
    const activeWasDeleted = deleteSet.has(previousStore.activeId);
    const nextStore = {
      activeId: activeWasDeleted ? (nextRecords[0] && nextRecords[0].id || '') : previousStore.activeId,
      records: nextRecords,
    };
    const previousActive = previousStore.records.find(item => item.id === previousStore.activeId);
    writeSourceStore(nextStore);
    uniqueIds.forEach(id => fallbackRuntimeCache.delete(id));

    if (!nextRecords.length) {
      try { fs.unlinkSync(SOURCE_FILE); } catch (_err) {}
      runtime = null;
      return { ok: true, deleted: uniqueIds.length, name: '未配置', version: '', sources: {}, installed: [] };
    }

    const activeRecord = nextRecords.find(item => item.id === nextStore.activeId) || nextRecords[0];
    nextStore.activeId = activeRecord.id;
    writeSourceStore(nextStore);
    fs.writeFileSync(SOURCE_FILE, JSON.stringify(activeRecord), 'utf8');
    try {
      const hostRuntime = await getRuntime(activeWasDeleted);
      return { ok: true, deleted: uniqueIds.length, name: hostRuntime.name, version: hostRuntime.version, sources: hostRuntime.sources, installed: listSources() };
    } catch (err) {
      writeSourceStore(previousStore);
      try {
        if (previousActive) fs.writeFileSync(SOURCE_FILE, JSON.stringify(previousActive), 'utf8');
        else fs.unlinkSync(SOURCE_FILE);
      } catch (_err) {}
      runtime = null;
      throw err;
    }
  }

  // —— URL 下载 + importSourceUrl（上游 :797-831；5MB 正文上限 :809；electron fetch→fetchImpl 注入位）——
  function downloadSourceScript(sourceUrl) {
    return new Promise((resolve, reject) => {
      lxRequest(sourceUrl, {
        method: 'GET',
        timeout: 20000,
        headers: { accept: 'application/javascript,text/javascript,text/plain,*/*' },
      }, (err, response) => {
        if (err) return reject(err);
        if (!response || response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`LX_SOURCE_DOWNLOAD_HTTP_${response && response.statusCode || 0}`));
        }
        const raw = Buffer.isBuffer(response.raw) ? response.raw : Buffer.from(String(response.body || ''));
        if (!raw.length || raw.length > 5 * 1024 * 1024) return reject(new Error('LX_SOURCE_FILE_INVALID'));
        resolve(raw.toString('utf8'));
      });
    });
  }

  async function importSourceUrl(urlOrApiKey) {
    let sourceUrl = normalizeImportSourceUrl(urlOrApiKey);
    let script;
    try {
      script = await downloadSourceScript(sourceUrl);
    } catch (err) {
      // 上游 :820-825：HTTPS 证书类失败对 ynx 域降级 http 重试一次。
      // （ynx https 已在 normalize 预降级，本分支为上游同款防御路径。）
      const fallbackUrl = sourceUrlHttpFallback(sourceUrl, err);
      if (!fallbackUrl) throw err;
      sourceUrl = fallbackUrl;
      script = await downloadSourceScript(sourceUrl);
    }
    let fileName = 'remote-source.js';
    try {
      fileName = decodeURIComponent(path.basename(new URL(sourceUrl).pathname)) || fileName;
    } catch (_err) {}
    // 本移植 importSource 签名为 (name, script)（T1 定），上游为 (script, fileName)。
    return importSource(fileName, script);
  }

  // —— 解析器回退链 + 90s LRU 缓存 + 音质探测（上游 :1087-1218 + :1158-1185，T2/T3 已全量落地）——
  // 接口签名为我方约定的对象参数（上游为位置参数 source, musicInfo, quality, options）。
  async function resolveMusicUrl({ source, quality, musicInfo, excludeResolvers, maxResolvers } = {}) {
    const excludedResolvers = new Set((Array.isArray(excludeResolvers) ? excludeResolvers : [])
      .map(item => String(item || '').trim().toLowerCase()).filter(Boolean));
    const requested = String(quality || '').trim();
    const normalizedInfo = normalizeMusicInfo(source, musicInfo);
    const cacheKey = [
      source,
      normalizedInfo.songmid || normalizedInfo.id || normalizedInfo.hash || normalizedInfo.copyrightId || '',
      requested,
    ].join('|');
    const cached = musicUrlCache.get(cacheKey);
    if (!excludedResolvers.size && cached && Date.now() - cached.time < 90 * 1000) {
      // cached 字段为我方新增（上游无），供调用方区分命中缓存与真实解析。
      return { ok: true, source, ...cached.value, cached: true };
    }
    const activeHost = await getRuntime();
    // 上游 :1110-1113：选中脚本先行，其余已装脚本惰性建 runtime 按短而确定的顺序回退轮换，
    // 避免一次点击扇出到 20+ 脚本并等待全局超时。
    const hostLoaders = [async () => activeHost];
    for (const record of allScriptRecords()) {
      if (record.id === activeHost.id) continue;
      hostLoaders.push(async () => {
        if (!fallbackRuntimeCache.has(record.id)) {
          fallbackRuntimeCache.set(record.id, createRuntime(record).catch(err => {
            fallbackRuntimeCache.delete(record.id);
            throw err;
          }));
        }
        return fallbackRuntimeCache.get(record.id);
      });
    }
    const maxResolverCount = Math.max(1, Math.min(8, Number(maxResolvers) || 6));
    const resolveWithHost = async (host) => {
      if (excludedResolvers.has(String(host.name || '').trim().toLowerCase()) ||
          excludedResolvers.has(String(host.id || '').trim().toLowerCase())) {
        throw new Error('LX_SOURCE_EXCLUDED');
      }
      const supported = Array.isArray(host.sources[source]?.qualitys) ? host.sources[source].qualitys : [];
      // 上游 :1134-1136 对「念心音源」脚本的 320k-first 硬编码不移植（生态包袱，
      // 我方无该脚本用户；计划 T3 例外条款）——统一走降级链，2 候选×2 变体上限（:1137-1146）。
      const rawCandidates = fallbackChainFor(requested)
      const candidates = rawCandidates
        .filter((item, index, all) => item && sourceSupportsQuality(supported, item) && all.indexOf(item) === index)
        .slice(0, 2);
      if (!host.sources[source] || !candidates.length) throw new Error('LX_QUALITY_UNSUPPORTED');
      const hostErrors = [];
      for (const candidate of candidates) {
        const candidateVariants = qualityVariants(candidate)
          .filter((item, index, all) => item && sourceSupportsQuality(supported, item) && all.indexOf(item) === index)
          .slice(0, 2);
        for (const candidateVariant of candidateVariants) {
          try {
            const result = await withTimeout(
              host.request(source, 'musicUrl', { type: candidateVariant, quality: candidateVariant, musicInfo: normalizedInfo }),
              LX_ACTION_TIMEOUT_MS,
              `LX_SOURCE_TIMEOUT_${candidateVariant}`
            );
            // 我方新增：ok:false 为脚本失败信号（上游仅以 url 有无判定；测试 fixture 亦用此约定）。
            if (result && typeof result === 'object' && result.ok === false) {
              throw new Error(String(result.msg || result.message || '') || 'LX_SOURCE_RESOLVE_FAILED');
            }
            let url = extractHttpUrl(result);
            const playbackHeaders = extractPlaybackHeaders(result);
            if (/^http:\/\/mcp\.nianxinxz\.com\//i.test(url)) {
              url = url.replace(/^http:/i, 'https:');
            }
            if (url) {
              // —— 批 T3：Range 魔数探测（上游 :1158-1185）。探测仅 advisory：
              // 供应商静默降档时 resolver 的 URL 依然可用，由播放代理/下载写入做终验
              // （:1164-1168 注释语义）；只有 404/410 明确死链才跳过该候选换下一档/下一 resolver
              // （:1180-1182），其余探测失败保留 URL 并带 probeWarning。
              let probe = null;
              let probeWarning = '';
              try {
                probe = await probeAudioUrl(url, playbackHeaders, fetchFn);
                if (!audioProbeSatisfiesQuality(probe, requested)) {
                  probeWarning = `LX_AUDIO_QUALITY_DOWNGRADED_${probe.codec}_${probe.bitrate || 0}`;
                  hostErrors.push(`${candidate}:${probeWarning}`);
                }
              } catch (probeErr) {
                const probeMessage = probeErr && probeErr.message ? probeErr.message : 'LX_AUDIO_PROBE_FAILED';
                hostErrors.push(`${candidate}:${probeMessage}`);
                probeWarning = probeMessage;
                if (/^LX_AUDIO_PROBE_HTTP_(?:404|410)$/i.test(probeMessage)) continue;
              }
              return {
                url,
                headers: playbackHeaders,
                quality: candidateVariant,
                requestedQuality: candidate,
                actual: probe,
                probeWarning,
                resolver: host.name,
              };
            }
            hostErrors.push(`${candidateVariant}:LX_SOURCE_URL_INVALID`);
          } catch (err) {
            hostErrors.push(`${candidateVariant}:${err && err.message ? err.message : 'LX_SOURCE_RESOLVE_FAILED'}`);
          }
        }
      }
      throw new Error(hostErrors.join(';') || 'LX_SOURCE_RESOLVE_FAILED');
    };
    const errors = [];
    let tried = 0;
    for (const loadHost of hostLoaders) {
      if (tried >= maxResolverCount) break;
      let host;
      try {
        host = await withTimeout(loadHost(), 2500, 'LX_SOURCE_INIT_TIMEOUT');
        if (excludedResolvers.has(String(host.name || '').trim().toLowerCase()) ||
            excludedResolvers.has(String(host.id || '').trim().toLowerCase())) continue;
        tried++;
        const value = await withTimeout(resolveWithHost(host), 8000, 'LX_SOURCE_RESOLVER_TIMEOUT');
        if (value && value.url) {
          musicUrlCache.set(cacheKey, { time: Date.now(), value });
          if (musicUrlCache.size > 120) musicUrlCache.delete(musicUrlCache.keys().next().value);
          return { ok: true, source, ...value };
        }
      } catch (error) {
        errors.push(`${host && host.name ? host.name : 'unknown'}:${error && error.message ? error.message : 'LX_SOURCE_RESOLVE_FAILED'}`);
      }
    }
    if (errors.length) console.warn('[LXSourceSequentialRejected]', errors);
    throw new Error(tried
      ? '当前音源及备用音源均解析失败，请切换音源后重试'
      : '没有可用于这首歌的音源');
  }

  // —— 后续任务占位：接口名锁定本计划 Interfaces 块（裁决：getLyric 归 T7 路由一并移植；
  //    picAction 上游无实现，维持占位不凭猜实现）——
  const notImplemented = task => () => { throw new Error(`LX_SOURCE_NOT_IMPLEMENTED:${task}`); };

  return {
    importSource,
    importSourceUrl,
    selectSource,
    setSourcesEnabled,
    deleteSource,
    deleteSources,
    listSources,
    checkSources,
    resolveMusicUrl,
    getLyric: notImplemented('T7'),
    picAction: notImplemented('PIC_NO_UPSTREAM_IMPL'),
  };
}

module.exports = {
  createLxSourceHost, QUALITY_ALIASES, fallbackChainFor,
  normalizeImportSourceUrl, sourceUrlHttpFallback,
};
