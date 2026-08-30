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
      var snap = { cards: [], poster: null, posterMedia: null, rail: null };
      var cards = $all('#empty-home .home-grid .home-card');
      for (var i = 0; i < cards.length; i++) {
        var l = cards[i].querySelector('.home-card-label');
        var t = cards[i].querySelector('.home-card-title');
        var s = cards[i].querySelector('.home-card-sub');
        snap.cards.push({
          label: l ? l.textContent : '',
          title: t ? t.textContent : '',
          sub: s ? s.textContent : '',
          onclick: cards[i].getAttribute('onclick') || '',
        });
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
      snap.rail = {
        title: railTitle ? railTitle.textContent : '',
        note: railNote ? railNote.textContent : '',
      };
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
        cards[i].classList.remove('sfv-tile-cover', 'sfv-continue-tile', 'sfv-continue-empty');
        // T-隔离：清除影视态 setCardArt 写入的封面（如"心动"海报），
        // 否则会泄漏到音乐态"继续听/最近播放"卡片。同时清掉音乐态自身的背景缓存，
        // 强制下方 renderHomeDiscover 重新写入音乐封面。
        var cardArt = cards[i].querySelector('.home-card-art');
        if (cardArt) {
          cardArt.style.backgroundImage = '';
          cardArt.classList.remove('has-cover');
          try { delete cardArt.__homeDashboardRequestedBackground; delete cardArt.__homeDashboardBackground; } catch (e2) {}
        }
      }
      // T-隔离：移除 home-quick-grid，使后续 renderHomeDiscover → renderHomeDashboardQuickCards
      // 绕过 fingerprint 守卫重新绘制（否则音乐态数据与快照一致会 early-return，残留影视态封面）。
      var quickGrid = doc.querySelector('#empty-home .home-grid');
      if (quickGrid) quickGrid.classList.remove('home-quick-grid');
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
