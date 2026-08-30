/*
 * Stellaflix 影视模块 — 影视态首页 (Step 3)
 *
 * 双态同构：复用音乐态既有 DOM（#empty-home 内的 5 张 .home-card 与 #home-tile-row 海报轨），
 *   影视态下改写其文案/封面并接管点击；切回音乐态时交还给 renderHomeDiscover() 权威重渲。
 *   严格铁律：T118 修复后切回音乐态必须 100% 还原所有 home.js 在影视态改写过的元素。
 *
 * 关键设计（均针对真实代码约束）：
 *   1) 卡片按钮带内联 onclick="playHomeSong(0)" 等音乐逻辑 —— 影视态在 .home-grid 上用
 *      **捕获阶段** stopPropagation 拦截，事件到不了 target，内联处理器不会执行。
 *      这样无需增删 onclick 属性，切回音乐态零残留。
 *   2) index.html 的 renderHomeDiscover() 有 13 处调用点，影视态需在其入口早退（守卫已加），
 *      否则任一音乐事件都会把影视文案覆写回去。
 *   3) Electron 下 window.prompt 不可用，故自建极简 URL 输入条，不依赖 prompt。
 *
 * 合规：不预置任何在线片源，仅提供「用户自行选择本地文件 / 自行粘贴地址」两条入口。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // T-#6-序4：纯工具核心（fmtTime / escHtml / escAttr）已抽到 home-core.js，须先于本文件加载
  var HC = SFV.homeCore;
  if (!HC) { throw new Error('[SFV home] homeCore 未加载，请检查 index.html 加载顺序'); }
  var fmtTime = HC.fmtTime, escHtml = HC.escHtml, escAttr = HC.escAttr;

  var SLOT = 'home';
  var urlBar = null;

  // T118 修复（P0）：音乐态基线快照
  // 背景：之前 restoreMusic() 只调用 renderHomeDiscover() 试图还原，
  //   但 home.js 在影视态改写过的 home-poster-title / quote、5 个匿名 .home-card-label、
  //   #home-tile-row 整体、#home-rail-title/note、#sfv-tmdb-attrib、#sfv-back-to-music、
  //   #sfv-urlbar 等元素，renderHomeDiscover() 都没有还原代码 —— 切回音乐态时残留影视态文案。
  //   30 分钟后再切换会再次复现，让用户感觉"两个空间混在一起"。
  // 修复：install() 阶段拍一次音乐态基线（textContent / onclick / display），
  //   restoreMusic() 整体回滚基线后，再交给 renderHomeDiscover() 重建动态数据（封面/标题等）。
  // 严格铁律：双态独立 —— 任一态的 DOM 改写必须能在切回时 100% 还原，不允许残留。
  // T118 音乐态基线快照状态（MUSIC_SNAP_KEY / musicSnap）已迁至 home-snapshot.js

  function d() { return global.document; }
  function $(sel) { var doc = d(); return doc && doc.querySelector ? doc.querySelector(sel) : null; }
  function $all(sel) {
    var doc = d();
    if (!doc || !doc.querySelectorAll) return [];
    return Array.prototype.slice.call(doc.querySelectorAll(sel));
  }
  function isVideoSpace() {
    // T-双态独立海报：SFV.state API + body class 双重判断，避免切态瞬间 SFV.state 还没更新但 DOM class 已切换
    var byState = !!(SFV.state && SFV.state.isVideo && SFV.state.isVideo());
    var byBody = !!(d() && d().body && d().body.classList.contains('video-space-active'));
    return byState || byBody;
  }

  // T-#2：影视海报渲染/动作子系统抽到 home-poster-render.js（存储+posterStore 保留本文件）
  var renderVideoPoster = function () { if (SFV.homePosterRender && SFV.homePosterRender.render) return SFV.homePosterRender.render(); };
  var restructurePosterActionsForVideo = function () { if (SFV.homePosterRender && SFV.homePosterRender.restructure) return SFV.homePosterRender.restructure(); };
  var resetVideoPoster = function () { if (SFV.homePosterRender && SFV.homePosterRender.reset) return SFV.homePosterRender.reset(); };
  var pickLocalVideoPoster = function () { if (SFV.homePosterRender && SFV.homePosterRender.pickLocal) return SFV.homePosterRender.pickLocal(); };
  var pickVideoPoster = function () { if (SFV.homePosterRender && SFV.homePosterRender.pick) return SFV.homePosterRender.pick(); };

  // T-#2：影视卡片子系统抽到 home-cards.js（latestProgress/cardDefs/setCardText/getMusicLeftPoster/setCardArt）
  var latestProgress = function () { if (SFV.homeCards && SFV.homeCards.latestProgress) return SFV.homeCards.latestProgress(); };
  var cardDefs = function () {
    if (SFV.homeCards && typeof SFV.homeCards.cardDefs === 'function') return SFV.homeCards.cardDefs();
    return [];
  };
  var setCardText = function (card, def) { if (SFV.homeCards && SFV.homeCards.setCardText) return SFV.homeCards.setCardText(card, def); };
  var getMusicLeftPoster = function () { if (SFV.homeCards && SFV.homeCards.getMusicLeftPoster) return SFV.homeCards.getMusicLeftPoster(); };
  var setCardArt = function (card, flag) { if (SFV.homeCards && SFV.homeCards.setCardArt) return SFV.homeCards.setCardArt(card, flag); };

  // ---- 捕获阶段拦截：影视态下屏蔽卡片内联 onclick 的音乐逻辑 ----
  // T-#2：「接着看」与恢复播放子系统抽到 home-continue-watching.js（bindGridCapture/bindRailCapture/renderContinueWatching/resumeFromHistory/resumeById/resumeItem/scrollToRail）
  var bindGridCapture = function () { if (SFV.homeContinueWatching && SFV.homeContinueWatching.bindGridCapture) return SFV.homeContinueWatching.bindGridCapture(); };
  var bindRailCapture = function () { if (SFV.homeContinueWatching && SFV.homeContinueWatching.bindRailCapture) return SFV.homeContinueWatching.bindRailCapture(); };
  var renderContinueWatching = function () { if (SFV.homeContinueWatching && SFV.homeContinueWatching.renderContinueWatching) return SFV.homeContinueWatching.renderContinueWatching(); };

  // ---- URL 输入条（替代 Electron 不可用的 window.prompt）----
  function toggleUrlBar() {
    var doc = d();
    if (urlBar && urlBar.parentNode) {
      urlBar.parentNode.removeChild(urlBar);
      urlBar = null;
      return;
    }
    urlBar = doc.createElement('div');
    urlBar.className = 'sfv-urlbar';
    var input = doc.createElement('input');
    input.type = 'text';
    input.className = 'sfv-urlbar-input';
    input.placeholder = '粘贴视频直链（mp4 / m3u8 …），回车打开';
    var ok = doc.createElement('button');
    ok.type = 'button';
    ok.className = 'sfv-urlbar-btn';
    ok.textContent = '打开';
    var cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'sfv-urlbar-btn';
    cancel.textContent = '取消';

    var submit = function () {
      var v = (input.value || '').trim();
      if (!v) return;
      var r = SFV.source ? SFV.source.resolve(v) : null;
      if (r && !r.ok) { toast('无法识别的地址：' + r.reason); return; }
      if (r && r.kind === 'hls' && r.requiresHlsLib) toast('该环境不原生支持 HLS，可能无法播放');
      if (SFV.source) SFV.source.open(v);
      toggleUrlBar();
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', function () { toggleUrlBar(); });
    input.addEventListener('keydown', function (ev) {
      if (ev && (ev.key === 'Enter' || ev.keyCode === 13)) submit();
      if (ev && (ev.key === 'Escape' || ev.keyCode === 27)) toggleUrlBar();
    });

    urlBar.appendChild(input);
    urlBar.appendChild(ok);
    urlBar.appendChild(cancel);
    (doc.body || doc.documentElement).appendChild(urlBar);
    if (input.focus) { try { input.focus(); } catch (e) {} }
  }

  function toast(msg) {
    var doc = d();
    if (!doc || !doc.createElement) return;
    var t = doc.createElement('div');
    t.className = 'sfv-toast';
    t.textContent = msg;
    (doc.body || doc.documentElement).appendChild(t);
    global.setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 2600);
  }

  // ---- slot providers ----
  function render() {
    if (!isVideoSpace()) return;
    bindGridCapture();
    bindRailCapture();
    var cards = $all('#empty-home .home-grid .home-card');
    var defs = cardDefs();

    // 从 state.js setSpace 钩子写入的跨态快照读取音乐态海报；
    // 首屏直接进入影视态（state.init 绕过快照钩子）时自动兜底重新读取。
    var musicCross = getMusicCrossPoster();
    var musicSyncUrl = musicCross ? musicCross.syncUrl : '';
    var musicBlobPromise = musicCross ? musicCross.blobPromise : null;
    console.log('[SFV-HOME] render() musicCross sync:', musicSyncUrl ? 'yes' : 'no', 'blobPromise:', !!musicBlobPromise);

    for (var i = 0; i < cards.length; i++) {
      if (i < defs.length) {
        setCardText(cards[i], defs[i]);

        // [方案A 根治] 保留 data-home-tone（不摘除）。
        // data-home-tone 是音乐态 --tone-a 配色的来源，驱动每卡 label / 装饰色。
        // 影视态复用音乐态同一组 DOM，模板里 data-home-tone 已按位置写死
        // (search/library/mix/playlist/local)，保留它即可让影视态 5 张卡 tone-a 与音乐态
        // 同位置对齐（青/青/蓝灰/青/奶白），无需 nth-child 补丁。
        // 若误删，tone-a 会回退基类默认青色，音乐态的色彩层次随之丢失（此前的不一致 root cause）。
        // 仍保留 home-card-featured / home-card-quick（控制 art 尺寸/排版），沿用音乐态 DOM 上的 class。
        // cards[0] = featured (心动大卡), cards[1-4] = quick (片单/追片/历史/音乐空间小卡)

        // T119：每张分类卡的封面 = 各自 flag 类最新一条的 pic
        // 传 musicSyncUrl 供 music-space 卡使用
        var usedArtUrl = setCardArt(cards[i], defs[i].flag || null, musicSyncUrl);

        // 如果 music-space 卡有异步 blobPromise 但同步没拿到，等 blob load 完再写
        if (defs[i].flag === 'music-space' && !usedArtUrl && musicBlobPromise) {
          var artEl = cards[i].querySelector('.home-card-art');
          if (artEl) {
            musicBlobPromise.then(function (url) {
              if (url) {
                try {
                  artEl.style.backgroundImage = 'url("' + url + '")';
                  artEl.classList.add('has-cover');
                  console.log('[SFV-HOME] async blob poster applied to music-space card');
                } catch (e) {}
              }
            }).catch(function () {});
          }
        }

        // [问题1修复] 统一用 property 赋值，彻底抛弃 setAttribute 字符串。
        // 原因：音乐态模板原来写的 onclick attribute 是字符串形式，而我们用 property function 赋值
        // 最可靠，不会有任何引号嵌套 / 转义问题。同时要把音乐态残留的 attribute 清干净。
        // cardDefs 里所有 action 都是 function（包括 music-space 的），直接赋值即可。
        var act = defs[i].action;
        if (typeof act === 'function') {
          cards[i].onclick = act;
        } else if (typeof act === 'string') {
          // 防御：如果 cardDefs 里有 action 是字符串（对齐音乐态模板风格），
          // 用 setAttribute + 清空 property
          cards[i].setAttribute('onclick', act);
          cards[i].onclick = null;
        }
        // 无论如何，都要清空音乐态 DOM 上残留的 onclick attribute（可能有旧值）
        // 对于上面用 property function 赋值的场景，setAttribute 会覆盖旧的 attribute 值
        if (typeof act === 'function') {
          cards[i].setAttribute('onclick', '');
        }

        cards[i].style.display = '';
      } else {
        // 多余卡位隐藏（DOM 有 6 卡时保护）
        cards[i].style.display = 'none';
      }
    }
    var hero = $('#empty-home .home-poster-title');
    if (hero) hero.textContent = '我的影视空间';
    // T134-f：影视态文案回读视频独立 store（posterStore.quote），有则用、无则默认；不再写死
    var quote = d() && d().getElementById ? d().getElementById('home-poster-quote') : null;
    if (quote) {
      var vq = posterStore && posterStore.quote;
      console.log('[SFV-HOME] render() setting quote, posterStore.quote:', JSON.stringify(vq), 'posterStore:', !!posterStore);
      quote.textContent = vq ? vq : '导入你自己的片源，搜索 / 播放 / 收藏都在这里完成 —— Stellaflix 不存储任何视频资源。';
    }
    // 影视态最近播放（覆盖音乐态残留文案）
    var nowEl = d() && d().getElementById ? d().getElementById('home-poster-now') : null;
    if (nowEl) {
      var history = (SFV.model && SFV.model.getHistory) ? SFV.model.getHistory() : [];
      if (history.length && history[0] && history[0].title) {
        nowEl.textContent = '最近播放 · ' + history[0].title;
      } else {
        nowEl.textContent = '播放任意影片后，这里会显示最近观看。';
      }
    }
    // 用户要求移除红笔圈出的 TMDB 署名；清理可能残留的 DOM
    var doc = d();
    if (doc && doc.getElementById) {
      var oldAttrib = doc.getElementById('sfv-tmdb-attrib');
      if (oldAttrib && oldAttrib.parentNode) oldAttrib.parentNode.removeChild(oldAttrib);
    }
    // 接着看：5 卡横排（对齐音乐态 renderHomeTiles 的 #home-tile-row）
    renderContinueWatching();
    // T119：渲染影视态左侧海报（独立于音乐态）
    console.log('[SFV-HOME] render() calling renderVideoPoster, posterStore:', !!posterStore, 'url:', !!(posterStore && posterStore.url));
    renderVideoPoster();
    // T119：改造 home-poster-actions 5 个 chip（隐藏"用当前封面"；海报只允许本地自定义图，故移除 TMDB 选图入口）
    restructurePosterActionsForVideo();
    // T118：进入影视态时也触发 3D 歌单架 rebuild，让 currentItems() 走 video 分支
    if (typeof global.scheduleShelfRebuild === 'function') {
      try { global.scheduleShelfRebuild('sfv-render-video', true); } catch (e) {}
    }

    // T134-f Layer4：requestAnimationFrame 自愈——拦截 render() 之后任何异步路径对海报/文案的覆盖
    // 原因：safePlaybackStep('home-poster', ...) 在播放状态变化时同步调用 renderHomePersonalPoster，
    //   它可能在 render() 之后同一微任务或下一帧执行（如切歌事件恰好在 spacechange 后触发）。
    //   即使前面三层守卫（回调包装 / 函数入口 / renderHomeDiscover）全部生效，此层作为最后保险。
    // T134-f Layer4：raf 自愈（修正 10:52 — 实时读 posterStore，编辑中跳过）
    var doc = d();
    var _healReRenderPending = false;
    (function heal() {
      var raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : function(fn) { return setTimeout(fn, 16); };
      raf(function () {
        try {
          if (!doc || !doc.body || !doc.body.classList.contains('video-space-active')) return;
          var copyEl = doc.querySelector('.home-poster-copy');
          if (copyEl && copyEl.classList.contains('editing')) return;
          var liveQuote = (posterStore && posterStore.quote) || '';
          var liveUrl = (posterStore && posterStore.url) || '';
          var liveKind = (posterStore && posterStore.kind === 'video') ? 'video' : 'image';
          var liveBlob = (posterStore && posterStore.blobKey) || '';
          if (liveQuote) {
            var q = doc.getElementById('home-poster-quote');
            if (q && q.textContent !== liveQuote) q.textContent = liveQuote;
          }
          // 情况1：图片 + dataUrl → 设置 CSS var（原逻辑）
          if (liveKind === 'image' && liveUrl) {
            var m = doc.getElementById('home-poster-media');
            if (m) {
              var current = m.style.getPropertyValue('--home-poster-image') || '';
              if (current.indexOf(liveUrl.slice(0, 40)) === -1) {
                m.style.setProperty('--home-poster-image', 'url("' + escAttr(liveUrl) + '")');
                m.classList.add('sfv-poster-movie', 'has-image');
                m.classList.remove('sfv-poster-default', 'sfv-poster-has-video');
              }
            }
          }
          // 情况2：视频 或 blobDB 内的大图片 → 确认内嵌媒体元素存在，否则 re-render 一次
          if (!_healReRenderPending && (liveKind === 'video' || (liveKind === 'image' && liveBlob && !liveUrl))) {
            var mm = doc.getElementById('home-poster-media');
            if (mm) {
              var needReRender = false;
              var tag = liveKind === 'video' ? 'video' : 'img';
              var cls = liveKind === 'video' ? 'sfv-poster-video-bg' : 'sfv-poster-image-bg-blob';
              var found = mm.querySelector(tag + '.' + cls);
              if (!found) needReRender = true;
              else if (liveKind === 'video' && found.src && _outerPosterActiveObjectUrl
                && found.src !== _outerPosterActiveObjectUrl && found.getAttribute('src') !== _outerPosterActiveObjectUrl) {
                needReRender = true;
              }
              if (needReRender) {
                _healReRenderPending = true;
                setTimeout(function () {
                  _healReRenderPending = false;
                  try {
                    if (doc && doc.body && doc.body.classList.contains('video-space-active')) {
                      renderVideoPoster();
                    }
                  } catch (_e2) { /* ignore */ }
                }, 40);
              } else {
                // 媒体元素存在，且 className 正确标记
                mm.classList.add('sfv-poster-movie');
                if (liveKind === 'video') mm.classList.add('sfv-poster-has-video');
                else mm.classList.add('has-image');
                mm.classList.remove('sfv-poster-default');
              }
            }
          }
        } catch (e) { /* 自愈失败静默 */ }
      });
    })();
    // 切进影视态：刷新首页 Insight 卡片为「今日观看」形态（和 T118 同层级 — 独立 DOM，不影响音乐态快照）
    try {
      if (typeof global.renderHomeInsightDock === 'function') global.renderHomeInsightDock();
    } catch (e) { /* 非致命 */ }
  }

  function ensureBackBtn() {
    var doc = d();
    if (!doc || !doc.getElementById) return;
    var btn = doc.getElementById('sfv-back-to-music');
    if (!btn) {
      btn = doc.createElement('button');
      btn.id = 'sfv-back-to-music';
      btn.className = 'sfv-back-to-music';
      btn.type = 'button';
      btn.textContent = '← 返回音乐';
      btn.addEventListener('click', function () {
        if (SFV.state && SFV.state.setSpace) SFV.state.setSpace('music');
      });
      // 插入到海报区域底部（home-poster 内）
      var poster = doc.getElementById('home-poster');
      if (poster) poster.appendChild(btn);
      else { /* fallback: 不强挂 */ }
    }
    btn.style.display = '';
  }

  function hideBackBtn() {
    var btn = d() && d().getElementById ? d().getElementById('sfv-back-to-music') : null;
    if (btn) btn.style.display = 'none';
  }

  // ---- T119：影视海报独立化 ----
  // 用户死命令：影视态的海报 ≠ 音乐态的海报；用电影海报；用户未看影视用默认封面
  // 海报来源策略（A4 + 用户后续答案）：
  //   1) localStorage['stellaflix-video-poster'] 用户手动设置过 → 用设置
  //   2) 否则：liked + 追片(track) + inList + history 所有 vod meta，按 ts 倒序取最新一条的 pic
  //   3) 否则（C1 兜底）：默认封面 = B3 暗色玻璃 + 🎬 emoji
  var VIDEO_POSTER_LS_KEY = 'stellaflix-video-poster';

  // ---- T-双态独立海报：外层海报大媒体 IndexedDB（存视频 MP4 Blob，不走 base64/IPC JSON） ----
  var OUTER_POSTER_MEDIA_DB = 'stellaflix-outer-poster-media-v1';
  var OUTER_POSTER_MEDIA_STORE = 'media';
  var OUTER_POSTER_VIDEO_BLOB_KEY = 'outer-video';   // 影视态外层海报的媒体 blob key
  var OUTER_POSTER_MUSIC_BLOB_KEY = 'outer-music';   // 音乐态外层海报的媒体 blob key（bridge 用）
  var _outerPosterMediaDbPromise = null;
  var _outerPosterActiveObjectUrl = '';

  function outerPosterOpenDb() {
    if (_outerPosterMediaDbPromise) return _outerPosterMediaDbPromise;
    _outerPosterMediaDbPromise = new Promise(function (resolve, reject) {
      try {
        var DB = global.indexedDB || global.webkitIndexedDB || global.mozIndexedDB || global.msIndexedDB;
        if (!DB) return reject(new Error('INDEXEDDB_NOT_AVAILABLE'));
        var req = DB.open(OUTER_POSTER_MEDIA_DB, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(OUTER_POSTER_MEDIA_STORE)) {
            db.createObjectStore(OUTER_POSTER_MEDIA_STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('OUTER_POSTER_DB_OPEN_FAILED')); };
        req.onblocked = function () { reject(new Error('OUTER_POSTER_DB_BLOCKED')); };
      } catch (e) { reject(e); }
    });
    return _outerPosterMediaDbPromise;
  }
  function outerPosterBlobPut(key, blob, meta) {
    return outerPosterOpenDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(OUTER_POSTER_MEDIA_STORE, 'readwrite');
        tx.objectStore(OUTER_POSTER_MEDIA_STORE).put({
          id: String(key || ''),
          blob: blob,
          meta: meta || {},
        });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error('OUTER_POSTER_PUT_FAILED')); };
        tx.onabort = function () { reject(tx.error || new Error('OUTER_POSTER_PUT_ABORTED')); };
      });
    });
  }
  function outerPosterBlobGet(key) {
    return outerPosterOpenDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(OUTER_POSTER_MEDIA_STORE, 'readonly');
        var req = tx.objectStore(OUTER_POSTER_MEDIA_STORE).get(String(key || ''));
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error || new Error('OUTER_POSTER_GET_FAILED')); };
      });
    });
  }
  function outerPosterBlobDelete(key) {
    return outerPosterOpenDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(OUTER_POSTER_MEDIA_STORE, 'readwrite');
        tx.objectStore(OUTER_POSTER_MEDIA_STORE).delete(String(key || ''));
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error('OUTER_POSTER_DELETE_FAILED')); };
        tx.onabort = function () { reject(tx.error || new Error('OUTER_POSTER_DELETE_ABORTED')); };
      });
    });
  }
  function releasePosterObjectUrl() {
    if (_outerPosterActiveObjectUrl) {
      try { (global.URL || global.webkitURL).revokeObjectURL(_outerPosterActiveObjectUrl); } catch (_e) { /* ignore */ }
      _outerPosterActiveObjectUrl = '';
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 跨态海报快照存储：state.js 在 setSpace emit 之前调用 _preCapturePosterSnapshot() 写入
  // 每个快照包含 fromSpace 的海报同步 URL（dataUrl 或 blobUrl），以及 IndexedDB 大图异步加载 Promise
  // render() 再从这里读，保证比 renderVideoPoster()/restoreMusic() 覆盖 DOM 更早拿到值
  var _crossPosterSnapshot = {
    music: null,    // { syncUrl, blobPromise } 音乐态海报的同步 URL 或异步 blob
    video: null,    // 同上，影视态（读 posterStore）
  };

  // state.js 钩子：在 setSpace 改 spaceMode 之前被调用
  function _preCapturePosterSnapshot(fromSpace, toSpace) {
    try {
      console.log('[SFV-HOME] _preCapturePosterSnapshot:', fromSpace, '→', toSpace);
      if (fromSpace === 'music') {
        // 拍音乐态海报快照
        _crossPosterSnapshot.music = _readMusicPosterNow();
      } else if (fromSpace === 'video') {
        // 拍影视态海报快照（读 posterStore）
        _crossPosterSnapshot.video = _readVideoPosterNow();
      }
    } catch (e) {
      console.warn('[SFV-HOME] _preCapturePosterSnapshot failed:', e);
    }
  }

  // 同步读音乐态左侧海报（只返回同步能拿到的 dataUrl/blobUrl，或启动异步 IndexedDB 加载）
  function _readMusicPosterNow() {
    var result = { syncUrl: '', blobPromise: null };
    try {
      var doc = global.document;
      if (doc && doc.getElementById) {
        var pm = doc.getElementById('home-poster-media');
        if (pm) {
          // 1. 读 vendor 设置的 --home-poster-image CSS var
          var cv = pm.style.getPropertyValue('--home-poster-image') || '';
          if (cv) { var m = cv.match(/url\(["']?(.+?)["']?\)/); if (m && m[1]) { result.syncUrl = m[1]; } }
          // 2. 读 inline backgroundImage
          if (!result.syncUrl) {
            var bg = pm.style.backgroundImage || '';
            if (bg) { var m2 = bg.match(/url\(["']?(.+?)["']?\)/); if (m2 && m2[1]) result.syncUrl = m2[1]; }
          }
          // 3. 读 vendor 写入的 class 上的 backgroundImage（vendor 可能通过 CSS class 而不是 inline style 设置）
          if (!result.syncUrl) {
            var cssBg = doc.defaultView.getComputedStyle(pm).backgroundImage || '';
            if (cssBg && cssBg !== 'none') { var m3 = cssBg.match(/url\(["']?(.+?)["']?\)/); if (m3 && m3[1]) result.syncUrl = m3[1]; }
          }
          // 4. 读 outer-poster-bridge 注入的 <img class="sfv-poster-music-image-bg"> src
          if (!result.syncUrl) {
            var imgBg = pm.querySelector('img.sfv-poster-music-image-bg');
            if (imgBg && imgBg.src && imgBg.src.indexOf('data:') === 0) {
              // data: 永久可用，可直接作为跨态 syncUrl
              result.syncUrl = imgBg.src;
            }
            // blob: 是会被 _revokeMusicObjectUrl 在切态后回收的临时句柄，
            // 不得作为跨态 syncUrl 直接用（render 前/后被回收 → 悬空引用 → 不显示）。
            // 此处故意留空，交给下方 layer6 异步从 IndexedDB 重新水合出新的有效 object URL。
          }
        }
      }
      // 5. localStorage 兜底（vendor 存的 dataUrl）
      if (!result.syncUrl) {
        try {
          var raw = global.localStorage.getItem('stellaflix-home-personal-poster-v1');
          if (raw) { var p = JSON.parse(raw); if (p && p.image) result.syncUrl = p.image; }
        } catch (e2) { /* ignore */ }
      }
      // 6. 如果 outer-poster-bridge 有 IndexedDB 媒体（blobKey='outer-music'），
      //    启动异步加载并存 Promise，让 render() 可以 await。
      //    该 URL 由外层新建、不写入 MUSIC_OBJECT_URL，因此切态时的 _revokeMusicObjectUrl 不会回收它，
      //    跨态复用安全。注意：此处不再用 !result.syncUrl 守门，
      //    因为 blob: 海报在 layer4 被故意留空，必须走到这里重新水合。
      if (true) {
        try {
          var metaRaw = global.localStorage.getItem('mineradio.outer.poster.meta.music');
          if (metaRaw) {
            var meta = JSON.parse(metaRaw);
            if (meta && meta.blobKey === 'outer-music' && typeof outerPosterBlobGet === 'function') {
              result.blobPromise = outerPosterBlobGet('outer-music').then(function (entry) {
                if (entry && entry.blob) {
                  return (global.URL || global.webkitURL).createObjectURL(entry.blob);
                }
                return '';
              }).catch(function () { return ''; });
            }
          }
        } catch (e3) { /* ignore */ }
      }
      // 7. home-dashboard 用户背景图：localStorage meta + dashboard 自己的 IndexedDB
      //    重要纠正：2.1.0 的"音乐态海报"实际来自 home-dashboard（03a-home-dashboard.js），
      //    不是 outer-poster-bridge，也不是 vendor 的 homePosterState。dashboard 把用户上传的图
      //    渲染为 <img class="home-dashboard-video" src="blob:DASHBOARD"> 注入到 .daily-review-card
      //    （与 #home-poster-media 是两个容器），其 blob URL（homeDashboardVideoObjectUrl）会在
      //    切态时被 homeDashboardReleaseVideoSource 回收——同 outer bridge 一样的悬空陷阱。
      //    因此只能从 dashboard 自己的 IDB（stellaflix-home-dashboard-video-v1 / store 'media' /
      //    key 'home-hero-video-music'，记录形如 {id, blob, meta}）重新拿 blob，
      //    createObjectURL 出新的、不被 dashboard 追踪的 URL，跨态复用安全。
      if (!result.syncUrl) {
        try {
          var dashMetaRaw = global.localStorage.getItem('stellaflix-home-dashboard-video-meta-v1-music');
          if (dashMetaRaw && global.indexedDB) {
            var dashMeta = JSON.parse(dashMetaRaw);
            if (dashMeta && dashMeta.version === 1 && dashMeta.kind === 'image') {
              result.blobPromise = new Promise(function (resolve) {
                try {
                  var req = global.indexedDB.open('stellaflix-home-dashboard-video-v1', 1);
                  req.onupgradeneeded = function () {
                    var db = req.result;
                    if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
                  };
                  req.onsuccess = function () {
                    try {
                      var db = req.result;
                      var tx = db.transaction('media', 'readonly');
                      var g = tx.objectStore('media').get('home-hero-video-music');
                      g.onsuccess = function () {
                        var rec = g.result;
                        if (rec && rec.blob) {
                          try { resolve((global.URL || global.webkitURL).createObjectURL(rec.blob)); }
                          catch (_eu) { resolve(''); }
                        } else { resolve(''); }
                      };
                      g.onerror = function () { resolve(''); };
                    } catch (_etx) { resolve(''); }
                  };
                  req.onerror = function () { resolve(''); };
                } catch (_eopen) { resolve(''); }
              });
            }
          }
        } catch (e4) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    console.log('[SFV-HOME] _readMusicPosterNow:', result.syncUrl ? result.syncUrl.slice(0, 60) + '...' : '(empty)', 'blobPromise:', !!result.blobPromise);
    return result;
  }

  // 同步读影视态左侧海报（从 posterStore）
  function _readVideoPosterNow() {
    var result = { syncUrl: '', blobPromise: null };
    try {
      if (posterStore && posterStore.url) {
        result.syncUrl = posterStore.url;
      }
      if (!result.syncUrl && posterStore && posterStore.blobKey && typeof outerPosterBlobGet === 'function') {
        result.blobPromise = outerPosterBlobGet(posterStore.blobKey).then(function (entry) {
          if (entry && entry.blob) {
            return (global.URL || global.webkitURL).createObjectURL(entry.blob);
          }
          return '';
        }).catch(function () { return ''; });
      }
    } catch (e) { /* ignore */ }
    return result;
  }

  // 供 render() 使用的跨态海报读取函数（同步优先 + 触发异步 fallback）
  function getCrossPoster(fromSpace) {
    var snap = _crossPosterSnapshot[fromSpace];
    if (!snap) return { syncUrl: '', blobPromise: null };
    return snap;
  }

  // 读取音乐态跨态海报：优先用 state.js setSpace 钩子捕获的快照；
  // 若快照为空 —— 典型场景是「开屏直接进入影视态」：state.init() 直接置 spaceMode='video'
  // 并 emit，绕过了 _preCapturePosterSnapshot 钩子，因此从未捕获音乐态海报快照 ——
  // 则直接重新读取。dashboard 海报持久化在 IndexedDB/localStorage，与是否经过
  // music→video 切换无关，首屏即可拿到，故此处兜底读取可修复「首屏不显示」问题。
  function getMusicCrossPoster() {
    var snap = getCrossPoster('music');
    if (!snap || (!snap.syncUrl && !snap.blobPromise)) {
      try { snap = _readMusicPosterNow(); } catch (e) { snap = snap || { syncUrl: '', blobPromise: null }; }
    }
    return snap;
  }

  // 内存缓存：undefined=未加载（用 localStorage 兼容路径）, null=已加载但无数据, {}有数据
  var posterStore = undefined;

  // 根据当前态的 posterStore 返回可渲染媒体：image 模式返回 { kind:'image', url }（dataUrl 或 blobUrl）；
  // video 模式返回 { kind:'video', blobUrl, name, size }，并释放上一次的 objectURL。
  // 兼容两种 image 存储：
  //   1) 常规压缩图 → posterStore.url 直接为 base64 dataUrl
  //   2) 大图（迁移后） → posterStore.url 为空，posterStore.blobKey 指向 IndexedDB
  function loadPosterSavedMedia() {
    return new Promise(function (resolve) {
      try {
        var rec = (posterStore && typeof posterStore === 'object') ? posterStore : null;
        if (!rec) return resolve({ kind: 'empty' });
        var kind = rec.kind === 'video' ? 'video' : 'image';
        var blobKey = rec.blobKey || '';
        // ── 需要 blob（video 或 image-in-blobDB）
        if ((kind === 'video' && blobKey) || (kind === 'image' && !rec.url && blobKey)) {
          releasePosterObjectUrl();
          outerPosterBlobGet(blobKey).then(function (entry) {
            if (!entry || !entry.blob) return resolve({ kind: 'empty' });
            try {
              var url = (global.URL || global.webkitURL).createObjectURL(entry.blob);
              _outerPosterActiveObjectUrl = url;
              resolve({
                kind: kind,
                blobUrl: url,
                name: (rec.name) || (entry.meta && entry.meta.name) || '',
                size: Number(rec.size || (entry.meta && entry.meta.size) || 0),
                useBlobForImage: kind === 'image', // 渲染端创建 IMG 而非 VIDEO
              });
            } catch (e) { resolve({ kind: 'empty' }); }
          }, function () { resolve({ kind: 'empty' }); });
          return;
        }
        // 图片（含未设置 kind 的老数据）
        if (rec.url && typeof rec.url === 'string' && rec.url.indexOf('data:') === 0) {
          return resolve({
            kind: 'image',
            url: rec.url,
            name: rec.name || '',
            size: Number(rec.size || 0),
          });
        }
        resolve({ kind: 'empty' });
      } catch (_e) { resolve({ kind: 'empty' }); }
    });
  }

  // 把 pickMedia() 的返回（图片 dataUrl 或 视频 filePath → blob）
  //   → 写入 IPC 存储 + 必要时写 IndexedDB blob
  //   → 更新内存 posterStore
  //   → 返回 Promise<true|false>
  function savePosterMediaFromPicker(pickResult) {
    return new Promise(function (resolve) {
      try {
        if (!pickResult || !pickResult.ok) return resolve(false);
        if (pickResult.canceled) return resolve(true);

        var prevQuote = (posterStore && posterStore.quote) || '';
        var prevBlobKey = (posterStore && posterStore.blobKey) || '';

        // ── 图片：走 canvas 压缩（复用 home-poster-render 原逻辑）后 dataUrl 存 IPC JSON ──
        if (pickResult.isImage && pickResult.dataUrl) {
          var doc = d();
          if (!doc) return resolve(false);
          var img = doc.createElement('img');
          img.onload = function () {
            try {
              var maxSide = 1400;
              var iw = img.naturalWidth || img.width || 1;
              var ih = img.naturalHeight || img.height || 1;
              var scale = Math.min(1, maxSide / Math.max(iw, ih));
              var w = Math.max(1, Math.round(iw * scale));
              var h = Math.max(1, Math.round(ih * scale));
              var cv = doc.createElement('canvas');
              cv.width = w; cv.height = h;
              var cx = cv.getContext('2d');
              cx.drawImage(img, 0, 0, w, h);
              var compressed = cv.toDataURL('image/jpeg', 0.88);
              img.onload = null; img.onerror = null;
              var data = {
                kind: 'image',
                url: compressed,
                source: 'custom',
                title: pickResult.fileName || '',
                name: pickResult.fileName || '',
                size: Number(pickResult.fileSize || 0),
                blobKey: '',  // 图片压缩后走 dataUrl，不占 IndexedDB
                quote: prevQuote,
                ts: Date.now(),
              };
              posterStore = data;
              if (global.desktopWindow && typeof global.desktopWindow.videoPoster === 'function') {
                global.desktopWindow.videoPoster('set', data);
              }
              try { if (global.localStorage) global.localStorage.setItem(VIDEO_POSTER_LS_KEY, JSON.stringify(data)); } catch (_e) { /* quota */ }
              resolve(true);
            } catch (e) { resolve(false); }
          };
          img.onerror = function () {
            img.onload = null; img.onerror = null;
            // 压缩失败但好歹原始 dataUrl 还能救一下
            var data = {
              kind: 'image',
              url: pickResult.dataUrl,
              source: 'custom',
              title: pickResult.fileName || '',
              name: pickResult.fileName || '',
              size: Number(pickResult.fileSize || 0),
              blobKey: '',
              quote: prevQuote,
              ts: Date.now(),
            };
            posterStore = data;
            if (global.desktopWindow && typeof global.desktopWindow.videoPoster === 'function') {
              global.desktopWindow.videoPoster('set', data);
            }
            try { if (global.localStorage) global.localStorage.setItem(VIDEO_POSTER_LS_KEY, JSON.stringify(data)); } catch (_e) { /* quota */ }
            resolve(true);
          };
          img.src = pickResult.dataUrl;
          return;
        }

        // ── 视频：写入 IndexedDB（大 Blob），IPC JSON 只存元信息 ──
        if (pickResult.isVideo && pickResult.filePath) {
          if (!(global.desktopWindow && typeof global.desktopWindow.fileToBlob === 'function')) {
            return resolve(false);
          }
          global.desktopWindow.fileToBlob(pickResult.filePath).then(function (blobRes) {
            try {
              if (!blobRes || !blobRes.ok || !blobRes.buffer) return resolve(false);
              var buf = blobRes.buffer;
              var ab = buf.buffer ? buf.buffer.slice(buf.byteOffset || 0, (buf.byteOffset || 0) + (buf.byteLength || 0)) : buf;
              var mimeType = pickResult.mimeType || 'video/mp4';
              var blob = new global.Blob([ab], { type: mimeType });
              var fileName = pickResult.fileName || blobRes.fileName || '';
              var fileSize = Number(pickResult.fileSize || blobRes.size || 0);
              outerPosterBlobPut(OUTER_POSTER_VIDEO_BLOB_KEY, blob, { name: fileName, size: fileSize, ts: Date.now() }).then(function () {
                // 保存：若之前的 blobKey 不同并且也是外层海报键，尝试删旧的释放空间
                if (prevBlobKey && prevBlobKey !== OUTER_POSTER_VIDEO_BLOB_KEY
                  && (prevBlobKey === OUTER_POSTER_VIDEO_BLOB_KEY || prevBlobKey === OUTER_POSTER_MUSIC_BLOB_KEY)) {
                  outerPosterBlobDelete(prevBlobKey).catch(function () { /* ignore */ });
                } else if (!prevBlobKey) {
                  /* 之前是图片（无 blobKey），图片的 base64 url 字段自然被下一数据覆盖 */
                }
                var data = {
                  kind: 'video',
                  url: '',  // 视频不存 dataUrl
                  blobKey: OUTER_POSTER_VIDEO_BLOB_KEY,
                  name: fileName,
                  size: fileSize,
                  source: 'custom',
                  title: fileName,
                  quote: prevQuote,
                  ts: Date.now(),
                };
                posterStore = data;
                releasePosterObjectUrl(); // 下次渲染时重开
                if (global.desktopWindow && typeof global.desktopWindow.videoPoster === 'function') {
                  global.desktopWindow.videoPoster('set', data);
                }
                try { if (global.localStorage) global.localStorage.setItem(VIDEO_POSTER_LS_KEY, JSON.stringify(data)); } catch (_e) { /* quota */ }
                resolve(true);
              }, function () { resolve(false); });
            } catch (_e2) { resolve(false); }
          }, function () { resolve(false); });
          return;
        }

        resolve(false);
      } catch (_e) { resolve(false); }
    });
  }

  // 异步加载持久化海报（文件存储）到内存缓存。
  // 文件不存在时回退读取 localStorage 旧数据并迁移到文件，保证升级平滑。
  function loadPosterStore() {
    return new Promise(function (resolve) {
      try {
        if (global.desktopWindow && typeof global.desktopWindow.videoPoster === 'function') {
          global.desktopWindow.videoPoster('get').then(function (r) {
            if (r && r.ok && r.data) {
              posterStore = r.data;
            } else {
              var legacy = migrateLocalStoragePoster();
              if (legacy) {
                posterStore = legacy;
                global.desktopWindow.videoPoster('set', legacy); // 迁移写入文件
              } else {
                posterStore = null;
              }
            }
            resolve();
          }).catch(function () { posterStore = null; resolve(); });
          return;
        }
      } catch (e) { /* ignore */ }
      posterStore = null;
      resolve();
    });
  }

  // 从 localStorage 旧键迁移自定义海报数据（一次性）
  function migrateLocalStoragePoster() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(VIDEO_POSTER_LS_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && (parsed.url || parsed.poster)) {
        var rec = {
          kind: (parsed.kind === 'video') ? 'video' : 'image',
          url: parsed.url || parsed.poster,
          source: parsed.source || 'custom',
          title: parsed.title || '',
          quote: parsed.quote || '',
          blobKey: parsed.blobKey || '',
          name: parsed.name || '',
          size: Number(parsed.size) || 0,
          ts: parsed.ts || Date.now(),
        };
        // T-双态独立：老 base64 图若 > 5MB → 迁入 IndexedDB 释放 LS 空间
        if (rec.kind === 'image' && rec.url && rec.url.indexOf('data:image') === 0 && rec.url.length > 5 * 1024 * 1024) {
          try {
            var binary = atob(rec.url.split(',')[1] || '');
            var arr = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
            var mType = rec.url.slice(5).split(';')[0] || 'image/jpeg';
            var bigBlob = new global.Blob([arr], { type: mType });
            outerPosterBlobPut(OUTER_POSTER_VIDEO_BLOB_KEY, bigBlob, { name: rec.name || 'migrated-image', size: arr.length, ts: rec.ts });
            rec.blobKey = OUTER_POSTER_VIDEO_BLOB_KEY;
            rec.url = '';
          } catch (_ee) { /* 迁移失败保持原样，不影响用户 */ }        }
        return rec;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // 读取用户手动设置的海报（优先内存缓存；未加载时走 localStorage 兼容旧数据）
  function getUserVideoPoster() {
    try {
      if (posterStore !== undefined) {
        if (posterStore && (posterStore.url || posterStore.poster || posterStore.blobKey)) {
          var kind = posterStore.kind === 'video' ? 'video' : 'image';
          return {
            kind: kind,
            url: posterStore.url || posterStore.poster || '',
            blobKey: posterStore.blobKey || '',
            name: posterStore.name || '',
            size: Number(posterStore.size) || 0,
            source: posterStore.source || 'custom',
            title: posterStore.title || '',
            quote: posterStore.quote || '',
            ts: Number(posterStore.ts) || 0,
          };
        }
        return null;
      }
      // 兼容：缓存尚未加载，直接读 localStorage（迁移期）
      var raw = global.localStorage && global.localStorage.getItem(VIDEO_POSTER_LS_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && (parsed.url || parsed.poster || parsed.blobKey)) {
        var kind2 = parsed.kind === 'video' ? 'video' : 'image';
        return {
          kind: kind2,
          url: parsed.url || parsed.poster || '',
          blobKey: parsed.blobKey || '',
          name: parsed.name || '',
          size: Number(parsed.size) || 0,
          source: parsed.source || 'custom',
          title: parsed.title || '',
          quote: parsed.quote || '',
          ts: Number(parsed.ts) || 0,
        };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // T-跨态连线：返回影视态左侧海报的可直接用图片 URL（dataUrl）。
  // 供音乐态首页「影视空间」卡跨态展示用。同步函数，只返回 dataUrl；
  // blobDB 大图、视频、或无海报时返回空字符串（调用方会走 SVG 兜底）。
  function getVideoLeftPosterImage() {
    try {
      var p = getUserVideoPoster();
      if (!p) return '';
      // 只有小图（有 dataUrl）能直接用于 CSS background-image
      if (p.kind === 'image' && p.url) return p.url;
    } catch (e) { /* ignore */ }
    return '';
  }

  // 用户手动保存海报：更新内存缓存 + 异步写文件（持久真相）+ 同步写 localStorage（兜底兼容）
  // rec: { kind?, url?, blobKey?, name?, size?, source?, title? }  quote 始终从 posterStore 保留
  function setUserVideoPoster(rec) {
    try {
      rec = rec || {};
      var prevQuote = (posterStore && posterStore.quote) || '';
      var prevBlobKey = (posterStore && posterStore.blobKey) || '';
      var kind = rec.kind === 'video' ? 'video' : 'image';
      var nextBlobKey = rec.blobKey || '';
      var data = {
        kind: kind,
        url: rec.url || '',
        blobKey: nextBlobKey,
        name: rec.name || '',
        size: Number(rec.size) || 0,
        source: rec.source || 'custom',
        title: rec.title || '',
        quote: prevQuote,
        ts: Date.now(),
      };
      posterStore = data;
      // 若切换掉了之前的 video blobKey → 释放 IndexedDB 空间
      if (prevBlobKey && prevBlobKey !== nextBlobKey
        && (prevBlobKey === OUTER_POSTER_VIDEO_BLOB_KEY || prevBlobKey === OUTER_POSTER_MUSIC_BLOB_KEY)) {
        outerPosterBlobDelete(prevBlobKey).catch(function () { /* ignore */ });
      }
      if (kind === 'image') {
        // 图片不再需要 objectURL
        releasePosterObjectUrl();
      } else if (kind === 'video') {
        // 切了新视频 → 释放旧 objectURL，渲染时会重建
        releasePosterObjectUrl();
      }
      if (global.desktopWindow && typeof global.desktopWindow.videoPoster === 'function') {
        global.desktopWindow.videoPoster('set', data); // fire-and-forget，文件持久化
      }
      try { if (global.localStorage) global.localStorage.setItem(VIDEO_POSTER_LS_KEY, JSON.stringify(data)); } catch (e2) { /* 配额超限不影响文件存储 */ }
      return true;
    } catch (e) { return false; }
  }

  // 清掉用户手动设置的海报（缓存 + 文件 + localStorage + IndexedDB blob 四处同步）
  function clearUserVideoPoster() {
    try {
      var prevBlobKey = (posterStore && posterStore.blobKey) || '';
      posterStore = null;
      releasePosterObjectUrl();
      if (prevBlobKey === OUTER_POSTER_VIDEO_BLOB_KEY || prevBlobKey === OUTER_POSTER_MUSIC_BLOB_KEY) {
        outerPosterBlobDelete(prevBlobKey).catch(function () { /* ignore */ });
      }
      if (global.desktopWindow && typeof global.desktopWindow.videoPoster === 'function') {
        global.desktopWindow.videoPoster('clear');
      }
      try { if (global.localStorage) global.localStorage.removeItem(VIDEO_POSTER_LS_KEY); } catch (e2) { /* ignore */ }
      // 清理 #home-poster-media 内可能残留的 VIDEO 子元素
      var doc = d();
      var media = doc && doc.getElementById ? doc.getElementById('home-poster-media') : null;
      if (media) {
        var videos = media.querySelectorAll('video.sfv-poster-video-bg');
        for (var vi = 0; vi < videos.length; vi++) {
          try { videos[vi].pause(); videos[vi].removeAttribute('src'); videos[vi].load && videos[vi].load(); } catch (_ec) {}
          if (videos[vi].parentNode) videos[vi].parentNode.removeChild(videos[vi]);
        }
      }
      return true;
    } catch (e) { return false; }
  }

  // ---- T134-f：影视态独立文案（不写入音乐 store，且保存时不污染 #home-poster-media 海报图）----
  var _videoQuoteInput = null, _videoQuoteSaveBtn = null, _videoQuoteCancelBtn = null, _videoQuoteKeyHandler = null;

  function saveVideoPosterQuote(raw) {
    var next = String(raw || '').trim().slice(0, 80);
    console.log('[SFV-HOME] saveVideoPosterQuote called, raw:', JSON.stringify(next));
    if (!next) { if (typeof global.showToast === 'function') global.showToast('文案不能为空'); return; }
    try {
      if (!posterStore || typeof posterStore !== 'object') posterStore = {};
      posterStore.quote = next;
      var kind = posterStore.kind === 'video' ? 'video' : 'image';
      var data = {
        kind: kind,
        url: posterStore.url || '',
        blobKey: posterStore.blobKey || '',
        name: posterStore.name || '',
        size: Number(posterStore.size) || 0,
        source: posterStore.source || 'custom',
        title: posterStore.title || '',
        quote: next,
        ts: Date.now(),
      };
      posterStore = data; // 把缺失字段补全到内存，避免 posterStore 是老结构
      console.log('[SFV-HOME] writing to IPC + localStorage, quote:', next, 'kind:', kind);
      if (global.desktopWindow && typeof global.desktopWindow.videoPoster === 'function') {
        global.desktopWindow.videoPoster('set', data);
      }
      try { if (global.localStorage) global.localStorage.setItem(VIDEO_POSTER_LS_KEY, JSON.stringify(data)); } catch (e2) {}
    } catch (e) { console.warn('[SFV-HOME] saveVideoPosterQuote error:', e.message); }
    // 仅更新文案 DOM；绝不改写 #home-poster-media 的 --home-poster-image（海报图保持视频态）
    var quote = d() && d().getElementById ? d().getElementById('home-poster-quote') : null;
    if (quote) { quote.textContent = next; console.log('[SFV-HOME] DOM quote updated to:', next); }
    var wrap = d() && d().querySelector ? d().querySelector('.home-poster-copy') : null;
    if (wrap) wrap.classList.remove('editing');
    if (typeof global.showToast === 'function') global.showToast('影视海报文案已保存');
  }

  function restoreVideoQuoteButtons() {
    try {
      if (_videoQuoteSaveBtn) _videoQuoteSaveBtn.onclick = (typeof saveHomePosterQuote === 'function') ? saveHomePosterQuote : null;
      if (_videoQuoteCancelBtn) _videoQuoteCancelBtn.onclick = (typeof cancelHomePosterQuoteEdit === 'function') ? cancelHomePosterQuoteEdit : null;
      if (_videoQuoteInput && _videoQuoteKeyHandler) _videoQuoteInput.removeEventListener('keydown', _videoQuoteKeyHandler, true);
    } catch (e) {}
    _videoQuoteInput = _videoQuoteSaveBtn = _videoQuoteCancelBtn = _videoQuoteKeyHandler = null;
  }

  function videoSaveHandler() {
    var v = _videoQuoteInput ? _videoQuoteInput.value : '';
    saveVideoPosterQuote(v);
    restoreVideoQuoteButtons();
  }
  function videoCancelHandler() {
    if (typeof cancelHomePosterQuoteEdit === 'function') cancelHomePosterQuoteEdit();
    restoreVideoQuoteButtons();
  }

  // 复用音乐态内联编辑 UI（#home-poster-editor），但保存写入视频独立 store
  function editVideoPosterQuote() {
    var doc = d();
    if (!doc) return;
    var input = doc.getElementById('home-poster-quote-input');
    var wrap = doc.querySelector('.home-poster-copy');
    console.log('[SFV-HOME] editVideoPosterQuote called, input:', !!input, 'wrap:', !!wrap);
    if (!input || !wrap) { console.warn('[SFV-HOME] editVideoPosterQuote: missing input or wrap'); return; }
    var current = (posterStore && posterStore.quote) || '';
    input.value = current;
    wrap.classList.add('editing');
    _videoQuoteInput = input;

    // 用多种策略查找保存/取消按钮，确保绑定成功
    var actionsEl = wrap.querySelector('.home-poster-editor-actions');
    _videoQuoteSaveBtn = null;
    _videoQuoteCancelBtn = null;

    if (actionsEl) {
      // 策略1：通过 .primary class 找保存按钮
      _videoQuoteSaveBtn = actionsEl.querySelector('.primary');
      // 策略2：通过文本内容匹配（兜底）
      if (!_videoQuoteSaveBtn) {
        var btns = actionsEl.querySelectorAll('button, .home-poster-chip');
        for (var i = 0; i < btns.length; i++) {
          if ((btns[i].textContent || '').trim() === '保存') { _videoQuoteSaveBtn = btns[i]; break; }
        }
      }

      // 取消按钮：非 .primary 的按钮
      var allBtns = actionsEl.querySelectorAll('button, .home-poster-chip');
      for (var j = 0; j < allBtns.length; j++) {
        if (allBtns[j] !== _videoQuoteSaveBtn) { _videoQuoteCancelBtn = allBtns[j]; break; }
      }
    }

    console.log('[SFV-HOME] saveBtn:', !!_videoQuoteSaveBtn, 'cancelBtn:', !!_videoQuoteCancelBtn);

    if (_videoQuoteSaveBtn) {
      _videoQuoteSaveBtn.onclick = videoSaveHandler;
      // 移除可能的内联 onclick 属性（防止双触发）
      _videoQuoteSaveBtn.setAttribute('data-sfv-bound', '1');
    } else {
      console.warn('[SFV-HOME] save button NOT FOUND in editor actions!');
    }
    if (_videoQuoteCancelBtn) {
      _videoQuoteCancelBtn.onclick = videoCancelHandler;
      _videoQuoteCancelBtn.setAttribute('data-sfv-bound', '1');
    }
    _videoQuoteKeyHandler = function (e) {
      if (!e) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); videoCancelHandler(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopImmediatePropagation(); videoSaveHandler(); }
    };
    input.addEventListener('keydown', _videoQuoteKeyHandler, true);
    setTimeout(function () { try { input.focus(); input.select(); } catch (e2) {} }, 0);
  }

  // ---- T118/T119：拍音乐态基线快照（仅一次）----
  // 严格只快照"home.js 在影视态会改写"的元素，避免覆盖音乐态的动态封面（renderHomeDiscover 会自己重设）。
  // T119 扩展：必须把 .home-poster-media 的 --home-poster-image CSS 变量 / className / 内嵌默认封面 emoji 都拍下，
  //   否则影视态改了海报图后切回音乐态会残留影视海报。
  // T-#2：音乐态基线快照子系统抽到 home-snapshot.js（captureMusicDefaults/applyMusicDefaults）
  var captureMusicDefaults = function () { if (SFV.homeSnapshot && SFV.homeSnapshot.captureMusicDefaults) return SFV.homeSnapshot.captureMusicDefaults(); };
  var applyMusicDefaults = function () { if (SFV.homeSnapshot && SFV.homeSnapshot.applyMusicDefaults) return SFV.homeSnapshot.applyMusicDefaults(); };

  // 切回音乐态：先整体回滚影视态改写 → 再交还给 renderHomeDiscover 重建动态数据。
  function restoreMusic() {
    // T-双态独立海报：离开影视态时释放外层海报的 objectURL + 清理 VIDEO/IMG 内嵌媒体元素
    releasePosterObjectUrl();
    try {
      var doc = d();
      var media = doc && doc.getElementById ? doc.getElementById('home-poster-media') : null;
      if (media) {
        var nodes = media.querySelectorAll('video.sfv-poster-video-bg, img.sfv-poster-image-bg-blob');
        for (var ni = 0; ni < nodes.length; ni++) {
          try {
            if (nodes[ni].tagName === 'VIDEO') {
              nodes[ni].pause();
              nodes[ni].removeAttribute('src');
              if (nodes[ni].load) nodes[ni].load();
            } else {
              nodes[ni].removeAttribute('src');
            }
          } catch (_ex) { /* ignore */ }
          if (nodes[ni].parentNode) nodes[ni].parentNode.removeChild(nodes[ni]);
        }
        // 清理 className，回滚时让 renderHomeDiscover 重设
        media.classList.remove('sfv-poster-movie', 'has-image', 'sfv-poster-has-video');
      }
    } catch (_e) { /* ignore */ }

    captureMusicDefaults();   // 首次进入前无快照则补拍
    applyMusicDefaults();     // 整体回滚基线
    if (typeof global.renderHomeDiscover === 'function') {
      try { global.renderHomeDiscover(); } catch (e) {}
    }
    // 3D 歌单架：影视/音乐态切换时必须 rebuild，否则 currentItems 走错分支但 DOM 残留
    if (typeof global.scheduleShelfRebuild === 'function') {
      try { global.scheduleShelfRebuild('sfv-restore-music', true); } catch (e) {}
    }
    // 切回音乐态：刷新首页 Insight 卡片，触发音乐分支兜底还原，不留任何影视态文案残留（T118）
    try {
      if (typeof global.renderHomeInsightDock === 'function') global.renderHomeInsightDock();
    } catch (e) { /* 非致命 */ }
  }

  function install() {
    if (!SFV.dispatch) return;
    // T118：在 dispatch 监听 spacechange 之前先拍基线（install 阶段默认 music 态）
    captureMusicDefaults();
    SFV.dispatch.registerSlot(SLOT, { el: null, music: restoreMusic, video: render });
    if (isVideoSpace()) {
      render();
      // 启动期影视态自渲染后，补一次顶栏高亮（否则需等 goHome() 调 setActiveNav 才高亮
      // 导致「首页卡片有了但顶栏没亮 active=home」的视觉错位）。
      try {
        if (SFV.nav && typeof SFV.nav.paintActive === 'function') SFV.nav.paintActive('home');
        else if (SFV.online && typeof SFV.online.setActiveNav === 'function') SFV.online.setActiveNav('home');
      } catch (e) {}
    }
  }

  function boot() {
    // 先异步加载持久化海报（文件存储）到内存缓存，再 install/render，
    // 确保首次渲染时自定义海报已就绪；加载失败也不阻塞安装。
    loadPosterStore().then(function () {
      var doc = d();
      if (doc && doc.readyState === 'loading' && doc.addEventListener) {
        doc.addEventListener('DOMContentLoaded', install);
      } else {
        install();
      }
    }, function () {
      var doc = d();
      if (doc && doc.readyState === 'loading' && doc.addEventListener) {
        doc.addEventListener('DOMContentLoaded', install);
      } else {
        install();
      }
    });
  }
  boot();

  SFV.home = {
    render: render, restoreMusic: restoreMusic, install: install, toast: toast,
    getUrlBar: function () { return urlBar; }, setUrlBar: function (v) { urlBar = v; },
    cardDefs: cardDefs, renderContinueWatching: renderContinueWatching,
    captureMusicDefaults: captureMusicDefaults, applyMusicDefaults: applyMusicDefaults,
    renderVideoPoster: renderVideoPoster, pickVideoPoster: pickVideoPoster,
    setCardArt: setCardArt, pickLocalVideoPoster: pickLocalVideoPoster, resetVideoPoster: resetVideoPoster,
    getUserVideoPoster: getUserVideoPoster, setUserVideoPoster: setUserVideoPoster,
    clearUserVideoPoster: clearUserVideoPoster,
    getVideoLeftPosterImage: getVideoLeftPosterImage,
    editVideoPosterQuote: editVideoPosterQuote, saveVideoPosterQuote: saveVideoPosterQuote,
    // T-双态独立海报：新 API 暴露给 home-poster-render 与音乐态 bridge
    loadPosterSavedMedia: loadPosterSavedMedia,
    savePosterMediaFromPicker: savePosterMediaFromPicker,
    releasePosterObjectUrl: releasePosterObjectUrl,
    outerPosterBlobPut: outerPosterBlobPut,
    outerPosterBlobGet: outerPosterBlobGet,
    outerPosterBlobDelete: outerPosterBlobDelete,
    OUTER_POSTER_MEDIA_DB: OUTER_POSTER_MEDIA_DB,
    OUTER_POSTER_MEDIA_STORE: OUTER_POSTER_MEDIA_STORE,
    OUTER_POSTER_VIDEO_BLOB_KEY: OUTER_POSTER_VIDEO_BLOB_KEY,
    OUTER_POSTER_MUSIC_BLOB_KEY: OUTER_POSTER_MUSIC_BLOB_KEY,
    // T-跨态海报快照：state.js setSpace 钩子 + 读取
    _preCapturePosterSnapshot: _preCapturePosterSnapshot,
    getCrossPoster: getCrossPoster,
  };
})(typeof window !== 'undefined' ? window : this);
