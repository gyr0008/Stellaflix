/*
 * Stellaflix 影视模块 — 汇联页（占位壳）
 *
 * 完整实现已下线。若此文件仍被加载，仅注册占位页，避免抛错或覆盖。
 * 当前生效的是 page-discover.js（index.html 已改挂它）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  function mount(host) {
    if (SFV.ui && typeof SFV.ui.setTitle === 'function') SFV.ui.setTitle('汇联');
    host.innerHTML = '';
    var box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:400px;color:rgba(255,255,255,0.7);text-align:center;padding:40px;pointer-events:none;user-select:none;';
    var t = document.createElement('div');
    t.textContent = '汇联';
    t.style.cssText = 'font-size:24px;font-weight:300;letter-spacing:4px;margin-bottom:12px;color:rgba(255,255,255,0.85);';
    var s = document.createElement('div');
    s.textContent = '功能维护中，敬请期待';
    s.style.cssText = 'font-size:14px;opacity:0.5;letter-spacing:2px;';
    box.appendChild(t);
    box.appendChild(s);
    host.appendChild(box);
  }

  function unmount() {}
  function back() { unmount(); return false; }

  if (SFV.router && typeof SFV.router.register === 'function') {
    SFV.router.register({ id: 'discover', title: '汇联', mount: mount, unmount: unmount, back: back });
  } else {
    SFV.huilianPage = { mount: mount, unmount: unmount, back: back };
  }
})(typeof window !== 'undefined' ? window : this);
