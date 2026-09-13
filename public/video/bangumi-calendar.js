/**
 * Stellaflix — Bangumi 周表 Widget（兼容转发层）
 *
 * 本文件的渲染实现已迁移至 bangumi-timeline.js（Kazumi timeline_page 移植版）：
 *   - UI 形态：7 列紧凑网格 -> 单日大卡片 + 七日 TabBar（Kazumi 形态）
 *   - 能力：新增季度切换（时间机器）、热度排序改为 votes 降序、卡片三指标
 *
 * 为不破坏既有调用点（page-collections.js 的 calendar 分支、历史引用），
 * 这里保留 SFV.bangumiCalendar 名称，全部方法转发到 SFV.bangumiTimeline。
 *
 * 样式说明：
 *   - bangumi-calendar.css 仍保留 .sfv-bgm-pop*（追番/加入片单弹层），被两个模块共用；
 *   - 新的页面样式在 bangumi-timeline.css。
 *
 * @license GPL-3.0
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;

  function tl() { return SFV.bangumiTimeline || null; }

  function mount(host) {
    var m = tl();
    if (m && typeof m.mount === 'function') return m.mount(host);
    if (host) host.innerHTML = '<div class="sfv-bgm-tl-ph">Bangumi 时间表模块未加载</div>';
  }
  function refresh() {
    var m = tl();
    if (m && typeof m.refresh === 'function') m.refresh();
  }
  function openPopup() {
    var m = tl();
    if (m && typeof m.openPopup === 'function') m.openPopup();
  }
  function closePopup() {
    var m = tl();
    if (m && typeof m.closePopup === 'function') m.closePopup();
  }
  function openPage() {
    var m = tl();
    if (m && typeof m.openPage === 'function') m.openPage();
  }

  SFV.bangumiCalendar = {
    mount: mount,
    refresh: refresh,
    openPopup: openPopup,
    closePopup: closePopup,
    openPage: openPage,
    get _state() { var m = tl(); return m ? m._state : {}; }
  };
})(typeof window !== 'undefined' ? window : this);
