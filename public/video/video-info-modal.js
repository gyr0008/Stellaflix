/*
 * Stellaflix 影视模块 — 影视态「视频详情」信息面板 (改造 #11)
 *
 * 复用音乐态已有的 #track-detail-modal / #track-detail-heading / #track-detail-body
 * 骨架与 .detail-grid / .detail-k / .detail-v / .detail-section 样式，在影视态下把
 * ⓘ 信息按钮（#track-detail-btn）打开的「歌曲详情 / 评论」替换为结构化视频技术信息。
 *
 * 展示字段（基于实测可获取性，见模块内 collectInfo）：
 *   - 基础：片源地址、当前分辨率、时长、当前进度、播放速率、音量/静音、播放状态
 *   - 画质与编码：HLS 多档位（高度/编码/码率）+ 当前档；原生直读降级为「未知」
 *   - 解码与缓冲：就绪/网络状态、已缓冲至、解码帧数、掉帧数（Chromium 限）
 * 文件大小（HLS 流不暴露）按用户决策直接省略。
 *
 * 契约：须在 player.js（SFV.player.getVideoEl/getCurrentMeta）与
 * source-adapter-hls.js（SFV.sourceAdapterHls.getActiveHls）之后加载。
 * 分发函数 sfvOpenTrackDetailOrVideoInfo 供 index.html 的 ⓘ 按钮 onclick 调用。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.videoInfo) return; // 幂等守卫

  // 影视态视频层 #sfv-overlay 由 player.js 直接挂到 body（根层叠上下文），
  // 而 #track-detail-modal 位于 #desktop-window-shell 内（该 shell 因 transform/clip-path
  // 形成独立层叠上下文）。若仅抬高 modal 的 z-index，它仍被 shell 上下文困住，
  // 永远无法压过根上下文的 #sfv-overlay(2147483000)——这正是「视频详情弹窗不浮在视频上」的根因。
  // 故影视态打开时把 modal 临时提到 body（与 overlay 同处根上下文），音乐态还原回 shell。
  var docRef = global.document;
  var modalOrigParent = null, modalOrigNext = null;
  function getModalEl() { return docRef && docRef.getElementById ? docRef.getElementById('track-detail-modal') : null; }
  function reparentModalToBody() {
    var modal = getModalEl(); if (!modal || !docRef || !docRef.body) return;
    if (modal.parentNode === docRef.body) return;
    modalOrigParent = modal.parentNode;
    modalOrigNext = modal.nextSibling;
    docRef.body.appendChild(modal);
  }
  function restoreModalToShell() {
    var modal = getModalEl(); if (!modal || !modalOrigParent) return;
    try {
      if (modalOrigNext && modalOrigNext.parentNode === modalOrigParent) modalOrigParent.insertBefore(modal, modalOrigNext);
      else modalOrigParent.appendChild(modal);
    } catch (e) {}
    modalOrigParent = null; modalOrigNext = null;
  }

  var READY_MAP = {
    0: 'HAVE_NOTHING（无数据）',
    1: 'HAVE_METADATA（仅元数据）',
    2: 'HAVE_CURRENT_DATA（当前帧）',
    3: 'HAVE_FUTURE_DATA（可播放）',
    4: 'HAVE_ENOUGH_DATA（缓冲充足）'
  };
  var NET_MAP = {
    0: 'NETWORK_EMPTY（空）',
    1: 'NETWORK_IDLE（空闲）',
    2: 'NETWORK_LOADING（加载中）',
    3: 'NETWORK_NO_SOURCE（无源）'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function row(k, v) {
    var val = (v == null || v === '') ? '未知' : v;
    return '<div class="detail-k">' + esc(k) + '</div>' +
           '<div class="detail-v">' + esc(val) + '</div>';
  }
  function fmtTime(sec) {
    sec = Math.floor(sec || 0);
    if (!isFinite(sec) || sec < 0) return '未知';
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var ss = (s < 10 ? '0' : '') + s;
    var mm = (m < 10 ? '0' : '') + m;
    return h > 0 ? (h + ':' + mm + ':' + ss) : (m + ':' + ss);
  }
  function truncateUrl(u, max) {
    u = u || '';
    max = max || 72;
    if (u.length <= max) return u;
    return u.slice(0, max - 1) + '…';
  }

  function collectInfo() {
    var info = { title: '当前视频', source: '未知' };
    var v = (SFV.player && SFV.player.getVideoEl) ? SFV.player.getVideoEl() : null;
    var meta = (SFV.player && SFV.player.getCurrentMeta) ? SFV.player.getCurrentMeta() : null;

    info.title = (meta && (meta.title || meta.name)) ||
                 (SFV.player && SFV.player.currentId && SFV.player.currentId()) || '当前视频';
    info.source = (v && v.currentSrc) ||
                  (meta && (meta.src || meta.url)) ||
                  (SFV.player && SFV.player.currentId && SFV.player.currentId()) || '未知';

    if (v) {
      info.width = v.videoWidth || 0;
      info.height = v.videoHeight || 0;
      info.duration = v.duration || 0;
      info.currentTime = v.currentTime || 0;
      info.rate = v.playbackRate || 1;
      info.volume = (v.volume == null ? 1 : v.volume);
      info.muted = !!v.muted;
      info.readyState = v.readyState || 0;
      info.networkState = v.networkState || 0;
      info.paused = !!v.paused;
      try {
        if (v.getVideoPlaybackQuality) {
          var q = v.getVideoPlaybackQuality();
          info.totalFrames = q.totalVideoFrames;
          info.droppedFrames = q.droppedVideoFrames;
        } else if ('webkitDecodedFrameCount' in v) {
          info.totalFrames = v.webkitDecodedFrameCount;
          info.droppedFrames = v.webkitDroppedFrameCount || 0;
        }
      } catch (e) {}
      try {
        if (v.buffered && v.buffered.length) {
          var last = v.buffered.length - 1;
          info.bufferedEnd = v.buffered.end(last);
        }
      } catch (e) {}
    }

    // HLS 画质/编码/档位（需 source-adapter-hls.js 已加载并存活实例）
    var hls = (SFV.sourceAdapterHls && SFV.sourceAdapterHls.getActiveHls)
      ? SFV.sourceAdapterHls.getActiveHls() : null;
    if (hls && hls.levels && hls.levels.length) {
      info.hls = true;
      info.levels = hls.levels.map(function (lv) {
        return {
          height: lv.height || 0,
          width: lv.width || 0,
          bitrate: lv.bitrate || 0,
          codec: (lv.videoCodec || (lv.attrs && lv.attrs.CODECS) || '').toLowerCase()
        };
      });
      var ci = (typeof hls.currentLevel === 'number' && hls.currentLevel >= 0)
        ? hls.currentLevel : (hls.loadLevel || 0);
      info.currentLevelIndex = ci;
      var cl = info.levels[ci];
      if (cl) {
        info.currentHeight = cl.height || info.height;
        info.currentCodec = cl.codec || '';
        info.currentBitrate = cl.bitrate || 0;
      }
    }
    return info;
  }

  function buildBody(info) {
    var html = '';

    html += '<div class="detail-hero">';
    html += '<div class="detail-title" style="white-space:normal;line-height:1.35">' + esc(info.title) + '</div>';
    html += '</div>';

    // 基础信息
    html += '<div class="detail-section"><div class="detail-section-head">' +
            '<div class="detail-section-title">基础信息</div></div>';
    html += '<div class="detail-grid">';
    html += row('片源地址', info.source.indexOf('blob:') === 0 ? 'blob:（内存流）' : truncateUrl(info.source, 72));
    html += row('当前分辨率', (info.width && info.height) ? (info.width + ' × ' + info.height) : '未知');
    html += row('时长', fmtTime(info.duration));
    html += row('当前进度', fmtTime(info.currentTime));
    html += row('播放速率', (info.rate || 1) + 'x');
    html += row('音量', info.muted ? '静音' : Math.round((info.volume || 0) * 100) + '%');
    html += row('播放状态', info.paused ? '已暂停' : '播放中');
    html += '</div></div>';

    // 画质与编码
    if (info.hls) {
      html += '<div class="detail-section"><div class="detail-section-head">' +
              '<div class="detail-section-title">画质与编码（HLS）</div></div>';
      html += '<div class="detail-grid">';
      html += row('当前清晰度', info.currentHeight ? (info.currentHeight + 'p') : '未知');
      html += row('视频编码', info.currentCodec || '未知');
      if (info.currentBitrate) html += row('当前码率', Math.round(info.currentBitrate / 1000) + ' kbps');
      html += '</div>';
      if (info.levels && info.levels.length) {
        var lvHtml = '';
        info.levels.forEach(function (lv, i) {
          var mark = (i === info.currentLevelIndex) ? ' ◀当前' : '';
          lvHtml += '<div class="sfv-level-row">' +
            '<span class="sfv-level-h">' + (lv.height ? lv.height + 'p' : '?') + '</span>' +
            '<span class="sfv-level-c">' + (lv.codec ? esc(lv.codec) : '未知编码') + '</span>' +
            '<span class="sfv-level-b">' + (lv.bitrate ? (Math.round(lv.bitrate / 1000) + 'k') : '') + '</span>' +
            '<span class="sfv-level-mark">' + mark + '</span>' +
            '</div>';
        });
        html += '<div class="sfv-level-list">' + lvHtml + '</div>';
      }
      html += '</div>';
    } else {
      html += '<div class="detail-section"><div class="detail-section-head">' +
              '<div class="detail-section-title">画质与编码</div></div>';
      html += '<div class="detail-grid">';
      html += row('当前分辨率', (info.width && info.height) ? (info.width + ' × ' + info.height) : '未知');
      html += row('视频编码', '未知（原生直读 / 源未暴露）');
      html += '</div></div>';
    }

    // 解码与缓冲
    html += '<div class="detail-section"><div class="detail-section-head">' +
            '<div class="detail-section-title">解码与缓冲</div></div>';
    html += '<div class="detail-grid">';
    html += row('就绪状态', READY_MAP[info.readyState] || ('状态' + info.readyState));
    html += row('网络状态', NET_MAP[info.networkState] || ('状态' + info.networkState));
    if (typeof info.bufferedEnd === 'number') html += row('已缓冲至', fmtTime(info.bufferedEnd));
    if (typeof info.totalFrames === 'number') html += row('解码帧数', info.totalFrames);
    if (typeof info.droppedFrames === 'number') html += row('掉帧数', info.droppedFrames);
    html += '</div></div>';

    return html;
  }

  function open() {
    var modal = document.getElementById('track-detail-modal');
    var headingEl = document.getElementById('track-detail-heading');
    var bodyEl = document.getElementById('track-detail-body');
    if (!modal || !headingEl || !bodyEl) return;
    // 影视态把 modal 提到 body（根层叠上下文），使其能压过 #sfv-overlay；
    // 音乐态还原回 #desktop-window-shell，保持原 DOM 契约与 glass 层叠。
    var body = document.body;
    var inVideoSpace = body && (body.classList.contains('video-space-active') || body.classList.contains('video-player-active'));
    if (inVideoSpace) reparentModalToBody(); else restoreModalToShell();
    var info = collectInfo();
    headingEl.textContent = '视频详情';
    bodyEl.innerHTML = buildBody(info);
    if (typeof global.openGsapModal === 'function') global.openGsapModal(modal);
    else modal.classList.add('show');
  }

  SFV.videoInfo = { open: open, collectInfo: collectInfo };

  // index.html ⓘ 按钮 onclick 分发：影视态 → 视频详情；音乐态 → 原歌曲详情
  // 影视态播放器 overlay 使用 body.video-player-active，浏览态使用 body.video-space-active，
  // 故二者任一命中均应打开视频详情面板。
  global.sfvOpenTrackDetailOrVideoInfo = function (mode) {
    var body = document.body;
    var inVideoSpace = body && (body.classList.contains('video-space-active') || body.classList.contains('video-player-active'));
    if (inVideoSpace) {
      open();
    } else if (typeof global.openTrackDetailModal === 'function') {
      restoreModalToShell();
      global.openTrackDetailModal(mode || 'song');
    }
  };
})(typeof window !== 'undefined' ? window : this);
