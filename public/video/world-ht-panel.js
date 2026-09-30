/*!
 * 世界页灯塔卡片面板（步骤④-4）—— hearthere.live ht-panel 逐字移植
 *
 * 事实源 _scratch/hearthere/main.pretty.js：
 *   Rd 外壳 .nav-bar/.nav-panel--station :3189-3345（station tab 无外壳关闭钮 :3301）
 *   Xf station-showcase :7304-7414 · sp ht-panel :7534-7686
 *   图标 Jf :7415 / tp :7436 / ao :7443 / ns :7487 / Yf :7268 / Zf :7276
 *   动作表 Xs :7507-7532 · 纯函数 $f :7120 / Wf :7125 / el :16620 / ni :7284 / Dr :4191
 *   开卡语义 wt :19638-19653（面板先开、相机后飞）· 空白点击 no-op Us :19826
 *   入场 = @keyframes nav-panel-in（CSS 一次性关键帧）；station tab 不接 fi :10393-10404 → 无退场帧
 *
 * 已裁决的等价改写（不进语义）：
 *   · React JSX → 原生 DOM 构建；useState/useLayoutEffect → 显式 refreshMarquee/refreshScale。
 *   · 无 Supabase 面（用户 2026-09-27）：聊天 / 导播台 / 直播倒计时 / 主播离开告警 /
 *     收听数实时订阅（zg）/ 收藏表（station_favorites）不 port；
 *     收藏星接本地 worldMapActions，people→listenerCount 槽、title→description 槽。
 *   · Apple Music 授权按钮（Lr）不 port → A==='authorize' 落 unavailable 单按钮支路（本地恒授权，不可达）。
 *   · 国旗数据集（Yl）不存在 → Gf/Qf 支路留 opts.flagUrlFor 注入点，缺省回落 avatar（不凭空造旗）。
 *   · Dr 渐进小图依赖 station-assets CDN 后缀 → 本地无该资产面，恒 null（hero 单层图）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // ============================================================
  //  文案表（zh 逐字 :148-283；CTA 动作文字按裁决甲换本地语义，键名保持 hearthere 原键）
  // ============================================================
  var TEXT = {
    'common.loading': '加载中',
    'common.closePanel': '关闭面板',
    'station.showcase.defaultDescription': '关于这个声音信标，主播什么也没说',
    'station.showcase.unnamed': '声音信标 {id}',
    'station.action.authorize': '绑定 Apple Music 开始收听',
    'station.action.tuneIn': '进入房间',
    'station.action.stop': '退出观看',
    'station.action.nextStation': '下一个电台',
    'station.action.offline': '离线',
    'station.action.idle': '待机中',
    'station.action.favorite': '收藏声音信标',
    'station.action.unfavorite': '取消收藏'
  };

  function showcaseText(key, params) {
    var s = TEXT[key] || key;
    if (params) {
      s = s.replace(/\{(\w+)\}/g, function (_, k) {
        return params[k] != null ? String(params[k]) : '';
      });
    }
    return s;
  }

  // Xs :7507-7532（icon 字段改由图标构造器给）
  var ACTION_TABLE = {
    authorize: { labelKey: 'station.action.authorize', icon: 'broadcast' },
    tune_in: { labelKey: 'station.action.tuneIn', icon: 'broadcast' },
    stop: { labelKey: 'station.action.stop', icon: 'stop' },
    next_station: { labelKey: 'station.action.nextStation', icon: 'broadcast' },
    offline: { labelKey: 'station.action.offline', icon: 'stop' },
    idle: { labelKey: 'station.action.idle', icon: 'stop' }
  };

  // ============================================================
  //  纯函数（逐字）
  // ============================================================

  // $f :7120-7123
  function locationText(st) {
    var parts = [st.city, st.region, st.country].filter(Boolean);
    if (parts.length > 0) return parts.join(', ');
    return st.position[0].toFixed(2) + '°, ' + st.position[1].toFixed(2) + '°';
  }

  // Wf :7125-7127
  function actionState(st, listeningStationId, isAuthorized) {
    if (!isAuthorized) return 'authorize';
    if (listeningStationId === st.id) return 'stop';
    return st.status === 'offline' ? 'offline' : 'tune_in';
  }

  // el :16620-16641
  function clickDecision(o) {
    var isMine = o.myStationId !== null && o.clickedStationId === o.myStationId;
    var isListening = o.listeningStationId === o.clickedStationId;
    if (isMine) return { type: 'open_station_panel', stationId: o.clickedStationId, autoTune: false };
    if (o.isBroadcasting) return { type: 'confirm_stop_broadcast', stationId: o.clickedStationId };
    return {
      type: 'open_station_panel',
      stationId: o.clickedStationId,
      autoTune: !!(o.isMusicAuthorized && !isListening && (o.stationStatus === 'playing' || o.stationStatus === 'live_idle'))
    };
  }

  // :19973 canGoNextStation = ge.some(k => k.status === 'playing' && k.id !== it.id)
  function canGoNextStation(stations, id) {
    for (var i = 0; i < (stations || []).length; i++) {
      var k = stations[i];
      if (k && k.status === 'playing' && k.id !== id) return true;
    }
    return false;
  }

  // Dr :4191-4197（本地无 station-assets CDN 后缀面 → 恒 null）
  function progressiveThumb() { return null; }

  // 本地数据源 → hearthere 槽位（people→listenerCount、title→description）
  function panelRecord(st) {
    var r = {};
    for (var k in st) { if (Object.prototype.hasOwnProperty.call(st, k)) r[k] = st[k]; }
    if (r.listenerCount == null && r.people != null) r.listenerCount = r.people;
    if (r.description == null && r.descriptionZh == null && r.descriptionEn == null && r.title != null) {
      r.description = r.title;
    }
    return r;
  }

  // ============================================================
  //  DOM 构造（hearthre JSX → 原生）
  // ============================================================

  function mk(tag, cls, text) {
    var e = global.document.createElement(tag);
    if (cls) e.setAttribute('class', cls);
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function mkSvg(viewBox, cls, children) {
    var svg = global.document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('viewBox', viewBox);
    for (var i = 0; i < children.length; i++) {
      var node = children[i];
      var el = global.document.createElementNS(SVG_NS, node.tag);
      for (var a in node) {
        if (Object.prototype.hasOwnProperty.call(node, a) && a !== 'tag') el.setAttribute(a, node[a]);
      }
      svg.appendChild(el);
    }
    return svg;
  }

  // Jf :7415-7426 关闭叉
  function iconClose() {
    var p = { tag: 'path', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M18 6 6 18M6 6l12 12' };
    return mkSvg('0 0 24 24', 'ht-icon', [p]);
  }
  // tp :7436-7442 收藏星
  function iconStar() {
    return mkSvg('0 0 24 24', 'ht-icon', [{ tag: 'path', d:
      'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z' }]);
  }
  // ao :7443-7464 电波（authorize/tuneIn/nextStation 共用）
  function iconBroadcast() {
    return mkSvg('0 0 24 24', 'ht-icon', [
      { tag: 'path', d: 'M4.9 19.1C1 15.2 1 8.8 4.9 4.9' },
      { tag: 'path', d: 'M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5' },
      { tag: 'circle', cx: '12', cy: '12', r: '2' },
      { tag: 'path', d: 'M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5' },
      { tag: 'path', d: 'M19.1 4.9C23 8.8 23 15.2 19.1 19.1' }
    ]);
  }
  // ns :7487-7498 停止方
  function iconStop() {
    return mkSvg('0 0 24 24', 'ht-icon filled', [{ tag: 'rect', x: '6', y: '6', width: '12', height: '12', rx: '2' }]);
  }
  // Yf :7268-7275 位置别针
  function iconPin() {
    return mkSvg('0 0 24 24', 'ht-icon filled', [{ tag: 'path', fill: 'currentColor', d:
      'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z' }]);
  }
  // Zf :7276-7282 收听人数
  function iconListeners() {
    return mkSvg('0 0 28 28', 'ht-icon filled', [{ tag: 'path', d:
      'M9.5 14a4.5 4.5 0 1 0 0-9a4.5 4.5 0 0 0 0 9m7.6 7.619c.763.235 1.714.381 2.9.381c6 0 6-3.75 6-3.75A2.25 2.25 0 0 0 23.75 16h-6.656a3.24 3.24 0 0 1 .904 2.25v.555l-.003.083a5.5 5.5 0 0 1-.154.99a6.1 6.1 0 0 1-.74 1.74M23.5 10.5a3.5 3.5 0 1 1-7 0a3.5 3.5 0 0 1 7 0M2 18.25A2.25 2.25 0 0 1 4.25 16h10.5A2.25 2.25 0 0 1 17 18.25v.5S17 24 9.5 24S2 18.75 2 18.75z' }]);
  }
  function ctaIcon(name) {
    return name === 'stop' ? iconStop() : iconBroadcast();
  }

  // Ur :7264-7267 等价物：唯一真源在 ④-3（world-lighthouse-deck.stationAvatarUrl）
  function avatarUrl(st) {
    var deck = SFV.worldLighthouseDeck;
    if (deck && typeof deck.stationAvatarUrl === 'function') return deck.stationAvatarUrl(st);
    return '';
  }

  function marquee(cls, text, box) {
    var span = mk('span', null, text);
    box.appendChild(span);
    box.__marquee = { cls: cls, text: text };
    return box;
  }

  function measureScroll(container, textEl) {
    var c = container.offsetWidth || 0;
    var t = Math.max(textEl.offsetWidth || 0, textEl.scrollWidth || 0);
    return t > c;
  }

  // 对单个 marquee 槽位施加/解除 is-scrolling（:7378 v ? ' is-scrolling' + 克隆 : 单 span）
  function applyMarquee(box, isDocument) {
    if (!box || !box.__marquee) return;
    var textEl = box.children[0];
    var need = !!isDocument && textEl ? measureScroll(box, textEl) : false;
    if (need && box.children.length < 2) {
      var clone = mk('span', null, box.__marquee.text);
      clone.setAttribute('aria-hidden', 'true');
      box.appendChild(clone);
    } else if (!need && box.children.length > 1) {
      while (box.children.length > 1) box.removeChild(box.children[box.children.length - 1]);
    }
    box.classList.toggle('is-scrolling', need);
  }

  function refreshMarquee() {
    var p = panelEl();
    if (!p) return;
    var boxes = [];
    var showcase = p.children[1];
    if (!showcase) return;
    walk(showcase, function (e) { if (e.__marquee) boxes.push(e); });
    for (var i = 0; i < boxes.length; i++) applyMarquee(boxes[i], true);
  }

  function walk(node, fn) {
    for (var i = 0; i < (node.children || []).length; i++) {
      var c = node.children[i];
      fn(c);
      walk(c, fn);
    }
  }

  // ============================================================
  //  Xf station-showcase（:7304-7414）
  // ============================================================
  function buildShowcase(st, opts) {
    opts = opts || {};
    var detail = panelRecord(st);
    var d = !!(detail.city || detail.region || detail.country);
    var f = opts.isDetailLoading && !d ? showcaseText('common.loading') : locationText(detail);
    var p = opts.showLiveBadge !== undefined ? opts.showLiveBadge : detail.status !== 'offline';
    var uRaw = detail.descriptionZh != null ? detail.descriptionZh
      : detail.descriptionEn != null ? detail.descriptionEn : detail.description;
    var descText = (opts.isDetailLoading && !uRaw) ? showcaseText('common.loading')
      : (uRaw || showcaseText('station.showcase.defaultDescription'));
    var m = detail.displayKind != null ? detail.displayKind : detail.ownerType;
    var y = detail.name || showcaseText('station.showcase.unnamed', { id: detail.id });
    var flagBranch = m === 'system' && !!detail.countryCode && !detail.avatarUrl;
    var P = avatarUrl(detail);
    var M = flagBranch && typeof opts.flagUrlFor === 'function' ? opts.flagUrlFor(detail.countryCode) : '';
    var R = detail.coverUrl || (detail.avatarUrl ? P : null);
    var C = detail.coverUrl ? progressiveThumb(detail.coverUrl) : null;

    var showcase = mk('div', 'station-showcase');

    // hero
    var hero = mk('div', 'station-panel__hero' + (C ? ' has-progressive-thumb' : ''));
    if (C) {
      var thumb = mk('img', 'station-panel__hero-thumb');
      thumb.setAttribute('src', C); thumb.setAttribute('alt', '');
      hero.appendChild(thumb);
    }
    if (R) {
      var img = mk('img', 'station-panel__hero-img' + (C ? ' has-progressive-thumb' : ''));
      img.setAttribute('src', R); img.setAttribute('alt', '');
      img.addEventListener('load', function () {
        img.classList.add('is-loaded'); hero.classList.add('is-hero-loaded');
      });
      img.addEventListener('error', function () {
        img.classList.remove('is-loaded'); hero.classList.remove('is-hero-loaded');
      });
      hero.appendChild(img);
    }
    hero.appendChild(mk('div', 'station-panel__hero-vignette'));
    if (p) {
      var toolbar = mk('div', 'station-panel__toolbar');
      toolbar.appendChild(mk('span', 'ht-badge live', 'LIVE'));
      hero.appendChild(toolbar);
    }

    // content
    var content = mk('div', 'station-panel__content');
    var info = mk('div', 'station-panel__info');
    var box = mk('div', 'station-panel__avatar-box');
    if (M) {
      var flag = mk('img', 'station-panel__flag');
      flag.setAttribute('src', M); flag.setAttribute('alt', '');
      box.appendChild(flag);
    } else {
      var av = mk('div', 'ht-avatar station-panel__avatar');
      av.style.width = '100%';
      av.style.height = '100%';
      av.style.background = "url('" + P + "') center / cover no-repeat";
      av.style.border = 'none';
      box.appendChild(av);
    }
    var meta = mk('div', 'station-panel__meta');
    var h3 = mk('h3', 'station-panel__name');
    marquee('station-panel__name', y, h3);
    meta.appendChild(h3);
    if (f) {
      var loc = mk('div', 'station-panel__location');
      loc.appendChild(iconPin());
      var lt = mk('div', 'station-panel__location-text');
      marquee('station-panel__location-text', f, lt);
      loc.appendChild(lt);
      meta.appendChild(loc);
    }
    info.appendChild(box);
    info.appendChild(meta);

    var descCls = 'station-panel__desc ht-scrollbar' + (uRaw ? '' : ' station-panel__desc--placeholder');
    var desc = mk('p', descCls, descText);

    var actions = mk('div', 'station-panel__actions');
    var listeners = mk('div', 'station-panel__listeners');
    listeners.appendChild(iconListeners());
    listeners.appendChild(mk('span', null,
      opts.isDetailLoading && listenersCountOf(detail) === null ? '...' : listenersCountOf(detail)));
    actions.appendChild(listeners);
    var group = buildActionGroup(detail, opts);
    if (group) actions.appendChild(group);

    content.appendChild(info);
    content.appendChild(desc);
    content.appendChild(actions);
    content.appendChild(buildCta(detail, opts));

    showcase.appendChild(hero);
    showcase.appendChild(content);
    return showcase;
  }

  function listenersCountOf(st) {
    return st.listenerCount != null ? st.listenerCount : null;
  }

  // sp actions 支路（:7616-7632）：聊天/导播台属 Supabase 面不 port，仅收藏星
  function buildActionGroup(st, opts) {
    if (typeof opts.onFavorite !== 'function' && opts.isFavorite === undefined) return null;
    var group = mk('div', 'station-panel__action-group');
    var fav = mk('button', 'ht-icon-btn station-panel__action-icon-btn' + (opts.isFavorite ? ' is-active' : ''));
    fav.setAttribute('aria-label', showcaseText(opts.isFavorite ? 'station.action.unfavorite' : 'station.action.favorite'));
    fav.appendChild(iconStar());
    fav.addEventListener('click', function () {
      if (typeof opts.onFavorite === 'function') opts.onFavorite(st);
    });
    group.appendChild(fav);
    return group;
  }

  // sp cta 支路（:7634-7683）
  function buildCta(st, opts) {
    var A = opts.actionState;
    var J = ACTION_TABLE[A] || ACTION_TABLE.tune_in;
    var disabled = A === 'offline' || A === 'idle' || (A === 'authorize' && !!opts.isMusicAuthLoading);
    var T = A === 'stop' || A === 'tune_in';
    var onAction = typeof opts.onAction === 'function' ? opts.onAction : function () {};

    // Lr Apple Music 授权按钮不 port（裁决甲）：authorize 落 unavailable 单按钮支路
    if (T) {
      var row = mk('div', 'station-panel__cta-row');
      var cur = mk('button', 'ht-btn station-panel__cta station-panel__cta--current ' +
        (A === 'stop' ? 'station-panel__cta--stop danger' : 'primary station-panel__cta--tune-in-cyan'));
      cur.disabled = disabled;
      var curIcon = mk('span', 'station-panel__cta-icon');
      curIcon.appendChild(ctaIcon(J.icon));
      cur.appendChild(curIcon);
      cur.appendChild(mk('span', null, showcaseText(J.labelKey)));
      cur.addEventListener('click', function () { onAction(A); });
      row.appendChild(cur);

      var next = mk('button', 'ht-btn primary station-panel__cta station-panel__cta--next station-panel__cta--tune-in-cyan');
      next.disabled = !opts.canGoNext;
      var nextIcon = mk('span', 'station-panel__cta-icon');
      nextIcon.appendChild(ctaIcon(ACTION_TABLE.next_station.icon));
      next.appendChild(nextIcon);
      next.appendChild(mk('span', null, showcaseText(ACTION_TABLE.next_station.labelKey)));
      next.addEventListener('click', function () { onAction('next_station'); });
      row.appendChild(next);
      return row;
    }

    var btn = mk('button', 'ht-btn station-panel__cta ' +
      (A === 'offline' || A === 'idle' || A === 'authorize' ? 'secondary is-disabled station-panel__cta--unavailable' : 'secondary'));
    btn.disabled = disabled;
    var ic = mk('span', 'station-panel__cta-icon');
    ic.appendChild(ctaIcon(J.icon));
    btn.appendChild(ic);
    btn.appendChild(mk('span', null, showcaseText(J.labelKey)));
    btn.addEventListener('click', function () { onAction(A); });
    return btn;
  }

  // ============================================================
  //  sp ht-panel（:7593-7600）
  // ============================================================
  function buildPanel(stationIn, opts) {
    opts = opts || {};
    var st = stationIn || {};
    var isAuthorized = opts.isAuthorized !== false;   // 本地无 Music 授权门（裁决甲）
    var listening = opts.listeningStationId != null ? opts.listeningStationId : null;
    var A = opts.actionState || actionState(st, listening, isAuthorized);
    opts.actionState = A;
    if (opts.canGoNext === undefined) opts.canGoNext = true;
    if (opts.showLiveBadge === undefined) opts.showLiveBadge = st.status !== 'offline';

    var root = mk('div', 'ht-panel');
    var close = mk('button', 'ht-icon-btn ht-icon-btn--overlay ht-panel__close');
    close.setAttribute('aria-label', showcaseText('common.closePanel'));
    close.appendChild(iconClose());
    close.addEventListener('click', function () {
      if (typeof opts.onClose === 'function') opts.onClose();
    });
    root.appendChild(close);
    root.appendChild(buildShowcase(st, opts));
    root.__opts = opts;
    root.__station = st;
    return root;
  }

  // ============================================================
  //  Rd 外壳（:3189-3345）：.nav-bar > .nav-panel.nav-panel--station > .ht-panel
  //  station tab：A=false → 外壳无关闭钮（:3301）；内容 = stationContent（:3270）
  // ============================================================
  var Ld = 0.45;                 // :3187 移动端缩放系数
  var state = { host: null, navBar: null, panel: null, opts: null };

  function mount(host) {
    if (!host) return;
    unmount();
    state.host = host;
    state.navBar = mk('div', 'nav-bar');
    host.appendChild(state.navBar);
    if (global.addEventListener) {
      global.addEventListener('resize', onResize);
    }
  }

  function onResize() {
    refreshScale();
    refreshMarquee();
  }

  function unmount() {
    close();
    if (state.navBar && state.navBar.parentNode) state.navBar.parentNode.removeChild(state.navBar);
    if (global.removeEventListener) global.removeEventListener('resize', onResize);
    state.host = null; state.navBar = null;
  }

  function open(stationIn, opts) {
    if (!state.navBar) return false;
    clearShell();
    opts = opts || {};
    var panel = buildPanel(stationIn, Object.assign({}, opts, {
      onClose: function () { close(); }
    }));
    var shell = mk('div', 'nav-panel nav-panel--station');
    shell.style.setProperty('--nav-panel-mobile-scale', String(state.scale || 1));
    shell.appendChild(panel);
    state.navBar.appendChild(shell);
    state.panel = panel;
    state.opts = opts;
    refreshScale();
    refreshMarquee();
    return true;
  }

  // It(null) 等价（:19971）：卸载外壳并回调应用侧一次
  function close() {
    var cb = state.opts && state.opts.onClose;
    clearShell();
    if (typeof cb === 'function') cb();
  }

  // 换台/重挂用的静默卸载：不得触发上一张面板的 onClose
  function clearShell() {
    if (state.navBar) {
      for (var i = state.navBar.children.length - 1; i >= 0; i--) {
        state.navBar.removeChild(state.navBar.children[i]);
      }
    }
    state.panel = null;
    state.opts = null;
  }

  // Rd :3210-3224 移动端缩放（桌面恒 1）
  function refreshScale() {
    var shell = state.panel && state.panel.parentNode;
    if (!shell) return;
    var mq = typeof global.matchMedia === 'function' ? global.matchMedia('(max-width: 767px)') : null;
    if (!mq || !mq.matches) { state.scale = 1; shell.style.setProperty('--nav-panel-mobile-scale', '1'); return; }
    var H = shell.offsetHeight;
    var V = (global.visualViewport && global.visualViewport.height) || global.innerHeight ||
      (global.document && global.document.documentElement && global.document.documentElement.clientHeight);
    if (!isFinite(H) || !isFinite(V) || H <= 0 || V <= 0) { state.scale = 1; return; }
    var next = Math.min(1, V * Ld / H);
    state.scale = Math.abs((state.scale || 1) - next) < 0.001 ? (state.scale || 1) : next;
    shell.style.setProperty('--nav-panel-mobile-scale', String(state.scale));
  }

  function isOpen() { return !!state.panel; }
  function panelEl() { return state.panel || null; }

  SFV.worldHtPanel = {
    TEXT: TEXT,
    ACTION_TABLE: ACTION_TABLE,
    showcaseText: showcaseText,
    locationText: locationText,
    actionState: actionState,
    clickDecision: clickDecision,
    canGoNextStation: canGoNextStation,
    panelRecord: panelRecord,
    buildPanel: buildPanel,
    mount: mount,
    unmount: unmount,
    open: open,
    close: close,
    isOpen: isOpen,
    panelEl: panelEl,
    refreshMarquee: refreshMarquee,
    refreshScale: refreshScale
  };
})(typeof window !== 'undefined' ? window : globalThis);
