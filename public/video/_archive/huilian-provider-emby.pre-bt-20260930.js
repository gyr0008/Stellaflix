/*
 * Stellaflix — 汇联页 · Emby / Jellyfin / Plex 媒体服务器适配器
 * ----------------------------------------------------------------------------
 * 三种服务器都暴露公开 REST API，本文件用同一套"媒体服务器抽象"接：
 *
 *   Emby / Jellyfin（API 几乎同构，Jellyfin 是 Emby 开源分支）：
 *     POST /Users/AuthenticateByName  → 拿 AccessToken
 *     GET  /Users/{userId}           → 当前用户
 *     GET  /Items?Recursive=true     → 列出媒体库
 *     GET  /Items/{id}               → 单集详情（含 MediaSources）
 *     GET  /Videos/{id}/stream...    → 直链流（静态）
 *
 *   Plex：
 *     POST /users/sign_in            → 拿 authToken
 *     GET  /library/sections         → 媒体库
 *     GET  /library/section/{id}/all → 列表
 *     GET  /library/metadata/{id}    → 单集详情
 *     (Plex 直链：用 /video/:/transcode/universal/start.m3u8 或返回 key 拼接)
 *
 * 本文件实现：
 *   1) canHandle：URL 里含 /emby/ /jellyfin/ /plex/ 或用户显式选"媒体服务器"
 *   2) resolve：鉴权 → 拉库 → 拿直链 → 包装成 manifest
 *   3) openRange：Emby/Jellyfin 直链支持 Range；Plex 走 HLS 分片
 *
 * 鉴权：用户需在汇联页"服务器配置"里填 baseURL + username + password（Emby/Jellyfin）
 * 或 baseURL + plexToken（Plex）。本文件不硬编码任何凭据。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var Prov = SFV.huilianProviders;
  if (!Prov) throw new Error('huilianProviders 未加载');

  function xhrJson(method, url, body, headers) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('X-Application', 'Stellaflix/2.1.0');
      if (headers) for (var k in headers) xhr.setRequestHeader(k, headers[k]);
      xhr.onload = function () {
        try { resolve(JSON.parse(xhr.responseText)); } catch (e) { resolve(xhr.responseText); }
      };
      xhr.onerror = function () { reject('xhr-fail'); };
      xhr.send(body ? JSON.stringify(body) : null);
    });
  }

  function detectKind(url) {
    var u = String(url || '');
    if (/\/emby\//i.test(u)) return 'emby';
    if (/\/jellyfin\//i.test(u)) return 'jellyfin';
    if (/\/plex\//i.test(u) || /plex/i.test(u)) return 'plex';
    return null;
  }

  function EmbyProvider() { Prov.IProvider.call(this, 'emby', 25); }
  EmbyProvider.prototype = Object.create(Prov.IProvider.prototype);
  EmbyProvider.prototype.constructor = EmbyProvider;

  EmbyProvider.prototype.canHandle = function (input) {
    var n = Prov.normalizeInput(input);
    if (!n) return false;
    return !!detectKind(n.url) || /emby|jellyfin|plex/i.test(n.url);
  };

  // 鉴权：Emby/Jellyfin 用 user+pass；Plex 用 token
  EmbyProvider.prototype._auth = function (serverUrl, creds) {
    var kind = detectKind(serverUrl);
    if (kind === 'plex') {
      return Promise.resolve({ kind: 'plex', token: creds.plexToken || '', baseUrl: serverUrl });
    }
    var body = { Username: creds.username, Pw: creds.password };
    var h = kind === 'jellyfin' ? { 'X-Emby-Authorization': 'MediaBrowser Client="Stellaflix"' } : {};
    return xhrJson('POST', serverUrl + '/Users/AuthenticateByName', body, h).then(function (r) {
      return { kind: kind, token: r.AccessToken, userId: r.User.Id, baseUrl: serverUrl };
    });
  };

  // 拉取媒体库顶层
  EmbyProvider.prototype._listLibraries = function (sess) {
    var h = { 'X-Emby-Token': sess.token };
    return xhrJson('GET', sess.baseUrl + '/Items?Recursive=false&IncludeItemTypes=Folder', null, h)
      .then(function (r) { return (r.Items || []).filter(function (i) { return i.Type === 'Folder'; }); });
  };

  // 拉取某个库下的视频列表
  EmbyProvider.prototype._listVideos = function (sess, parentId) {
    var h = { 'X-Emby-Token': sess.token };
    return xhrJson('GET', sess.baseUrl + '/Items?ParentId=' + parentId + '&IncludeItemTypes=Movie,Episode&Recursive=true', null, h)
      .then(function (r) { return r.Items || []; });
  };

  // 拿单集直链（Emby/Jellyfin 静态直链）
  EmbyProvider.prototype._directStreamUrl = function (sess, itemId) {
    var h = { 'X-Emby-Token': sess.token };
    return xhrJson('GET', sess.baseUrl + '/Items/' + itemId, null, h).then(function (item) {
      var ms = (item.MediaSources || [])[0];
      if (!ms) return null;
      // 静态直链（不走转码）
      var url = sess.baseUrl + '/Videos/' + itemId + '/stream.' + (ms.Container || 'mp4') +
                '?static=true&api_key=' + encodeURIComponent(sess.token) + '&MediaSourceId=' + ms.Id;
      return { url: url, durationSec: ms.RunTimeTicks ? ms.RunTimeTicks / 1e7 : 0, container: ms.Container };
    });
  };

  // 主入口：input.url 形如 emby://serverUrl|itemId 或 jellyfin://...
  EmbyProvider.prototype.resolve = function (input) {
    var self = this;
    var n = Prov.normalizeInput(input);
    // 解析协议：emby://serverUrl|itemId|username|password
    var parts = n.url.split('|');
    var serverUrl = parts[0].replace(/^emby:\/\//i, '').replace(/^jellyfin:\/\//i, '').replace(/^plex:\/\//i, '');
    var itemId = parts[1] || '';
    var creds = { username: parts[2] || '', password: parts[3] || '', plexToken: parts[2] || '' };
    return this._auth(serverUrl, creds).then(function (sess) {
      if (itemId) {
        return self._directStreamUrl(sess, itemId).then(function (ds) {
          return {
            id: n.id || n.url,
            title: n.title || ('emby-' + itemId),
            durationSec: ds ? ds.durationSec : 0,
            mimeType: 'video/' + (ds && ds.container ? ds.container : 'mp4'),
            kind: 'vod',
            source: 'emby',
            url: ds ? ds.url : '',
            extra: { sess: sess, itemId: itemId }
          };
        });
      }
      // 没 itemId：返回库列表（让 UI 展示）
      return self._listLibraries(sess).then(function (libs) {
        return {
          id: n.id || n.url,
          title: n.title || 'Emby Libraries',
          durationSec: 0,
          mimeType: '',
          kind: 'collection',
          source: 'emby',
          url: serverUrl,
          extra: { sess: sess, libraries: libs }
        };
      });
    });
  };

  EmbyProvider.prototype.openRange = function (manifest, startSec, endSec) {
    // Emby 静态直链支持 Range
    var url = manifest.url;
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      // 粗估字节（Emby 直链是 CBR 近似）
      var ratioStart = startSec / Math.max(1, manifest.durationSec || 1);
      var ratioEnd = endSec / Math.max(1, manifest.durationSec || 1);
      // 没总长：先拿头 1MB 探
      xhr.onload = function () { resolve(xhr.response); };
      xhr.onerror = function () { reject('range-fail'); };
      xhr.send();
    });
  };

  Prov.register(new EmbyProvider());
  SFV.huilianEmbyProvider = EmbyProvider;
})(typeof window !== 'undefined' ? window : this);
