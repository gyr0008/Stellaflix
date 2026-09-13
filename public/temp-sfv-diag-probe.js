/*
 * [临时诊断] 渲染进程探针 —— 排查影视播放卡死
 *
 * 用法：
 *   1. 重启 App（加载 server.js 新的 /api/diag-log 路由）
 *   2. F12 打开 DevTools → Console
 *   3. 粘贴本文件全部内容并回车（应输出 "probe installed"）
 *   4. 正常操作：打开《肖申克的救赎》→ 点播放
 *   5. 等卡死发生后告诉我，我读 outputs/sfv-diag-renderer.log
 *
 * 探针做什么（全程只读，不改任何播放行为）：
 *   - 每秒采样：video.duration / currentTime / buffered 区间 / readyState / networkState
 *     / 解码帧数(getVideoPlaybackQuality) / jsHeap / 资源请求计数 / hls 实例状态
 *   - 转发 console 中含 SFV/HLS/MSE/SourceBuffer/buffer 关键词的日志
 *   - 挂接 hls ERROR 事件（fatal/soft、类型、分片序号）
 *   - 全部 POST 到 /api/diag-log 落盘（渲染冻结后主进程仍写盘，日志不丢）
 */
(function () {
  if (window.__sfvProbe) return 'already installed';
  window.__sfvProbe = true;
  var t0 = Date.now();

  function send(kind, data) {
    try {
      fetch('/api/diag-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: Date.now() - t0, kind: kind, data: data })
      }).catch(function () {});
    } catch (e) {}
  }

  // 同步 XHR 落盘通道：主线程在下一语句硬冻结时也能保证该条日志已写入。
  // 仅用于 marker 级关键日志（数量少，localhost 往返 ~1-2ms 可忽略）。
  function sendSync(kind, data) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/diag-log', false); // false = 同步
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(JSON.stringify({ t: Date.now() - t0, kind: kind, data: data }));
    } catch (e) {}
  }

  // 转发 console 关键日志（错误/警告全收，info/log 只收关键词相关）
  ['error', 'warn', 'info', 'log'].forEach(function (m) {
    var orig = console[m];
    console[m] = function () {
      try {
        var s = Array.prototype.map.call(arguments, function (a) {
          try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ');
        if (m === 'error' || m === 'warn' || /SFV|HLS|MSE|SourceBuffer|buffer|Danmaku/i.test(s)) {
          send('console.' + m, s.slice(0, 600));
          // marker 级（冻结定位锚点 + 播放管线关键节点）走同步通道，冻结也丢不了
          if (/SFV-FREEZE|attachHls called|loadSource|Native Fallback|attachFlv called/i.test(s)) {
            sendSync('marker.sync', s.slice(0, 600));
          }
        }
      } catch (e) {}
      return orig.apply(console, arguments);
    };
  });

  // 媒体元素资源错误（video/audio/source 的 error 事件不冒泡，捕获阶段 document 级监听）
  // openUrl 直链路径没有挂 video error 监听，这是唯一能看见 direct 播放失败码的通道
  document.addEventListener('error', function (e) {
    try {
      var el = e && e.target;
      if (!el || !el.tagName) return;
      var tag = el.tagName.toLowerCase();
      if (tag !== 'video' && tag !== 'audio' && tag !== 'source') return;
      sendSync('media.error', {
        tag: tag,
        code: el.error ? el.error.code : 0,
        msg: (el.error && el.error.message) ? String(el.error.message).slice(0, 200) : '',
        src: String(el.currentSrc || el.src || '').slice(0, 300),
        ns: el.networkState, rs: el.readyState
      });
    } catch (err) {}
  }, true);

  window.addEventListener('error', function (e) {
    send('window.error', String((e && e.message) || e).slice(0, 300));
  });
  window.addEventListener('unhandledrejection', function (e) {
    send('unhandledrejection', String(e && e.reason).slice(0, 300));
  });

  var hookedHls = null;
  var lastFragSn = -1;
  var everSawVideo = false; // 见到视频元素后才开始采样（音乐态下保持静默）

  // resCount 默认 250 条上限会顶死（冻结期间完全无用），放大缓冲让它能真实反映请求洪峰
  try { if (performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(100000); } catch (e) {}

  setInterval(function () {
    var out = {};
    try {
      var v = document.querySelector('#sfv-overlay video') || document.querySelector('video.sfv-video') || document.querySelector('#sfv-player-overlay video') || document.querySelector('video');
      var hlsNow = null;
      try { var _s0 = window.StellaflixVideo || window.SFV; hlsNow = _s0 && _s0.sourceAdapterHls && _s0.sourceAdapterHls.getActiveHls && _s0.sourceAdapterHls.getActiveHls(); } catch (e) {}
      if (!v && !hlsNow && !everSawVideo) return; // 无播放活动，静默
      if (v) everSawVideo = true;
      if (v) {
        var buf = [];
        for (var i = 0; i < v.buffered.length; i++) {
          buf.push([+v.buffered.start(i).toFixed(1), +v.buffered.end(i).toFixed(1)]);
        }
        out.video = {
          dur: +(v.duration || 0).toFixed(1),
          ct: +(v.currentTime || 0).toFixed(1),
          buffered: buf,
          rs: v.readyState, ns: v.networkState,
          paused: v.paused, vw: v.videoWidth, vh: v.videoHeight,
          err: v.error ? v.error.code : 0,
          srcType: /^blob:/.test(v.currentSrc || '') ? 'blob(MSE)' : (/^https?:/.test(v.currentSrc || '') ? 'direct' : 'none')
        };
        try {
          var q = v.getVideoPlaybackQuality();
          out.frames = { total: q.totalVideoFrames, dropped: q.droppedVideoFrames };
        } catch (e) {}
      }
      try { out.heapMB = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (e) {}
      try { out.resCount = performance.getEntriesByType('resource').length; } catch (e) {}
      try {
        var _sfv = window.StellaflixVideo || window.SFV;
        var hls = _sfv && _sfv.sourceAdapterHls && _sfv.sourceAdapterHls.getActiveHls && _sfv.sourceAdapterHls.getActiveHls();
        if (hls) {
          out.hls = {
            levels: hls.levels ? hls.levels.length : 0,
            cur: hls.currentLevel,
            loadingsn: (function () {
              try {
                var frags = [];
                hls.streamController && hls.streamController.fragCurrent && frags.push(hls.streamController.fragCurrent.sn);
                return frags.join(',');
              } catch (e) { return '?'; }
            })()
          };
          if (hls !== hookedHls) {
            hookedHls = hls;
            try {
              hls.on('hlsError', function (ev, d) {
                send('hls.error', {
                  fatal: !!(d && d.fatal), type: d && d.type, details: d && d.details,
                  code: d && d.response && d.response.code,
                  sn: d && d.frag && d.frag.sn,
                  err: String((d && d.error && (d.error.message || d.error)) || '').slice(0, 200)
                });
              });
              hls.on('hlsFragBuffered', function (ev, d) {
                var sn = d && d.frag && d.frag.sn;
                if (sn !== lastFragSn) { lastFragSn = sn; send('hls.fragBuffered', { sn: sn }); }
              });
              send('hls.hooked', { levels: out.hls.levels });
            } catch (e) { send('hls.hookFail', String(e)); }
          }
        }
      } catch (e) {}
      send('sample', out);
    } catch (e) { send('sampleError', String(e)); }
  }, 1000);

  send('probe.installed', { ua: navigator.userAgent });
  return 'probe installed';
})();
