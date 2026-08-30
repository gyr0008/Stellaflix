/*
 * Stellaflix 影视模块 — 海报本地缓存
 *
 * 用途：当用户把 TMDB 条目加入追片/片单/历史时，把远程海报图（image.tmdb.org）
 *       抓取并持久化到本地。追片页等列表渲染时优先使用本地缓存，避免网络
 *       不可达或图片域名被拦导致海报白图/裂图。
 *
 * 存储策略：
 *   1) 首选 Electron userData 文件（poster-cache.json），容量不受 localStorage 限制，
 *      也不受端口跳变导致 origin 不一致的影响。
 *   2) 降级：若不在桌面壳或 IPC 失败，用 localStorage(stellaflix-video-poster-cache) 兜底。
 *   3) 内存缓存：避免同一次启动反复读盘。
 *
 * 注意：key 使用与 model.js 一致的 vod key（如 tmdb:movie:12345）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var LS_KEY = 'stellaflix-video-poster-cache';
  var memory = {};     // key -> dataUrl（进程内缓存）
  var inflight = {};   // key -> Promise（去重并发下载）

  function canUseBridge() {
    return !!(global.desktopWindow && typeof global.desktopWindow.posterCache === 'function');
  }

  function readLS(key) {
    try {
      var raw = global.localStorage.getItem(LS_KEY);
      var all = raw ? JSON.parse(raw) : {};
      return (all && typeof all[key] === 'string') ? all[key] : null;
    } catch (e) { return null; }
  }

  function writeLS(key, dataUrl) {
    try {
      var raw = global.localStorage.getItem(LS_KEY);
      var all = raw ? JSON.parse(raw) : {};
      all[key] = dataUrl;
      global.localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch (e) { /* localStorage 配额/只读均忽略 */ }
  }

  function removeLS(key) {
    try {
      var raw = global.localStorage.getItem(LS_KEY);
      var all = raw ? JSON.parse(raw) : {};
      if (all[key]) { delete all[key]; global.localStorage.setItem(LS_KEY, JSON.stringify(all)); }
    } catch (e) { /* localStorage 配额/只读均忽略 */ }
  }

  function fetchAsDataURL(url) {
    if (!global.fetch) return Promise.reject(new Error('NO_FETCH'));
    return global.fetch(url, { mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP_' + r.status);
      return r.blob();
    }).then(function (blob) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onloadend = function () { resolve(reader.result); };
        reader.onerror = function () { reject(reader.error || new Error('FILEREADER_ERROR')); };
        reader.readAsDataURL(blob);
      });
    });
  }

  // 从持久层读取（内存 → IPC 文件 → localStorage 兜底）
  function get(key) {
    if (!key) return Promise.resolve(null);
    if (memory[key]) return Promise.resolve(memory[key]);
    if (canUseBridge()) {
      return global.desktopWindow.posterCache('get', key).then(function (res) {
        var url = (res && res.ok && typeof res.data === 'string') ? res.data : null;
        if (url) { memory[key] = url; return url; }
        return readLS(key);
      }).catch(function () { return readLS(key); });
    }
    return Promise.resolve(readLS(key));
  }

  // 下载并缓存远程海报。返回 Promise<dataUrl|null>
  function cache(key, url) {
    if (!key || !url) return Promise.resolve(null);
    if (memory[key]) return Promise.resolve(memory[key]);
    if (inflight[key]) return inflight[key];

    var promise = get(key).then(function (cached) {
      if (cached) { memory[key] = cached; return cached; }
      return fetchAsDataURL(url);
    }).then(function (dataUrl) {
      if (!dataUrl) return null;
      memory[key] = dataUrl;
      if (canUseBridge()) {
        global.desktopWindow.posterCache('set', { key: key, dataUrl: dataUrl }).catch(function () {
          writeLS(key, dataUrl);
        });
      } else {
        writeLS(key, dataUrl);
      }
      return dataUrl;
    }).catch(function (e) {
      console.warn('[SFV poster-cache] cache failed:', key, url, e && e.message);
      return null;
    }).finally(function () {
      delete inflight[key];
    });

    inflight[key] = promise;
    return promise;
  }

  // 同步返回最佳可用 URL：内存命中则返回本地 data URL，否则返回原 URL 并后台触发缓存。
  function resolvePic(key, url) {
    if (!key) return url || '';
    if (memory[key]) return memory[key];
    if (url && !inflight[key]) cache(key, url);
    return url || '';
  }

  // 删除指定 key 的本地缓存：内存 → IPC 文件桥 → localStorage 兜底，三层一起清。
  function remove(key) {
    if (!key) return;
    delete memory[key];
    delete inflight[key];
    if (canUseBridge()) {
      global.desktopWindow.posterCache('remove', key).catch(function () { removeLS(key); });
    } else {
      removeLS(key);
    }
  }

  SFV.posterCache = {
    get: get,
    cache: cache,
    resolvePic: resolvePic,
    remove: remove,
  };
})(typeof window !== 'undefined' ? window : this);
