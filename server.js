// ====================================================================
//  粒子音乐可视化播放器 — Server v2
//  - 网易云搜索 / 歌曲URL / 封面/音频代理
//  - 扫码登录 (login_qr_*) + cookie 持久化 (./.cookie)
//  - 试听检测 (freeTrialInfo) + 全 quality 探测
//  - 所有受保护 API 都会带上已登录用户的 cookie
// ====================================================================
// NeteaseCloudMusicApi (~8.7MB) is lazy-bound so cold start only pays for the
// package when the first Netease route actually runs, not at server module load.
let _neteaseCloudMusicApi = null;
function neteaseApiFn(name) {
  return function lazyNeteaseApi(...args) {
    if (!_neteaseCloudMusicApi) _neteaseCloudMusicApi = require('NeteaseCloudMusicApi');
    const fn = _neteaseCloudMusicApi[name];
    if (typeof fn !== 'function') throw new Error('NeteaseCloudMusicApi missing export: ' + name);
    return fn(...args);
  };
}
const search = neteaseApiFn('search');
const cloudsearch = neteaseApiFn('cloudsearch');
const song_detail = neteaseApiFn('song_detail');
const song_url = neteaseApiFn('song_url');
const song_url_v1 = neteaseApiFn('song_url_v1');
const album = neteaseApiFn('album');
const artist_detail = neteaseApiFn('artist_detail');
const artist_top_song = neteaseApiFn('artist_top_song');
const artist_songs = neteaseApiFn('artist_songs');
const playlist_tracks = neteaseApiFn('playlist_tracks');
const playlist_detail = neteaseApiFn('playlist_detail');
const playlist_track_all = neteaseApiFn('playlist_track_all');
// 批 T16c：播客整条下线——网易云官方播客族接口常量（dj 前缀 8 枚）随路由一并退役
// （grep 自证：此前唯一消费方是 /api/podcast/*）。
const lyric = neteaseApiFn('lyric');
const lyric_new = neteaseApiFn('lyric_new');
const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

// ffmpeg-static：懒加载（postinstall 在某些受限网络下可能下载失败二进制）；
// 缺失时 /api/agent/speech/transcribe 返回明确错误而不崩溃。
let ffmpegStaticPath = null;
try { ffmpegStaticPath = require('ffmpeg-static'); } catch (_) { ffmpegStaticPath = null; }
let ffmpegBinaryReady = !!(ffmpegStaticPath && fs.existsSync(ffmpegStaticPath));

// ============ AI 助手语音双引擎（自 Mineradio-LX-Music GPL-3.0 移植，2026-09-22） ============
// 引擎 A（主）：faster-whisper（Python）— 前端 MediaRecorder 音频 → /transcribe 高精度转写
// 引擎 B（兜底直采）：Windows SpeechRecognitionEngine — 服务端麦克风直听 /recognize
// 降级链：whisper 就绪 → A；A 缺失且 win32 → B；都不行 → 保留原 SAPI 转写链（SF 特有第三保险）
const WINDOWS_SPEECH_SCRIPT = path.join(__dirname, 'desktop', 'speech', 'windows-speech-recognizer.ps1');
const WHISPER_SPEECH_SCRIPT = path.join(__dirname, 'desktop', 'speech', 'whisper-speech-recognizer.py');
let speechProcess = null; // 当前语音子进程（任一引擎），供 /cancel 统一终止
// 熔断：whisper 探测只查文件存在性（不 spawn 验证 python 包），运行期连续失败后
// 停用 whisper 直到重启，避免每次请求都先空等 90s 超时再回落 SAPI。
const WHISPER_FAILURE_LIMIT = 2;
let whisperFailureCount = 0;

// Python 解释器多候选探测（MR 硬编码 Python313 的宽松化改造）：
// env STELLAFLIX_WHISPER_PYTHON > win32 常见安装目录（313→310、LocalAppData 与 C:\）> PATH。
function findWhisperPython() {
  const envOverride = process.env.STELLAFLIX_WHISPER_PYTHON;
  if (envOverride && fs.existsSync(envOverride)) return envOverride;
  if (process.platform === 'win32') {
    const localPrograms = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python');
    for (const minor of [13, 12, 11, 10]) {
      const candidate = path.join(localPrograms, `Python3${minor}`, 'python.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
    for (const minor of [13, 12, 11, 10]) {
      const candidate = path.join('C:\\', `Python3${minor}`, 'python.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
    const launcher = path.join(process.env.SystemRoot || 'C:\\Windows', 'py.exe');
    if (fs.existsSync(launcher)) return launcher;
  }
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of process.platform === 'win32' ? ['python.exe'] : ['python3', 'python']) {
      const candidate = path.join(dir, name);
      try { if (fs.existsSync(candidate)) return candidate; } catch (_) {}
    }
  }
  return '';
}

// huggingface 缓存的 Systran/faster-whisper-small 模型（可用 env 直指模型目录）。
function findWhisperModelPath() {
  const envModel = process.env.STELLAFLIX_WHISPER_MODEL;
  if (envModel && fs.existsSync(path.join(envModel, 'model.bin'))) return envModel;
  const root = path.join(os.homedir(), '.cache', 'huggingface', 'hub', 'models--Systran--faster-whisper-small', 'snapshots');
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(root, entry.name))
      .find(candidate => fs.existsSync(path.join(candidate, 'model.bin'))) || '';
  } catch (_error) { return ''; }
}

function whisperRuntimeReady() {
  return whisperFailureCount < WHISPER_FAILURE_LIMIT
    && !!findWhisperModelPath()
    && !!findWhisperPython()
    && fs.existsSync(WHISPER_SPEECH_SCRIPT);
}

function cancelWindowsSpeechRecognition() {
  const child = speechProcess;
  speechProcess = null;
  if (!child) return false;
  try { child.kill(); } catch (_error) {}
  return true;
}

// 引擎 B：服务端麦克风直采（win32 + PowerShell System.Speech）。
function recognizeWindowsSpeech(timeoutSeconds) {
  if (process.platform !== 'win32' || !fs.existsSync(WINDOWS_SPEECH_SCRIPT)) {
    return Promise.reject(Object.assign(new Error('当前系统不支持本地语音识别。'), { code: 'SPEECH_NOT_SUPPORTED' }));
  }
  if (speechProcess) {
    return Promise.reject(Object.assign(new Error('语音识别正在进行中。'), { code: 'SPEECH_BUSY' }));
  }
  const timeout = Math.max(3, Math.min(30, Math.round(Number(timeoutSeconds) || 18)));
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WINDOWS_SPEECH_SCRIPT, '-TimeoutSeconds', String(timeout),
    ], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    speechProcess = child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      if (speechProcess === child) speechProcess = null;
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error); else resolve(data);
    };
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', error => finish(Object.assign(new Error('无法启动本地语音识别。'), { code: 'SPEECH_START_FAILED', cause: error })));
    child.once('close', () => {
      let data = null;
      const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      for (let index = lines.length - 1; index >= 0 && !data; index -= 1) {
        try { data = JSON.parse(lines[index]); } catch (_error) {}
      }
      if (data && data.ok && String(data.text || '').trim()) {
        finish(null, { ok: true, text: String(data.text).trim().slice(0, 4000), engine: data.engine || 'windows-offline-zh-CN' });
        return;
      }
      const errorCode = data && data.error || 'SPEECH_RECOGNITION_FAILED';
      const speechMessages = {
        SPEECH_ZH_CN_NOT_INSTALLED: '未安装 Windows 中文语音识别器。',
        SPEECH_NOT_HEARD: '没有听清，请靠近麦克风再说一次。',
        SPEECH_RECOGNITION_FAILED: '本地语音识别失败，请检查麦克风是否可用。',
      };
      const message = speechMessages[errorCode] || (stderr ? '本地语音识别失败，请检查麦克风。' : '没有听清，请再说一次。');
      finish(Object.assign(new Error(message), { code: errorCode }));
    });
    killTimer = setTimeout(() => {
      try { child.kill(); } catch (_error) {}
      finish(Object.assign(new Error('语音输入等待超时，请重试。'), { code: 'SPEECH_TIMEOUT' }));
    }, (timeout + 5) * 1000);
  });
}

// 引擎 A：faster-whisper 转写（前端上传的 webm/wav/ogg/m4a，PyAV 解码，不依赖 ffmpeg-static）。
function recognizeWhisperAudio(audioBuffer, extension) {
  const modelPath = findWhisperModelPath();
  const pythonExe = findWhisperPython();
  if (!modelPath || !pythonExe || !fs.existsSync(WHISPER_SPEECH_SCRIPT)) {
    return Promise.reject(Object.assign(new Error('高精度本地语音模型不可用。'), { code: 'WHISPER_NOT_AVAILABLE' }));
  }
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length < 1024) {
    return Promise.reject(Object.assign(new Error('没有听清，请再说一次。'), { code: 'SPEECH_NOT_HEARD' }));
  }
  const safeExtension = /^\.(?:webm|wav|ogg|m4a)$/i.test(extension || '') ? extension : '.webm';
  const tempPath = path.join(os.tmpdir(), 'stellaflix-speech-' + process.pid + '-' + Date.now() + safeExtension);
  fs.writeFileSync(tempPath, audioBuffer);
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExe, [WHISPER_SPEECH_SCRIPT, '--audio', tempPath, '--model', modelPath], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' })
    });
    speechProcess = child;
    let stdout = '';
    let settled = false;
    let killTimer = null;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      if (speechProcess === child) speechProcess = null;
      if (killTimer) clearTimeout(killTimer);
      try { fs.unlinkSync(tempPath); } catch (_error) {}
      if (error) reject(error); else resolve(data);
    };
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString('utf8')).slice(-65536); });
    child.once('error', error => finish(Object.assign(new Error('无法启动高精度本地语音识别。'), { code: 'WHISPER_START_FAILED', cause: error })));
    child.once('close', () => {
      let data = null;
      const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      for (let index = lines.length - 1; index >= 0 && !data; index -= 1) {
        try { data = JSON.parse(lines[index]); } catch (_error) {}
      }
      if (data && data.ok && String(data.text || '').trim()) {
        whisperFailureCount = 0; // 成功即复位熔断
        finish(null, { ok: true, text: String(data.text).trim().slice(0, 4000), engine: data.engine || 'faster-whisper-small-zh' });
        return;
      }
      const code = data && data.error || 'WHISPER_RECOGNITION_FAILED';
      finish(Object.assign(new Error(code === 'SPEECH_NOT_HEARD' ? '没有听清，请靠近麦克风再说一次。' : '高精度本地语音识别失败。'), { code }));
    });
    killTimer = setTimeout(() => {
      try { child.kill(); } catch (_error) {}
      finish(Object.assign(new Error('语音识别等待超时，请重试。'), { code: 'SPEECH_TIMEOUT' }));
    }, 90000);
  });
}
// ============ 语音双引擎结束 ============

// ============ LX Music 桌面版数据库直读（LxDatas 借鉴，自 MR readLxPlaylists 移植，2026-09-23） ============
// 只读打开落雪 %APPDATA%/lx-music-desktop/LxDatas/lx.data.db（node:sqlite，Node 22.5+/Electron 42+），
// 拉全部歌单+歌曲。免 .lxmc 手动导出；装了落雪的用户点一下即全量导入。
function findLxDatabasePath() {
  const candidates = [
    process.env.STELLAFLIX_LX_DB_PATH,
    process.env.APPDATA && path.join(process.env.APPDATA, 'lx-music-desktop', 'LxDatas', 'lx.data.db'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'lx-music-desktop', 'portable', 'LxDatas', 'lx.data.db'),
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

function decodeLxText(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_m, code) => {
      try { return String.fromCodePoint(Number(code)); } catch (_e) { return _m; }
    })
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function readLxPlaylists() {
  const dbPath = findLxDatabasePath();
  if (!dbPath) throw new Error('LX_DATABASE_NOT_FOUND');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const storedLists = db.prepare(
      'SELECT id, name, source, sourceListId, position FROM my_list ORDER BY position ASC'
    ).all();
    const lists = [
      { id: 'default', name: '默认列表', source: '', sourceListId: '', position: -2 },
      { id: 'love', name: '我的收藏', source: '', sourceListId: '', position: -1 },
      ...storedLists,
    ];
    const songs = db.prepare(
      'SELECT m.id, m.listId, m.name, m.singer, m.source, m.interval, m.meta, ' +
      'COALESCE(o."order", 999999) AS sortOrder ' +
      'FROM my_list_music_info m LEFT JOIN my_list_music_info_order o ' +
      'ON o.listId=m.listId AND o.musicInfoId=m.id ' +
      "WHERE m.listId <> 'temp' ORDER BY m.listId, sortOrder ASC"
    ).all();
    const songsByList = new Map();
    songs.forEach(row => {
      let meta = {};
      try { meta = JSON.parse(row.meta || '{}') || {}; } catch (_e) {}
      const song = {
        id: row.id,
        name: decodeLxText(row.name),
        singer: decodeLxText(row.singer),
        source: row.source,
        interval: row.interval || '',
        songmid: meta.songId == null ? row.id : meta.songId,
        albumName: decodeLxText(meta.albumName),
        picUrl: meta.picUrl || '',
        albumId: meta.albumId == null ? '' : meta.albumId,
      };
      if (!songsByList.has(row.listId)) songsByList.set(row.listId, []);
      songsByList.get(row.listId).push(song);
    });
    return {
      ok: true,
      dbPath,
      playlists: lists
        .map(list => ({
          id: list.id,
          name: decodeLxText(list.name),
          source: list.source || '',
          sourceListId: list.sourceListId || '',
          lxNative: true,
          lxDbListId: list.id,
          songs: songsByList.get(list.id) || [],
        }))
        .filter(list => list.songs.length),
    };
  } finally {
    db.close();
  }
}
// ============ LxDatas 直读结束 ============

const tls = require('tls');
const { once } = require('events');
const { fileURLToPath } = require('url');
const {
  appendCuefieldFeedback,
  readCuefieldFeedbackStats,
} = require('./cuefield/feedback-log');
const { planCuefieldTransitionFromCache } = require('./cuefield/stellaflix-bridge');
const agentApi = require('./agent-api');
// LX 脚本源宿主 + 内置爬虫（批 T7，移植上游 server.js:2725-3145 路由族的底层实现，
// 宿主沙箱见 lx-source-host.js，五家免 cookie 爬虫与冷却/缓存见 lx-search.js）。
const { createLxSourceHost } = require('./lx-source-host');
const { createLxSearch } = require('./lx-search');
// 世界页数据代理（M4）：Radio Browser / USGS / CelesTrak 免 key 源
const worldApi = require('./world-api');
// 世界页「一起看」房间信令（M5）：本地内存房间 + 轮询信箱
const worldRoomApi = require('./world-room-api');
// 世界页地图瓦片内存缓存（LRU，最多 600 片 ≈ 10MB）
const mapTileCache = new Map();
const platformPlaylistImport = require('./platform-playlist-import');
// 平台歌单导入的跨平台匹配桥：sp/qs/am 导入歌曲无 Stellaflix 原生 id，
// 用 lx-search 的 wy 爬虫按歌名+歌手匹配出可播版本；匹配不上的歌保留
// needsCrossPlatformMatch，由前端 LX 解析链现场兜底（T15：旧第三方音源聚合解析路由已退役）。
// 批 T8 换血：旧 netease 官方 API handleSearch → lxSearch.searchOne('wy')（消费批 T5 单例）。
// 闭包定义先于下方 lxSearch const 声明但仅在请求期执行，TDZ 不触雷；输出与旧注入逐字节
// 同形 {name,singer,songmid,picUrl,interval,source:'wy'}，import 模块零改动。错误语义照旧：
// searchOne 抛出即 rejected，由 platform-playlist-import.js bridgeSearchAll 的 catch 兜底为
// failures:[{source:'bridge',...}]（tests/platform-playlist-import.test.js 锁定）。
platformPlaylistImport.setSearchImplementation(async function (query, options) {
  const limit = Math.max(1, Math.min(30, Number(options && options.limit) || 10));
  const songs = await lxSearch.searchOne('wy', { query: String(query || ''), limit });
  return {
    ok: true,
    songs: (Array.isArray(songs) ? songs : []).map(s => ({
      name: s.name, singer: s.singer || '', songmid: String(s.songmid || s.id || ''),
      picUrl: s.pic || '', interval: s.interval || 0, source: 'wy',
    })),
    failures: [],
  };
});
const { setupGlobalProxy } = require('./desktop/global-proxy');
const hlsAdFilter = require('./desktop/hls-ad-filter');

// 全局出口代理：若本机运行着 Clash / V2Ray 等代理并在环境变量中暴露
// HTTP_PROXY / HTTPS_PROXY，则 server 侧所有出站 fetch 自动经其转发（详见 desktop/global-proxy.js）。
(function initGlobalProxy() {
  try {
    const r = setupGlobalProxy(process.env);
    if (r.enabled) {
      console.log('[Proxy] 全局出口代理已启用 -> ' + r.proxy + ' (agent=' + r.kind + ')');
    } else if (r.error) {
      console.warn('[Proxy] 全局代理初始化失败：' + r.error);
    }
  } catch (e) { /* 代理失败不影响主流程 */ }
})();

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// —— LX 脚本源单例（批 T7，裁决7）——
// userDataPath：desktop/main.js 现状未向 server 注入用户数据目录 env（主进程自持
// STABLE_USER_DATA_PATH = appData/<产品名>，见 desktop/main.js:151），故按计划约定键名
// STELLAFLIX_USER_DATA；纯 node / 未注入时回退 %APPDATA%\Stellaflix —— 与桌面端 stable
// 用户目录同根同层，两条启动路径落位一致。
function resolveLxSourceUserDataPath() {
  const fromEnv = String(process.env.STELLAFLIX_USER_DATA || '').trim();
  if (fromEnv) return fromEnv;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Stellaflix');
}
const lxSourceHost = createLxSourceHost({ userDataPath: resolveLxSourceUserDataPath() });
const lxSearch = createLxSearch();

// 裁决6：宿主终态失败为两条中文文案（lx-source-host.js resolveMusicUrl 末端 throw），
// 路由层据此映射机器可读 code（error 字段仍保留原文，T9 前端按 code 分流）。
// 其余 code 直接取自异常消息中的 LX_* 词法段（如 LX_SOURCE_INIT_TIMEOUT /
// LX_SOURCE_REQUEST_HANDLER_MISSING / LX_QUALITY_UNSUPPORTED / LX_SOURCE_DOWNLOAD_HTTP_500 …）。
const LX_SOURCE_TERMINAL_CODES = Object.freeze({
  '当前音源及备用音源均解析失败，请切换音源后重试': 'LX_SOURCE_RESOLVE_ALL_FAILED',
  '没有可用于这首歌的音源': 'LX_SOURCE_NO_RESOLVER',
});
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BEATMAP_CACHE_DIR = process.env.STELLAFLIX_BEAT_CACHE_DIR || 'D:\\StellaflixCache\\beatmaps';
const CUEFIELD_FEEDBACK_FILE = process.env.CUEFIELD_FEEDBACK_FILE || path.join(__dirname, 'data', 'cuefield-feedback.jsonl');
const APP_PACKAGE = readPackageInfo();
const APP_VERSION = process.env.STELLAFLIX_VERSION || APP_PACKAGE.version || '0.1.0';
const UPDATE_CONFIG = readUpdateConfig(APP_PACKAGE);
const UPDATE_FALLBACK_NOTES = [
  '修复多行歌词与 3D 歌单架的显示层级',
  '优化更新入口与安装包获取流程',
];
const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_IP_LOCATION_URL = 'http://ip-api.com/json/';
const WEATHER_DEFAULT_LOCATION = {
  name: '上海',
  country: 'China',
  latitude: 31.2304,
  longitude: 121.4737,
  timezone: 'Asia/Shanghai',
};

function applySystemCertificateAuthorities() {
  try {
    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return;
    const bundled = tls.getCACertificates('default') || [];
    const system = tls.getCACertificates('system') || [];
    if (!system.length) return;
    const seen = new Set();
    const merged = [];
    bundled.concat(system).forEach(cert => {
      if (!cert || seen.has(cert)) return;
      seen.add(cert);
      merged.push(cert);
    });
    if (merged.length > bundled.length) tls.setDefaultCACertificates(merged);
  } catch (e) {
    console.warn('[TLS] system CA merge skipped:', e.message);
  }
}

applySystemCertificateAuthorities();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.ogv':  'video/ogg',
  '.mov':  'video/quicktime',
  '.m4v':  'video/mp4',
  '.ts':   'video/MP2T',
  '.m4s':  'video/iso-segment',
};

// ---------- TMDB API 只读缓存（内存，TTL 30min，模块级单例） ----------
// api.tmdb.org /3/ 的 GET JSON 200 响应服务端复用：详情页 bundle / 海报墙品类
// 每次打开都重新远程往返（单程 0.3~0.8s），而元数据变化以小时计。
// 缓存键剥离 api_key（结果与 key 无关，也避免凭证进入缓存索引）。
// 播放链路零影响：非 /3/ 目标、带 Range、非 2xx 一律不缓存。
const TMDB_API_CACHE_TTL_MS = 30 * 60 * 1000;
const TMDB_API_CACHE_MAX = 150;
const TMDB_API_CACHE_MAX_BODY = 512 * 1024;
const tmdbApiCache = new Map(); // key -> { ct, buf, at }

function tmdbApiCacheKey(targetUrl) {
  try {
    const u = new URL(targetUrl);
    if (u.pathname !== '/3' && !u.pathname.startsWith('/3/')) return null;
    u.searchParams.delete('api_key');
    u.hash = '';
    return u.origin + u.pathname + '?' + u.searchParams.toString();
  } catch (e) { return null; }
}

function tmdbApiCacheGet(key) {
  const hit = tmdbApiCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TMDB_API_CACHE_TTL_MS) { tmdbApiCache.delete(key); return null; }
  return hit;
}

function tmdbApiCacheSet(key, entry) {
  tmdbApiCache.set(key, entry);
  while (tmdbApiCache.size > TMDB_API_CACHE_MAX) {
    const oldest = tmdbApiCache.keys().next().value;
    if (oldest === undefined) break;
    tmdbApiCache.delete(oldest);
  }
}

// ---------- /api/proxy 图片磁盘缓存（跨进程/跨重启持久，海报墙冷启动秒出） ----------
// 海报墙一次拉 ~200 张 TMDB 图，浏览器缓存受端口跳变（3000→动态端口）与
// 「同 URL 变参数」影响命中率低；服务端落盘后同 URL 永不再打 image.tmdb.org
// （国内网络该域名单张 0.2~1.3s，是首屏 3s 的主要来源）。
// 键 = 上游完整 URL 的 sha1（含查询参数：w500 与 original 是不同资源）；
// 仅 GET、无 Range、扩展名像图片且上游 200 + image/* 才读写。
// 目录默认在用户主目录（打包安装目录可能只读），SFV_CACHE_DIR 供测试/部署覆盖。
const IMG_CACHE_DIR = process.env.SFV_CACHE_DIR
  || path.join(os.homedir(), '.stellaflix', 'proxy-img-cache');
