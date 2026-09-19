/*
 * Stellaflix 影视模块 — online 协调器 · 集群 B：TMDB 元数据 / 详情面板 / 失效修复
 *
 * 从 online.js 拆出（#6-b 可维护性债拆分）。持有 TMDB 取色/身份归一、详情打开与渲染、
 * 跨源失效修复面板。跨集群调用统一经共享状态 S（SFV.onlineShared）路由；online.js 保留
 * 薄别名委托，调用点零改动。
 *
 * 合规红线：不内置任何站点地址；api_site 由用户手动导入。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var S = SFV.onlineShared;
  if (!S) { throw new Error('[SFV online-detail] onlineShared 未加载，请检查 index.html 加载顺序'); }
  var OC = SFV.onlineCore;
  if (!OC) { throw new Error('[SFV online-detail] onlineCore 未加载，请检查 index.html 加载顺序'); }

  // 重建 online.js 中的局部别名（来自 S / OC，运行时已就绪）
  function d() { return S.d(); }
  var el = S.el, toast = S.toast;
  var doc = S.d();
  var esc = OC.esc, fmtAgo = OC.fmtAgo, trackLabel = OC.trackLabel, TRACK_META = OC.TRACK_META;
  var sourceById = S.sourceById, hasSources = S.hasSources, isVideoSpace = S.isVideoSpace;

  // ---- TMDB 元数据统一层 ----
  function resolvePic(it) {
    if (!it) return '';
    if (it.pic) return it.pic;
    if (it.poster) return it.poster;
    if (it._tmdb && it._tmdb.poster) return it._tmdb.poster;
    // 本地海报缓存兜底：详情页/浏览厅看过的片子已由 detail.js 把海报存成本地 data URL，
    // 起播时即使源没给图也能复用（与 player-controller 的本地兜底共用同一份缓存）。
    if (it.key && SFV.posterCache && typeof SFV.posterCache.resolvePic === 'function') {
      var cached = SFV.posterCache.resolvePic(it.key, '');
      if (cached) return cached;
    }
    return '';
  }

  function showTitleOf(item) {
    if (!item || !item.title) return '';
    var idx = item.title.indexOf(' · ');
    return idx > 0 ? item.title.slice(0, idx) : item.title;
  }

  var _picBackfillTried = {};
  function tryPicBackfill(item, doc) {
    if (!item || !item.key || !item.title) return;
    if (item.pic) return;
    if (_picBackfillTried[item.key]) return;
    if (!SFV.tmdb || typeof SFV.tmdb.hasKey !== 'function' || !SFV.tmdb.hasKey()) return;
    if (typeof SFV.tmdb.bestMatch !== 'function') return;
    if (!SFV.model || typeof SFV.model.updateHistoryPic !== 'function') return;
    var title = showTitleOf(item);
    if (!title) return;
    _picBackfillTried[item.key] = true;
    var key = item.key;
    SFV.tmdb.bestMatch(title).then(function (m) {
      if (!m || !m.poster) return;
      if (!SFV.model.updateHistoryPic(key, m.poster)) return;
      if (!doc || !doc.querySelector) return;
      var sel = '.sfv-continue-tile[data-sfv-key="' + esc(key) + '"] .sfv-tile-cover';
      var tile = doc.querySelector(sel);
      if (tile) {
        tile.style.backgroundImage = 'url("' + esc(m.poster) + '")';
        tile.classList.add('has-cover');
      }
    }).catch(function () { });
  }

  function enrichTmdb(card, it) {
    if (!it || !it.title) return;
    if (it._tmdbResolved) return;
    if (!SFV.tmdb || !SFV.tmdb.hasKey()) return;
    if (it.pic && it.pic.indexOf('data:') === 0) return;
    SFV.tmdb.bestMatch(it.title).then(function (m) {
      if (!m || !card.isConnected) return;
      var cover = card.querySelector('.sfv-card-cover');
      if (cover && m.poster) {
        var prevHtml = cover.innerHTML;
        var img = el('img', 'sfv-card-img');
        var picUrl = (SFV.posterCache && typeof SFV.posterCache.resolvePic === 'function' && it.key)
          ? SFV.posterCache.resolvePic(it.key, m.poster)
          : m.poster;
        img.src = picUrl; img.alt = it.title || ''; img.loading = 'lazy';
        img.addEventListener('load', function () { img.classList.add('loaded'); });
        img.addEventListener('error', function () {
          img.remove();
          if (!prevHtml || prevHtml === '') cover.textContent = '🎬';
          else {
            cover.innerHTML = prevHtml;
            var fallbackImg = cover.querySelector('img');
            if (fallbackImg && !fallbackImg.classList.contains('loaded')) {
              if (fallbackImg.complete) fallbackImg.classList.add('loaded');
              else fallbackImg.addEventListener('load', function () { fallbackImg.classList.add('loaded'); });
            }
          }
        });
        cover.textContent = ''; cover.appendChild(img);
      }
      if (m.vote) {
        var sub = card.querySelector('.sfv-card-sub');
        if (sub && !sub.querySelector('.sfv-tmdb-vote')) {
          sub.insertAdjacentElement('afterbegin',
            el('span', 'sfv-tmdb-vote', '★ ' + m.vote.toFixed(1))
          );
        }
      }
      if (m.poster) it.pic = m.poster;
      it._tmdb = m;
    }).catch(function () { });
  }

  // ---- TMDB 仅补全元数据（海报/评分/id），不再按 tmdbId 合并卡片 ----
  // 分层原则：搜索页身份由 aggregateByLocalKey（L0 标题/季）决定；
  // TMDB 多季常共享 series id，若在此二次 merge 会吞掉完结季等分卡。
  function enrichIdentity(aggs) {
    if (!aggs || !aggs.length) return Promise.resolve(aggs);
    if (!SFV.tmdb || typeof SFV.tmdb.hasKey !== 'function' || !SFV.tmdb.hasKey() ||
        typeof SFV.tmdb.bestMatch !== 'function') {
      return Promise.resolve(aggs);
    }
    var queue = aggs.slice();
    var CONC = 4;
    function worker() {
      if (!queue.length) return Promise.resolve();
      var item = queue.shift();
      var p = Promise.race([
        SFV.tmdb.bestMatch(item.title),
        new Promise(function (res) { setTimeout(function () { res(null); }, 4000); })
      ]).catch(function () { return null; });
      return p.then(function (m) {
        item._tmdbResolved = true;
        if (m && m.id != null) {
          item._tmdb = m;
          item.tmdbId = m.id;
          item.tmdbMediaType = m.mediaType;
          if (m.rating != null) item.tmdbRating = m.rating;
          if (m.poster) item.pic = m.poster;
        }
        // isKazumi 语义保持：仅当全部 variant 都是规则源
        item.isKazumi = (item.variants || []).length > 0 &&
          item.variants.every(function (v) { return v && v.isKazumi; });
        delete item._localKey;
        return worker();
      });
    }
    var ps = [];
    for (var i = 0; i < CONC; i++) ps.push(worker());
    return Promise.all(ps).then(function () {
      return aggs;
    });
  }

  function renderGrid(items, view) {
    S.bodyEl.innerHTML = '';
    if (!items || !items.length) {
      S.setNote(view && view.query ? '没有找到相关结果。' : '输入关键词开始搜索。');
      return;
    }
    var grid = el('div', 'sfv-grid');
    items.forEach(function (it) {
      var card = el('button', 'sfv-card');
      card.type = 'button';
      var cover = el('div', 'sfv-card-cover');
      if (it.pic) {
        var img = el('img', 'sfv-card-img');
        img.src = it.pic; img.alt = it.title || ''; img.loading = 'lazy';
        img.addEventListener('error', function () { img.style.display = 'none'; cover.classList.add('sfv-cover--broken'); });
        cover.appendChild(img);
      } else cover.textContent = '🎬';
      var name = el('div', 'sfv-card-name', it.title || '未命名');
      var sub = el('div', 'sfv-card-sub', (it.year ? it.year + ' · ' : '') + (it.variants && it.variants.length > 1 ? it.variants.length + ' 个来源' : '点击查看'));
      card.appendChild(cover); card.appendChild(name); card.appendChild(sub);
      if (it.isKazumi) card.classList.add('sfv-card--kazumi');
      card.addEventListener('click', function () {
        if (it.isKazumi) openKazumiDetail(it);
        else openDetail(it);
      });
      grid.appendChild(card);
      enrichTmdb(card, it);
    });
    S.bodyEl.appendChild(grid);
  }

  // ---------------------------------------------------------------- 详情 + 剧集
  function openDetail(item, meta) {
    // D9 修复：进入即消费并清除全局 _detailOrigin，避免跨会话/跨来源残留导致错层返回。
    // 把真实来源写进 detail view 的 from 标记，goBack 据 view.from 判定返回目标。
    var _origin = S._detailOrigin || null;
    S._detailOrigin = null;
    S.ensureOverlayShown();
    var firstVar = (item.variants && item.variants[0]) || null;
    if (!firstVar) { toast('该结果缺少来源信息。'); return; }
    var vodKey = firstVar.key || (firstVar.sourceId + ':' + firstVar.vodId);
    var src = sourceById(firstVar.sourceId);
    var vodId = firstVar.vodId;
    if (!src || vodId == null) { toast('片源不可用，可能已被移除。'); return; }
    S.recordMeta({ key: vodKey, title: item.title, pic: resolvePic(item), year: item.year, sourceId: src.id, vodId: vodId });
    var view = { mode: 'detail', key: vodKey, title: item.title, pic: resolvePic(item), year: item.year, source: src, vodId: vodId, meta: meta || null, _tmdb: item._tmdb || null, from: (_origin === 'search' ? 'search' : 'browse') };
    S.pushView(view);
    loadDetail(view);
  }

  function openKazumiDetail(item) {
    var _origin = S._detailOrigin || null;
    S._detailOrigin = null;
    S.ensureOverlayShown();
    var v = (item.variants && item.variants[0]) || null;
    if (!v || !v.src || !v.ruleName) { toast('该规则结果缺少详情链接。'); return; }
    var view = {
      mode: 'detail',
      key: item.key,
      title: item.title,
      pic: resolvePic(item),
      year: item.year,
      ruleName: v.ruleName,
      src: v.src,
      source: { id: 'kazumi:' + v.ruleName },
      vodId: item.key,
      _tmdb: item._tmdb || null,
      isKazumi: true,
      from: (_origin === 'search' ? 'search' : 'browse')
    };
    S.recordMeta({ key: item.key, title: item.title, pic: item.pic, year: item.year, sourceId: view.source.id, vodId: item.key });
    S.pushView(view);
    renderDetail(view);
  }

  function openDetailFromMeta(meta) {
    var _origin = S._detailOrigin || null;
    S._detailOrigin = null;
    var src = meta.sourceId ? sourceById(meta.sourceId) : null;
    if (meta.key && meta.key.indexOf('url:') === 0) {
      if (SFV.source) SFV.source.open(meta.key.slice(4));
      else if (SFV.player) SFV.player.openUrl(meta.key.slice(4));
      return;
    }
    if (meta.key && meta.key.indexOf('file:') === 0) {
      toast('本地文件需重新选择');
      if (SFV.player) SFV.player.openFilePicker();
      return;
    }
    S.ensureOverlayShown();
    var view = Object.assign({}, meta, { mode: 'detail', meta: meta });
    // 优先保留 meta 自带的 from（如播放器返回重建的详情已带正确来源）；否则按本次消费的来源判定
    if (view.from == null) view.from = (_origin === 'search' ? 'search' : 'browse');
    S.pushView(view);
    return;
  }

  function repairKeyOf(meta) {
    return meta.key || ('__title__' + String(meta.title || ''));
  }

  function pickRepairCandidate(items, meta, tried) {
    var title = String(meta.title || '').trim().toLowerCase();
    var year = String(meta.year || '').trim();
    if (!title) return null;
    var yearMatch = null, exact = null, fuzzy = null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.title) continue;
      var usable = (it.variants || []).filter(function (v) { return !(tried && tried[v.sourceId]); });
      if (!usable.length) continue;
      var t = it.title.trim().toLowerCase();
      if (t === title) {
        if (year && String(it.year || '').trim() === year) { if (!yearMatch) yearMatch = { it: it, usable: usable }; }
        else if (!exact) exact = { it: it, usable: usable };
      } else if (!fuzzy && (t.indexOf(title) >= 0 || title.indexOf(t) >= 0)) {
        fuzzy = { it: it, usable: usable };
      }
    }
    var best = yearMatch || exact || fuzzy;
    if (!best) return null;
    best.it.variants = best.usable;
    return best.it;
  }

  function repairFromSearch(meta, opts) {
    opts = opts || {};
    var title = meta.title ? String(meta.title).trim() : '';
    if (!title) { renderExpiredPanel(meta, 'missing-title'); return; }
    var key = repairKeyOf(meta);
    var tried = S.repairTried[key] || (S.repairTried[key] = {});
    if (opts.excludeSourceId) tried[opts.excludeSourceId] = true;
    var enabled = SFV.sources.getEnabledSources();
    if (!enabled.length) { renderExpiredPanel(meta, 'no-enabled-source'); return; }
    S.renderLoading('正在尝试为你查找替代片源…');
    SFV.sources.search(title, { sources: enabled, pg: 1, timeout: 12000 }).then(function (res) {
      if (!S.isOpen()) return;
      if (res.noSource || !res.items || !res.items.length) {
        renderExpiredPanel(meta, 'search-empty'); return;
      }
      var cand = pickRepairCandidate(res.items, meta, tried);
      if (!cand) { renderExpiredPanel(meta, 'no-match'); return; }
      var variant = (cand.variants && cand.variants[0]) || null;
      if (!variant || variant.vodId == null) { renderExpiredPanel(meta, 'no-variant'); return; }
      tried[variant.sourceId] = true;
      toast('已为你找到替代片源：' + (cand.title || title));
      var repaired = {
        key: meta.key,
        title: cand.title,
        pic: cand.pic || meta.pic,
        year: cand.year || meta.year,
        vodId: variant.vodId,
        variants: [{ key: meta.key, sourceId: variant.sourceId, vodId: variant.vodId }],
      };
      openDetail(repaired, meta);
    }).catch(function () {
      if (!S.isOpen()) return;
      renderExpiredPanel(meta, 'search-error');
    });
  }

  function expiredReasonText(r) {
    var map = {
      'missing-title': '条目缺少标题，无法检索',
      'no-enabled-source': '未启用任何片源',
      'search-empty': '跨源检索无结果',
      'no-match': '跨源检索无匹配片名',
      'no-variant': '匹配条目缺少可播放剧集',
      'search-error': '跨源检索异常',
    };
    return map[r] || r || '未知';
  }

  function renderExpiredPanel(meta, reason) {
    if (!S.isOpen()) return;
    S.setNote('');
    S.titleEl.textContent = meta.title || '来源已失效';
    S.bodyEl.innerHTML = '';
    var panel = el('div', 'sfv-expired-panel');
    panel.appendChild(el('div', 'sfv-expired-title', '来源已失效'));
    var sub = el('div', 'sfv-expired-sub');
    sub.textContent = '该条目原有来源不可访问，已为你保留原始信息，可手动查看或重试查找。';
    panel.appendChild(sub);

    var info = el('div', 'sfv-expired-info');
    var rows = [
      ['标题', meta.title || '—'],
      ['原片源ID', meta.sourceId || '—'],
      ['原剧集ID', meta.vodId != null ? String(meta.vodId) : '—'],
      ['原始键', meta.key || '—'],
      ['失效原因', expiredReasonText(reason)],
    ];
    rows.forEach(function (r) {
      var row = el('div', 'sfv-expired-row');
      row.appendChild(el('span', 'sfv-expired-k', r[0]));
      row.appendChild(el('span', 'sfv-expired-v', r[1]));
      info.appendChild(row);
    });
    panel.appendChild(info);

    var actions = el('div', 'sfv-expired-actions');
    if (meta.key && meta.key.indexOf('url:') === 0) {
      var openBtn = el('button', 'sfv-expired-btn sfv-expired-btn--primary', '手动打开原始链接');
      openBtn.type = 'button';
      openBtn.addEventListener('click', function () {
        var u = meta.key.slice(4);
        if (SFV.source) SFV.source.open(u); else if (SFV.player) SFV.player.openUrl(u);
      });
      actions.appendChild(openBtn);
    }
    var retryBtn = el('button', 'sfv-expired-btn', '重试查找');
    retryBtn.type = 'button';
    retryBtn.addEventListener('click', function () { repairFromSearch(meta, {}); });
    actions.appendChild(retryBtn);
    panel.appendChild(actions);

    S.bodyEl.appendChild(panel);

    if (SFV.model && SFV.model.logFailure) {
      SFV.model.logFailure({
        title: meta.title || '',
        key: meta.key || '',
        sourceId: meta.sourceId || '',
        vodId: meta.vodId != null ? String(meta.vodId) : '',
        reason: reason,
        action: 'open',
      });
    }
  }

  function loadDetail(view) {
    renderDetail(view);
  }

  function renderDetail(view) {
    S.setNote('');
    S.destroyDetail();
    try {
      if (SFV.detail && typeof SFV.detail.build === 'function') {
        S._detailInstance = SFV.detail.build(S.bodyEl, view, { back: S.goBack }) || null;
      } else if (SFV.ui && typeof SFV.ui.toast === 'function') {
        SFV.ui.toast('详情页开发中，敬请期待');
      }
    } catch (detailErr) {
      S._detailInstance = null;
      if (SFV.ui && typeof SFV.ui.toast === 'function') {
        SFV.ui.toast('详情页加载失败，敬请期待');
      }
    }
  }

  // ---------------------------------------------------------------- 注册到共享状态 S + 命名空间
  S.resolvePic = resolvePic;
  S.showTitleOf = showTitleOf;
  S.tryPicBackfill = tryPicBackfill;
  S.enrichTmdb = enrichTmdb;
  S.enrichIdentity = enrichIdentity;
  S.renderGrid = renderGrid;
  S.openDetail = openDetail;
  S.openKazumiDetail = openKazumiDetail;
  S.openDetailFromMeta = openDetailFromMeta;
  S.repairKeyOf = repairKeyOf;
  S.pickRepairCandidate = pickRepairCandidate;
  S.repairFromSearch = repairFromSearch;
  S.expiredReasonText = expiredReasonText;
  S.renderExpiredPanel = renderExpiredPanel;
  S.loadDetail = loadDetail;
  S.renderDetail = renderDetail;

  SFV.onlineDetail = {
    resolvePic: resolvePic, showTitleOf: showTitleOf, tryPicBackfill: tryPicBackfill,
    enrichTmdb: enrichTmdb, enrichIdentity: enrichIdentity, renderGrid: renderGrid,
    openDetail: openDetail, openKazumiDetail: openKazumiDetail, openDetailFromMeta: openDetailFromMeta,
    repairKeyOf: repairKeyOf, pickRepairCandidate: pickRepairCandidate, repairFromSearch: repairFromSearch,
    expiredReasonText: expiredReasonText, renderExpiredPanel: renderExpiredPanel,
    loadDetail: loadDetail, renderDetail: renderDetail,
  };

  console.log('[SFV-DIAG] online-detail.js 集群已加载（TMDB/详情/失效修复）');
})(typeof window !== 'undefined' ? window : this);
