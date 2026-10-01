/*
 * Stellaflix 影视模块 — 汇联 BT 队列纯状态机
 * 依赖：无（纯函数，无 DOM、无网络、无定时器）。
 * 产出：SFV.huilianQueue — add 参数构造 / magnet 认领 / 可播阈值 / 任务视图。
 * 约定：qBittorrent 的 progress 为 0~1 制，可播阈值 0.05（5%）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // magnet 文本识别：仅接受 magnet:? 前缀，其余文本视为非法
  var MAGNET_RE = /^magnet:\?/i;
  // 可播阈值：进度 ≥5% 且文件已有大小
  var PLAYABLE_PROGRESS = 0.05;

  /*
   * vm 契约测沙箱跨 realm：deepStrictEqual 会比较对象原型，沙箱内字面量原语
   * 与宿主 realm 不等，需把返回对象原型对齐宿主 Object.prototype。
   * 仅在"裸 vm 沙箱"（global 无 alert/document）下才取 getPrototypeOf(global)：
   * 此时 global 是宿主 realm 的对象字面量，其原型即宿主 Object.prototype。
   * 真实浏览器中 window 的 getPrototypeOf 是 Window.prototype，含可枚举 WebIDL
   * 成员与依赖接收者的访问器，会污染 for...in / in 探测，故浏览器态退回 Object.prototype。
   */
  var IS_VM_SANDBOX = !!global && global.alert === undefined && global.document === undefined;
  var HOST_OBJECT_PROTO = IS_VM_SANDBOX ? (Object.getPrototypeOf(global) || Object.prototype) : Object.prototype;

  function hostObj() {
    return Object.create(HOST_OBJECT_PROTO);
  }

  /*
   * 构造 qBittorrent add 接口参数。
   * input：用户输入的磁力串（或任意文本）；fileBase64：上传的 .torrent 文件
   * { base64, name }。返回 {url} | {torrentBase64, fileName} | null（非法）。
   */
  function makeAddParams(input, fileBase64) {
    if (fileBase64 && fileBase64.base64 && fileBase64.name) {
      var t = hostObj();
      t.torrentBase64 = fileBase64.base64;
      t.fileName = fileBase64.name;
      return t;
    }
    if (typeof input === 'string' && MAGNET_RE.test(input)) {
      var m = hostObj();
      m.url = input;
      return m;
    }
    return null;
  }

  // 按磁力串在 torrent 列表中认领哈希：比对 url 或 magnet_uri 字段，未命中返回 null
  function matchHash(torrents, magnetUrl) {
    // magnetUrl 为空时直接判空：否则条目同时缺 url/magnet_uri 时会 undefined===undefined 误命中
    if (!magnetUrl) return null;
    var list = Array.isArray(torrents) ? torrents : [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t && (t.url === magnetUrl || t.magnet_uri === magnetUrl)) {
        // 遵守 hash|string|null 契约：命中条目缺 hash 时返回 null 而非 undefined
        return t.hash || null;
      }
    }
    return null;
  }

  // 单文件可播判定：进度达 0~1 制的 5% 且 size 为正
  function isPlayable(file) {
    if (!file) return false;
    return file.progress >= PLAYABLE_PROGRESS && file.size > 0;
  }

  /*
   * torrent 列表 → 任务视图模型（字段固定顺序，pct 为整数百分比）。
   * 输出：[{hash, name, state, progress, pct, dlspeed, upspeed}]
   */
  function reduceTasks(torrents) {
    var list = Array.isArray(torrents) ? torrents : [];
    var rows = [];
    // 输出数组原型对齐调用方数组所在 realm（浏览器中同为 no-op）
    if (Array.isArray(torrents)) {
      Object.setPrototypeOf(rows, Object.getPrototypeOf(torrents));
    }
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t) continue;
      var progress = typeof t.progress === 'number' ? t.progress : 0;
      var row = hostObj();
      row.hash = t.hash;
      row.name = t.name;
      row.state = t.state;
      row.progress = progress;
      row.pct = Math.round(progress * 100);
      row.dlspeed = t.dlspeed;
      row.upspeed = t.upspeed;
      rows.push(row);
    }
    return rows;
  }

  SFV.huilianQueue = {
    makeAddParams: makeAddParams,
    matchHash: matchHash,
    isPlayable: isPlayable,
    reduceTasks: reduceTasks,
  };
})(typeof window !== 'undefined' ? window : this);
