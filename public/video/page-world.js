/*
 * Stellaflix 影视模块 — 世界页面
 *
 * M0：地球底座（步骤② 起为 @maptiler/sdk 3.9.0 + maplibre 5.6.2，见 video/world-globe.js；
 *   底图 = MapTiler HearThereMap 样式，对齐 hearthere.live cd()，无降级链）
 *   mount   → 创建 globe 地图（stars 太空底 + halo 大气光）
 *   unmount → 完整销毁地图与 WebGL 上下文
 *
 * Task 6（世界页大翻版）接线序：
 *   worldGlobe.mount → worldUi.mount
 *   → worldLighthouseDeck.mount(info.map, info.overlay, {stations,onBeaconClick,onHover})
 *   → worldMapActions.mount(info.map, {ui,deck})（flyTo/快捷键/自转，maplibre 面）
 *   交互契约（hearthere :19620-19650 token 模式）：
 *     点地图 → deck.pickStation 命中 → setSelected + flyTo(zoom16/pitch60/2800ms)
 *     → 卡片只在该飞行的 map 'moveend' 后打开；被取代飞行/切页后的 moveend 不开卡；
 *     点空处（卡片开着）→ 关卡片；悬停命中 → canvas cursor=pointer。
 *   旧 Cesium 面（world-cesium / world-lighthouse / world-actions）已退役，
 *   Task 9 移入 video/_archive/（不删除；启动链与 read 路径测试已同步摘除）。
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

  // Task 6 交互面：当前绑定了 click/mousemove 的 maplibre map 与飞行 token
  var boundMap = null;
  var boundHandlers = null;
  var flySeq = 0;

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
  //  Task 6 交互层：点击拾取 → flyTo → moveend 开卡（token 模式）
  // ============================================================

  function setHoverCursor(on) {
    if (!boundMap || typeof boundMap.getCanvas !== 'function') return;
    var canvas = boundMap.getCanvas();
    if (canvas && canvas.style) canvas.style.cursor = on ? 'pointer' : '';
  }

  // deck 站点 {position:[lon,lat]} → 卡片层（world-ui 读 st.lon/st.lat）形状
  function stationView(st) {
    if (!st) return st;
    var v = {};
    for (var k in st) { if (Object.prototype.hasOwnProperty.call(st, k)) v[k] = st[k]; }
    if (Array.isArray(st.position)) {
      if (v.lon == null) v.lon = st.position[0];
      if (v.lat == null) v.lat = st.position[1];
    }
    return v;
  }

  function openStationCard(st, clickPos) {
    if (!SFV.worldUi || typeof SFV.worldUi.showCard !== 'function' || !st) return;
    var pos = clickPos || null;
    if (boundMap && typeof boundMap.project === 'function' && Array.isArray(st.position)) {
      try {
        var p = boundMap.project(st.position);
        if (p && p.x != null) pos = p; // moveend 后按站点投影锚定卡片
      } catch (e) { /* 保留点击点兜底 */ }
    }
    SFV.worldUi.showCard(stationView(st), pos, {
      isFavorite: SFV.worldMapActions ? SFV.worldMapActions.isFavorite(st.id) : false,
      onFavorite: function (s2) {
        return SFV.worldMapActions ? SFV.worldMapActions.toggleFavorite(s2) : false;
      },
      onLocate: function (s2) {
        flyToStation(s2, null);
      },
      // M5：进入「一起看」房间（room.js + webrtc.js）
      onJoin: function (s2) {
        if (!SFV.worldRoom || !SFV.worldRoom.joinWatchRoom) {
          if (SFV.worldUi) SFV.worldUi.toast('房间模块未加载');
          return;
        }
        SFV.worldRoom.joinWatchRoom(s2, hostEl).catch(function () {});
      }
    });
  }

  // 电影感飞行 + 延迟开卡：token 自增；每个飞行注册一次性 moveend，
  // 落地时 token 已被更新的飞行取代（或页面已切走）则只摘监听不开卡。
  function flyToStation(st, clickPos) {
    if (!st) return;
    var map = boundMap;
    var token = ++flySeq;
    var mountId = seq;
    if (map && typeof map.on === 'function' && typeof map.off === 'function') {
      var onEnd = function () {
        map.off('moveend', onEnd);
        if (token !== flySeq || mountId !== seq) return; // 被取代/已切走：过期飞行不开卡
        openStationCard(st, clickPos);
      };
      map.on('moveend', onEnd);
    }
    if (SFV.worldMapActions && SFV.worldMapActions.flyTo) SFV.worldMapActions.flyTo(st);
  }

  // beacon 命中统一入口：选中（deck 尺寸分级 290）→ 飞行 → moveend 开卡
  function openStation(st, screenPos) {
    if (!st) return;
    if (SFV.worldLighthouseDeck && SFV.worldLighthouseDeck.setSelected) {
      SFV.worldLighthouseDeck.setSelected(st.id);
    }
    flyToStation(st, screenPos || null);
  }

  function onMapClick(e) {
    var deck = SFV.worldLighthouseDeck;
    if (!deck || !e || !e.point || typeof deck.pickStation !== 'function') return;
    var st = deck.pickStation(e.point.x, e.point.y);
    if (st) {
      openStation(st, e.point);
    } else if (SFV.worldUi && SFV.worldUi.cardEl) {
      // 点空处 = Esc 语义：卡片开着则关闭
      flySeq++; // 取消在途飞行的开卡
      SFV.worldUi.hideCard();
    }
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

        // 步骤②：自绘行政边界层退役 —— MapTiler HearThereMap 样式自带 Country border，
        // 且 hearthere 无独立边界层（SFV.worldBoundaries 不再挂载；模块留档 _archive 步骤⑤处理）

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
              onBeaconClick: function (st, screenPos) {
                if (mySeq !== seq || !st) return;
                openStation(st, screenPos || null);
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
                flyToStation(target, null); // Task 6 本地 flyTo（含 moveend 开卡）
                SFV.worldUi.toast('跳到「' + target.name + '」');
              });

              // 右下快捷键条：四项都可点（Esc/R/F/A，行为层在 world-map-actions）
              SFV.worldUi.setHintHandler(function (act) {
                if (act === 'esc') { SFV.worldUi.hideCard(); return; }
                if (act === 'reset') {
                  if (SFV.worldMapActions) SFV.worldMapActions.resetView();
                  return;
                }
                if (act === 'favorite') {
                  if (!SFV.worldMapActions) return;
                  var card = SFV.worldUi.cardEl;
                  var id = card && card.getAttribute && card.getAttribute('data-station-id');
                  var cur = id ? freshStation(id) : null;
                  if (cur) SFV.worldMapActions.toggleFavorite(cur);
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
                  // 城市级坐标（不含精确位置）；未填城市则用 0,0
                  var lon = opts.lon != null ? opts.lon : 0;
                  var lat = opts.lat != null ? opts.lat : 0;
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
      seq++;          // 作废所有在途闭包（含飞行 onEnd 的 mountId 校验）
      flySeq++;       // 取消在途飞行的开卡（Task 6：unmount 即废 token）
      setWorldPageClass(false);
      liftTitlebar(false);
      stopRoomPolling();
      unbindMapInteractions();
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
