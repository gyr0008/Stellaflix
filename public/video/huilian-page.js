/*
 * Stellaflix 影视模块 — 汇联页 (huilian-page.js)
 * ----------------------------------------------------------------------------
 * 汇联 = 影视态里「边下边播 + 边播边删 + 随意跳转」的入口页。
 *
 * 产品定位：无论影片在哪里（HLS / WebDAV / Emby / Jellyfin / Plex / 阿里云盘 / 115 /
 * 磁力 / 直链），统一接到汇联页 -> 点一下 -> 立刻起播。
 *
 * 核心组合：
 *   - 来源适配层：huilian-providers.js + huilian-provider-*.js
 *              （把任意来源归一成 IProvider 契约）
 *   - MSE 流式缓冲管理器：huilian-stream.js
 *              （MediaSource + SourceBuffer + 滚动尾巴 GC = 边播边删）
 *   - UI：本文件（片单 + 粘贴板 + 热力图 + 决策树提示）
 *
 * 边播边删的实现（对齐 PDF 第四章滑动窗口 + 第七章 ByteTimeMap + 看完即删）：
 *   - 播放头超前尾巴：huilian-stream._gcTick() 每个 GC_INTERVAL_MS 主动调用
 *     SourceBuffer.remove(0, cutoff)，cutoff = currentTime - BACK_SECONDS
 *   - 磁盘：浏览器 MSE 落盘临时文件由浏览器 GC 异步释放；
 *     播放结束 / 页面 unmount 时调 stream.reset() 彻底销毁 MediaSource
 *     对齐 PDF 的 destroyStore 语义
 *   - 内存：已播段从 SourceBuffer remove 后浏览器在下一次 GC 回收 ArrayBuffer
 *
 * 加载顺序（index.html）：
 *   huilian-providers.js -> huilian-stream.js -> huilian-provider-*.js -> huilian-page.js
 *
 * 注册：通过 SFV.router.register({ id:'discover', ... }) 替换占位页 page-discover.js
 *   （默认保留本文件；若仍要占位页，从 index.html 里去掉 huilian-page.js 那行即可）
 *
 * 单文件 ≤ 500 行。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var Prov = SFV.huilianProviders;
  var Stream = SFV.huilianStream;

  if (!Prov) throw new Error('huilianProviders 未加载');
  if (!Stream) throw new Error('huilianStream 未加载');

  // 窗口参数（对齐 PDF 4.2 PRELOAD + 7.x 热力图）
  var CFG = {
    HEATMAP_SLOTS: 200,
    HOT_THRESHOLD: 60,      // 缓冲余量 >60s → 充裕
    OK_THRESHOLD: 15,       // >15s → 缓冲充足
    WARM_THRESHOLD: 5,      // >5s → 缓冲中
  };
  var COLOR_EMPTY = 'rgba(255,255,255,0.08)';
  var COLOR_PARTIAL = 'rgba(80,200,120,0.45)';
  var COLOR_FULL = 'rgba(40,170,90,0.85)';
  var COLOR_RECLAIMED = 'rgba(255,255,255,0.04)';
  var COLOR_PLAYHEAD = '#ffffff';

  // -------- 模块级状态 --------
  var hostEl = null;
  var stream = null;
  var curManifest = null;
  var curVideoEl = null;
  var heatmapCanvas = null, heatmapCtx = null;
  var inputEl = null, playBtn = null, clearBtn = null, statusEl = null;
  var providerBadgeEl = null;
  var bitrateEl = null, bufferEl = null;
  var redrawTimer = null;

  // =====================================================================
  //  页面 DOM
  // =====================================================================
  function mount(host, ctx) {
    hostEl = host;
    host.innerHTML = '';
    var wrap = c('div', 'huilian-wrap');

    // 1. 标题 + 来源徽标
    var header = c('div', 'huilian-header');
    var title = c('div', 'huilian-title', '汇联');
    providerBadgeEl = c('div', 'huilian-provider-badge', '未选择来源');
    header.appendChild(title); header.appendChild(providerBadgeEl);
    wrap.appendChild(header);

    // 2. 输入行（粘贴板：URL / 磁力 / 服务器协议）
    var inputRow = c('div', 'huilian-input-row');
    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'huilian-input';
    inputEl.placeholder = '粘贴 m3u8 / mp4 直链 / 磁力 / aliyun:// / emby:// / webdav URL';
    inputEl.setAttribute('aria-label', '播放地址');
    inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') playFromInput(); });
    inputRow.appendChild(inputEl);

    playBtn = document.createElement('button');
    playBtn.type = 'button'; playBtn.className = 'huilian-btn huilian-btn-play';
    playBtn.textContent = '▶ 播放';
    playBtn.addEventListener('click', playFromInput);
    inputRow.appendChild(playBtn);

    clearBtn = document.createElement('button');
    clearBtn.type = 'button'; clearBtn.className = 'huilian-btn huilian-btn-clear';
    clearBtn.textContent = '✕ 清空';
    clearBtn.addEventListener('click', clearPlayback);
    inputRow.appendChild(clearBtn);
    wrap.appendChild(inputRow);

    // 3. 视频承载（单独一个 section，便于全屏）
    var stage = c('div', 'huilian-stage');
    curVideoEl = document.createElement('video');
    curVideoEl.className = 'huilian-video';
    curVideoEl.playsInline = true;
    curVideoEl.controls = false;
    curVideoEl.addEventListener('timeupdate', scheduleHeatmapRedraw);
    curVideoEl.addEventListener('seeked', onSeek);
    curVideoEl.addEventListener('play', onPlayState);
    curVideoEl.addEventListener('pause', onPlayState);
    curVideoEl.addEventListener('ended', onEnded);
    stage.appendChild(curVideoEl);
    wrap.appendChild(stage);

    // 4. 进度条（自定义，覆盖在视频下方；热力图在进度条下方）
    var progressRow = c('div', 'huilian-progress-row');
    var seekbar = c('div', 'huilian-seekbar');
    seekbar.addEventListener('click', onSeekbarClick);
    seekbar.addEventListener('mousemove', onSeekbarHover);
    progressRow.appendChild(seekbar);
    wrap.appendChild(progressRow);

    // 5. 热力图
    var heatmapWrap = c('div', 'huilian-heatmap-wrap');
    heatmapCanvas = document.createElement('canvas');
    heatmapCanvas.className = 'huilian-heatmap';
    heatmapCanvas.width = 800; heatmapCanvas.height = 28;
    heatmapWrap.appendChild(heatmapCanvas);
    wrap.appendChild(heatmapWrap);

    // 6. 状态行（缓冲余量 + 码率 + 决策树提示，对齐 PDF 5.3 + 7.3）
    var statusRow = c('div', 'huilian-status-row');
    statusEl = c('div', 'huilian-status', '就绪：粘贴地址后点播放，或直接点片单');
    bitrateEl = c('div', 'huilian-metas', '');
    bufferEl = c('div', 'huilian-metas', '');
    statusRow.appendChild(statusEl); statusRow.appendChild(bitrateEl); statusRow.appendChild(bufferEl);
    wrap.appendChild(statusRow);

    // 7. 片单（由用户在 extraInfo 里注入；无注入时给一个默认的"使用说明"）
    var cards = c('div', 'huilian-cards');
    cards.appendChild(buildDefaultCard());
    wrap.appendChild(cards);

    host.appendChild(wrap);

    // 若 URL -params 里带 autoPlay=1 + url=xxx，自动起播
    var params = new URLSearchParams(global.location.search);
    if (params.get('autoPlay') === '1' && params.get('url')) {
      inputEl.value = params.get('url');
      playFromInput();
    }
  }

  // 默认卡片：使用说明 + 示例协议
  function buildDefaultCard() {
    var card = c('div', 'huilian-card');
    card.appendChild(c('div', 'huilian-card-title', '「汇联」用法'));
    var body = c('div', 'huilian-card-body',
      '1) 粘贴任意 m3u8 / mp4 / flv 直链，点播放 → 起播\n' +
      '2) 粘贴磁力 → 需要 webtorrent 插件才能 P2P 流\n' +
      '3) 粘贴 aliyun://fileId|driveId|refreshToken → 阿里云盘直链\n' +
      '4) 粘贴 emby://server|itemId|user|pass → Emby/Jellyfin 直链\n' +
      '5) 粘贴 webdav URL（含 /dav 路径）→ 网络挂载\n' +
      '\n 边播边删：播放头前的已播段会主动回收，磁盘永远只保留一个 45s 尾巴。\n' +
      '随意跳转：点进度条任意位置 → 从该点重新填充窗口。');
    card.appendChild(body);
    return card;
  }

  // =====================================================================
  //  起播 / 清空
  // =====================================================================
  function playFromInput() {
    var raw = (inputEl.value || '').trim();
    if (!raw) { toast('请先粘贴播放地址'); return; }
    Prov.resolve(raw).then(function (manifest) {
      curManifest = manifest;
      manifest._startedAt = Date.now();
      if (providerBadgeEl) providerBadgeEl.textContent = '来源：' + (manifest.source || 'unknown') + ' ｜ ' + (manifest.title || '');
      if (manifest.kind === 'collection') {
        renderCollection(manifest);
        return;
      }
      startStream(manifest);
    }).catch(function (err) {
      toast('解析失败：' + (err && err.message ? err.message : String(err)));
    });
  }

  function startStream(manifest) {
    var provider = Prov.pick(manifest.url || manifest.masterUrl || '');
    if (!provider) { toast('无可用来源适配器'); return; }
    // MIME 回退
    var mime = manifest.mimeType || guessMime(manifest);
    stream = new Stream({
      cfg: Object.assign({}, Stream.DEFAULTS),
      onError: function (m) { toast('播放错误：' + m); },
      onReady: function () { toast('缓冲就绪，开始播放'); },
      onBytes: function (delta, total) { onBytesUpdated(delta, total); },
      onTick: function (cur, bufEnd, cutoff) { onStreamTick(cur, bufEnd, cutoff); }
    });
    stream.attach(curVideoEl, provider, manifest, mime).then(function () {
      curVideoEl.play().catch(function () { /* autoplay 被拦截：等用户手动点 */ });
    }).catch(function (e) {
      toast('起播失败：' + (e && e.message ? e.message : String(e)));
    });
  }

  function clearPlayback() {
    if (stream) { stream.reset(); stream = null; }
    curManifest = null;
    if (curVideoEl) curVideoEl.src = '';
    if (heatmapCtx) { heatmapCtx.clearRect(0, 0, heatmapCanvas.width, heatmapCanvas.height); }
    if (inputEl) inputEl.value = '';
    if (providerBadgeEl) providerBadgeEl.textContent = '未选择来源';
    if (statusEl) statusEl.textContent = '已清空';
  }

  function renderCollection(manifest) {
    // 媒体服务器库列表 → 渲染成 UI，点一下 resolve 单集
    var libs = manifest.extra && manifest.extra.libraries || [];
    var cards = hostEl && hostEl.querySelector('.huilian-cards');
    if (!cards) return;
    cards.innerHTML = '';
    if (!libs.length) { cards.appendChild(c('div', 'huilian-card-body', '（空库）')); return; }
    libs.forEach(function (lib) {
      var card = c('div', 'huilian-card');
      card.appendChild(c('div', 'huilian-card-title', lib.Name || lib.title || 'library'));
      card.appendChild(c('div', 'huilian-card-body', '共 ' + (lib.ChildCount || 0) + ' 项'));
      card.addEventListener('click', function () {
        if (inputEl) inputEl.value = (manifest.source + '://') + manifest.url + '|' + lib.Id;
        playFromInput();
      });
      cards.appendChild(card);
    });
  }

  // =====================================================================
  //  事件处理
  // =====================================================================
  function onSeek(e) {
    if (stream && curVideoEl) {
      stream.seekTo(curVideoEl.currentTime);
      toast('已跳转（从 ' + curVideoEl.currentTime.toFixed(1) + 's 重建缓冲）');
    }
  }
  function onPlayState() {
    if (statusEl) statusEl.textContent = (curVideoEl.paused ? '已暂停' : '播放中');
  }
  function onEnded() {
    toast('播放完毕，缓冲已清空');
    if (stream) stream.reset();
    stream = null;
  }
  function onSeekbarClick(e) {
    if (!curVideoEl || !curManifest) return;
    var r = e.currentTarget.getBoundingClientRect();
    var ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    var target = ratio * (curManifest.durationSec || curVideoEl.duration || 0);
    curVideoEl.currentTime = target;
    onSeek(e);
  }
  function onSeekbarHover(e) {
    if (!curVideoEl) return;
    var r = e.currentTarget.getBoundingClientRect();
    var ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    var target = ratio * (curVideoEl.duration || 0);
    e.currentTarget.setAttribute('data-hover', target.toFixed(1) + 's');
  }

  // =====================================================================
  //  缓冲 + 热力图
  // =====================================================================
  function onBytesUpdated(delta, total) {
    if (bitrateEl) bitrateEl.textContent = '已下载 ' + (total / 1024 / 1024).toFixed(2) + ' MB';
  }
  function onStreamTick(cur, bufEnd, cutoff) {
    if (bufferEl) bufferEl.textContent = '缓冲 ' + Math.max(0, bufEnd - cur).toFixed(1) + 's';
    updateDecisionStatus(cur, bufEnd);
    scheduleHeatmapRedraw();
  }

  // 决策树（对齐 PDF 5.3）
  function updateDecisionStatus(cur, bufEnd) {
    if (!statusEl) return;
    var margin = bufEnd - cur;
    var verdict;
    if (margin > CFG.HOT_THRESHOLD) verdict = '网络充裕，可任意跳转';
    else if (margin > CFG.OK_THRESHOLD) verdict = '缓冲充足';
    else if (margin > CFG.WARM_THRESHOLD) verdict = '缓冲 ' + margin.toFixed(0) + 's，建议暂停等待';
    else verdict = '缓冲紧张';
    var reclaim = cur > 0 ? (' ｜ 已播 ' + cur.toFixed(0) + 's 标记可回收') : '';
    statusEl.textContent = verdict + reclaim;
  }

  function scheduleHeatmapRedraw() {
    if (redrawTimer) return;
    redrawTimer = setTimeout(function () { redrawTimer = null; drawHeatmap(); }, 200);
  }

  function drawHeatmap() {
    if (!heatmapCanvas) return;
    heatmapCtx = heatmapCtx || heatmapCanvas.getContext('2d');
    var ctx = heatmapCtx;
    var W = heatmapCanvas.width, H = heatmapCanvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!curVideoEl) return;
    var dur = curVideoEl.duration || (curManifest && curManifest.durationSec) || 0;
    var cur = curVideoEl.currentTime || 0;
    if (!dur) return;
    var slotW = W / CFG.HEATMAP_SLOTS;
    for (var s = 0; s < CFG.HEATMAP_SLOTS; s++) {
      var sStart = (s / CFG.HEATMAP_SLOTS) * dur;
      var sEnd = ((s + 1) / CFG.HEATMAP_SLOTS) * dur;
      var covered = coverage(sStart, sEnd);
      var color = COLOR_EMPTY;
      if (covered >= 0.95) color = COLOR_FULL;
      else if (covered > 0.05) color = COLOR_PARTIAL;
      if (sEnd < cur && covered >= 0.95) color = COLOR_RECLAIMED;
      ctx.fillStyle = color;
      ctx.fillRect(s * slotW, 0, Math.ceil(slotW), H);
    }
    var x = (cur / dur) * W;
    ctx.fillStyle = COLOR_PLAYHEAD;
    ctx.fillRect(x - 1, 0, 2, H);
  }
  function coverage(a, b) {
    if (!curVideoEl || !curVideoEl.buffered) return 0;
    var cov = 0;
    for (var i = 0; i < curVideoEl.buffered.length; i++) {
      var rs = curVideoEl.buffered.start(i), re = curVideoEl.buffered.end(i);
      var o = Math.min(b, re) - Math.max(a, rs);
      if (o > 0) cov += o;
    }
    return cov / (b - a);
  }

  // =====================================================================
  //  工具
  // =====================================================================
  function guessMime(manifest) {
    var u = manifest.url || manifest.masterUrl || '';
    if (/\.m3u8/i.test(u)) return 'video/mp2t';
    if (/\.webm/i.test(u)) return 'video/webm';
    if (/\.mkv/i.test(u)) return 'video/x-matroska';
    return 'video/mp4';
  }
  function c(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (typeof text !== 'undefined') e.textContent = text;
    return e;
  }
  function toast(msg) {
    if (SFV.online && typeof SFV.online.toast === 'function') SFV.online.toast(msg);
    else if (global.console) console.log('[huilian]', msg);
  }

  function unmount() {
    clearPlayback();
    hostEl = null;
  }

  function back() {
    clearPlayback();
    return false;
  }

  // =====================================================================
  //  注册（router 就绪就占；没就绪就挂在命名空间让 router 启动时拾取）
  // =====================================================================
  if (SFV.router && typeof SFV.router.register === 'function') {
    SFV.router.register({ id: 'discover', title: '汇联', mount: mount, unmount: unmount, back: back });
  } else {
    SFV.huilianPage = { mount: mount, unmount: unmount, back: back };
  }
})(typeof window !== 'undefined' ? window : this);
