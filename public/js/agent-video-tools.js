/*
 * Stellaflix 影视 — AI 助手本地工具层 (agent-video-tools.js)
 *
 * 与 agent-music-tools 对称：无需 LLM API 即可执行「搜片 / 起播 / 播控 / 选集」。
 * 只调用已有 SFV.* 公共入口，不预置片源、不硬编码站点（合规红线与 sources-core 一致）。
 *
 * 导出：window.StellaflixAgentVideoTools
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var MAX_CANDIDATES = 8;
  var SEARCH_TIMEOUT = 12000;
  var DETAIL_TIMEOUT = 12000;

  function toolError(code, message, details) {
    return {
      ok: false,
      error: code,
      message: message,
      details: details || null,
      authMode: 'imported-cms-source',
      requiresLogin: false
    };
  }

  function getSFV() {
    return global.StellaflixVideo || null;
  }

  function hasEnabledSources() {
    var v = getSFV();
    if (!v || !v.sources || typeof v.sources.getEnabledSources !== 'function') return false;
    try {
      var list = v.sources.getEnabledSources();
      return !!(list && list.length);
    } catch (_e) {
      return false;
    }
  }

  function enabledSourceCount() {
    var v = getSFV();
    if (!v || !v.sources || typeof v.sources.getEnabledSources !== 'function') return 0;
    try {
      var list = v.sources.getEnabledSources();
      return list && list.length ? list.length : 0;
    } catch (_e) {
      return 0;
    }
  }

  function sourceById(id) {
    var v = getSFV();
    if (!v || !v.sources || typeof v.sources.getSources !== 'function') return null;
    try {
      var all = v.sources.getSources() || [];
      for (var i = 0; i < all.length; i++) {
        if (all[i] && all[i].id === id) return all[i];
      }
    } catch (_e) {}
    return null;
  }

  var NON_MAIN_EPISODE_RE = /(预告|片花|花絮|特典|彩蛋|抢先|幕后|特辑|先行|先导|trailer|teaser|preview)/i;

  function pickEpisode(plays) {
    var v = getSFV();
    if (!plays || !plays.length) return null;
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < plays.length; i++) {
      var eps = (plays[i] && plays[i].episodes) || [];
      if (!eps.length) continue;
      var ep = null;
      if (v && v.sources && typeof v.sources.pickMainEpisode === 'function') {
        ep = v.sources.pickMainEpisode(eps);
      }
      if (!ep) ep = eps[0];
      // 兜底：即便上游返回了预告片，也改选第一个非预告集
      if (ep && NON_MAIN_EPISODE_RE.test(ep.name || '')) {
        for (var j = 0; j < eps.length; j++) {
          if (!NON_MAIN_EPISODE_RE.test(eps[j].name || '')) { ep = eps[j]; break; }
        }
      }
      var score = (ep && /正片|完整版|高清|超清|中字|国语|HD|BD/i.test(ep.name || '')) ? 2 : 1;
      if (ep && NON_MAIN_EPISODE_RE.test(ep.name || '')) score -= 1;
      score += Math.max(0, 10 - i) * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = { play: plays[i], ep: ep };
      }
    }
    return best;
  }

  function candidateSummary(item, index) {
    item = item || {};
    var variants = item.variants || [];
    var first = variants[0] || {};
    return {
      index: index,
      key: item.key || first.key || ((first.sourceId || '') + ':' + (first.vodId || '')),
      title: String(item.title || '').slice(0, 120),
      year: String(item.year || first.year || '').slice(0, 16),
      remarks: String(item.remarks || first.remarks || '').slice(0, 40),
      typeName: String(item.typeName || first.typeName || '').slice(0, 24),
      pic: String(item.pic || first.pic || '').slice(0, 300),
      sourceId: first.sourceId || '',
      sourceName: first.sourceName || '',
      vodId: first.vodId || '',
      variantCount: variants.length
    };
  }

  // 解说 / 混剪 / 切片类内容：不是正片，小M 候选与自动起播都不应出现。
  // 只检查 title/remarks/typeName，不扫 vod_content 简介——正片简介里可能偶发
  // 「剪辑/盘点」等词，会把搜索页能命中的正片误杀。
  var COMMENTARY_TITLE_RE = /(?:电影解说|影视解说|影片解说|剧情解说|电影解说版|解说版|\[电影解说\]|\【电影解说\】|(\d{1,2}|[一二三四五六七八九十])分钟看完|一口气看完|看完一部电影|影视吐槽|电影吐槽|电影混剪|影视混剪|高燃混剪|剧情混剪|电影剪辑|影视剪辑|影视二创|电影盘点|烂片盘点)/i;
  var COMMENTARY_LOOSE_RE = /(?:解说|混剪|吐槽|盘点|切片)/i;

  function itemCommentaryBlob(item) {
    item = item || {};
    var variants = item.variants || [];
    var parts = [
      item.title,
      item.remarks,
      item.typeName
    ];
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i] || {};
      parts.push(v.title, v.remarks, v.typeName);
    }
    return parts.filter(Boolean).join(' ');
  }

  function isCommentaryItem(item) {
    var blob = itemCommentaryBlob(item);
    if (!blob) return false;
    if (COMMENTARY_TITLE_RE.test(blob)) return true;
    // 「XX解说」「【解说】」等短标签
    if (/\[.{0,12}解说.{0,12}\]|\【.{0,12}解说.{0,12}\】|（.{0,12}解说.{0,12}）|\(.{0,12}解说.{0,12}\)/i.test(blob)) return true;
    // type_name 直接标为解说/影评类
    var type = String(item.typeName || '');
    if (type && COMMENTARY_LOOSE_RE.test(type)) return true;
    return false;
  }

  function playEpisodeNow(view, ep, play, plays) {
    var v = getSFV();
    if (!v) return toolError('VIDEO_MODULE_NOT_READY', '影视模块尚未加载，请重启 Stellaflix');
    var playFn = null;
    if (v.playOrchestrator && typeof v.playOrchestrator.play === 'function') {
      playFn = v.playOrchestrator.play;
    } else if (v.online && typeof v.online.playEpisode === 'function') {
      playFn = v.online.playEpisode;
    } else if (v.onlineActions && typeof v.onlineActions.playEpisode === 'function') {
      playFn = v.onlineActions.playEpisode;
    }
    if (!playFn) return toolError('VIDEO_PLAY_NOT_READY', '影视播放入口尚未就绪');
    if (!ep || !ep.url) return toolError('EPISODE_NO_URL', '该集没有可播放地址');
    var opt = plays && plays.length ? { plays: plays, fromIndex: 0 } : undefined;
    for (var i = 0; i < (plays || []).length; i++) {
      if (plays[i] === play) {
        opt = { plays: plays, fromIndex: i };
        break;
      }
    }
    try {
      playFn(view, ep, play, opt);
      return {
        ok: true,
        message: '正在播放：' + (view.title || '影片') + (ep.name ? ' · ' + ep.name : ''),
        movie: {
          title: String(view.title || '').slice(0, 120),
          year: String(view.year || '').slice(0, 16),
          episode: String(ep.name || '').slice(0, 80),
          sourceName: String((view.source && view.source.name) || '').slice(0, 40)
        },
        authMode: 'imported-cms-source',
        requiresLogin: false
      };
    } catch (error) {
      return toolError('PLAY_FAILED', error && error.message ? error.message : '起播失败');
    }
  }

  function playFromSummary(summary, episodeIndex) {
    var v = getSFV();
    if (!v || !v.sources) return toolError('VIDEO_MODULE_NOT_READY', '影视模块尚未加载');
    var src = sourceById(summary.sourceId);
    if (!src) return toolError('SOURCE_NOT_FOUND', '片源已不存在，请在片源管理中重新导入');
    if (summary.vodId == null || summary.vodId === '') return toolError('VOD_ID_MISSING', '缺少影片标识');
    if (!v.sources.detail) return toolError('VIDEO_DETAIL_NOT_READY', '详情接口尚未就绪');

    return v.sources.detail(src, summary.vodId, DETAIL_TIMEOUT).then(function (res) {
      if (!res || !res.ok) {
        var reason = (res && res.reason) || 'unknown';
        if (reason === 'source-not-found') return toolError('SOURCE_NOT_FOUND', '片源不可用');
        return toolError('DETAIL_FAILED', '无法获取播放地址（' + reason + '）');
      }
      var plays = res.plays || [];
      if (!plays.length) return toolError('NO_PLAY_URL', '该片没有可用播放地址');
      var picked = pickEpisode(plays);
      if (!picked) return toolError('NO_PLAY_URL', '该片没有可用播放地址');
      if (episodeIndex != null && isFinite(episodeIndex)) {
        var idx = Math.max(0, Math.floor(Number(episodeIndex)));
        var targetPlay = picked.play;
        var epList = targetPlay.episodes || [];
        if (idx < epList.length) picked.ep = epList[idx];
      }
      var vod = res.vod || {};
      var view = {
        mode: 'detail',
        key: (src.id + ':' + summary.vodId),
        title: summary.title || vod.title || '影片',
        pic: summary.pic || vod.pic || '',
        year: summary.year || vod.year || '',
        source: src,
        vodId: summary.vodId,
        from: 'agent'
      };
      return playEpisodeNow(view, picked.ep, picked.play, plays);
    }).catch(function (error) {
      return toolError('DETAIL_FAILED', error && error.message ? error.message : '详情请求失败');
    });
  }

  // ---------------------------------------------------------------- 公共工具

  function getVideoContext() {
    var v = getSFV();
    var player = v && v.player;
    var meta = null;
    var open = false;
    var playing = false;
    var videoEl = null;
    try {
      if (player) {
        open = typeof player.isOpen === 'function' ? !!player.isOpen() : false;
        meta = typeof player.getMeta === 'function' ? player.getMeta() : null;
        if (!meta && typeof player.getCurrentMeta === 'function') meta = player.getCurrentMeta();
        videoEl = typeof player.getVideoEl === 'function' ? player.getVideoEl() : null;
        if (videoEl) playing = open && !videoEl.paused && !videoEl.ended;
      }
    } catch (_e) {}
    var space = 'unknown';
    try {
      if (v && v.state && typeof v.state.isVideo === 'function') space = v.state.isVideo() ? 'video' : 'music';
    } catch (_e2) {}
    return {
      ok: true,
      message: '已获取影视上下文',
      space: space,
      sourceCount: enabledSourceCount(),
      hasSources: hasEnabledSources(),
      playerOpen: open,
      playing: playing,
      currentTitle: meta && meta.title ? String(meta.title) : '',
      authMode: 'imported-cms-source',
      requiresLogin: false
    };
  }

  function searchMovies(input) {
    var options = (input && typeof input === 'object') ? input : { query: input };
    var query = String(options.query || options.keyword || options.title || '').trim();
    if (!query) return Promise.resolve(toolError('QUERY_REQUIRED', '请告诉我要搜索的电影或剧集名称'));
    var v = getSFV();
    if (!v || !v.sources || typeof v.sources.search !== 'function') {
      return Promise.resolve(toolError('VIDEO_MODULE_NOT_READY', '影视片源模块尚未加载'));
    }
    if (!hasEnabledSources()) {
      return Promise.resolve(toolError(
        'NO_VIDEO_SOURCE',
        '还没有导入片源。请到 视觉控制台 → 片源 添加 CMS 接口后再试。Stellaflix 不内置任何站点。'
      ));
    }
    return v.sources.search(query, { timeout: SEARCH_TIMEOUT }).then(function (res) {
      var items = (res && res.items) || [];
      var candidates = [];
      var filteredCommentary = 0;
      for (var i = 0; i < items.length; i++) {
        if (isCommentaryItem(items[i])) {
          filteredCommentary++;
          continue;
        }
        if (candidates.length >= MAX_CANDIDATES) break;
        candidates.push(candidateSummary(items[i], candidates.length));
      }
      if (!candidates.length) {
        var noSource = !!(res && res.noSource);
        if (!noSource && filteredCommentary > 0) {
          return toolError(
            'NOT_FOUND',
            '没有找到正片「' + query + '」。已过滤解说/混剪类结果，可试试完整片名或年份。'
          );
        }
        return toolError(
          noSource ? 'NO_VIDEO_SOURCE' : 'NOT_FOUND',
          noSource
            ? '还没有导入片源。请到 视觉控制台 → 片源 添加 CMS 接口后再试。'
            : ('没有找到「' + query + '」，可以试试更完整的片名或年份。')
        );
      }
      return {
        ok: true,
        message: candidates.length === 1
          ? ('找到 1 个正片结果：' + candidates[0].title)
          : ('找到 ' + candidates.length + ' 个正片候选'),
        query: query,
        needsSelection: candidates.length > 1,
        candidates: candidates,
        candidateCount: candidates.length,
        filteredCommentary: filteredCommentary,
        authMode: 'imported-cms-source',
        requiresLogin: false
      };
    }).catch(function (error) {
      return toolError('SEARCH_FAILED', error && error.message ? error.message : '搜索失败，请稍后重试');
    });
  }

  function searchAndPlayMovie(input) {
    var options = (input && typeof input === 'object') ? input : { query: input };
    var query = String(options.query || options.title || '').trim();
    if (!query && options.year) query = String(options.year);
    if (!query) return Promise.resolve(toolError('QUERY_REQUIRED', '请告诉我要播放的电影或剧集名称'));
    if (options.resultIndex != null || options.index != null) {
      var pickIdx = Number(options.resultIndex != null ? options.resultIndex : options.index);
      var last = options.lastCandidates || options.candidates;
      if (Array.isArray(last) && last[pickIdx]) {
        return playFromSummary(last[pickIdx], options.episodeIndex);
      }
    }
    return searchMovies({ query: query }).then(function (searchResult) {
      if (!searchResult || !searchResult.ok) return searchResult;
      if (searchResult.needsSelection && options.autoPlayFirst !== true) {
        return {
          ok: false,
          needsSelection: true,
          error: 'NEEDS_SELECTION',
          message: '找到多个结果，请选择要播放的影片：',
          query: searchResult.query,
          candidates: searchResult.candidates,
          authMode: 'imported-cms-source',
          requiresLogin: false
        };
      }
      var pick = 0;
      if (options.year) {
        for (var i = 0; i < searchResult.candidates.length; i++) {
          if (String(searchResult.candidates[i].year || '').indexOf(String(options.year)) >= 0) {
            pick = i;
            break;
          }
        }
      }
      return playFromSummary(searchResult.candidates[pick], options.episodeIndex);
    });
  }

  function playMovieCandidate(input) {
    var options = (input && typeof input === 'object') ? input : {};
    if (options.sourceId && (options.vodId || options.vodId === 0)) {
      return playFromSummary({
        title: options.title || '',
        year: options.year || '',
        pic: options.pic || '',
        sourceId: options.sourceId,
        vodId: options.vodId
      }, options.episodeIndex);
    }
    if (options.index != null && Array.isArray(options.candidates) && options.candidates[options.index]) {
      return playFromSummary(options.candidates[options.index], options.episodeIndex);
    }
    return Promise.resolve(toolError('CANDIDATE_REQUIRED', '请指定要播放的候选影片'));
  }

  function controlVideoPlayback(input) {
    var options = (input && typeof input === 'object') ? input : {};
    var action = String(options.action || '').trim().toLowerCase();
    if (action !== 'play' && action !== 'pause') {
      return Promise.resolve(toolError('ACTION_INVALID', '视频播放控制只支持 play 或 pause'));
    }
    var v = getSFV();
    var player = v && v.player;
    if (!player || typeof player.isOpen !== 'function' || !player.isOpen()) {
      return Promise.resolve(toolError('NO_CURRENT_VIDEO', '当前没有正在播放的影片'));
    }
    var videoEl = typeof player.getVideoEl === 'function' ? player.getVideoEl() : null;
    if (!videoEl) return Promise.resolve(toolError('PLAYER_NOT_READY', '视频播放器未就绪'));
    try {
      var isPaused = !!videoEl.paused;
      if (action === 'play' && !isPaused) {
        return Promise.resolve({ ok: true, action: action, playing: true, message: '当前已在播放', authMode: 'local-player', requiresLogin: false });
      }
      if (action === 'pause' && isPaused) {
        return Promise.resolve({ ok: true, action: action, playing: false, message: '当前已经暂停', authMode: 'local-player', requiresLogin: false });
      }
      if (typeof player.togglePlay === 'function') player.togglePlay();
      else if (action === 'pause') videoEl.pause();
      else {
        var p = videoEl.play();
        if (p && p.catch) p.catch(function () {});
      }
      var nowPlaying = !videoEl.paused;
      if (action === 'play' && !nowPlaying) return Promise.resolve(toolError('CONTROL_FAILED', '未能继续播放'));
      if (action === 'pause' && nowPlaying) return Promise.resolve(toolError('CONTROL_FAILED', '未能暂停播放'));
      var meta = typeof player.getMeta === 'function' ? player.getMeta() : null;
      var title = meta && meta.title ? String(meta.title) : '';
      return Promise.resolve({
        ok: true,
        action: action,
        playing: nowPlaying,
        message: (action === 'play' ? '已继续播放' : '已暂停') + (title ? '：' + title : ''),
        authMode: 'local-player',
        requiresLogin: false
      });
    } catch (error) {
      return Promise.resolve(toolError('CONTROL_FAILED', error && error.message ? error.message : '播放控制失败'));
    }
  }

  function seekVideo(input) {
    var options = (input && typeof input === 'object') ? input : {};
    var v = getSFV();
    var player = v && v.player;
    if (!player || typeof player.isOpen !== 'function' || !player.isOpen()) {
      return Promise.resolve(toolError('NO_CURRENT_VIDEO', '当前没有正在播放的影片'));
    }
    var videoEl = typeof player.getVideoEl === 'function' ? player.getVideoEl() : null;
    if (!videoEl || !isFinite(videoEl.duration) || videoEl.duration <= 0) {
      return Promise.resolve(toolError('SEEK_UNAVAILABLE', '当前无法读取影片时长，无法跳转'));
    }
    var target = null;
    if (options.seconds != null && isFinite(Number(options.seconds))) {
      target = Math.max(0, Math.min(videoEl.duration, Number(options.seconds)));
    } else if (options.percent != null && isFinite(Number(options.percent))) {
      target = Math.max(0, Math.min(videoEl.duration, videoEl.duration * Number(options.percent) / 100));
    } else if (options.time && /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(options.time))) {
      var parts = String(options.time).split(':').map(Number);
      var sec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
      target = Math.max(0, Math.min(videoEl.duration, sec));
    }
    if (target == null) return Promise.resolve(toolError('SEEK_TARGET_REQUIRED', '请提供跳转目标，例如快进 10 分钟或跳到 01:20:00'));
    try {
      videoEl.currentTime = target;
      return Promise.resolve({
        ok: true,
        message: '已跳转到 ' + formatTime(target),
        currentTime: target,
        duration: videoEl.duration,
        authMode: 'local-player',
        requiresLogin: false
      });
    } catch (error) {
      return Promise.resolve(toolError('SEEK_FAILED', error && error.message ? error.message : '跳转失败'));
    }
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return h > 0 ? (h + ':' + pad(m) + ':' + pad(s)) : (pad(m) + ':' + pad(s));
  }

  function selectEpisode(input) {
    var options = (input && typeof input === 'object') ? input : {};
    var direction = String(options.direction || '').toLowerCase();
    var v = getSFV();
    var player = v && v.player;
    if (!player || typeof player.isOpen !== 'function' || !player.isOpen()) {
      return Promise.resolve(toolError('NO_CURRENT_VIDEO', '当前没有正在播放的影片'));
    }
    try {
      if (direction === 'next') {
        if (typeof player.hasNextEpisode === 'function' && !player.hasNextEpisode()) {
          return Promise.resolve(toolError('NO_NEXT_EPISODE', '已经是最后一集'));
        }
        if (typeof player.playNextEpisode !== 'function') return Promise.resolve(toolError('EPISODE_NAV_UNAVAILABLE', '选集导航不可用'));
        var ok = player.playNextEpisode();
        return Promise.resolve(ok === false
          ? toolError('NO_NEXT_EPISODE', '切换下一集失败')
          : { ok: true, direction: 'next', message: '已切换到下一集', authMode: 'local-player', requiresLogin: false });
      }
      if (direction === 'previous') {
        if (typeof player.hasPrevEpisode === 'function' && !player.hasPrevEpisode()) {
          return Promise.resolve(toolError('NO_PREV_EPISODE', '已经是第一集'));
        }
        if (typeof player.playPrevEpisode !== 'function') return Promise.resolve(toolError('EPISODE_NAV_UNAVAILABLE', '选集导航不可用'));
        var okPrev = player.playPrevEpisode();
        return Promise.resolve(okPrev === false
          ? toolError('NO_PREV_EPISODE', '切换上一集失败')
          : { ok: true, direction: 'previous', message: '已切换到上一集', authMode: 'local-player', requiresLogin: false });
      }
      if (options.episodeIndex != null && isFinite(Number(options.episodeIndex))) {
        var idx = Math.max(0, Math.floor(Number(options.episodeIndex)));
        if (typeof player.playEpisodeAt !== 'function') return Promise.resolve(toolError('EPISODE_NAV_UNAVAILABLE', '选集导航不可用'));
        var okAt = player.playEpisodeAt(idx);
        return Promise.resolve(okAt === false
          ? toolError('EPISODE_SWITCH_FAILED', '切换到指定集失败')
          : { ok: true, episodeIndex: idx, message: '已切换到第 ' + (idx + 1) + ' 集', authMode: 'local-player', requiresLogin: false });
      }
      return Promise.resolve(toolError('EPISODE_DIRECTION_REQUIRED', '请指定下一集、上一集或集数'));
    } catch (error) {
      return Promise.resolve(toolError('EPISODE_SWITCH_FAILED', error && error.message ? error.message : '选集失败'));
    }
  }

  function toggleFullscreen() {
    var v = getSFV();
    var player = v && v.player;
    if (!player || typeof player.isOpen !== 'function' || !player.isOpen()) {
      return Promise.resolve(toolError('NO_CURRENT_VIDEO', '当前没有正在播放的影片'));
    }
    try {
      if (typeof player.toggleFullscreen === 'function') player.toggleFullscreen();
      else return Promise.resolve(toolError('FULLSCREEN_UNAVAILABLE', '当前环境不支持全屏控制'));
      return Promise.resolve({ ok: true, message: '已切换全屏', authMode: 'local-player', requiresLogin: false });
    } catch (error) {
      return Promise.resolve(toolError('FULLSCREEN_FAILED', error && error.message ? error.message : '全屏切换失败'));
    }
  }

  function openVideoInterface(input) {
    var options = (input && typeof input === 'object') ? input : {};
    var target = String(options.target || options.page || '').trim().toLowerCase();
    var v = getSFV();
    try {
      if (target === 'sources' || target === 'source' || /片源/.test(target)) {
        if (v && v.onlineActions && typeof v.onlineActions.openSources === 'function') {
          v.onlineActions.openSources();
          return Promise.resolve({ ok: true, target: 'sources', message: '已打开片源管理', authMode: 'local-ui', requiresLogin: false });
        }
        if (v && v.online && typeof v.online.openSources === 'function') {
          v.online.openSources();
          return Promise.resolve({ ok: true, target: 'sources', message: '已打开片源管理', authMode: 'local-ui', requiresLogin: false });
        }
      }
      if (target === 'home' || target === 'discover' || /影视首页|汇联|发现/.test(target)) {
        if (v && v.online && typeof v.online.open === 'function') {
          v.online.open();
          return Promise.resolve({ ok: true, target: 'home', message: '已打开影视首页', authMode: 'local-ui', requiresLogin: false });
        }
      }
      if (target === 'history' || /观看历史|历史/.test(target)) {
        if (v && v.online && typeof v.online.goToNav === 'function') {
          v.online.goToNav('history');
          return Promise.resolve({ ok: true, target: 'history', message: '已打开观看历史', authMode: 'local-ui', requiresLogin: false });
        }
      }
      return Promise.resolve(toolError('INTERFACE_NOT_FOUND', '没有识别出要打开的影视界面，可试试：片源管理 / 影视首页'));
    } catch (error) {
      return Promise.resolve(toolError('INTERFACE_FAILED', error && error.message ? error.message : '打开界面失败'));
    }
  }

  function getCapabilities() {
    return {
      name: 'Stellaflix video tools',
      authMode: 'imported-cms-source',
      requiresLogin: false,
      sourcesEmptyByDefault: true,
      tools: [
        'get_video_context',
        'search_movies',
        'search_and_play_movie',
        'play_movie_candidate',
        'control_video_playback',
        'seek_video',
        'select_episode',
        'toggle_video_fullscreen',
        'open_video_interface'
      ]
    };
  }

  global.StellaflixAgentVideoTools = {
    get_video_context: getVideoContext,
    search_movies: searchMovies,
    search_and_play_movie: searchAndPlayMovie,
    play_movie_candidate: playMovieCandidate,
    control_video_playback: controlVideoPlayback,
    seek_video: seekVideo,
    select_episode: selectEpisode,
    toggle_video_fullscreen: toggleFullscreen,
    open_video_interface: openVideoInterface,
    getCapabilities: getCapabilities,
    // camelCase 别名，便于本地命令层调用
    getVideoContext: getVideoContext,
    searchMovies: searchMovies,
    searchAndPlayMovie: searchAndPlayMovie,
    playMovieCandidate: playMovieCandidate,
    controlVideoPlayback: controlVideoPlayback,
    seekVideo: seekVideo,
    selectEpisode: selectEpisode,
    toggleVideoFullscreen: toggleFullscreen,
    openVideoInterface: openVideoInterface
  };
})(typeof window !== 'undefined' ? window : this);
