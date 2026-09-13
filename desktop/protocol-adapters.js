'use strict';

/**
 * Stellaflare 影视态 — 主进程协议适配层 (protocol-adapters.js)
 * ----------------------------------------------------------------------------
 * 把各媒体服务器 / 网盘 / WebDAV 的协议归一化成统一的"播放清单"结构，供
 * huilian-page.js 渲染和 mpv-controller 播放。
 *
 * 统一输出结构（对齐 huilian-providers.js 的 manifest 契约）：
 *   {
 *     id: string,
 *     title: string,
 *     durationSec: number,
 *     mimeType: string,
 *     kind: 'vod' | 'live' | 'collection',
 *     source: 'emby' | 'alist' | 'aliyun' | 'webdav',
 *     url: string,                // 最终播放 URL（直链或 m3u8）
 *     extra: any,                 // 适配器私有扩展
 *   }
 *
 * 设计原则：
 *   - 主进程侧跑（Node http/https 模块），渲染进程不直接跨域请求
 *   - 鉴权凭据由渲染进程通过 IPC 传入，不落盘
 *   - 每个适配器独立文件，可插拔
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

let _config = null;
function setConfig(cfg) { _config = cfg; }

// -----------------------------------------------------------------------
//  通用 HTTP 请求
// -----------------------------------------------------------------------
function httpRequest(url, opts) {
  opts = opts || {};
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = Object.assign({ 'User-Agent': _config?.network?.userAgent || 'Stellaflix/0.1.0 Video' }, opts.headers || {});
    const reqOpts = { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: opts.method || 'GET', headers };
    const req = mod.request(reqOpts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpRequest(res.headers.location, opts).then(resolve, reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(_config?.network?.timeout || 30000, () => req.destroy(new Error('http timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function jsonRequest(url, opts) {
  return httpRequest(url, opts).then(r => {
    try { return JSON.parse(r.body); } catch (e) { return r.body; }
  });
}

// -----------------------------------------------------------------------
//  Emby / Jellyfin
// -----------------------------------------------------------------------
const emby = {
  async resolve(url, creds) {
    // url 形如 http://server:8096 或含 itemId
    const u = url.replace(/\/$/, '');
    const itemId = u.split('/').pop();
    const base = u.replace(/\/\w+$/, '');
    const authBody = JSON.stringify({ Username: creds.username, Pw: creds.password });
    const authRes = await httpRequest(base + '/Users/AuthenticateByName', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="Stellaflix"' },
      body: authBody,
    });
    const auth = JSON.parse(authRes.body);
    if (!auth.AccessToken) throw new Error('Emby 鉴权失败');
    const token = auth.AccessToken;
    const userId = auth.User.Id;
    const headers = { 'X-Emby-Token': token };
    const itemRes = await httpRequest(base + '/Items/' + itemId, { headers });
    const item = JSON.parse(itemRes.body);
    const ms = (item.MediaSources || [])[0];
    if (!ms) throw new Error('无媒体源');
    const streamExt = ms.Container || 'mp4';
    const streamUrl = base + '/Videos/' + itemId + '/stream.' + streamExt +
                     '?static=true&api_key=' + encodeURIComponent(token) + '&MediaSourceId=' + ms.Id;
    return {
      id: 'emby-' + itemId,
      title: item.Name || 'emby',
      durationSec: ms.RunTimeTicks ? ms.RunTimeTicks / 1e7 : 0,
      mimeType: 'video/' + streamExt,
      kind: 'vod',
      source: 'emby',
      url: streamUrl,
      extra: { item, ms, token, base },
    };
  },
};

// -----------------------------------------------------------------------
//  Alist
// -----------------------------------------------------------------------
const alist = {
  async resolve(url, token) {
    // url 形如 http://alist.example.com/d/路径/file.mp4
    const u = new URL(url);
    const base = u.origin;
    const filePath = decodeURIComponent(u.pathname.replace(/^\/d/, ''));
    const body = JSON.stringify({ path: filePath, password: '' });
    const res = await jsonRequest(base + '/api/fs/get', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': token || '' },
      body,
    });
    if (res.code !== 200) throw new Error('Alist 解析失败: ' + res.message);
    const data = res.data || {};
    return {
      id: 'alist-' + filePath,
      title: data.name || filePath,
      durationSec: 0,
      mimeType: 'video/' + ((data.name || '').split('.').pop() || 'mp4'),
      kind: 'vod',
      source: 'alist',
      url: (data.raw_url || (base + '/d' + filePath)),
      extra: { data, base, token },
    };
  },
};

// -----------------------------------------------------------------------
//  阿里云盘
// -----------------------------------------------------------------------
const aliyun = {
  async resolve(fileId, driveId, refreshToken) {
    if (!refreshToken) throw new Error('需要 refresh_token');
    const tkRes = await jsonRequest('https://auth.aliyundrive.com/v2/account/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    const accessToken = tkRes.access_token;
    const dlRes = await jsonRequest('https://api.aliyundrive.com/v2/file/get_download_url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
      body: JSON.stringify({ file_id: fileId, drive_id: driveId || 'default' }),
    });
    if (!dlRes.url) throw new Error('获取下载 URL 失败');
    return {
      id: 'aliyun-' + fileId,
      title: 'aliyun-' + fileId,
      durationSec: 0,
      mimeType: 'video/mp4',
      kind: 'vod',
      source: 'aliyun',
      url: dlRes.url,
      contentLength: dlRes.size,
      extra: { dl: dlRes, tk: tkRes },
    };
  },
};

// -----------------------------------------------------------------------
//  WebDAV
// -----------------------------------------------------------------------
const webdav = {
  async resolve(url, creds) {
    // WebDAV 直接返回 URL，由 mpv 原生支持 http Range
    const ext = (url.split('/').pop() || '').split('.').pop() || 'mp4';
    return {
      id: 'webdav-' + url,
      title: decodeURIComponent(url.split('/').pop() || 'webdav'),
      durationSec: 0,
      mimeType: 'video/' + ext,
      kind: 'vod',
      source: 'webdav',
      url,
      extra: { creds },
    };
  },
};

module.exports = { setConfig, emby, alist, aliyun, webdav };
