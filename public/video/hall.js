/*
 * Stellaflix 影视模块 — 浏览厅 (hall) 编排
 *
 * 入口：影视首页「心动」卡 → SFV.hall.enter()。
 * 渲染：SFV.coverFlow（纯 CSS 3D，移植自 cover-flow-showcase），不依赖 Three.js。
 * 布局：3D 卡片区(stage) + 一句描述(desc) + 底部玻璃胶囊控制栏(dock)。
 * 控制栏 7 控件：◀上一个 / 分类切换(纯文字单按钮循环) / 沉浸切换(空壳) / ▶播放 / 追片(纯图标) / 收藏(纯图标＋) / ▶下一个。
 * ESC：弹窗开则先关弹窗，否则退厅（还原音乐架）。
 *
 * 铁律：零业务逻辑进 index.html；本模块仅提供 SFV.hall.* 与最小 DOM/事件接线。
 * 单文件 ≤ 500 行。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // ---- 分类（映射 TMDB 加载器）----
  // TMDB genre IDs: 16=Animation(动画), 99=Documentary(纪录片)
  // "电影"分类排除动画(genre 16)，避免 popular 返回的热门动画混入。
  var CATEGORIES = [
    { key: 'movie',       label: '电影',   icon: '🎬', loader: function (p) { return SFV.tmdb.popular('movie', p).then(function (arr) { return (arr || []).filter(function (it) { return !(it.genreIds && it.genreIds.indexOf(16) >= 0); }); }); } },
    { key: 'documentary', label: '纪录片', icon: '🎞', loader: function (p) { return SFV.tmdb.discover({ with_genres: '99', sort_by: 'popularity.desc', page: p }); } },
    { key: 'animation',   label: '动画',   icon: '✏', loader: function (p) { return SFV.tmdb.discover({ with_genres: '16', sort_by: 'popularity.desc', page: p }); } },
    { key: 'anime',       label: '动漫',   icon: '🌸', loader: function (p) { return SFV.tmdb.popular('anime', p); } }
  ];

  // ---- 图标工具 ----
  function _mi(p) {
    return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="' + p + '"/></svg>';
  }
  // 详情页/心动页共用的播放按钮图标（用户要求统一的玻璃风描边水滴箭头）
  var ICON_PLAY_ARROW = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 11.9997V9.32968C6 6.01968 8.35 4.65968 11.22 6.31968L13.53 7.65968L15.84 8.99968C18.71 10.6597 18.71 13.3697 15.84 15.0297L13.53 16.3697L11.22 17.7097C8.35 19.3397 6 17.9897 6 14.6697V11.9997Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_SKIP_NEXT = _mi('M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z');
  // 心动页「上一个 / 下一个」按钮图标（用户指定的描边箭头）
  var ICON_PREV = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 19.9201L8.47997 13.4001C7.70997 12.6301 7.70997 11.3701 8.47997 10.6001L15 4.08008" stroke="#ffffff" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_NEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8.90991 19.9201L15.4299 13.4001C16.1999 12.6301 16.1999 11.3701 15.4299 10.6001L8.90991 4.08008" stroke="#ffffff" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // 收藏图标（与详情/播放器收藏按钮一致：stroke 风格 ＋）
  var ICON_ADD = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  // ---- 追片状态（全面复制视频播放器底部控制栏 heart-btn）----
  // 状态/图标/标签全部取自 SFV.model，与 player-controller.js 保持一致。
  var HEART_STATES = [null, 'watching', 'planToWatch', 'onHold', 'watched', 'abandoned'];
  function trackKey(item) { return item && (item.key || item.id) ? String(item.key || item.id) : ''; }
  function getTrackIconHtml(status) {
    var map = (SFV.model && SFV.model.STATE_ICONS) || {};
    var icon = map[status || 'none'] || '';
    return '<span class="sfv-track-icon">' + icon + '</span>';
  }
  function getTrackLabel(status) {
    var labels = (SFV.model && SFV.model.TRACK_LABELS) || {};
    return labels[status] || '未追';
  }

  // ---- 状态 ----
  var active = false;
  var root = null;          // .sfv-hall 根
  var stageEl = null;       // .sfv-hall-stage（cover-flow 挂载）
  var descEl = null;        // .sfv-hall-desc
  var dockEl = null;        // .sfv-hall-dock
  var followBtn = null;
  var catBtn = null;        // 分类切换按钮（纯文字，单按钮循环切换）
  var listBtn = null;       // 收藏（片单）按钮（纯图标 add ＋，与播放器收藏一致）
  var statusEl = null;
  var prevShelfMode = null;
  var keyHandler = null;
  var curCategory = CATEGORIES[0].key;
  var curItem = null;

  function d() { return global.document; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isVideo() { return !!(SFV.state && SFV.state.isVideo && SFV.state.isVideo()); }

  function toast(msg) {
    var doc = d(); if (!doc) return;
    var t = doc.createElement('div');
    t.className = 'sfv-toast'; t.textContent = msg;
    (doc.body || doc.documentElement).appendChild(t);
    global.setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
  }
  function showStatus(msg) {
    var doc = d(); if (!doc) return;
    if (!statusEl) {
      statusEl = doc.createElement('div');
      statusEl.className = 'sfv-hall-status';
      (doc.body || doc.documentElement).appendChild(statusEl);
    }
    statusEl.textContent = msg; statusEl.classList.add('show');
  }
  function hideStatus() { if (statusEl) statusEl.classList.remove('show'); }

  // 防御性清理：若旧 root 仍在 DOM（异常重入/未完整 exit），先移除再重建
  function destroyDom() {
    if (keyHandler && global.removeEventListener) {
      global.removeEventListener('keydown', keyHandler, true);
      keyHandler = null;
    }
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null; stageEl = null; descEl = null; dockEl = null;
    followBtn = null; catBtn = null; listBtn = null;
  }

  // ---- 构建 DOM ----
  function build() {
    destroyDom(); // 防止 build 被重复调用导致多重 dock
    var doc = d();
    root = doc.createElement('div');
    root.className = 'sfv-hall';
    root.setAttribute('aria-hidden', 'false');

    // 3D 卡片区
    stageEl = doc.createElement('div');
    stageEl.className = 'sfv-hall-stage';
    root.appendChild(stageEl);

    // 一句描述
    descEl = doc.createElement('div');
    descEl.className = 'sfv-hall-desc';
    root.appendChild(descEl);

    // 底部玻璃胶囊控制栏
    dockEl = doc.createElement('div');
    dockEl.className = 'sfv-hall-dock';

    var prev = dockBtn(ICON_PREV, '上一个', function () { if (SFV.coverFlow) SFV.coverFlow.prev(); });
    dockEl.appendChild(prev);

    // 分类切换（单按钮纯文字，点击循环切换分类；激活态与「追片」按钮一致）
    catBtn = doc.createElement('button');
    catBtn.type = 'button';
    catBtn.className = 'sfv-hall-dock-btn sfv-hall-cat-btn';
    catBtn.addEventListener('click', function () { cycleCategory(); });
    dockEl.appendChild(catBtn);

    // 沉浸切换（空壳：toggle 隐藏 desc+dock）
    var immer = dockBtn('⟲', '沉浸模式', function () {
      if (global.document && global.document.body) {
        global.document.body.classList.toggle('sfv-hall-immersive');
      }
    });
    dockEl.appendChild(immer);

    // ▶ 开始播放
    var play = dockBtn(ICON_PLAY_ARROW, '播放', function () { if (curItem) openPoster(curItem); });
    dockEl.appendChild(play);

    // ❤ 追片状态
    followBtn = doc.createElement('button');
    followBtn.type = 'button';
    followBtn.className = 'sfv-hall-dock-btn sfv-hall-follow';
    followBtn.addEventListener('click', onFollowClick);
    dockEl.appendChild(followBtn);

    // ＋ 收藏（全面复制播放器底部控制栏 collect-btn：打开「收藏到片单」弹窗）
    var list = doc.createElement('button');
    list.type = 'button';
    list.className = 'sfv-hall-dock-btn sfv-hall-collect';
    list.title = '收藏到片单';
    list.setAttribute('aria-label', '收藏到片单');
    list.innerHTML = ICON_ADD;
    list.addEventListener('click', onCollectClick);
    dockEl.appendChild(list);
    listBtn = list;

    var next = dockBtn(ICON_NEXT, '下一个', function () { if (SFV.coverFlow) SFV.coverFlow.next(); });
    dockEl.appendChild(next);

    root.appendChild(dockEl);
    (doc.body || doc.documentElement).appendChild(root);
  }

  function dockBtn(icon, label, handler) {
    var doc = d();
    var b = doc.createElement('button');
    b.type = 'button';
    b.className = 'sfv-hall-dock-btn';
    b.setAttribute('aria-label', label);
    b.title = label;
    // icon 可能是文本字符（◀/▶/⟲）或 SVG HTML（播放按钮），按内容自动路由避免 XSS 风险
    if (typeof icon === 'string' && icon.indexOf('<') !== -1) {
      b.innerHTML = icon;
    } else {
      b.textContent = icon;
    }
    b.addEventListener('click', handler);
    return b;
  }

  function setActiveTab(key) {
    if (catBtn) {
      var cat = null;
      for (var j = 0; j < CATEGORIES.length; j++) {
        if (CATEGORIES[j].key === key) { cat = CATEGORIES[j]; break; }
      }
      if (cat) {
        catBtn.textContent = cat.label;
        catBtn.title = '当前分类：' + cat.label + '（点击切换）';
        catBtn.classList.add('on'); // 始终高亮当前分类，与「追片」按钮激活态一致
      }
    }
  }

  // 单按钮循环切换分类：电影 → 纪录片 → 动画 → 动漫 → 电影…
  function cycleCategory() {
    var n = CATEGORIES.length, i = 0;
    for (var j = 0; j < n; j++) { if (CATEGORIES[j].key === curCategory) { i = j; break; } }
    var next = CATEGORIES[(i + 1) % n];
    setTab(next.key);
  }

  // 高分评论缓存 + 防抖（避免快速滑动频繁请求 / 重复请求）
  var reviewCache = {};
  var reviewTimer = null;

  // 同步渲染：中英文双标题（即时）+ 评论占位，再异步补高分评论
  function updateDesc(item) {
    curItem = item;
    if (!descEl) return;
    if (reviewTimer) { clearTimeout(reviewTimer); reviewTimer = null; }
    if (!item) { descEl.innerHTML = ''; return; }

    var title = esc(item.title || '');
    var ot = item.originalTitle || '';
    var html = '<div class="sfv-hall-desc-title">' + title + '</div>';
    if (ot && ot !== (item.title || '')) {
      html += '<div class="sfv-hall-desc-ot">' + esc(ot) + '</div>';
    }
    html += '<div class="sfv-hall-desc-review" data-state="loading">加载高分评论…</div>';
    descEl.innerHTML = html;
    updateFollowBtn(item);

    // 异步拉高分评论（防抖 180ms，避免快速滑动频繁请求）
    var rid = (item.id || '') + '|' + (item.mediaType || '');
    reviewTimer = setTimeout(function () { loadHighScoreReview(item, rid); }, 180);
  }

  // 高分评论：路线1 豆瓣（优先）→ 路线2 TMDB 直连评论（兜底）→ 最终降级 overview
  function loadHighScoreReview(item, rid) {
    var reviewEl = descEl && descEl.querySelector('.sfv-hall-desc-review');
    if (!reviewEl) return;

    // 命中缓存（同一卡片不重复请求）
    if (reviewCache[rid]) {
      paintReview(reviewEl, reviewCache[rid].review, reviewCache[rid].source);
      return;
    }

    reviewEl.setAttribute('data-state', 'loading');
    reviewEl.textContent = '加载高分评论…';

    var doubanP;
    if (SFV.tmdb && SFV.tmdb.getExternalIds) {
      doubanP = SFV.tmdb.getExternalIds(item.id, item.mediaType).then(function (ext) {
        var imdb = ext && ext.imdbId;
        if (!imdb && !item.title) throw new Error('NO_KEY');
        var q = imdb
          ? ('?imdb=' + encodeURIComponent(imdb))
          : ('?title=' + encodeURIComponent(item.title) + (item.year ? '&year=' + encodeURIComponent(item.year) : ''));
        var ctrl = new AbortController();
        var to = setTimeout(function () { ctrl.abort(); }, 6000);
        return fetch('/api/douban' + q, { signal: ctrl.signal })
          .then(function (r) { clearTimeout(to); if (!r.ok) throw new Error('HTTP_' + r.status); return r.json(); })
          .then(function (j) {
            if (j && j.ok && j.comments && j.comments.length) {
              var r0 = j.comments[0];
              return { review: { content: r0.content, rating: r0.rating }, source: 'douban' };
            }
            throw new Error('DOUBAN_EMPTY');
          });
      }).catch(function () { return null; });
    } else {
      doubanP = Promise.resolve(null);
    }

    doubanP.then(function (doubanRes) {
      if (doubanRes) {
        reviewCache[rid] = doubanRes;
        paintReview(reviewEl, doubanRes.review, doubanRes.source);
        return;
      }
      // 路线2：TMDB 直连评论兜底
      if (SFV.tmdb && SFV.tmdb.getReviews && item.id) {
        return SFV.tmdb.getReviews(item.id, item.mediaType).then(function (list) {
          var scored = (list || []).filter(function (x) { return x.content; });
          scored.sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); });
          if (scored.length) {
            var t = scored[0];
            var res = { review: { content: t.content, rating: t.rating }, source: 'tmdb' };
            reviewCache[rid] = res;
            paintReview(reviewEl, res.review, res.source);
          } else {
            fallbackOverview(reviewEl, item);
          }
        }).catch(function () { fallbackOverview(reviewEl, item); });
      }
      fallbackOverview(reviewEl, item);
    }).catch(function () { fallbackOverview(reviewEl, item); });
  }

  function paintReview(el, r, source) {
    if (!el) return;
    var text = (r && r.content) || '';
    if (text.length > 80) text = text.slice(0, 79) + '…';
    var star = (r && r.rating != null) ? ('　' + r.rating + '★') : '';
    el.setAttribute('data-state', 'done');
    // 不显示任何来源标签（豆瓣 / TMDB 均隐藏），仅渲染评论文本
    el.innerHTML = '<span class="sfv-hall-desc-review-text">' + esc(text) + star + '</span>';
  }

  function fallbackOverview(el, item) {
    if (!el) return;
    var ov = (item.overview || '').trim();
    if (ov.length > 80) ov = ov.slice(0, 79) + '…';
    el.setAttribute('data-state', 'done');
    el.innerHTML = '<span class="sfv-hall-desc-review-text">' + esc(ov || '暂无简介') + '</span>';
  }

  function updateFollowBtn(item) {
    if (!followBtn || !item) return;
    var key = trackKey(item);
    var status = (key && SFV.model && typeof SFV.model.getTrackStatus === 'function') ? SFV.model.getTrackStatus(key) : null;
    var label = getTrackLabel(status);
    // 纯图标 + 状态提示，与播放器底部 heart-btn 完全一致
    followBtn.innerHTML = getTrackIconHtml(status);
    followBtn.title = '追片：' + label;
    followBtn.setAttribute('aria-label', '追片：' + label);
    followBtn.classList.toggle('on', !!status);
  }

  function onFollowClick(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!curItem) return;
    var key = trackKey(curItem);
    if (!key || !SFV.model || typeof SFV.model.getTrackStatus !== 'function' || typeof SFV.model.setTrackStatus !== 'function') return;
    var status = SFV.model.getTrackStatus(key);
    var idx = HEART_STATES.indexOf(status);
    var next = HEART_STATES[(idx + 1) % HEART_STATES.length];
    SFV.model.setTrackStatus(key, next);
    // 加入追片（有效状态）时同步把元数据 + 海报本地缓存，与取消清理形成闭环
    if (next && SFV.model.setMeta && curItem) {
      SFV.model.setMeta({ key: key, title: curItem.title, pic: curItem.poster, year: curItem.year });
    }
    updateFollowBtn(curItem);
    var label = getTrackLabel(next);
    toast('已设为：' + label);
  }

  // 收藏：打开与播放器底部控制栏完全相同的「收藏到片单」弹窗
  function onCollectClick(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!curItem) return;
    if (SFV.playerCollect && typeof SFV.playerCollect.open === 'function') {
      SFV.playerCollect.open(curItem);
    } else if (global.openCollectModalForCurrent) {
      global.openCollectModalForCurrent();
    } else {
      toast('收藏功能不可用');
    }
  }

  // ---- 进入 / 退出 ----
  function enter() {
    if (active) return;
    if (!isVideo() && SFV.state && SFV.state.setSpace) SFV.state.setSpace('video');
    active = true;

    if (global.shelfManager && global.shelfManager.getMode) {
      try { prevShelfMode = global.shelfManager.getMode(); } catch (e) { prevShelfMode = 'stage'; }
    }
    if (global.setShelfMode) { try { global.setShelfMode('off'); } catch (e) {} }

    destroyDom(); // 进入前强制清理旧 DOM，防止任何残留导致双重 dock
    build();
    setActiveTab(curCategory);
    if (global.document && global.document.body) global.document.body.classList.add('sfv-hall-active');

    if (SFV.coverFlow && SFV.coverFlow.mount) {
      SFV.coverFlow.mount(stageEl, {
        loadItems: function (p) { return CATEGORIES.filter(function (c) { return c.key === curCategory; })[0].loader(p); },
        onSelect: function (item) { openPoster(item); },
        onActiveChange: function (item) { updateDesc(item); }
      });
    }

    keyHandler = function (e) {
      if (!e) return;
      if (e.key === 'Escape' || e.keyCode === 27) {
        // 优先关闭已打开的弹窗：收藏面板 > 多源选择面板，最后才退厅
        if (SFV.playerCollect && typeof SFV.playerCollect.isOpen === 'function' && SFV.playerCollect.isOpen()) {
          SFV.playerCollect.close();
        } else if (SFV.sourcePicker && SFV.sourcePicker.isOpen && SFV.sourcePicker.isOpen()) {
          SFV.sourcePicker.close();
        } else {
          exit();
        }
      }
    };
    if (global.addEventListener) global.addEventListener('keydown', keyHandler, true);
  }

  function exit() {
    if (!active) return;
    // 连线：保存当前中心海报到 localStorage → 首页心动卡右侧展示
    if (curItem && curItem.poster) {
      try {
        global.localStorage.setItem('stellaflix:hall:lastPoster', JSON.stringify({
          poster: curItem.poster,
          title: curItem.title || '',
          id: curItem.id || '',
          ts: Date.now()
        }));
      } catch (e) {}
    }
    active = false;
    if (SFV.coverFlow && SFV.coverFlow.destroy) SFV.coverFlow.destroy();
    if (SFV.sourcePicker && SFV.sourcePicker.isOpen && SFV.sourcePicker.isOpen()) SFV.sourcePicker.close();
    if (global.setShelfMode) { try { global.setShelfMode(prevShelfMode || 'stage'); } catch (e) {} }
    if (global.scheduleShelfRebuild) { try { global.scheduleShelfRebuild('sfv-hall-exit', true); } catch (e) {} }
    if (global.document && global.document.body) {
      global.document.body.classList.remove('sfv-hall-active');
      global.document.body.classList.remove('sfv-hall-immersive');
    }
    destroyDom();
  }

  function setTab(key) {
    curCategory = key;
    setActiveTab(key);
    if (SFV.coverFlow && SFV.coverFlow.destroy) SFV.coverFlow.destroy();
    if (stageEl && SFV.coverFlow && SFV.coverFlow.mount) {
      SFV.coverFlow.mount(stageEl, {
        loadItems: function (p) { return CATEGORIES.filter(function (c) { return c.key === key; })[0].loader(p); },
        onSelect: function (item) { openPoster(item); },
        onActiveChange: function (item) { updateDesc(item); }
      });
    }
  }

  // ---- 点海报：并行搜 CMS10 + Kazumi → 单源直播 / 多源弹窗 / 无果 toast ----
  function openPoster(item) {
    if (!item) return;
    var title = (item.title || '').trim();
    if (!title) { toast('该影片缺少标题，无法搜索播放源'); return; }
    showStatus('正在搜索播放源：' + title);
    var cmsP = (SFV.sources && SFV.sources.search) ? SFV.sources.search(title, { timeout: 12000 }) : Promise.resolve({ items: [], errors: [], noSource: true });
    var kzP = (SFV.kazumi && SFV.kazumi.search) ? SFV.kazumi.search(title) : Promise.resolve({ items: [], errors: [] });
    Promise.all([cmsP, kzP]).then(function (arr) {
      var cms = arr[0] || { items: [] };
      var kz = arr[1] || { items: [] };
      var candidates = [];
      (cms.items || []).forEach(function (it) {
        var variants = (it.variants && it.variants.length) ? it.variants : [it];
        variants.forEach(function (v) {
          candidates.push({
            id: 'cms:' + (v.sourceId || '') + ':' + (v.vodId || ''),
            label: (v.sourceName || v.sourceId || 'CMS') + (v.remarks ? ' · ' + v.remarks : ''),
            sub: it.title + (it.year ? ' (' + it.year + ')' : ''),
            title: it.title || '',
            kind: 'cms', group: (v.sourceName || v.sourceId || 'CMS'), _ref: v
          });
        });
      });
      (kz.items || []).forEach(function (it) {
        candidates.push({
          id: 'kz:' + (it.ruleName || '') + ':' + (it.src || ''),
          label: (it.ruleName || 'Kazumi'),
          sub: it.title || title,
          title: it.title || title,
          kind: 'kazumi', group: (it.ruleName || 'Kazumi'), _ref: it
        });
      });
      // 方案 C：收敛到与所点影片真正相关的候选（先严格匹配，无果再宽松 Top N），
      // 避免弹窗混入「请以你的名字呼唤我」等子串命中但无关的源。
      if (SFV.SearchFilterCore && SFV.SearchFilterCore.filterCandidatesForQuery) {
        candidates = SFV.SearchFilterCore.filterCandidatesForQuery(candidates, title, { topN: 8 });
      }
      if (!candidates.length) { hideStatus(); toast('未找到「' + title + '」的可用播放源'); return; }
      if (candidates.length === 1) { playCandidate(candidates[0], item); return; }
      hideStatus();
      if (SFV.sourcePicker && SFV.sourcePicker.open) {
        SFV.sourcePicker.open({ title: title, poster: item.poster, candidates: candidates, onPick: function (c) { playCandidate(c, item); } });
      } else { playCandidate(candidates[0], item); }
    }).catch(function (err) {
      hideStatus(); toast('搜索播放源出错：' + (err && err.message ? err.message : '未知错误'));
    });
  }

  // ---- 候选 → 解析剧集 → playEpisode（播放前退厅）----
  function playCandidate(c, item) {
    if (!c) return;
    hideStatus();
    if (c.kind === 'kazumi') {
      var ref = c._ref;
      toast('正在解析 Kazumi 源…');
      if (!SFV.kazumi || !SFV.kazumi.getChapters) { toast('Kazumi 不可用'); return; }
      SFV.kazumi.getChapters(ref.ruleName, ref.src).then(function (res) {
        var plays = (res && res.plays) || [];
        var chosen = plays[0];
        var episodes = (chosen && chosen.episodes) || [];
        if (!episodes.length) { toast('该源无可播放剧集'); return; }
        var view = {
          key: 'kazumi:' + (ref.ruleName || '') + ':' + (ref.src || ''),
          title: (item && item.title) || ref.title || c.label,
          pic: (item && item.poster) || ref.pic || '',
          year: (item && item.year) || '',
          source: { id: 'kazumi:' + (ref.ruleName || ''), name: ref.ruleName || 'Kazumi' },
          vodId: ref.src, isKazumi: true, ruleName: ref.ruleName
        };
        doPlay(view, episodes[0], episodes);
      }).catch(function (e) { toast('Kazumi 解析失败：' + (e && e.message ? e.message : '')); });
    } else {
      var v = c._ref;
      toast('正在获取播放地址…');
      if (!SFV.sources || !SFV.sources.detail) { toast('CMS 不可用'); return; }
      SFV.sources.detail(v.sourceId, v.vodId).then(function (res) {
        if (!res || !res.ok || !res.plays || !res.plays.length) { toast('该源无播放地址'); return; }
        var view = {
          key: (v.sourceId || '?') + ':' + (v.vodId || ''),
          title: (item && item.title) || v.title || c.label,
          pic: (item && item.poster) || v.pic || '',
          year: (item && item.year) || v.year || '',
          source: { id: v.sourceId, name: v.sourceName }, vodId: v.vodId
        };
        doPlay(view, res.plays[0], res.plays);
      }).catch(function (e) { toast('获取播放地址失败：' + (e && e.message ? e.message : '')); });
    }
  }

  function doPlay(view, ep, episodes) {
    exit();
    if (SFV.online && SFV.online.playEpisode) SFV.online.playEpisode(view, ep, { episodes: episodes });
    else if (SFV.player && SFV.player.openUrl) SFV.player.openUrl(ep.url, { title: view.title, id: view.key });
    else toast('播放器不可用');
  }

  SFV.hall = {
    enter: enter, exit: exit,
    isActive: function () { return active; },
    openPoster: openPoster,
    setTab: setTab
  };
})(typeof window !== 'undefined' ? window : this);
