/*
 * Stellaflix 影视模块 — 灯塔模式 · 信标浮动卡片 UI (Phase 1)
 *
 * 对应文档 §4.8 信标浮动卡片 + §4.10 交互。职责：
 *  - 点击信标后弹出浮动卡片（海报 / 片名 / 城市 / 人数 / 加入按钮）；
 *  - 卡片定位在点击点附近并夹紧到容器内，避免超出屏幕边缘；
 *  - Phase 1 不接入网络加入，加入按钮置为“即将开放”（真实加入见 Phase 2/3）。
 *
 * 不依赖业务模块；仅做 DOM 呈现。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var cardEl = null;
  var containerEl = null;
  var _onJoin = null;        // 注入的加入回调（在线模式由 view.js 设置）

  function setJoinHandler(fn) { _onJoin = (typeof fn === 'function') ? fn : null; }

  function buildCard(beacon) {
    var c = el('div', 'lh-card');
    var v = beacon.video;

    var poster = el('div', 'lh-card-poster');
    if (v && v.posterUrl) {
      var img = el('img', 'lh-card-poster-img');
      img.src = v.posterUrl;
      img.alt = v.title || '';
      img.addEventListener('error', function () { poster.classList.add('lh-card-poster--empty'); });
      poster.appendChild(img);
    } else {
      poster.classList.add('lh-card-poster--empty');
      poster.appendChild(el('div', 'lh-card-poster-empty-icon', '📡'));
    }
    c.appendChild(poster);

    var body = el('div', 'lh-card-body');

    var status = el('div', 'lh-card-status');
    status.textContent = beacon.state === LH.STATE.GHOST ? '幽灵回放' :
      (beacon.state === LH.STATE.PLAYING ? '正在观看' : '在线');
    body.appendChild(status);

    var title = el('div', 'lh-card-title',
      (v && v.title) ? v.title : '仅在线（未播放）');
    body.appendChild(title);

    if (v && (v.season || v.episode)) {
      var ep = '第 ' + (v.season || '?') + ' 季 · 第 ' + (v.episode || '?') + ' 集';
      body.appendChild(el('div', 'lh-card-sub', ep));
    }

    var meta = el('div', 'lh-card-meta');
    meta.appendChild(el('span', 'lh-card-city', beacon.city || '未知城市'));
    if (beacon.country) meta.appendChild(el('span', 'lh-card-country', beacon.country));
    meta.appendChild(el('span', 'lh-card-viewers', '👥 ' + (beacon.viewers || 1)));
    body.appendChild(meta);

    var actions = el('div', 'lh-card-actions');
    var joinBtn = el('button', 'lh-card-join', beacon.roomCode ? ('加入 ' + beacon.roomCode) : '加入灯塔');
    joinBtn.type = 'button';
    if (_onJoin && beacon.roomCode) {
      joinBtn.disabled = false;
      joinBtn.title = '加入该房间 · 一起看';
      joinBtn.addEventListener('click', function (e) { e.stopPropagation(); hideCard(); _onJoin(beacon.roomCode); });
    } else {
      joinBtn.disabled = true; // 离线演示 / 无房间码：禁用
      joinBtn.title = '一起看功能将在后续阶段开放';
    }
    actions.appendChild(joinBtn);
    body.appendChild(actions);

    var close = el('button', 'lh-card-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', function (e) {
      e.stopPropagation();
      hideCard();
    });
    c.appendChild(close);

    c.appendChild(body);
    return c;
  }

  function showCard(beacon, screenPos, container) {
    if (!beacon || !container) return;
    containerEl = container;
    hideCard();
    cardEl = buildCard(beacon);
    container.appendChild(cardEl);

    var W = container.clientWidth || 800, H = container.clientHeight || 600;
    var cw = cardEl.offsetWidth || 240, ch = cardEl.offsetHeight || 200;
    var x = (screenPos ? screenPos.x : W / 2) + 18;
    var y = (screenPos ? screenPos.y : H / 2) - ch / 2;
    x = Math.max(8, Math.min(x, W - cw - 8));
    y = Math.max(8, Math.min(y, H - ch - 8));
    cardEl.style.left = x + 'px';
    cardEl.style.top = y + 'px';
    cardEl.classList.add('lh-card--in');
  }

  function hideCard() {
    if (cardEl && cardEl.parentNode) cardEl.parentNode.removeChild(cardEl);
    cardEl = null;
  }

  // ============================================================
  //  「我的房间」面板 (Phase 3) — Host 审批 / Guest 状态 / 成员与人数
  //  仅做 DOM 呈现；业务动作（复制/离开/切换公开/审批）经 callbacks 上抛给 view.js。
  // ============================================================
  var roomEl = null;
  var roomContainer = null;
  var _roomData = null;        // 最近一次数据（用于 update 合并）
  var _roomCb = {};            // 回调集合（首次 show 注入，update 复用）

  function roomBadge(status) {
    var map = { accepted: ['已加入', 'ok'], pending: ['等待审批', 'wait'], rejected: ['已拒绝', 'no'], connected: ['已连接', 'ok'] };
    var b = map[status] || ['—', 'wait'];
    var e = el('span', 'lh-room-badge lh-room-badge--' + b[1], b[0]);
    return e;
  }

  function buildRoomPanel(s) {
    var p = el('div', 'lh-room-panel');
    p.appendChild((function () {
      var h = el('div', 'lh-room-head');
      h.appendChild(el('div', 'lh-room-title', '我的房间'));
      var close = el('button', 'lh-room-close', '×');
      close.type = 'button'; close.setAttribute('aria-label', '关闭');
      close.addEventListener('click', function () { hideRoomPanel(); });
      h.appendChild(close);
      return h;
    })());

    // 房间码 / 加入状态
    var codeRow = el('div', 'lh-room-code-row');
    if (s.role === 'host') {
      codeRow.appendChild(el('span', 'lh-room-code-label', '房间码'));
      codeRow.appendChild(el('span', 'lh-room-code', s.code || '------'));
      var copy = el('button', 'lh-room-copy', '复制');
      copy.type = 'button';
      copy.addEventListener('click', function () { if (_roomCb.onCopy) _roomCb.onCopy(s.code); });
      codeRow.appendChild(copy);
    } else {
      codeRow.appendChild(el('span', 'lh-room-code-label', '已加入'));
      codeRow.appendChild(el('span', 'lh-room-code', s.code || '------'));
    }
    p.appendChild(codeRow);

    // 昵称（可编辑，持久化）
    var nickRow = el('div', 'lh-room-nick-row');
    nickRow.appendChild(el('span', 'lh-room-nick-label', '昵称'));
    var nickInput = el('input', 'lh-room-nick');
    nickInput.type = 'text'; nickInput.maxLength = 16; nickInput.value = s.myNickname || '匿名灯塔';
    nickInput.placeholder = '你的昵称';
    nickInput.addEventListener('change', function () { if (_roomCb.onNickname) _roomCb.onNickname(nickInput.value); });
    nickRow.appendChild(nickInput);
    p.appendChild(nickRow);

    // 状态行
    p.appendChild(el('div', 'lh-room-status', s.statusText || ''));

    // 人数 2/4
    var count = el('div', 'lh-room-count');
    count.appendChild(el('span', 'lh-room-count-num', (s.members ? s.members.filter(function (m) { return m.status === 'accepted' || m.status === 'connected'; }).length : 0) + ' / 4'));
    count.appendChild(el('span', 'lh-room-count-label', ' 在线成员'));
    p.appendChild(count);

    // 公开灯塔开关（双方：控制本端 beacon 是否出现在他人世界地图）
    var togg = el('button', 'lh-room-toggle' + (s.isPublic ? ' is-on' : ''), s.isPublic ? '公开灯塔：开' : '公开灯塔：关');
    togg.type = 'button';
    togg.addEventListener('click', function () {
      var nv = !s.isPublic; s.isPublic = nv;
      togg.classList.toggle('is-on', nv);
      togg.textContent = nv ? '公开灯塔：开' : '公开灯塔：关';
      if (_roomCb.onTogglePrivacy) _roomCb.onTogglePrivacy(nv);
    });
    p.appendChild(togg);
    p.appendChild(el('div', 'lh-room-note', '关闭后你的灯塔不再出现在他人世界地图（仍可凭房间码一起看）。'));

    // 成员列表
    var list = el('div', 'lh-room-members');
    (s.members || []).forEach(function (m) {
      var row = el('div', 'lh-room-member');
      row.appendChild(el('span', 'lh-room-member-name', m.name || m.id || '匿名灯塔'));
      row.appendChild(roomBadge(m.status));
      if (s.role === 'host' && m.status === 'pending') {
        var ok = el('button', 'lh-room-approve', '接受');
        ok.type = 'button';
        ok.addEventListener('click', function () { if (_roomCb.onApprove) _roomCb.onApprove(m.id); });
        var no = el('button', 'lh-room-reject', '拒绝');
        no.type = 'button';
        no.addEventListener('click', function () { if (_roomCb.onReject) _roomCb.onReject(m.id); });
        row.appendChild(ok); row.appendChild(no);
      }
      list.appendChild(row);
    });
    if (!(s.members && s.members.length)) {
      list.appendChild(el('div', 'lh-room-empty', s.role === 'host' ? '等待他人加入…' : '等待房主确认…'));
    }
    p.appendChild(list);

    // 离开 / 关闭 + 网络诊断 + 聊天
    var foot = el('div', 'lh-room-foot');
    var footRow = el('div', 'lh-room-foot-row');
    var diag = el('button', 'lh-room-diag', '网络诊断');
    diag.type = 'button';
    diag.addEventListener('click', function () { if (_roomCb.onDiagnostics) _roomCb.onDiagnostics(); });
    footRow.appendChild(diag);
    var chat = el('button', 'lh-room-chat', '聊天');
    chat.type = 'button';
    chat.addEventListener('click', function () { if (_roomCb.onOpenChat) _roomCb.onOpenChat(); });
    footRow.appendChild(chat);
    foot.appendChild(footRow);
    var leave = el('button', 'lh-room-leave', s.role === 'host' ? '关闭房间' : '离开房间');
    leave.type = 'button';
    leave.addEventListener('click', function () { if (_roomCb.onLeave) _roomCb.onLeave(); });
    foot.appendChild(leave);
    p.appendChild(foot);

    return p;
  }

  function showRoomPanel(session, container) {
    if (!session || !container) return;
    roomContainer = container;
    _roomData = Object.assign({}, session);
    _roomCb = {
      onCopy: session.onCopy, onLeave: session.onLeave,
      onNickname: session.onNickname, onTogglePrivacy: session.onTogglePrivacy,
      onDiagnostics: session.onDiagnostics, onOpenChat: session.onOpenChat,
      onApprove: session.onApprove, onReject: session.onReject
    };
    hideRoomPanel();
    roomEl = buildRoomPanel(_roomData);
    container.appendChild(roomEl);
    requestAnimationFrame(function () { if (roomEl) roomEl.classList.add('lh-room-panel--in'); });
  }

  // 增量更新：仅数据变化，回调沿用首次注入
  function updateRoomPanel(data) {
    if (!roomEl || !roomContainer) return;
    _roomData = Object.assign({}, _roomData, data);
    var fresh = buildRoomPanel(_roomData);
    roomContainer.replaceChild(fresh, roomEl);
    roomEl = fresh;
    requestAnimationFrame(function () { if (roomEl) roomEl.classList.add('lh-room-panel--in'); });
  }

  function hideRoomPanel() {
    if (roomEl && roomEl.parentNode) roomEl.parentNode.removeChild(roomEl);
    roomEl = null;
  }

  // ============================================================
  //  网络诊断面板 (Phase 4 #4) — 展示传输模式 / 边缘 / STUN / P2P 连接 / 广播·零源
  // ============================================================
  var diagEl = null, diagContainer = null;

  function buildDiagPanel(d) {
    var p = el('div', 'lh-diag-panel');
    p.appendChild((function () {
      var h = el('div', 'lh-diag-head');
      h.appendChild(el('div', 'lh-diag-title', '网络诊断'));
      var c = el('button', 'lh-diag-close', '×');
      c.type = 'button'; c.setAttribute('aria-label', '关闭');
      c.addEventListener('click', function () { hideDiagnostics(); });
      h.appendChild(c);
      return h;
    })());
    function row(k, v, cls) {
      var r = el('div', 'lh-diag-row');
      r.appendChild(el('span', 'lh-diag-k', k));
      r.appendChild(el('span', 'lh-diag-v' + (cls ? ' ' + cls : ''), v));
      return r;
    }
    p.appendChild(row('传输模式', d.mode));
    p.appendChild(row('在线状态', d.online ? '在线' : '离线演示', d.online ? 'ok' : 'wait'));
    p.appendChild(row('边缘端点', d.endpoint, d.online ? '' : 'wait'));
    p.appendChild(row('STUN 节点', d.stun.length ? d.stun.join(' , ') : '（未配置）'));
    p.appendChild(row('同步广播', d.broadcasting ? '广播中' : '未广播', d.broadcasting ? 'ok' : 'wait'));
    p.appendChild(row('零源地址', d.resolveUrl ? '已下发' : '无', d.resolveUrl ? 'ok' : 'wait'));
    var conn = el('div', 'lh-diag-row');
    conn.appendChild(el('span', 'lh-diag-k', 'P2P 连接'));
    var cv = el('span', 'lh-diag-v');
    if (!d.links.length) cv.textContent = '（无）';
    else d.links.forEach(function (l) {
      cv.appendChild(el('span', 'lh-diag-peer ' + (l.state === 'connected' ? 'ok' : 'wait'), (l.peer || '').slice(0, 6) + '·' + l.state));
    });
    conn.appendChild(cv);
    p.appendChild(conn);
    return p;
  }
  function showDiagnostics(d, container) {
    if (!container) return;
    diagContainer = container;
    hideDiagnostics();
    diagEl = buildDiagPanel(d);
    container.appendChild(diagEl);
    requestAnimationFrame(function () { if (diagEl) diagEl.classList.add('lh-diag-panel--in'); });
  }
  function updateDiagnostics(d) {
    if (!diagEl || !diagContainer) return;
    var f = buildDiagPanel(d);
    diagContainer.replaceChild(f, diagEl);
    diagEl = f;
    requestAnimationFrame(function () { if (diagEl) diagEl.classList.add('lh-diag-panel--in'); });
  }
  function hideDiagnostics() {
    if (diagEl && diagEl.parentNode) diagEl.parentNode.removeChild(diagEl);
    diagEl = null;
  }
  function isDiagnosticsOpen() { return !!diagEl; }

  // ============================================================
  //  房间群聊面板 (Phase 4 #7) — 消息列表 + 输入框 + 发送（回车/点击）
  // ============================================================
  var chatEl = null, chatContainer = null, _chatCb = {};

  function chatMsgEl(m) {
    var r = el('div', 'lh-chat-msg');
    r.appendChild(el('span', 'lh-chat-name', (m.name || m.from || '匿名') + '：'));
    r.appendChild(el('span', 'lh-chat-text', m.text || ''));
    return r;
  }
  function buildChatPanel(d) {
    var p = el('div', 'lh-chat-panel');
    p.appendChild((function () {
      var h = el('div', 'lh-chat-head');
      h.appendChild(el('div', 'lh-chat-title', '房间聊天'));
      var c = el('button', 'lh-chat-close', '×');
      c.type = 'button'; c.setAttribute('aria-label', '关闭');
      c.addEventListener('click', function () { hideChat(); });
      h.appendChild(c);
      return h;
    })());
    var msgs = el('div', 'lh-chat-msgs');
    (d.messages || []).forEach(function (m) { msgs.appendChild(chatMsgEl(m)); });
    p.appendChild(msgs);
    var row = el('div', 'lh-chat-input-row');
    var input = el('input', 'lh-chat-input');
    input.type = 'text'; input.maxLength = 200; input.placeholder = '说点什么…';
    var send = el('button', 'lh-chat-send', '发送');
    send.type = 'button';
    function doSend() {
      var t = input.value;
      if (t && _chatCb.onSend) _chatCb.onSend(t);
      input.value = '';
      if (input.focus) try { input.focus(); } catch (e) {}
    }
    send.addEventListener('click', doSend);
    input.addEventListener('keydown', function (e) { if (e && e.key === 'Enter') doSend(); });
    row.appendChild(input); row.appendChild(send);
    p.appendChild(row);
    // 自动滚到底部
    try { setTimeout(function () { msgs.scrollTop = msgs.scrollHeight || 0; }, 0); } catch (e) {}
    return p;
  }
  function showChat(d, container) {
    if (!container) return;
    chatContainer = container;
    _chatCb = { onSend: d.onSend, onClose: d.onClose };
    hideChat();
    chatEl = buildChatPanel(d);
    container.appendChild(chatEl);
    requestAnimationFrame(function () { if (chatEl) chatEl.classList.add('lh-chat-panel--in'); });
  }
  function updateChat(d) {
    if (!chatEl || !chatContainer) return;
    _chatCb = { onSend: d.onSend, onClose: d.onClose };
    var f = buildChatPanel(d);
    chatContainer.replaceChild(f, chatEl);
    chatEl = f;
    requestAnimationFrame(function () { if (chatEl) chatEl.classList.add('lh-chat-panel--in'); });
  }
  function hideChat() {
    if (chatEl && chatEl.parentNode) chatEl.parentNode.removeChild(chatEl);
    chatEl = null;
  }
  function isChatOpen() { return !!chatEl; }

  LH.ui = {
    showCard: showCard, hideCard: hideCard, setJoinHandler: setJoinHandler,
    showRoomPanel: showRoomPanel, updateRoomPanel: updateRoomPanel, hideRoomPanel: hideRoomPanel,
    showDiagnostics: showDiagnostics, updateDiagnostics: updateDiagnostics,
    hideDiagnostics: hideDiagnostics, isDiagnosticsOpen: isDiagnosticsOpen,
    showChat: showChat, updateChat: updateChat, hideChat: hideChat, isChatOpen: isChatOpen
  };
})(typeof window !== 'undefined' ? window : this);
