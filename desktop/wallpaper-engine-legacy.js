/*
 * wallpaper-engine-legacy.js
 * ---------------------------------------------------------------------------
 * 为旧版 Stellaflix 分支（Electron <= 15 / Node 12 等效、无构建转译链）提供的
 * Wallpaper Engine 集成兼容实现。作为「独立兼容模块」接入，不修改现有壁纸文件。
 *
 * 兼容性适配要点（低版本不支持的 API 已全部规避）：
 *  - 不使用 protocol.handle()：改用 app 就绪后注册的 registerStreamProtocol()。
 *  - 不使用 Web Streams（Response / Readable.toWeb）：媒体流用 Node Readable + Buffer。
 *  - 不使用可选链 ?. / 空值合并 ??：全部展开为显式判空。
 *  - 不使用 Array.flat / Object.fromEntries：用 for-of + push 手工展平。
 *  - 保留：class / async-await / const-let / 箭头函数 / Promise / Set-Map / Buffer。
 *
 * 该模块仅依赖 Node 内置模块（fs/path/crypto/child_process）与 Electron 的
 * app/screen/session 对象，以及 Windows 上的 powershell.exe。
 * 设计目标：旧版即便运行在 macOS / Linux 也能安全 no-op（isSupported()=false），
 * 而 Windows 旧 Electron 分支可复用本模块的库发现 / 静音补丁 / 媒体流协议能力。
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Readable } = require('stream');

const WALLPAPER_ENGINE_SCHEME = 'stellaflix-wallpaper-legacy';
const WALLPAPER_ENGINE_APP_ID = '431960';
const CONFIG_FILE = 'wallpaper-engine-legacy-library.json';
const MAX_PROJECT_JSON_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 30 * 1000;
const MAX_MANUAL_SCAN_DIRS = 4000;
const SCENE_PACKAGE_EXTENSIONS = makeSet(['.pkg', '.pak']);
const IMAGE_MIME = makeMap([['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'], ['.gif', 'image/gif']]);
const VIDEO_MIME = makeMap([['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.m4v', 'video/mp4'], ['.mov', 'video/quicktime']]);
const SAFE_MIME = mergeMaps(IMAGE_MIME, VIDEO_MIME);

// ---- 低版本友好小工具（不用 fromEntries / flat / ?. ??） ----
function makeSet(arr) { const s = new Set(); arr.forEach(function (x) { s.add(x); }); return s; }
function makeMap(pairs) { const m = new Map(); pairs.forEach(function (p) { m.set(p[0], p[1]); }); return m; }
function mergeMaps(a, b) { const m = new Map(); a.forEach(function (v, k) { m.set(k, v); }); b.forEach(function (v, k) { m.set(k, v); }); return m; }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeGet(obj, key) { return isObject(obj) ? obj[key] : undefined; }

const AUDIO_PROPERTY_HINT = /(?:\bvolume\b|\bmute(?:d)?\b|\bsilent\b|\baudio\s*(?:volume|level|gain|enable|enabled|toggle)\b|\bmusic\s*(?:volume|level|gain|size|enable|enabled|toggle)\b|\bsound\s*(?:volume|level|gain|enable|enabled|toggle)\b|音量|静音|无声|音乐(?:大小|音量|开关)|声音(?:大小|音量|开关)|音效(?:大小|音量|开关))/i;
const AUDIO_PROPERTY_KEY = /^(?:volume|dbvolume|musicvolume|music_volume|audiovolume|audio_volume|soundvolume|sound_volume|bgmvolume|bgm_volume|muteaudio|audiomute|mutemusic|musicmute|music|audio|sound|bgm)$/i;
const AUDIO_STANDALONE_LABEL = /^(?:(?:background\s*(?:audio|music|sound)|背景(?:音频|音乐|声音))|(?:audio|music|sound|bgm|音频|音乐|声音)(?:[\s,，、/_-]*(?:audio|music|sound|bgm|音频|音乐|声音|\d+))*)$/i;
const AUDIO_VISUAL_HINT = /(?:visuali[sz](?:er|ation)|\bbars?\b|\bring\b|\bpulse\b|\bthreshold\b|\bsensitiv(?:e|ity)\b|\bintensity\b|\bcolou?r\b|\bopacity\b|\btransparen(?:cy|t)\b|\bbounce\b|\bflicker\b|\balbum\b|\binformation\b|\bresponse\b|\breactive\b|\bfrequency\b|\bspectrum\b|\bwave\b|\bnote\b|可视|频谱|跳动|闪烁|响应|颜色|透明|专辑|封面|信息)/i;
const BLOCKED_PROPERTY_KEYS = makeSet(['__proto__', 'prototype', 'constructor']);
const SAFE_PROPERTY_KEY = /^[a-z0-9_.-]{1,128}$/i;
const MAX_SCENE_PROPERTIES = 256;
const MAX_PROPERTY_OPTIONS = 64;

function normalizeAbsolutePath(value) {
  const raw = String(value == null ? '' : value).trim().replace(/^"|"$/g, '');
  if (!raw) return '';
  try { return path.resolve(raw); } catch (_) { return ''; }
}
function pathKey(value) {
  return normalizeAbsolutePath(value).replace(/[\\/]+$/, '').toLowerCase();
}
function opaqueId(value) {
  return crypto.createHash('sha256').update(pathKey(value)).digest('hex').slice(0, 24);
}
function sanitizeText(value, fallback) {
  const text = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return text || String(fallback == null ? 'Wallpaper Engine' : fallback);
}
function sanitizePropertyLabel(value, fallback) {
  return sanitizeText(String(value == null ? '' : value)
    .replace(/<[^>]{0,512}>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, ' '), fallback);
}
function normalizeScenePropertyValue(value, maximumLength) {
  maximumLength = maximumLength || 512;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximumLength);
  }
  return null;
}

function analyzeSceneProperties(project) {
  const muteProperties = Object.create(null);
  muteProperties.volume = 0;
  const descriptors = [];
  const properties = isObject(project) ? safeGet(safeGet(project, 'general'), 'properties') : null;
  if (!isObject(properties)) {
    return { properties: descriptors, muteProperties: cloneObj(muteProperties), propertyCount: 0, audioPropertyCount: 0, mutedAudioPropertyCount: 0 };
  }
  let audioPropertyCount = 0;
  let mutedAudioPropertyCount = 0;
  Object.keys(properties).forEach(function (rawKey) {
    if (descriptors.length >= MAX_SCENE_PROPERTIES) return;
    const key = String(rawKey == null ? '' : rawKey).trim();
    const property = properties[rawKey];
    if (!isObject(property)) return;
    if (!SAFE_PROPERTY_KEY.test(key) || BLOCKED_PROPERTY_KEYS.has(key.toLowerCase())) return;
    const type = String(safeGet(property, 'type') || '').trim().toLowerCase();
    const label = sanitizePropertyLabel(safeGet(property, 'text'), key);
    const hint = key + ' ' + label;
    const normalizedKey = key.replace(/[_.-]/g, '').toLowerCase();
    const exactAudioKey = AUDIO_PROPERTY_KEY.test(key);
    const explicitAudioControl = AUDIO_PROPERTY_HINT.test(hint)
      || normalizedKey === 'muteaudio' || normalizedKey === 'audiomute'
      || normalizedKey === 'mutemusic' || normalizedKey === 'musicmute'
      || normalizedKey === 'dbvolume'
      || normalizedKey === 'audioenable' || normalizedKey === 'audioenabled'
      || normalizedKey === 'musicenable' || normalizedKey === 'musicenabled'
      || normalizedKey === 'soundenable' || normalizedKey === 'soundenabled'
      || normalizedKey === 'bgmenable' || normalizedKey === 'bgmenabled';
    const visualOnly = AUDIO_VISUAL_HINT.test(hint) && !explicitAudioControl;
    const audioProperty = !visualOnly && (exactAudioKey || explicitAudioControl || AUDIO_STANDALONE_LABEL.test(label));
    let options = [];
    if (Array.isArray(safeGet(property, 'options'))) {
      options = property.options.slice(0, MAX_PROPERTY_OPTIONS).map(function (option, index) {
        const source = isObject(option) ? option : {};
        return { label: sanitizePropertyLabel(safeGet(source, 'label'), '选项 ' + (index + 1)), value: normalizeScenePropertyValue(safeGet(source, 'value'), 256) };
      }).filter(function (o) { return o.value !== null; });
    }
    const descriptor = { key: key, label: label, type: type.replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'unknown', value: normalizeScenePropertyValue(safeGet(property, 'value')), audio: audioProperty, autoMuted: false };
    const minimum = Number(safeGet(property, 'min'));
    const maximum = Number(safeGet(property, 'max'));
    const step = Number(safeGet(property, 'step'));
    if (Number.isFinite(minimum)) descriptor.min = minimum;
    if (Number.isFinite(maximum)) descriptor.max = maximum;
    if (Number.isFinite(step) && step > 0) descriptor.step = step;
    if (options.length) descriptor.options = options;
    if (audioProperty) {
      audioPropertyCount += 1;
      let muteValue;
      if (type === 'bool' || typeof safeGet(property, 'value') === 'boolean') {
        muteValue = normalizedKey === 'muteaudio' || normalizedKey === 'audiomute' || normalizedKey === 'mutemusic' || normalizedKey === 'musicmute' || /(?:静音|无声)/i.test(hint);
      } else if (type === 'slider' || typeof safeGet(property, 'value') === 'number') {
        if (normalizedKey === 'dbvolume' || /(?:db|分贝)/i.test(hint) || (Number.isFinite(minimum) && minimum < 0 && Number.isFinite(maximum) && maximum <= 0)) {
          muteValue = Number.isFinite(minimum) ? minimum : -60;
        } else if ((!Number.isFinite(minimum) || minimum <= 0) && (!Number.isFinite(maximum) || maximum >= 0)) {
          muteValue = 0;
        } else if (Number.isFinite(minimum)) {
          muteValue = minimum;
        }
      } else if (type === 'combo' && options.length) {
        const offOption = options.find(function (o) { return /(?:\bnone\b|\boff\b|\bmute(?:d)?\b|\bsilent\b|\bdisable(?:d)?\b|关闭|静音|无声|不要音乐|无音乐)/i.test(o.label); })
          || (exactAudioKey ? options.find(function (o) { return String(o.value) === '0'; }) : null);
        if (offOption) muteValue = offOption.value;
      }
      if (muteValue !== undefined && muteValue !== null) {
        muteProperties[key] = muteValue;
        descriptor.autoMuted = true;
        descriptor.muteValue = muteValue;
        mutedAudioPropertyCount += 1;
      }
    }
    descriptors.push(descriptor);
  });
  return { properties: descriptors, muteProperties: cloneObj(muteProperties), propertyCount: descriptors.length, audioPropertyCount: audioPropertyCount, mutedAudioPropertyCount: mutedAudioPropertyCount };
}
function cloneObj(obj) { const out = Object.create(null); Object.keys(obj).forEach(function (k) { out[k] = obj[k]; }); return out; }

function deriveWorkshopId(project, projectRoot, sourceKind) {
  const candidates = [safeGet(project, 'workshopid'), safeGet(project, 'workshopId'), safeGet(project, 'publishedfileid'), safeGet(project, 'publishedFileId'), safeGet(project, 'workshopurl'), safeGet(project, 'workshopUrl'), safeGet(project, 'url')];
  for (let i = 0; i < candidates.length; i += 1) {
    const value = String(candidates[i] == null ? '' : candidates[i]).trim();
    const direct = /^\d{5,32}$/.exec(value);
    if (direct) return direct[0];
    const urlMatch = /(?:[?&]id=|\/filedetails\/?)(\d{5,32})/i.exec(value);
    if (urlMatch) return urlMatch[1];
  }
  const directoryId = path.basename(String(projectRoot || ''));
  if (sourceKind === 'workshop' && /^\d{5,32}$/.test(directoryId)) return directoryId;
  return '';
}

function statSafe(target) {
  return new Promise(function (resolve) {
    fs.stat(target, function (err, stat) { resolve(err ? null : stat); });
  });
}
function isDirectory(target) {
  return statSafe(target).then(function (stat) { return !!(stat && stat.isDirectory()); });
}
function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function resolveProjectFile(projectRoot, value, allowedMime) {
  const raw = String(value == null ? '' : value).trim().replace(/\//g, path.sep);
  if (!raw || raw.indexOf('\0') >= 0 || path.isAbsolute(raw) || /^[a-z]:/i.test(raw) || raw.indexOf(':') >= 0) return Promise.resolve('');
  const lexicalRoot = path.resolve(projectRoot);
  const lexicalTarget = path.resolve(lexicalRoot, raw);
  if (!isInside(lexicalRoot, lexicalTarget)) return Promise.resolve('');
  const ext = path.extname(lexicalTarget).toLowerCase();
  if (!allowedMime.has(ext)) return Promise.resolve('');
  return Promise.all([safeRealpath(lexicalRoot), safeRealpath(lexicalTarget)]).then(function (paths) {
    const realRoot = paths[0], realTarget = paths[1];
    if (!realRoot || !realTarget) return '';
    if (!isInside(realRoot, realTarget)) return '';
    return fs.promises ? fs.promises.stat(realTarget).then(function (st) { return st.isFile() ? realTarget : ''; }, function () { return ''; })
      : statSafe(realTarget).then(function (st) { return st && st.isFile() ? realTarget : ''; });
  }, function () { return ''; });
}
function safeRealpath(p) {
  if (fs.promises && fs.promises.realpath) return fs.promises.realpath(p).catch(function () { return p; });
  return new Promise(function (resolve) { fs.realpath(p, function (err, rp) { resolve(err ? p : rp); }); });
}
function firstProjectFile(projectRoot, values, allowedMime) {
  let index = 0;
  function next() {
    if (index >= values.length) return Promise.resolve('');
    return resolveProjectFile(projectRoot, values[index], allowedMime).then(function (target) {
      return target || (function () { index += 1; return next(); })();
    });
  }
  return next();
}
function validateScenePackage(file) {
  if (!file || !SCENE_PACKAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) return Promise.resolve('');
  return new Promise(function (resolve) {
    fs.open(file, 'r', function (err, handle) {
      if (err) { resolve(''); return; }
      const header = Buffer.alloc(12);
      fs.read(handle, header, 0, header.length, 0, function (rerr, bytesRead) {
        fs.close(handle, function () {});
        if (rerr || bytesRead !== header.length) { resolve(''); return; }
        const sigStart = header.subarray(0, 8).toString('ascii');
        const sigAfter = header.subarray(4, 12).toString('ascii');
        resolve((/^PKGV\d{4}$/.test(sigStart) || /^PKGV\d{4}$/.test(sigAfter)) ? file : '');
      });
    });
  });
}
function execFileText(file, args) {
  return new Promise(function (resolve) {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 2500, maxBuffer: 256 * 1024 }, function (error, stdout) {
      resolve(error ? '' : String(stdout || ''));
    });
  });
}

function windowsSteamRegistryRoots() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const queries = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKCU\\Software\\Valve\\Steam', 'SteamExe'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath']
  ];
  return Promise.all(queries.map(function (q) {
    return execFileText('reg.exe', ['query', q[0], '/v', q[1]]).then(function (output) {
      const match = output.match(new RegExp(q[1] + '\\s+REG_\\w+\\s+(.+)$', 'mi'));
      if (!match) return '';
      let found = normalizeAbsolutePath(match[1].replace(/\//g, path.sep));
      if (/steam\.exe$/i.test(found)) found = path.dirname(found);
      return found;
    });
  })).then(function (results) {
    const roots = new Set();
    results.forEach(function (r) { if (r) roots.add(r); });
    return Array.from(roots);
  });
}
function readSteamLibraryFolders(steamRoot) {
  const roots = new Set([normalizeAbsolutePath(steamRoot)]);
  const files = [path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), path.join(steamRoot, 'config', 'libraryfolders.vdf')];
  return Promise.all(files.map(function (file) {
    return new Promise(function (resolve) {
      fs.readFile(file, 'utf8', function (err, text) {
        if (err) { resolve(); return; }
        const matches = String(text).replace(/^\uFEFF/, '').match(/"path"\s+"([^"]+)"/gi);
        if (matches) matches.forEach(function (m) { const mm = /"path"\s+"([^"]+)"/i.exec(m); if (mm) roots.add(normalizeAbsolutePath(mm[1])); });
        // vdf 数字键新格式
        const numMatches = String(text).replace(/^\uFEFF/, '').match(/"\d+"\s+"([a-z]:\\{1,2}[^"]+)"/gi);
        if (numMatches) numMatches.forEach(function (m) { const mm = /"(\d+)"\s+"([a-z]:\\{1,2}[^"]+)"/i.exec(m); if (mm) roots.add(normalizeAbsolutePath(mm[2])); });
        resolve();
      });
    });
  })).then(function () { return Array.from(roots); });
}
function discoverSteamLibraries() {
  const candidates = new Set([
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Steam'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam'),
    process.env.ProgramW6432 && path.join(process.env.ProgramW6432, 'Steam'),
    'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam',
    'D:\\Steam', 'D:\\SteamLibrary', 'E:\\Steam', 'E:\\SteamLibrary', 'F:\\Steam', 'F:\\SteamLibrary'
  ].filter(Boolean).map(normalizeAbsolutePath));
  return windowsSteamRegistryRoots().then(function (registryRoots) {
    registryRoots.forEach(function (r) { candidates.add(r); });
    const libraries = new Set();
    return Promise.all(Array.from(candidates).map(function (candidate) {
      return isDirectory(candidate).then(function (isDir) {
        if (!isDir) return;
        return readSteamLibraryFolders(candidate).then(function (libs) { libs.forEach(function (l) { libraries.add(normalizeAbsolutePath(l)); }); });
      });
    })).then(function () { return Array.from(libraries); });
  });
}
function knownWallpaperContainers(root) {
  return [path.join(root, 'steamapps', 'workshop', 'content', WALLPAPER_ENGINE_APP_ID), path.join(root, 'steamapps', 'common', 'wallpaper_engine', 'projects', 'myprojects')];
}
function directProjectDirectories(container) {
  const output = [];
  return new Promise(function (resolve) {
    fs.readdir(container, { withFileTypes: true }, function (err, entries) {
      if (err) { resolve(output); return; }
      const jobs = entries.filter(function (e) { return e.isDirectory(); }).map(function (entry) {
        const projectRoot = path.join(container, entry.name);
        return statSafe(path.join(projectRoot, 'project.json')).then(function (st) { if (st) output.push(projectRoot); });
      });
      Promise.all(jobs).then(function () { resolve(output); });
    });
  });
}
function manualProjectDirectories(root) {
  root = normalizeAbsolutePath(root);
  if (!root) return Promise.resolve([]);
  return isDirectory(root).then(function (isDir) {
    if (!isDir) return [];
    return statSafe(path.join(root, 'project.json')).then(function (st) {
      if (st) return [root];
      const known = [];
      return Promise.all(knownWallpaperContainers(root).map(function (container) {
        return isDirectory(container).then(function (cd) { if (cd) return directProjectDirectories(container).then(function (dirs) { dirs.forEach(function (d) { known.push(d); }); }); });
      })).then(function () {
        if (known.length) return known;
        const output = [];
        const queue = [{ dir: root, depth: 0 }];
        let visited = 0;
        function step() {
          if (!queue.length || visited >= MAX_MANUAL_SCAN_DIRS) return Promise.resolve(output);
          const current = queue.shift();
          return new Promise(function (resolve2) {
            fs.readdir(current.dir, { withFileTypes: true }, function (err, entries) {
              if (err) { resolve2(); return; }
              visited += entries.length;
              const jobs = entries.filter(function (e) { return e.isDirectory(); }).map(function (entry) {
                if (/^\./.test(entry.name) || /^(?:node_modules|cache|temp|tmp)$/i.test(entry.name)) return Promise.resolve();
                const child = path.join(current.dir, entry.name);
                return statSafe(path.join(child, 'project.json')).then(function (st) {
                  if (st) output.push(child);
                  else if (current.depth < 2) queue.push({ dir: child, depth: current.depth + 1 });
                });
              });
              Promise.all(jobs).then(resolve2);
            });
          }).then(step);
        }
        return step();
      });
    });
  });
}
function readProjectManifest(projectRoot) {
  const file = path.join(projectRoot, 'project.json');
  return statSafe(file).then(function (stat) {
    if (!stat || !stat.isFile() || stat.size <= 0 || stat.size > MAX_PROJECT_JSON_BYTES) return null;
    return new Promise(function (resolve) {
      fs.readFile(file, 'utf8', function (err, rawText) {
        if (err) { resolve(null); return; }
        let value;
        try { value = JSON.parse(String(rawText).replace(/^\uFEFF/, '')); } catch (_) { resolve(null); return; }
        if (!isObject(value)) { resolve(null); return; }
        Promise.all([safeRealpath(projectRoot), safeRealpath(file)]).then(function (paths) {
          if (!isInside(paths[0], paths[1])) { resolve(null); return; }
          resolve({ value: value, stat: stat, file: paths[1] });
        }, function () { resolve(null); });
      });
    });
  });
}
function mimeForPath(file) { return SAFE_MIME.get(path.extname(file).toLowerCase()) || 'application/octet-stream'; }
function parseByteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value == null ? '' : value).trim());
  if (!match) return null;
  if (!match[1] && !match[2]) return { invalid: true };
  let start, end;
  if (!match[1] && match[2]) {
    const suffix = Math.max(0, Number(match[2]) || 0);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Math.max(0, Number(match[1]) || 0);
    end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { invalid: true };
  return { start: start, end: end };
}

/**
 * LegacyWallpaperEngineLibrary
 * 仅依赖 Node 内置模块 + 文件系统的 Wallpaper Engine 库。
 * 媒体流使用 registerStreamProtocol（兼容旧 Electron），不使用 Web Streams。
 */
