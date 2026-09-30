/*
 * Stellaflix 影视模块 — 世界页交互 UI（M3）
 *
 * 视觉对齐 hearthere.live 的克制质感：
 *   · 顶部叠层：标题已按需求移除，仅保留 ON AIR 指示
 *   · ON AIR   ：右上角红点脉冲
 *   · 信标卡片 ：深色毛玻璃 + 颜色条 + 状态徽章 + 收藏/定位
 *   · 统计面板 ：左下「N 个放映厅 · N 正在放映 · N 在线 · N 离线」
 *   · 欢迎 toast：顶部居中，进场后自动消失
 *   · 加载态   ：细环 + 字距文案，就绪后淡出
 *
 * 本模块只管 DOM，不碰相机/模型；行为逻辑在 world-actions.js。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var root = null;        // 世界页内的 UI 容器（绝对定位铺满）
  var toastTimer = 0;
  var toastEl = null;
  var statsEl = null;
  var onAirEl = null;
  var loadingEl = null;
  var fireworksCanvas = null;
  var onAirHandler = null;
  var hintHandler = null;
  var hintsEl = null;
  var createBtnEl = null;
  var createPanelEl = null;
  var createHandler = null;
  var fireworkBtnEl = null;
  var likeBtnEl = null;
  var unsubFirework = null;
  var unsubLike = null;
  var stationProjector = null;   // stationId -> {x,y} 屏幕坐标（T9 可选接线；缺省走屏幕中心）

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ============================================================
  //  顶部叠层（标题已按需求移除，仅保留 ON AIR）
  // ============================================================
  function buildBrand() {

    // Task 9 口号（用户裁决：HearThere 的「听」版口号 → Stellaflix「看」版，见下行文案）
    var sloganEl = el('div', 'world-brand-slogan');
    sloganEl.textContent = '看看世界都在看什么';
    sloganEl.style.pointerEvents = 'none';
    root.appendChild(sloganEl);

    onAirEl = el('button', 'world-on-air');
    onAirEl.type = 'button';
    onAirEl.setAttribute('aria-label', '跳到正在放映的信标');
    onAirEl.style.pointerEvents = 'auto';
    onAirEl.style.cursor = 'pointer';
    onAirEl.appendChild(el('span', 'world-on-air-dot'));
    onAirEl.appendChild(el('span', null, 'ON AIR'));
    onAirEl.addEventListener('click', function () {
      if (onAirHandler) onAirHandler();
    });
    root.appendChild(onAirEl);
  }

  // ============================================================
  //  统计面板 / 快捷键提示
  // ============================================================
  function buildStats() {
    statsEl = el('div', 'world-stats');
    root.appendChild(statsEl);

    // 右下快捷键条：每一项都是可点按钮（不只是键盘提示）
    hintsEl = el('div', 'world-hints');
    hintsEl.style.pointerEvents = 'auto';
    var items = [
      ['Esc', '关卡片', 'esc'],
      ['R', '重置视角', 'reset'],
      ['F', '收藏', 'favorite'],
      ['A', '自转', 'rotate']
    ];
    items.forEach(function (p) {
      var b = el('button', 'world-hint-btn');
      b.type = 'button';
      b.setAttribute('data-act', p[2]);
      b.appendChild(el('kbd', null, p[0]));
      b.appendChild(el('span', null, p[1]));
      b.addEventListener('click', function () {
        if (hintHandler) hintHandler(p[2]);
      });
      hintsEl.appendChild(b);
    });
    root.appendChild(hintsEl);
  }

  function setHintHandler(fn) {
    hintHandler = typeof fn === 'function' ? fn : null;
  }

  function setRotateState(on) {
    if (!hintsEl) return;
    var b = hintsEl.querySelector('[data-act="rotate"]');
    if (b) b.classList.toggle('is-on', !!on);
  }

  // ============================================================
  //  Task 8：社交动作区 ——「点火！」按钮 + 库存计数 + 点赞
  //  语义：HearThere 收听奖励 → Stellaflix 看完整片奖励
  //  （每完整看完 1 部 = 1 发烟花；库存判定在 SFV.worldSocial，
  //   本模块只画按钮、扣减/toast 走其返回面）。复用 hint 区样式语言。
  // ============================================================
  function socialStationId() {
    try {
      var p = SFV.worldHtPanel && SFV.worldHtPanel.panelEl && SFV.worldHtPanel.panelEl();
      if (p && p.__station && p.__station.id != null) return String(p.__station.id);
      var s = SFV.worldRoom && SFV.worldRoom.session;
      return s && s.code ? 'room-' + s.code : '';
    } catch (e) { return ''; }
  }

  function buildSocial() {
    fireworkBtnEl = el('button', 'world-hint-btn world-firework-btn');
    fireworkBtnEl.type = 'button';
    fireworkBtnEl.style.pointerEvents = 'auto';
    fireworkBtnEl.style.cursor = 'pointer';
    fireworkBtnEl.appendChild(el('span', null, '🎆 点火！'));
    fireworkBtnEl.appendChild(el('span', 'world-firework-count', '×0'));
    fireworkBtnEl.addEventListener('click', function () {
      var social = SFV.worldSocial;
      if (!social) { toast('社交模块未加载'); return; }
      if (!social.light(socialStationId())) {
        toast('先看完一部片攒一发');
        return;
      }
      setFireworkStock(social.stock());
    });
    hintsEl.appendChild(fireworkBtnEl);

    likeBtnEl = el('button', 'world-hint-btn world-like-btn', '♥ 点赞');
    likeBtnEl.type = 'button';
    likeBtnEl.style.pointerEvents = 'auto';
    likeBtnEl.style.cursor = 'pointer';
    likeBtnEl.addEventListener('click', function () {
      var social = SFV.worldSocial;
      if (!social) { toast('社交模块未加载'); return; }
      social.like(socialStationId());
      toast('♥ 已点赞');
    });
    hintsEl.appendChild(likeBtnEl);
  }

  function setFireworkStock(n) {
    if (!fireworkBtnEl) return;
    var c = fireworkBtnEl.querySelector('.world-firework-count');
    if (c) c.textContent = '×' + (Math.max(0, Number(n) || 0));
  }

  // 收到烟花事件 → 现有 world-fireworks 画布放粒子。
  // payload.stationId 有投影器就给坐标，否则引擎回落屏幕中心（最小面，不加投影基建）。
  function fireworkAt(payload) {
    var social = SFV.worldSocial;
    if (!social) return;
    var canvas = fireworksCanvasEl();
    if (!canvas) return;
    var pos = null;
    if (stationProjector && payload && payload.stationId) {
      try { pos = stationProjector(payload.stationId); } catch (e) { pos = null; }
    }
    social.celebrate(canvas,
      pos && pos.x != null ? pos.x : undefined,
      pos && pos.y != null ? pos.y : undefined);
  }

  function setFireworkProjector(fn) {
    stationProjector = typeof fn === 'function' ? fn : null;
  }

  // 订阅 + 轮询启动（world-social 的唯一页面消费者就是这里；可重入）
  function bindSocial() {
    var social = SFV.worldSocial;
    if (!social) return;
    if (unsubFirework) { try { unsubFirework(); } catch (e) {} unsubFirework = null; }
    if (unsubLike) { try { unsubLike(); } catch (e) {} unsubLike = null; }
    try {
      unsubFirework = social.onFirework(function (p) { fireworkAt(p); });
      unsubLike = social.onLike(function () { toast('♥ 有人点赞了这里的放映'); });
      setFireworkStock(social.stock());
      social.start();   // 默认 5000ms（控制方裁决，见 world-social.js 注释）
    } catch (e) {}
  }

  function unbindSocial() {
    try { if (SFV.worldSocial) SFV.worldSocial.stop(); } catch (e) {}
    if (unsubFirework) { try { unsubFirework(); } catch (e) {} unsubFirework = null; }
    if (unsubLike) { try { unsubLike(); } catch (e) {} unsubLike = null; }
  }

  // ============================================================
  //  A1/A2：「+ 创建放映」主按钮 + 创建面板
  // ============================================================
  function buildCreateBtn() {
    createBtnEl = el('button', 'world-create-btn');
    createBtnEl.type = 'button';
    createBtnEl.setAttribute('aria-label', '创建放映');
    createBtnEl.appendChild(el('span', 'world-create-btn-icon', '+'));
    createBtnEl.appendChild(el('span', null, '创建放映'));
    createBtnEl.addEventListener('click', function () {
      if (createPanelEl) hideCreatePanel();
      else showCreatePanel();
    });
    root.appendChild(createBtnEl);
  }

  function hideCreatePanel() {
    if (createPanelEl && createPanelEl.parentNode) createPanelEl.parentNode.removeChild(createPanelEl);
    createPanelEl = null;
    if (createBtnEl) createBtnEl.classList.remove('is-open');
  }

  function showCreatePanel() {
    if (!root) return;
    hideCreatePanel();
    if (createBtnEl) createBtnEl.classList.add('is-open');

    var p = el('div', 'world-create-panel');

    // 标题栏
    var head = el('div', 'world-create-head');
    head.appendChild(el('div', 'world-create-title', '创建放映'));
    var close = el('button', 'world-create-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', function () { hideCreatePanel(); });
    head.appendChild(close);
    p.appendChild(head);

    // 片名
    var titleLabel = el('label', 'world-create-label', '片名');
    var titleInput = el('input', 'world-create-input');
    titleInput.type = 'text';
    titleInput.maxLength = 48;
    titleInput.placeholder = '正在看什么？';
    p.appendChild(titleLabel);
    p.appendChild(titleInput);

    // 城市
    var cityLabel = el('label', 'world-create-label', '城市');
    var cityInput = el('input', 'world-create-input');
    cityInput.type = 'text';
    cityInput.maxLength = 32;
    cityInput.placeholder = '城市名（如：东京）';
    p.appendChild(cityLabel);
    p.appendChild(cityInput);

    // 权限：公开地图 vs 仅房间码
    var permLabel = el('label', 'world-create-label', '谁能看到你');
    var permRow = el('div', 'world-create-perm');
    var permPublic = el('button', 'world-create-perm-btn is-on', '公开地图');
    permPublic.type = 'button';
    var permPrivate = el('button', 'world-create-perm-btn', '仅房间码');
    permPrivate.type = 'button';
    var isPublic = true;
    permPublic.addEventListener('click', function () {
      isPublic = true;
      permPublic.classList.add('is-on');
      permPrivate.classList.remove('is-on');
    });
    permPrivate.addEventListener('click', function () {
      isPublic = false;
      permPrivate.classList.add('is-on');
      permPublic.classList.remove('is-on');
    });
    permRow.appendChild(permPublic);
    permRow.appendChild(permPrivate);
    p.appendChild(permLabel);
    p.appendChild(permRow);
    p.appendChild(el('div', 'world-create-note',
      isPublic
        ? '公开：你的灯塔会出现在他人世界地图（城市级位置）'
        : '私密：仅凭房间码加入，不公开出现在地图上'));

    // 同步更新提示文案
    permPublic.addEventListener('click', function () {
      var n = p.querySelector('.world-create-note');
      if (n) n.textContent = '公开：你的灯塔会出现在他人世界地图（城市级位置）';
    });
    permPrivate.addEventListener('click', function () {
      var n = p.querySelector('.world-create-note');
      if (n) n.textContent = '私密：仅凭房间码加入，不公开出现在地图上';
    });

    // 提交
    var submit = el('button', 'world-create-submit', '▶ 开始放映');
    submit.type = 'button';
    submit.addEventListener('click', function () {
      var title = (titleInput.value || '').trim() || '一起看';
      var city = (cityInput.value || '').trim();
      submit.disabled = true;
      submit.textContent = '正在创建…';
      if (createHandler) {
        createHandler({
          title: title,
          name: city || '放映房间',
          discovery: isPublic
        });
      }
      hideCreatePanel();
    });
    p.appendChild(submit);

    // D1：隐私说明入口
    var privacyLink = el('button', 'world-create-privacy-link', '🔒 隐私说明');
    privacyLink.type = 'button';
    privacyLink.addEventListener('click', function () {
      if (privacyDetail.style.display === 'none') {
        privacyDetail.style.display = 'block';
        privacyLink.textContent = '🔒 隐私说明 ▲';
      } else {
        privacyDetail.style.display = 'none';
        privacyLink.textContent = '🔒 隐私说明';
      }
    });
    p.appendChild(privacyLink);

    var privacyDetail = el('div', 'world-create-privacy');
    privacyDetail.style.display = 'none';
    privacyDetail.innerHTML = '' +
      '<div class="world-create-privacy-row"><b>位置精度</b>：只用城市级坐标，不含精确位置。' +
      '公开模式下他人地图只看到你所在的城市，看不到街道门牌。</div>' +
      '<div class="world-create-privacy-row"><b>数据流向</b>：播放同步走 WebRTC P2P 直连，' +
      '不经过服务器中继媒体流。视频/音频留在各人本地播放器。</div>' +
      '<div class="world-create-privacy-row"><b>不采集</b>：不收集 IP、设备指纹、精确位置。' +
      'deviceId 是本地随机标识，房间在内存里、进程退出即消失。</div>' +
      '<div class="world-create-privacy-row"><b>可关闭</b>：建房后可在房间面板关闭公开灯塔，' +
      '关闭后不再出现在他人地图（仍可凭房间码加入）。</div>';
    p.appendChild(privacyDetail);

    // 定位：右下角，贴着创建按钮
    p.style.position = 'absolute';
    p.style.right = '20px';
    p.style.bottom = '78px';
    p.style.zIndex = '200';
    root.appendChild(p);
    createPanelEl = p;

    // 进场动画
    requestAnimationFrame(function () {
      if (createPanelEl) createPanelEl.classList.add('is-in');
    });
    // 片名自动聚焦
    try { titleInput.focus(); } catch (e) {}
  }

  function setCreateHandler(fn) {
    createHandler = typeof fn === 'function' ? fn : null;
  }

  function setStats(s) {
    if (!statsEl) return;
    s = s || {};
    statsEl.innerHTML = '';
    var mk = function (k, v, cls) {
      var w = el('span', cls);
      w.appendChild(el('b', null, String(v)));
      w.appendChild(document.createTextNode(k));
      return w;
    };
    statsEl.appendChild(mk('个放映厅', s.total || 0));
    statsEl.appendChild(el('span', 'sep'));
    statsEl.appendChild(mk('正在放映', s.playing || 0, 'k-playing'));
    statsEl.appendChild(el('span', 'sep'));
    statsEl.appendChild(mk('在线', s.online || 0, 'k-online'));
    statsEl.appendChild(el('span', 'sep'));
    statsEl.appendChild(mk('离线', s.offline || 0, 'k-offline'));
  }

  // ============================================================
  //  欢迎 toast
  // ============================================================
  function toast(msg, ms) {
    if (!root) return;
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    clearTimeout(toastTimer);
    toastEl = el('div', 'world-toast', msg);
    root.appendChild(toastEl);
    requestAnimationFrame(function () {
      if (toastEl) toastEl.classList.add('is-in');
    });
    toastTimer = setTimeout(function () {
      if (!toastEl) return;
      toastEl.classList.remove('is-in');
      setTimeout(function () {
        if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
        toastEl = null;
      }, 320);
    }, ms || 2600);
  }

  // ============================================================
  //  加载态
  // ============================================================
  function showLoading(text) {
    if (!root) return;
    hideLoading();
    loadingEl = el('div', 'world-loading');
    loadingEl.appendChild(el('div', 'world-loading-ring'));
    loadingEl.appendChild(el('div', null, text || '正在接入地球…'));
    root.appendChild(loadingEl);
  }

  function hideLoading() {
    if (!loadingEl) return;
    loadingEl.classList.add('is-out');
    var n = loadingEl;
    loadingEl = null;
    setTimeout(function () {
      if (n && n.parentNode) n.parentNode.removeChild(n);
    }, 520);
  }

  // ============================================================
  //  烟花画布（供 world-actions.js 调用）
  // ============================================================
  function fireworksCanvasEl() {
    if (fireworksCanvas) return fireworksCanvas;
    fireworksCanvas = el('canvas', 'world-fireworks');
    if (root) root.appendChild(fireworksCanvas);
    return fireworksCanvas;
  }

  // ============================================================
  //  挂载 / 卸载
  // ============================================================
  function mount(host) {
    unmount();
    root = el('div', 'world-ui-root');
    root.style.cssText = 'position:absolute;inset:0;z-index:120;pointer-events:none;';
    host.appendChild(root);

    buildBrand();
    buildStats();
    buildSocial();
    buildCreateBtn();
    setStats({ total: 0, playing: 0, online: 0, offline: 0 });
    bindSocial();

    // 卡片需要能点，容器本身仍穿透
    return root;
  }

  function unmount() {
    clearTimeout(toastTimer);
    unbindSocial();
    hideCreatePanel();
    if (loadingEl && loadingEl.parentNode) loadingEl.parentNode.removeChild(loadingEl);
    loadingEl = null;
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    toastEl = null;
    if (fireworksCanvas && fireworksCanvas.parentNode) {
      fireworksCanvas.parentNode.removeChild(fireworksCanvas);
    }
    fireworksCanvas = null;
    fireworkBtnEl = null;
    likeBtnEl = null;
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null; statsEl = null; onAirEl = null;
    createBtnEl = null;
  }

  function setOnAir(on) {
    if (!onAirEl) return;
    onAirEl.style.opacity = on ? '1' : '0.35';
    onAirEl.style.filter = on ? 'none' : 'grayscale(1)';
  }

  function setOnAirHandler(fn) {
    onAirHandler = typeof fn === 'function' ? fn : null;
  }

  SFV.worldUi = {
    mount: mount,
    unmount: unmount,
    toast: toast,
    setStats: setStats,
    setOnAir: setOnAir,
    setOnAirHandler: setOnAirHandler,
    setHintHandler: setHintHandler,
    setRotateState: setRotateState,
    setCreateHandler: setCreateHandler,
    showCreatePanel: showCreatePanel,
    hideCreatePanel: hideCreatePanel,
    showLoading: showLoading,
    hideLoading: hideLoading,
    fireworksCanvas: fireworksCanvasEl,
    // Task 8 社交层导出面（挂尾部，不动既有表面）
    setFireworkStock: setFireworkStock,
    setFireworkProjector: setFireworkProjector,
    get root() { return root; }
  };
})(typeof window !== 'undefined' ? window : this);
