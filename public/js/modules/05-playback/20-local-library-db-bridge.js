// ============================================================
// SQLite 本地曲库桥接（播放统计落库通道）。
// 主进程 desktop/local-library-store.js 的 song_stats 一行按「绝对路径:大小:修改时间」
// 存播放计数，重扫、换库或删掉索引都不清零；展示侧权威仍是 listenStatsState，
// 这里只做累加式镜像，绝不重放历史。纯浏览器或缺通道的旧桌面壳下整条链路静默降级。
// ============================================================
var localLibraryDbState = { probed: false, available: false, promise: null, status: null };

/**
 * 取桌面壳桥接对象。
 * @returns {object|null} 桌面壳桥接对象，纯浏览器或旧壳时为 null。
 */
function localLibraryDbApi() {
  var api = typeof window !== 'undefined' ? window.desktopWindow : null;
  if (!api || !api.isDesktop) return null;
  if (typeof api.localLibraryDbStatus !== 'function') return null;
  return api;
}
/**
 * 探测一次 SQLite 曲库是否可用并缓存结论。node:sqlite 缺失或建库失败时永久降级。
 * @returns {Promise<boolean>} 是否可用。
 */
function probeLocalLibraryDb() {
  if (localLibraryDbState.probed) return Promise.resolve(localLibraryDbState.available);
  if (localLibraryDbState.promise) return localLibraryDbState.promise;
  var api = localLibraryDbApi();
  if (!api) {
    localLibraryDbState.probed = true;
    localLibraryDbState.available = false;
    return Promise.resolve(false);
  }
  localLibraryDbState.promise = (async function () {
    var ok = false;
    try {
      var status = await api.localLibraryDbStatus();
      ok = !!(status && status.ok && status.available);
      localLibraryDbState.status = status || null;
    } catch (e) {
      console.warn('[LocalLibraryDbProbe]', e);
      ok = false;
    }
    localLibraryDbState.probed = true;
    localLibraryDbState.available = ok;
    localLibraryDbState.promise = null;
    return ok;
  })();
  return localLibraryDbState.promise;
}
/**
 * 同步判断 SQLite 曲库当前是否已确认可用；未探测完成时按不可用处理。
 * @returns {boolean} 是否已确认可用。
 */
function localLibraryDbActive() {
  return !!(localLibraryDbState.probed && localLibraryDbState.available);
}
/**
 * 统一调用 SQLite 曲库通道。永不抛出：任何失败都返回 null 让调用方回落原路径；
 * 只有主进程明确回报存储不可用才把状态 latch 成不可用，避免单次瞬时错误永久关闭 SQLite 路径。
 * @param {string} method 桥接方法名。
 * @param {*} a 第一参数。
 * @param {*} b 第二参数。
 * @returns {Promise<object|null>} 主进程返回值；不可用或失败时为 null。
 */
async function callLocalLibraryDb(method, a, b) {
  var api = localLibraryDbApi();
  if (!api || typeof api[method] !== 'function') return null;
  if (!(await probeLocalLibraryDb())) return null;
  try {
    var result = arguments.length >= 3 ? await api[method](a, b) : (arguments.length === 2 ? await api[method](a) : await api[method]());
    if (result && result.ok === false && result.error === 'LOCAL_LIBRARY_DB_UNAVAILABLE') {
      localLibraryDbState.available = false;
      return null;
    }
    return result || null;
  } catch (e) {
    console.warn('[LocalLibraryDb]', method, e);
    return null;
  }
}
/**
 * 归一化路径键：统一分隔符并转小写，与主进程 normalizeStorePathKey 同构。
 * 与 04-shelf/11-local-track-map.js 同名同实现，拼接顺序变化不改变结果
 * （tests/local-library-registration-smoke.test.js 逐字钉住两者等价）。
 * @param {*} value 任意路径。
 * @returns {string} 归一化路径键。
 */
function normalizeLocalLibraryPathKey(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .trim()
    .toLowerCase();
}
/**
 * 取曲目对象的绝对路径原文，供 SQLite 行键回退计算使用。
 * @param {object} song 曲目对象。
 * @returns {string} 绝对路径；拿不到时退回相对路径、再退回文件名。
 */
function localLibrarySongPath(song) {
  if (!song) return '';
  return String(song.localFilePathAbsolute || song.localPath || song.name || '');
}
/**
 * 取曲目对象的归一化路径键。
 * @param {object} song 曲目对象。
 * @returns {string} 归一化路径键。
 */
function localLibraryPathKeyFromSong(song) {
  if (!song) return '';
  return normalizeLocalLibraryPathKey(localLibrarySongPath(song));
}
/**
 * 生成 SQLite song_stats 的行键。曲库引擎（04-shelf/11 localSongKeyFromFile）已经按
 * 「路径:大小:修改时间」给每条曲目算过 localKey，索引/封面/歌词也都落在同一行，
 * 统计必须跟着同一个键走，否则收藏和播放次数会分裂成两行。
 * 只有旧数据桶里没带 localKey 的曲目才回退到同构公式现算。
 * @param {object} song 曲目对象。
 * @returns {string} 行键；拿不到路径时为空串。
 */
function localLibraryDbSongKeyFromSong(song) {
  if (!song) return '';
  var engineKey = String(song.localKey || '');
  if (engineKey) return engineKey;
  var filePath = localLibrarySongPath(song);
  if (!filePath) return '';
  return filePath + ':' +
    (Number(song.localFileSize || (song.localFile && song.localFile.size) || 0) || 0) + ':' +
    (Number(song.localFileLastModified || (song.localFile && song.localFile.lastModified) || 0) || 0);
}
/**
 * 把本地曲目的播放次数与最近播放写进 SQLite。song_stats 按 song_key 独立存活，
 * 重扫、换库或删掉索引都不会清零，所以这里只做累加，不重放历史。
 * @param {object} snapshot 听歌会话快照（listenSongSnapshot 结果）。
 * @param {{listenMs?:number, completed?:boolean, playedAt?:number}} result 本次结算数据。
 * @returns {void}
 */
function syncLocalLibraryDbPlayStat(snapshot, result) {
  var snap = snapshot || {};
  if (snap.type !== 'local') return;
  var songKey = String(snap.localKey || '');
  if (!songKey) return;
  var payload = result || {};
  callLocalLibraryDb('bumpLocalLibraryDbPlayStat', {
    key: songKey,
    pathKey: snap.pathKey || '',
    plays: 1,
    listenMs: Math.max(0, Math.round(Number(payload.listenMs) || 0)),
    completed: payload.completed ? 1 : 0,
    lastPlayedAt: Number(payload.playedAt) || Date.now(),
    name: snap.name || '',
    artist: snap.artist || '',
  });
}
