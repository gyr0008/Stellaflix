/*
 * Stellaflix 影视模块 — 用户数据 vault（镜像 + 空桶恢复）
 *
 * localStorage 按 origin 隔离，端口跳变(3000→3001)会让全部影视用户数据"消失"。
 * 本模块把 KEYS 快照镜像到 userData/video-vault.json（经 desktopWindow.videoVault 桥），
 * 启动时仅当本地键完全不存在才从 vault 回填（主动清空不复活）。
 * 无桌面桥（浏览器直开）时整体 no-op，行为与引入前一致。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var KEYS = [
    'stellaflix-video-progress',
    'stellaflix-video-library',
    'stellaflix-video-history',
    'stellaflix-video-flag',
    'stellaflix-video-meta',
    'stellaflix-video-track',
    'stellaflix-video-failure-log',
    'stellaflix-watch-history-v2',
    'stellaflix:library:lastPoster'
  ];
  var DEBOUNCE_MS = 1000;
  var READY_TIMEOUT_MS = 1500;

  function bridge() {
    return (global.desktopWindow && typeof global.desktopWindow.videoVault === 'function')
      ? global.desktopWindow.videoVault : null;
  }

  function snapshot() {
    var out = {};
    for (var i = 0; i < KEYS.length; i++) {
      var raw = null;
      try { raw = global.localStorage.getItem(KEYS[i]); } catch (e) { raw = null; }
      if (raw != null) out[KEYS[i]] = raw;
    }
    return out;
  }

  var timer = null;

  function flush() {
    var call = bridge();
    if (!call) return Promise.resolve(false);
    return call('set', snapshot())
      .then(function (r) { return !!(r && r.ok); })
      .catch(function (e) {
        if (global.console) global.console.warn('[SFV.vault] flush failed:', e && e.message);
        return false;
      });
  }

  function mirror() {
    if (!bridge()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; flush(); }, DEBOUNCE_MS);
  }

  function init() {
    var call = bridge();
    if (!call) return Promise.resolve(false);
    var work = call('get', null).then(function (res) {
      var vault = (res && res.ok && res.data && typeof res.data === 'object' && !Array.isArray(res.data)) ? res.data : null;
      var restored = false;
      if (vault) {
        for (var i = 0; i < KEYS.length; i++) {
          var k = KEYS[i];
          var local = null;
          try { local = global.localStorage.getItem(k); } catch (e) { local = null; }
          if (local == null && typeof vault[k] === 'string') {
            try { global.localStorage.setItem(k, vault[k]); restored = true; } catch (e) { /* 配额等失败保持本地现状 */ }
          }
        }
      }
      if (restored && global.dispatchEvent) {
        try { global.dispatchEvent(new global.Event('sfv:vault-restored')); } catch (e) { /* ignore */ }
      }
      // 无条件镜像一次：首次建档与换桶收敛共用此步
      return flush().then(function () { return restored; });
    }).catch(function () { return false; });
    return new Promise(function (resolve) {
      var settled = false;
      var t = setTimeout(function () { if (!settled) { settled = true; resolve(false); } }, READY_TIMEOUT_MS);
      work.then(function (v) { if (!settled) { settled = true; clearTimeout(t); resolve(v); } });
    });
  }

  if (global.addEventListener) {
    global.addEventListener('pagehide', function () {
      if (timer) { clearTimeout(timer); timer = null; }
      flush();
    });
  }

  SFV.vault = { KEYS: KEYS, ready: init(), mirror: mirror, flush: flush };
})(typeof window !== 'undefined' ? window : globalThis);
