/*
 * Stellaflix 影视模块 — 世界页面（灯塔模式入口）
 *
 * 仅做路由登记与薄委托：真实视图由 public/video/lighthouse/view.js 实现，
 * 满足「影视模块铁律：index.html 零业务逻辑、业务代码放独立模块」。
 *
 * 触发路径（见 LIGHTHOUSE_MODE_PLAN.md §3.3）：
 *   影视空间 → 导航栏「世界」Tab → router.go('world') → 本页 mount → LH.view.mount
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  SFV.router.register({
    id: 'world',
    title: '世界',
    mount: function (host, ctx) {
      var LH = SFV.lighthouse;
      if (LH && LH.view) {
        LH.view.mount(host, ctx || {});
      } else {
        // 防御：灯塔模块未加载时退回占位
        host.innerHTML = '';
        var ui = SFV.ui || {};
        var wrap = (ui.el ? ui.el('div', 'sfv-placeholder') : document.createElement('div'));
        wrap.appendChild((ui.el ? ui.el('div', 'sfv-placeholder-icon', '🌍') : document.createTextNode('🌍')));
        wrap.appendChild((ui.el ? ui.el('div', 'sfv-placeholder-title', '世界模块加载中') : document.createTextNode('世界模块加载中')));
        host.appendChild(wrap);
      }
    },
    unmount: function () {
      var LH = SFV.lighthouse;
      if (LH && LH.view) LH.view.unmount();
    },
    back: function () { return false; }
  });
})(typeof window !== 'undefined' ? window : this);
