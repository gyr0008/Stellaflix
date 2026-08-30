/*
 * Stellaflix 影视模块 — 影视态 modal 提到 body（根层叠上下文）包裹层
 *
 * 根因：#desktop-window-shell 因 transform/clip-path 形成独立层叠上下文，
 * 其内部所有 .modal-mask（收藏片单 #collect-modal、视频详情 #track-detail-modal 等）
 * 被牢牢困在该上下文内，永远压不过根上下文的 #sfv-overlay（z-index:2147483000）。
 * 表现为：影视态点击「收藏」→ 片单不弹出 / 「视频详情」不浮在视频上。
 *
 * 此前 video-info-modal.js 仅对 #track-detail-modal 做了 reparent（针对性修复）。
 * 本脚本作为统一收口：包裹全局 openGsapModal / closeGsapModal，在影视态打开任意
 * modal 前把它 append 到 body（与 overlay 同处根上下文，借各自 z-index 压过视频层），
 * 关闭后还原回原父节点。音乐态（无 video 类）不触发，行为不变。
 *
 * 安装时机：music.js 在 index.html 末尾（body 结束前）加载，video 脚本在 head 加载，
 * 故本脚本不能在加载期直接捕获 openGsapModal（彼时尚未定义）。改为在 DOMContentLoaded
 * 再包裹——此时 music.js 已执行完毕，openGsapModal / closeGsapModal 均已就位。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  if (SFV._modalVideoReparent) return;
  SFV._modalVideoReparent = true;

  function inVideo() {
    var b = global.document && global.document.body;
    return !!b && (b.classList.contains('video-player-active') || b.classList.contains('video-space-active'));
  }
  function reparent(modal) {
    var d = global.document;
    if (!d || !d.body || !modal) return;
    if (modal._sfvOrigParent) return;          // 已处理（含 video-info-modal 先行 reparent 的情况）
    if (modal.parentNode === d.body) return;   // 已在 body
    modal._sfvOrigParent = modal.parentNode;
    modal._sfvOrigNext = modal.nextSibling;
    d.body.appendChild(modal);
  }
  function restore(modal) {
    if (!modal || !modal._sfvOrigParent) return;
    try {
      if (modal._sfvOrigNext && modal._sfvOrigNext.parentNode === modal._sfvOrigParent) {
        modal._sfvOrigParent.insertBefore(modal, modal._sfvOrigNext);
      } else {
        modal._sfvOrigParent.appendChild(modal);
      }
    } catch (e) {}
    modal._sfvOrigParent = null;
    modal._sfvOrigNext = null;
  }

  function install() {
    var origOpen = global.openGsapModal;
    var origClose = global.closeGsapModal;
    global.openGsapModal = function (modal) {
      if (inVideo()) reparent(modal);
      if (typeof origOpen === 'function') origOpen(modal);
    };
    global.closeGsapModal = function (modal) {
      if (typeof origClose === 'function') origClose(modal);
      restore(modal);
    };
  }

  if (global.document && global.document.readyState !== 'loading') install();
  else if (global.addEventListener) global.addEventListener('DOMContentLoaded', install);
})(typeof window !== 'undefined' ? window : this);
