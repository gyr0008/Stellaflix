/*
 * Stellaflix 影视模块 — 弹幕 API 客户端 (DanDanPlay / 弹弹play)
 *
 * 严格对齐 DanDanPlay 开放弹幕网络 API（base: https://api.dandanplay.net，GPL 兼容使用）。
 * 认证：自 2025-01-30 起强制认证，采用「签名验证模式」：
 *   X-Signature = base64( sha256( AppId + Timestamp + Path + AppSecret ) )
 *   请求头：X-Auth / X-AppId / X-Signature / X-Timestamp
 * 所有请求经本应用 /api/proxy 转发（解决浏览器 CORS），认证头由代理白名单透传。
 *
 * 合规红线：AppId / AppSecret 由用户自行向弹弹play申请并配置于本地（localStorage），
 *           绝不硬编码、绝不出厂预置。本客户端只做「拉取」不做「预置」。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var danmaku = (SFV.danmaku = SFV.danmaku || {});

  var DEFAULT_BASE = 'https://api.dandanplay.net';

  // ====== 默认凭证（构建期注入，对齐 Kazumi dandan_credentials.dart 模式）======
  // 源码中这两个占位符**始终为空**，绝不硬编码任何明文凭证（合规红线 + GPLv3）。
  // 真正的 AppId / AppSecret 由构建期(afterPack) 从环境变量注入**打包副本**：
  //   DANDANAPI_APPID / DANDANAPI_KEY   （命名对齐 Kazumi，值与 Kazumi 无关）
  // 注入方式：build/after-pack.js 读环境变量 → 正则替换下方占位符 '' 为真实值。
  //   源码工作树永远留空（零污染）；未设置环境变量时打包副本保持 ''，由用户在
  //   设置面板自行配置（AppId/AppSecret 存于 localStorage）。
  var DEFAULT_APP_ID = '';       // 注入点：打包期(afterPack) 读取 DANDANAPI_APPID 替换（勿在源码硬编码）
  var DEFAULT_APP_SECRET = '';   // 注入点：打包期(afterPack) 读取 DANDANAPI_KEY 替换（勿在源码硬编码）

  var cfg = {
    baseUrl: DEFAULT_BASE,
    proxyBase: '',          // 同域 /api/proxy（Electron 与 Vite 均适用）
    appId: DEFAULT_APP_ID,
    appSecret: DEFAULT_APP_SECRET
  };

  // 可注入的 sha256->base64 实现（浏览器默认 Web Crypto，单测注入 Node crypto）
  var _sha256Base64 = null;

  function arrayBufferToBase64(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    if (typeof btoa === 'function') return btoa(bin);
    return Buffer.from(bytes).toString('base64');
  }

  function defaultSha256Base64(str) {
    if (_sha256Base64) return Promise.resolve(_sha256Base64(str));
    if (global.crypto && global.crypto.subtle && global.crypto.subtle.digest) {
      var data = (global.TextEncoder ? new TextEncoder().encode(str) : Buffer.from(str, 'utf8'));
      return global.crypto.subtle.digest('SHA-256', data).then(arrayBufferToBase64);
    }
    return Promise.reject(new Error('DANMAKU_NO_CRYPTO'));
  }

  // 生成签名验证模式所需的请求头（apiPath 不含域名、不含查询串）
  function makeAuthHeaders(apiPath) {
    if (!cfg.appId || !cfg.appSecret) {
      return Promise.reject(new Error('DANMAKU_AUTH_REQUIRED'));
    }
    var ts = Math.floor(Date.now() / 1000);
    return defaultSha256Base64(cfg.appId + ts + apiPath + cfg.appSecret).then(function (sig) {
      return {
        'X-Auth': '1',
        'X-AppId': cfg.appId,
        'X-Signature': sig,
        'X-Timestamp': String(ts)
      };
    });
  }

  function serialize(q) {
    return Object.keys(q).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]);
    }).join('&');
  }

  function buildProxyUrl(apiPath, query) {
    var qs = query ? '?' + (global.URLSearchParams ? new URLSearchParams(query).toString() : serialize(query)) : '';
    var target = cfg.baseUrl + apiPath + qs;
    return (cfg.proxyBase || '') + '/api/proxy?url=' + encodeURIComponent(target);
  }

  // 统一请求入口：签名 → 走 /api/proxy → 解析 JSON
  function request(apiPath, query) {
    return makeAuthHeaders(apiPath).then(function (auth) {
      var url = buildProxyUrl(apiPath, query);
      var headers = Object.assign({ 'Accept': 'application/json' }, auth);
      if (!global.fetch) return Promise.reject(new Error('DANMAKU_NO_FETCH'));
      return global.fetch(url, { headers: headers })
        .then(function (resp) {
          if (!resp.ok) {
            if (resp.status === 401 || resp.status === 403) {
              return resp.json().catch(function () { return {}; }).then(function (j) {
                throw new Error('DANMAKU_AUTH_FAILED:' + (j.errorMessage || resp.status));
              });
            }
            throw new Error('DANMAKU_HTTP_' + resp.status);
          }
          return resp.json();
        })
        .then(function (json) {
          if (!json || json.success === false) {
            throw new Error('DANMAKU_API_ERROR:' + (json && json.errorMessage ? json.errorMessage : (json && json.errorCode)));
          }
          return json;
        });
    });
  }

  // 搜索番剧（按关键词）
  function searchAnime(keyword) {
    return request('/api/v2/search/anime', { keyword: keyword }).then(function (json) {
      return (json.animes || []).map(function (a) {
        return { animeId: a.animeId, animeTitle: a.animeTitle };
      });
    });
  }

  // 搜索剧集（DanDanPlay /api/v2/search/episodes，GET 接口）
  // 响应结构：{ success, animes:[{ animeId, animeTitle, episodes:[{episodeId, episodeTitle}] }] }
  function searchEpisodes(anime, episode) {
    var q = { anime: anime };
    if (episode != null && episode !== '') q.episode = episode;
    console.log('[Danmaku-Client] search/episodes 请求', JSON.stringify(q));
    return request('/api/v2/search/episodes', q).then(function (json) {
      // DanDanPlay /search/episodes 返回 animes 数组，每项含 bangumi 及 episodes
      var animes = json.animes || [];
      // 优先匹配：animeTitle 包含搜索关键词的番剧
      var matched = null;
      for (var i = 0; i < animes.length; i++) {
        var at = animes[i].animeTitle || '';
        if (at.indexOf(anime) > -1 || anime.indexOf(at) > -1) {
          matched = animes[i];
          break;
        }
      }
      // 如果没匹配到，取第一个
      if (!matched && animes.length > 0) matched = animes[0];
      var list = (matched && matched.episodes) || [];
      console.log('[Danmaku-Client] search/episodes 响应 success=' + json.success + ' animes=' + animes.length + ' matchedTitle=' + (matched ? matched.animeTitle : 'N/A') + ' episodes=' + list.length + ' errorMessage=' + (json.errorMessage || 'none'));
      if (list.length > 0) {
        console.log('[Danmaku-Client] 第1集: id=' + list[0].episodeId + ' title=' + list[0].episodeTitle);
      } else if (animes.length > 0) {
        console.log('[Danmaku-Client] anime keys=' + Object.keys(animes[0]).join(',') + ' first anime=' + JSON.stringify(animes[0]).substring(0, 300));
      } else {
        console.log('[Danmaku-Client] 完整响应 keys=' + Object.keys(json).join(',') + ' animes 长度=0');
      }
      return list.map(function (e) {
        return { episodeId: e.episodeId, episodeTitle: e.episodeTitle };
      });
    }).catch(function (e) {
      console.error('[Danmaku-Client] search/episodes 请求失败', e ? e.message : e);
      throw e;
    });
  }

  // 拉取某剧集弹幕，返回 DanmakuEntry[]
  function getComments(episodeId) {
    return request('/api/v2/comment/' + episodeId, { withRelated: 'true', chConvert: '1' }).then(function (json) {
      var Entry = danmaku.DanmakuEntry;
      return (json.comments || []).map(function (c) { return Entry.fromJson(c); });
    });
  }

  // 一站式：番名 + 集数 → 弹幕列表（影视态最常用入口）
  function fetchForEpisode(animeTitle, episode, onProgress) {
    console.log('[Danmaku-Client] fetchForEpisode 调用', { animeTitle: animeTitle, episode: episode });
    return searchEpisodes(animeTitle, episode).then(function (eps) {
      console.log('[Danmaku-Client] searchEpisodes 返回', { count: eps.length, episodes: eps.map(function(e) { return { id: e.episodeId, title: e.episodeTitle }; }) });
      if (!eps.length) throw new Error('DANMAKU_NO_EPISODE');
      if (onProgress) onProgress('找到剧集：' + eps[0].episodeTitle);
      return getComments(eps[0].episodeId);
    }).then(function (comments) {
      console.log('[Danmaku-Client] getComments 返回', { count: comments ? comments.length : 0 });
      return comments;
    }).catch(function (e) {
      console.error('[Danmaku-Client] fetchForEpisode 失败', { error: e, message: e ? e.message : null });
      throw e;
    });
  }

  var client = {
    configure: function (o) {
      if (!o) return;
      if (o.baseUrl) cfg.baseUrl = o.baseUrl;
      if (o.proxyBase != null) cfg.proxyBase = o.proxyBase;
    },
    setCredentials: function (appId, appSecret) {
      cfg.appId = appId || '';
      cfg.appSecret = appSecret || '';
    },
    getCredentials: function () { return { appId: cfg.appId, appSecret: cfg.appSecret }; },
    hasCredentials: function () { return !!(cfg.appId && cfg.appSecret); },
    setSha256Base64: function (fn) { _sha256Base64 = fn; },   // 单测注入
    makeAuthHeaders: makeAuthHeaders,                         // 暴露供测试
    searchAnime: searchAnime,
    searchEpisodes: searchEpisodes,
    getComments: getComments,
    fetchForEpisode: fetchForEpisode,
    DANMAKU_BASE: DEFAULT_BASE
  };

  danmaku.client = client;
})(typeof window !== 'undefined' ? window : this);