const IMG_CACHE_MAX_FILE = 5 * 1024 * 1024;
const IMG_CACHE_MAX_FILES = 1500;
const IMG_CACHE_EXT_RE = /\.(png|jpe?g|gif|webp|ico|bmp|avif)(\?|#|$)/i;
const imgCacheLru = new Map(); // key -> 最近访问时间（HIT 也 touch）

// ---------- /api/image-color：海报平均色（wsrv 1×1 PNG + zlib 解像素，零 canvas） ----------
const imageColorCache = new Map(); // tmdb 图片 URL -> '#rrggbb'
function decode1x1Png(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('NOT_PNG');
  const colorType = buf[25]; // 0=灰度 2=RGB 6=RGBA
  let off = 8;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.slice(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = require('zlib').inflateSync(Buffer.concat(idat));
  // 每 scanline 首字节是 filter type；1×1 只有一个像素行，跳过后即像素
  const px = raw.slice(1);
  let r, g, b;
  if (colorType === 0) { r = g = b = px[0]; }
  else { r = px[0]; g = px[1]; b = px[2]; }
  return '#' + [r, g, b].map((v) => (v & 0xff).toString(16).padStart(2, '0')).join('');
}

function imgCacheKey(targetUrl) {
  try {
    const u = new URL(targetUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!IMG_CACHE_EXT_RE.test(u.pathname)) return null;
    return crypto.createHash('sha1').update(u.origin + u.pathname + (u.search || '')).digest('hex');
  } catch (e) { return null; }
}

async function imgCacheGet(key) {
  const bin = path.join(IMG_CACHE_DIR, key);
  try {
    const meta = JSON.parse(await fs.promises.readFile(bin + '.meta', 'utf8'));
    const buf = await fs.promises.readFile(bin);
    imgCacheLru.set(key, Date.now());
    fs.promises.utimes(bin, new Date(), new Date()).catch(() => {});
    return { buf, ct: meta.ct || 'application/octet-stream', cc: meta.cc || '' };
  } catch (e) { return null; }
}

async function imgCachePut(key, buf, ct, cc) {
  const bin = path.join(IMG_CACHE_DIR, key);
  try {
    await fs.promises.mkdir(IMG_CACHE_DIR, { recursive: true });
    await fs.promises.writeFile(bin, buf);
    await fs.promises.writeFile(bin + '.meta', JSON.stringify({ ct, cc, at: Date.now() }));
    imgCacheLru.set(key, Date.now());
    imgCachePut.count = (imgCachePut.count || 0) + 1;
    if (imgCachePut.count % 50 === 0) imgCacheSweep();
  } catch (e) {
    console.warn('[ImgCache] put failed:', e.message);
  }
}

// 容量兜底：按 mtime 删最旧的超额对象（含跨进程累积，内存 LRU 重启即清零）
async function imgCacheSweep() {
  let files;
  try { files = await fs.promises.readdir(IMG_CACHE_DIR); } catch (e) { return; }
  const bins = files.filter((f) => /^[0-9a-f]{40}$/.test(f));
  if (bins.length <= IMG_CACHE_MAX_FILES) return;
  const stats = [];
  for (const b of bins) {
    const p = path.join(IMG_CACHE_DIR, b);
    try { stats.push({ p, key: b, mtime: (await fs.promises.stat(p)).mtimeMs }); } catch (e) {}
  }
  stats.sort((a, b) => a.mtime - b.mtime);
  for (let i = 0; i < stats.length - IMG_CACHE_MAX_FILES; i += 1) {
    try {
      await fs.promises.unlink(stats[i].p);
      await fs.promises.unlink(stats[i].p + '.meta');
    } catch (e) {}
    imgCacheLru.delete(stats[i].key);
  }
}

// ---------- SSRF 防护：私网 IP/主机名拦截（/api/proxy 使用） ----------
function isPrivateIPv4(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some(n => isNaN(n))) return true;
  if (p[0] === 10) return true;
  if (p[0] === 127) return true;
  if (p[0] === 0) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}
function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = String(hostname).toLowerCase().trim();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h.startsWith('[::1]') || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIPv4(h);
  return false; // 域名放行（影视源为公网自定义域名）
}

// Bangumi 镜像等上游的错误体形态不统一：可能是 {"message":"..."}，
// 也可能是 {"error":{"code":"...","message":"..."}}（error 为对象时直接取值会得到 [object Object]）。
function extractUpstreamErrorDetail(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '';
  try {
    const j = JSON.parse(t);
    if (j && typeof j === 'object') {
      if (typeof j.message === 'string' && j.message) return j.message;
      if (j.error && typeof j.error === 'object' && typeof j.error.message === 'string') return j.error.message;
      if (typeof j.error === 'string' && j.error) return j.error;
    }
  } catch (e) { /* 非 JSON：原样返回文本 */ }
  return t;
}

// ---------- Cookie 持久化 ----------
// ---------- 历史凭证清理（批 T16d） ----------
// LX 世界观不再持有任何平台 cookie 登录态；此钩子只负责清掉旧版本落盘的凭证文件，
// 供桌面端「清除登录状态」入口（16e）复用。公开分发口径：包内不落任何凭证。
const LEGACY_COOKIE_FILES = [
  process.env.COOKIE_FILE || path.join(__dirname, '.cookie'),
  process.env.QQ_COOKIE_FILE || path.join(__dirname, '.qq-cookie'),
  process.env.KUGOU_COOKIE_FILE || path.join(__dirname, '.kugou-cookie'),
  process.env.QISHUI_COOKIE_FILE || path.join(__dirname, '.qishui-cookie'),
  process.env.QISHUI_TOKEN_FILE || path.join(__dirname, '.qishui-token'),
  process.env.QISHUI_OAUTH_CONFIG_FILE || path.join(__dirname, '.qishui-oauth.json'),
  process.env.SPOTIFY_TOKEN_FILE || path.join(__dirname, '.spotify-token.json'),
  process.env.SPOTIFY_CONFIG_FILE || path.join(__dirname, '.spotify-credentials.json'),
  path.join(__dirname, '.qishui-qr-identity.json'),
  path.join(__dirname, '.qishui-qr-login.json'),
];
function clearAllRuntimeLoginCredentials(reason) {
  const removed = [];
  for (const file of LEGACY_COOKIE_FILES) {
    try {
      if (file && fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed.push(file);
      }
    } catch (_) {}
  }
  return { ok: true, reason: String(reason || 'login-reset'), removed };
}

// ---------- 工具 ----------
function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'text/plain',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
}
// ---------- 跨站请求防护 ----------
// 合法调用方只有播放器自己的窗口（均从 http://127.0.0.1:<PORT> 加载）。
// Chromium 强制为浏览器请求附加 Origin / Sec-Fetch-Site，网页脚本无法伪造；
// 两者皆无的请求视为本机非浏览器流量（Electron 主进程 / curl）放行。
// 注意：Spotify OAuth 回调由 desktop/main.js 的独立回调服务器处理，不经过这里。
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
]);
function corsHeadersFor(req) {
  const origin = String(req.headers.origin || '');
  if (ALLOWED_ORIGINS.has(origin)) {
    return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
  }
  return {};
}
function isCrossSiteWrite(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  const origin = String(req.headers.origin || '');
  if (origin && !ALLOWED_ORIGINS.has(origin)) return true;
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') return true;
  return false;
}
// isTrustedLocalApiRequest（批 T7，移植上游 server.js:311-323）：cross-site 一律拒；
// 无 Origin / Origin:null（curl、Electron 主进程等本机无头流量）放行；否则必须
// http://127.0.0.1|localhost|[::1]:<PORT>。裁决2：仅施加于 /api/lx-source/* 路由族，
// 全局 isCrossSiteWrite 守卫保持原样，本批不向其它 /api 路由回铺。
function isTrustedLocalApiRequest(req) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') return false;
  const origin = String(req.headers.origin || '').trim();
  if (!origin || origin === 'null') return true;
  try {
    const parsed = new URL(origin);
    const localHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
    return parsed.protocol === 'http:' && localHost && String(parsed.port || '80') === String(PORT);
  } catch (_err) {
    return false;
  }
}
function sendJSON(res, data, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(res._cors || {}),
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(JSON.stringify(data));
}
function readPackageInfo() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}
function parseGitHubRepository(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const direct = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (direct) return { owner: direct[1], repo: direct[2].replace(/\.git$/i, '') };
  const github = raw.match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[#/?].*)?$/i);
  if (github) return { owner: github[1], repo: github[2].replace(/\.git$/i, '') };
  return null;
}
function readUpdateConfig(pkg) {
  const local = (pkg && pkg.stellaflix && pkg.stellaflix.update) || {};
  const disabled = local.disabled === true || local.provider === 'none';
  if (disabled) {
    return {
      provider: local.provider || 'none',
      owner: '',
      repo: '',
      configured: false,
      disabled: true,
      preview: false,
      preferMirrors: false,
      mirrors: [],
      manifest: '',
    };
  }
  const repoHint = process.env.STELLAFLIX_UPDATE_REPOSITORY
    || process.env.GITHUB_REPOSITORY
    || local.repository
    || local.github
    || (pkg && pkg.repository && (pkg.repository.url || pkg.repository))
    || '';
  const parsed = parseGitHubRepository(repoHint) || {};
  const owner = process.env.STELLAFLIX_UPDATE_OWNER || local.owner || parsed.owner || '';
  const repo = process.env.STELLAFLIX_UPDATE_REPO || local.repo || parsed.repo || '';
  return {
    provider: local.provider || 'github',
    owner,
    repo,
    configured: !!(owner && repo),
    disabled: false,
    preview: local.preview !== false,
    preferMirrors: local.preferMirrors !== false,
    mirrors: readUpdateMirrors(local),
    manifest: process.env.STELLAFLIX_UPDATE_MANIFEST
      || process.env.STELLAFLIX_UPDATE_MANIFEST_URL
      || process.env.STELLAFLIX_UPDATE_MANIFEST_FILE
      || '',
  };
}
function parseUpdateMirrorList(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/[\n,;]/);
}
function readUpdateMirrors(local) {
  const envMirrors = process.env.STELLAFLIX_UPDATE_MIRRORS || process.env.STELLAFLIX_UPDATE_MIRROR || '';
  const raw = envMirrors
    ? parseUpdateMirrorList(envMirrors)
    : parseUpdateMirrorList(local.mirrors || local.downloadMirrors || []);
  const seen = new Set();
  const mirrors = [];
  raw.forEach(item => {
    const url = String(item || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    const key = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    mirrors.push(url);
  });
  return mirrors.slice(0, 6);
}
function buildMirrorUrl(originalUrl, mirror) {
  const source = String(originalUrl || '').trim();
  const base = String(mirror || '').trim();
  if (!/^https?:\/\//i.test(source) || !/^https?:\/\//i.test(base)) return '';
  if (base.includes('{encodedUrl}')) return base.replace(/\{encodedUrl\}/g, encodeURIComponent(source));
  if (base.includes('{url}')) return base.replace(/\{url\}/g, source);
  return base.replace(/\/+$/, '/') + source;
}
function uniqueDownloadCandidates(urls, opts) {
  opts = opts || {};
  const directUrls = (Array.isArray(urls) ? urls : [urls])
    .map(url => String(url || '').trim())
    .filter(url => /^https?:\/\//i.test(url));
  const directSet = new Set(directUrls.map(url => url.toLowerCase()));
  const mirrors = opts.useMirrors === false ? [] : (UPDATE_CONFIG.mirrors || []);
  const mirrored = [];
  directUrls.forEach(source => {
    mirrors.forEach((mirror, index) => {
      const url = buildMirrorUrl(source, mirror);
      if (url) mirrored.push({
        url,
        label: '国内加速线路 ' + (index + 1),
        mirrored: true,
      });
    });
  });
  const direct = directUrls.map(url => ({
    url,
    label: directSet.has(url.toLowerCase()) ? 'GitHub 直连' : '下载线路',
    mirrored: false,
  }));
  const ordered = UPDATE_CONFIG.preferMirrors === false ? direct.concat(mirrored) : mirrored.concat(direct);
  const seen = new Set();
  return ordered.filter(item => {
    const key = item.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').replace(/[+].*$/, '').replace(/-.+$/, '');
}
function compareVersions(a, b) {
  const aa = normalizeVersion(a).split('.').map(n => parseInt(n, 10) || 0);
  const bb = normalizeVersion(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(aa.length, bb.length, 3);
  for (let i = 0; i < len; i++) {
    const left = aa[i] || 0;
    const right = bb[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}
function cleanReleaseLine(line) {
  return String(line || '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}
function extractReleaseNotes(body) {
  const notes = [];
  String(body || '').split(/\r?\n/).forEach(line => {
    if (/<!--[\s\S]*?-->/i.test(line)) return;
    const text = cleanReleaseLine(line);
    if (!text) return;
    if (/^(what'?s changed|changes|changelog|full changelog|更新日志)$/i.test(text)) return;
    if (/https?:\/\//i.test(text)) return;
    if (/^(下载|网盘|夸克盘|百度(?:云|网盘)|蓝奏(?:云|网盘)|安装包)/i.test(text)) return;
    if (text.length > 72) return;
    notes.push(text);
  });
  return notes.slice(0, 4);
}
function safeExternalUpdateUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch (_) {
    return '';
  }
}
function normalizeUpdateDownloadPages(values, fallbackLabel) {
  const source = Array.isArray(values) ? values : (values ? [values] : []);
  const seen = new Set();
  const pages = [];
  source.forEach((value, index) => {
    const item = value && typeof value === 'object' ? value : { url: value };
    const url = safeExternalUpdateUrl(item.url || item.href || item.downloadPageUrl || item.externalUrl || '');
    if (!url || seen.has(url)) return;
    const label = cleanReleaseLine(item.label || item.name || fallbackLabel || `下载线路 ${index + 1}`)
      .replace(/[<>|]/g, '')
      .slice(0, 24)
      .trim() || `下载线路 ${index + 1}`;
    seen.add(url);
    pages.push({ label, url });
  });
  return pages.slice(0, 6);
}
function extractReleaseDownloadPages(body) {
  const raw = String(body || '');
  const pages = [];
  const hiddenPattern = /<!--\s*stellaflix-download-page\s*:\s*(?:([^|<>\r\n]{1,32})\s*\|\s*)?(https:\/\/[^\s<>]+)\s*-->/gi;
  let hidden = null;
  while ((hidden = hiddenPattern.exec(raw))) {
    pages.push({
      label: String(hidden[1] || '').trim(),
      url: hidden[2],
    });
  }
  if (pages.length) return normalizeUpdateDownloadPages(pages);
  const visiblePattern = /^\s*[-*]?\s*(夸克盘|百度(?:云|网盘)|蓝奏(?:云|网盘)|网盘|下载(?:地址|页面|链接)?)\s*[:：]\s*(?:\[[^\]]*]\()?(https:\/\/[^\s<>)\]]+)/gmi;
  let visible = null;
  while ((visible = visiblePattern.exec(raw))) {
    pages.push({ label: visible[1], url: visible[2] });
  }
  return normalizeUpdateDownloadPages(pages);
}
function extractReleaseDownloadPage(body) {
  const pages = extractReleaseDownloadPages(body);
  return pages.length ? pages[0].url : '';
}
function normalizeManifestUpdateInfo(data) {
  data = data || {};
  const release = data.release || {};
  const latestVersion = normalizeVersion(
    data.latestVersion
    || data.version
    || release.version
    || release.tagName
    || release.tag_name
    || release.name
    || APP_VERSION
  ) || APP_VERSION;
  const htmlUrl = safeExternalUpdateUrl(release.htmlUrl || release.html_url || data.htmlUrl || '');
  const legacyExternalUrl = safeExternalUpdateUrl(
    release.downloadPageUrl
    || release.externalUrl
    || data.downloadPageUrl
    || data.externalUrl
    || release.downloadUrl
    || data.downloadUrl
    || ''
  );
  const downloadPages = normalizeUpdateDownloadPages(
    release.downloadPages || data.downloadPages || [],
    '网盘下载'
  );
  if (legacyExternalUrl && !downloadPages.some(page => page.url === legacyExternalUrl)) {
    downloadPages.unshift({ label: '网盘下载', url: legacyExternalUrl });
  }
  const externalUrl = downloadPages.length ? downloadPages[0].url : legacyExternalUrl;
  const downloadPageUrl = externalUrl || htmlUrl;
  const notes = Array.isArray(release.notes) && release.notes.length
    ? release.notes.slice(0, 4).map(cleanReleaseLine).filter(Boolean)
    : (extractReleaseNotes(release.body || data.body).length ? extractReleaseNotes(release.body || data.body) : UPDATE_FALLBACK_NOTES);
  return {
    configured: true,
    preview: false,
    updateAvailable: data.updateAvailable != null ? !!data.updateAvailable : compareVersions(latestVersion, APP_VERSION) > 0,
    currentVersion: APP_VERSION,
    latestVersion,
    release: {
      tagName: release.tagName || release.tag_name || data.tagName || ('v' + latestVersion),
      name: release.name || data.name || ('Stellaflix v' + latestVersion),
      version: latestVersion,
      publishedAt: release.publishedAt || release.published_at || data.publishedAt || '',
      htmlUrl,
      externalUrl,
      downloadPageUrl,
      downloadPages,
      downloadUrl: externalUrl,
      asset: null,
      patch: null,
      patchAvailable: false,
      summary: release.summary || data.summary || notes[0] || '发现新版本，建议更新。',
      notes,
    },
    source: 'manifest',
  };
}
async function readUpdateManifest(ref) {
  const value = String(ref || '').trim();
  if (!value) throw new Error('UPDATE_MANIFEST_MISSING');
  if (/^https?:\/\//i.test(value)) {
    const resp = await fetch(value, {
      headers: { 'User-Agent': `Stellaflix/${APP_VERSION}` },
    });
    if (!resp.ok) throw new Error('Update manifest ' + resp.status);
    return resp.json();
  }
  const file = /^file:/i.test(value) ? fileURLToPath(value) : path.resolve(value);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function fetchManifestUpdateInfo(ref) {
  try {
    const data = await readUpdateManifest(ref);
    return normalizeManifestUpdateInfo(data);
  } catch (err) {
    return localUpdateFallback(err.message || 'Update manifest failed', { configured: true });
  }
}
function beatCacheRootInfo() {
  const dir = path.resolve(BEATMAP_CACHE_DIR);
  const root = path.parse(dir).root;
  const drive = root ? root.replace(/[\\\/]+$/, '').toUpperCase() : '';
  const allowed = !!root && !/^C:$/i.test(drive);
  const available = allowed && fs.existsSync(root);
  return { dir, root, drive, allowed, available };
}
function ensureBeatMapCacheDir() {
  const info = beatCacheRootInfo();
  if (!info.allowed) {
    const err = new Error('BEAT_CACHE_ON_C_DRIVE_DISABLED');
    err.code = 'BEAT_CACHE_ON_C_DRIVE_DISABLED';
    err.info = info;
    throw err;
  }
  if (!info.available) {
    const err = new Error('BEAT_CACHE_DRIVE_UNAVAILABLE');
    err.code = 'BEAT_CACHE_DRIVE_UNAVAILABLE';
    err.info = info;
    throw err;
  }
  fs.mkdirSync(info.dir, { recursive: true });
  return info.dir;
}
function safeBeatMapCacheFile(key) {
  const raw = String(key || '').trim();
  if (!raw || raw.length > 240) return null;
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  const label = raw.replace(/[^a-z0-9_.-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'beatmap';
  return path.join(ensureBeatMapCacheDir(), `${label}-${hash}.json`);
}
function compactBeatMapCachePayload(body) {
  const key = String(body && body.key || '').trim();
  const map = body && body.map;
  if (!key || !map || typeof map !== 'object') return null;
  return {
    v: 1,
    key,
    savedAt: Date.now(),
    meta: {
      provider: String(body.provider || '').slice(0, 32),
      title: String(body.title || '').slice(0, 160),
      artist: String(body.artist || '').slice(0, 160),
      mode: String(body.mode || 'sf').slice(0, 32),
    },
    map,
  };
}
function readBeatMapCache(key) {
  // B3 已知限制：保持同步读（cuefield/stellaflix-bridge.js:18 以同步契约消费本回调，
  // 改 async 会静默破坏转场规划）。读的是压缩后的小 JSON，阻塞窗口远小于写路径；
  // 后续若要异步化需连同 bridge 与 quick-check 一起改。
  const file = safeBeatMapCacheFile(key);
  if (!file || !fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw && raw.map ? raw : null;
}
async function writeBeatMapCache(body) {
  // B3 异步写：原 writeFileSync+renameSync 在 /api/audio 音频流的关键期（新歌起播、
  // 客户端回传 beatmap 存档）同步阻塞事件循环，慢盘上可感知为音频瞬断。
  // 改 fs.promises 后写盘让出事件循环；tmp+rename 的原子性保持不变。
  const payload = compactBeatMapCachePayload(body);
  if (!payload) return { ok: false, error: 'INVALID_BEATMAP_CACHE_PAYLOAD' };
  const file = safeBeatMapCacheFile(payload.key);
  if (!file) return { ok: false, error: 'INVALID_BEATMAP_CACHE_KEY' };
  const tmp = file + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(payload));
  await fs.promises.rename(tmp, file);
  return { ok: true, key: payload.key, savedAt: payload.savedAt, dir: path.dirname(file) };
}
function localUpdateFallback(reason, opts) {
  opts = opts || {};
  const configured = !!(opts.configured != null ? opts.configured : false);
  return {
    configured,
    preview: UPDATE_CONFIG.preview,
    updateAvailable: false,
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    release: {
      tagName: 'v' + APP_VERSION,
      name: 'Stellaflix v' + APP_VERSION,
      version: APP_VERSION,
      htmlUrl: '',
      externalUrl: '',
      downloadPageUrl: '',
      downloadPages: [],
      downloadUrl: '',
      asset: null,
      patch: null,
      patchAvailable: false,
      summary: '当前版本，更新检测已就绪。',
      notes: UPDATE_FALLBACK_NOTES,
    },
    reason: reason || '',
  };
}
function updateError(code, message, cause) {
  const err = new Error(message || code);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}
function classifyUpdateError(err) {
  const code = String(err && err.code || '').trim();
  const message = String(err && err.message || err || '').trim();
  const detail = message || code || '未知错误';
  if (/HASH|DIGEST|CHECKSUM/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_HASH_MISMATCH', reason: '文件校验失败，可能是线路缓存异常，已拦截该安装包。', detail };
  }
  if (/SIZE_MISMATCH|content length/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_SIZE_MISMATCH', reason: '下载文件大小不一致，可能是网络中断或线路缓存不完整。', detail };
  }
  if (/AbortError|TIMEOUT|ETIMEDOUT|timeout/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_TIMEOUT', reason: '连接超时，当前网络到更新线路不稳定。', detail };
  }
  if (/ENOTFOUND|EAI_AGAIN|DNS|fetch failed|getaddrinfo/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_DNS_FAILED', reason: '域名解析失败，可能是当前网络无法连接该更新线路。', detail };
  }
  if (/ECONNRESET|ECONNREFUSED|socket|network/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_NETWORK_FAILED', reason: '网络连接被中断，已尝试切换更新线路。', detail };
  }
  const http = message.match(/\bHTTP[_\s-]?(\d{3})\b/i) || message.match(/\b(\d{3})\b/);
  if (http) {
    const status = Number(http[1]);
    if (status === 403) return { code: code || 'UPDATE_HTTP_403', reason: '更新线路返回 403，可能被限流或拦截。', detail };
    if (status === 404) return { code: code || 'UPDATE_HTTP_404', reason: '更新文件不存在，可能 release 资源还没有同步完成。', detail };
    if (status >= 500) return { code: code || 'UPDATE_HTTP_5XX', reason: '更新线路服务器异常，请稍后重试。', detail };
    return { code: code || ('UPDATE_HTTP_' + status), reason: '更新线路返回 HTTP ' + status + '。', detail };
  }
  return { code: code || 'UPDATE_FAILED', reason: '更新失败：' + detail, detail };
}
async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 12000);
  try {
    return await fetch(url, Object.assign({}, opts || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}
function promiseWithTimeout(promise, timeoutMs, code) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(code || 'PROVIDER_REQUEST_TIMEOUT');
        err.code = code || 'PROVIDER_REQUEST_TIMEOUT';
        reject(err);
      }, Math.max(250, Number(timeoutMs) || 5000));
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
async function readStreamChunkWithTimeout(reader, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error('UPSTREAM_STREAM_IDLE_TIMEOUT');
          err.code = 'UPSTREAM_STREAM_IDLE_TIMEOUT';
          reject(err);
        }, timeoutMs || 12000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function fetchTextFromCandidates(candidates, timeoutMs) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : [];
  const failures = [];
  for (let i = 0; i < list.length; i++) {
    const candidate = list[i];
    try {
      const resp = await fetchWithTimeout(candidate.url, {
        headers: { 'User-Agent': `Stellaflix/${APP_VERSION}` },
      }, timeoutMs || 6500);
      if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);
      return { text: await resp.text(), candidate };
    } catch (err) {
      const info = classifyUpdateError(err);
      failures.push(candidate.label + ': ' + info.reason);
    }
  }
  throw updateError('UPDATE_ALL_LINES_FAILED', failures.join('；') || 'All update lines failed');
}
function yamlScalar(text, key) {
  const pattern = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.+?)\\s*$', 'm');
  const match = String(text || '').match(pattern);
  if (!match) return '';
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}
function parseLatestYmlUpdateInfo(text, reason) {
  const latestVersion = normalizeVersion(yamlScalar(text, 'version') || APP_VERSION) || APP_VERSION;
  const releaseDate = yamlScalar(text, 'releaseDate');
  const htmlUrl = `https://github.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases/tag/v${latestVersion}`;
  return {
    configured: true,
    preview: false,
    updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
    currentVersion: APP_VERSION,
    latestVersion,
    release: {
      tagName: 'v' + latestVersion,
      name: 'Stellaflix v' + latestVersion,
      version: latestVersion,
      publishedAt: releaseDate,
      htmlUrl,
      externalUrl: '',
      downloadPageUrl: htmlUrl,
      downloadPages: [],
      downloadUrl: '',
      asset: null,
      patch: null,
      patchAvailable: false,
      summary: '发现新版本，请前往发布页面获取安装包。',
      notes: ['更新入口已改为浏览器外部下载', 'Stellaflix 不再在本地下载或应用补丁'],
    },
    source: 'latest-yml',
    reason: reason || '',
  };
}
async function fetchLatestYmlUpdateInfo(reason) {
  if (!UPDATE_CONFIG.configured || UPDATE_CONFIG.provider !== 'github') throw updateError('UPDATE_REPOSITORY_NOT_CONFIGURED');
  const latestYmlUrl = `https://github.com/${encodeURIComponent(UPDATE_CONFIG.owner)}/${encodeURIComponent(UPDATE_CONFIG.repo)}/releases/latest/download/latest.yml`;
  const candidates = uniqueDownloadCandidates(latestYmlUrl);
  const result = await fetchTextFromCandidates(candidates, 6500);
  return parseLatestYmlUpdateInfo(result.text, reason);
}
async function fetchLatestUpdateInfo() {
  if (UPDATE_CONFIG.manifest) return fetchManifestUpdateInfo(UPDATE_CONFIG.manifest);
  if (!UPDATE_CONFIG.configured || UPDATE_CONFIG.provider !== 'github') return localUpdateFallback();
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(UPDATE_CONFIG.owner)}/${encodeURIComponent(UPDATE_CONFIG.repo)}/releases/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);
  try {
    const resp = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': `Stellaflix/${APP_VERSION}`,
        'Accept': 'application/vnd.github+json',
      },
    });
    if (!resp.ok) {
      try { return await fetchLatestYmlUpdateInfo('GitHub Releases ' + resp.status); }
      catch (_) { return localUpdateFallback('GitHub Releases ' + resp.status, { configured: true }); }
    }
    const data = await resp.json();
    const latestVersion = normalizeVersion(data.tag_name || data.name || APP_VERSION) || APP_VERSION;
    const htmlUrl = safeExternalUpdateUrl(data.html_url || '');
    const downloadPages = extractReleaseDownloadPages(data.body);
    const externalUrl = downloadPages.length ? downloadPages[0].url : '';
    const downloadPageUrl = externalUrl || htmlUrl;
    const notes = extractReleaseNotes(data.body).length ? extractReleaseNotes(data.body) : UPDATE_FALLBACK_NOTES;
    return {
      configured: true,
      preview: false,
      updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
      currentVersion: APP_VERSION,
      latestVersion,
      release: {
        tagName: data.tag_name || ('v' + latestVersion),
        name: data.name || ('Stellaflix v' + latestVersion),
        version: latestVersion,
        publishedAt: data.published_at || '',
        htmlUrl,
        externalUrl,
        downloadPageUrl,
        downloadPages,
        downloadUrl: externalUrl,
        asset: null,
        patch: null,
        patchAvailable: false,
        summary: notes[0] || '发现新版本，建议更新。',
        notes,
      },
    };
  } catch (err) {
    const reason = err && err.message || 'Update check failed';
    try { return await fetchLatestYmlUpdateInfo(reason); }
    catch (fallbackErr) { return localUpdateFallback((fallbackErr && fallbackErr.message) || reason, { configured: true }); }
  } finally {
    clearTimeout(timer);
  }
}
function readRequestBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) {
        const params = new URLSearchParams(raw);
        const out = {};
        params.forEach((v, k) => { out[k] = v; });
        resolve(out);
      }
    });
    req.on('error', () => resolve({}));
  });
}
// 收二进制请求体（如语音转写上传的音频 blob），按 Buffer 拼接，上限 20MB 防止 OOM
function readRawBody(req, maxBytes = 20 * 1024 * 1024) {
  return new Promise(resolve => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) { aborted = true; try { req.destroy(); } catch (_) {} resolve(null); return; }
      chunks.push(buf);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on('error', () => { if (!aborted) resolve(null); });
  });
}
// 通用子进程封装：捕获 stdout/stderr(utf8)、超时强杀。返回 {code, stdout, stderr}；不抛异常。
function runProcess(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    let proc;
    try { proc = spawn(cmd, args, { windowsHide: true }); }
    catch (err) { resolve({ code: -1, stdout: '', stderr: String(err && err.message || err) }); return; }
    const outChunks = [];
    const errChunks = [];
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { proc.kill(); } catch (_) {} }, timeoutMs);
    proc.stdout.on('data', d => outChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    proc.stderr.on('data', d => errChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    proc.on('error', e => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8') + '\n' + String(e && e.message || e) });
    });
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({
        code: killed ? -1 : (code == null ? -1 : code),
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
  });
}
function normalizeApiCode(payload) {
  const body = payload && (payload.body || payload);
  return Number((body && body.code) || (body && body.body && body.body.code) || (payload && payload.status) || 0);
}
function normalizeApiMessage(payload) {
  const body = payload && (payload.body || payload);
  return (body && (body.message || body.msg || body.error)) || (body && body.body && (body.body.message || body.body.msg || body.body.error)) || '';
}
function playbackRestriction(provider, category, message, action, extra) {
  return {
    provider,
    category,
    action: action || '',
    message,
    ...(extra || {}),
  };
}
function classifyNeteasePlaybackRestriction(lastData, loginInfo) {
  const loggedIn = !!(loginInfo && loginInfo.loggedIn);
  const vipReady = !!(loginInfo && (loginInfo.isVip || loginInfo.isSvip || loginInfo.vipLevel === 'vip' || loginInfo.vipLevel === 'svip' || Number(loginInfo.vipType || 0) > 0));
  const fee = Number(lastData && lastData.fee);
  const code = Number(lastData && lastData.code);
  const freeTrial = lastData && lastData.freeTrialInfo;
  if (!loggedIn) {
    return playbackRestriction('netease', 'login_required', '网易云需要登录后尝试获取完整播放地址', 'login', { code, fee });
  }
  if (freeTrial) {
    return playbackRestriction('netease', 'trial_only', '网易云仅返回试听片段，完整播放需要会员或购买', 'upgrade', { code, fee });
  }
  if (fee === 1) {
    if (vipReady) {
      return playbackRestriction('netease', 'copyright_unavailable', '当前会员状态下仍未取得可播放地址，已尝试在网易云内匹配同一录音版本', 'switch_source', { code, fee });
    }
    return playbackRestriction('netease', 'vip_required', '网易云歌曲需要 VIP 权限，当前无法获取完整播放地址', 'upgrade', { code, fee });
  }
  if (fee === 4) {
    return playbackRestriction('netease', 'paid_required', '网易云歌曲需要单曲、专辑购买或更高权限', 'purchase', { code, fee });
  }
  if (fee === 8) {
    return playbackRestriction('netease', 'copyright_unavailable', '当前网易云版本没有返回完整音源，已尝试匹配站内同一录音版本', 'switch_source', { code, fee });
  }
  if (code === 404 || code === 403) {
    return playbackRestriction('netease', 'copyright_unavailable', '网易云版权暂不可播，换源或稍后重试会更稳', 'switch_source', { code, fee });
  }
  return playbackRestriction('netease', 'url_unavailable', '网易云没有返回可播放地址，可能是版权、会员或地区限制', loggedIn ? 'switch_source' : 'login', { code, fee });
}
const NETEASE_QUALITY_CANDIDATES = [
  { level: 'jymaster', br: 1999000, label: '超清母带', svip: true },
  { level: 'hires',    br: 1999000, label: '高清臻音' },
  { level: 'lossless', br: 1411000, label: '无损' },
  { level: 'exhigh',   br: 999000,  label: '极高' },
  { level: 'standard', br: 128000,  label: '标准' },
];
const NETEASE_DIRECT_RESOLVE_BUDGET_MS = 4800;
const NETEASE_SOURCE_MATCH_TOTAL_BUDGET_MS = 8000;
const NETEASE_SOURCE_MATCH_LOOKUP_BUDGET_MS = 4800;
const NETEASE_SONG_URL_TOTAL_BUDGET_MS = 12000;
function normalizeQualityPreference(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (['jymaster', 'master', 'studio', 'svip'].includes(raw)) return 'jymaster';
  // T15（携 T12 minor）：LX 词汇 flac24bit 归 hires——本函数服务保留的 QQ 兼容
  // vkey/推荐候选链（QQ_QUALITY_CANDIDATE_TEMPLATES），24bit FLAC 属最高解析档。
  if (['hires', 'hi-res', 'highres', 'zhenyin', 'spatial', 'flac24bit'].includes(raw)) return 'hires';
  if (['lossless', 'flac', 'sq'].includes(raw)) return 'lossless';
  if (['exhigh', 'high', '320', '320k', 'hq'].includes(raw)) return 'exhigh';
  if (['standard', 'normal', '128', '128k', 'std'].includes(raw)) return 'standard';
  return 'hires';
}
function qualityCandidatesFrom(target, candidates) {
  target = normalizeQualityPreference(target);
  let start = candidates.findIndex(item => item.level === target);
  if (start < 0) start = 0;
  return candidates.slice(start);
}
function hasNeteaseSvip(loginInfo) {
  return !!(loginInfo && loginInfo.loggedIn && (loginInfo.vipLevel === 'svip' || loginInfo.isSvip));
}
function mapArtists(raw) {
  return (raw || [])
    .map(a => ({ id: a && a.id, name: (a && a.name) || '' }))
    .filter(a => a.name);
}
function mapSongRecord(s) {
  s = s || {};
  const artists = mapArtists(s.ar || s.artists);
  const album = s.al || s.album || {};
  return {
    provider: 'netease',
    source: 'netease',
    type: 'song',
    id: s.id,
    name: s.name,
    artist: artists.map(a => a.name).join(' / '),
    artists,
    artistId: artists[0] && artists[0].id,
    album: album.name || '',
    albumId: album.id || '',
    cover: album.picUrl || album.coverUrl || '',
    duration: s.dt || s.duration || 0,
    popularity: Number(s.pop || s.popularity || s.score || s.hotScore || 0) || 0,
    searchRank: s.rank === null || s.rank === undefined || s.rank === '' ? null : Number(s.rank),
    fee: s.fee,
  };
}
function mapDiscoverPlaylist(pl, tag) {
  pl = pl || {};
  const creator = pl.creator || pl.user || {};
  const id = pl.id || pl.resourceId || pl.creativeId;
  return {
    provider: 'netease',
    source: 'netease',
    type: 'playlist',
    id,
    name: pl.name || pl.title || '',
    cover: pl.picUrl || pl.coverImgUrl || pl.coverUrl || pl.uiElement && pl.uiElement.image && pl.uiElement.image.imageUrl || '',
    trackCount: pl.trackCount || pl.songCount || pl.programCount || 0,
    playCount: pl.playCount || pl.playcount || 0,
    creator: creator.nickname || creator.name || '',
    tag: tag || pl.alg || '',
  };
}