function LegacyWallpaperEngineLibrary(options) {
  options = options || {};
  this.userDataPath = normalizeAbsolutePath(options.userDataPath || process.cwd());
  this.configPath = normalizeAbsolutePath(options.configPath || path.join(this.userDataPath, CONFIG_FILE));
  this.autoDiscover = options.autoDiscover !== false;
  const config = this.readConfig();
  this.manualRoots = config.manualRoots;
  this.manualProjectFiles = config.manualProjectFiles;
  this.index = new Map();
  this.mediaToken = crypto.randomBytes(24).toString('hex');
  this.snapshot = null;
  this.scanPromise = null;
  this.queuedForceScan = null;
  this.protocolInstalled = false;
  this.disposed = false;
  this.generation = 0;
}
LegacyWallpaperEngineLibrary.prototype.readConfig = function () {
  try {
    const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    const manualRoots = Array.isArray(safeGet(raw, 'manualRoots'))
      ? raw.manualRoots.map(normalizeAbsolutePath).filter(Boolean).slice(0, 32) : [];
    const manualProjectFiles = Array.isArray(safeGet(raw, 'manualProjectFiles'))
      ? raw.manualProjectFiles.map(normalizeAbsolutePath).filter(Boolean).slice(0, 64) : [];
    return { version: 2, manualRoots: dedupe(manualRoots), manualProjectFiles: dedupe(manualProjectFiles) };
  } catch (_) {
    return { version: 2, manualRoots: [], manualProjectFiles: [] };
  }
};
LegacyWallpaperEngineLibrary.prototype.saveConfig = function () {
  const self = this;
  return new Promise(function (resolve, reject) {
    fs.mkdir(path.dirname(self.configPath), { recursive: true }, function (err) {
      if (err) { reject(err); return; }
      const temp = self.configPath + '.tmp';
      fs.writeFile(temp, JSON.stringify({ version: 2, manualRoots: self.manualRoots, manualProjectFiles: self.manualProjectFiles }, null, 2), 'utf8', function (werr) {
        if (werr) { reject(werr); return; }
        fs.rename(temp, self.configPath, function (rerr) {
          if (rerr) { fs.copyFile(temp, self.configPath, function () { resolve(); }); } else { resolve(); }
        });
      });
    });
  });
};
function dedupe(arr) { const seen = new Set(); const out = []; arr.forEach(function (x) { const k = pathKey(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }); return out; }

LegacyWallpaperEngineLibrary.prototype.addManualRoot = function (root) {
  const self = this;
  root = normalizeAbsolutePath(root);
  if (!root) return Promise.reject(new Error('请选择存在的 Wallpaper Engine 项目目录'));
  return isDirectory(root).then(function (isDir) {
    if (!isDir) return Promise.reject(new Error('请选择存在的 Wallpaper Engine 项目目录'));
    return manualProjectDirectories(root).then(function (dirs) {
      if (!dirs.length) return Promise.reject(new Error('所选目录中没有识别到 project.json'));
      if (!self.manualRoots.some(function (r) { return pathKey(r) === pathKey(root); })) {
        self.manualRoots.push(root);
        self.manualRoots = self.manualRoots.slice(-32);
        return self.saveConfig();
      }
    });
  }).then(function () { return self.list({ force: true }); });
};
LegacyWallpaperEngineLibrary.prototype.discoverSources = function () {
  const self = this;
  const output = [];
  const seen = new Set();
  if (!this.autoDiscover) return Promise.resolve(output);
  return discoverSteamLibraries().then(function (libraries) {
    libraries.forEach(function (library) {
      knownWallpaperContainers(library).forEach(function (container) {
        const key = pathKey(container);
        if (seen.has(key)) return;
        seen.add(key);
        const isWorkshop = /workshop[\\/]content/i.test(container);
        output.push({ root: container, kind: isWorkshop ? 'workshop' : 'local', label: isWorkshop ? 'Steam 创意工坊' : 'Wallpaper Engine 本地项目', direct: true });
      });
    });
    self.manualRoots.forEach(function (root) {
      const key = pathKey(root);
      if (seen.has(key) || !root) return;
      seen.add(key);
      output.push({ root: root, kind: 'imported', label: '手动导入', direct: false });
    });
    return output;
  });
};
LegacyWallpaperEngineLibrary.prototype.indexProject = function (projectRoot, source, scenePackageOverride) {
  const self = this;
  return readProjectManifest(projectRoot).then(function (manifest) {
    if (!manifest) return null;
    const project = manifest.value;
    const projectType = String(safeGet(project, 'type') || '').trim().toLowerCase();
    const directExt = path.extname(String(safeGet(project, 'file') || '')).toLowerCase();
    const inferredMedia = VIDEO_MIME.has(directExt) ? 'video' : (IMAGE_MIME.has(directExt) ? 'image' : '');
    const allowDirectMedia = projectType === 'video' || projectType === 'image' || (!projectType && !!inferredMedia);
    const mediaPromise = allowDirectMedia ? firstProjectFile(projectRoot, [safeGet(project, 'file')], SAFE_MIME) : Promise.resolve('');
    const scenePromise = projectType === 'scene'
      ? firstProjectFile(projectRoot, [scenePackageOverride ? path.relative(projectRoot, scenePackageOverride) : '', SCENE_PACKAGE_EXTENSIONS.has(directExt) ? safeGet(project, 'file') : '', 'scene.pkg', 'scene.pak'], SCENE_PACKAGE_EXTENSIONS).then(validateScenePackage)
      : Promise.resolve('');
    const previewPromise = firstProjectFile(projectRoot, [safeGet(project, 'preview'), safeGet(project, 'cover'), safeGet(project, 'poster'), 'preview.jpg', 'preview.jpeg', 'preview.png', 'preview.webp', 'preview.gif', 'cover.jpg', 'cover.png', 'cover.webp', 'cover.gif'], IMAGE_MIME);
    return Promise.all([mediaPromise, scenePromise, previewPromise]).then(function (res) {
      const media = res[0], scenePackage = res[1], preview = res[2];
      if (!media && !preview && !scenePackage) return null;
      const mediaExt = path.extname(media).toLowerCase();
      const previewExt = path.extname(preview).toLowerCase();
      const mediaType = VIDEO_MIME.has(mediaExt) ? 'video' : (IMAGE_MIME.has(mediaExt) ? 'image' : '');
      const safeProjectType = projectType || (mediaType ? mediaType : 'unknown');
      const enginePlayable = !!scenePackage;
      const previewOnly = !media && !enginePlayable;
      const propertyAnalysis = projectType === 'scene' ? analyzeSceneProperties(project) : { propertyCount: 0, audioPropertyCount: 0, mutedAudioPropertyCount: 0 };
      const workshopId = deriveWorkshopId(project, projectRoot, source.kind);
      const id = opaqueId(projectRoot);
      return {
        item: {
          id: id, title: sanitizeText(safeGet(project, 'title'), path.basename(projectRoot)), projectType: safeProjectType,
          mediaType: mediaType, mediaAnimated: mediaExt === '.gif', playable: !!media, enginePlayable: enginePlayable, previewOnly: previewOnly,
          hasPreview: !!preview, previewAnimated: previewExt === '.gif', source: source.kind, sourceLabel: source.label, workshopId: workshopId,
          propertyCount: propertyAnalysis.propertyCount, audioPropertyCount: propertyAnalysis.audioPropertyCount, mutedAudioPropertyCount: propertyAnalysis.mutedAudioPropertyCount,
          updatedAt: Math.round(Number(manifest.stat.mtimeMs) || 0),
          safetyMode: media ? 'direct-media' : (enginePlayable ? 'native-engine' : 'preview-only')
        },
        record: { id: id, projectRoot: projectRoot, projectFile: manifest.file, media: media, preview: preview, scenePackage: scenePackage, workshopId: workshopId }
      };
    });
  }).catch(function () { return null; });
};
LegacyWallpaperEngineLibrary.prototype.performScan = function () {
  const self = this;
  const generation = ++this.generation;
  const startedAt = Date.now();
  return this.discoverSources().then(function (sources) {
    const projectSources = new Map();
    const manualPackageByRoot = new Map();
    self.manualProjectFiles.forEach(function (file) { manualPackageByRoot.set(pathKey(path.dirname(file)), file); });
    sources.forEach(function (source) {
      const projectsPromise = source.direct ? directProjectDirectories(source.root) : manualProjectDirectories(source.root);
      return projectsPromise.then(function (projectRoots) {
        projectRoots.forEach(function (projectRoot) {
          const key = pathKey(projectRoot);
          if (!projectSources.has(key)) projectSources.set(key, { projectRoot: projectRoot, source: source });
        });
      });
    });
    // discoverSources 已 resolve；逐个索引
    return Promise.all(Array.from(projectSources.values()).map(function (value) {
      if (self.disposed || generation !== self.generation) return Promise.resolve(null);
      return self.indexProject(value.projectRoot, value.source, manualPackageByRoot.get(pathKey(value.projectRoot)) || '').then(function (indexed) {
        if (!indexed || self.index.has(indexed.item.id)) return null;
        self.index.set(indexed.item.id, indexed.record);
        return indexed.item;
      });
    }));
  }).then(function (items) {
    const projects = items.filter(Boolean);
    projects.sort(function (a, b) { return (Number(b.playable) - Number(a.playable)) || (Number(b.enginePlayable) - Number(a.enginePlayable)) || a.title.localeCompare(b.title, 'zh-CN'); });
    if (self.disposed || generation !== self.generation) return self.snapshot;
    const snapshot = {
      ok: true, projects: projects, count: projects.length,
      dynamicCount: projects.filter(function (p) { return p.playable && p.mediaType === 'video'; }).length,
      enginePlayableCount: projects.filter(function (p) { return p.enginePlayable; }).length,
      previewOnlyCount: projects.filter(function (p) { return p.previewOnly; }).length,
      sourceCount: 0, scannedAt: Date.now(), elapsedMs: Date.now() - startedAt, mediaToken: self.mediaToken
    };
    self.snapshot = snapshot;
    return snapshot;
  });
};
LegacyWallpaperEngineLibrary.prototype.list = function (options) {
  const self = this;
  options = options || {};
  const force = options.force === true;
  if (!force && this.snapshot && Date.now() - this.snapshot.scannedAt < CACHE_TTL_MS) return Promise.resolve(this.snapshot);
  if (this.scanPromise) {
    if (!force) return this.scanPromise;
    if (this.queuedForceScan) return this.queuedForceScan;
    const active = this.scanPromise;
    const queued = active.catch(function () { return null; }).then(function () { return self.performScan(); });
    queued.finally(function () { if (self.scanPromise === queued) self.scanPromise = null; if (self.queuedForceScan === queued) self.queuedForceScan = null; });
    this.queuedForceScan = queued; this.scanPromise = queued; return queued;
  }
  const scan = this.performScan();
  scan.finally(function () { if (self.scanPromise === scan) self.scanPromise = null; });
  this.scanPromise = scan;
  return scan;
};
LegacyWallpaperEngineLibrary.prototype.validatedRecordFile = function (record, kind) {
  const target = kind === 'media' ? record.media : record.preview;
  if (!target) return Promise.resolve('');
  const projectRoot = record.projectRoot;
  return safeRealpath(projectRoot).then(function (realRoot) {
    return safeRealpath(target).then(function (realTarget) {
      if (!realRoot || !realTarget || !isInside(realRoot, realTarget) || !SAFE_MIME.has(path.extname(realTarget).toLowerCase())) return '';
      return statSafe(realTarget).then(function (st) { return st && st.isFile() ? realTarget : ''; });
    });
  });
};
LegacyWallpaperEngineLibrary.prototype.mediaResponse = function (request) {
  const self = this;
  const method = String(safeGet(request, 'method') || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return Promise.resolve({ status: 405, headers: { 'Allow': 'GET, HEAD' }, body: Buffer.from('Method not allowed') });
  }
  let url, id;
  try { url = new URL(request.url); id = decodeURIComponent(url.pathname.replace(/^\/+/, '')); }
  catch (_) { return Promise.resolve({ status: 404, headers: {}, body: Buffer.from('Not found') }); }
  const kind = url.hostname === 'media' ? 'media' : (url.hostname === 'preview' ? 'preview' : '');
  if (url.searchParams.get('token') !== this.mediaToken) return Promise.resolve({ status: 404, headers: {}, body: Buffer.from('Not found') });
  if (!/^[a-f0-9]{24}$/i.test(id)) return Promise.resolve({ status: 404, headers: {}, body: Buffer.from('Not found') });
  if (!this.snapshot && !this.scanPromise) { /* lazy */ }
  const record = kind ? this.index.get(id.toLowerCase()) : null;
  if (!record) return Promise.resolve({ status: 404, headers: {}, body: Buffer.from('Not found') });
  return this.validatedRecordFile(record, kind).then(function (target) {
    if (!target) return { status: 404, headers: {}, body: Buffer.from('Not found') };
    return statSafe(target).then(function (stat) {
      if (!stat) return { status: 404, headers: {}, body: Buffer.from('Not found') };
      const size = Number(stat.size) || 0;
      const rangeHeader = request.headers && request.headers.range;
      const range = rangeHeader ? parseByteRange(rangeHeader, size) : null;
      if (range && range.invalid) return { status: 416, headers: { 'Content-Range': 'bytes */' + size }, body: Buffer.alloc(0) };
      const start = range ? range.start : 0;
      const end = range ? range.end : Math.max(0, size - 1);
      const headers = {
        'Content-Type': mimeForPath(target), 'Content-Length': String(size ? end - start + 1 : 0),
        'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff'
      };
      if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
      if (method === 'HEAD' || !size) return { status: range ? 206 : 200, headers: headers, body: Buffer.alloc(0) };
      const stream = fs.createReadStream(target, { start: start, end: end });
      return { status: range ? 206 : 200, headers: headers, stream: stream };
    });
  });
};
/**
 * 适配旧 Electron：用 registerStreamProtocol 而非 protocol.handle。
 * 返回 false 表示当前环境不支持（调用方应降级为跳过）。
 */
LegacyWallpaperEngineLibrary.prototype.installProtocol = function (protocol) {
  if (this.protocolInstalled) return true;
  if (!protocol || typeof protocol.registerStreamProtocol !== 'function') return false;
  const self = this;
  // 旧的 registerStreamProtocol 回调签名 (request, callback)
  protocol.registerStreamProtocol(WALLPAPER_ENGINE_SCHEME, function (request, callback) {
    self.mediaResponse(request).then(function (res) {
      const status = res.status;
      const headers = res.headers || {};
      if (res.stream) {
        // 旧 API 用 Node Readable 直接作为 stream 形参
        callback({ statusCode: status, headers: headers, data: res.stream });
      } else {
        callback({ statusCode: status, headers: headers, data: res.body || Buffer.alloc(0) });
      }
    }).catch(function () {
      callback({ statusCode: 404, headers: {}, data: Buffer.alloc(0) });
    });
  });
  this.protocolInstalled = true;
  return true;
};
LegacyWallpaperEngineLibrary.prototype.dispose = function () {
  this.disposed = true;
  this.generation += 1;
  this.index.clear();
  this.mediaToken = '';
  this.snapshot = null;
};

module.exports = {
  WALLPAPER_ENGINE_SCHEME: WALLPAPER_ENGINE_SCHEME,
  LegacyWallpaperEngineLibrary: LegacyWallpaperEngineLibrary,
  analyzeSceneProperties: analyzeSceneProperties,
  discoverSteamLibraries: discoverSteamLibraries,
  sanitizeText: sanitizeText
};
