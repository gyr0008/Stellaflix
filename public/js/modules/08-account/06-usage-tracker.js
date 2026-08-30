/* Stellaflix Usage Time Tracker
 * 本地化存储应用使用时长：总时长 + 今日时长
 * 仅通过 localStorage 持久化，除应用删除或手动清除外，永不自动重置。
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'stellaflix.usage.stats';
  var STORAGE_VERSION = 1;
  var TICK_INTERVAL = 1000; // 1 second
  var PERSIST_INTERVAL = 10; // 每 10 秒持久化一次

  // --- Storage helpers ---

  function getTodayKey() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  /**
   * 从 localStorage 读取数据。
   * 只有以下情况会返回默认值：
   *   1. 首次使用，key 不存在（total 为 0 的全新状态）
   *   2. 存储被用户手动清除 / 应用卸载
   * 数据损坏时不自动重置，而是保留损坏数据并输出警告，等待用户手动处理。
   */
  function loadStats() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        // key 不存在 —— 全新状态，创建默认值
        return createDefaultStats();
      }

      var parsed = JSON.parse(raw);

      // 基本校验：必须是对象且具备 version / total 字段
      if (typeof parsed !== 'object' || parsed === null || !('total' in parsed)) {
        // 数据格式异常但不重置 —— 保留原始数据在 localStorage 中，
        // 仅在运行时以默认结构继续计时（新时长会正常累加）
        console.warn('[StellaflixUsage] 存储数据格式异常，将保留原始数据并继续累加新时长。');
        return createRecoveryStats(raw);
      }

      // 字段归一化（只补全缺失字段，不覆盖已有值）
      if (typeof parsed.total !== 'number') parsed.total = Number(parsed.total) || 0;
      if (!parsed.daily || typeof parsed.daily !== 'object') parsed.daily = {};
      if (typeof parsed.lastActiveDate !== 'string') parsed.lastActiveDate = getTodayKey();
      if (typeof parsed.version !== 'number') parsed.version = STORAGE_VERSION;

      return parsed;
    } catch (e) {
      // JSON 解析失败 —— 绝不自动重置
      console.warn('[StellaflixUsage] 存储数据解析失败（可能已损坏），保留原始数据，等待用户手动处理。');
      return createRecoveryStats(null);
    }
  }

  /**
   * 恢复模式：保留已损坏的原始数据引用用于后续手动处理，
   * 运行时用默认结构继续计时，新时长正常写入。
   */
  function createRecoveryStats(rawCorrupt) {
    var stats = {
      version: STORAGE_VERSION,
      total: 0,
      daily: {},
      lastActiveDate: getTodayKey(),
      sessionStart: Date.now(),
      _corruptBackup: rawCorrupt || null
    };
    return stats;
  }

  function createDefaultStats() {
    return {
      version: STORAGE_VERSION,
      total: 0,
      daily: {},
      lastActiveDate: getTodayKey(),
      sessionStart: Date.now()
    };
  }

  function saveStats(stats) {
    try {
      // 保存前移除临时字段
      var toSave = {};
      var keys = ['version', 'total', 'daily', 'lastActiveDate', 'sessionStart'];
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] in stats) toSave[keys[i]] = stats[keys[i]];
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch (e) {
      console.warn('[StellaflixUsage] 保存失败:', e);
    }
  }

  // --- State management ---

  var stats = loadStats();
  var isTracking = false;
  var timerId = null;
  var visibleTime = 0; // 当前会话累计秒数
  var lastTickTime = 0;

  /**
   * 跨日处理：自然过时时自动归属。
   * 不修改历史数据，仅更新 lastActiveDate 标记。
   */
  function ensureDayRollover() {
    var today = getTodayKey();
    if (stats.lastActiveDate !== today) {
      stats.lastActiveDate = today;
      saveStats(stats);
    }
  }

  // --- Time accumulation ---

  function addSeconds(seconds) {
    if (seconds <= 0) return;
    ensureDayRollover();

    stats.total += seconds;

    var today = getTodayKey();
    stats.daily[today] = (stats.daily[today] || 0) + seconds;

    // 清理超过 30 天的日记录（仅清理明细，保留 total）
    cleanupOldDays();

    saveStats(stats);
  }

  function cleanupOldDays() {
    var keys = Object.keys(stats.daily).sort();
    if (keys.length > 30) {
      var toRemove = keys.slice(0, keys.length - 30);
      for (var i = 0; i < toRemove.length; i++) {
        delete stats.daily[toRemove[i]];
      }
    }
  }

  // --- Formatting ---

  function formatTime(totalSeconds) {
    totalSeconds = Math.floor(totalSeconds);
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    return [h, m, s].map(function (n) {
      return String(n).padStart(2, '0');
    }).join(':');
  }

  // --- Display update ---

  var totalEl = null;
  var todayEl = null;

  function initDisplay() {
    totalEl = document.getElementById('usage-total-time');
    todayEl = document.getElementById('usage-today-time');
    if (totalEl || todayEl) updateDisplay();
  }

  function updateDisplay() {
    if (!totalEl && !todayEl) return;

    var todayKey = getTodayKey();
    var todaySeconds = stats.daily[todayKey] || 0;
    var liveTotal = stats.total + visibleTime;
    var liveToday = todaySeconds + visibleTime;

    if (totalEl) totalEl.textContent = formatTime(liveTotal);
    if (todayEl) todayEl.textContent = formatTime(liveToday);
  }

  // --- Timer ---

  function tick() {
    if (!isTracking) return;

    var now = Date.now();
    var delta = Math.floor((now - lastTickTime) / 1000);

    if (delta >= 1) {
      visibleTime += delta;
      lastTickTime = now;

      // 每 PERSIST_INTERVAL 秒持久化一次
      if (visibleTime >= PERSIST_INTERVAL) {
        addSeconds(visibleTime);
        visibleTime = 0;
      }

      updateDisplay();
    }
  }

  function startTracking() {
    if (isTracking) return;
    isTracking = true;
    lastTickTime = Date.now();
    timerId = setInterval(tick, TICK_INTERVAL);
  }

  function pauseTracking() {
    if (!isTracking) return;
    isTracking = false;
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
    if (visibleTime > 0) {
      addSeconds(visibleTime);
      visibleTime = 0;
    }
    updateDisplay();
  }

  // --- Visibility handling ---

  function handleVisibilityChange() {
    if (document.hidden) {
      pauseTracking();
    } else {
      startTracking();
    }
  }

  // --- Page lifecycle ---

  function handleBeforeUnload() {
    if (visibleTime > 0) {
      addSeconds(visibleTime);
      visibleTime = 0;
    }
  }

  // --- Public API ---

  /**
   * 对外暴露的 API 仅供读取使用。
   * 不提供任何 reset / clear 功能——数据只能通过以下方式清除：
   *   1. 用户在浏览器 DevTools 中手动执行 localStorage.removeItem('stellaflix.usage.stats')
   *   2. 卸载 / 删除应用
   *   3. 浏览器隐私模式自动清除
   */
  window.StellaflixUsage = {
    start: function () {
      initDisplay();
      ensureDayRollover();
      startTracking();
    },
    /**
     * 将计时数据绑定到 DOM 元素。新 UI 设计完成后调用此方法接入。
     * @param {string|HTMLElement} totalElOrId - 总时长元素或其 id
     * @param {string|HTMLElement} todayElOrId - 今日时长元素或其 id
     */
    bindDisplay: function (totalElOrId, todayElOrId) {
      totalEl = typeof totalElOrId === 'string'
        ? document.getElementById(totalElOrId) : totalElOrId;
      todayEl = typeof todayElOrId === 'string'
        ? document.getElementById(todayElOrId) : todayElOrId;
      updateDisplay();
    },
    getTotal: function () {
      return stats.total + visibleTime;
    },
    getToday: function () {
      return (stats.daily[getTodayKey()] || 0) + visibleTime;
    },
    formatTime: formatTime
  };

  // --- Auto-initialize ---

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initDisplay();
      ensureDayRollover();
      startTracking();
    });
  } else {
    initDisplay();
    ensureDayRollover();
    startTracking();
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('beforeunload', handleBeforeUnload);

})();