// ---------- 业务: 搜索 ----------
//   优先用 cloudsearch (新接口, 字段更全, picUrl 更稳定)
//   对于仍然缺失封面的歌曲, 用 song_detail 批量补齐
async function handleSearch(keywords, limit, offset) {
  limit = Math.max(1, Math.min(50, Number(limit) || 20));
  offset = Math.max(0, Number(offset) || 0);
  console.log('[Search]', keywords, 'limit:', limit, 'offset:', offset);
  const result = await cloudsearch({ keywords, limit, offset });
  const songs = result.body && result.body.result && result.body.result.songs ? result.body.result.songs : [];

  let mapped = songs.map(s => {
    return mapSongRecord(s);
  });

  // 兜底: 补齐缺失的封面
  const missing = mapped.filter(s => !s.cover).map(s => s.id);
  if (missing.length) {
    try {
      console.log('[Search] backfilling covers for', missing.length, 'songs');
      const dd = await song_detail({ ids: missing.join(',') });
      const songsArr = (dd.body && dd.body.songs) || [];
      const idToPic = {};
      songsArr.forEach(s => {
        const pic = (s.al && s.al.picUrl) || (s.album && s.album.picUrl) || '';
        if (pic) idToPic[s.id] = pic;
      });
      mapped = mapped.map(s => s.cover ? s : { ...s, cover: idToPic[s.id] || '' });
    } catch (e) { console.warn('[Search] backfill failed:', e.message); }
  }

  return mapped;
}

const NETEASE_SOURCE_MATCH_POSITIVE_TTL_MS = 12 * 60 * 60 * 1000;
const NETEASE_SOURCE_MATCH_NEGATIVE_TTL_MS = 5 * 60 * 1000;
const NETEASE_SOURCE_MATCH_MAX_CANDIDATES = 4;
const neteaseSourceMatchCache = new Map();
const neteaseSourceMatchInflight = new Map();

// Lightweight TTL + inflight cache for hot playback-address resolution.
function createPlaybackTtlCache(maxEntries, defaultTtlMs) {
  const store = new Map();
  const inflight = new Map();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (Date.now() - hit.at > hit.ttl) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },
    set(key, value, ttlMs) {
      store.set(key, { at: Date.now(), ttl: ttlMs || defaultTtlMs, value });
      while (store.size > maxEntries) store.delete(store.keys().next().value);
    },
    async wrap(key, ttlMs, fn) {
      const cached = this.get(key);
      if (cached !== null && cached !== undefined) return cached;
      if (inflight.has(key)) return inflight.get(key);
      const promise = (async () => {
        try {
          const value = await fn();
          const resolvedTtl = typeof ttlMs === 'function' ? ttlMs(value) : ttlMs;
          if (value && value.playable && value.url) this.set(key, value, resolvedTtl);
          return value;
        } finally {
          if (inflight.get(key) === promise) inflight.delete(key);
        }
      })();
      inflight.set(key, promise);
      return promise;
    },
  };
}

const neteaseSongUrlCache = createPlaybackTtlCache(256, 3 * 60 * 1000);
const qqSongUrlCache = createPlaybackTtlCache(256, 60 * 1000);

