'use strict';

/**
 * 修复轮⑥ A3 — 房间面板按钮接线
 * 运行：node --test tests/world-room-a3-buttons.test.js
 *
 * 覆盖：
 *  A3-1 网络诊断 → LH.ui.showDiagnostics（RTC 链路 + STUN 数据）
 *  A3-2 无观众聊天发送 → 本地可见提示（不再无声）
 *  A3-3 关闭房间：服务端删除失败 → 失败提示（edge removeRoom 返回 false，不再假装 true）
 *  A3-4 成员轮询：pending 观众进入 Host 面板；接受按钮回传 deviceId
 *  A3-5 观众侧经轮询获知审批通过 → 自动建 RTC
 *  A3-6 updateRoomPanel 增量更新：DOM 不整面替换，接受按钮不被吞
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// ============================================================
//  world-room.js 行为面：vm + 真实 room.js + 桩 edge/ui/sync
// ============================================================
function setupRoom(opts) {
  opts = opts || {};
  const ctx = vm.createContext({
    console, Promise, Object, Array, JSON, Math, Number, String, Error, Date, RegExp,
    Uint8Array, TextEncoder, TextDecoder,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref && t.unref(); return t; },
    clearTimeout,
  });
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.crypto = undefined; // 走 Math.random 分支

  const intervals = [];
  ctx.setInterval = (fn, ms) => { intervals.push({ fn, ms, cleared: false }); return intervals.length; };
  ctx.clearInterval = (id) => { if (intervals[id - 1]) intervals[id - 1].cleared = true; };

  const calls = {
    panelSessions: [], panelUpdates: [], hidden: 0,
    chats: [], diags: [], toasts: [], chatsHidden: 0, diagsHidden: 0, chatOpen: false,
    accepts: [], rejects: [], createdRooms: [], removedRooms: [],
    rtcStarts: 0, rtcCloses: 0, refreshed: 0,
  };
  const roomState = { exists: true, code: null, guests: [] };
  if (opts.guests) roomState.guests = opts.guests;

  const LH = {
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
    security: { getDeviceId: () => opts.myId || 'host-1' },
    edge: {
      createRoom: (code, meta) => { roomState.code = code; calls.createdRooms.push({ code, meta }); return Promise.resolve({ ok: true }); },
      getRoom: (code) => {
        if (!roomState.exists) { const e = new Error('http-404'); e.code = 404; return Promise.reject(e); }
        return Promise.resolve({ exists: true, code: roomState.code, status: 'open', guests: roomState.guests.map((g) => Object.assign({}, g)) });
      },
      requestJoin: (code, info) => { calls.accepts.push; return Promise.resolve({ ok: true }); },
      hostAccept: (code, gid) => { calls.accepts.push(gid); return Promise.resolve({ ok: true }); },
      hostReject: (code, gid) => { calls.rejects.push(gid); return Promise.resolve({ ok: true }); },
      removeRoom: (code) => { calls.removedRooms.push(code); return Promise.resolve(opts.removeOk !== undefined ? opts.removeOk : true); },
      openSignal: () => ({ readyState: 1, send: () => true, close: () => {} }),
    },
    ui: {
      showRoomPanel: (s, c) => { calls.panelSessions.push(s); },
      updateRoomPanel: (s) => { calls.panelUpdates.push(s); },
      hideRoomPanel: () => { calls.hidden++; },
      showChat: (d, c) => { calls.chats.push(d); calls.chatOpen = true; },
      hideChat: () => { calls.chatsHidden++; calls.chatOpen = false; },
      isChatOpen: () => calls.chatOpen,
      updateChat: () => {},
      showDiagnostics: (d, c) => { calls.diags.push(d); calls.diagOpen = true; },
      hideDiagnostics: () => { calls.diagsHidden++; calls.diagOpen = false; },
      isDiagnosticsOpen: () => !!calls.diagOpen,
    },
    webrtc: {
      RtcSession: function (o) {
        this.opts = o; this.links = {}; this.id = 'rtc-' + calls.rtcStarts;
        calls._last = this;
      },
    },
    sync: { startBroadcast: () => {}, stopBroadcast: () => {}, handleSignal: () => {}, handleChat: () => {}, buildChat: (t, id, name) => ({ id: 'm' + t, from: id, name, text: t }), buildSwitch: () => ({}), relay: () => {} },
  };
  LH.webrtc.RtcSession.prototype.start = function () { calls.rtcStarts++; if (opts.withLink) this.links['guest-9'] = { status: 'connected' }; return true; };
  LH.webrtc.RtcSession.prototype.close = function () { calls.rtcCloses++; };

  ctx.StellaflixVideo = {
    lighthouse: LH,
    worldUi: { toast: (t) => calls.toasts.push(t), updateCardLive: () => {} },
    worldData: { fetchRooms: () => Promise.resolve({ rooms: [] }) },
    worldLighthouse: { refreshStations: () => { calls.refreshed++; } },
    worldSync: {
      setMyId: () => {}, bindPlayer: () => {}, startBroadcast: () => {}, reset: () => {},
      getCurrentVideoInfo: () => null, getPlaybackState: () => 'playing',
      onMessage: () => {}, onUpdate: () => {}, chatLog: [],
      sendChat: (t) => { calls._sentChat = (calls._sentChat || []).concat(t); return { text: t }; },
      currentVideo: null,
    },
  };

  vm.runInContext(read('public/video/lighthouse/room.js'), ctx, { filename: 'room.js' });
  vm.runInContext(read('public/video/world-room.js'), ctx, { filename: 'world-room.js' });

  const W = ctx.StellaflixVideo.worldRoom;
  const flush = async () => { await settle(20); };
  const tickMemberPoll = async () => {
    const iv = intervals.find((i) => i.ms === 3000 && !i.cleared);
    assert.ok(iv, '应注册 3s 成员轮询');
    iv.fn();
    await flush();
    return iv;
  };
  return { ctx, LH, W, calls, roomState, intervals, flush, settle, tickMemberPoll, container: {} };
}

test('A3-1：网络诊断按钮 → showDiagnostics（含 RTC 链路状态与 STUN 配置）', async () => {
  const t = setupRoom({ withLink: true });
  await t.W.createHost({ title: '测试放映', name: '测试城', lon: 0, lat: 0 }, t.container);
  await t.flush();
  assert.equal(t.calls.rtcStarts, 1, '前置：应已启动 RTC');

  const session = t.calls.panelSessions[t.calls.panelSessions.length - 1];
  assert.equal(typeof session.onDiagnostics, 'function');
  session.onDiagnostics();

  assert.equal(t.calls.diags.length, 1, 'onDiagnostics 必须真开诊断面板（旧版空回调 = 死按钮）');
  const d = t.calls.diags[0];
  assert.ok(Array.isArray(d.links) && d.links.some((l) => l.peer === 'guest-9' && l.state === 'connected'), 'P2P 链路应列出');
  assert.ok(Array.isArray(d.stun) && d.stun.join(',').includes('stun:'), 'STUN 列表应展示');
  assert.ok(d.mode, '应有传输模式描述');
});

test('A3-2：无观众时发送聊天 → 提示仅本地可见；有链路则不误报', async () => {
  const t = setupRoom();
  await t.W.createHost({ title: 'T', name: 'N', lon: 0, lat: 0 }, t.container);
  await t.flush();
  const session = t.calls.panelSessions[t.calls.panelSessions.length - 1];
  session.onOpenChat();
  assert.equal(t.calls.chats.length, 1, '前置：聊天面板应打开');

  t.calls.toasts.length = 0;
  t.calls.chats[0].onSend('你好');
  assert.deepEqual(t.calls._sentChat, ['你好'], '消息本体仍应进 worldSync.sendChat');
  assert.ok(t.calls.toasts.some((x) => /只有自己可见|暂时没有其他/.test(x)), '无观众应有反馈提示（旧版无声发送）');

  const t2 = setupRoom({ withLink: true });
  await t2.W.createHost({ title: 'T', name: 'N', lon: 0, lat: 0 }, t2.container);
  await t2.flush();
  t2.calls.panelSessions[t2.calls.panelSessions.length - 1].onOpenChat();
  t2.calls.toasts.length = 0;
  t2.calls.chats[0].onSend('你好');
  assert.ok(!t2.calls.toasts.some((x) => /只有自己可见/.test(x)), '有在线链路时不得误报');
});

test('A3-3：主播结束放映 —— 服务端删除失败必须提示（不再静默假装成功）', async () => {
  const t = setupRoom({ removeOk: false });
  await t.W.createHost({ title: 'T', name: 'N', lon: 0, lat: 0 }, t.container);
  await t.flush();
  const code = t.W.session.code;

  t.calls.toasts.length = 0;
  t.W.leave();
  assert.equal(t.calls.rtcCloses, 1, '前置：RTC 仍同步关闭');
  assert.equal(t.calls.hidden, 1, '前置：面板仍同步收起');
  await t.flush();
  assert.ok(t.calls.toasts.some((x) => /结束放映失败/.test(x)), '删除失败要如实提示：' + JSON.stringify(t.calls.toasts));

  const t2 = setupRoom({ removeOk: true });
  await t2.W.createHost({ title: 'T', name: 'N', lon: 0, lat: 0 }, t2.container);
  await t2.flush();
  t2.calls.toasts.length = 0;
  t2.W.leave();
  await t2.flush();
  assert.ok(t2.calls.toasts.some((x) => /放映已结束/.test(x)), '成功路径保持原文案');
});

test('A3-3b：edge-local removeRoom —— 服务端失败返回 false（不再 catch 成 true）', async () => {
  const ctx = vm.createContext({ console, Promise, Object, Array, JSON, Math, Number, String, Error, RegExp });
  ctx.window = ctx;
  const LH = { security: { getDeviceId: () => 'dev-1' } };
  ctx.StellaflixVideo = { lighthouse: LH };
  ctx.fetch = () => Promise.reject(new Error('network down'));
  vm.runInContext(read('public/video/lighthouse/edge-local.js'), ctx, { filename: 'edge-local.js' });
  const ok = await ctx.StellaflixVideo.lighthouse.edge.removeRoom('ABC123');
  assert.equal(ok, false, '失败必须返回 false');
  ctx.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, closed: true }) });
  const ok2 = await ctx.StellaflixVideo.lighthouse.edge.removeRoom('ABC123');
  assert.equal(ok2, true, '成功返回 true');
});

test('A3-4：成员轮询 —— pending 观众进 Host 面板；接受按钮回传 deviceId；leave 停轮询', async () => {
  const t = setupRoom({ guests: [{ deviceId: 'guest-9', nickname: '阿May', status: 'pending' }] });
  await t.W.createHost({ title: 'T', name: 'N', lon: 0, lat: 0 }, t.container);
  await t.flush();
  assert.equal(t.W.session.members.length, 0, '前置：首轮前 members 为空');

  await t.tickMemberPoll();
  const m = t.W.session.members;
  assert.equal(m.length, 1, '轮询应把服务端 guests 灌进 members');
  assert.equal(m[0].id, 'guest-9', 'id 必须是 deviceId（审批接口按 deviceId 找人）');
  assert.equal(m[0].name, '阿May');
  assert.equal(m[0].status, 'pending');
  const latest = t.calls.panelUpdates[t.calls.panelUpdates.length - 1];
  assert.ok(latest && latest.members && latest.members.length === 1, '变化应触发面板刷新');

  // 审批动作直通 edge
  const session = t.calls.panelSessions[t.calls.panelSessions.length - 1];
  session.onApprove('guest-9');
  await t.flush();
  assert.deepEqual(t.calls.accepts, ['guest-9'], 'onApprove → RoomSession.approve → edge.hostAccept(code, deviceId)');

  const before = t.calls.panelUpdates.length;
  t.W.leave();
  await t.flush();
  const iv = t.intervals.find((i) => i.ms === 3000);
  assert.ok(iv && iv.cleared, 'leave 必须停成员轮询');
});

test('A3-5：观众侧 —— 轮询发现 accepted 后自动建 RTC 并置 active', async () => {
  const myId = 'guest-9';
  const t = setupRoom({ myId });
  // 先由主播建一个真房间，拿房间码
  const host = setupRoom();
  await host.W.createHost({ title: 'T', name: 'N', lon: 0, lat: 0 }, {});
  await host.flush();
  const code = host.W.session.code;
  host.roomState.guests = [{ deviceId: myId, nickname: '我', status: 'accepted' }];

  t.roomState.code = code;
  t.roomState.guests = [{ deviceId: myId, nickname: '我', status: 'accepted' }];

  await t.W.joinWatchRoom({ id: 'room-' + code, roomId: code, name: '城', title: 'T', lon: 0, lat: 0 }, t.container);
  await t.flush();
  assert.equal(t.W.session.status, 'pending', '前置：加入后等待审批');

  await t.tickMemberPoll();
  assert.equal(t.W.session.status, 'active', '审批通过应转 active（旧版永远卡在等待主播确认）');
  assert.equal(t.calls.rtcStarts, 1, 'accepted 后应自动建立 RTC 链路');
});

// ============================================================
//  ui.js 面板增量更新：最小 DOM 桩
// ============================================================
function makeDom() {
  class FNode {
    constructor(tag) {
      this.tagName = tag; this.childNodes = []; this.parentNode = null;
      this.className = ''; this.textContent = ''; this.value = '';
      this.style = {}; this.attributes = {}; this._ls = {};
      const self = this; const cls = new Set();
      this.classList = {
        add: (c) => { cls.add(c); self.className = [...cls].join(' '); },
        remove: (c) => { cls.delete(c); self.className = [...cls].join(' '); },
        toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); self.className = [...cls].join(' '); return want; },
        contains: (c) => cls.has(c),
      };
    }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
    replaceChild(n, o) { const i = this.childNodes.indexOf(o); if (i < 0) return null; this.childNodes[i] = n; n.parentNode = this; o.parentNode = null; return o; }
    setAttribute(k, v) { this.attributes[k] = v; }
    addEventListener(ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); }
    dispatch(ev, e) { (this._ls[ev] || []).forEach((f) => f(e || { stopPropagation() {} })); }
    focus() {}
  }
  const doc = { createElement: (t) => new FNode(t) };
  const walk = (node, fn) => { fn(node); node.childNodes.forEach((c) => walk(c, fn)); };
  return {
    FNode, doc,
    byClass(root, token) { let hit = null; walk(root, (n) => { if (!hit && n.className && n.className.split(' ').includes(token)) hit = n; }); return hit; },
    allByClass(root, token) { const out = []; walk(root, (n) => { if (n.className && n.className.split(' ').includes(token)) out.push(n); }); return out; },
  };
}

function setupUi() {
  const dom = makeDom();
  const ctx = vm.createContext({ console, Object, Array, JSON, Math, String, Number, Error, RegExp, document: dom.doc });
  ctx.window = ctx;
  ctx.requestAnimationFrame = (fn) => { fn(); };
  ctx.setTimeout = (fn) => { fn(); return 0; };
  vm.runInContext(read('public/video/lighthouse/ui.js'), ctx, { filename: 'ui.js' });
  const container = new dom.FNode('div');
  return { ctx, dom, ui: ctx.StellaflixVideo.lighthouse.ui, container };
}

test('A3-6：updateRoomPanel 增量更新 —— 面板/输入框节点不整面替换，接受按钮点击不被吞', async () => {
  const t = setupUi();
  const calls = [];
  const session = {
    role: 'host', code: 'ABC123', myNickname: '主播', statusText: '放映中，等待他人加入',
    members: [], isPublic: true,
    onCopy() {}, onLeave() {}, onNickname() {}, onTogglePrivacy() {}, onDiagnostics() {}, onOpenChat() {},
    onApprove(id) { calls.push(['approve', id]); }, onReject(id) { calls.push(['reject', id]); },
  };
  t.ui.showRoomPanel(session, t.container);
  const root1 = t.container.childNodes[0];
  assert.ok(root1, '前置：面板已挂载');
  const nickInput = t.dom.byClass(root1, 'lh-room-nick');
  assert.equal(t.dom.allByClass(root1, 'lh-room-approve').length, 0);

  // pending 观众出现 → 增量刷出接受按钮
  t.ui.updateRoomPanel({ members: [{ id: 'guest-9', name: '阿May', status: 'pending' }], statusText: '放映中 · 1 人审批中' });
  assert.equal(t.container.childNodes[0], root1, 'updateRoomPanel 不得整面替换面板节点');
  assert.equal(t.dom.byClass(root1, 'lh-room-nick'), nickInput, '昵称输入框节点必须保留（焦点/未提交输入不被吞）');
  const okBtn = t.dom.byClass(root1, 'lh-room-approve');
  assert.ok(okBtn, 'pending 成员应渲染接受按钮');
  assert.ok(t.dom.byClass(root1, 'lh-room-reject'), '拒绝按钮同样');

  // 再次增量更新（其他状态变化）→ 按钮节点身份不变，点击仍生效
  t.ui.updateRoomPanel({ statusText: '放映中 · 等待审批' });
  assert.equal(t.dom.byClass(root1, 'lh-room-approve'), okBtn, '同一 pending 成员：接受按钮节点身份必须稳定');
  okBtn.dispatch('click');
  assert.deepEqual(calls, [['approve', 'guest-9']], '接受按钮必须把该成员 deviceId 回传');

  // 审批通过 → badge 更新、按钮收起、节点不重建
  t.ui.updateRoomPanel({ members: [{ id: 'guest-9', name: '阿May', status: 'accepted' }] });
  assert.equal(t.container.childNodes[0], root1);
  const badge = t.dom.byClass(root1, 'lh-room-badge');
  assert.ok(badge && /已加入/.test(badge.textContent), 'badge 应增量改为已加入：' + (badge && badge.textContent));
  const btn = t.dom.byClass(root1, 'lh-room-approve');
  assert.ok(!btn || btn.style.display === 'none', 'accepted 后接受按钮应隐藏或移除');

  // 成员消失 → 行移除，空态回来
  t.ui.updateRoomPanel({ members: [] });
  assert.equal(t.dom.allByClass(root1, 'lh-room-member').length, 0);
  assert.ok(t.dom.byClass(root1, 'lh-room-empty'), '空态占位应回来');
});

test('A3-7：leave 关闭房间时 —— 聊天/诊断浮层随房间面板一起收起（修复轮⑦：E2E 发现聊天面板孤儿）', async () => {
  const t = setupRoom();
  await t.W.createHost({ title: 'T', name: 'N', lon: 0, lat: 0 }, t.container);
  await t.flush();
  const session = t.calls.panelSessions[t.calls.panelSessions.length - 1];

  // 打开聊天 + 诊断浮层
  session.onOpenChat();
  session.onDiagnostics();
  assert.equal(t.calls.chatOpen, true, '前置：聊天面板已打开');
  assert.equal(t.calls.diagOpen, true, '前置：诊断面板已打开');

  t.W.leave();
  await t.flush();
  assert.equal(t.calls.hidden, 1, '房间面板收起（原有行为保持）');
  assert.equal(t.calls.chatsHidden, 1, '聊天面板必须随 leave 一起关闭（旧 bug：孤儿浮层悬挂）');
  assert.equal(t.calls.diagsHidden, 1, '诊断面板同样随 leave 关闭');

  // 未打开浮层时 leave 不得误调用（isChatOpen false → 不调 hideChat 也可，但调用须幂等无害）
  const t2 = setupRoom();
  await t2.W.createHost({ title: 'T', name: 'N', lon: 0, lat: 0 }, t2.container);
  await t2.flush();
  t2.W.leave();
  await t2.flush();
  assert.ok(t2.calls.chatsHidden <= 1 && t2.calls.diagsHidden <= 1, '未打开时关闭须幂等');
});

test('A3 模块语法合法', () => {
  const { execFileSync } = require('node:child_process');
  for (const f of ['public/video/world-room.js', 'public/video/lighthouse/ui.js', 'public/video/lighthouse/edge-local.js']) {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8', stdio: 'pipe' });
  }
});
