/*
 * Stellaflix 影视模块 — 世界页面
 *
 * M0：地球底座（步骤② 起为 @maptiler/sdk 3.9.0 + maplibre 5.6.2，见 video/world-globe.js；
 *   底图 = MapTiler HearThereMap 样式，对齐 hearthere.live cd()，无降级链）
 *   mount   → 创建 globe 地图（stars 太空底 + halo 大气光）
 *   unmount → 完整销毁地图与 WebGL 上下文
 *
 * Task 6（世界页大翻版）接线序：
 *   worldGlobe.mount → worldUi.mount → worldHtPanel.mount(host)
 *   → worldLighthouseDeck.mount(info.map, info.overlay, {stations,onBeaconClick,onHover})
 *   → worldMapActions.mount(info.map, {ui,deck})（快捷键/自转，maplibre 面）
 *   交互契约（步骤④-4 起按 hearthere 逐字）：
 *     点地图 → deck.pickStation 命中 → wt（:19638-19653）：setSelected 选中
 *     → ht-panel 即点即开（It('station') 同步于相机动作之前）→ 相机独立飞行（zn :19600-19637）；
 *     空白点击 = Us（:19793-19851）命中为空即 return 的 no-op（不关面板）；
 *     悬停命中 → canvas cursor=pointer。
 *     旧自研面（world-ui 的 .world-card 卡片、点空处关卡、落地后开卡 token）
 *     随「删」裁决整条退役，样式入 video/_archive/。
 * 非渲染资产保留在 video/lighthouse/（config/security/edge-local/state/room/webrtc/sync/ui；
 *   死渲染项 view/mock/geo/edge 同批归档 _archive/）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var hostEl = null;
  var statusEl = null;
  var seq = 0;
  var savedHostStyle = null;
  var onAirCursor = -1;
  var roomPollTimer = 0;

  // 交互面（④-4）：当前绑定了 click/mousemove 的 maplibre map；
  // 面板侧状态机：打开中的信标 id / 已「进入房间」的信标 id（Wf 的 e）
  var boundMap = null;
  var boundHandlers = null;
  var openStationId = null;
  var listeningStationId = null;

  // A2（修复轮⑥）：当前地图视野中心（城市级）。maplibre getCenter() 返回 {lng,lat}，
  // 兼容 [lng,lat] 数组形状；未绑定地图或取不到时返回 null，由调用方兜底。
  function mapViewCenter() {
    try {
      var c = boundMap && boundMap.getCenter && boundMap.getCenter();
      if (!c) return { lng: null, lat: null };
      if (Array.isArray(c)) return { lng: c[0], lat: c[1] };
      return { lng: c.lng != null ? c.lng : c.lon, lat: c.lat };
    } catch (e) {
      return { lng: null, lat: null };
    }
  }

  // 房间上球：每 20s 增量刷新开放房间（只增/删/改，绝不重建模型）
  // Task 6：刷新改推给 deck 层（老 worldLighthouse 不再接收）
  function startRoomPolling() {
    stopRoomPolling();
    if (!SFV.worldData || !SFV.worldData.fetchRooms) return;
    if (!SFV.worldLighthouseDeck || !SFV.worldLighthouseDeck.refreshStations) return;
    // Fix round 1（I-2）：轮询纪元 = 注册时的挂载代；tick 入口与兑现处双检——
    // 在途 fetch 迟于 unmount 返回、或注销后仍有人持旧引用回调，一律作废。
    var pollSeq = seq;
    var tick = function () {
      if (pollSeq !== seq) return;
      SFV.worldData.fetchRooms({ limit: 60 }).then(function (info) {
        if (pollSeq !== seq) return; // 已切页：不碰已卸载 deck
        if (!info || !info.rooms || !info.rooms.length) return;
        SFV.worldLighthouseDeck.refreshStations(info.rooms);
      }).catch(function () {});
    };
    roomPollTimer = setInterval(tick, 20000);
    // B1：建房/离房后 world-room 会调 refreshMap，这里注册即时刷新
    if (SFV.worldRoom && SFV.worldRoom.setMapRefreshHandler) {
      SFV.worldRoom.setMapRefreshHandler(tick);
    }
  }
  function stopRoomPolling() {
    if (roomPollTimer) {
      clearInterval(roomPollTimer);
      roomPollTimer = 0;
      // Fix round 1（I-2）：轮询在谁手上起的就在谁手上断——unmount 走
      // stopRoomPolling 时一并注销 room 模块的即时刷新 handler
      //（world-room.setMapRefreshHandler 收非函数即清空）。
      if (SFV.worldRoom && SFV.worldRoom.setMapRefreshHandler) {
        SFV.worldRoom.setMapRefreshHandler(null);
      }
    }
  }

  // ============================================================
  //  ④-4 交互层（hearthre 逐字）：点击命中 → 选中 + 即点即开面板（wt
  //  :19638-19653，It('station') 先于相机动作）→ 相机独立飞行；空白点击
  //  为 no-op（Us :19793-19851，命中为空即 return，不关面板）。
  //  旧自研面（点图投卡 / 落地开卡 / 宿主卡片 DOM 辅助）已退役，见头注释。
  // ============================================================

  function setHoverCursor(on) {
    if (!boundMap || typeof boundMap.getCanvas !== 'function') return;
    var canvas = boundMap.getCanvas();
    if (canvas && canvas.style) canvas.style.cursor = on ? 'pointer' : '';
  }

  function deckStations() {
    if (!SFV.worldLighthouseDeck || typeof SFV.worldLighthouseDeck.getState !== 'function') return [];
    var s = SFV.worldLighthouseDeck.getState() || {};
    return s.stations || [];
  }

  function findStation(id) {
    var list = deckStations();
    for (var n = 0; n < list.length; n++) { if (list[n].id === id) return list[n]; }
    return null;
  }

  function panelOpen(st, extra) {
    if (!SFV.worldHtPanel || typeof SFV.worldHtPanel.open !== 'function' || !st) return;
    var opts = {
      listeningStationId: listeningStationId,
      isFavorite: SFV.worldMapActions ? SFV.worldMapActions.isFavorite(st.id) : false,
      canGoNext: SFV.worldHtPanel.canGoNextStation(deckStations(), st.id),  // :19973
      onFavorite: function () { toggleFavorite(st); },
      onAction: function (action) { handleCta(action, st); }
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) opts[k] = extra[k];
    openStationId = st.id;
    SFV.worldHtPanel.open(st, opts);
  }

  function closePanel() { // It(null) 等价（:19971）
    openStationId = null;
    if (SFV.worldHtPanel && typeof SFV.worldHtPanel.close === 'function') SFV.worldHtPanel.close();
  }

  function panelStation() {
    var p = SFV.worldHtPanel && SFV.worldHtPanel.panelEl && SFV.worldHtPanel.panelEl();
    return p && p.__station ? p.__station : null;
  }

  function toggleFavorite(st) { // 卡片收藏星与快捷键 R 段收藏同一入口
    if (!SFV.worldMapActions || !st) return;
    SFV.worldMapActions.toggleFavorite(st);
    if (SFV.worldHtPanel.isOpen() && panelStation() && panelStation().id === st.id) panelOpen(st);
  }

  function flyTo(st) {
    if (SFV.worldLighthouseDeck && SFV.worldLighthouseDeck.flyToStation) SFV.worldLighthouseDeck.flyToStation(st);
  }

  function handleCta(action, st) {
    if (action === 'tune_in') { // 进入房间（M5：local room.js + webrtc.js 替代 Supabase 面）
      if (!SFV.worldRoom || !SFV.worldRoom.joinWatchRoom) {
        if (SFV.worldUi) SFV.worldUi.toast('房间模块未加载');
        return;
      }
      SFV.worldRoom.joinWatchRoom(st, hostEl).then(function () {
        listeningStationId = st.id;
        panelOpen(findStation(st.id) || st);
      }).catch(function () {});
      return;
    }
    if (action === 'stop') {
      if (SFV.worldRoom && SFV.worldRoom.leave) SFV.worldRoom.leave();
      listeningStationId = null;
      closePanel(); // sp 无收听态后自动关面板 = It(null) 等价（:19971）
      return;
    }
    if (action === 'next_station') { nextPlayingStation(); return; }
    // offline / idle：Wf 已把按钮置禁用，点击不达此处
  }

  // 下一个电台（:19973 u 支路语义：跳到另一座正在放映的信标）
  function nextPlayingStation() {
    if (!SFV.worldHtPanel) return;
    var list = deckStations();
    var playing = [];
    for (var i = 0; i < list.length; i++) if (list[i].status === 'playing') playing.push(list[i]);
    var next = null;
    for (var j = 0; j < playing.length; j++) {
      if (next) break;
      if (playing[j].id !== openStationId && playing[j].id !== listeningStationId) next = playing[j];
    }
    if (!next) { if (SFV.worldUi) SFV.worldUi.toast('没有下一个正在放映的信标'); return; }
    openStation(next);
  }

  // wt（:19638-19653）：选中 → 开面板 → 相机飞行（顺序逐字：面板先于飞行）
  function openStation(st) {
    if (!st) return;
    if (SFV.worldLighthouseDeck && SFV.worldLighthouseDeck.setSelected) {
      SFV.worldLighthouseDeck.setSelected(st.id);
    }
    panelOpen(st);
    flyTo(st);
  }

  function onMapClick(e) {
    var deck = SFV.worldLighthouseDeck;
    if (!deck || !e || !e.point || typeof deck.pickStation !== 'function') return;
    var st = deck.pickStation(e.point.x, e.point.y);
    if (st) openStation(st);
    // 命中为空 = Us（:19826 je 为 null）：no-op，不关面板
  }

  function onMapHover(e) {
    var deck = SFV.worldLighthouseDeck;
    if (!deck || !e || !e.point || typeof deck.pickStation !== 'function') return;
    setHoverCursor(!!deck.pickStation(e.point.x, e.point.y));
  }

  function unbindMapInteractions() {
    if (boundMap && boundHandlers) {
      try {
        if (boundHandlers.click) boundMap.off('click', boundHandlers.click);
        if (boundHandlers.move) boundMap.off('mousemove', boundHandlers.move);
      } catch (e) { /* 图已销毁时尽力释放 */ }
    }
    boundMap = null;
    boundHandlers = null;
  }

  function bindMapInteractions(map) {
    unbindMapInteractions();
    boundMap = map;
    boundHandlers = { click: onMapClick, move: onMapHover };
    if (map && typeof map.on === 'function') {
      map.on('click', onMapClick);
      map.on('mousemove', onMapHover);
    }
  }

  // ============================================================

  // 世界页独立化（2026-09-27）：挂载期给 body 挂 sfv-world-page ——
  // player.css 据此隐藏首页共享 three.js 星空画布（#canvas-container）并把
  // 覆盖层/宿主切实色底，世界页不再与首页共用同一套相机/3D 空间。
  // 摘除统一走 unmount；online-nav.close()→router.leave() 保证退出浏览层
  // （含 goHome/切音乐态）也必然经过 unmount，类不残留。
  function setWorldPageClass(on) {
    var b = global.document && global.document.body;
    if (!b || !b.classList) return;
    if (on) b.classList.add('sfv-world-page');
    else b.classList.remove('sfv-world-page');
  }

  // 世界页悬浮胶囊的层叠上下文旁路（2026-09-27 真机反馈「能点击但不显示」）：
  // .sfv-browse 覆盖层挂在 document.body（online-nav.js:68）且 z-index:2147482000，
  // 而 #desktop-titlebar 在 #desktop-window-shell 内——该 shell 因 transform/clip-path
  // 自成层叠上下文，其内部 z-index 再高也出不了这道墙，胶囊被地球层压住不可见；
  // 地球层 pointer-events:none 又让鼠标穿透命中它，于是「点得到、看不见」。
  // 沿用仓库既有解法（bottom-bar / track-detail-modal 均 reparent 到 body）：
  // 挂载期把标题栏提到 body，卸载时送回 shell 原位。
  var titlebarAnchor = null;
  function liftTitlebar(on) {
    var doc = global.document;
    if (!doc || !doc.body || typeof doc.getElementById !== 'function') return;
    var tb = doc.getElementById('desktop-titlebar');
    var shell = doc.getElementById('desktop-window-shell');
    if (!tb || !shell) return;
    if (on) {
      var b = doc.body;
      if (!b.classList || !b.classList.contains || !b.classList.contains('desktop-shell')) return;
      if (tb.parentNode !== shell) return;
      titlebarAnchor = tb.nextSibling || null;
      b.appendChild(tb);
      return;
    }
    if (tb.parentNode === doc.body) {
      if (titlebarAnchor && titlebarAnchor.parentNode === shell) shell.insertBefore(tb, titlebarAnchor);
      else shell.appendChild(tb);
    }
    titlebarAnchor = null;
  }

  function applyHostChrome(host) {
    // 世界页是全屏地球，不要 .sfv-browse--page 的 102px 顶栏让位与透明底
    // （透明会让首页星空/3D 层透上来，地球画布被压在内容区里）。
    savedHostStyle = {
      padding: host.style.padding,
      height: host.style.height,
      overflow: host.style.overflow,
      background: host.style.background
    };
    host.style.padding = '0';
    host.style.height = '100%';
    host.style.overflow = 'hidden';
    host.style.background = '#05060a';
  }

  function restoreHostChrome() {
    if (!hostEl || !savedHostStyle) return;
    var s = savedHostStyle;
    hostEl.style.padding = s.padding;
    hostEl.style.height = s.height;
    hostEl.style.overflow = s.overflow;
    hostEl.style.background = s.background;
    savedHostStyle = null;
  }

  function setStatus(text) {
    if (statusEl && statusEl.parentNode) statusEl.textContent = text;
  }

  function showError(msg) {
    if (!hostEl) return;
    var box = document.createElement('div');
    box.className = 'world-error';
    box.style.cssText =
      'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'height:100%;min-height:280px;gap:12px;padding:32px;box-sizing:border-box;' +
      'color:rgba(255,255,255,0.7);font-family:"Inter","Noto Sans SC",sans-serif;' +
      'text-align:center;';
    var t = document.createElement('div');
    t.style.cssText = 'font-size:18px;letter-spacing:2px;color:rgba(255,255,255,0.85);';
    t.textContent = '世界页暂时不可用';
    var d = document.createElement('div');
    d.style.cssText = 'font-size:13px;opacity:0.6;max-width:420px;line-height:1.6;';
    d.textContent = msg;
    box.appendChild(t);
    box.appendChild(d);
    hostEl.innerHTML = '';
    hostEl.appendChild(box);
  }

  SFV.router.register({
    id: 'world',
    title: '世界',
    mount: function (host, ctx) {
      if (SFV.ui && SFV.ui.setTitle) SFV.ui.setTitle('世界');

      setWorldPageClass(true);
      liftTitlebar(true);
      host.innerHTML = '';
      hostEl = host;
      applyHostChrome(host);

      // 骨架：先出加载态，底座就绪后由 world-globe 接管
      statusEl = document.createElement('div');
      statusEl.className = 'world-status';
      statusEl.style.cssText =
        'display:flex;align-items:center;justify-content:center;' +
        'height:100%;min-height:320px;' +
        'color:rgba(255,255,255,0.55);' +
        "font-family:'Inter','Noto Sans SC',sans-serif;" +
        'font-size:14px;letter-spacing:2px;' +
        'pointer-events:none;user-select:none;';
      statusEl.textContent = '正在接入地球…';
      host.appendChild(statusEl);

      var mySeq = ++seq;

      if (!SFV.worldGlobe || typeof SFV.worldGlobe.mount !== 'function') {
        showError('地球底座模块未加载（video/world-globe.js）。');
        return;
      }

      SFV.worldGlobe.mount(host).then(function (info) {
        if (mySeq !== seq) return; // 已切走
        if (!info) return;
        var name = info.basemap === 'maptiler' ? '暗色地球' : '地球';
        setStatus('');
        if (SFV.ui && SFV.ui.setTitle) SFV.ui.setTitle('世界 · ' + name);

        // M3：品牌叠层 / 统计 / toast / 烟花画布
        if (SFV.worldUi && typeof SFV.worldUi.mount === 'function') {
          SFV.worldUi.mount(host);
          SFV.worldUi.showLoading('正在连接放映房间…');
        }

        // ④-4：ht-panel 外壳（.nav-bar 挂页面宿主，:3189-3345 Rd 逐字）
        if (SFV.worldHtPanel && typeof SFV.worldHtPanel.mount === 'function') {
          SFV.worldHtPanel.mount(host);
        }

        // 步骤②：自绘行政边界层退役 —— MapTiler HearThereMap 样式自带 Country border，
        // 且 hearthere 无独立边界层（SFV.worldBoundaries 不再挂载；步骤⑤已归档 _archive/）

        // M5：拉取开放的「一起看」房间；拉不到就降级演示房间
        var roomsPromise = (SFV.worldData && SFV.worldData.fetchRooms)
          ? SFV.worldData.fetchRooms({ limit: 60 })
          : Promise.resolve({ ok: false, rooms: [] });

        // Task 6：灯塔 deck 层上球（map + overlay 直收）；点击/悬停走 pickStation 契约
        if (SFV.worldLighthouseDeck && typeof SFV.worldLighthouseDeck.mount === 'function'
          && info.map && info.overlay) {
          roomsPromise.then(function (stInfo) {
            if (mySeq !== seq) return;

            var stations = (stInfo && stInfo.rooms && stInfo.rooms.length)
              ? stInfo.rooms
              : null;
            if (stInfo && stInfo.source && SFV.worldUi) {
              SFV.worldUi.toast('放映房间来源：' + stInfo.source);
            }

            return SFV.worldLighthouseDeck.mount(info.map, info.overlay, {
              stations: stations,
              onBeaconClick: function (st) {
                if (mySeq !== seq || !st) return;
                openStation(st);
              },
              onHover: function (st) {
                if (mySeq !== seq) return;
                setHoverCursor(!!st);
              }
            }).then(function () {
              if (mySeq !== seq) { SFV.worldLighthouseDeck.unmount(); return; }
              if (!SFV.worldUi) return;
              SFV.worldUi.hideLoading();

              var st = (SFV.worldLighthouseDeck.getState() || {}).stations || [];
              var playing = 0, online = 0, offline = 0;
              for (var i = 0; i < st.length; i++) {
                if (st[i].status === 'playing') playing++;
                else if (st[i].status === 'offline') offline++;
                else online++;
              }
              SFV.worldUi.setStats({ total: st.length, playing: playing, online: online, offline: offline });
              SFV.worldUi.setOnAir(playing > 0);
              SFV.worldUi.setRotateState(SFV.worldMapActions ? SFV.worldMapActions.autoRotate : true);

              // 当前站点的收藏/名称等以 deck 实时状态为准（轮询会增删站点）
              function freshStation(id) {
                var list = (SFV.worldLighthouseDeck.getState() || {}).stations || [];
                for (var n = 0; n < list.length; n++) { if (list[n].id === id) return list[n]; }
                return null;
              }

              // ON AIR 可点：跳到一个正在放映的信标
              onAirCursor = -1;
              SFV.worldUi.setOnAirHandler(function () {
                var list = (SFV.worldLighthouseDeck.getState() || {}).stations || [];
                var playingList = [];
                for (var j = 0; j < list.length; j++) {
                  if (list[j].status === 'playing') playingList.push(list[j]);
                }
                if (!playingList.length) {
                  SFV.worldUi.toast('当前没有正在放映的信标');
                  return;
                }
                onAirCursor = (onAirCursor + 1) % playingList.length;
                var target = playingList[onAirCursor];
                openStation(target); // wt：选中 + 即点即开面板 + 飞行
                SFV.worldUi.toast('跳到「' + target.name + '」');
              });

              // 右下快捷键条：四项都可点（Esc/R/F/A，行为层在 world-map-actions）
              SFV.worldUi.setHintHandler(function (act) {
                if (act === 'esc') { closePanel(); return; }
                if (act === 'reset') {
                  if (SFV.worldMapActions) SFV.worldMapActions.resetView();
                  return;
                }
                if (act === 'favorite') {
                  var cur = openStationId != null ? freshStation(openStationId) : null;
                  if (cur) toggleFavorite(cur);
                  else SFV.worldUi.toast('先点一座信标，再收藏');
                  return;
                }
                if (act === 'rotate') {
                  if (!SFV.worldMapActions) return;
                  var next = !SFV.worldMapActions.autoRotate;
                  SFV.worldMapActions.setAutoRotate(next);
                  SFV.worldUi.setRotateState(next);
                  SFV.worldUi.toast(next ? '地球自转已开启' : '地球自转已关闭');
                }
              });

              // A 段：右下角「+ 创建放映」→ createHost
              if (SFV.worldUi && SFV.worldUi.setCreateHandler) {
                SFV.worldUi.setCreateHandler(function (opts) {
                  if (!SFV.worldRoom || !SFV.worldRoom.createHost) {
                    if (SFV.worldUi) SFV.worldUi.toast('房间模块未加载');
                    return;
                  }
                  // 城市级坐标（不含精确位置）；面板未带坐标时取当前地图视野中心，绝不落 (0,0) 零点岛
                  var lon = opts.lon, lat = opts.lat;
                  if (lon == null || lat == null) {
                    var c = mapViewCenter();
                    if (lon == null) lon = c.lng;
                    if (lat == null) lat = c.lat;
                  }
                  if (lon == null) lon = 0;
                  if (lat == null) lat = 0;
                  SFV.worldRoom.createHost({
                    title: opts.title,
                    name: opts.name,
                    lon: lon,
                    lat: lat,
                    discovery: opts.discovery !== false
                  }, host).catch(function () {});
                });
              }

              if (st.length) SFV.worldUi.toast('发现 ' + st.length + ' 个放映房间');
              if (typeof SFV.worldLighthouseDeck.applyTier === 'function'
                && typeof info.map.getZoom === 'function') {
                SFV.worldLighthouseDeck.applyTier(info.map.getZoom());
              }

              // Task 6：地图行为层（flyTo/R 重置/A 自转/F 收藏的 maplibre 实现 + 键盘）
              if (SFV.worldMapActions && typeof SFV.worldMapActions.mount === 'function') {
                SFV.worldMapActions.mount(info.map, {
                  ui: SFV.worldUi,
                  deck: SFV.worldLighthouseDeck
                });
              }

              // 点击拾取（deck.pickStation）+ 悬停 cursor 绑定到 maplibre 事件
              bindMapInteractions(info.map);

              // 房间上球：开始轮询开放房间（Task 6 起刷新推给 deck）
              startRoomPolling();
            });
          }).catch(function (e) {
            console.warn('[page-world] 灯塔 deck 层挂载失败', e);
            if (SFV.worldUi) SFV.worldUi.hideLoading();
          });
        } else if (SFV.worldUi) {
          SFV.worldUi.hideLoading();
        }
      }).catch(function (err) {
        if (mySeq !== seq) return;
        console.error('[page-world] 地球底座接入失败', err);
        if (SFV.worldUi) SFV.worldUi.hideLoading();
        showError('地球加载失败：' + (err && err.message ? err.message : err));
      });
    },
    unmount: function () {
      seq++;          // 作废所有在途闭包（含 deck 飞行 token 的挂载代校验）
      setWorldPageClass(false);
      liftTitlebar(false);
      stopRoomPolling();
      unbindMapInteractions();
      openStationId = null;
      listeningStationId = null;
      if (SFV.worldHtPanel && typeof SFV.worldHtPanel.unmount === 'function') {
        SFV.worldHtPanel.unmount();
      }
      if (SFV.worldRoom && typeof SFV.worldRoom.leave === 'function') {
        SFV.worldRoom.leave();
      }
      // 步骤②：boundaries 已停挂（见 mount 侧注释），unmount 链同步摘除
      if (SFV.worldMapActions && typeof SFV.worldMapActions.unmount === 'function') {
        SFV.worldMapActions.unmount();
      }
      if (SFV.worldUi && typeof SFV.worldUi.unmount === 'function') {
        SFV.worldUi.unmount();
      }
      if (SFV.worldLighthouseDeck && typeof SFV.worldLighthouseDeck.unmount === 'function') {
        SFV.worldLighthouseDeck.unmount();
      }
      if (SFV.worldGlobe && typeof SFV.worldGlobe.unmount === 'function') {
        SFV.worldGlobe.unmount();
      }
      restoreHostChrome();
      if (hostEl) {
        hostEl.innerHTML = '';
        hostEl = null;
      }
      statusEl = null;
    },
    back: function () { return false; }
  });
})(typeof window !== 'undefined' ? window : this);