function neteaseSourceMatchText(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[\s·・\-—_.,，。:：'"“”‘’/\\|!?！？]+/g, '');
}
function neteaseSourceMatchDurationMs(value) {
  let duration = Number(value) || 0;
  if (duration > 0 && duration < 10000) duration *= 1000;
  return Math.max(0, duration);
}
function neteaseSourceMatchArtists(song) {
  const list = song && (song.ar || song.artists) || [];
  return (Array.isArray(list) ? list : []).map(artist => ({
    id: String(artist && artist.id || ''),
    name: neteaseSourceMatchText(artist && artist.name || ''),
  })).filter(artist => artist.id || artist.name);
}
// 版本 token 规则提升为共享常量：网易云同曲匹配与聚合解析（跨平台元数据匹配）共用同一套
// Live/翻唱/Remix/伴奏等版本区分规则，避免两处规则漂移。
const SOURCE_MATCH_VERSION_RULES = [
  ['live', /\blive\b|现场|演唱会/],
  ['cover', /\bcover\b|翻唱/],
  ['remix', /\bremix\b|\b(?:pop |radio |club |digital dog )?mix\b|mix版/],
  ['remaster', /\bremaster(?:ed)?\b|重制/],
  ['rerecord', /\bre[ -]?record(?:ed|ing)?\b|重录/],
  ['named-version', /taylor['’]?s version|\bversion\b|\bver\.?\b|版本/],
  ['edit', /\bradio edit\b|\bedit\b|剪辑版/],
  ['alternate-cut', /\bstripped\b|\bmono\b|\bstereo\b|\bcommentary\b/],
  ['instrumental', /\binstrumental\b|伴奏|\bkaraoke\b/],
  ['acoustic', /\bacoustic\b|不插电/],
  ['speed', /\bnightcore\b|\bsped up\b|\bslowed(?: and reverb)?\b|加速|慢速|变速/],
  ['dj', /\bdj\b|dj版/],
  ['demo', /\bdemo\b|试听版/],
];
function sourceMatchVersionTokensFromText(text) {
  const normalized = String(text || '').toLowerCase();
  return SOURCE_MATCH_VERSION_RULES.filter(rule => rule[1].test(normalized)).map(rule => rule[0]);
}
function neteaseSourceMatchVersionTokens(song) {
  const aliases = song && (song.alia || song.alias) || [];
  const text = String((song && song.name || '') + ' ' + (Array.isArray(aliases) ? aliases.join(' ') : aliases || ''));
  return sourceMatchVersionTokensFromText(text);
}
function neteaseSourceMatchMediaProfiles(song) {
  const profiles = [];
  ['h', 'm', 'l', 'sq', 'hr', 'hMusic', 'mMusic', 'lMusic', 'sqMusic', 'hrMusic'].forEach(key => {
    const item = song && song[key];
    if (!item) return;
    const profile = {
      br: Number(item.br || item.bitrate || 0) || 0,
      size: Number(item.size || 0) || 0,
      duration: Number(item.playTime || item.playtime || item.duration || 0) || 0,
      sr: Number(item.sr || item.sampleRate || 0) || 0,
    };
    if (profile.br || profile.size) profiles.push(profile);
  });
  return profiles;
}
function neteaseSourceMatchFingerprintCount(source, candidate) {
  const sourceProfiles = neteaseSourceMatchMediaProfiles(source);
  const candidateProfiles = neteaseSourceMatchMediaProfiles(candidate);
  let matches = 0;
  sourceProfiles.forEach(left => {
    if (candidateProfiles.some(right =>
      left.br && left.br === right.br &&
      left.size && left.size === right.size &&
      (!left.duration || !right.duration || Math.abs(left.duration - right.duration) <= 10) &&
      (!left.sr || !right.sr || left.sr === right.sr)
    )) matches++;
  });
  return matches;
}
function neteaseSourceMatchArtistSetEqual(sourceArtists, candidateArtists) {
  const sourceIds = [...new Set(sourceArtists.map(artist => artist.id).filter(Boolean))].sort();
  const candidateIds = [...new Set(candidateArtists.map(artist => artist.id).filter(Boolean))].sort();
  if (sourceIds.length && candidateIds.length) {
    return sourceIds.length === candidateIds.length && sourceIds.every((id, index) => id === candidateIds[index]);
  }
  const sourceNames = [...new Set(sourceArtists.map(artist => artist.name).filter(Boolean))].sort();
  const candidateNames = [...new Set(candidateArtists.map(artist => artist.name).filter(Boolean))].sort();
  return sourceNames.length > 0 && sourceNames.length === candidateNames.length && sourceNames.every((name, index) => name === candidateNames[index]);
}
function neteaseSourceMatchCandidateScore(source, candidate) {
  if (!source || !candidate || String(source.id || '') === String(candidate.id || '')) return -1;
  if (neteaseSourceMatchText(source.name) !== neteaseSourceMatchText(candidate.name)) return -1;
  const sourceVersions = neteaseSourceMatchVersionTokens(source);
  const candidateVersions = neteaseSourceMatchVersionTokens(candidate);
  if (sourceVersions.join('|') !== candidateVersions.join('|')) return -1;
  const sourceArtists = neteaseSourceMatchArtists(source);
  const candidateArtists = neteaseSourceMatchArtists(candidate);
  const sourceIds = sourceArtists.map(artist => artist.id).filter(Boolean);
  const candidateIds = candidateArtists.map(artist => artist.id).filter(Boolean);
  const artistIdMatch = sourceIds.length && candidateIds.length && sourceIds.some(id => candidateIds.indexOf(id) >= 0);
  const artistNameMatch = sourceArtists.some(left => candidateArtists.some(right => left.name && right.name && left.name === right.name));
  const artistSetMatch = neteaseSourceMatchArtistSetEqual(sourceArtists, candidateArtists);
  if (!artistIdMatch && !artistNameMatch) return -1;
  const sourceDuration = neteaseSourceMatchDurationMs(source.dt || source.duration);
  const candidateDuration = neteaseSourceMatchDurationMs(candidate.dt || candidate.duration);
  const durationDiff = sourceDuration && candidateDuration ? Math.abs(sourceDuration - candidateDuration) : 0;
  const durationLimit = sourceDuration ? Math.max(1800, sourceDuration * 0.012) : 0;
  if (durationLimit && durationDiff > durationLimit) return -1;
  const fingerprintMatches = neteaseSourceMatchFingerprintCount(source, candidate);
  const officialRecommendation = !!candidate.__officialSourceMatch;
  if (!fingerprintMatches && (!artistSetMatch || !sourceDuration || !candidateDuration || durationDiff > (officialRecommendation ? 1800 : 600))) return -1;
  const privilege = candidate.__privilege || candidate.privilege || {};
  let score = fingerprintMatches * 120;
  if (artistIdMatch) score += 70;
  else if (artistNameMatch) score += 42;
  if (artistSetMatch) score += 18;
  if (officialRecommendation) score += 240;
  if (sourceDuration && candidateDuration) score += Math.max(0, 45 - durationDiff / 100);
  if (Number(privilege.pl || 0) > 0 && String(privilege.plLevel || '').toLowerCase() !== 'none') score += 22;
  score += Math.min(20, Number(candidate.pop || candidate.popularity || candidate.score || 0) / 5 || 0);
  return score;
}
function neteaseSourceMatchCacheKey(id, hints) {
  hints = hints || {};
  return [
    String(id || ''),
    neteaseSourceMatchText(hints.name || hints.title),
    neteaseSourceMatchText(hints.artist),
    Math.round(neteaseSourceMatchDurationMs(hints.duration) / 1000),
  ].join('|');
}
function readNeteaseSourceMatchCache(key) {
  const entry = neteaseSourceMatchCache.get(key);
  if (!entry) return null;
  const ttl = entry.candidates && entry.candidates.length ? NETEASE_SOURCE_MATCH_POSITIVE_TTL_MS : NETEASE_SOURCE_MATCH_NEGATIVE_TTL_MS;
  if (Date.now() - entry.at > ttl) {
    neteaseSourceMatchCache.delete(key);
    return null;
  }
  return entry.candidates;
}
function writeNeteaseSourceMatchCache(key, candidates) {
  neteaseSourceMatchCache.set(key, { at: Date.now(), candidates: candidates || [] });
  while (neteaseSourceMatchCache.size > 256) neteaseSourceMatchCache.delete(neteaseSourceMatchCache.keys().next().value);
}
function neteaseSourceMatchHintArtists(hints) {
  hints = hints || {};
  const ids = String(hints.artistIds || hints.artistId || '').split(',').map(value => value.trim()).filter(Boolean);
  let names = String(hints.artistNames || '').split('\u001f').map(value => value.trim()).filter(Boolean);
  if (!names.length && String(hints.artist || '').trim()) names = [String(hints.artist).trim()];
  const count = Math.max(ids.length, names.length);
  const artists = [];
  for (let index = 0; index < count; index++) {
    const id = ids[index] || '';
    const name = names[index] || (count === 1 ? String(hints.artist || '').trim() : '');
    if (id || name) artists.push({ id, name });
  }
  return artists;
}
function mergeNeteaseSourceMatchSong(detailSong, searchSong, hints) {
  const detail = detailSong || {};
  const searchItem = searchSong || {};
  const merged = { ...searchItem, ...detail };
  const rawDetailArtists = detail.ar || detail.artists || [];
  const rawSearchArtists = searchItem.ar || searchItem.artists || [];
  const detailArtists = (Array.isArray(rawDetailArtists) ? rawDetailArtists : []).filter(artist => artist && (artist.id || String(artist.name || '').trim()));
  const searchArtists = (Array.isArray(rawSearchArtists) ? rawSearchArtists : []).filter(artist => artist && (artist.id || String(artist.name || '').trim()));
  const hintArtists = neteaseSourceMatchHintArtists(hints);
  const artists = (Array.isArray(detailArtists) && detailArtists.length)
    ? detailArtists
    : ((Array.isArray(searchArtists) && searchArtists.length) ? searchArtists : hintArtists);
  const detailAlbum = detail.al || detail.album || {};
  const searchAlbum = searchItem.al || searchItem.album || {};
  const album = { ...searchAlbum, ...detailAlbum };
  album.name = String(detailAlbum.name || '').trim() || String(searchAlbum.name || '').trim() || hints && hints.album || '';
  merged.id = detail.id || searchItem.id || hints && hints.id || '';
  merged.name = String(detail.name || '').trim() || String(searchItem.name || '').trim() || hints && (hints.name || hints.title) || '';
  merged.ar = artists;
  merged.artists = artists;
  merged.al = album;
  merged.album = album;
  merged.dt = detail.dt || detail.duration || searchItem.dt || searchItem.duration || neteaseSourceMatchDurationMs(hints && hints.duration);
  ['h', 'm', 'l', 'sq', 'hr', 'hMusic', 'mMusic', 'lMusic', 'sqMusic', 'hrMusic'].forEach(key => {
    if (!merged[key] && searchItem[key]) merged[key] = searchItem[key];
  });
  return merged;
}
async function findNeteaseSameTrackCandidates(id, hints, lookupDeadline) {
  hints = hints || {};
  const sourceId = String(id || '').trim();
  const title = String(hints.name || hints.title || '').trim();
  const artist = String(hints.artist || '').trim();
  if (!sourceId || !title || !artist) return [];
  const cacheKey = neteaseSourceMatchCacheKey(sourceId, hints);
  const cached = readNeteaseSourceMatchCache(cacheKey);
  if (cached) return cached;
  if (neteaseSourceMatchInflight.has(cacheKey)) return neteaseSourceMatchInflight.get(cacheKey);
  const promise = findNeteaseSameTrackCandidatesInner(id, hints, lookupDeadline).finally(() => {
    if (neteaseSourceMatchInflight.get(cacheKey) === promise) neteaseSourceMatchInflight.delete(cacheKey);
  });
  neteaseSourceMatchInflight.set(cacheKey, promise);
  return promise;
}
async function findNeteaseSameTrackCandidatesInner(id, hints, lookupDeadline) {
  hints = hints || {};
  const deadline = Number(lookupDeadline) > 0 ? Number(lookupDeadline) : Date.now() + NETEASE_SOURCE_MATCH_LOOKUP_BUDGET_MS;
  const sourceId = String(id || '').trim();
  const title = String(hints.name || hints.title || '').trim();
  const artist = String(hints.artist || '').trim();
  if (!sourceId || !title || !artist) return [];
  const cacheKey = neteaseSourceMatchCacheKey(sourceId, hints);
  const cached = readNeteaseSourceMatchCache(cacheKey);
  if (cached) return cached;
  const query = [title, artist].filter(Boolean).join(' ');
  let searchSongs = [];
  try {
    const searchBudget = Math.min(3000, Math.max(500, deadline - Date.now()));
    const result = await promiseWithTimeout(cloudsearch({ keywords: query, type: 1, limit: 16 }), searchBudget, 'NETEASE_SOURCE_SEARCH_TIMEOUT');
    searchSongs = result.body && result.body.result && Array.isArray(result.body.result.songs) ? result.body.result.songs : [];
  } catch (err) {
    console.warn('[NeteaseSourceMatch] search failed:', err.code || err.message);
    return [];
  }
  const searchById = new Map(searchSongs.map(song => [String(song && song.id || ''), song]));
  const detailIds = [sourceId].concat(searchSongs.slice(0, 12).map(song => String(song && song.id || '')).filter(Boolean));
  let detailSongs = [];
  let privileges = [];
  try {
    const detailBudget = Math.min(2000, Math.max(500, deadline - Date.now()));
    const detail = await promiseWithTimeout(song_detail({ ids: [...new Set(detailIds)].join(',') }), detailBudget, 'NETEASE_SOURCE_DETAIL_TIMEOUT');
    detailSongs = detail.body && Array.isArray(detail.body.songs) ? detail.body.songs : [];
    privileges = detail.body && Array.isArray(detail.body.privileges) ? detail.body.privileges : [];
  } catch (err) {
    console.warn('[NeteaseSourceMatch] detail failed:', err.code || err.message);
  }
  const privilegeById = new Map(privileges.map(item => [String(item && item.id || ''), item]));
  const detailById = new Map(detailSongs.map(song => [String(song && song.id || ''), song]));
  const sourceDetail = detailById.get(sourceId) || searchById.get(sourceId) || null;
  const officialRecommendationId = String(sourceDetail && sourceDetail.noCopyrightRcmd && sourceDetail.noCopyrightRcmd.songId || '');
  if (officialRecommendationId && !detailById.has(officialRecommendationId) && !searchById.has(officialRecommendationId) && deadline - Date.now() >= 500) {
    try {
      const officialDetail = await promiseWithTimeout(song_detail({ ids: officialRecommendationId }), Math.min(1000, Math.max(500, deadline - Date.now())), 'NETEASE_OFFICIAL_MATCH_DETAIL_TIMEOUT');
      const officialSongs = officialDetail.body && Array.isArray(officialDetail.body.songs) ? officialDetail.body.songs : [];
      const officialPrivileges = officialDetail.body && Array.isArray(officialDetail.body.privileges) ? officialDetail.body.privileges : [];
      officialSongs.forEach(song => detailById.set(String(song && song.id || ''), song));
      officialPrivileges.forEach(item => privilegeById.set(String(item && item.id || ''), item));
    } catch (err) {
      console.warn('[NeteaseSourceMatch] official alternate detail failed:', err.code || err.message);
    }
  }
  const source = mergeNeteaseSourceMatchSong(detailById.get(sourceId), searchById.get(sourceId), {
    ...hints,
    id: sourceId,
    name: title,
    artist,
  });
  const ranked = [];
  const candidateSeeds = searchSongs.slice();
  if (officialRecommendationId && !candidateSeeds.some(song => String(song && song.id || '') === officialRecommendationId)) {
    const officialSeed = detailById.get(officialRecommendationId) || { id: officialRecommendationId, name: title, ar: neteaseSourceMatchHintArtists(hints), dt: neteaseSourceMatchDurationMs(hints.duration) };
    candidateSeeds.unshift(officialSeed);
  }
  candidateSeeds.forEach(searchSong => {
    const candidateId = String(searchSong && searchSong.id || '');
    if (!candidateId || candidateId === sourceId) return;
    const candidate = mergeNeteaseSourceMatchSong(detailById.get(candidateId), searchSong, {});
    candidate.__privilege = privilegeById.get(candidateId) || searchSong.privilege || {};
    candidate.__officialSourceMatch = !!(officialRecommendationId && candidateId === officialRecommendationId);
    const score = neteaseSourceMatchCandidateScore(source, candidate);
    if (score < 0) return;
    ranked.push({
      song: mapSongRecord(candidate),
      score,
      fingerprintMatches: neteaseSourceMatchFingerprintCount(source, candidate),
      officialRecommendation: !!candidate.__officialSourceMatch,
      durationDiff: Math.abs(neteaseSourceMatchDurationMs(source.dt || source.duration) - neteaseSourceMatchDurationMs(candidate.dt || candidate.duration)),
    });
  });
  ranked.sort((a, b) => b.score - a.score || a.durationDiff - b.durationDiff || Number(b.song.popularity || 0) - Number(a.song.popularity || 0));
  const candidates = ranked.slice(0, NETEASE_SOURCE_MATCH_MAX_CANDIDATES);
  writeNeteaseSourceMatchCache(cacheKey, candidates);
  return candidates;
}

async function handleNeteaseAlbumDetail(id, limit) {
  const albumId = String(id || '').trim();
  const num = Math.max(10, Math.min(120, parseInt(limit || '80', 10) || 80));
  if (!albumId) return { provider: 'netease', error: 'MISSING_ALBUM_ID', album: null, songs: [] };
  const result = await album({ id: albumId, timestamp: Date.now() });
  const body = result.body || result || {};
  const info = body.album || body.data && (body.data.album || body.data) || {};
  const rawSongs = Array.isArray(body.songs) ? body.songs : (Array.isArray(info.songs) ? info.songs : []);
  const artists = mapArtists(info.artists || info.ar || []);
  const songs = rawSongs
    .slice(0, num)
    .map(song => mapSongRecord(song))
    .filter(song => song && song.id);
  return {
    provider: 'netease',
    album: {
      provider: 'netease',
      id: info.id || albumId,
      albumId: info.id || albumId,
      name: info.name || '',
      artist: artists.map(a => a.name).join(' / ') || info.artist && info.artist.name || (songs[0] && songs[0].artist) || '',
      artists,
      cover: info.picUrl || info.coverUrl || '',
      releaseDate: info.publishTime || info.publishTime === 0 ? info.publishTime : '',
      trackCount: Number(info.size || info.trackCount || rawSongs.length) || songs.length,
    },
    songs,
    total: Number(info.size || info.trackCount || rawSongs.length) || songs.length,
  };
}

// ---------- 首页发现（批 T16d：登录态退役后只回 starter） ----------
async function handleDiscoverHome() {
  return {
    loggedIn: false,
    user: null,
    dailySongs: [],
    dailySongTotal: 0,
    dailySongsComplete: true,
    playlists: [],
    mode: 'starter',
    updatedAt: Date.now(),
  };
}

const REQUEST_TEXT_MAX_BYTES = 4 * 1024 * 1024;
const sharedHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 });
const sharedHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 });

function requestText(targetUrl, opts, body) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const maxBytes = Math.max(64 * 1024, Number(opts.maxBytes) || REQUEST_TEXT_MAX_BYTES);
    const req = lib.request(u, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      agent: u.protocol === 'https:' ? sharedHttpsAgent : sharedHttpAgent,
    }, response => {
      const chunks = [];
      let received = 0;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { response.destroy(); } catch (_) {}
        reject(err);
      };
      response.on('data', chunk => {
        received += chunk.length;
        if (received > maxBytes) {
          fail(Object.assign(new Error('Response too large'), { statusCode: response.statusCode, code: 'RESPONSE_TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 400) {
          const err = new Error('HTTP ' + response.statusCode);
          err.statusCode = response.statusCode;
          err.body = text;
          reject(err);
          return;
        }
        resolve(text);
      });
      response.on('error', fail);
    });
    req.setTimeout(opts.timeoutMs || 10000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(targetUrl, opts, body) {
  const text = await requestText(targetUrl, opts, body);
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error('Invalid JSON from ' + targetUrl);
    err.cause = e;
    throw err;
  }
}

function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function openMeteoWeatherLabel(code) {
  code = Number(code);
  if (code === 0) return '晴';
  if (code === 1 || code === 2) return '少云';
  if (code === 3) return '阴';
  if (code === 45 || code === 48) return '雾';
  if (code === 51 || code === 53 || code === 55) return '毛毛雨';
  if (code === 56 || code === 57) return '冻雨';
  if (code === 61 || code === 63 || code === 65) return '雨';
  if (code === 66 || code === 67) return '冻雨';
  if (code === 71 || code === 73 || code === 75 || code === 77) return '雪';
  if (code === 80 || code === 81 || code === 82) return '阵雨';
  if (code === 85 || code === 86) return '阵雪';
  if (code === 95 || code === 96 || code === 99) return '雷雨';
  return '天气';
}

function buildWeatherMood(weather, date) {
  const now = date || new Date();
  const hour = now.getHours();
  const code = Number(weather && weather.weatherCode);
  const temp = Number(weather && weather.temperature);
  const apparent = Number(weather && weather.apparentTemperature);
  const rain = Number(weather && weather.precipitation) || 0;
  const humidity = Number(weather && weather.humidity) || 0;
  const wind = Number(weather && weather.windSpeed) || 0;
  const isNight = weather && weather.isDay === 0 || hour < 6 || hour >= 20;
  const isMorning = hour >= 5 && hour < 11;
  const isDusk = hour >= 17 && hour < 20;
  const isRain = rain > 0 || [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code);
  const isSnow = [71, 73, 75, 77, 85, 86].includes(code);
  const isCloud = [2, 3, 45, 48].includes(code);
  const isStorm = [95, 96, 99].includes(code);
  const feels = Number.isFinite(apparent) ? apparent : temp;

  let mood = {
    key: 'clear',
    title: '晴朗电台',
    tagline: '让节奏亮一点，像窗边的光',
    energy: 0.62,
    warmth: 0.58,
    focus: 0.48,
    melancholy: 0.24,
    keywords: ['轻快 华语', 'city pop', 'indie pop', 'chill pop', '阳光 歌单'],
  };
  if (isStorm) {
    mood = {
      key: 'storm',
      title: '雷雨电台',
      tagline: '低频更厚，适合把世界关小一点',
      energy: 0.46,
      warmth: 0.34,
      focus: 0.66,
      melancholy: 0.62,
      keywords: ['暗色 R&B', 'trip hop', '夜晚 电子', '氛围 摇滚', '雨夜 歌单'],
    };
  } else if (isRain) {
    mood = {
      key: 'rain',
      title: '雨天电台',
      tagline: '留一点潮湿的空间给旋律',
      energy: 0.38,
      warmth: 0.42,
      focus: 0.64,
      melancholy: 0.66,
      keywords: ['雨天 R&B', 'lofi rainy', '华语 慢歌', 'dream pop', '雨夜 歌单'],
    };
  } else if (isSnow || feels <= 3) {
    mood = {
      key: 'snow',
      title: '冷空气电台',
      tagline: '干净、慢速、带一点冬天的颗粒感',
      energy: 0.34,
      warmth: 0.28,
      focus: 0.72,
      melancholy: 0.54,
      keywords: ['冬天 民谣', 'ambient piano', '日系 冬天', 'indie folk', '安静 歌单'],
    };
  } else if (feels >= 31 || humidity >= 78) {
    mood = {
      key: 'humid',
      title: '闷热电台',
      tagline: '降低密度，留出一点呼吸',
      energy: 0.48,
      warmth: 0.76,
      focus: 0.46,
      melancholy: 0.30,
      keywords: ['夏日 chill', 'bossa nova', 'city pop 夏天', '轻电子', '海边 歌单'],
    };
  } else if (isCloud) {
    mood = {
      key: 'cloudy',
      title: '阴天电台',
      tagline: '不急着明亮，先让声音变软',
      energy: 0.40,
      warmth: 0.46,
      focus: 0.58,
      melancholy: 0.52,
      keywords: ['阴天 华语', 'indie rock mellow', 'neo soul', 'chillhop', '独立 民谣'],
    };
  }

  if (isNight) {
    mood.key += '-night';
    mood.title = mood.key.startsWith('clear') ? '夜色电台' : mood.title.replace('电台', '夜听');
    mood.tagline = '音量放低一点，让夜色参与编曲';
    mood.energy = Math.min(mood.energy, 0.42);
    mood.focus = Math.max(mood.focus, 0.68);
    mood.melancholy = Math.max(mood.melancholy, 0.52);
    mood.keywords = ['夜晚 R&B', 'late night jazz', 'ambient', 'lofi sleep', '夜跑 歌单'].concat(mood.keywords.slice(0, 3));
  } else if (isMorning) {
    mood.title = mood.key.startsWith('rain') ? '雨晨电台' : '早晨电台';
    mood.energy = Math.max(mood.energy, 0.52);
    mood.keywords = ['早晨 通勤', 'morning acoustic', '清晨 indie', '轻快 华语'].concat(mood.keywords.slice(0, 3));
  } else if (isDusk) {
    mood.title = mood.key.startsWith('rain') ? '黄昏雨声' : '黄昏电台';
    mood.melancholy = Math.max(mood.melancholy, 0.48);
    mood.keywords = ['黄昏 city pop', '日落 歌单', '落日飞车', 'soul pop'].concat(mood.keywords.slice(0, 3));
  }

  if (wind >= 28) {
    mood.energy = Math.max(mood.energy, 0.56);
    mood.keywords = ['公路 摇滚', 'windy day playlist'].concat(mood.keywords.slice(0, 4));
  }
  mood.keywords = Array.from(new Set(mood.keywords)).slice(0, 7);
  return mood;
}

async function resolveOpenMeteoLocation(query) {
  const raw = String(query || '').trim();
  if (!raw) return WEATHER_DEFAULT_LOCATION;
  const u = new URL(OPEN_METEO_GEOCODE_URL);
  u.searchParams.set('name', raw);
  u.searchParams.set('count', '1');
  u.searchParams.set('language', 'zh');
  u.searchParams.set('format', 'json');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  const first = body && Array.isArray(body.results) && body.results[0];
  if (!first) return { ...WEATHER_DEFAULT_LOCATION, query: raw, fallback: true };
  return {
    name: first.name || raw,
    country: first.country || '',
    admin1: first.admin1 || '',
    latitude: first.latitude,
    longitude: first.longitude,
    timezone: first.timezone || 'auto',
  };
}

async function fetchOpenMeteoWeather(params) {
  params = params || {};
  let location;
  const lat = clampNumber(params.lat, -90, 90, NaN);
  const lon = clampNumber(params.lon, -180, 180, NaN);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    location = {
      name: String(params.city || params.name || '当前位置').trim() || '当前位置',
      country: '',
      latitude: lat,
      longitude: lon,
      timezone: params.timezone || 'auto',
    };
  } else {
    location = await resolveOpenMeteoLocation(params.city || params.q || params.location);
  }
  const u = new URL(OPEN_METEO_FORECAST_URL);
  u.searchParams.set('latitude', String(location.latitude));
  u.searchParams.set('longitude', String(location.longitude));
  u.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m');
  u.searchParams.set('hourly', 'precipitation_probability,weather_code,temperature_2m');
  u.searchParams.set('forecast_days', '1');
  u.searchParams.set('timezone', location.timezone || 'auto');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  const cur = body && body.current || {};
  const weather = {
    provider: 'open-meteo',
    location: {
      name: location.name,
      country: location.country || '',
      admin1: location.admin1 || '',
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: body.timezone || location.timezone || '',
      fallback: !!location.fallback,
    },
    label: openMeteoWeatherLabel(cur.weather_code),
    weatherCode: Number(cur.weather_code),
    temperature: Number(cur.temperature_2m),
    apparentTemperature: Number(cur.apparent_temperature),
    humidity: Number(cur.relative_humidity_2m),
    precipitation: Number(cur.precipitation || cur.rain || cur.showers || cur.snowfall || 0),
    cloudCover: Number(cur.cloud_cover),
    windSpeed: Number(cur.wind_speed_10m),
    windGusts: Number(cur.wind_gusts_10m),
    isDay: Number(cur.is_day),
    time: cur.time || '',
    updatedAt: Date.now(),
  };
  weather.mood = buildWeatherMood(weather);
  return weather;
}

async function fetchIpWeatherLocation() {
  const u = new URL(WEATHER_IP_LOCATION_URL);
  u.searchParams.set('fields', 'status,message,country,regionName,city,lat,lon,timezone,query');
  u.searchParams.set('lang', 'zh-CN');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  if (!body || body.status !== 'success' || !Number.isFinite(Number(body.lat)) || !Number.isFinite(Number(body.lon))) {
    const err = new Error(body && body.message || 'IP_LOCATION_FAILED');
    err.body = body;
    throw err;
  }
  return {
    provider: 'ip-api',
    city: body.city || WEATHER_DEFAULT_LOCATION.name,
    region: body.regionName || '',
    country: body.country || '',
    latitude: Number(body.lat),
    longitude: Number(body.lon),
    timezone: body.timezone || 'auto',
    ip: body.query || '',
  };
}

function weatherRadioSeedQueries(mood) {
  const key = String(mood && mood.key || '');
  if (key.includes('rain') || key.includes('storm')) return ['陈奕迅 阴天快乐', '周杰伦 雨下一整晚', '孙燕姿 遇见', '林宥嘉 说谎', '毛不易 消愁'];
  if (key.includes('snow') || key.includes('cloudy')) return ['陈奕迅 好久不见', '莫文蔚 阴天', '李健 贝加尔湖畔', '朴树 平凡之路', '蔡健雅 达尔文'];
  if (key.includes('humid')) return ['落日飞车 My Jinji', '告五人 爱人错过', '夏日入侵企画 想去海边', '陈绮贞 旅行的意义', '王若琳 Lost in Paradise'];
  if (key.includes('night')) return ['方大同 特别的人', '陶喆 爱很简单', 'Frank Ocean Pink + White', '林忆莲 夜太黑', "Norah Jones Don't Know Why"];
  return ['孙燕姿 天黑黑', '周杰伦 晴天', '五月天 温柔', '陈奕迅 稳稳的幸福', '王菲'];
}

function fallbackWeatherForRadio(params, err) {
  params = params || {};
  const name = String(params.city || params.q || params.location || WEATHER_DEFAULT_LOCATION.name).trim() || WEATHER_DEFAULT_LOCATION.name;
  return {
    provider: 'open-meteo',
    location: {
      name,
      country: '',
      admin1: '',
      latitude: null,
      longitude: null,
      timezone: params.timezone || WEATHER_DEFAULT_LOCATION.timezone,
      fallback: true,
    },
    label: '天气暂不可用',
    weatherCode: null,
    temperature: null,
    apparentTemperature: null,
    humidity: null,
    precipitation: null,
    cloudCover: null,
    windSpeed: null,
    windGusts: null,
    isDay: null,
    time: '',
    updatedAt: Date.now(),
    error: err && err.message || '',
    mood: {
      key: 'fallback',
      title: '临时电台',
      tagline: '天气暂时没有回来，先放一组稳妥的歌',
      energy: 0.54,
      warmth: 0.55,
      focus: 0.55,
      melancholy: 0.35,
      keywords: ['华语 流行', 'indie pop', 'city pop', '轻快 歌单', 'chill pop'],
    },
  };
}

