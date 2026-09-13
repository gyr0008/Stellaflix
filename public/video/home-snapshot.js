/*
 * Stellaflix 影视模块 — 影视态首页音乐态基线快照子系统 (Step 3)
 *
 * 从 home.js 抽出（home.js 影视态首页拆债，目标 ≤500 行）。
 *   - captureMusicDefaults：install 阶段拍一次音乐态基线（textContent/onclick/display）
 *   - applyMusicDefaults ：切回音乐态时整体回滚基线（T118 修复，DOM 层级 100% 还原影视态改写）
 *
 * 状态归属：MUSIC_SNAP_KEY / musicSnap 为本模块自有状态（原 home.js 闭包变量已迁出）。
 * 共享状态桥接：urlBar 仍属 home.js（与 toggleUrlBar/ensureBackBtn/hideBackBtn 共享），
 *   本模块经 SFV.home.getUrlBar()/setUrlBar() 访问器读写，避免外部化 home.js 闭包可变状态。
 * 依赖：global.document（运行期）；SFV.home 访问器（运行期引用，本文件仅定义、不调用）。
 * 加载顺序：须晚于 home-core.js，早于 home.js（home.js 经 SFV.homeSnapshot 委托调用）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // 音乐态基线快照 key（与 home.js 历史约定保持一致的全局暴露，便于测试/DevTools 排查）
  var MUSIC_SNAP_KEY = '__sfv_music_home_snapshot__';
  var musicSnap = null;

  function d() { return global.document; }
  function $all(sel) {
    var doc = d();
    if (!doc || !doc.querySelectorAll) return [];
    return Array.prototype.slice.call(doc.querySelectorAll(sel));
  }

  // ---- T118：拍摄音乐态基线 ----
  function captureMusicDefaults() {
    if (musicSnap) return;
    var doc = d();
    if (!doc || !doc.querySelector) return;
    try {
      // 启动默认空间=影视时，音乐模块链可能已把 5 卡预写成影视文案。
      // 此时不能拿当前 DOM 当「音乐基线」，否则切回音乐会还原成影视文案。
      var startVideo = false;
      try {
        startVideo = doc.documentElement.classList.contains('video-space-active')
          || (doc.body && doc.body.classList.contains('video-space-active'))
          || (global.localStorage && global.localStorage.getItem('stellaflix-start-space') === 'video');
      } catch (_se) { }
      var snap = { cards: [], poster: null, posterMedia: null, rail: null };
      var cards = $all('#empty-home .home-grid .home-card');
      // 与 index.html 静态音乐 home 一致的基线（预写影视壳之前的原文案）
      var musicHtmlDefaults = [
        { label: 'CONTINUE', title: '继续播放', sub: '从当前队列或最近播放继续', onclick: 'resumeHomeDashboardPlayback()' },
        { label: 'LIBRARY', title: '音乐库', sub: '歌单、本地音乐和已登录平台', onclick: 'openHomeDashboardLibrary()' },
        { label: 'DAILY MIX', title: '每日推荐', sub: '使用当前 Stellaflix 推荐数据', onclick: 'playHomeDaily()' },
        { label: 'RECENT', title: '最近播放', sub: '播放过的歌曲会出现在这里', onclick: 'playHomeRecent()' },
        { label: 'Video', title: '影视空间', sub: '搜索 / 播放影片', onclick: "if(window.StellaflixVideo&&StellaflixVideo.state)StellaflixVideo.state.setSpace('video')" }
      ];
      for (var i = 0; i < cards.length; i++) {
        var l = cards[i].querySelector('.home-card-label');
        var t = cards[i].querySelector('.home-card-title');
        var s = cards[i].querySelector('.home-card-sub');
        if (startVideo && i < musicHtmlDefaults.length) {
          var md = musicHtmlDefaults[i];
          snap.cards.push({
            label: md.label,
            title: md.title,
            sub: md.sub,
            onclick: md.onclick,
          });
        } else {
          snap.cards.push({
            label: l ? l.textContent : '',
            title: t ? t.textContent : '',
            sub: s ? s.textContent : '',
            onclick: cards[i].getAttribute('onclick') || '',
          });
        }
      }
      var posterTitle = doc.querySelector('#empty-home .home-poster-title');
      var posterQuote = doc.getElementById('home-poster-quote');
      snap.poster = {
        title: posterTitle ? posterTitle.textContent : '',
        quote: posterQuote ? posterQuote.textContent : '',
      };
      // T119：拍 .home-poster-media 的完整状态
      var media = doc.getElementById('home-poster-media');
      if (media) {
        snap.posterMedia = {
          className: media.className || '',
          cssVar: media.style.getPropertyValue('--home-poster-image') || '',
          inlineBg: media.style.backgroundImage || '',
          inlineStyle: media.getAttribute('style') || '',
          innerHTML: media.innerHTML,
          // 拍下影视态注入的 default-cover 类，便于回滚时识别
        };
      }
      var railTitle = doc.getElementById('home-rail-title');
      var railNote = doc.getElementById('home-rail-note');
      if (startVideo) {
        // 预写壳已改过 rail 文案，基线用空/音乐默认，切回时由 renderHomeDiscover 重建
        snap.rail = { title: '', note: '' };
      } else {
        snap.rail = {
          title: railTitle ? railTitle.textContent : '',
          note: railNote ? railNote.textContent : '',
        };
      }
      musicSnap = snap;
      // 暴露给测试 / DevTools 排查
      try { global[MUSIC_SNAP_KEY] = snap; } catch (e) {}
    } catch (e) {
      console.warn('[SFV-HOME] captureMusicDefaults failed:', e);
    }
  }

  // ---- T118：回滚音乐态基线（DOM 层级 100% 还原影视态改写）----
  function applyMusicDefaults() {
    var doc = d();
    if (!doc) return;
    var snap = musicSnap || global[MUSIC_SNAP_KEY];
    if (!snap) return;
    try {
      // 1) 还原 5 张 home-card 的 label/title/sub/onclick
      var cards = $all('#empty-home .home-grid .home-card');
      for (var i = 0; i < cards.length && i < snap.cards.length; i++) {
        var def = snap.cards[i];
        var l = cards[i].querySelector('.home-card-label');
        var t = cards[i].querySelector('.home-card-title');
        var s = cards[i].querySelector('.home-card-sub');
        if (l) l.textContent = def.label;
        if (t) t.textContent = def.title;
        if (s) s.textContent = def.sub;
        if (def.onclick) cards[i].setAttribute('onclick', def.onclick);
        else cards[i].removeAttribute('onclick');
        cards[i].style.display = '';
        // 清掉影视态可能写入的 data-sfv-key（home-tile-row 才用，home-card 上不会有，但保险起见）
        cards[i].removeAttribute('data-sfv-key');
        cards[i].removeAttribute('data-sfv-id');
        // 清掉影视态 setCardText 之外的 class 影响
        var isVideoTile = cards[i].classList.contains('sfv-tile-cover')
          || cards[i].classList.contains('sfv-continue-tile')
          || cards[i].classList.contains('sfv-continue-empty');
        cards[i].classList.remove('sfv-tile-cover', 'sfv-continue-tile', 'sfv-continue-empty');
        // FIX-v3: 不再盲目清除 5 张卡的所有封面。
        // 旧逻辑（全清）的致命缺陷：
        //   ① CONTINUE/LIBRARY/RECENT 等音乐态本就有正确封面的卡片也被一起清 DOM。
        //   ② 清完后同步帧 renderHomeDashboardQuickCards 立即 patchCard，但
        //      CONTINUE 依赖 homeDashboardCurrentSong()/recent、LIBRARY 依赖 localSongs、
        //      RECENT 依赖 recent.cover —— 切态瞬间这些值未必就绪 → cover=''
        //      → displayCover 走 homeDashboardGeneratedCover → 写入蓝色圆盘 SVG。
        //   ③ 异步 loadHomeDiscover 返回后，CONTINUE/LIBRARY/RECENT/VIDEO 的 cover
        //      字段仍然空（它们不来自 homeDiscoverState.songs）→ 再次 patch 依然蓝色圆盘。
        // 新逻辑（精准清）：只清「有影视态标记」的卡片（sfv-tile-cover / sfv-continue-tile）。
        //   这些卡片的封面确实是影视态 setCardArt 写入的（如"心动"海报），必须清防泄漏。
        //   其他音乐态本来就有的卡片，DOM 里保留上一次的真实封面 ——
        //   即使同步帧 patchCard 再次写入 cover='' 对应的蓝色圆盘，也至少有
        //   「旧 DOM cover 在 → patchCard 尝试写新值」的竞争。
        //   更进一步：下方 renderHomeDashboardQuickCards 中已经为 cover 为空的卡
        //   添加了从 homeDiscoverState.songs 兜底取 cover 的逻辑，双保险。
        // 双态独立（防串扰）：切回音乐态时，对五张 home-card 无条件失效
        // 音乐态 homeDashboardSetStableBackgroundImage 的去重守卫字段。
        // 不清 style.backgroundImage（避免视觉闪烁为蓝色圆盘），仅让守卫失效，
        // 这样随后 renderHomeDashboardQuickCards 的 patch 能真正写入正确的音乐态封面，
        // 而不会被 "__homeDashboardRequestedBackground === 音乐cover" 的去重逻辑跳过，
        // 从而杜绝影视态海报残留在音乐态。
        var cardArt = cards[i].querySelector('.home-card-art');
        if (cardArt) {
          try { delete cardArt.__homeDashboardRequestedBackground; delete cardArt.__homeDashboardBackground; } catch (e2) {}
          // isVideoTile（接着看 tile）才清 style，保留原逻辑；
          // 五张 home-card 不清 style，留给音乐态 patch 覆盖，避免蓝色圆盘闪烁。
          if (isVideoTile) {
            cardArt.style.backgroundImage = '';
            cardArt.classList.remove('has-cover');
          }
        }
      }
      // T-隔离：不再移除 home-quick-grid 类，确保 5 列布局不会因切态失效。
      // 原先设计：移除类使 renderHomeDashboardQuickCards 绕过 fingerprint 守卫重绘。
      // 副作用：一旦 remove 之后由于时序/守卫条件未重新 add，容器永久回退到 2 列布局。
      // 替代方案：在 renderHomeDashboardQuickCards 入口自行处理 fingerprint 失效 + 强制确保 home-quick-grid 类。
      // 2) 还原 home-poster-title / home-poster-quote
      if (snap.poster) {
        var posterTitle = doc.querySelector('#empty-home .home-poster-title');
        var posterQuote = doc.getElementById('home-poster-quote');
        if (posterTitle) posterTitle.textContent = snap.poster.title;
        if (posterQuote) posterQuote.textContent = snap.poster.quote;
      }
      // 2.5) T119：还原 .home-poster-media（海报图/CSS变量/默认封面class）
      var mediaNode = doc.getElementById('home-poster-media');
      if (mediaNode && snap.posterMedia) {
        // 完全恢复快照，包括 className / 内嵌 style / innerHTML
        // 但用最稳的方式：先清掉所有可能加上的类，再恢复内联 style
        mediaNode.className = snap.posterMedia.className;
        if (snap.posterMedia.inlineStyle) {
          mediaNode.setAttribute('style', snap.posterMedia.inlineStyle);
        } else {
          mediaNode.removeAttribute('style');
        }
        mediaNode.innerHTML = snap.posterMedia.innerHTML;
        // 保险：再 setProperty 一遍 --home-poster-image（setAttribute('style') 应已覆盖）
        if (snap.posterMedia.cssVar) {
          mediaNode.style.setProperty('--home-poster-image', snap.posterMedia.cssVar);
        } else {
          mediaNode.style.removeProperty('--home-poster-image');
        }
        // 兜底：清掉影视态可能注入的 default-cover 类（即便 className 已恢复）
        mediaNode.classList.remove('sfv-poster-default', 'sfv-poster-movie');
      }
      // 3) 还原 home-rail-title / home-rail-note 文案（内容由 renderHomeTiles 重建）
      if (snap.rail) {
        var railTitle = doc.getElementById('home-rail-title');
        var railNote = doc.getElementById('home-rail-note');
        if (railTitle) railTitle.textContent = snap.rail.title;
        if (railNote) railNote.textContent = snap.rail.note;
      }
      // 4) 清空 home.js renderContinueWatching 注入的 5 张"接着看"tile
      var row = doc.getElementById('home-tile-row');
      if (row) {
        row.innerHTML = '';
        try { delete row._homeTiles; } catch (e) { row._homeTiles = null; }
      }
      // 5) 移除 TMDB 署名（影视态添加）
      var attrib = doc.getElementById('sfv-tmdb-attrib');
      if (attrib && attrib.parentNode) attrib.parentNode.removeChild(attrib);
      // 6) 隐藏"返回音乐"按钮（影视态添加）
      var back = doc.getElementById('sfv-back-to-music');
      if (back) back.style.display = 'none';
      // 7) 移除 urlBar（影视态添加）—— urlBar 为 home.js 共享状态，经访问器桥接
      var ub = (SFV.home && typeof SFV.home.getUrlBar === 'function') ? SFV.home.getUrlBar() : null;
      if (ub && ub.parentNode) {
        ub.parentNode.removeChild(ub);
        if (SFV.home && typeof SFV.home.setUrlBar === 'function') SFV.home.setUrlBar(null);
      }
    } catch (e) {
      console.warn('[SFV-HOME] applyMusicDefaults failed:', e);
    }
  }

  SFV.homeSnapshot = {
    captureMusicDefaults: captureMusicDefaults,
    applyMusicDefaults: applyMusicDefaults,
  };
})(typeof window !== 'undefined' ? window : this);
