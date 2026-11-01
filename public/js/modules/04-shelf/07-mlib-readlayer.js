// 本地化音乐资料库 · 聚合读层（spec: 2026-10-18-local-music-library-design.md §4）
// 纯函数层：不碰 DOM、不碰 seam（后续任务在本文件扩展）。
(function () {
  'use strict';
  var CJK = /^[\u4e00-\u9fff]/;

  function bucketOf(name, pinyin) {
    if (pinyin) return 'cjk';
    if (name && CJK.test(name)) return 'other';
    if (name && /^[a-zA-Z]/.test(name)) return 'latin';
    return 'other';
  }

  function albumsFromTracks(tracks) {
    var byId = new Map();
    (tracks || []).forEach(function (t) {
      if (!t) return; // T1 审查加固：null 元素防护
      if (!t.albumId) return; // 无 albumId 不进专辑轴（spec 铁律）
      var a = byId.get(t.albumId) || { id: t.albumId, title: t.album || t.albumId, sub: t.artist || '', cover: '', count: 0, playable: false, meta: { releaseYear: t.releaseYear || 0 } };
      a.count += 1;
      if (!a.cover && t.cover) a.cover = t.cover;
      if (t.matched) a.playable = true;
      byId.set(t.albumId, a);
    });
    var cards = Array.from(byId.values());
    cards.forEach(function (c) { c.sortKey = String(c.title).toLowerCase(); c.sortBucket = 'album'; });
    return cards;
  }

  function artistsFromTracks(tracks) {
    var byId = new Map();
    (tracks || []).forEach(function (t) {
      if (!t) return; // T1 审查加固：null 元素防护
      if (!t.artistId) return;
      var key = t.artistId;
      var a = byId.get(key) || { id: key, title: t.artist || key, sub: '', cover: '', count: 0, playable: false, meta: { avatar: '', sortKeyPinyin: t.sortKeyPinyin || '' } };
      a.count += 1;
      if (!a.meta.sortKeyPinyin && t.sortKeyPinyin) a.meta.sortKeyPinyin = t.sortKeyPinyin;
      if (t.matched) a.playable = true;
      byId.set(key, a);
    });
    var cards = Array.from(byId.values());
    cards.forEach(function (c) {
      c.sortKey = (c.meta.sortKeyPinyin || String(c.title).toLowerCase());
      c.sortBucket = bucketOf(c.title, c.meta.sortKeyPinyin);
      c.sub = c.count + ' 首';
    });
    return cards;
  }

  function playlistsFrom(playlists) {
    return (playlists || []).map(function (p) {
      if (!p) return null; // T1 审查加固：null 元素防护（消费侧 filter 掉）
      var count = typeof p.count === 'number' ? p.count : ((p.trackIds || []).length);
      return { id: p.id, title: p.title, sub: '', cover: p.cover || '', count: count,
        sortKey: String(p.id).toLowerCase(), sortBucket: 'playlist', playable: count > 0, meta: { addedAt: p.addedAt || 0 } };
    });
  }

  window.stellaMlibRead = Object.assign(window.stellaMlibRead || {}, {
    albumsFromTracks: albumsFromTracks, artistsFromTracks: artistsFromTracks, playlistsFrom: playlistsFrom,
  });

  // ---- Task 2：seam 门面（每轴 rev 缓存 / in-flight 复用 / seq 丢弃 / 三轴数据入口）----
  var AXES = ['albums', 'artists', 'playlists'];
  var BUCKET_ORDER = { latin: 0, cjk: 1, other: 2 }; // 艺人轴组序 latin→cjk→other（other 前插分界条归 Task 5）
  var DETAIL_METHOD = { albums: 'getAlbumDetail', artists: 'getArtistDetail', playlists: 'getPlaylistDetail' };
  var axisCache = {}; // axis -> { rev, data }：rev 相同即命中，rev 变化整体作废（spec §3/§4）
  var inflight = {};  // axis -> { rev, promise }：同轴同 rev 并发复用同一 promise
  var seq = {};       // axis -> 请求序号：晚到的旧响应丢弃，不污染缓存

  function resetFacade() {
    AXES.forEach(function (a) { axisCache[a] = null; inflight[a] = null; seq[a] = 0; });
  }
  resetFacade();

  function seamReady(axis) {
    var seam = window.stellaMlibSeam;
    var src = axis === 'playlists' ? 'getPlaylists' : 'getTracks';
    return !!seam && typeof seam.getLibraryStats === 'function' && typeof seam[src] === 'function';
  }

  function engineMissing(axis) { return { axis: axis, cards: [], status: 'engine-missing' }; }
  function errorResult(axis, err) {
    var e = err || {};
    return { axis: axis, cards: [], status: 'error', error: e, message: e.message || String(e) };
  }
  function seamThrow(e) { return { code: 'SEAM_THROW', message: String((e && e.message) || e) }; }

  async function probeStats(axis) {
    var seam = window.stellaMlibSeam;
    if (!seamReady(axis)) return { status: 'engine-missing' };
    var stats;
    try { stats = (await seam.getLibraryStats()) || {}; } catch (e) { return { status: 'error', error: seamThrow(e) }; }
    if (stats.error) return { status: 'error', error: stats.error };
    if (!stats.ready) return { status: 'engine-missing' }; // 引擎未就绪与未挂载同口径（spec §5），不轮询
    return { status: 'ok', rev: stats.rev };
  }

  function cmpStr(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

  function sortAlbums(cards) {
    cards.sort(function (x, y) {
      var a = (x.meta && x.meta.releaseYear) || 0, b = (y.meta && y.meta.releaseYear) || 0;
      if (a !== b) return b - a; // 发行年降序、无年份沉底
      return cmpStr(String(x.sortKey), String(y.sortKey)); // 同年份按标题
    });
    return cards;
  }

  function sortArtists(cards) {
    var collator = new Intl.Collator('zh-Hans-CN'); // 组内一次比较；collator 输出前预计算，不进热路径（spec §4）
    cards.sort(function (x, y) {
      var a = BUCKET_ORDER[x.sortBucket], b = BUCKET_ORDER[y.sortBucket];
      if (a !== b) return a - b; // 跨组序固定 latin→cjk→other
      return collator.compare(String(x.sortKey), String(y.sortKey));
    });
    return cards;
  }

  function sortPlaylists(cards) {
    cards.sort(function (x, y) {
      var a = (x.meta && x.meta.addedAt) || 0, b = (y.meta && y.meta.addedAt) || 0;
      if (a !== b) return b - a; // 加入时间降序
      return cmpStr(String(x.sortKey), String(y.sortKey));
    });
    return cards;
  }

  async function otherSourceEmpty(selfAxis) {
    // 'empty' 仅指 tracks+playlists 全空且引擎就绪（spec §5 曲库为空）；仅当本轴空卡时才探另一源
    var seam = window.stellaMlibSeam;
    var method = selfAxis === 'playlists' ? 'getTracks' : 'getPlaylists';
    if (!seam || typeof seam[method] !== 'function') return true; // 另一源未实现＝不贡献数据→视为空
    var res;
    try { res = (await seam[method]()) || {}; } catch (e) { return false; }
    if (res.error) return false; // 另一源失败→不能断言曲库全空，保留 ok+空卡（轴为空口径）
    var list = (selfAxis === 'playlists' ? res.tracks : res.playlists) || [];
    return list.length === 0;
  }

  async function fetchTracks(axis) { // axis: 'albums' | 'artists'
    var seam = window.stellaMlibSeam;
    var res;
    try { res = (await seam.getTracks()) || {}; } catch (e) { return errorResult(axis, seamThrow(e)); }
    if (res.error) return errorResult(axis, res.error); // error 如实上浮，message 透传
    var tracks = res.tracks || [];
    var cards = axis === 'albums' ? sortAlbums(albumsFromTracks(tracks)) : sortArtists(artistsFromTracks(tracks));
    var empty = cards.length === 0 && (await otherSourceEmpty(axis));
    return { axis: axis, cards: cards, status: empty ? 'empty' : 'ok', rev: res.rev };
  }

  async function fetchPlaylists(axis) {
    var seam = window.stellaMlibSeam;
    var res;
    try { res = (await seam.getPlaylists()) || {}; } catch (e) { return errorResult(axis, seamThrow(e)); }
    if (res.error) return errorResult(axis, res.error);
    var cards = sortPlaylists(playlistsFrom(res.playlists || []).filter(function (c) { return !!c; }));
    var empty = cards.length === 0 && (await otherSourceEmpty(axis));
    return { axis: axis, cards: cards, status: empty ? 'empty' : 'ok', rev: res.rev };
  }

  async function runAxisFetch(axis, s, reqRev, holder) {
    var data = axis === 'playlists' ? await fetchPlaylists(axis) : await fetchTracks(axis);
    if (seq[axis] === s) { // seq 丢弃：rev 中途变化时旧响应不得覆盖缓存
      if (data.status === 'ok' || data.status === 'empty') {
        axisCache[axis] = { rev: data.rev == null ? reqRev : data.rev, data: data };
      }
      if (inflight[axis] === holder) inflight[axis] = null;
    }
    return data;
  }

  async function getAxisData(axis) {
    if (AXES.indexOf(axis) === -1) return errorResult(axis, { code: 'UNKNOWN_AXIS', message: '未知数据轴：' + axis });
    ensureSeamWatch(); // 缝可能晚于页面出现：每次读轴都补挂一次（幂等，绝不重订）
    var probe = await probeStats(axis);
    if (probe.status === 'engine-missing') return engineMissing(axis);
    if (probe.status === 'error') return errorResult(axis, probe.error);
    var rev = probe.rev;
    var hit = axisCache[axis];
    if (hit && hit.rev === rev) return hit.data;
    var fly = inflight[axis];
    if (fly && fly.rev === rev) return fly.promise; // 并发去重：同轴 in-flight 复用同一 promise
    var holder = { rev: rev, promise: null };
    holder.promise = runAxisFetch(axis, ++seq[axis], rev, holder);
    inflight[axis] = holder;
    return holder.promise;
  }

  // 批4 引擎的详情方法返回扁平形状（14-mlib-seam.js: getAlbumDetail → {id,title,artist,cover,tracks,rev}），
  // 而 spec §3 契约是 {entity, tracks}。兼容只落在这一处：读层是缝的唯一消费方，页面层继续只认 entity。
  // 字段口径取页面实际消费的五个（08 renderDetailHead：title / sub / count / meta.releaseYear / cover），不多造。
  // cover 只认引擎给 res.cover：艺人轴详情给的是首轨专辑封面，页面按轴另判（头像层绝不吃它）。
  function entityFromFlatDetail(res, tracks) {
    if (typeof res.title !== 'string' && typeof res.id !== 'string') return null; // 无实体字段＝不凭空造实体
    var first = tracks[0] || {};
    return {
      title: String(res.title == null ? '' : res.title),
      sub: String(res.artist == null ? '' : res.artist), // 艺人轴引擎不给 artist → 留空，不拿别的字段凑
      cover: String(res.cover == null ? '' : res.cover),
      count: tracks.length,
      meta: { releaseYear: Number(first.releaseYear) || 0 },
    };
  }

  async function getDetail(axis, id) {
    var seam = window.stellaMlibSeam;
    var method = DETAIL_METHOD[axis];
    if (!method || !seam || typeof seam[method] !== 'function') {
      return { entity: null, tracks: [], status: 'engine-missing' }; // 缝未挂载/缺方法：不 throw
    }
    var res;
    try { res = (await seam[method](id)) || {}; }
    catch (e) { var err = seamThrow(e); return { entity: null, tracks: [], status: 'error', error: err, message: err.message }; }
    if (res.error) return { entity: res.entity || null, tracks: res.tracks || [], status: 'error', error: res.error, message: res.error.message };
    var list = Array.isArray(res.tracks) ? res.tracks : [];
    return { entity: res.entity || entityFromFlatDetail(res, list), tracks: list, status: 'ok' };
  }

  function invalidate() {
    AXES.forEach(function (a) {
      axisCache[a] = null;
      if (inflight[a]) seq[a] += 1; // 令 in-flight 响应经 seq 检查自然丢弃
      inflight[a] = null;
    });
  }

  // ---- F1（终审回批）：seam.subscribe 接线（spec §4 line 60 契约、§5 line 74/83 失效与「等 subscribe 不轮询」）----
  // 读层的 engine-missing 文案承诺「导入……后这里会自动出现」，兑现者就是这条订阅：
  // 缝通知 → 先 invalidate（rev 缓存全废 + 在途响应经 seq 作废）→ 再逐个回调登记方。
  // 分层口径：整模块只订**一枚**缝订阅，多调用方共享内部监听数组；调用方拿到的是自己的 unsubscribe。
  var watchers = [];        // 登记的 onChange（回调数组，一枚缝订阅对多监听方）
  var watchedSeam = null;   // 当前已订阅的那枚缝对象（幂等判定：同一枚缝绝不重订）
  var watchToken = null;    // 本枚订阅的身份；释放/重订后旧 handler 一律作废，不再替新订阅干活
  var watchUnsubscribe = null; // 缝给的 unsubscribe

  function notifyWatchers() {
    // slice：回调里可能 watch/unwatch（数组在迭代中被改会漏通知或重复通知）
    watchers.slice().forEach(function (fn) {
      try { fn(); } catch (e) { /* 一个监听方抛错不拖垮其余登记方 */ }
    });
  }

  // 幂等补挂：缝缺席／缝没实现 subscribe／已订这枚缝 → 一律静默不订（不抛）。
  // 每枚订阅自带一个 token：释放或重订后，缝若还攥着旧那枚 handler，进来先认 token 再干活（一律空转）。
  function ensureSeamWatch() {
    var seam = window.stellaMlibSeam;
    if (!seam || seam === watchedSeam) return;
    if (typeof seam.subscribe !== 'function') return;
    if (watchedSeam) releaseSeamWatch(); // 缝被换掉（引擎重启/晚挂载的第二份）：先退掉旧那一枚再订，不漏水
    var token = {};
    var handler = function () {
      if (watchToken !== token) return;
      invalidate();   // 先作废（rev 缓存全废＋在途响应经 seq 丢弃），再通知——顺序反了会让回调读到旧缓存
      notifyWatchers();
    };
    var off;
    try {
      off = seam.subscribe(handler);
    } catch (e) {
      return; // 缝的 subscribe 自己抛错：不拖垮读层，下次 getAxisData 再补挂
    }
    watchedSeam = seam;
    watchToken = token;
    watchUnsubscribe = typeof off === 'function' ? off : null;
  }

  // 最后一个监听方摘除时释放整模块那枚订阅（不漏水）；token 一并作废，晚到的旧通知自然空转。
  function releaseSeamWatch() {
    if (!watchedSeam) return;
    var off = watchUnsubscribe;
    watchedSeam = null;
    watchToken = null;
    watchUnsubscribe = null;
    if (off) { try { off(); } catch (e) { /* 缝的 unsubscribe 抛错不影响本层 */ } }
  }

  function watchSeam(onChange) {
    ensureSeamWatch(); // 调用方可能早于任何一次读轴：先就地补挂一次
    if (typeof onChange !== 'function') return function () {};
    watchers.push(onChange);
    return function () {
      var i = watchers.indexOf(onChange);
      if (i >= 0) watchers.splice(i, 1);
      if (watchers.length === 0) releaseSeamWatch();
    };
  }

  window.__stellaMlibReadResetForTests = resetFacade;

  window.stellaMlibRead = Object.assign(window.stellaMlibRead || {}, {
    getAxisData: getAxisData, getDetail: getDetail, invalidate: invalidate, watchSeam: watchSeam,
  });

  // ---- Task 3：状态文案表（spec §5 诚实空态；文案归读层，页面只显示不改写）----
  var UNPLAYABLE_HINT = '未匹配到可播来源';
  var EMPTY_ENGINE = { heading: '曲库引擎尚未就绪', hint: '导入歌单或本地音乐后这里会自动出现', action: null };
  var EMPTY_LIBRARY = { heading: '曲库还是空的', hint: '从首页「导入」卡片开始', action: 'import' };
  var AXIS_EMPTY_HEADING = '这个板块还没有内容';
  var AXIS_EMPTY_HINT = { // 轴为空＝曲库非空但该轴无数据：按轴措辞（spec §5），无按钮
    albums: '专辑按曲库里的专辑信息归组，导入匹配后自动出现',
    artists: '艺人按曲库里的艺人信息归组，导入匹配后自动出现',
    playlists: '导入歌单后自动出现',
  };
  var READ_FALLBACK = '读取失败';

  function copy(o) { return { heading: o.heading, hint: o.hint, action: o.action }; }
  function orFallback(v) { // message 缺失/空 → 兜底文案；其余原样（不 trim、不加前缀）
    return v === null || v === undefined || v === '' ? READ_FALLBACK : String(v);
  }

  function getStateCopy(axis, result) {
    var r = result || {};
    var status = r.status;
    if (status === 'engine-missing') return copy(EMPTY_ENGINE);
    if (status === 'empty') return copy(EMPTY_LIBRARY);
    if (status === 'ok') {
      var cards = Array.isArray(r.cards) ? r.cards : [];
      if (cards.length > 0) return null; // 有卡＝正常渲染，绝不进空态盒分支
      return { heading: AXIS_EMPTY_HEADING, hint: AXIS_EMPTY_HINT[axis] || '', action: null };
    }
    if (status === 'error') { // 读取失败：缝 message 如实上屏，重试钮手动触发（spec §5）
      return { heading: orFallback(r.message), hint: '', action: 'retry' };
    }
    // 未知 status：形状同 error，但 action=null——不认识的态不得白送重试钮（防漂移）
    return { heading: orFallback(status), hint: '', action: null };
  }

  function unplayableHint() { return UNPLAYABLE_HINT; }

  window.stellaMlibRead = Object.assign(window.stellaMlibRead || {}, {
    getStateCopy: getStateCopy, unplayableHint: unplayableHint,
  });
})();