function uniqueSongsByKey(songs) {
  const seen = new Set();
  const out = [];
  (songs || []).forEach(song => {
    const key = String(song && (song.id || song.name + '|' + song.artist) || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(song);
  });
  return out;
}

function tagWeatherPoolSongs(songs, source) {
  return (songs || []).map(song => ({ ...song, weatherSource: source }));
}

async function fetchWeatherPlaylistSongs(playlist, limit) {
  const id = playlist && playlist.id;
  if (!id) return [];
  let rawTracks = [];
  try {
    if (typeof playlist_track_all === 'function') {
      const all = await playlist_track_all({ id, limit: limit || 36, offset: 0, timestamp: Date.now() });
      rawTracks = (all.body && (all.body.songs || all.body.tracks)) || [];
    }
  } catch (e) {
    console.warn('[WeatherRadio] playlist_track_all failed:', playlist && playlist.name, e.message);
  }
  if (!rawTracks.length && typeof playlist_detail === 'function') {
    try {
      const detail = await playlist_detail({ id, s: 0, timestamp: Date.now() });
      const pl = (detail.body && detail.body.playlist) || {};
      rawTracks = pl.tracks || [];
    } catch (e) {
      console.warn('[WeatherRadio] playlist_detail failed:', playlist && playlist.name, e.message);
    }
  }
  return rawTracks.map(mapSongRecord).filter(song => song.id && song.name).slice(0, limit || 36);
}

const NETEASE_PLAYLIST_SYNC_PAGE_SIZE = 200;
const NETEASE_PLAYLIST_SYNC_MAX_PAGES = 80;
const NETEASE_TRACK_SYNC_PAGE_SIZE = 500;
const NETEASE_TRACK_SYNC_MAX_PAGES = 80;
const NETEASE_TRACK_STREAM_PAGE_SIZE = 200;
const NETEASE_PLAYLIST_TRACK_INDEX_TTL_MS = 10 * 60 * 1000;
const NETEASE_PLAYLIST_TRACK_INDEX_MAX_ENTRIES = 8;
const neteasePlaylistTrackIndexCache = new Map();
const neteasePlaylistTrackIndexInflight = new Map();

function mapNeteasePlaylistMeta(pl, fallbackId) {
  pl = pl || {};
  return {
    id: pl.id || fallbackId,
    name: pl.name || '',
    cover: pl.coverImgUrl || pl.cover || '',
    trackCount: pl.trackCount || pl.track_count || 0,
    playCount: pl.playCount || pl.play_count || 0,
    creator: (pl.creator && pl.creator.nickname) || pl.creatorNickname || '',
    subscribed: !!pl.subscribed,
    specialType: pl.specialType || 0,
  };
}

function mergeUniqueNeteasePlaylists(target, incoming, seen) {
  (incoming || []).forEach(pl => {
    const id = String(pl && pl.id || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    target.push(pl);
  });
}

async function fetchAllNeteaseUserPlaylists(uid, maxItems) {
  const playlists = [];
  const seen = new Set();
  let offset = 0;
  let total = 0;
  for (let page = 0; page < NETEASE_PLAYLIST_SYNC_MAX_PAGES; page += 1) {
    const r = await user_playlist({
      uid,
      limit: NETEASE_PLAYLIST_SYNC_PAGE_SIZE,
      offset,
      timestamp: Date.now(),
    });
    const body = r.body || r || {};
    const raw = Array.isArray(body.playlist) ? body.playlist : [];
    total = Number(body.total || body.count || total) || total;
    mergeUniqueNeteasePlaylists(playlists, raw, seen);
    if (maxItems && playlists.length >= maxItems) break;
    if (!raw.length || raw.length < NETEASE_PLAYLIST_SYNC_PAGE_SIZE) break;
    if (total && playlists.length >= total) break;
    offset += NETEASE_PLAYLIST_SYNC_PAGE_SIZE;
  }
  return maxItems ? playlists.slice(0, maxItems) : playlists;
}

async function fetchNeteaseUserPlaylistsPage(uid, limit, offset) {
  limit = Math.max(1, Math.min(NETEASE_PLAYLIST_SYNC_PAGE_SIZE, parseInt(limit || '48', 10) || 48));
  offset = Math.max(0, parseInt(offset || '0', 10) || 0);
  const r = await user_playlist({
    uid,
    limit,
    offset,
    timestamp: Date.now(),
  });
  const body = r.body || r || {};
  const playlists = Array.isArray(body.playlist) ? body.playlist : [];
  const total = Math.max(Number(body.total || body.count || 0) || 0, offset + playlists.length);
  const nextOffset = offset + playlists.length;
  return {
    playlists,
    total,
    offset,
    limit,
    nextOffset,
    hasMore: total ? nextOffset < total : playlists.length >= limit,
  };
}

function neteaseRawTrackKey(track, fallback) {
  track = track || {};
  const privilege = track.privilege || {};
  const album = track.al || track.album || {};
  return String(
    track.id ||
    track.songId ||
    track.resourceId ||
    privilege.id ||
    ((track.name || '') + '|' + (album.id || album.name || '') + '|' + fallback)
  );
}

function mergeUniqueNeteaseTracks(target, incoming, seen) {
  let added = 0;
  (incoming || []).forEach((track, index) => {
    const key = neteaseRawTrackKey(track, target.length + ':' + index);
    if (!key || seen.has(key)) return;
    seen.add(key);
    target.push(track);
    added += 1;
  });
  return added;
}

async function fetchNeteasePlaylistDetailMeta(id) {
  if (typeof playlist_detail !== 'function') return { playlistMeta: { id, name: '', cover: '', trackCount: 0 }, tracks: [] };
  const detail = await playlist_detail({ id, s: 0, timestamp: Date.now() });
  const pl = (detail.body && detail.body.playlist) || {};
  return { playlistMeta: mapNeteasePlaylistMeta(pl, id), tracks: Array.isArray(pl.tracks) ? pl.tracks : [] };
}

function pruneNeteasePlaylistTrackIndexCache() {
  const now = Date.now();
  for (const [key, entry] of neteasePlaylistTrackIndexCache.entries()) {
    if (!entry || now - entry.updatedAt > NETEASE_PLAYLIST_TRACK_INDEX_TTL_MS) {
      neteasePlaylistTrackIndexCache.delete(key);
    }
  }
  while (neteasePlaylistTrackIndexCache.size > NETEASE_PLAYLIST_TRACK_INDEX_MAX_ENTRIES) {
    const oldestKey = neteasePlaylistTrackIndexCache.keys().next().value;
    if (oldestKey == null) break;
    neteasePlaylistTrackIndexCache.delete(oldestKey);
  }
}

function invalidateNeteasePlaylistTrackIndex(id) {
  const key = String(id || '');
  if (key) neteasePlaylistTrackIndexCache.delete(key);
}

async function fetchNeteasePlaylistTrackIndex(id) {
  const key = String(id || '');
  if (!key || typeof playlist_detail !== 'function') return null;
  pruneNeteasePlaylistTrackIndexCache();
  const cached = neteasePlaylistTrackIndexCache.get(key);
  if (cached && Date.now() - cached.updatedAt <= NETEASE_PLAYLIST_TRACK_INDEX_TTL_MS) {
    neteasePlaylistTrackIndexCache.delete(key);
    neteasePlaylistTrackIndexCache.set(key, cached);
    return cached;
  }
  if (neteasePlaylistTrackIndexInflight.has(key)) return neteasePlaylistTrackIndexInflight.get(key);
  const pending = (async () => {
    const detail = await playlist_detail({ id, s: 0, timestamp: Date.now() });
    const pl = (detail.body && detail.body.playlist) || {};
    const rawIds = Array.isArray(pl.trackIds) && pl.trackIds.length ? pl.trackIds : (pl.tracks || []);
    const trackIds = rawIds.map(item => item && (item.id || item.songId || item.trackId)).filter(Boolean);
    const entry = {
      playlistMeta: mapNeteasePlaylistMeta(pl, id),
      trackIds,
      updatedAt: Date.now(),
    };
    if (!entry.playlistMeta.trackCount) entry.playlistMeta.trackCount = trackIds.length;
    neteasePlaylistTrackIndexCache.set(key, entry);
    pruneNeteasePlaylistTrackIndexCache();
    return entry;
  })().finally(() => {
    neteasePlaylistTrackIndexInflight.delete(key);
  });
  neteasePlaylistTrackIndexInflight.set(key, pending);
  return pending;
}

async function fetchAllNeteasePlaylistTracks(id) {
  let playlistMeta = { id, name: '', cover: '', trackCount: 0 };
  let detailTracks = [];
  try {
    const detail = await fetchNeteasePlaylistDetailMeta(id);
    playlistMeta = detail.playlistMeta || playlistMeta;
    detailTracks = detail.tracks || [];
  } catch (err) {
    console.warn('[PlaylistTracks] playlist_detail meta failed:', err.message);
  }

  const rawTracks = [];
  const seen = new Set();
  const expectedTotal = Number(playlistMeta.trackCount || 0) || 0;

  if (typeof playlist_track_all === 'function') {
    let offset = 0;
    for (let page = 0; page < NETEASE_TRACK_SYNC_MAX_PAGES; page += 1) {
      try {
        const all = await playlist_track_all({
          id,
          limit: NETEASE_TRACK_SYNC_PAGE_SIZE,
          offset,
          timestamp: Date.now(),
        });
        const body = all.body || all || {};
        const rows = (body.songs || body.tracks || []);
        const added = mergeUniqueNeteaseTracks(rawTracks, rows, seen);
        if (!rows.length || !added) break;
        if (expectedTotal && rawTracks.length >= expectedTotal) break;
        if (!expectedTotal && rows.length < NETEASE_TRACK_SYNC_PAGE_SIZE) break;
        offset += NETEASE_TRACK_SYNC_PAGE_SIZE;
      } catch (err) {
        console.warn('[PlaylistTracks] playlist_track_all page failed:', id, offset, err.message);
        break;
      }
    }
  }

  if (!rawTracks.length && detailTracks.length) {
    mergeUniqueNeteaseTracks(rawTracks, detailTracks, seen);
  }

  return { playlistMeta, rawTracks };
}

async function fetchNeteasePlaylistTracksPage(id, limit, offset) {
  limit = Math.max(1, Math.min(NETEASE_TRACK_STREAM_PAGE_SIZE, parseInt(limit || '48', 10) || 48));
  offset = Math.max(0, parseInt(offset || '0', 10) || 0);
  let rawTracks = [];
  let playlistMeta = { id, name: '', cover: '', trackCount: 0 };
  let total = 0;
  let requestedCount = 0;
  try {
    const index = await fetchNeteasePlaylistTrackIndex(id);
    if (index && index.trackIds && index.trackIds.length) {
      playlistMeta = index.playlistMeta || playlistMeta;
      total = index.trackIds.length;
      const pageIds = index.trackIds.slice(offset, offset + limit);
      requestedCount = pageIds.length;
      if (pageIds.length) {
        const detail = await song_detail({ ids: pageIds.join(','), timestamp: Date.now() });
        const body = detail.body || detail || {};
        const rows = body.songs || body.tracks || [];
        const byId = new Map(rows.map(track => [String(track && track.id || ''), track]));
        rawTracks = pageIds.map(trackId => byId.get(String(trackId))).filter(Boolean);
      }
    }
  } catch (err) {
    console.warn('[PlaylistTracks] cached track index failed:', id, offset, err.message);
  }
  if (!requestedCount && !rawTracks.length && typeof playlist_track_all === 'function') {
    const page = await playlist_track_all({ id, limit, offset, timestamp: Date.now() });
    const body = page.body || page || {};
    rawTracks = body.songs || body.tracks || [];
    requestedCount = rawTracks.length;
    total = Number(body.total || body.count || body.songCount || body.trackCount || 0) || 0;
  }
  if (!rawTracks.length && !requestedCount && typeof playlist_detail === 'function') {
    try {
      const detail = await fetchNeteasePlaylistDetailMeta(id);
      playlistMeta = detail.playlistMeta || playlistMeta;
      total = Math.max(total, Number(playlistMeta.trackCount || 0) || 0);
      if (!rawTracks.length) rawTracks = (detail.tracks || []).slice(offset, offset + limit);
    } catch (err) {
      console.warn('[PlaylistTracks] paged metadata failed:', id, err.message);
    }
  }
  if (!playlistMeta.trackCount && total) playlistMeta.trackCount = total;
  const nextOffset = offset + Math.max(requestedCount, rawTracks.length);
  return {
    playlistMeta,
    rawTracks,
    total,
    offset,
    limit,
    nextOffset,
    hasMore: total ? nextOffset < total : rawTracks.length >= limit,
  };
}

async function filterLikelyPlayableWeatherSongs(songs) {
  const source = uniqueSongsByKey(songs)
    .filter(song => song && song.name && song.id && !isLowSignalWeatherSong(song))
    .slice(0, 24);
  const playable = [];
  const fallback = source.slice(0, 24);
  for (let i = 0; i < source.length; i += 4) {
    const chunk = source.slice(i, i + 4);
    const settled = await Promise.allSettled(chunk.map(async song => {
      const info = await handleSongUrl(song.id, { loggedIn: false }, 'standard');
      return info && info.url ? song : null;
    }));
    settled.forEach((result, idx) => {
      if (result.status === 'fulfilled' && result.value) playable.push(result.value);
      else if (result.status === 'rejected') console.warn('[WeatherRadio] playable probe failed:', chunk[idx] && chunk[idx].name, result.reason && result.reason.message);
    });
    if (playable.length >= 12) break;
  }
  return (playable.length ? playable : fallback).slice(0, 24);
}

function isLowSignalWeatherSong(song) {
  const text = String([
    song && song.name,
    song && song.artist,
    song && song.album,
  ].filter(Boolean).join(' ')).toLowerCase();
  if (!text) return true;
  if (/(^|[\s\-_/（(])ai(?:\s*(歌|歌曲|音乐|cover|翻唱|生成|作曲|演唱|女声|男声)|$|[\s\-_/）)])/i.test(text)) return true;
  if (/suno|udio|人工智能|生成歌曲|ai歌曲|虚拟歌手|测试音频|demo|beat\s*maker/i.test(text)) return true;
  if (/翻自|翻唱|cover|remix|伴奏|纯音乐|钢琴|dj|live\s*版|live版|唯美钢琴|karaoke|instrumental/i.test(text)) return true;
  if (/白噪音|雨声|睡眠|助眠|冥想|疗愈频率|环境音|自然声音|asmr/i.test(text)) return true;
  if (/[（(](r&b|lofi|jazz|dj|edm|trap|remix|伴奏|纯音乐|钢琴|电子|治愈|古风|女声|男声|英文|中文版|抖音|ai)[）)]/i.test(text)) return true;
  if (/^(纯音乐|轻音乐|治愈系|放松|睡眠|雨天|阴天|夜晚|夏日|海边)$/i.test(String(song.name || '').trim())) return true;
  return false;
}

function scoreWeatherSong(song, mood) {
  const text = String((song && song.name || '') + ' ' + (song && song.artist || '') + ' ' + (song && song.album || '')).toLowerCase();
  let score = 0;
  if (song && song.cover) score += 4;
  if (song && song.duration) score += 2;
  if (song && song.weatherSource === 'daily') score += 6;
  if (song && song.weatherSource === 'private') score += 4;
  if (/周杰伦|陈奕迅|孙燕姿|五月天|王菲|陶喆|方大同|林宥嘉|蔡健雅|莫文蔚|李健|毛不易|告五人|落日飞车|陈绮贞|朴树/.test(text)) score += 10;
  const key = String(mood && mood.key || '');
  if (key.includes('rain') && /雨|阴|夜|慢|r&b|soul|陈奕迅|林宥嘉|孙燕姿/.test(text)) score += 5;
  if (key.includes('humid') && /夏|海|city|pop|落日|告五人|方大同|陶喆/.test(text)) score += 5;
  if (key.includes('night') && /夜|moon|jazz|soul|r&b|方大同|陶喆|王菲/.test(text)) score += 5;
  if (key.includes('cloudy') && /阴|民谣|indie|陈绮贞|朴树|李健/.test(text)) score += 5;
  return score;
}

function weatherArtistKey(song) {
  const raw = String(song && song.artist || song && song.name || '').split(/\s*\/\s*|、|,|&/)[0] || '';
  return raw.trim().toLowerCase() || 'unknown';
}

function weatherTitleKey(song) {
  return String(song && song.name || '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s._\-·'’"“”「」《》:：/\\|]+/g, '')
    .trim();
}

function uniqueWeatherTitles(sorted) {
  const seen = new Set();
  const out = [];
  (sorted || []).forEach(song => {
    const key = weatherTitleKey(song);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    out.push(song);
  });
  return out;
}

function diversifyWeatherSongs(sorted, artistLimit) {
  const primary = [];
  const deferred = [];
  const counts = new Map();
  (sorted || []).forEach(song => {
    const key = weatherArtistKey(song);
    const count = counts.get(key) || 0;
    if (count < artistLimit) {
      primary.push(song);
      counts.set(key, count + 1);
    } else {
      deferred.push(song);
    }
  });
  return primary.length >= 8 ? primary : primary.concat(deferred.slice(0, 8 - primary.length));
}

function orderWeatherSongs(songs, mood) {
  const sorted = uniqueSongsByKey(songs)
    .filter(song => song && song.name && song.id && !isLowSignalWeatherSong(song))
    .sort((a, b) => scoreWeatherSong(b, mood) - scoreWeatherSong(a, mood));
  return diversifyWeatherSongs(uniqueWeatherTitles(sorted), 2);
}

async function buildWeatherRadio(params) {
  let weather;
  try {
    weather = await fetchOpenMeteoWeather(params);
  } catch (e) {
    console.warn('[WeatherRadio] weather provider failed, using fallback radio:', e.message);
    weather = fallbackWeatherForRadio(params, e);
  }
  const queries = weatherRadioSeedQueries(weather.mood);
  let songs = [];
  const settled = await Promise.allSettled(queries.slice(0, 4).map(q => handleSearch(q, 6)));
  settled.forEach(result => {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) songs = songs.concat(result.value);
  });
  if (songs.length < 10 && weather.mood && Array.isArray(weather.mood.keywords)) {
    const more = await Promise.allSettled(weather.mood.keywords.slice(0, 2).map(q => handleSearch(q, 6)));
    more.forEach(result => {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) songs = songs.concat(result.value);
    });
  }
  songs = orderWeatherSongs(songs, weather.mood);
  return {
    ok: true,
    weather,
    radio: {
      title: weather.mood.title,
      subtitle: weather.mood.tagline,
      seedQueries: queries.slice(0, 4),
      songs: songs.slice(0, 18),
      updatedAt: Date.now(),
    },
  };
}

function audioProxyHeadersFor(audioUrl, range) {
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
  try {
    const host = new URL(audioUrl).hostname.toLowerCase();
    if (host.includes('qq.com') || host.includes('qpic.cn')) headers.Referer = 'https://y.qq.com/';
    if (host.includes('qishui.com') || host.includes('byteimg.com') || host.includes('douyin')) headers.Referer = 'https://www.qishui.com/';
    // Kugou 播放页 Referer（原 kugou-api.kugouAudioReferer 内联，见缺口台账）
    if (host.includes('kugou.com')) headers.Referer = 'https://www.kugou.com/';
  } catch (e) {}
  if (range) headers.Range = range;
  return headers;
}

// —— /api/audio 增强合并（批 T8，逐字移植上游 server.js:353-383，身份命名不变）——
// proxyUrl 经 audioProxyUrl 追加 h=base64url(JSON) 播放头参数，/api/audio 侧由
// audioProxyHeadersFromQuery 解析并按白名单转发上游；CRLF 消毒（上游 :373）防头注入。
function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value || {}), 'utf8').toString('base64url');
}
function parseBase64UrlJson(value) {
  try {
    if (!value) return {};
    return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')) || {};
  } catch (_err) {
    return {};
  }
}
function audioProxyHeadersFromQuery(value) {
  const raw = parseBase64UrlJson(value);
  const out = {};
  const allowed = new Set(['accept', 'cookie', 'origin', 'referer', 'user-agent']);
  for (const [rawKey, rawValue] of Object.entries(raw || {})) {
    const key = String(rawKey || '').trim().toLowerCase();
    if (!allowed.has(key) || rawValue == null) continue;
    out[key] = String(rawValue).replace(/[\r\n]+/g, ' ');
  }
  return out;
}
function audioProxyUrl(originalUrl, headers) {
  if (!originalUrl) return '';
  const params = new URLSearchParams({ url: originalUrl });
  if (headers && Object.keys(headers).length) params.set('h', base64UrlJson(headers));
  return '/api/audio?' + params.toString();
}
// 大小写无关头合并：overrides（audioProxyHeadersFromQuery 的小写白名单键）需覆盖 base
//（audioProxyHeadersFor 的 'User-Agent'/'Referer' 混合大小写默认）。同名异案键若并存，
// undici Headers 初始化按 append 语义会把值拼成 "a, b"，故先删旧键再写入。
function mergeAudioProxyRequestHeaders(base, overrides) {
  const out = Object.assign({}, base);
  for (const [key, value] of Object.entries(overrides || {})) {
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete out[existing];
    }
    out[key] = value;
  }
  return out;
}

function audioContentTypeForUrl(audioUrl, upstreamType) {
  let pathname = '';
  try { pathname = new URL(audioUrl).pathname.toLowerCase(); } catch (e) {}
  if (/\.flac$/.test(pathname)) return 'audio/flac';
  if (/\.mp3$/.test(pathname)) return 'audio/mpeg';
  if (/\.(m4a|mp4)$/.test(pathname)) return 'audio/mp4';
  if (/\.ogg$/.test(pathname)) return 'audio/ogg';
  if (/\.wav$/.test(pathname)) return 'audio/wav';
  return upstreamType || 'audio/mpeg';
}

//   返回 { url, trial, level, br }
//   trial=true 表示这是试听片段 (freeTrialInfo 非空)
// 批 T16d：/api/song/url 保留为无凭证公开端点（本地歌联网匹配重试仍在用）。
const ANONYMOUS_PLAYBACK_LOGIN = Object.freeze({
  loggedIn: false,
  hasCookie: false,
  vipType: 0,
  vipLevel: 'none',
  isVip: false,
  isSvip: false,
  vipLabel: '无VIP',
});
async function resolveNeteaseDirectSongUrl(id, loginInfo, qualityPreference) {
  const songId = String(id || '').trim();
  if (!songId) return resolveNeteaseDirectSongUrlInner(id, loginInfo, qualityPreference);
  const qualityKey = String(qualityPreference && typeof qualityPreference === 'object'
    ? JSON.stringify(qualityPreference)
    : (qualityPreference || 'auto'));
  const cacheKey = songId + '|' + qualityKey;
  return neteaseSongUrlCache.wrap(cacheKey, 3 * 60 * 1000, () =>
    resolveNeteaseDirectSongUrlInner(id, loginInfo, qualityPreference));
}
async function resolveNeteaseDirectSongUrlInner(id, loginInfo, qualityPreference) {
  console.log('[SongUrl] id:', id);
  const resolveDeadline = Date.now() + NETEASE_DIRECT_RESOLVE_BUDGET_MS;
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const svipReady = hasNeteaseSvip(loginInfo);
  const qualities = qualityCandidatesFrom(requestedQuality, NETEASE_QUALITY_CANDIDATES)
    .filter(q => !q.svip || svipReady);

  let trialFallback = null; // 兜底: 即使是试听也要能播
  let lastData = null;
  let lastError = null;
  const probeFailures = [];
  const probeCache = new Map();

  for (const q of qualities) {
    if (resolveDeadline - Date.now() < 500) break;
    try {
      // 优先用 v1 接口 (支持更高音质 level 字段)
      let result;
      try {
        result = await promiseWithTimeout(
          song_url_v1({ id, level: q.level }),
          Math.min(2600, Math.max(500, resolveDeadline - Date.now())),
          'NETEASE_DIRECT_URL_TIMEOUT'
        );
      } catch (e) {
        lastError = e;
        if (resolveDeadline - Date.now() < 500) throw e;
        result = await promiseWithTimeout(
          song_url({ id, br: q.br }),
          Math.min(2200, Math.max(500, resolveDeadline - Date.now())),
          'NETEASE_LEGACY_URL_TIMEOUT'
        );
      }
      const d = result.body && result.body.data && result.body.data[0];
      if (d) lastData = d;
      const url = d && d.url;
      const freeTrial = d && d.freeTrialInfo;
      console.log('[SongUrl]', q.level, '->', url ? 'OK' : 'no url', freeTrial ? '(TRIAL)' : '');
      let probe = null;
      if (url) {
        probe = probeCache.get(url);
        if (!probe) {
          probe = await probePlaybackAudioUrl(url, Math.min(2500, Math.max(600, resolveDeadline - Date.now())));
          probeCache.set(url, probe);
        }
        if (!probe.ok || !probe.magic) {
          probeFailures.push(q.level + ':' + (probe.status || probe.reason || 'invalid-audio'));
          continue;
        }
      }
      if (url && !freeTrial && probe && probe.ok) {
        return {
          provider: 'netease',
          source: 'netease',
          url,
          trial: false,
          playable: true,
          level: q.level,
          quality: q.label,
          br: d.br,
          requestedQuality,
          probeStatus: probe.status,
          probeBytes: probe.bytes,
          probeMagic: probe.magic,
        };
      }
      if (url && freeTrial && probe && probe.ok && !trialFallback) {
        trialFallback = {
          provider: 'netease',
          source: 'netease',
          url,
          trial: true,
          playable: true,
          level: q.level,
          quality: q.label,
          br: d.br,
          requestedQuality,
          trialInfo: freeTrial,
          restriction: classifyNeteasePlaybackRestriction(d, loginInfo),
          probeStatus: probe.status,
          probeBytes: probe.bytes,
          probeMagic: probe.magic,
        };
      }
    } catch (err) {
      lastError = err;
      console.log('[SongUrl]', q.level, 'failed:', err.message);
    }
  }
  if (trialFallback) return trialFallback;
  const restriction = classifyNeteasePlaybackRestriction(lastData, loginInfo);
  return {
    provider: 'netease',
    source: 'netease',
    url: null,
    trial: false,
    playable: false,
    reason: restriction.category,
    message: restriction.message,
    restriction,
    lastCode: lastData && lastData.code,
    fee: lastData && lastData.fee,
    error: lastError && lastError.message,
    probeFailures: probeFailures.slice(0, 12),
    requestedQuality,
  };
}

