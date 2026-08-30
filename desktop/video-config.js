'use strict';

/**
 * Stellaflare 影视态 — 配置读取模块 (video-config.js)
 * ----------------------------------------------------------------------------
 * 从 package.json 的 stellaflixVideo 节点读取配置，解析 __appData__ / __exeDir__
 * 等占位符为绝对路径，给 mpv-controller / download-manager / protocol-adapters 使用。
 *
 * 设计原则：
 *   - 单一数据源：所有视频相关配置都从 package.json 读，不另起 config/*.json
 *   - 路径占位符：__appData__ → app.getPath('userData')；__exeDir__ → exe 所在目录
 *   - 只读：运行期不写回 package.json；用户改配置后重启生效
 *   - 零侵入：本模块不依赖任何 Electron 模块，可被主进程 / 渲染进程共用
 */

const path = require('path');
const fs = require('fs');

let _cache = null;

/** 读取并缓存 stellaflixVideo 配置 */
function readRaw() {
  if (_cache) return _cache;
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    _cache = pkg.stellaflixVideo || {};
  } catch (e) {
    _cache = {};
  }
  return _cache;
}

/** 解析路径占位符 */
function resolvePlaceholders(value, appPaths) {
  if (typeof value !== 'string') return value;
  let v = value;
  if (appPaths && appPaths.appData) v = v.replace(/__appData__/g, appPaths.appData);
  if (appPaths && appPaths.exeDir)  v = v.replace(/__exeDir__/g, appPaths.exeDir);
  return v;
}

/** 初始化：必须在 app.ready 之后调用，传入 app.getPath 结果 */
function init(appPaths) {
  const raw = readRaw();
  const R = appPaths || {};
  return {
    mpv: {
      dllName: raw.mpv?.dllName || 'mpv-1.dll',
      dllPath: resolvePlaceholders(raw.mpv?.dllPath || '_up_/ffmpeg/mpv-1.dll', R),
      ffmpegPath: resolvePlaceholders(raw.mpv?.ffmpegPath || '_up_/ffmpeg/ffmpeg.exe', R),
      ffprobePath: resolvePlaceholders(raw.mpv?.ffprobePath || '_up_/ffmpeg/ffprobe.exe', R),
      enableLogging: raw.mpv?.enableLogging !== false,
      logLevel: raw.mpv?.logLevel || 'info',
    },
    decoder: {
      preferredEngine: raw.decoder?.preferredEngine || 'mpv',
      fallbackEngine: raw.decoder?.fallbackEngine || 'ffmpeg',
      maxDecodeWidth: raw.decoder?.maxDecodeWidth || 3840,
      maxDecodeHeight: raw.decoder?.maxDecodeHeight || 2160,
      enableHwDecoding: raw.decoder?.enableHwDecoding !== false,
      hwDecodingBackend: raw.decoder?.hwDecodingBackend || 'auto',
    },
    qbt: {
      enabled: raw.qbt?.enabled !== false,
      exePath: resolvePlaceholders(raw.qbt?.exePath || '_up_/resources/qbittorrent/qbittorrent.exe', R),
      port: raw.qbt?.port || 8080,
      username: raw.qbt?.username || 'admin',
      password: raw.qbt?.password || 'adminadmin',
      defaultSavePath: resolvePlaceholders(raw.qbt?.defaultSavePath || '__appData__/Artist', R),
      maxActiveDownloads: raw.qbt?.maxActiveDownloads || 3,
      applyRateLimit: raw.qbt?.applyRateLimit === true,
      globalRateLimit: raw.qbt?.globalRateLimit || 0,
    },
    mediaLibrary: {
      rootDir: resolvePlaceholders(raw.mediaLibrary?.rootDir || '__appData__/StellaMedia', R),
      cacheDir: resolvePlaceholders(raw.mediaLibrary?.cacheDir || '__appData__/StellaMedia/cache', R),
      supportedFormats: raw.mediaLibrary?.supportedFormats || ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm3u8', 'mpd'],
      maxCacheSize: raw.mediaLibrary?.maxCacheSize || 10737418240,
      autoCleanCache: raw.mediaLibrary?.autoCleanCache !== false,
    },
    network: {
      userAgent: raw.network?.userAgent || 'Stellaflix/2.1.0 Video',
      timeout: raw.network?.timeout || 30000,
      maxRetries: raw.network?.maxRetries || 3,
      enableProxy: raw.network?.enableProxy === true,
      proxyUrl: raw.network?.proxyUrl || '',
    },
    display: {
      defaultAspectRatio: raw.display?.defaultAspectRatio || '16:9',
      enableSubtitle: raw.display?.enableSubtitle !== false,
      defaultSubtitleLang: raw.display?.defaultSubtitleLang || 'chi',
      defaultAudioLang: raw.display?.defaultAudioLang || 'chi',
      enableVisualizer: raw.display?.enableVisualizer === true,
    },
    protocols: {
      emby: raw.protocols?.emby?.enabled !== false,
      jellyfin: raw.protocols?.jellyfin?.enabled !== false,
      alist: raw.protocols?.alist?.enabled !== false,
      webdav: raw.protocols?.webdav?.enabled !== false,
    },
  };
}

/** 获取已初始化的配置（必须先 init） */
function get() {
  if (!_initialized) throw new Error('video-config 未初始化：请先调用 init()');
  return _config;
}

let _initialized = false;
let _config = null;

function initOnce(appPaths) {
  if (_initialized) return _config;
  _config = init(appPaths);
  _initialized = true;
  return _config;
}

module.exports = { init: initOnce, get, readRaw };
