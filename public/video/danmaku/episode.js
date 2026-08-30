/*
 * Stellaflix 影视模块 — 弹幕剧集匹配数据层 (DanmakuEpisode / DanmakuEpisodeResponse)
 *
 * 移植自 Kazumi lib/modules/danmaku/danmaku_episode_response.dart（GPL-3.0, Predidit/Kazumi）。
 * 对应 DanDanPlay 的 match 接口返回结构：
 *   bangumi.{ animeId, episodes:[{episodeId, episodeTitle}] }
 *   + success / errorCode / errorMessage
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var danmaku = (SFV.danmaku = SFV.danmaku || {});

  function DanmakuEpisode(opts) {
    opts = opts || {};
    this.episodeId = opts.episodeId;
    this.episodeTitle = opts.episodeTitle != null ? String(opts.episodeTitle) : '';
  }
  DanmakuEpisode.fromJson = function (json) {
    if (!json) return null;
    return new DanmakuEpisode({ episodeId: json.episodeId, episodeTitle: json.episodeTitle });
  };
  DanmakuEpisode.prototype.toJson = function () {
    return { episodeId: this.episodeId, episodeTitle: this.episodeTitle };
  };

  function DanmakuEpisodeResponse(opts) {
    opts = opts || {};
    this.bangumiId = opts.bangumiId;
    this.episodes = opts.episodes || [];
    this.errorCode = opts.errorCode;
    this.success = opts.success;
    this.errorMessage = opts.errorMessage != null ? String(opts.errorMessage) : '';
  }
  DanmakuEpisodeResponse.fromJson = function (json) {
    if (!json) return DanmakuEpisodeResponse.fromTemplate();
    var bangumi = json.bangumi || {};
    var list = bangumi.episodes || [];
    var episodes = list
      .map(function (i) { return DanmakuEpisode.fromJson(i); })
      .filter(Boolean);
    return new DanmakuEpisodeResponse({
      bangumiId: bangumi.animeId,
      episodes: episodes,
      errorCode: json.errorCode,
      success: json.success,
      errorMessage: json.errorMessage
    });
  };
  DanmakuEpisodeResponse.fromTemplate = function () {
    return new DanmakuEpisodeResponse({ bangumiId: 0, episodes: [], errorCode: 0, success: false, errorMessage: '' });
  };
  DanmakuEpisodeResponse.prototype.toJson = function () {
    // 与 DanDanPlay match 响应结构一致（嵌套 bangumi.{animeId,episodes}），保证 fromJson/toJson 可往返。
    // 注：Kazumi 源 toJson 将 bangumi 写为平铺数组，与 fromJson 的 bangumi.episodes 不自洽；此处修正为嵌套以自洽。
    return {
      bangumi: {
        animeId: this.bangumiId,
        episodes: this.episodes.map(function (e) { return e.toJson(); })
      },
      errorCode: this.errorCode,
      success: this.success,
      errorMessage: this.errorMessage
    };
  };

  danmaku.DanmakuEpisode = DanmakuEpisode;
  danmaku.DanmakuEpisodeResponse = DanmakuEpisodeResponse;
})(typeof window !== 'undefined' ? window : this);