async function resolveNeteaseSameTrackPlayback(id, loginInfo, qualityPreference, matchHints, requestDeadline) {
  const ownDeadline = Date.now() + NETEASE_SOURCE_MATCH_TOTAL_BUDGET_MS;
  const deadline = Number(requestDeadline) > 0 ? Math.min(ownDeadline, Number(requestDeadline)) : ownDeadline;
  let candidates = [];
  try {
    const lookupBudget = Math.min(NETEASE_SOURCE_MATCH_LOOKUP_BUDGET_MS, Math.max(500, deadline - Date.now()));
    candidates = await promiseWithTimeout(
      findNeteaseSameTrackCandidates(id, matchHints, Date.now() + lookupBudget),
      lookupBudget,
      'NETEASE_SOURCE_MATCH_LOOKUP_TIMEOUT'
    );
  } catch (err) {
    console.warn('[NeteaseSourceMatch] lookup failed:', err.code || err.message);
    return null;
  }
  const excludedIds = new Set(String(matchHints && matchHints.excludeIds || '')
    .split(',')
    .map(value => String(value || '').trim())
    .filter(Boolean));
  const attemptedIds = [...excludedIds];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const candidateId = String(candidate && candidate.song && candidate.song.id || '');
    if (!candidateId || excludedIds.has(candidateId)) continue;
    attemptedIds.push(candidateId);
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 800) break;
      const playback = await promiseWithTimeout(
        resolveNeteaseDirectSongUrl(candidate.song.id, loginInfo, qualityPreference),
        Math.min(NETEASE_DIRECT_RESOLVE_BUDGET_MS, remainingMs),
        'NETEASE_SOURCE_MATCH_PLAYBACK_TIMEOUT'
      );
      if (!playback || !playback.url || playback.trial) continue;
      return { candidate, playback, triedIds: attemptedIds.slice() };
    } catch (err) {
      console.warn('[NeteaseSourceMatch] candidate failed:', candidate.song && candidate.song.id, err.code || err.message);
    }
  }
  return null;
}

async function handleSongUrl(id, loginInfo, qualityPreference, matchHints) {
  const hints = matchHints || {};
  const requestDeadline = Date.now() + NETEASE_SONG_URL_TOTAL_BUDGET_MS;
  let direct = null;
  if (!hints.skipDirect) {
    try {
      direct = await promiseWithTimeout(
        resolveNeteaseDirectSongUrl(id, loginInfo, qualityPreference),
        Math.min(NETEASE_DIRECT_RESOLVE_BUDGET_MS + 300, Math.max(500, requestDeadline - Date.now())),
        'NETEASE_DIRECT_RESOLVE_TIMEOUT'
      );
    } catch (err) {
      const restriction = playbackRestriction('netease', 'url_unavailable', '网易云音源请求超时，已继续尝试站内同一录音版本', 'retry', { code: err.code || 'NETEASE_DIRECT_RESOLVE_TIMEOUT' });
      direct = {
        provider: 'netease',
        source: 'netease',
        url: null,
        trial: false,
        playable: false,
        reason: restriction.category,
        message: restriction.message,
        restriction,
        error: err.code || err.message,
      };
    }
  } else {
    const restriction = playbackRestriction('netease', 'url_unavailable', '正在继续尝试网易云站内的其它同曲版本', 'retry', { code: 'NETEASE_DIRECT_SKIPPED_AFTER_MATCH_FAILURE' });
    direct = {
      provider: 'netease',
      source: 'netease',
      url: null,
      trial: false,
      playable: false,
      reason: restriction.category,
      message: restriction.message,
      restriction,
      error: 'NETEASE_DIRECT_SKIPPED_AFTER_MATCH_FAILURE',
    };
  }
  if (direct && direct.url && !direct.trial) return direct;
  const sourceMatchAttempted = !!(String(hints.name || hints.title || '').trim() && String(hints.artist || '').trim());
  const matched = await resolveNeteaseSameTrackPlayback(id, loginInfo, qualityPreference, hints, requestDeadline);
  if (!matched) return { ...direct, sourceMatchAttempted };
  return {
    ...matched.playback,
    provider: 'netease',
    source: 'netease-same-track',
    sourceMatch: true,
    matchKind: matched.candidate.fingerprintMatches > 0
      ? 'netease_same_recording'
      : (matched.candidate.officialRecommendation ? 'netease_official_alternate' : 'netease_same_track_metadata'),
    matchedFromId: String(id || ''),
    requestedSongId: String(id || ''),
    resolvedNeteaseId: String(matched.candidate.song.id || ''),
    resolvedSongId: String(matched.candidate.song.id || ''),
    matchedSong: matched.candidate.song,
    matchScore: Math.round(matched.candidate.score || 0),
    fingerprintMatches: matched.candidate.fingerprintMatches || 0,
    sourceMatchTriedIds: matched.triedIds || [String(matched.candidate.song.id || '')],
    originalRestriction: direct && direct.restriction || null,
  };
}

function normalizeListenReportProvider(value) {
  value = String(value || '').trim().toLowerCase();
  if (value === 'qq' || value === 'kugou' || value === 'qishui' || value === 'spotify') return value;
  return value === 'netease' || value === 'cloud' || value === 'song' ? 'netease' : '';
}

function listenReportSongId(provider, song) {
  song = song && typeof song === 'object' ? song : {};
  if (provider === 'qq') return String(song.qqId || song.mid || song.mediaMid || song.id || '');
  if (provider === 'kugou') return String(song.hash || song.mixSongId || song.providerSongId || song.id || '');
  if (provider === 'qishui') return String(song.providerSongId || song.trackId || song.id || '');
  if (provider === 'spotify') return String(song.spotifyId || song.providerSongId || song.id || '').replace(/^spotify:track:/i, '');
  return String(song.id || song.providerSongId || '');
}

function validateListenReport(body) {
  body = body && typeof body === 'object' ? body : {};
  const song = body.song && typeof body.song === 'object' ? body.song : {};
  const provider = normalizeListenReportProvider(
    body.provider || song.provider || song.source || song.sourceKey || song.type || song.resolvedPlaybackProvider
  );
  const songId = listenReportSongId(provider, song);
  const sessionId = String(body.sessionId || '').trim().slice(0, 160);
  const listenMs = Math.max(0, Math.min(12 * 60 * 60 * 1000, Math.round(Number(body.listenMs) || 0)));
  const durationMs = Math.max(0, Math.min(12 * 60 * 60 * 1000, Math.round(Number(body.durationMs) || 0)));
  const cappedListenMs = durationMs > 0 ? Math.min(listenMs, durationMs + 2500) : listenMs;
  const requiredMs = durationMs > 0
    ? (durationMs <= 30000 ? durationMs * 0.8 : Math.min(30000, durationMs * 0.5))
    : 30000;
  const eligible = !!(
    provider &&
    songId &&
    sessionId.length >= 8 &&
    cappedListenMs >= Math.max(5000, requiredMs) &&
    song.type !== 'local' &&
    !song.trial
  );
  return {
    provider,
    song,
    songId,
    sessionId,
    listenMs: cappedListenMs,
    durationMs,
    requiredMs: Math.ceil(requiredMs),
    eligible,
    context: body.context && typeof body.context === 'object' ? body.context : {},
  };
}

