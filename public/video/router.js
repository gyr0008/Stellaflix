/*
 * Stellaflix 影视模块 — 页面路由管理器 (T127)
 *
 * 职责：把顶部导航的 3 个分页（首页 / 汇联 / 世界）管理为
 *   **彼此独立的页面模块**，而非「单一覆盖层里的 kind 参数化视图」。
 *
 * 设计要点：
 *   - 每个页面模块通过 SFV.router.register({ id, title, mount, back }) 注册；
 *     mount(host) 时 fully owns `host`（先清空再渲染），与 legacy 视图（搜索/分类/
 *     规则/详情）互斥，绝不相互串台。
 *   - 各分页为独立注册页面模块（首页 / 汇联 / 世界各自文件注册），
 *     满足「不同新页面」铁律。
 *   - 本管理器不触碰任何 CSS 级联变量；背景/网格 DIY 变量仍由 online.js 写到
 *     bodyEl（页面同样渲染进 bodyEl），保持既有视觉契约不变。
 *   - 仅提供纯路由能力，不含任何业务逻辑。
 *
 * 双态隔离：页面仅存在于影视态（body.video-space-active）的 #sfv-browse 内部；
 *   模块本身不感知音乐态，亦不写入音乐态 DOM。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var pages = {};        // id -> page def { id, title, mount, back }
  var order = [];        // 注册顺序
  var currentPageId = null;  // 当前激活页面 id（与 currentId() 函数区分，避免变量覆盖函数）
  var host = null;       // 渲染宿主（online.js 注入的 bodyEl）

  function register(p) {
    if (!p || !p.id) return;
    pages[p.id] = p;
    if (order.indexOf(p.id) === -1) order.push(p.id);
  }

  // online.js 在 ensure() 创建 bodyEl 后调用，注入渲染宿主
  function setHost(h) { host = h; }

  // 切换到某个页面：先卸载当前页（若有 unmount），再清空宿主并交给新页面 mount
  function go(id) {
    var p = pages[id];
    if (!p || !host) return;
    var cur = pages[currentPageId];
    if (cur && typeof cur.unmount === 'function') {
      try { cur.unmount(); } catch (e) {}
    }
    host.innerHTML = '';
    currentPageId = id;
    if (typeof p.mount === 'function') {
      p.mount(host, { router: api, shell: SFV.online });
    }
  }

  function current() { return pages[currentPageId] || null; }
  function currentId() { return currentPageId; }
  function listIds() { return order.slice(); }

  var api = {
    register: register,
    setHost: setHost,
    go: go,
    current: current,
    currentId: currentId,
    listIds: listIds
  };
  SFV.router = api;
})(typeof window !== 'undefined' ? window : this);
