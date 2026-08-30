/*
 * Stellaflix 影视模块 — 数据分发层 (Step 2)
 * 双态同构核心：同一份 DOM，注册式 slot 按当前 spaceMode 选择 music/video provider 渲染。
 * 不持有任何具体 UI 内容，内容由 Step 3+ 的模块注册进来。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var slots = new Map(); // name -> { el, music, video }
  var bound = false;

  function currentSpace() {
    return SFV.state ? SFV.state.getSpace() : 'music';
  }

  function registerSlot(name, opts) {
    if (!name) throw new Error('dispatch.registerSlot: name required');
    opts = opts || {};
    slots.set(name, {
      el: opts.el || null,
      music: typeof opts.music === 'function' ? opts.music : null,
      video: typeof opts.video === 'function' ? opts.video : null,
    });
  }

  function unregisterSlot(name) {
    slots.delete(name);
  }

  function getSlot(name) {
    return slots.get(name) || null;
  }

  function renderSlot(name) {
    var slot = slots.get(name);
    if (!slot) return;
    var space = currentSpace();
    var provider = space === 'video' ? slot.video : slot.music;
    if (typeof provider === 'function') {
      try {
        provider(slot.el, { space: space, name: name });
      } catch (e) {
        if (global.console) global.console.error('[SFV dispatch] slot "' + name + '" render failed:', e);
      }
    }
  }

  function renderAll() {
    slots.forEach(function (_v, name) {
      renderSlot(name);
    });
  }

  function bind() {
    if (bound) return;
    if (SFV.state && SFV.state.EVENT && global.addEventListener) {
      global.addEventListener(SFV.state.EVENT, function () {
        renderAll();
        // T118 修复（P0）：空间切换时同步 3D 歌单架内容。
        // 原因：3D 歌单架的 currentItems() 已正确按 spaceMode 走 video/music 分支，
        //   但 shelfManager.rebuild() 没有任何监听器触发，导致切换空间后 3D 歌单架
        //   仍残留上次的内容。scheduleShelfRebuild 已通过 index.html 暴露到 window。
        if (typeof global.scheduleShelfRebuild === 'function') {
          try { global.scheduleShelfRebuild('spacechange', true); } catch (e) {}
        }
      });
      bound = true;
    }
    // P0：绑定后立刻按当前态渲染一次——避免「state.init() 先 emit() → dispatch.bind() 后注册监听器」
    // 造成的初始态漏通知（例如启动偏好=影视时，emit 早发生、listener 未绑定，导致 slot 永远不渲染）。
    // 仅渲染 bind 时刻已注册的 slots；后续注册的 slot 由模块自身负责初始同步（见 home.install 的
    // `if (isVideoSpace()) render()` 模式）。
    try { renderAll(); } catch (e) {
      if (global.console) global.console.warn('[SFV dispatch] bind-time renderAll failed:', e);
    }
  }

  SFV.dispatch = {
    registerSlot: registerSlot,
    unregisterSlot: unregisterSlot,
    getSlot: getSlot,
    renderSlot: renderSlot,
    renderAll: renderAll,
    bind: bind,
  };
})(typeof window !== 'undefined' ? window : this);