async function handleLocalListenReport(body) {
  const report = validateListenReport(body);
  return {
    provider: report.provider || 'unknown',
    songId: report.songId,
    sessionId: report.sessionId,
    listenMs: report.listenMs,
    durationMs: report.durationMs,
    eligible: report.eligible,
    accepted: true,
    localRecorded: true,
    platformSubmitted: false,
    historySynced: false,
    accountDurationSync: 'unsupported',
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pn = url.pathname;

  // ---------- 平台登录族 + 五平台官方 API 统一收口（批 T16d） ----------
  // 主人裁定：LX 世界观不持有平台 cookie 登录态，官方 API 连根退役。
  // 保留面：/api/song/url、/api/playlist/tracks、/api/album/detail、/api/artist/detail、
  // /api/lyric、/api/search、/api/discover/home（网易云公开元数据），不在此列。
  if (
    pn === '/api/platform/capabilities'
    || pn === '/api/listen/total'
    || pn === '/api/login/cookie'
    || pn === '/api/login/qr/key'
    || pn === '/api/login/qr/create'
    || pn === '/api/login/qr/check'
    || pn === '/api/login/status'
    || pn === '/api/logout'
    || pn === '/api/user/playlists'
    || pn === '/api/album/subscribe'
    || pn === '/api/album/subscribe/check'
    || pn === '/api/playlist/subscribe'
    || pn === '/api/song/like/check'
    || pn === '/api/song/like'
    || pn === '/api/playlist/create'
    || pn === '/api/playlist/add-song'
    || pn === '/api/song/comments'
    || pn === '/api/song/comments/like'
    || pn.startsWith('/api/qq/')
    || pn.startsWith('/api/kugou/')
    || pn.startsWith('/api/qishui/')
    || pn.startsWith('/api/spotify/')
  ) {
    sendJSON(res, { ok: false, error: 'REMOVED' }, 404);
    return;
  }
  res._cors = corsHeadersFor(req);
  if (pn.startsWith('/api/') && isCrossSiteWrite(req)) {
    console.warn('[Origin-Guard] blocked', req.method, pn, 'origin=' + (req.headers.origin || '-'), 'sec-fetch-site=' + (req.headers['sec-fetch-site'] || '-'));
    sendJSON(res, { error: 'FORBIDDEN_ORIGIN', message: 'Cross-site write to local API is not allowed' }, 403);
    return;
  }


  // ---------- 世界页数据源（M4 内容已移除，保留接口说明） ----------
  if (pn === '/api/world/beacons' || pn === '/api/world/quakes' || pn === '/api/world/satellites') {
    sendJSON(res, { ok: false, error: 'REMOVED', message: '内容数据源已移除；放映房间见 /api/rooms' }, 404);
    return;
  }

  // ---------- 世界页「一起看」房间信令（M5） ----------
  if (pn === '/api/rooms' || pn.startsWith('/api/room')) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJSON(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    await worldRoomApi.handle(req, res, url, sendJSON);
    return;
  }

  // ---------- 世界页地图瓦片代理（同源，消除 CORS / 网络不稳） ----------
  // GET /api/map-tile/{z}/{y}/{x}
  if (pn.startsWith('/api/map-tile/')) {
    const parts = pn.split('/').filter(Boolean); // ['api','map-tile',z,y,x]
    const z = parseInt(parts[2], 10);
    const y = parseInt(parts[3], 10);
    const x = parseInt(parts[4], 10);
    if (!Number.isInteger(z) || !Number.isInteger(y) || !Number.isInteger(x) ||
        z < 0 || z > 19 || y < 0 || x < 0) {
      sendJSON(res, { ok: false, error: 'BAD_TILE' }, 400);
      return;
    }
    const tileKey = z + '/' + y + '/' + x;
    const cached = mapTileCache.get(tileKey);
    if (cached) {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(cached);
      return;
    }
    const tileUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + y + '/' + x;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(tileUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) {
        sendJSON(res, { ok: false, error: 'TILE_HTTP_' + resp.status }, 502);
        return;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > 0 && buf.length < 2 * 1024 * 1024) {
        mapTileCache.set(tileKey, buf);
        if (mapTileCache.size > 600) {
          const firstKey = mapTileCache.keys().next().value;
          mapTileCache.delete(firstKey);
        }
      }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(buf);
    } catch (e) {
      sendJSON(res, { ok: false, error: 'TILE_FETCH_FAIL', message: e && e.message }, 502);
    }
    return;
  }

  if (pn === '/api/app/version') {
    sendJSON(res, {
      name: APP_PACKAGE.name || 'stellaflix',
      productName: APP_PACKAGE.productName || 'Stellaflix',
      version: APP_VERSION,
      update: {
        provider: UPDATE_CONFIG.provider,
        configured: UPDATE_CONFIG.configured,
        owner: UPDATE_CONFIG.owner,
        repo: UPDATE_CONFIG.repo,
        preview: UPDATE_CONFIG.preview,
        manifestOverride: !!UPDATE_CONFIG.manifest,
      },
    });
    return;
  }

  if (pn === '/api/listen/report') {
    try {
      if (req.method !== 'POST') {
        sendJSON(res, { accepted: false, error: 'METHOD_NOT_ALLOWED' }, 405);
        return;
      }
      const body = await readRequestBody(req);
      sendJSON(res, await handleLocalListenReport(body));
    } catch (err) {
      console.error('[ListenReport]', err);
      sendJSON(res, {
        accepted: false,
        platformSubmitted: false,
        error: err.code || err.message,
        message: err.message,
      }, Number(err.statusCode) === 401 ? 401 : 502);
    }
    return;
  }

  if (pn === '/api/update/latest') {
    try {
      sendJSON(res, await fetchLatestUpdateInfo());
    } catch (err) {
      sendJSON(res, {
        ...localUpdateFallback(err.message || 'Update check failed', { configured: UPDATE_CONFIG.configured }),
        error: err.message || 'Update check failed',
      });
    }
    return;
  }

  if (
    pn === '/api/update/download'
    || pn === '/api/update/download/status'
    || pn === '/api/update/patch'
    || pn === '/api/update/patch/status'
  ) {
    sendJSON(res, {
      ok: false,
      externalOnly: true,
      error: 'UPDATE_EXTERNAL_ONLY',
      message: 'Stellaflix 已停用客户端本地下载与快速补丁，请使用外部下载页面。',
    }, 410);
    return;
  }

  if (pn === '/api/beatmap/cache/status') {
    const info = beatCacheRootInfo();
    sendJSON(res, {
      enabled: info.allowed && info.available,
      dir: info.dir,
      drive: info.drive,
      reason: !info.allowed ? 'C_DRIVE_DISABLED' : (!info.available ? 'TARGET_DRIVE_UNAVAILABLE' : ''),
      mode: info.allowed && info.available ? 'disk' : 'memory-only',
    });
    return;
  }

  // Cuefield only consumes Stellaflix's existing local beat-map cache. It never
  // receives account cookies, song files, or playback URLs on this route.
  if (pn === '/api/cuefield/transition') {
    if (req.method !== 'POST') {
      sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    try {
      const body = await readRequestBody(req);
      const plan = planCuefieldTransitionFromCache({
        fromKey: body.fromKey,
        toKey: body.toKey,
        fromLrc: body.fromLrc,
        toLrc: body.toLrc,
        exitBias: body.exitBias || 'late',
        maxEntryTime: Math.max(8, Math.min(32, Number(body.maxEntryTime) || 32)),
        readBeatMapCache,
      });
      sendJSON(res, plan);
    } catch (err) {
      sendJSON(res, {
        ok: false,
        error: err && (err.code || err.message) || 'CUEFIELD_TRANSITION_FAILED',
      }, 400);
    }
    return;
  }

  // Feedback remains on this computer under Electron userData. The fan project's
  // optional remote-feedback module is intentionally not wired into Stellaflix.
  if (pn === '/api/cuefield/feedback') {
    if (req.method === 'GET') {
      try {
        sendJSON(res, { ok: true, stats: readCuefieldFeedbackStats(CUEFIELD_FEEDBACK_FILE) });
      } catch (err) {
        sendJSON(res, { ok: false, error: err.message || 'CUEFIELD_FEEDBACK_READ_FAILED' }, 500);
      }
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const record = appendCuefieldFeedback(CUEFIELD_FEEDBACK_FILE, body);
        sendJSON(res, { ok: true, record });
      } catch (err) {
        sendJSON(res, { ok: false, error: err.code || err.message || 'CUEFIELD_FEEDBACK_SAVE_FAILED' }, 400);
      }
      return;
    }
    sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    return;
  }

  if (pn === '/api/beatmap/cache') {
    if (req.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      try {
        const entry = readBeatMapCache(key);
        sendJSON(res, entry
          ? { ok: true, hit: true, key: entry.key || key, map: entry.map, meta: entry.meta || {}, savedAt: entry.savedAt || 0 }
          : { ok: true, hit: false, key });
      } catch (err) {
        const info = err.info || beatCacheRootInfo();
        sendJSON(res, {
          ok: false,
          hit: false,
          enabled: false,
          mode: 'memory-only',
          key,
          reason: err.code || err.message || 'BEAT_CACHE_READ_FAILED',
          dir: info.dir,
        });
      }
      return;
    }

    if (req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        sendJSON(res, await writeBeatMapCache(body)); // B3：异步写盘，避免阻塞音频流事件循环
      } catch (err) {
        const info = err.info || beatCacheRootInfo();
        sendJSON(res, {
          ok: false,
          enabled: false,
          mode: 'memory-only',
          reason: err.code || err.message || 'BEAT_CACHE_WRITE_FAILED',
          dir: info.dir,
        });
      }
      return;
    }

    sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    return;
  }

  if (pn === '/api/discover/home') {
    try {
      sendJSON(res, await handleDiscoverHome());
    } catch (err) {
      console.error('[DiscoverHome]', err);
      sendJSON(res, { error: err.message, loggedIn: false, dailySongs: [], playlists: [] }, 500);
    }
    return;
  }

  if (pn === '/api/weather/radio') {
    try {
      const data = await buildWeatherRadio({
        city: url.searchParams.get('city') || url.searchParams.get('q') || '',
        lat: url.searchParams.get('lat'),
        lon: url.searchParams.get('lon'),
        timezone: url.searchParams.get('timezone') || '',
      });
      sendJSON(res, data);
    } catch (err) {
      console.error('[WeatherRadio]', err);
      sendJSON(res, {
        ok: false,
        error: err.message,
        weather: null,
        radio: { title: '天气电台', subtitle: '天气暂时没有回来，可以先听今日推荐。', seedQueries: [], songs: [] },
      }, 500);
    }
    return;
  }

  if (pn === '/api/weather/ip-location') {
    try {
      sendJSON(res, { ok: true, location: await fetchIpWeatherLocation() });
    } catch (err) {
      console.error('[WeatherIpLocation]', err);
      sendJSON(res, { ok: false, error: err.message, location: null }, 500);
    }
    return;
  }

  // ---------- 搜索 ----------
  if (pn === '/api/search') {
    try {
      const kw    = url.searchParams.get('keywords') || '';
      const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const songs = await handleSearch(kw, limit, offset);
      sendJSON(res, { songs, offset, limit, nextOffset: offset + songs.length, hasMore: songs.length >= limit });
    } catch (err) { console.error('[Search]', err); sendJSON(res, { error: err.message, songs: [] }, 500); }
    return;
  }

  // ---------- AI 助手音乐搜索桥 (LX 兼容契约) ----------
  // 旧 netease 假桩（/api/lx-source/search + status）已随批 T7 删除，
  // 由真实 /api/lx-source/* 路由族（见下方「LX 脚本源路由族」段）接管同名路径。

  // ---------- 平台歌单导入（platform-playlist-import.js，自 Mineradio 移植）----------
  // body: { input: 分享链接/纯数字歌单 ID, source: tx|wy|kw|kg|kgc|mg|sp|qs|am（可选） }
  if (pn === '/api/platform-playlist/import') {
    if (req.method !== 'POST') { sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405); return; }
    try {
      const body = await readRequestBody(req);
      const input = String(body.input || '').trim();
      if (!input) { sendJSON(res, { ok: false, error: 'INPUT_REQUIRED', message: '请粘贴歌单分享链接或数字歌单 ID' }, 400); return; }
      const result = await platformPlaylistImport.importPlaylist(input, String(body.source || '').trim());
      sendJSON(res, result);
    } catch (err) {
      console.error('[PlatformPlaylistImport]', err && err.message);
      sendJSON(res, { ok: false, error: 'IMPORT_FAILED', message: err && err.message || '歌单导入失败' }, 400);
    }
    return;
  }

  // ---------- LX Music 桌面版数据库直读（LxDatas 借鉴）----------
  if (pn === '/api/lx/playlists') {
    if (req.method !== 'GET') { sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405); return; }
    try {
      sendJSON(res, readLxPlaylists());
    } catch (err) {
      const notFound = err && err.message === 'LX_DATABASE_NOT_FOUND';
      sendJSON(res, { ok: false, error: notFound ? 'LX_DATABASE_NOT_FOUND' : 'LX_PLAYLIST_READ_FAILED',
        message: notFound ? '未找到落雪音乐数据库（支持 %APPDATA%/lx-music-desktop/LxDatas 与便携版 portable/LxDatas）' : (err && err.message || '读取落雪数据库失败') },
        notFound ? 404 : 500);
    }
    return;
  }

  // ---------- 播客（podcast）整条下线（批 T16c） ----------
  // 主人裁定：在线音乐对齐 LX 世界观后，播客不再由官方平台 cookie 供给，整套退役
  // （不是隐藏、不是加开关）。原 /api/podcast/{search,hot,detail,programs,my,my/items,
  // dj-beatmap} 的实现体（mapPodcast 系列 / fetchMyPodcast 系列 / 官方 dj 前缀接口常量 /
  // dj-analyzer 依赖）随批删除；此处保留显式 REMOVED 收口，形态沿用 /api/world/* 同款
  // { ok:false, error:'REMOVED' }，不借 LX_ROUTE_NOT_FOUND、不依赖路由兜底造成「假 404」。
  if (pn === '/api/podcast' || pn.startsWith('/api/podcast/')) {
    sendJSON(res, { ok: false, error: 'REMOVED', message: '播客功能已整条下线' }, 404);
    return;
  }

  if (pn === '/api/album/detail') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('albumId') || '';
      const limit = Math.max(10, Math.min(120, parseInt(url.searchParams.get('limit') || '80', 10) || 80));
      if (!id) {
        sendJSON(res, { provider: 'netease', error: 'Missing album id', album: null, songs: [] }, 400);
        return;
      }
      sendJSON(res, await handleNeteaseAlbumDetail(id, limit));
    } catch (err) {
      console.error('[AlbumDetail]', err);
      sendJSON(res, { provider: 'netease', error: err.message, album: null, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/song/url') {
    try {
      const sid = url.searchParams.get('id');
      const quality = url.searchParams.get('quality') || '';
      const matchHints = {
        name: url.searchParams.get('name') || '',
        artist: url.searchParams.get('artist') || '',
        artistId: url.searchParams.get('artistId') || '',
        artistIds: url.searchParams.get('artistIds') || '',
        artistNames: url.searchParams.get('artistNames') || '',
        album: url.searchParams.get('album') || '',
        duration: url.searchParams.get('duration') || '',
        excludeIds: url.searchParams.get('excludeIds') || '',
        skipDirect: url.searchParams.get('skipDirect') === '1',
      };
      sendJSON(res, await handleSongUrl(sid, ANONYMOUS_PLAYBACK_LOGIN, quality, matchHints));
    } catch (err) { console.error('[SongUrl]', err); sendJSON(res, { error: err.message }, 500); }
    return;
  }

  if (pn === '/api/lyric') {
    try {
      const id = url.searchParams.get('id');
      if (!id) { sendJSON(res, { error: 'Missing song id', lyric: '' }, 400); return; }
      let body = {};
      let source = 'lyric';
      try {
        if (typeof lyric_new === 'function') {
          const nr = await lyric_new({ id, timestamp: Date.now() });
          body = nr.body || {};
          source = 'lyric_new';
        }
      } catch (errNew) {
        console.warn('[LyricNew]', errNew.message);
      }
      if (!lyricBodyHasPrimary(body) || !lyricBodyHasTranslation(body)) {
        const r = await lyric({ id, timestamp: Date.now() });
        body = mergeLyricBodies(body, r.body || {});
        source = source === 'lyric_new' ? 'lyric_new+lyric' : 'lyric';
      }
      sendJSON(res, {
        lyric: (body.lrc && body.lrc.lyric) || '',
        tlyric: (body.tlyric && body.tlyric.lyric) || '',
        yrc: (body.yrc && body.yrc.lyric) || '',
        ytlrc: (body.ytlrc && body.ytlrc.lyric) || '',
        romalrc: (body.romalrc && body.romalrc.lyric) || '',
        yromalrc: (body.yromalrc && body.yromalrc.lyric) || '',
        source,
      });
    } catch (err) {
      console.error('[Lyric]', err);
      sendJSON(res, { error: err.message, lyric: '' }, 500);
    }
    return;
  }

  // ---------- 歌曲评论 ----------
  // ---------- 歌手主页 / 热门歌曲 ----------
  if (pn === '/api/artist/detail') {
    try {
      const id = url.searchParams.get('id');
      const limit = Math.max(10, Math.min(80, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
      if (!id) { sendJSON(res, { error: 'Missing artist id', songs: [] }, 400); return; }
      let detailBody = {};
      try {
        const detail = await artist_detail({ id, timestamp: Date.now() });
        detailBody = detail.body || detail || {};
      } catch (e) {
        console.warn('[ArtistDetail] detail failed:', e.message);
      }
      let rawSongs = [];
      try {
        const list = await artist_songs({ id, order: 'hot', limit, offset: 0, timestamp: Date.now() });
        const b = list.body || list || {};
        rawSongs = (b.songs || (b.data && b.data.songs) || []);
      } catch (e) {
        console.warn('[ArtistSongs] hot failed:', e.message);
      }
      if (!rawSongs.length) {
        const top = await artist_top_song({ id, timestamp: Date.now() });
        const b = top.body || top || {};
        rawSongs = b.songs || [];
      }
      const artist = detailBody.artist || (detailBody.data && (detailBody.data.artist || detailBody.data)) || {};
      const songs = rawSongs.map(mapSongRecord).filter(s => s.id).slice(0, limit);
      sendJSON(res, {
        id,
        artist: {
          id: artist.id || id,
          name: artist.name || artist.artistName || '',
          avatar: artist.avatar || artist.cover || artist.picUrl || artist.img1v1Url || '',
          brief: artist.briefDesc || artist.description || artist.desc || '',
          musicSize: artist.musicSize || artist.songSize || 0,
          albumSize: artist.albumSize || 0,
        },
        songs,
        body: detailBody,
      });
    } catch (err) {
      console.error('[ArtistDetail]', err);
      sendJSON(res, { error: err.message, songs: [] }, 500);
    }
    return;
  }

  // ---------- 歌单曲目详情 ----------
  if (pn === '/api/playlist/tracks') {
    try {
      const id = url.searchParams.get('id');
      if (!id) { sendJSON(res, { error: 'Missing playlist id', tracks: [] }, 400); return; }
      if (!/^\d+$/.test(String(id))) { sendJSON(res, { error: 'INVALID_PLAYLIST_ID', tracks: [] }, 400); return; }

      const pageLimit = parseInt(url.searchParams.get('limit') || '0', 10) || 0;
      const pageOffset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
      if (pageLimit || pageOffset) {
        const pageData = await fetchNeteasePlaylistTracksPage(id, pageLimit || 48, pageOffset);
        const pageTracks = (pageData.rawTracks || []).map(mapSongRecord).filter(t => t.id);
        sendJSON(res, {
          playlist: pageData.playlistMeta || { id, name: '', cover: '', trackCount: 0 },
          tracks: pageTracks,
          offset: pageData.offset,
          limit: pageData.limit,
          nextOffset: pageData.nextOffset,
          hasMore: pageData.hasMore,
          total: pageData.total || Number(pageData.playlistMeta && pageData.playlistMeta.trackCount) || 0,
          partial: true,
        });
        return;
      }

      const syncedData = await fetchAllNeteasePlaylistTracks(id);
      const syncedPlaylistMeta = syncedData.playlistMeta || { id, name: '', cover: '', trackCount: 0 };
      const syncedRawTracks = syncedData.rawTracks || [];
      const syncedTracks = syncedRawTracks.map(mapSongRecord).filter(t => t.id);
      if (!syncedPlaylistMeta.trackCount) syncedPlaylistMeta.trackCount = syncedTracks.length;
      sendJSON(res, { playlist: syncedPlaylistMeta, tracks: syncedTracks });
      return;

    } catch (err) {
      console.error('[PlaylistTracks]', err);
      sendJSON(res, { error: err.message, tracks: [] }, 500);
    }
    return;
  }

  // ---------- 封面代理 (带 CORS 头, 给 canvas 提取像素用) ----------
  if (pn === '/api/cover') {
    try {
      const coverUrl = url.searchParams.get('url');
      // URL 校验: 必须是 http(s) 开头, 否则直接 404 (不要让 fetch 抛错)
      if (!coverUrl || !/^https?:\/\//i.test(coverUrl)) {
        res.writeHead(400, res._cors || {});
        res.end('Invalid cover url');
        return;
      }
      // 带 connect timeout + 重试：避免 CDN 单节点抖动时无限挂起
      const COVER_TIMEOUT_MS = 8000;
      let resp;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), COVER_TIMEOUT_MS);
        try {
          resp = await fetch(coverUrl, {
            headers: { 'User-Agent': UA, 'Referer': 'https://music.163.com/' },
            signal: ctrl.signal
          });
        } finally { clearTimeout(timer); }
      } catch (fetchErr) {
        // 连接类错误（UND_ERR_CONNECT_TIMEOUT / ECONNREFUSED / ETIMEDOUT）包装为 502
        console.error('[Cover] fetch failed:', fetchErr.message, coverUrl);
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', ...(res._cors || {}) });
        res.end('Cover fetch failed: ' + fetchErr.message);
        return;
      }
      const ct  = resp.headers.get('content-type') || 'image/jpeg';
      const cl  = resp.headers.get('content-length');
      const hdr = {
        'Content-Type': ct,
        ...(res._cors || {}),
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'public, max-age=86400',
      };
      if (cl) hdr['Content-Length'] = cl;
      res.writeHead(resp.status, hdr);
      if (!resp.body) { res.end(); return; }
      const reader = resp.body.getReader();
      let coverClientClosed = false;
      const closeCoverReader = () => {
        coverClientClosed = true;
        try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {}
      };
      res.once('close', closeCoverReader);
      try {
        while (!coverClientClosed) {
          const c = await reader.read();
          if (c.done) break;
          if (!res.write(c.value)) await once(res, 'drain');
        }
      } finally {
        res.removeListener('close', closeCoverReader);
        if (coverClientClosed) {
          try { await reader.cancel(); } catch (_) {}
        }
      }
      if (!coverClientClosed) res.end();
    } catch (err) { console.error('[Cover]', err); if (!res.headersSent) { res.writeHead(500); res.end(); } else { try { res.destroy(); } catch (_) {} } }
    return;
  }

  // ---------- [临时诊断] 渲染进程探针落盘（排查播放卡死，渲染冻结时主进程仍可写盘） ----------
  if (pn === '/api/diag-log') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    try {
      const body = await readRequestBody(req);
      const line = JSON.stringify({ at: new Date().toISOString(), body: body }) + '\n';
      require('fs').appendFileSync(require('path').join(__dirname, 'outputs', 'sfv-diag-renderer.log'), line);
    } catch (e) { /* 诊断路由永不报错 */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // ---------- 海报平均色（精选片单封面卡「色温跟随首张海报」） ----------
  // wsrv.nl 把 TMDB 海报缩到 1×1 PNG，本端 zlib 解像素即得平均色：零新依赖、零 canvas。
  if (pn === '/api/image-color') {
    const target = url.searchParams.get('url') || '';
    // SSRF 白名单：仅 TMDB 图片 CDN 的 t/p 路径
    if (!/^https:\/\/image\.tmdb\.org\/t\/p\/[a-zA-Z0-9_]+\/[^/?#]+$/i.test(target)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid image url');
      return;
    }
    const hit = imageColorCache.get(target);
    const sendColor = (color) => {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        ...(res._cors || {}),
        'Cache-Control': 'public, max-age=604800',
      });
      res.end(JSON.stringify({ color }));
    };
    if (hit) { sendColor(hit); return; }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      let up;
      try {
        up = await fetch('https://wsrv.nl/?url=' + encodeURIComponent(target) + '&w=1&h=1&output=png', {
          headers: { 'User-Agent': UA }, signal: ctrl.signal,
        });
      } finally { clearTimeout(timer); }
      if (!up.ok) throw new Error('WSRV_HTTP_' + up.status);
      const buf = Buffer.from(await up.arrayBuffer());
      const color = decode1x1Png(buf);
      imageColorCache.set(target, color);
      sendColor(color);
    } catch (err) {
      console.warn('[ImageColor]', err.message || err, target);
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('image-color upstream failed');
    }
    return;
  }

  // ---------- 影视通用代理（含 SSRF 私网拦截、防盗链头伪造、HLS MIME 覆盖） ----------
  // 前端 source-adapter 系经由此路由中转所有跨域视频/字幕/弹幕请求，同源直链可不经代理。
  if (pn === '/api/proxy') {
    try {
      const target = url.searchParams.get('url');
      if (!target) { res.writeHead(400); res.end('Missing url'); return; }
      let parsed;
      try { parsed = new URL(target); } catch (e) { res.writeHead(400); res.end('Bad url'); return; }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { res.writeHead(403); res.end('Forbidden scheme'); return; }
      if (isPrivateHost(parsed.hostname)) { res.writeHead(403); res.end('Forbidden host'); return; }
      const range = req.headers.range || '';
      // TMDB API 只读缓存：GET /3/ 且无 Range 才参与（命中直接回源内存副本）
      const tCacheKey = (req.method === 'GET' && !range) ? tmdbApiCacheKey(target) : null;
      if (tCacheKey) {
        const hit = tmdbApiCacheGet(tCacheKey);
        if (hit) {
          res.writeHead(200, {
            'Content-Type': hit.ct,
            'Content-Length': String(hit.buf.length),
            'X-TMDB-Cache': 'HIT',
            ...(res._cors || {}),
          });
          res.end(hit.buf);
          return;
        }
      }
      // 图片磁盘缓存：GET 直链图片（无 Range）先查盘，命中直接回字节
      const iCacheKey = (req.method === 'GET' && !range) ? imgCacheKey(target) : null;
      if (iCacheKey) {
        const cached = await imgCacheGet(iCacheKey);
        if (cached) {
          res.writeHead(200, {
            'Content-Type': cached.ct,
            'Content-Length': String(cached.buf.length),
            'Cache-Control': cached.cc || 'public, max-age=86400',
            'Accept-Ranges': 'bytes',
            'X-SFV-Img-Cache': 'HIT',
            ...(res._cors || {}),
          });
          res.end(cached.buf);
          return;
        }
      }
      // 参考 KVideo（MIT）的成熟代理方案：中国 CDN 普遍检查 Origin/Referer/Sec-Fetch 等头，
      // 缺少任一都可能导致 403。以下完整模拟浏览器请求特征。
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': parsed.origin + '/',
        'Origin': parsed.origin,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
      };
      if (range) headers['Range'] = range;
      // 白名单透传客户端发来的认证头（弹弹play / DanDanPlay / cookie 等）
      ['x-auth', 'x-appid', 'x-signature', 'x-timestamp', 'x-appsecret', 'cookie'].forEach(function (k) {
        if (req.headers[k]) headers[k] = req.headers[k];
      });
      // 出站 fetch：m3u8 分片/列表统一设 connect 超时为 12s，避免 CDN 节点不可达时无限挂起
      const PROXY_TIMEOUT_MS = 12000;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
      let up;
      try {
        up = await fetch(target, { headers, signal: ctrl.signal });
      } catch (fetchErr) {
        clearTimeout(timer);
        console.error('[Proxy] fetch failed:', fetchErr.message, target);
        try { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', ...(res._cors || {}) }); } catch (e) {}
        res.end('Proxy upstream connect failed: ' + fetchErr.message);
        return;
      }
      clearTimeout(timer);
      // ==== Fix: 通道问题诊断 —— 非 2xx 上游响应记录明显日志，方便用户快速定位
      // CDN 防盗链 403、源站 5xx、SSRF 私网拦截（isPrivateHost）导致上游失败都会
      // 在这里暴露出来，避免黑盒地表现为播放器黑屏。
      if (!up.ok || up.status < 200 || up.status >= 400) {
        console.warn('[Proxy-ERR] upstream status=' + up.status + ' url=' + target);
      }
      // HLS 资源自适应 MIME 覆盖：部分 CDN 将分片伪装为 .png/.jpg 等非视频扩展名，
      // 原样透传其 Content-Type 会导致 hls.js 拒绝解码（预期 video/* 或 application/octet-stream）。
      var ct = up.headers.get('content-type') || 'application/octet-stream';
      var lower = (target || '').toLowerCase();
      var upstreamIsImage = ct && ct.indexOf('image/') === 0;
      if (!upstreamIsImage) {
        if (/\.(m3u8|m3u)(\?|#|$)/i.test(lower)) {
          ct = 'application/vnd.apple.mpegurl';
        } else if (/\.(ts|m4s|aac|mp4)(\?|#|$)/i.test(lower)) {
          ct = 'video/mp2t';
        } else if (/\.(png|jpg|jpeg|gif|webp|ico|bmp)(\?|#|$)/i.test(lower)) {
          ct = 'application/octet-stream';
        }
      }

      // TMDB API JSON：全量读入并写缓存后回包（体积小，无需走下方流式路径）
      if (tCacheKey && up.ok && /json/i.test(ct)) {
        let jsonBuf;
        try {
          jsonBuf = Buffer.from(await up.text(), 'utf8');
        } catch (readErr) {
          console.warn('[Proxy] tmdb json read failed:', readErr.message, target);
          try { res.writeHead(502); } catch (e) {}
          res.end('tmdb json read failed');
          return;
        }
        res.writeHead(up.status, {
          'Content-Type': ct,
          'Content-Length': String(jsonBuf.length),
          ...(res._cors || {}),
        });
        res.end(jsonBuf);
        if (jsonBuf.length <= TMDB_API_CACHE_MAX_BODY) {
          tmdbApiCacheSet(tCacheKey, { ct, buf: jsonBuf, at: Date.now() });
        }
        return;
      }

      // 图片 MISS：整体读入 → 先落盘再回包（保证紧接的二次请求必 HIT），
      // 超过 5MB 只回包不落盘（海报量级远小于此；异常大响应不值得占磁盘）。
      if (iCacheKey && up.ok && upstreamIsImage) {
        let imgBuf;
        try {
          imgBuf = Buffer.from(await up.arrayBuffer());
        } catch (readErr) {
          console.warn('[Proxy] image read failed:', readErr.message, target);
          try { res.writeHead(502); } catch (e) {}
          res.end('image read failed');
          return;
        }
        const imgCc = up.headers.get('cache-control') || 'public, max-age=86400';
        if (imgBuf.length <= IMG_CACHE_MAX_FILE) {
          await imgCachePut(iCacheKey, imgBuf, ct, imgCc);
        }
        res.writeHead(up.status, {
          'Content-Type': ct,
          'Content-Length': String(imgBuf.length),
          'Cache-Control': imgCc,
          'Accept-Ranges': 'bytes',
          ...(res._cors || {}),
        });
        res.end(imgBuf);
        return;
      }

      // ---- HLS 广告过滤（discontinuity 分组启发式）----
      // 仅处理完整 playlist（无 Range）；分片/图片仍走流式透传。
      // 关闭：请求加 &ad=0。master 原样返回，由 hls.js 再拉 media 时过滤。
      const adFilterOff = url.searchParams.get('ad') === '0';
      const maybePlaylist = !upstreamIsImage && !range && up.ok && (
        hlsAdFilter.looksLikeM3u8Url(lower) ||
        (ct && /mpegurl|m3u8/i.test(ct))
      );
      if (!adFilterOff && maybePlaylist && up.body) {
        let rawText;
        try {
          rawText = await up.text();
        } catch (readErr) {
          console.warn('[Proxy] m3u8 read failed:', readErr.message, target);
          try { res.writeHead(502); } catch (e) {}
          res.end('m3u8 read failed');
          return;
        }
        let bodyText = rawText;
        if (hlsAdFilter.looksLikeM3u8Text(rawText)) {
          const filtered = hlsAdFilter.filterHlsAds(rawText, target);
          if (filtered.changed) {
            bodyText = filtered.content;
            console.log('[HLS-AdFilter]', 'removed=' + filtered.removed, target);
          }
        }
        const buf = Buffer.from(bodyText, 'utf8');
        const playlistOut = {
          'Content-Type': 'application/vnd.apple.mpegurl',
          ...(res._cors || {}),
          'Content-Length': String(buf.length),
          'Cache-Control': 'no-store',
        };
        res.writeHead(up.status, playlistOut);
        res.end(buf);
        return;
      }

      const out = {
        'Content-Type': ct,
        ...(res._cors || {}),
        'Accept-Ranges': 'bytes',
      };
      // 关键修复：undici fetch 会按上游 content-encoding 自动解压 body，但 headers 里的
      // content-length 仍是「压缩态」字节数。若原样转发，客户端（hls.js XHR）会按旧长度
      // 提前截断 body —— m3u8 清单被截短（142 分钟影片只显示 5 分钟）、缺 #EXT-X-ENDLIST
      // 被误判为直播流而无限轮询。故仅当上游未压缩时才透传 content-length；
      // 压缩响应不携带 content-length，Node 自动降级为 Transfer-Encoding: chunked。
      const upstreamEncoded = !!up.headers.get('content-encoding');
      const cl = up.headers.get('content-length'); if (cl && !upstreamEncoded) out['Content-Length'] = cl;
      const cr = up.headers.get('content-range'); if (cr) out['Content-Range'] = cr;
      // 图片响应保留缓存语义（TMDB 海报等）：透传上游 Cache-Control，
      // 缺失时补 24h 强缓存——此前代理头重建把上游 immutable 缓存头丢掉，
      // 导致浏览器每次开海报墙都重新远程拉全部图片（单张经上游要 0.2~1.3s）。
      if (upstreamIsImage) {
        out['Cache-Control'] = up.headers.get('cache-control') || 'public, max-age=86400';
      }
      res.writeHead(up.status, out);
      if (upstreamIsImage) console.log('[Proxy-IMG]', up.status, ct, target);
      if (!up.body) { res.end(); return; }
      const reader = up.body.getReader();
      // 客户端中止传播：渲染端（hls.js 切档/退出播放/XHR abort）断开连接后，
      // 立即取消上游读取，避免无人消费的分片继续在主进程内存中堆积（OOM 隐患）。
      var clientGone = false;
      req.on('close', function () {
        clientGone = true;
        try { reader.cancel().catch(function () {}); } catch (e) {}
      });
      while (true) {
        if (clientGone) break;
        const c = await reader.read();
        if (c.done) break;
        // 背压：socket 缓冲区满时等待 drain，避免渲染端消费慢时数据在主进程无界堆积。
        if (!res.write(Buffer.from(c.value))) await once(res, 'drain');
      }
      res.end();
    } catch (err) { console.error('[Proxy]', err); try { res.writeHead(502); } catch (e) {} res.end(); }
    return;
  }

  // ---------- Bangumi 搜索代理（仅 POST，供「每周新番」季度切换使用） ----------
  // 与通用 /api/proxy 不同：/api/proxy 是 GET-only（server 侧 fetch 不带 method/body），
  // 无法承载 Bangumi 的 POST 搜索。本路由采用「硬编码目标 + 字段白名单」而非通用透传，
  // 避免把 /api/proxy 改造成 method+body 透传后扩大攻击面。
  //   - 目标域固定：api.bgm.tv
  //   - 目标路径固定：/v0/search/subjects
  //   - limit 上限 20、offset 上限 200、keyword 截断 200 字符、payload 总量上限 4KB
  //   - 复用 isPrivateHost 做纵深防御（域已固定，理论上不可达，但保留拦截）
  if (pn === '/api/bangumi/search') {
    try {
      if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }

      const body = await readRequestBody(req) || {};
      const qLimit = body.limit != null ? body.limit : url.searchParams.get('limit');
      const qOffset = body.offset != null ? body.offset : url.searchParams.get('offset');

      const limit = Math.min(20, Math.max(1, parseInt(qLimit, 10) || 20));
      const offset = Math.min(200, Math.max(0, parseInt(qOffset, 10) || 0));

      const payload = {
        keyword: (typeof body.keyword === 'string' ? body.keyword : '').slice(0, 200),
        sort: (typeof body.sort === 'string' ? body.sort : 'rank').slice(0, 32),
        filter: (body.filter && typeof body.filter === 'object' && !Array.isArray(body.filter)) ? body.filter : {},
      };
      const rawPayload = JSON.stringify(payload);
      if (rawPayload.length > 4096) { res.writeHead(413); res.end('Payload Too Large'); return; }

      // 优先 Kazumi 镜像 api.kazumi.fyi（国内可直连，无需代理）；官方 api.bgm.tv 需代理，作最后兜底。
      // 启动方可经 STELLAFLIX_BANGUMI_SEARCH_UPSTREAMS（逗号分隔 URL）覆盖源列表；
      // 每个覆盖 URL 仍过 isPrivateHost 守卫（SSRF 面不扩大）。
      let candidates = [
        { url: 'https://api.kazumi.fyi/v0/search/subjects', label: 'api.kazumi.fyi' },
        { url: 'https://api.bgm.tv/v0/search/subjects', label: 'api.bgm.tv' },
      ];
      const upstreamOverride = String(process.env.STELLAFLIX_BANGUMI_SEARCH_UPSTREAMS || '').trim();
      if (upstreamOverride) {
        const parsed = [];
        for (const raw of upstreamOverride.split(',')) {
          const u = raw.trim();
          if (!u) continue;
          try {
            const pu = new URL(u);
            if (isPrivateHost(pu.hostname)) { console.warn('[BangumiSearch] 覆盖源被 SSRF 守卫拦截：' + u); continue; }
            parsed.push({ url: u, label: pu.hostname });
          } catch (e) { console.warn('[BangumiSearch] 覆盖源 URL 非法：' + u); }
        }
        if (parsed.length) candidates = parsed;
      }
      let up = null;
      const failures = [];
      for (let ci = 0; ci < candidates.length; ci++) {
        const label = candidates[ci].label;
        try {
          const cu = new URL(candidates[ci].url);
          cu.searchParams.set('limit', String(limit));
          cu.searchParams.set('offset', String(offset));
          if (isPrivateHost(cu.hostname)) { failures.push({ label, error: 'forbidden-host' }); continue; }
          const r = await fetchWithTimeout(cu.toString(), {
            method: 'POST',
            headers: {
              'User-Agent': 'Predidit/Kazumi/2.2.6 (Android) (https://github.com/Predidit/Kazumi)',
              'Accept': 'application/json',
              'Content-Type': 'application/json',
            },
            body: rawPayload,
          }, 12000);
          if (r.ok) { up = r; break; }
          // 提取上游错误体里的 message（如镜像 401 invalid request signature），便于定位
          let detail = '';
          try { detail = extractUpstreamErrorDetail((await r.text()).slice(0, 300)); } catch (e2) {}
          detail = String(detail).trim();
          failures.push({ label, status: r.status, ...(detail ? { message: detail } : {}) });
          console.warn('[BangumiSearch] 上游 ' + label + ' 返回 ' + r.status + (detail ? ' (' + detail + ')' : '') + '，尝试下一源');
        } catch (e) {
          const msg = (e && e.message) || String(e);
          failures.push({ label, error: msg });
          console.warn('[BangumiSearch] 源 ' + label + ' 失败：' + msg);
        }
      }
      if (!up) {
        const lastErr = failures.length ? failures[failures.length - 1] : { error: 'no-upstream' };
        console.error('[BangumiSearch] 全部源失败：', JSON.stringify(failures));
        sendJSON(res, {
          error: 'bangumi_search_upstream_failed',
          message: '全部源失败: ' + failures.map((f) => f.label + ' ' + (f.status != null ? 'HTTP ' + f.status : f.error)).join('; '),
          sources: failures,
          hint: '镜像搜索需 Kazumi 官方签名凭证（本应用无）；api.bgm.tv 需代理——启动前设置 HTTPS_PROXY 指向本机代理即可启用官方兜底',
        }, 502);
        return;
      }
      const text = await up.text();
      res.writeHead(up.status, {
        'Content-Type': up.headers.get('content-type') || 'application/json',
        ...(res._cors || {}),
      });
      res.end(text);
    } catch (err) { console.error('[BangumiSearch]', err); res.writeHead(502); res.end(); }
    return;
  }

  // ---------- LX 脚本源路由族（批 T7，移植上游 server.js:2725-3145 各段） ----------
  // 13 条路由：status/resolve/lyric/import/select/toggle/check/delete/search
  //   + daily-hot/platform-charts/playlist-search/playlist-square（批 T15.5a 补移植）。
  // 裁决1（批 T7）曾缓期后四条；主人 10-25 拍板方案A后由批 T15.5a 补齐：上游把它们保留为
  // 免 cookie 裸 HTTP 元数据爬虫（实现在 lx-search.js），供 T15.5b 前端改道消费，
  // 之后 T16 才能拆掉五平台官方路由与文件。song-cover-search 经查本仓无消费方，仍不建。
  // 裁决2：本地信任闸仅施加于本路由族；全局 isCrossSiteWrite 守卫不动。
  if (pn.startsWith('/api/lx-source/')) {
    if (!isTrustedLocalApiRequest(req)) {
      sendJSON(res, { ok: false, error: 'FORBIDDEN_ORIGIN', code: 'FORBIDDEN_ORIGIN' }, 403);
      return;
    }
    const lxRequirePost = () => {
      if (req.method === 'POST') return true;
      sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED', code: 'METHOD_NOT_ALLOWED' }, 405);
      return false;
    };
    // 裁决6：终态失败映射机器码 —— 优先取异常消息中的 LX_* 词法段；
    // 两条中文终态查 LX_SOURCE_TERMINAL_CODES；其余按路由给定的兜底码。error 保留原文。
    const lxRouteError = (err, status, fallbackCode) => {
      const message = err && err.message ? String(err.message) : '';
      const direct = message.match(/LX_[A-Z0-9_]+/);
      const mapped = Object.prototype.hasOwnProperty.call(LX_SOURCE_TERMINAL_CODES, message)
        ? LX_SOURCE_TERMINAL_CODES[message] : '';
      const code = direct ? direct[0] : (mapped || fallbackCode);
      sendJSON(res, { ok: false, error: message || fallbackCode, code }, status);
    };

    if (pn === '/api/lx-source/status') {
      // 上游 :2725 走 lxSourceHost.status()（会起沙箱）；我方 host 无该方法，直接由
      // listSources() 落盘快照组装（空库也稳定返回 {ok,sources:[],active:null}，不起沙箱）。
      // installed/name/version/enabledCount 为旧桩既有顶层字段兼容位（agent-music-tools.js:516
      // 仍读之；完整退役留 T9/T10，裁决8）。
      try {
        const installed = lxSourceHost.listSources();
        const active = installed.find(item => item.current && item.enabled) || null;
        sendJSON(res, {
          ok: true,
          sources: installed,
          active: active ? active.id : null,
          name: active ? active.name : '未配置',
          version: active ? active.version : '',
          installed,
          enabledCount: installed.filter(item => item.enabled).length,
        });
      } catch (err) {
        lxRouteError(err, 503, 'LX_SOURCE_UNAVAILABLE');
      }
      return;
    }

    if (pn === '/api/lx-source/resolve') {
      if (!lxRequirePost()) return;
      // spec §5 引导态（我方新增码）：一脚本未装 → 200 + LX_NO_SOURCES，T9 前端按码分流。
      if (!lxSourceHost.listSources().length) {
        sendJSON(res, { ok: false, error: '未导入任何 LX 脚本音源', code: 'LX_NO_SOURCES' });
        return;
      }
      try {
        const body = await readRequestBody(req);
        const source = String(body.source || '').toLowerCase();
        const musicInfo = body.musicInfo && typeof body.musicInfo === 'object' ? body.musicInfo : {};
        // 我方 host 为对象参数签名（上游 :2743 为位置参数 source, musicInfo, quality, opts，裁决4）。
        const result = await lxSourceHost.resolveMusicUrl({
          source,
          quality: String(body.quality || ''),
          musicInfo,
          excludeResolvers: Array.isArray(body.excludeResolvers) ? body.excludeResolvers : [],
          maxResolvers: Math.max(1, Math.min(8, Number(body.maxResolvers) || 6)),
        });
        // proxyUrl 沿我方 /api/audio 约定（上游 audioProxyUrl 不存在，裁决3）；批 T8 还债闭环：
        // 改经 audioProxyUrl(url, headers)（上游 :378-383 移植）构造，resolve 播放头 headers
        // 以 h=base64url(JSON) 白名单参数随 proxyUrl 透传，/api/audio 侧解析转发上游。
        // headers 为空时不带 h —— 旧 '/api/audio?url=' 形态原样工作（无 h = 现状行为）。
        sendJSON(res, { ...result, proxyUrl: audioProxyUrl(result && result.url, result && result.headers) });
      } catch (err) {
        console.warn('[LXSourceResolve]', err && err.message);
        lxRouteError(err, 502, 'LX_SOURCE_RESOLVE_FAILED');
      }
      return;
    }

    if (pn === '/api/lx-source/lyric') {
      if (!lxRequirePost()) return;
      // 上游 :2755 段：resolveLyrics → 我方 host.getLyric（批 T7 移植，上游 lx-source-host.js:1220-1237）。
      try {
        const body = await readRequestBody(req);
        const source = String(body.source || '').toLowerCase();
        const musicInfo = body.musicInfo && typeof body.musicInfo === 'object' ? body.musicInfo : {};
        const lyrics = await lxSourceHost.getLyric(source, musicInfo);
        sendJSON(res, { ok: true, source, ...lyrics });
      } catch (err) {
        console.warn('[LXSourceLyric]', err && err.message);
        lxRouteError(err, 502, 'LX_SOURCE_LYRIC_FAILED');
      }
      return;
    }

    if (pn === '/api/lx-source/import') {
      if (!lxRequirePost()) return;
      try {
        const body = await readRequestBody(req);
        // 我方 importSource 签名 (name, script)（T1 定；上游 :2992 为 (script, fileName)，裁决4）。
        const result = body.url
          ? await lxSourceHost.importSourceUrl(body.url)
          : await lxSourceHost.importSource(String(body.fileName || ''), body.script);
        sendJSON(res, { ok: true, ...result });
      } catch (err) {
        lxRouteError(err, 400, 'LX_SOURCE_IMPORT_FAILED');
      }
      return;
    }

    if (pn === '/api/lx-source/select') {
      if (!lxRequirePost()) return;
      try {
        const body = await readRequestBody(req);
        sendJSON(res, await lxSourceHost.selectSource(body.id));
      } catch (err) {
        lxRouteError(err, 400, 'LX_SOURCE_SELECT_FAILED');
      }
      return;
    }

    if (pn === '/api/lx-source/toggle') {
      if (!lxRequirePost()) return;
      try {
        const body = await readRequestBody(req);
        const ids = Array.isArray(body.ids) ? body.ids : body.id;
        sendJSON(res, await lxSourceHost.setSourcesEnabled(ids, body.enabled !== false));
      } catch (err) {
        lxRouteError(err, 400, 'LX_SOURCE_TOGGLE_FAILED');
      }
      return;
    }

    if (pn === '/api/lx-source/check') {
      if (!lxRequirePost()) return;
      try {
        const body = await readRequestBody(req);
        const ids = Array.isArray(body.ids) ? body.ids : body.id;
        sendJSON(res, await lxSourceHost.checkSources(ids)); // 上游 :3037 同款：成功返回逐源结果数组
      } catch (err) {
        lxRouteError(err, 400, 'LX_SOURCE_CHECK_FAILED');
      }
      return;
    }

    if (pn === '/api/lx-source/delete') {
      if (!lxRequirePost()) return;
      try {
        const body = await readRequestBody(req);
        sendJSON(res, Array.isArray(body.ids)
          ? await lxSourceHost.deleteSources(body.ids)
          : await lxSourceHost.deleteSource(body.id));
      } catch (err) {
        lxRouteError(err, 400, 'LX_SOURCE_DELETE_FAILED');
      }
      return;
    }

    if (pn === '/api/lx-source/search') {
      try {
        // 我方 searchAll 为对象参数（上游 :3107 位置参数 q + opts，裁决4）；
        // sources/limit 以查询串透传，由 lx-search 内部 resolveRequestedSources/clampLimit 解析。
        const result = await lxSearch.searchAll({
          query: url.searchParams.get('q') || url.searchParams.get('keywords') || '',
          limit: url.searchParams.get('limit'),
          sources: url.searchParams.get('sources'),
        });
        // 顶层 {ok, songs, failures} 保留旧桩兼容形态（裁决8，agent-music-tools 读 songs/failures）。
        const ok = result.songs.length > 0 || result.failures.length === 0;
        sendJSON(res, { ...result, ok }, ok ? 200 : 502);
      } catch (err) {
        sendJSON(res, { ok: false, songs: [], failures: [], error: err.message || 'LX_SEARCH_FAILED', code: 'LX_SEARCH_FAILED' }, 502);
      }
      return;
    }

    if (pn === '/api/lx-source/playlist-search') {
      // 上游 server.js:3118-3130（searchPlaylists 五家裸爬虫族，批 T15.5a 落在 lx-search.js）。
      try {
        const result = await lxSearch.searchPlaylists({
          query: url.searchParams.get('q') || url.searchParams.get('keywords') || '',
          limit: url.searchParams.get('limit'),
          page: url.searchParams.get('page'),
          sources: url.searchParams.get('sources') || url.searchParams.get('platform'),
        });
        sendJSON(res, result, result.ok ? 200 : 502);
      } catch (err) {
        sendJSON(res, {
          ok: false, playlists: [], failures: [],
          error: err.message || 'PLAYLIST_SEARCH_FAILED', code: 'PLAYLIST_SEARCH_FAILED',
        }, 502);
      }
      return;
    }

    if (pn === '/api/lx-source/playlist-square') {
      // 上游 server.js:3132-3145：分类词直接作为歌单检索 query，browseMode 供前端区分浏览态。
      try {
        const category = String(url.searchParams.get('category') || '流行').trim().slice(0, 40);
        const result = await lxSearch.searchPlaylists({
          query: category,
          limit: url.searchParams.get('limit') || 24,
          page: url.searchParams.get('page') || 1,
          sources: url.searchParams.get('platform') || url.searchParams.get('sources') || 'tx,wy,kw,kg,mg',
        });
        const payload = { ...result, category, browseMode: 'public-playlist-search' };
        sendJSON(res, payload, result.ok ? 200 : 502);
      } catch (err) {
        sendJSON(res, {
          ok: false, playlists: [], failures: [], browseMode: 'public-playlist-search',
          error: err.message || 'PLAYLIST_SQUARE_FAILED', code: 'PLAYLIST_SQUARE_FAILED',
        }, 502);
      }
      return;
    }

    // 上游 server.js:3085-3103 /api/song-cover-search：本仓首页/资料卡封面走本地上传+裁剪
    // （public/index.html 封面面板 → triggerUploadInput('cover') / commitCoverCrop），
    // 无云端封面搜索消费方 —— 批 T15.5a 按 brief 裁决不建（grep 证据见 task-15.5a-report）。
    sendJSON(res, { ok: false, error: 'LX_ROUTE_NOT_FOUND', code: 'LX_ROUTE_NOT_FOUND' }, 404);
    return;
  }

  // ---------- 音频代理 (支持 Range) ----------
  if (pn === '/api/audio') {
    try {
      const audioUrl = url.searchParams.get('url');
      if (!audioUrl) { res.writeHead(400); res.end('Missing url'); return; }
      // 批 T8（上游 :3149-3155）：协议白名单 + localhost 族主机名拒绝；校验前置到
      // qishui #auth= 解密路径之前，两条出站（解密 fetch / 直代理 fetch）一并覆盖。
      // 上游 :3152 正则逐字移植（其对 127.x.x.1 全量 IP 的盲区为上游原样，见 task-8-report）。
      try {
        const target = new URL(String(audioUrl));
        if (!/^https?:$/.test(target.protocol)) throw new Error('INVALID_AUDIO_URL');
        if (/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)$/i.test(target.hostname)) throw new Error('LOCAL_AUDIO_URL_BLOCKED');
      } catch (err) {
        sendJSON(res, { ok: false, error: err.message || 'INVALID_AUDIO_URL' }, 400);
        return;
      }
      const range = req.headers.range || '';
      // 批 T8 合并序（上游 :3169-3179）：宿主逐站默认 → h 白名单播放头覆盖 → 客户端 Range/If-Range。
      const hdr = mergeAudioProxyRequestHeaders(
        audioProxyHeadersFor(audioUrl, range),
        audioProxyHeadersFromQuery(url.searchParams.get('h'))
      );
      if (req.headers['if-range']) hdr['If-Range'] = String(req.headers['if-range']);
      const up = await fetchWithTimeout(audioUrl, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET', // 批 T8（上游 :3171）：HEAD 直通
        headers: hdr,
      }, 9000);
      const out = {
        'Content-Type': audioContentTypeForUrl(audioUrl, up.headers.get('content-type')),
        ...(res._cors || {}),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };
      const cl = up.headers.get('content-length'); if (cl) out['Content-Length'] = cl;
      const cr = up.headers.get('content-range');  if (cr) out['Content-Range']  = cr;
      // 批 T8（上游 :3187）：响应头白名单透传扩 etag / last-modified（断点续传校验用）。
      const et = up.headers.get('etag');           if (et) out['ETag']          = et;
      const lm = up.headers.get('last-modified');  if (lm) out['Last-Modified'] = lm;
      res.writeHead(up.status, out);
      if (req.method === 'HEAD' || !up.body) { res.end(); return; } // 批 T8（上游 :3192）
      const reader = up.body.getReader();
      let clientClosed = false;
      const closeReader = () => {
        clientClosed = true;
        try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {}
      };
      res.once('close', closeReader);
      try {
        while (!clientClosed) {
          const c = await readStreamChunkWithTimeout(reader, 12000);
          if (c.done) break;
          if (!res.write(c.value)) await once(res, 'drain');
        }
      } finally {
        res.removeListener('close', closeReader);
        if (clientClosed) {
          try { await reader.cancel(); } catch (_) {}
        }
      }
      if (clientClosed) return;
      res.end();
    } catch (err) {
      console.error('[Audio]', err && (err.code || err.name || err.message || 'AUDIO_PROXY_FAILED'));
      if (res.headersSent) {
        try { res.destroy(); } catch (_) {}
      } else {
        res.writeHead(err && err.name === 'AbortError' ? 504 : 502, { 'Cache-Control': 'no-store' });
        res.end();
      }
    }
    return;
  }

  // ---------- AI 助手 (小M) ----------
  if (pn === '/api/agent/config') {
    if (req.method === 'GET') {
      try { sendJSON(res, { ok: true, ...agentApi.getConfig() }); }
      catch (err) { sendJSON(res, agentApi.toPublicError(err), err.status || 500); }
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        sendJSON(res, { ok: true, ...await agentApi.saveConfig(body) });
      } catch (err) {
        sendJSON(res, agentApi.toPublicError(err), err.status || 400);
      }
      return;
    }
    sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    return;
  }

  if (pn === '/api/agent/chat') {
    if (req.method !== 'POST') {
      sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    try {
      const body = await readRequestBody(req);
      sendJSON(res, await agentApi.chat(body));
    } catch (err) {
      sendJSON(res, agentApi.toPublicError(err), err.status || 500);
    }
    return;
  }

  if (pn === '/api/agent/test') {
    if (req.method !== 'POST') {
      sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    try { sendJSON(res, await agentApi.testConnection()); }
    catch (err) { sendJSON(res, agentApi.toPublicError(err), err.status || 500); }
    return;
  }

  // ---------- AI 助手语音三链：A=MediaRecorder→faster-whisper（/transcribe 主链）｜B=服务端麦克风直采（/recognize，win32）｜C=ffmpeg→SAPI（/transcribe 兜底） ----------
  if (pn === '/api/agent/speech/capabilities') {
    // 真实探测（移植自 MR）：whisper = 模型+Python+脚本+未熔断；直采 = win32+脚本。
    // 前端据此调度：whisper 可用 → MediaRecorder+/transcribe；否则 win32 → /recognize 直采。
    sendJSON(res, {
      ok: true,
      whisperAvailable: whisperRuntimeReady(),
      windowsSpeechAvailable: process.platform === 'win32' && fs.existsSync(WINDOWS_SPEECH_SCRIPT),
    });
    return;
  }

  if (pn === '/api/agent/speech/recognize') {
    // 引擎 B：服务端麦克风直采（PowerShell System.Speech，仅 win32）。
    if (req.method !== 'POST') {
      sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    try {
      const body = await readRequestBody(req);
      sendJSON(res, await recognizeWindowsSpeech(body && body.timeoutSeconds));
    } catch (err) {
      sendJSON(res, { ok: false, error: err && err.code || 'SPEECH_RECOGNITION_FAILED', message: err && err.message || '语音识别失败。' }, 400);
    }
    return;
  }

  if (pn === '/api/agent/speech/transcribe') {
    if (req.method !== 'POST') {
      sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    const rawBody = await readRawBody(req, 20 * 1024 * 1024);
    if (rawBody == null) {
      sendJSON(res, { ok: false, error: 'PAYLOAD_TOO_LARGE', message: '音频超过 20MB 上限。' }, 413);
      return;
    }
    if (!rawBody.length) {
      sendJSON(res, { ok: false, error: 'EMPTY_AUDIO', message: '未收到音频数据。' });
      return;
    }
    // —— 引擎 A（主）：faster-whisper 直转（PyAV 解码，不依赖 ffmpeg-static）——
    if (whisperRuntimeReady()) {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      const whisperExt = contentType.includes('wav') ? '.wav'
        : (contentType.includes('ogg') ? '.ogg'
          : (contentType.includes('mp4') ? '.m4a' : '.webm'));
      try {
        sendJSON(res, await recognizeWhisperAudio(rawBody, whisperExt));
        return;
      } catch (err) {
        if (err && err.code === 'SPEECH_NOT_HEARD') {
          // 没检测到人声：SAPI 也无能为力，直接返回
          sendJSON(res, { ok: false, error: 'SPEECH_NOT_HEARD', message: err.message || '没有听清，请再说一次。' }, 400);
          return;
        }
        // 包未装/模型损坏/启动失败等：熔断计数并回落 SAPI 链
        whisperFailureCount += 1;
        console.warn('[SpeechTranscribe] whisper 引擎失败（第 ' + whisperFailureCount + ' 次），回落 SAPI：', err && err.code, err && err.message);
      }
    }
    // —— 引擎 C（SF 特有兜底）：ffmpeg 转 16k WAV → SAPI ——
    if (!ffmpegBinaryReady) {
      sendJSON(res, { ok: false, error: 'FFMPEG_BINARY_MISSING',
        message: '未检测到 ffmpeg 二进制，请先在项目根目录执行 npm install ffmpeg-static（需联网下载 ~70MB 的 Windows 预编译包）。' });
      return;
    }
    const ps1Path = path.join(__dirname, 'desktop', 'speech', 'sapi-transcribe.ps1');
    if (!fs.existsSync(ps1Path)) {
      sendJSON(res, { ok: false, error: 'SAPI_SCRIPT_MISSING', message: 'SAPI 转写脚本缺失：' + ps1Path });
      return;
    }
    const tmpId = crypto.randomBytes(8).toString('hex');
    const tmpDir = os.tmpdir();
    const inPath  = path.join(tmpDir, `speech-in-${tmpId}.webm`);
    const outPath = path.join(tmpDir, `speech-out-${tmpId}.wav`);
    const safeUnlink = (p) => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} };
    try {
      fs.writeFileSync(inPath, rawBody);
      // 1) ffmpeg: webm/opus → 16kHz 单声道 PCM s16le WAV（SAPI 标准输入格式）
      const ffResult = await runProcess(ffmpegStaticPath,
        ['-y', '-hide_banner', '-loglevel', 'error', '-i', inPath,
         '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outPath], 30000);
      if (ffResult.code !== 0) {
        sendJSON(res, { ok: false, error: 'FFMPEG_CONVERT_FAILED',
          message: 'ffmpeg 转码失败：' + ((ffResult.stderr || '').replace(/\r?\n/g, ' ').trim().slice(0, 500) || `exit ${ffResult.code}`) });
        return;
      }
      if (!fs.existsSync(outPath)) {
        sendJSON(res, { ok: false, error: 'FFMPEG_NO_OUTPUT', message: 'ffmpeg 未产出 WAV。' });
        return;
      }
      // 2) PowerShell + SAPI：单次识别 → stdout 文本
      const psResult = await runProcess('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, outPath], 45000);
      if (psResult.code !== 0) {
        sendJSON(res, { ok: false, error: 'SAPI_FAILED',
          message: '语音识别失败：' + ((psResult.stderr || '').replace(/\r?\n/g, ' ').trim().slice(0, 500) || `exit ${psResult.code}`) });
        return;
      }
      const text = (psResult.stdout || '').replace(/^\uFEFF/, '').trim();
      sendJSON(res, { ok: true, text, language: 'auto' });
    } catch (err) {
      console.warn('[SpeechTranscribe] failed:', err && err.message || err);
      sendJSON(res, { ok: false, error: 'SPEECH_TRANSCRIBE_FAILED',
        message: '语音识别处理异常：' + (err && err.message || String(err)) }, 500);
    } finally {
      safeUnlink(inPath);
      safeUnlink(outPath);
    }
    return;
  }

  if (pn === '/api/agent/speech/cancel') {
    if (req.method !== 'POST') {
      sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    sendJSON(res, { ok: true, canceled: cancelWindowsSpeechRecognition() });
    return;
  }

  // ---------- 静态资源 ----------
  if (pn === '/favicon.ico') {
    serveStatic(res, path.join(__dirname, 'build', 'icon.ico'));
    return;
  }

  let filePath = pn === '/' ? '/index.html' : pn;
  filePath = path.join(__dirname, 'public', filePath);
  serveStatic(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log('======================================================');
  console.log(' 粒子音乐可视化 v2  →  http://localhost:' + PORT);
  console.log('======================================================');
});

server.clearAllLoginCredentials = clearAllRuntimeLoginCredentials;
server.agentApi = agentApi;
// 批 T7：本地信任闸暴露给测试直断言分支（tests/lx-source-routes.test.js）。
server.isTrustedLocalApiRequest = isTrustedLocalApiRequest;
// 批 T8：/api/audio 增强助手同风格暴露（tests/lx-audio-proxy.test.js 直测
// audioProxyUrl 的 h 参数构造/回退旧 url= 形态 + audioProxyHeadersFromQuery 白名单解析）。
server.audioProxyUrl = audioProxyUrl;
server.audioProxyHeadersFromQuery = audioProxyHeadersFromQuery;

module.exports = server;
