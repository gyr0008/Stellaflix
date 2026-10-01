/*
 * Stellaflix — 汇联页 · 阿里云盘 来源适配器
 * ----------------------------------------------------------------------------
 * 阿里云盘公开 API（2024 末改版后仍可用）：
 *   POST https://auth.aliyundrive.com/v2/account/token
 *        { grant_type: 'refresh_token', refresh_token: <user_rt> }
 *      → { access_token, refresh_token, expires_in, token_type, user_id }
 *
 *   POST https://api.aliyundrive.com/adrive/v3/file/list
 *        { drive_id, parent_file_id, limit: 100 }
 *        Headers: Authorization: Bearer <access_token>
 *      → { items: [{ file_id, name, size, type: 'file'|'folder', content_type, thumbnail }] }
 *
 *   POST https://api.aliyundrive.com/v2/file/get_download_url
 *        { file_id, drive_id }
 *        Headers: Authorization: Bearer <access_token>
 *      → { url, expiration, size, ratelimit }   ← 这个 url 支持 Range
 *
 * 本文件实现：
 *   1) canHandle：URL 含 aliyundrive.com/s/ 或 aliyun://fileId|driveId|refreshToken
 *   2) resolve：用 refresh_token 换 access_token → 拿下载 URL → 包装 manifest
 *   3) openRange：下载 URL 支持 Range，直接走
 *
 * 合规：refresh_token 由用户自己从浏览器登录态里导出，本文件不内置任何凭据。
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
      if (headers) for (var k in headers) xhr.setRequestHeader(k, headers[k]);
      xhr.onload = function () {
        try { resolve(JSON.parse(xhr.responseText)); } catch (e) { resolve(xhr.responseText); }
      };
      xhr.onerror = function () { reject('xhr-fail'); };
      xhr.send(body ? JSON.stringify(body) : null);
    });
  }

  function AliyunProvider() { Prov.IProvider.call(this, 'aliyun', 15); }
  AliyunProvider.prototype = Object.create(Prov.IProvider.prototype);
  AliyunProvider.prototype.constructor = AliyunProvider;

  AliyunProvider.prototype.canHandle = function (input) {
    var n = Prov.normalizeInput(input);
    if (!n) return false;
    return Prov.isAliyun(n.url) || /^aliyun:\/\//i.test(n.url);
  };

  // 用 refresh_token 换 access_token
  AliyunProvider.prototype._refresh = function (refreshToken) {
    return xhrJson('POST', 'https://auth.aliyundrive.com/v2/account/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });
  };

  // 拿下载 URL
  AliyunProvider.prototype._getDownloadUrl = function (accessToken, fileId, driveId) {
    return xhrJson('POST', 'https://api.aliyundrive.com/v2/file/get_download_url', {
      file_id: fileId,
      drive_id: driveId || 'default'
    }, { Authorization: 'Bearer ' + accessToken });
  };

  // 解析分享链接里的 fileId（简化：用户直接给 aliyun://fileId|driveId|refreshToken）
  AliyunProvider.prototype.resolve = function (input) {
    var self = this;
    var n = Prov.normalizeInput(input);
    var parts = n.url.replace(/^aliyun:\/\//i, '').split('|');
    var fileId = parts[0];
    var driveId = parts[1] || '';
    var refreshToken = parts[2] || '';
    if (!refreshToken) return Promise.reject('需要 refresh_token');
    return this._refresh(refreshToken).then(function (tk) {
      return self._getDownloadUrl(tk.access_token, fileId, driveId).then(function (dl) {
        return {
          id: n.id || n.url,
          title: n.title || ('aliyun-' + fileId),
          durationSec: 0,        // 下载 URL 没时长，由 MP4 探针补
          mimeType: 'video/mp4',
          kind: 'vod',
          source: 'aliyun',
          url: dl.url,
          contentLength: dl.size,
          extra: { dl: dl, tk: tk }
        };
      });
    });
  };

  AliyunProvider.prototype.openRange = function (manifest, startSec, endSec) {
    var url = manifest.url;
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      // 粗估字节
      var ratioStart = startSec / Math.max(1, manifest.durationSec || 1);
      var ratioEnd = endSec / Math.max(1, manifest.durationSec || 1);
      var total = manifest.contentLength || 0;
      if (total) {
        var bs = Math.floor(total * ratioStart);
        var be = Math.floor(total * ratioEnd);
        xhr.setRequestHeader('Range', 'bytes=' + bs + '-' + Math.min(be, total - 1));
      }
      xhr.onload = function () { resolve(xhr.response); };
      xhr.onerror = function () { reject('range-fail'); };
      xhr.send();
    });
  };

  Prov.register(new AliyunProvider());
  SFV.huilianAliyunProvider = AliyunProvider;
})(typeof window !== 'undefined' ? window : this);
