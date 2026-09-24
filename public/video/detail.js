/*
 * Stellaflix 影视详情页（Plex 风）—— detail.js
 * ----------------------------------------------------------------
 * 设计契约见 player.css .sfv-detail-plex 注释 + 2026-08-06 协同设计决议：
 *   整页海报 fixed 铺满 + 仅底部 50% 暗渐变；左上圆形返回 + 右上 Plex 胶囊(-□×)；
 *   白色标题(甲:优先海报扣取,回退 TMDB 文字)；药丸操作组(播放/追片6态/收藏)；
 *   HEADER 元数据只读 4 字段(字段间 | 分隔,多类型间 / 分隔)；演员⌀70 + 相似/剧照卡(默认无独立标题文字)；
 *   8px TMDB 署名(G4-A)。剧集/选源冻结(等 Kazumi 讨论)。仅影视态可见(双态隔离)。
 *
 * 挂载：SFV.detail.build(rootEl, view, hooks)
 *   hooks.back   —— 返回回调(由 online.js 传入 goBack)，返回钮 / ESC 触发
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var doc = (typeof document !== 'undefined') ? document : null;
  // detail-core.js（先于本文件加载）已建立 SFV.detail 基础 facade（纯数据层：
  // isKazumiView / pickBestLogo / classifyCandidateEmbed / buildCandidates）；
  // 本文件在其上叠加 DOM 层（build / enrich / 播放接线），并补充 build。
  var D = SFV.detail;

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function svg(path) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }
  var ICON = {
    play:     '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 11.9997V9.32968C6 6.01968 8.35 4.65968 11.22 6.31968L13.53 7.65968L15.84 8.99968C18.71 10.6597 18.71 13.3697 15.84 15.0297L13.53 16.3697L11.22 17.7097C8.35 19.3397 6 17.9897 6 14.6697V11.9997Z" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    heart:    svg('<path d="M12 20.5C12 20.5 4.5 15.6 4.5 9.8 4.5 7.2 6.4 5.4 8.9 5.4c1.7 0 3.1 1 3.6 2.3.5-1.3 1.9-2.3 3.6-2.3 2.5 0 4.4 1.8 4.4 4.4 0 5.8-7.5 10.7-7.5 10.7z"/>'),
    edit:     svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>'),
    audio:    svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
    add:      svg('<path d="M12 5v14M5 12h14"/>'),
    // Plex 窗口控制专用图标 —— 差异②：放大到 20px 并加粗 stroke，
    // 让 − □ × 在窄胶囊里也清晰(参照左侧参考图粗体图标)
    min:      '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10" width="16" height="4" rx="2" fill="currentColor"/></svg>',
    max:      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2.5" stroke="currentColor" stroke-width="2.4"/></svg>',
    close:    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>'
  };

  // 追片 6 态（未追=null + model.js 的 5 态枚举）
  var TRACK_MENU = [
    { key: null, label: '未追' },
    { key: 'watching', label: '在看' },
    { key: 'planToWatch', label: '想看' },
    { key: 'onHold', label: '搁置' },
    { key: 'watched', label: '看过' },
    { key: 'abandoned', label: '抛弃' }
  ];

  function toast(msg) {
    if (SFV.ui && typeof SFV.ui.toast === 'function') SFV.ui.toast(msg);
    else if (SFV.home && typeof SFV.home.toast === 'function') SFV.home.toast(msg);
  }

  // 解析 TMDB id：优先 view._tmdb，否则按标题 bestMatch（G8 兜底）
  function resolveTmdbId(view) {
    if (view && view._tmdb && view._tmdb.id) {
      return Promise.resolve({ id: view._tmdb.id, mediaType: view._tmdb.mediaType === 'tv' ? 'tv' : 'movie' });
    }
    if (!SFV.tmdb || !SFV.tmdb.hasKey || !SFV.tmdb.hasKey()) return Promise.resolve(null);
    var title = (view && view.title) || '';
    if (!title) return Promise.resolve(null);
    return SFV.tmdb.bestMatch(title).then(function (m) {
      if (!m || !m.id) return null;
      return { id: m.id, mediaType: m.mediaType === 'tv' ? 'tv' : 'movie' };
    }).catch(function () { return null; });
  }

  // 详情页抓到的海报回写（2026-09-13）：
  //   ① 补 view.pic —— 起播链路 detail-source.playCandidate 构造 v2 时取 `view.pic || v.pic`，
  //      详情页 enrich 出的 TMDB 海报原先只画到背景层、没写回 view，起播后海报就丢了。
  //   ② 落本地缓存 SFV.posterCache（键 = view.key）—— 供底部控制条左侧海报容器、
  //      历史/追片列表离线复用，不依赖 TMDB 是否可达。
  // 已有源海报时不覆盖（源海报才是该条目的正片海报），仅在缺失时补齐。
  function rememberPoster(view, url) {
    if (!view || !url) return;
    if (!view.pic) view.pic = url;
    if (view.key && SFV.posterCache && typeof SFV.posterCache.cache === 'function') {
      try { SFV.posterCache.cache(view.key, view.pic || url); } catch (e) { /* 缓存失败不影响展示 */ }
    }
  }

  function mkPill(extraCls, iconHtml, label) {
    var b = el('button', 'sfv-plex-pill' + (extraCls ? ' ' + extraCls : ''));
    b.type = 'button';
    b.innerHTML = iconHtml + (label ? '<span>' + esc(label) + '</span>' : '');
    return b;
  }
  function sep() { return el('span', 'sfv-plex-sep'); }

  // 追片状态图标 / 文案 —— 镜像 Kazumi CollectButton.getIconByInt / getTypeStringByInt。
  // 图标取自 SFV.model.STATE_ICONS（Material 官方 path，1:1 对齐 Kazumi）；
  // none(未追) 用 favorite_border，与 Kazumi 默认分支一致。
  function trackIcon(key) {
    var map = (SFV.model && SFV.model.STATE_ICONS) || null;
    var k = (key == null) ? 'none' : key;
    return (map && map[k]) ? map[k] : '';
  }
  function trackLabel(key) {
    for (var i = 0; i < TRACK_MENU.length; i++) {
      if (TRACK_MENU[i].key === (key == null ? null : key)) return TRACK_MENU[i].label;
    }
    return '未追';
  }
  // 追片触发器引用（cycleTrackStatus 刷新图标时同步更新）
  var _trackTriggerBtn = null;

  // 追片候选键：主键=TMDB canonical（一部片跨源稳定），别名=源键（存量/无 TMDB id 时）。
  // 读写均经 model.get/setTrackStatusForKeys，写入时惰性清别名键。
  function trackKeysForView(view) {
    var keys = [];
    if (SFV.model && typeof SFV.model.canonicalTrackKey === 'function') {
      var c = SFV.model.canonicalTrackKey(view);
      if (c) keys.push(c);
    }
    if (view && view.key && keys.indexOf(view.key) < 0) keys.push(view.key);
    return keys;
  }

  // 追片：点击循环切换 6 态（与播放器底部控制栏 heart-btn 完全一致：
  //   纯图标刷新 + 互斥单值 6 态循环 + toast 提示；无下拉菜单）。
  function cycleTrackStatus(view) {
    var keys = trackKeysForView(view);
    if (!keys.length || !SFV.model ||
        typeof SFV.model.getTrackStatusForKeys !== 'function' ||
        typeof SFV.model.setTrackStatusForKeys !== 'function') return;
    var status = SFV.model.getTrackStatusForKeys(keys);
    var menuKeys = TRACK_MENU.map(function (m) { return m.key; });
    var idx = menuKeys.indexOf(status);
    var next = menuKeys[(idx + 1) % menuKeys.length];
    SFV.model.setTrackStatusForKeys(keys, next, { title: view.title, pic: view.pic, year: view.year });
    // 纯图标刷新（对照 heart-btn：仅图标，无文字），并同步 title
    if (_trackTriggerBtn) {
      _trackTriggerBtn.innerHTML = trackIcon(next);
      _trackTriggerBtn.title = '追片：' + trackLabel(next);
    }
    toast('已设为：' + trackLabel(next));
  }

  // 模块级：收集轮播 resize 监听，便于 destroy 时清理，避免详情页反复打开导致全局监听器堆积
  var __railResizeHandlers = [];

  function renderRail(sections, title, items, mapFn, isActor, wrapperClass) {
    if (!items || !items.length) return;
    var sec = el('div', wrapperClass || '');
    sec.appendChild(el('div', 'sfv-plex-section', title));
    var rail = el('div', 'sfv-plex-rail');
    items.forEach(function (it) {
      var m = mapFn(it);
      var card = el('div', isActor ? 'sfv-plex-actor' : 'sfv-plex-card' + (m.poster ? ' sfv-plex-card--poster' : ''));
      if (isActor) {
        var img = el('img', 'sfv-plex-actor-img');
        if (m.img) { img.src = m.img; img.alt = m.name || ''; img.loading = 'lazy'; }
        card.appendChild(img);
        if (m.name) card.appendChild(el('div', 'sfv-plex-actor-name', m.name));
      } else {
        var cimg = el('img', 'sfv-plex-card-img');
        if (m.img) { cimg.src = m.img; cimg.alt = m.name || ''; cimg.loading = 'lazy'; }
        card.appendChild(cimg);
        // 类似影片：hover 左下角淡入展示 TMDB title logo（透明 PNG 矢量标题）。
        // 有 logo 优先显示 logo；无 logo / 加载失败则回退 original_title 文字。
        // 幕后剧照(kind 缺失)不注入，保持纯净。
        if (m.kind === 'similar' || m.onClick) {
          var cap = el('div', 'sfv-plex-card__cap');
          card.appendChild(cap);
          if (m.kind === 'similar') loadSimilarLogo(m, cap);
          else if (m.ot) cap.textContent = m.ot;
          card.style.cursor = 'pointer';
          card.addEventListener('click', function () {
            if (typeof m.onClick === 'function') m.onClick();
            else openSimilarDetail(m);
          });
        }
      }
      rail.appendChild(card);
    });

    if (isActor) {
      // 主演：保持原生横向滚动，不加箭头
      sec.appendChild(rail);
    } else {
      // 类似影片 / 幕后剧照：横向轮播 + 左右箭头（对标参考视频 carousel 逻辑）
      var wrap = el('div', 'sfv-plex-rail-wrap');
      var leftBtn = el('button', 'sfv-plex-rail__arrow sfv-plex-rail__arrow--left');
      leftBtn.type = 'button'; leftBtn.setAttribute('aria-label', '向左滚动');
      leftBtn.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true"><path d="M16 5 L8 12 L16 19" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      var rightBtn = el('button', 'sfv-plex-rail__arrow sfv-plex-rail__arrow--right');
      rightBtn.type = 'button'; rightBtn.setAttribute('aria-label', '向右滚动');
      rightBtn.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true"><path d="M8 5 L16 12 L8 19" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      wrap.appendChild(leftBtn);
      wrap.appendChild(rail);
      wrap.appendChild(rightBtn);
      sec.appendChild(wrap);

      // 单卡片步进：每次仅滚动一张卡片宽度 + 间距，保持连续浏览体验
      function scrollByCard(dir) {
        var card = rail.querySelector('.sfv-plex-card');
        var gap = parseFloat(global.getComputedStyle(rail).gap) || 19;
        var step = card ? Math.round(card.offsetWidth + gap) : 299; // 兜底：按 280+19
        rail.scrollBy({ left: dir * step, behavior: 'smooth' });
      }
      function updateArrows() {
        var maxScroll = rail.scrollWidth - rail.clientWidth;
        var atStart = rail.scrollLeft <= 1;
        var atEnd = rail.scrollLeft >= maxScroll - 1;
        leftBtn.classList.toggle('is-hidden', atStart);
        rightBtn.classList.toggle('is-hidden', atEnd);
      }
      leftBtn.addEventListener('click', function (e) { e.stopPropagation(); scrollByCard(-1); });
      rightBtn.addEventListener('click', function (e) { e.stopPropagation(); scrollByCard(1); });
      rail.addEventListener('scroll', updateArrows, { passive: true });
      rail.addEventListener('load', updateArrows, true); // 卡片图懒加载完成后 scrollWidth 可能变化
      global.addEventListener('resize', updateArrows);
      __railResizeHandlers.push(updateArrows);
      updateArrows();
    }

    sections.appendChild(sec);
  }

  // 类似影片卡片 hover 标题：优先 TMDB title logo，缺失/失败回退 original_title 文字
  function loadSimilarLogo(m, cap) {
    if (!SFV.tmdb || typeof SFV.tmdb.getMovieLogos !== 'function' || !m.id) {
      if (m.ot) cap.textContent = m.ot;
      return;
    }
    SFV.tmdb.getMovieLogos(m.id, m.mediaType).then(function (logos) {
      if (!cap.parentNode) return; // 卡片已移除（详情页关闭/重建）
      var best = D.pickBestLogo(logos);
      if (best && SFV.tmdb.logoUrl) {
        cap.className = 'sfv-plex-card__cap sfv-plex-card__cap--logo';
        var limg = el('img', 'sfv-plex-card__logo');
        limg.src = SFV.tmdb.logoUrl(best.file_path, 'original');
        limg.alt = m.name || m.ot || '';
        limg.loading = 'lazy';
        limg.addEventListener('error', function () {
          if (cap.parentNode) {
            cap.className = 'sfv-plex-card__cap';
            cap.textContent = m.ot || '';
          }
        });
        cap.appendChild(limg);
      } else if (m.ot) {
        cap.textContent = m.ot;
      }
    })['catch'](function () {
      if (cap.parentNode && m.ot) cap.textContent = m.ot;
    });
  }

  // 搜索会话内的同系列季/版（本体 ↔ 完结季 ↔ S2…），点进对应身份卡详情
  function openSeasonSiblingCard(card) {
    if (!card) return;
    if (card.isKazumi && SFV.openKazumiDetail) { SFV.openKazumiDetail(card); return; }
    if (SFV.openDetail) { SFV.openDetail(card); return; }
    if (SFV.onlineDetail && SFV.onlineDetail.openDetail) { SFV.onlineDetail.openDetail(card); return; }
    toast('详情导航未就绪');
  }

  function renderSearchSeasonSiblings(sections, view) {
    var shared = SFV.onlineShared;
    var cards = shared && shared._lastSearchCards;
    if (!cards || !cards.length || !SFV.SearchFilterCore) return;
    var core = SFV.SearchFilterCore;
    if (typeof core.filterSeasonSiblings !== 'function') return;
    var siblings = core.filterSeasonSiblings(cards, (view && view.title) || '');
    if (!siblings.length) return;
    renderRail(sections, '同系列', siblings, function (s) {
      var label = core.labelIdentityMarkers(core.extractIdentityMarkers(s.title || ''));
      return {
        img: s.pic || '',
        name: label || s.title,
        ot: label || s.title,
        onClick: function () { openSeasonSiblingCard(s); }
      };
    });
  }

  // 点击「类似影片」卡片 → 跳转该影片详情页
  function openSimilarDetail(m) {
    if (!m || !m.id) return;
    var meta = {
      key: 'tmdb:' + m.mediaType + ':' + m.id,
      title: m.name || m.ot || '',
      pic: m.img || '',
      year: m.year || '',
      _tmdb: { id: m.id, mediaType: m.mediaType },
      _origin: 'similar'
    };
    if (SFV.online && typeof SFV.online.openDetailFromMeta === 'function') {
      SFV.online.openDetailFromMeta(meta);
    } else if (SFV.online && typeof SFV.online.pushView === 'function') {
      SFV.online.pushView(Object.assign({}, meta, { mode: 'detail', meta: meta }));
    } else {
      toast('详情页导航未就绪');
    }
  }

  function enrich(bg, titleWrap, subtitle, meta, overview, expand, sections, view) {
    resolveTmdbId(view)
      .then(function (tm) {
        if (!tm || !SFV.tmdb || typeof SFV.tmdb.getDetailBundle !== 'function') return null;
        return SFV.tmdb.getDetailBundle(tm.id, tm.mediaType);
      })
      .then(function (b) {
        if (!b) return; // 基础渲染已显示 view.title/pic，静默保留
        // 背景替换为 TMDB backdrop —— 立即应用 + 后台探测，加载失败回退；
        // 不再等整张 w1280 图经代理下载完才切换（渐进渲染提前首屏 ~1s）。
        // 失败（404/超时/无 key）保留 build 时设置的条目自带海报 view.pic
        if (b.backdrop) D.applyBackdropSafe(bg, b.backdrop);
        // 详情页已抓到 TMDB 海报（w500）：回写 view.pic + 落本地缓存，
        // 让底部控制条左侧海报容器直接复用这张已经下载好的图。
        if (b.poster) rememberPoster(view, b.poster);
        // 主标题：A 方案 - TMDB logo 矢量图优先
        // 1. 有 TMDB logo（zh 优先 > en > null > 其他, 同语种按 vote_average 降序）
        //    → 渲染透明 PNG 标题设计(鬼玩人红字 / 蚁人红蓝 Marvel 字)
        // 2. 无 logo → 文字回退: original_title 白字大写 (G1 之前定)
        titleWrap.innerHTML = '';
        var bestLogo = D.pickBestLogo(b.images && b.images.logos);
        if (bestLogo && SFV.tmdb.logoUrl) {
          var lt = el('div', 'sfv-plex-logo-title');
          var limg = el('img');
          limg.src = SFV.tmdb.logoUrl(bestLogo.file_path, 'original');
          limg.alt = view.title || '';
          limg.loading = 'lazy';
          // 加载失败回退: img.onerror 直接换文字, 不再退回整张 poster
          limg.addEventListener('error', function () {
            if (lt.parentNode) {
              lt.parentNode.removeChild(lt);
              titleWrap.appendChild(el('h1', 'sfv-plex-title-text', view.title || ''));
            }
          });
          lt.appendChild(limg);
          titleWrap.appendChild(lt);
        } else {
          titleWrap.appendChild(el('h1', 'sfv-plex-title-text', view.title || ''));
        }
        // 标题已就绪（TMDB logo 或文字回退）→ 立即绑定 logo 滚动动画到真实元素，
        // 不依赖后续 renderRail 是否成功，确保动画始终生效
        if (D.bindLogoScroll) D.bindLogoScroll();
        // 副标题：original_title（与标题不同才显示, 白字大写 + letter-spacing）
        var ot = b.originalTitle || '';
        if (ot && ot !== (view.title || '')) subtitle.textContent = ot;
        // 元数据行：TMDB logo + 评分 紧凑组 (gap 5，无竖线) | 年份/片长/类型 (gap 12，全无竖线)
        meta.innerHTML = '';
        var logoRating = el('div', 'sfv-plex-logo-rating');
        var logo = el('img', 'sfv-plex-tmdb-logo');
        logo.src = 'video/tmdb_logo.png'; logo.alt = 'The Movie Database';
        logoRating.appendChild(logo);
        logoRating.appendChild(el('span', 'sfv-plex-rating', (b.voteAverage || 0).toFixed(1)));
        meta.appendChild(logoRating);
        // 评分↔年份、 年份↔时长、 时长↔类型 间竖线全部删除，仅留 meta flex gap 12px 分隔
        meta.appendChild(el('span', 'sfv-plex-meta-cell', (b.releaseDate || '').slice(0, 4) || '—'));
        meta.appendChild(el('span', 'sfv-plex-meta-cell', b.runtime ? b.runtime + ' 分钟' : '--'));
        if (b.genres && b.genres.length) {
          meta.appendChild(el('span', 'sfv-plex-meta-cell sfv-plex-genres', b.genres.join(' / ')));
        }
        // 简介 + 展开（>120 字显示展开按钮）
        if (b.overview) {
          overview.textContent = b.overview;
          expand.style.display = b.overview.length > 120 ? 'inline-block' : 'none';
        }
        // 演员（⌀70 圆头像）
        if (b.cast && b.cast.length) {
          renderRail(sections, '主演', b.cast.slice(0, 8), function (c) {
            return { img: c.profile, name: c.name, sub: c.character };
          }, true);
        }
        // 幕后剧照（默认无独立标题文字；顺序在类似影片之前，2026-08-17 用户拍板互换）
        if (b.images && b.images.backdrops && b.images.backdrops.length) {
          renderRail(sections, '幕后剧照', b.images.backdrops, function (bd) {
            return { img: SFV.tmdb.posterUrl(bd.file_path, 'w780'), name: '' };
          }, false, 'sfv-plex-sec--backdrops');
        }
        // 类似影片（landscape 16:9 横幅；推荐上限 10 个，显示逻辑与幕后剧照一致 carousel）
        // 海报用 TMDB 原始无字干净版 w500（比默认 w342 更锐利）；ot=original_title 供 hover 左下角展示
        if (b.similar && b.similar.length) {
          renderRail(sections, '类似影片', b.similar.slice(0, 10), function (m) {
            return { img: SFV.tmdb.posterUrl(m.posterPath, 'w500'), name: m.title, ot: m.originalTitle, id: m.id, mediaType: m.mediaType, year: m.year, kind: 'similar' };
          }, false);
        }
        // TMDB 分季入口（对齐 Kazumi relations 的「季切换」意图）：
        // 点某一季 → 用「剧名 第N季」走 searchAndPick 本地源搜，不离开详情结构。
        if (b.seasons && b.seasons.length > 1 && SFV.detailSource &&
            typeof SFV.detailSource.searchAndPick === 'function') {
          renderRail(sections, '分季', b.seasons.slice(0, 12), function (s) {
            var seasonTitle = (view.title || b.title || '') + ' 第' + s.seasonNumber + '季';
            return {
              img: s.poster || b.poster || '',
              name: '第' + s.seasonNumber + '季',
              ot: s.name || seasonTitle,
              onClick: function () {
                var seasonView = Object.assign({}, view, {
                  title: seasonTitle,
                  pic: s.poster || view.pic || b.poster || ''
                });
                try {
                  SFV.detailSource.searchAndPick(seasonView, sections);
                } catch (e) {
                  toast('分季选源失败');
                }
              }
            };
          });
        }
      })
      .catch(function () { /* 静默降级：基础渲染已显示 */ });
  }

  function build(rootEl, view, hooks) {
    hooks = hooks || {};
    var onBack = typeof hooks.back === 'function' ? hooks.back : function () {};
    if (!doc) return null;
    view = view || {};

    // logo 滚动动画状态（enrich 后异步绑定，destroy 时统一清理）
    var logoScrollState = null;

    // 进入沉浸态：隐藏全局顶栏（含原 -□× 与搜索/DIY/logo）
    doc.body.classList.add('sfv-plex-immersive');

    // 同步清空并建根
    rootEl.innerHTML = '';
    var root = el('div', 'sfv-detail-plex');
    rootEl.appendChild(root);

    // 海报背景层（基础：view.pic；enrich 后替换为 TMDB backdrop）
    var bg = el('div', 'sfv-plex-bg');
    if (view.pic) bg.style.backgroundImage = 'url("' + esc(view.pic) + '")';
    rememberPoster(view, view.pic); // 源自带海报：立即落本地缓存，供起播后底部控制条复用
    root.appendChild(bg);

    var content = el('div', 'sfv-plex-content');
    root.appendChild(content);

    // 左上圆形返回大钮 — Plex 风格 chevron-left（参照 185121 红底圆钮）
    var back = el('button', 'sfv-plex-back');
    back.type = 'button';
    back.setAttribute('aria-label', '返回');
    back.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">' +
      '<path d="M14.5 6 L8.5 12 L14.5 18" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    back.addEventListener('click', function () { destroy(); onBack(); });
    root.appendChild(back);

    // 右上 Plex 风格窗口控制胶囊(-□×) —— 接真实 Electron 控制
    var win = el('div', 'sfv-plex-win');
    var bMin = el('button'); bMin.type = 'button'; bMin.innerHTML = ICON.min; bMin.title = '最小化';
    var bMax = el('button'); bMax.type = 'button'; bMax.innerHTML = ICON.max; bMax.title = '最大化';
    var bClose = el('button'); bClose.type = 'button'; bClose.innerHTML = ICON.close; bClose.title = '关闭';
    bMin.addEventListener('click', function () { if (global.desktopWindow && global.desktopWindow.minimize) global.desktopWindow.minimize(); });
    bMax.addEventListener('click', function () { if (global.desktopWindow && global.desktopWindow.toggleMaximize) global.desktopWindow.toggleMaximize(); });
    bClose.addEventListener('click', function () { if (global.desktopWindow && global.desktopWindow.close) global.desktopWindow.close(); });
    win.appendChild(bMin); win.appendChild(bMax); win.appendChild(bClose);
    root.appendChild(win);

    // HEADER 区
    var header = el('div', 'sfv-plex-header');
    content.appendChild(header);

    // 信息区（标题/副标题/meta/简介/展开按钮）：展开简介时仅本区上移，按钮区固定不动
    var info = el('div', 'sfv-plex-info');
    header.appendChild(info);

    var titleWrap = el('div', 'sfv-plex-title');
    titleWrap.appendChild(el('h1', 'sfv-plex-title-text', view.title || ''));
    info.appendChild(titleWrap);

    var subtitle = el('div', 'sfv-plex-subtitle', '');
    info.appendChild(subtitle);

    var meta = el('div', 'sfv-plex-meta');
    info.appendChild(meta);

    var overview = el('div', 'sfv-plex-overview', '');
    info.appendChild(overview);
    var expand = el('button', 'sfv-plex-expand', '展开简介');
    expand.type = 'button'; expand.style.display = 'none';
    expand.addEventListener('click', function () {
      var willExpand = !overview.classList.contains('expanded');
      // 真实高度差 Δ：必须先读截断态 clientHeight，再临时解除 line-clamp 读完整高度。
      // 若在解除 clamp 之后才读 clientHeight，clientHeight 已变成完整高度，
      // scrollHeight - clientHeight 会得到 0，导致按钮区被简介撑高向下推。
      var delta = 0;
      if (willExpand) {
        var clampedH = overview.clientHeight;
        overview.style.webkitLineClamp = 'unset';
        var fullH = overview.scrollHeight;
        overview.style.webkitLineClamp = '';
        delta = fullH - clampedH;
      }
      var ex = overview.classList.toggle('expanded');
      expand.textContent = ex ? '收起简介' : '展开简介';
      if (ex && delta > 0) {
        // 仅信息区上移：transform 平滑滑动（标题/副标题/meta/简介/展开按钮整体上移）
        info.style.transform = 'translateY(-' + delta + 'px)';
        // marginBottom 即时补偿：抵消简介撑高对按钮区的布局下推，使按钮区真正纹丝不动
        info.style.marginBottom = '-' + delta + 'px';
      } else {
        info.style.transform = '';
        info.style.marginBottom = '';
      }
    });
    info.appendChild(expand);

    var actions = el('div', 'sfv-plex-actions');
    header.appendChild(actions);

    // 操作按钮组（药丸）
    var curTrack = (SFV.model && typeof SFV.model.getTrackStatusForKeys === 'function')
      ? SFV.model.getTrackStatusForKeys(trackKeysForView(view))
      : null;
    var btnPlay = mkPill('sfv-plex-pill--play', ICON.play, '播放');
    btnPlay.addEventListener('click', function () { if (SFV.detailSource && typeof SFV.detailSource.searchAndPick === 'function') SFV.detailSource.searchAndPick(view, sections); });
    actions.appendChild(btnPlay);

    var btnTrack = mkPill('', trackIcon(curTrack), '');
    _trackTriggerBtn = btnTrack;
    btnTrack.title = '追片：' + trackLabel(curTrack);
    actions.appendChild(btnTrack);

    var btnColl = mkPill('', ICON.add, '');
    // 收藏（片单夹）功能已删除：保留不可点图标占位（用户 2026-09-19 裁定）
    btnColl.disabled = true;
    btnColl.title = '收藏功能已下线';
    btnColl.setAttribute('aria-disabled', 'true');
    actions.appendChild(btnColl);

    // 章节容器（演员/相似/剧照）—— 副信息，滚动下滑才看到
    var sections = el('div', 'sfv-plex-sections');
    content.appendChild(sections);
    // 搜索来的会话：立刻挂「同系列」（不依赖 TMDB enrich）
    try { renderSearchSeasonSiblings(sections, view); } catch (e) {}

    // TMDB 署名（G4-A: 8px rgba(255,255,255,.25)）
    var attrib = el('div', 'sfv-plex-attrib', 'Data provided by The Movie Database');
    content.appendChild(attrib);

    // TMDB API Key 自填入口：点击打开设置弹窗（消硬编码默认 key 风险；localStorage 覆盖实时生效）
    var tmdbSettingsLink = el('button', 'sfv-plex-tmdb-settings', 'TMDB 设置');
    tmdbSettingsLink.type = 'button';
    tmdbSettingsLink.addEventListener('click', function (e) {
      e.stopPropagation();
      if (SFV.tmdb && typeof SFV.tmdb.openKeySettings === 'function') SFV.tmdb.openKeySettings();
    });
    content.appendChild(tmdbSettingsLink);

    // 追片：点击循环切换 6 态（逻辑与切换效果完全对照播放器底部控制栏 heart-btn）
    btnTrack.addEventListener('click', function (e) {
      e.stopPropagation();
      cycleTrackStatus(view);
    });

    // ESC 返回（G6：不误触播放器全屏 ESC，详情页无播放器）
    function escHandler(e) {
      if (e && (e.key === 'Escape' || e.keyCode === 27)) {
        // 多源面板打开时 Esc 先关面板，不退出详情页
        if (typeof StellaflixVideo !== 'undefined' && StellaflixVideo.sourcePicker &&
            StellaflixVideo.sourcePicker.isOpen && StellaflixVideo.sourcePicker.isOpen()) {
          e.preventDefault();
          e.stopPropagation();
          StellaflixVideo.sourcePicker.close();
          return;
        }
        e.stopPropagation();
        destroy(); onBack();
      }
    }
    doc.addEventListener('keydown', escHandler);

    function destroy() {
      doc.body.classList.remove('sfv-plex-immersive');
      doc.removeEventListener('keydown', escHandler);
      // 追片按钮引用随页面销毁释放：_trackTriggerBtn 是模块级变量，
      // 留着会让下一次 cycleTrackStatus 改写已卸载页面的陈旧节点（跨实例串扰）
      _trackTriggerBtn = null;
      // 清理轮播 resize 监听，避免详情页反复打开导致全局监听器堆积
      for (var i = 0; i < __railResizeHandlers.length; i++) {
        global.removeEventListener('resize', __railResizeHandlers[i]);
      }
      __railResizeHandlers = [];
      // 清理 logo 滚动动画（rAF 循环 / img.load / MutationObserver），避免堆积
      if (logoScrollState) {
        if (logoScrollState.rafId) cancelAnimationFrame(logoScrollState.rafId);
        if (logoScrollState.logoLoadHandler && logoScrollState.logoEl && logoScrollState.logoEl.querySelector) {
          var _img = logoScrollState.logoEl.querySelector('img');
          if (_img) _img.removeEventListener('load', logoScrollState.logoLoadHandler);
        }
        if (logoScrollState.mo) logoScrollState.mo.disconnect();
        logoScrollState = null;
      }
    }

    // 显式可控的 logo 滚动动画：
    // 浏览层滚动时，艺术 logo（.sfv-plex-logo-title / 文字回退 .sfv-plex-title-text）
    // 从首屏左下初始位置连续平滑平移到屏幕顶部中央
    // （垂直中心 = 视口高 12%，水平中心 = 视口宽 50%，避开顶部窗口控制胶囊），
    // 形成明显的"向右上方"弧线；滚动 ANIM_MAX 像素内完成（easeOutCubic 缓动）。
    // 进度 p=1 后 logo 钉在屏幕顶部中央，不再随滚动移动
    // （transform 中的 +s 正好抵消自然滚动的 -s）。
    function bindLogoScroll() {
      // 幂等：先清理上一次绑定（build 兜底 / enrich 重绑），避免重复驱动
      if (logoScrollState) {
        if (logoScrollState.rafId) cancelAnimationFrame(logoScrollState.rafId);
        if (logoScrollState.logoLoadHandler && logoScrollState.logoEl && logoScrollState.logoEl.querySelector) {
          var _im0 = logoScrollState.logoEl.querySelector('img');
          if (_im0) _im0.removeEventListener('load', logoScrollState.logoLoadHandler);
        }
        if (logoScrollState.mo) logoScrollState.mo.disconnect();
        logoScrollState = null;
      }
      var scroller = (root.closest && root.closest('.sfv-browse-body')) || (doc.querySelector && doc.querySelector('.sfv-browse-body'));
      if (!scroller) return;
      var ANIM_MAX = 600;            // 完成动画所需滚动距离（px）
      var TARGET_TOP_RATIO = 0.12;   // 终点：logo 垂直中心落在视口高度的 12%（屏幕顶部中央附近）
      var TARGET_LEFT_RATIO = 0.5;   // 终点：logo 水平中心位于视口宽度的 50%（屏幕顶部中央）
      var SCALE_MIN = 0.65;         // 终点：logo 缩放到原尺寸的 65%
      var initial = null, rafId = 0, logoLoadHandler = null, logoEl = null;

      function getLogo() {
        return root.querySelector('.sfv-plex-logo-title') || root.querySelector('.sfv-plex-title-text');
      }
      function measure() {
        if (!logoEl) return;
        var r = logoEl.getBoundingClientRect();
        // 文档坐标：initial.left/top 取「s=0 时的视口坐标」，消除 enrich 异步 + 已滚动时
        // measure 的时机依赖（无论 measure 时页面滚到哪，文档坐标恒定）
        var st = scroller.scrollTop || 0;
        initial = { left: r.left + st, top: r.top + st, width: r.width };
      }
      function update() {
        if (!logoEl || !initial) return;
        var s = scroller.scrollTop || 0;
        var p = Math.min(s / ANIM_MAX, 1);
        var eased = 1 - Math.pow(1 - p, 3);                 // easeOutCubic
        var vw = scroller.clientWidth || (global.innerWidth || 0);
        var vh = scroller.clientHeight || (global.innerHeight || 0);
        // 终点：logo 垂直中心落在屏幕顶部中央（视口高度 12%），
        // 水平中心落在视口宽度的 50% 处（顶部中央）
        var targetTop = vh * TARGET_TOP_RATIO;
        var targetLeft = vw * TARGET_LEFT_RATIO - initial.width / 2;
        var dx = (targetLeft - initial.left) * eased;      // 水平右移
        var dy = (targetTop - initial.top) * eased + s;    // 垂直上移 + 抵消自然滚动（终点钉在屏幕顶部中央）
        var sc = 1 - (1 - SCALE_MIN) * eased;              // 随滚动逐渐缩小
        logoEl.style.transform = 'translate(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px) scale(' + sc.toFixed(3) + ')';
        if (!logoEl.style.zIndex) logoEl.style.zIndex = '4';
        if (!logoEl.style.willChange) logoEl.style.willChange = 'transform';
      }
      // rAF 持续驱动：不依赖 scroll 事件是否触发（部分布局/容器下 scroll 监听可能不命中），
      // 每帧读 scrollTop 并刷新 transform；详情页 destroy 时统一取消
      function tick() {
        update();
        rafId = requestAnimationFrame(tick);
      }
      function attach() {
        if (rafId) cancelAnimationFrame(rafId);
        logoEl = getLogo();
        if (!logoEl) return false;
        // 测试探针（受保护：仅当外部设置 window.__logoHook 时触发，生产中无副作用）
        if (typeof window !== 'undefined' && typeof window.__logoHook === 'function') window.__logoHook(logoEl);
        measure();
        update();
        var img = logoEl.querySelector ? logoEl.querySelector('img') : null;
        if (img) {
          logoLoadHandler = function () { measure(); update(); };
          img.addEventListener('load', logoLoadHandler);
        }
        rafId = requestAnimationFrame(tick);
        logoScrollState = { scroller: scroller, logoEl: logoEl, logoLoadHandler: logoLoadHandler, rafId: rafId };
        return true;
      }
      var attached = attach();
      if (typeof MutationObserver !== 'undefined') {
        // logo 由 enrich 异步创建/替换（如 TMDB logo 加载失败回退为文字标题），
        // 监听 titleWrap 子节点变化，一旦发现当前动画目标与 DOM 中实际 logo 不一致就重绑。
        var mo = new MutationObserver(function () {
          var current = getLogo();
          if (current && current !== logoEl) { attach(); }
        });
        mo.observe(titleWrap, { childList: true, subtree: true });
        if (!logoScrollState) logoScrollState = { scroller: scroller };
        logoScrollState.mo = mo;
      }
    }
    D.bindLogoScroll = bindLogoScroll;

    // 异步 enrich（TMDB 富信息；失败静默保留基础渲染）
    enrich(bg, titleWrap, subtitle, meta, overview, expand, sections, view);

    // logo 滚动动画：随浏览层滚动从初始位置平滑移动到屏幕右上角
    bindLogoScroll();

    return { destroy: destroy };
  }

  // 叠加 DOM 层（build）到基础 facade（detail-core.js 已含纯数据层）。
  // 若 detail-core.js 未先于本文件加载，SFV.detail 可能为 undefined；
  // 正常运行由 index.html 顺序保证。保留缺失守卫以防异常顺序。
  if (!SFV.detail) SFV.detail = {};
  Object.assign(SFV.detail, { build: build, el: el, esc: esc, toast: toast });
})(typeof window !== 'undefined' ? window : this);
