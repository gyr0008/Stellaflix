/*
 * Stellaflix 影视模块 — 播放编排器 (play-orchestrator)
 *
 * 从 online.js 抽出的单集播放唯一真相源（P4 消债）：
 *   play(view, ep, play) 统一处理
 *     - 进度/历史记录（recordMeta/recordHistory，由 online.js 注入）
 *     - CMS 直链播放 / Kazumi 解析后内嵌(embed)或直链分支
 *     - 剧集导航（setPlaylist/setPlayEpisodeAt）、连播（registerNextEpisode）
 *     - 关闭浏览层露出播放器（close，由 online.js 注入）
 *
 * 设计：本模块不持有 online.js 的内部状态（overlay/stack 等），仅通过 init(deps)
 * 注入它需要的闭包（toast/recordMeta/recordHistory/resolvePic/close）；
 * 播放器/源/解析器走全局 SFV.player / SFV.source / SFV.kazumi（调用期惰性读取）。
 * online.js 的 playEpisode / registerNextEpisode 退化为薄委托，保证对外 API 不变。
 *
 * 铁律：零业务逻辑进 index.html；本模块仅提供 SFV.playOrchestrator.{init,play}。
 * 单文件 ≤ 500 行。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var deps = {};
  function init(d) { deps = d || {}; }
  // 安全取依赖：未注入时降级为空函数，避免播放链路抛错。
  function dep(name) {
    var fn = deps[name];
    return (typeof fn === 'function') ? fn : function () {};
  }

  /**
   * 下一集连播钩子（仅 play 管道使用）。
   */
  function registerNextEpisode(view, ep, play) {
    if (!SFV.player || typeof SFV.player.setPlayNext !== 'function') return;
    var list = (play && play.episodes) ? play.episodes : null;
    if (!list || !list.length) { SFV.player.setPlayNext(null); return; }
    var i = -1;
    for (var k = 0; k < list.length; k++) {
      if (list[k] === ep || (list[k] && ep && list[k].index === ep.index)) { i = k; break; }
    }
    if (i < 0 || i >= list.length - 1) { SFV.player.setPlayNext(null); return; } // 末集/未找到
    var nextEp = list[i + 1];
    if (!nextEp || !nextEp.url) { SFV.player.setPlayNext(null); return; }        // 下一集无地址
    SFV.player.setPlayNext(function () {
      dep('toast')('自动播放：' + (nextEp.name || ('第' + (nextEp.index + 1) + '集')));
      play(view, nextEp, play);
    });
  }

  /**
   * 单集播放入口（唯一真相源）。
   * @param {Object} view 影片视图（含 source.id/vodId/title/pic/year/key 等）
   * @param {Object} ep   单集（含 url/index/name）
   * @param {Object} [play] 当前线路（含 episodes 列表，用于连播/选集导航）
   * @param {Object} [opt] 阶段3 扩展：{ plays:[{from,episodes}], fromIndex } 全部线路，供播放器线路切换
   */
  function play(view, ep, play, opt) {
    if (!ep || !ep.url) { dep('toast')('该集无播放地址'); return; }
    var plays = (opt && opt.plays) ? opt.plays : (play ? [play] : null);
    var fromIndex = (opt && typeof opt.fromIndex === 'number') ? opt.fromIndex : 0;
    // 记录返回目标：此刻浏览层尚未关闭，view._origin 可判定是否来自历史页
    dep('captureReturn')(view);
    var id = view.source.id + ':' + view.vodId + ':' + ep.index;
    var title = (view.title || '影片') + ' · ' + (ep.name || ('第' + (ep.index + 1) + '集'));
    dep('recordMeta')({ key: view.key, title: view.title, pic: dep('resolvePic')(view), year: view.year, sourceId: view.source.id, vodId: view.vodId });
    dep('recordHistory')({ key: id, title: title, pic: dep('resolvePic')(view), year: view.year, sourceId: view.source.id, vodId: view.vodId });
    // 同步写入新「观看历史」页专属存储（stellaflix-watch-history-v1），使其与播放记录一致。
    // 上方 model 写保留，供旧分类历史占位向后兼容。受保护调用，避免加载序问题。
    if (SFV.watchHistory && SFV.watchHistory.add) {
      SFV.watchHistory.add({
        key: id,
        title: view.title || '影片',
        sub: (ep && ep.name) ? ep.name : '',
        img: dep('resolvePic')(view),
        progress: 0,
        cur: '00:00',
        total: '',
        ts: Date.now(),
        finished: false,
        sourceId: view.source.id,
        vodId: view.vodId,
        pic: dep('resolvePic')(view),
        watchedSec: 0
      });
    }

    // 直链播放：经 source-adapter 跨域直链走 /api/proxy；进度键锚定 站点:vod:集数
    var doPlay = function (playUrl) {
      var sourceName = (view.source && view.source.name) ? view.source.name : ((view.source && view.source.id) ? view.source.id : '');
      var coverUrl = dep('resolvePic')(view);
      var meta = { url: playUrl, title: title, id: id };
      if (SFV.source) SFV.source.open(meta);
      else if (SFV.player) SFV.player.openUrl(playUrl, meta);
      // 封面/站点名晚到：open 已同步 setCurrentMeta，这里合并（emit sfv:player-meta → 底部控制器刷新）
      if (SFV.player && SFV.player.setMeta) SFV.player.setMeta({ key: id, seriesKey: view.key, cover: coverUrl, subtitle: sourceName });
      // 剧集导航：供底部控制器 prev/next 键使用（无剧集则清空）
      if (SFV.player && SFV.player.setPlaylist) {
        if (play && play.episodes) {
          SFV.player.setPlaylist(play.episodes, ep.index);
          if (SFV.player.setPlayEpisodeAt) SFV.player.setPlayEpisodeAt(function (i, e) { play(view, e, play, { plays: plays, fromIndex: fromIndex }); });
        } else {
          SFV.player.setPlaylist(null, -1);
          if (SFV.player.setPlayEpisodeAt) SFV.player.setPlayEpisodeAt(null);
        }
      }
      // 阶段3：线路(Road)切换 + 选集(Episode)网格（多线路/多集时显示）
      if (SFV.player && SFV.player.setRoads) {
        if (plays && (plays.length > 1 || ((plays[fromIndex] || {}).episodes || []).length > 1)) {
          SFV.player.setRoads(plays, fromIndex, function (toIdx, epIdx) {
            // 线路切换：切到目标线路的同集（对齐失败已在外层对齐为 index 兜底），重新起播
            var targetPlay = plays[toIdx];
            var targetEp = (targetPlay && targetPlay.episodes && targetPlay.episodes[epIdx]) || null;
            if (!targetEp) { dep('toast')('该线路无对应集'); return; }
            play(view, targetEp, targetPlay, { plays: plays, fromIndex: toIdx });
          });
        } else {
          SFV.player.setRoads(null, -1, null);
        }
      }
      // 阶段3：通知播放器侧线路/选集 UI 渲染
      if (SFV.playerRoadEpisode && typeof SFV.playerRoadEpisode.open === 'function') {
        SFV.playerRoadEpisode.open({
          view: view, plays: plays, fromIndex: fromIndex, currentEpisodeIndex: ep.index,
          onSwitchRoad: function (toIdx, epIdx) {
            // F3：先上报 wait，再切换；依据 switchRoad 返回值落 ok/error 状态机。
            if (SFV.playerRoadEpisode && SFV.playerRoadEpisode.setStatus) SFV.playerRoadEpisode.setStatus('wait');
            var ok = SFV.player && SFV.player.switchRoad ? SFV.player.switchRoad(toIdx, epIdx) : false;
            if (SFV.playerRoadEpisode && SFV.playerRoadEpisode.setStatus) SFV.playerRoadEpisode.setStatus(ok ? 'ok' : 'error');
          },
          // F4：跨线路集名对齐失败（集数不等/顺序不一致/目标线路无同名集）→
          // 提示并保持在当前线路，杜绝 Math.min 静默错集（与 setRoads 回调 L113 语义统一）。
          onAlignFail: function (toIdx, curName) {
            dep('toast')('该线路无对应集');
          },
          onPickEpisode: function (i) {
            // F3：先上报 wait，再选集；依据 playEpisodeAt 返回值落 ok/error 状态机。
            if (SFV.playerRoadEpisode && SFV.playerRoadEpisode.setStatus) SFV.playerRoadEpisode.setStatus('wait');
            var ok = SFV.player && SFV.player.playEpisodeAt ? SFV.player.playEpisodeAt(i) : false;
            if (SFV.playerRoadEpisode && SFV.playerRoadEpisode.setStatus) SFV.playerRoadEpisode.setStatus(ok ? 'ok' : 'error');
          }
        });
      }
      registerNextEpisode(view, ep, play); // 必须在 open 之后：open 会清空 playNext 钩子
      dep('close')();                       // 关闭浏览层，露出播放器全屏弹层
    };

    // 嵌入第三方解析器页面播放：解析器自渲染播放器、客户端解密真实流地址，
    // 我们无需（也无法）提取直链，直接把整个解析器页嵌入播放器 iframe 即可。
    var openEmbed = function (embedUrl, embedTitle, embedId) {
      var sourceName = (view.source && view.source.name) ? view.source.name : ((view.source && view.source.id) ? view.source.id : '');
      if (SFV.player && typeof SFV.player.openEmbed === 'function') {
        SFV.player.openEmbed(embedUrl, { id: embedId, title: embedTitle, cover: dep('resolvePic')(view), subtitle: sourceName });
        dep('close')(); // 关闭浏览层，露出带 iframe 的播放器弹层
      } else {
        doPlay(embedUrl); // 无嵌入能力时降级为原始地址直连
      }
    };

    // 判断是否为 Kazumi 来源（view.source.id 以 'kazumi:' 开头 或 view 含 ruleName 标记）
    var isKazumi = view && (
      (view.source && view.source.id && String(view.source.id).indexOf('kazumi:') === 0) ||
      view.isKazumi || view.ruleName
    );

    if (isKazumi && SFV.kazumi && typeof SFV.kazumi.resolvePlayUrl === 'function') {
      dep('toast')('正在解析播放地址…');
      SFV.kazumi.resolvePlayUrl(ep.url, view.ruleName || '').then(function (resolved) {
        if (resolved && resolved.url) {
          if (resolved.embed) {
            // 第三方解析器页面：无法提取直链，整体嵌入 iframe 交由它自渲染播放器
            openEmbed(resolved.url, title, id);
          } else {
            doPlay(resolved.url);
          }
        } else {
          // 解析失败：降级直接用原始 URL（可能是直链或 iframe 类型）
          console.warn('[Kazumi] 播放页解析未命中，降级使用原始 URL:', ep.url);
          dep('toast')('播放页解析未命中，尝试原始地址');
          doPlay(ep.url);
        }
      }).catch(function (e) {
        console.warn('[Kazumi] 播放页解析异常:', e.message);
        dep('toast')('解析异常，尝试原始地址');
        doPlay(ep.url);
      });
    } else {
      // CMS10 / 非 Kazumi：直接播放
      doPlay(ep.url);
    }
  }

  SFV.playOrchestrator = { init: init, play: play, registerNextEpisode: registerNextEpisode };
})(typeof window !== 'undefined' ? window : this);
