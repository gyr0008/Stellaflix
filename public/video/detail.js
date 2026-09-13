/*
 * Stellaflix 影视详情页（Plex 风）—— detail.js
 * ----------------------------------------------------------------
 * 设计契约见 player.css .sfv-detail-plex 注释 + 2026-08-06 协同设计决议：
 *   整页海报 fixed 铺满 + 仅底部 50% 暗渐变；左上圆形返回 + 右上 Plex 胶囊(-□×)；
 *   白色标题(甲:优先海报扣取,回退 TMDB 文字)；药丸操作组(播放/追片6态/收藏/下载)；
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
    download: svg('<path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/>'),
    add:      svg('<path d="M12 5v14M5 12h14"/>'),
    // Plex 窗口控制专用图标 —— 差异②：放大到 20px 并加粗 stroke，
    // 让 − □ × 在窄胶囊里也清晰(参照左侧参考图粗体图标)
    min:      '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10" width="16" height="4" rx="2" fill="currentColor"/></svg>',
    max:      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2.5" stroke="currentColor" stroke-width="2.4"/></svg>',
    close:    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>'
  };

  // 收藏面板内联图标（勾选 / 小加号），与 ICON 同源 stroke 风格
  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var PLUS_SM_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

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

  // 追片：点击循环切换 6 态（与播放器底部控制栏 heart-btn 完全一致：
  //   纯图标刷新 + 互斥单值 6 态循环 + toast 提示；无下拉菜单）。
  function cycleTrackStatus(view) {
    var key = view && view.key;
    if (!key || !SFV.model || typeof SFV.model.getTrackStatus !== 'function' || typeof SFV.model.setTrackStatus !== 'function') return;
    var status = SFV.model.getTrackStatus(key);
    var keys = TRACK_MENU.map(function (m) { return m.key; });
    var idx = keys.indexOf(status);
    var next = keys[(idx + 1) % keys.length];
    SFV.model.setTrackStatus(key, next);
    // 纯图标刷新（对照 heart-btn：仅图标，无文字），并同步 title
    if (_trackTriggerBtn) {
      _trackTriggerBtn.innerHTML = trackIcon(next);
      _trackTriggerBtn.title = '追片：' + trackLabel(next);
    }
    toast('已设为：' + trackLabel(next));
  }

  // ---- ＋收藏：片单夹面板（列出用户自建片单分类，点击切换加入/移出）----
  var _collectTriggerBtn = null;

  // 当前内容是否已在该片单夹（按 view.key 身份判定）
  function isCollectedIn(folder, view) {
    var id = view && view.key;
    if (!id || !folder || !folder.items) return false;
    for (var i = 0; i < folder.items.length; i++) {
      if (folder.items[i].id === id) return true;
    }
    return false;
  }
  function collectedFolderCount(folders, view) {
    var n = 0;
    for (var i = 0; i < folders.length; i++) if (isCollectedIn(folders[i], view)) n++;
    return n;
  }
  // 刷新触发器：反映「已收藏」状态（状态及时更新）
  function refreshCollectBtn(view) {
    if (!_collectTriggerBtn) return;
    var folders = (SFV.collections && SFV.collections.listUserFolders) ? SFV.collections.listUserFolders() : [];
    var n = collectedFolderCount(folders, view);
    if (n > 0) {
      _collectTriggerBtn.classList.add('collected');
      _collectTriggerBtn.setAttribute('aria-label', '已收藏，加入 ' + n + ' 个片单');
      _collectTriggerBtn.title = '已收藏（' + n + ' 个片单）';
    } else {
      _collectTriggerBtn.classList.remove('collected');
      _collectTriggerBtn.setAttribute('aria-label', '收藏到片单');
      _collectTriggerBtn.title = '收藏到片单';
    }
  }
  function collectItemPayload(view) {
    return {
      id: view.key,
      mediaType: view.mediaType || 'movie',
      title: view.title || '',
      // FIX: 兼容 pic / poster 两种字段，避免某些入口只传了 poster 时片单丢失海报
      poster: view.pic || view.poster || '',
      year: view.year || '',
      key: view.key
    };
  }

  function openCollectPanel(anchorBtn, view) {
    if (!SFV.collections) { toast('片单功能未就绪'); return; }
    var menu = anchorBtn.querySelector('.sfv-coll-popover');
    // 已打开则收回（再次点击按钮关闭）
    if (menu && menu.classList.contains('open')) {
      menu.classList.remove('open');
      return;
    }
    if (!menu) { menu = el('div', 'sfv-coll-popover'); anchorBtn.appendChild(menu); }
    // 影视模块无登录体系：片单为本地 localStorage；此处仅做存储可用性边界
    var LS = (typeof global !== 'undefined' && global.localStorage) ? global.localStorage : null;
    if (!LS) {
      menu.innerHTML = '';
      menu.appendChild(el('div', 'sfv-coll-empty', '当前环境无法保存片单（无本地存储）'));
      menu.classList.add('open');
      return;
    }
    renderCollectPanel(menu, anchorBtn, view);
    menu.classList.add('open');
  }

  function renderCollectPanel(menu, anchorBtn, view) {
    menu.innerHTML = '';
    var folders = SFV.collections.listUserFolders();

    menu.appendChild(el('div', 'sfv-coll-head', '收藏到片单'));

    if (!folders.length) {
      menu.appendChild(el('div', 'sfv-coll-empty', '还没有片单夹，先建一个吧'));
    } else {
      var list = el('div', 'sfv-coll-list');
      folders.forEach(function (f) {
        var inF = isCollectedIn(f, view);
        var item = el('button', 'sfv-plex-track-item' + (inF ? ' active' : ''));
        item.type = 'button';
        item.innerHTML = (inF ? CHECK_SVG : PLUS_SM_SVG) +
          '<span class="lbl">' + esc(f.name || '片单') + '</span>' +
          '<span class="cnt">' + (f.items ? f.items.length : 0) + '</span>';
        item.addEventListener('click', function (e) {
          e.stopPropagation();
          toggleCollect(f.id, inF, view);
          renderCollectPanel(menu, anchorBtn, view); // 就地刷新：勾选状态及时更新
        });
        list.appendChild(item);
      });
      menu.appendChild(list);
    }

    var create = el('button', 'sfv-coll-create', '＋ 新建片单夹');
    create.type = 'button';
    create.addEventListener('click', function (e) {
      e.stopPropagation();
      var name = (global.prompt ? global.prompt('片单夹名称', '我的片单') : '') || '';
      name = name.trim();
      if (!name) return;
      // createUserFolder 返回 folderId（修正旧版把它当对象取 .id 的 bug）
      var fid = SFV.collections.createUserFolder(name);
      if (fid) SFV.collections.addUserItem(fid, collectItemPayload(view));
      toast('已新建并加入「' + name + '」');
      renderCollectPanel(menu, anchorBtn, view);
      refreshCollectBtn(view);
    });
    menu.appendChild(create);
  }

  function toggleCollect(folderId, currentlyIn, view) {
    if (!folderId || !SFV.collections) return;
    var folders = SFV.collections.listUserFolders();
    var f = null;
    for (var i = 0; i < folders.length; i++) if (folders[i].id === folderId) { f = folders[i]; break; }
    if (!f) return;
    if (currentlyIn) {
      SFV.collections.removeUserItem(folderId, view.key); // 按 id 移出
      toast('已移出「' + (f.name || '片单') + '」');
    } else {
      SFV.collections.addUserItem(folderId, collectItemPayload(view)); // 按 id 去重
      toast('已加入片单「' + (f.name || '片单') + '」');
    }
    refreshCollectBtn(view);
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
        if (m.kind === 'similar') {
          var cap = el('div', 'sfv-plex-card__cap');
          card.appendChild(cap);
          loadSimilarLogo(m, cap);
          // 点击整张卡片跳转该影片详情页
          card.style.cursor = 'pointer';
          card.addEventListener('click', function () { openSimilarDetail(m); });
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
        // 背景替换为 TMDB backdrop
        if (b.backdrop) bg.style.backgroundImage = 'url("' + esc(b.backdrop) + '")';
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
    var curTrack = (SFV.model && typeof SFV.model.getTrackStatus === 'function') ? SFV.model.getTrackStatus(view.key) : null;
    var btnPlay = mkPill('sfv-plex-pill--play', ICON.play, '播放');
    btnPlay.addEventListener('click', function () { if (SFV.detailSource && typeof SFV.detailSource.searchAndPick === 'function') SFV.detailSource.searchAndPick(view, sections); });
    actions.appendChild(btnPlay);

    var btnTrack = mkPill('', trackIcon(curTrack), '');
    _trackTriggerBtn = btnTrack;
    btnTrack.title = '追片：' + trackLabel(curTrack);
    actions.appendChild(btnTrack);

    var btnColl = mkPill('', ICON.add, '');
    _collectTriggerBtn = btnColl;
    btnColl.title = '收藏到片单';
    actions.appendChild(btnColl);

    var btnDl = mkPill('', ICON.download, '');
    btnDl.title = '下载';
    btnDl.addEventListener('click', function () { toast('下载功能开发中'); });
    actions.appendChild(btnDl);

    // 章节容器（演员/相似/剧照）—— 副信息，滚动下滑才看到
    var sections = el('div', 'sfv-plex-sections');
    content.appendChild(sections);

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

    // ＋收藏：打开片单夹面板（影视态无登录，片单为本地 localStorage）
    refreshCollectBtn(view);
    btnColl.addEventListener('click', function (e) {
      e.stopPropagation();
      openCollectPanel(btnColl, view);
    });
    doc.addEventListener('click', closeCollectMenu);
    function closeCollectMenu() {
      var m = _collectTriggerBtn && _collectTriggerBtn.querySelector('.sfv-coll-popover');
      if (m && m.classList.contains('open')) m.classList.remove('open');
    }

    // ESC 返回（G6：不误触播放器全屏 ESC，详情页无播放器）
    function escHandler(e) {
      if (e && (e.key === 'Escape' || e.keyCode === 27)) {
        e.stopPropagation();
        destroy(); onBack();
      }
    }
    doc.addEventListener('keydown', escHandler);

    function destroy() {
      doc.body.classList.remove('sfv-plex-immersive');
      doc.removeEventListener('keydown', escHandler);
      doc.removeEventListener('click', closeCollectMenu);
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
