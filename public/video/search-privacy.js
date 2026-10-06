/*
 * Stellaflix 影视模块 — 搜索隐私开关（对齐 Kazumi privateMode 的搜索历史部分）
 *
 * 唯一职责：持久化「不记录搜索历史」偏好，供 online-shared 的
 * saveSearchHistory 在写入前查询。不触碰其他历史/收藏数据。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var KEY = 'stellaflix-video-search-privacy';

  function isNoSearchHistory(storage) {
    var ls = storage || global.localStorage;
    try {
      return ls ? ls.getItem(KEY) === '1' : false;
    } catch (e) { return false; }
  }

  function setNoSearchHistory(on, storage) {
    var ls = storage || global.localStorage;
    try {
      if (!ls) return;
      if (on) ls.setItem(KEY, '1');
      else ls.removeItem(KEY);
    } catch (e) {}
  }

  SFV.searchPrivacy = {
    KEY: KEY,
    isNoSearchHistory: isNoSearchHistory,
    setNoSearchHistory: setNoSearchHistory,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SFV.searchPrivacy;
  }
})(typeof window !== 'undefined' ? window : this);
