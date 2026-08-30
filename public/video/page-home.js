/*
 * Stellaflix 影视模块 — 影视首页占位（已弃用）
 *
 * 「首页」= 影视空间既有首页，由 home.js 直接渲染进主 DOM（大海报 + 心动/片单/追片/历史/音乐空间卡片 + 继续看）。
 * 它不是 #sfv-browse 覆盖层里的独立分页；online.js handleNavAction('home') 直接调用 goHome() 关闭覆盖层并刷新 home.js。
 * 保留本文件仅为了不改动 index.html 的 script 标签，避免 404。
 */
(function (global) {
  'use strict';
  // no-op：首页不再作为 router 页面注册，避免占位页覆盖真正的影视首页。
})(typeof window !== 'undefined' ? window : this);
