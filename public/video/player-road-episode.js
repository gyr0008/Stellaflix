/*
 * Stellaflix 影视模块 — 播放器侧 线路(Road)/选集(Episode) 切换 (阶段3)
 *
 * 对齐 Kazumi 视频页两屏模型：多源面板只做「选源→选命中→跳视频页」，
 * 线路(Road=play.from)与选集(Episode=play.episodes)的切换下沉到**播放器**。
 *
 * 责任：
 *   - Road：渲染全部线路下拉（数据来自编排器注入的 plays），点击切换线路，
 *     切换时用 detail-core.alignEpisodeByIdentifier 按「当前集名」跨线路对齐续播（P7 复用），
 *     集数不等/顺序不一致返回 null 时提示不静默错集。
 *   - Episode：渲染当前线路的选集网格，点击经 SFV.player.playEpisodeAt 或编排器续播。
 *   - 仅在 plays.length>1 或 episodes.length>1 时显示对应控件（单源单集不污染界面）。
 *
 * 铁律：零业务逻辑进 index.html；本模块仅提供 SFV.playerRoadEpisode.{open,close,setData}。
 * 挂载目标 = #sfv-overlay（video 之上、#sfv-controls 之下），嵌入态(#bottom-bar 被隐藏)不依赖，
 * 独立悬浮层，规避 player.css 对 #bottom-bar 的隐藏副作用（见 player.js:openEmbed）。
 * 单文件 ≤ 500 行。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  if (SFV.playerRoadEpisode) return; // 幂等守卫

  var root = null;     // 悬浮层根 DOM
  var roadWrap = null; // 线路下拉容器
  var epWrap = null;   // 选集网格容器
  var data = null;     // { view, plays, fromIndex, onSwitchRoad, onPickEpisode }
  var doc = (typeof document !== 'undefined') ? document : null;

  function d() { return global.document; }

  function ensureRoot() {
    if (root) return root;
    var overlay = d() && d().getElementById && d().getElementById('sfv-overlay');
    if (!overlay) return null;
    root = d().createElement('div');
    root.className = 'sfv-road-ep';
    root.setAttribute('aria-label', '线路与选集');
    roadWrap = d().createElement('div');
    roadWrap.className = 'sfv-road-ep-road';
    epWrap = d().createElement('div');
    epWrap.className = 'sfv-road-ep-list';
    root.appendChild(roadWrap);
    root.appendChild(epWrap);
    overlay.appendChild(root);
    return root;
  }

  function clear() {
    if (roadWrap) roadWrap.innerHTML = '';
    if (epWrap) epWrap.innerHTML = '';
  }

  function close() {
    clear();
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null; roadWrap = null; epWrap = null; data = null;
  }

  /*
   * 注入数据并渲染（由编排器在 doPlay 时调用）。
   * @param {Object} opt
   *   view         影片视图（续播用）
   *   plays        [{from, episodes:[{name,url,index}]}] 全部线路
   *   fromIndex    当前线路下标
   *   onSwitchRoad(fromIndex, alignedEpisodeIndex) 线路切换回调（编排器续播用）
   *   onPickEpisode(episodeIndex)                   选集点击回调
   */
  function open(opt) {
    // 2026-08-19：顶部多源面板已移除，仅保留右侧「选集」面板
    close();
    return;
    /*
    opt = opt || {};
    data = opt;
    var plays = opt.plays || [];
    var eps = (plays[opt.fromIndex || 0] && plays[opt.fromIndex || 0].episodes) || [];
    if (plays.length <= 1 && eps.length <= 1) { close(); return; } // 单源单集无需控件

    ensureRoot();
    if (!root) return;
    clear();

    // ---- 线路下拉（仅多线路时）----
    if (plays.length > 1) {
      var sel = d().createElement('select');
      sel.className = 'sfv-road-ep-select';
      plays.forEach(function (p, i) {
        var o = d().createElement('option');
        o.value = String(i);
        o.textContent = (p.from || ('线路 ' + (i + 1))) + ' (' + ((p.episodes || []).length) + ' 集)';
        if (i === (opt.fromIndex || 0)) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        var to = parseInt(sel.value, 10);
        if (isNaN(to) || !data) return;
        var curIdx = data.currentEpisodeIndex != null ? data.currentEpisodeIndex : 0;
        var curName = currentEpisodeName();
        // 跨线路按集名对齐（P7）：对齐成功→切换；对齐失败（集数不等/顺序不一致/
        // 目标线路无同名集）→ 回调 onAlignFail 提示并保持在当前线路，绝不静默跳集（F4）。
        var decision = decideRoadSwitch(plays, to, curName, curIdx);
        if (decision.ok) {
          if (typeof data.onSwitchRoad === 'function') data.onSwitchRoad(to, decision.episodeIndex);
        } else {
          if (typeof data.onAlignFail === 'function') data.onAlignFail(to, curName);
          // 保持当前线路：把下拉复位到当前线路，避免 UI 显示与实际播放线路不一致
          sel.value = String(data.fromIndex || 0);
        }
      });
      var rl = d().createElement('span');
      rl.className = 'sfv-road-ep-label';
      rl.textContent = '线路';
      roadWrap.appendChild(rl);
      roadWrap.appendChild(sel);
      roadWrap.style.display = '';
    } else if (roadWrap) {
      roadWrap.style.display = 'none';
    }

    // ---- 选集网格（仅多集时）----
    if (eps.length > 1) {
      eps.forEach(function (ep, i) {
        var b = d().createElement('button');
        b.type = 'button';
        b.className = 'sfv-road-ep-chip' + (i === (opt.currentEpisodeIndex || 0) ? ' is-current' : '');
        b.textContent = ep.name || ('第' + (i + 1) + '集');
        b.addEventListener('click', function () {
          if (typeof data.onPickEpisode === 'function') data.onPickEpisode(i);
        });
        epWrap.appendChild(b);
      });
      epWrap.style.display = '';
    } else if (epWrap) {
      epWrap.style.display = 'none';
    }

    root.style.display = '';
    */
  }

  function currentEpisodeName() {
    if (!data) return null;
    var eps = (data.plays[data.fromIndex || 0] && data.plays[data.fromIndex || 0].episodes) || [];
    var i = data.currentEpisodeIndex || 0;
    return (eps[i] && eps[i].name) || null;
  }

  /**
   * 线路切换决策（F4 修复：杜绝静默错集）。
   * 复用 detail-core.alignEpisodeByIdentifier 做跨线路集名对齐；
   *   对齐成功 → { ok:true, episodeIndex }
   *   对齐失败（集数不等/顺序不一致/目标线路无同名集/缺对齐模块）→ { ok:false }
   * 上层据此决定切换或提示，绝不再用 Math.min 静默跳到错误集。
   * @returns {{ok:boolean, episodeIndex?:number}}
   */
  function decideRoadSwitch(plays, to, curName, curIdx) {
    var aligned = (SFV.detail && SFV.detail.alignEpisodeByIdentifier)
      ? SFV.detail.alignEpisodeByIdentifier(plays, to, curName, curIdx)
      : null;
    if (aligned) return { ok: true, episodeIndex: aligned.episodeIndex };
    return { ok: false };
  }

  // 播放器切换集时同步高亮当前集
  function setCurrentEpisode(i) {
    if (!data) return;
    data.currentEpisodeIndex = i;
    if (!epWrap) return;
    var chips = epWrap.children || [];
    for (var k = 0; k < chips.length; k++) {
      chips[k].classList.toggle('is-current', k === i);
    }
  }

  /**
   * 设置浮动层的操作状态（F3：播放器侧切换状态机，对齐 Kazumi 错误状态机）。
   * 合法值：'wait'（切换中）/ 'ok'（成功）/ 'error'（失败）。
   * 其它值（含空/undefined）→ 清除状态属性，回到中性。
   * 渲染为 root 的 data-road-ep-state 属性，供 CSS 反馈用户。
   */
  function setStatus(state) {
    if (!root) return;
    if (state !== 'wait' && state !== 'ok' && state !== 'error') {
      root.removeAttribute('data-road-ep-state');
      return;
    }
    root.setAttribute('data-road-ep-state', state);
  }

  SFV.playerRoadEpisode = {
    open: open, close: close, setCurrentEpisode: setCurrentEpisode, setStatus: setStatus,
    _test: { currentEpisodeName: currentEpisodeName, decideRoadSwitch: decideRoadSwitch }
  };
})(typeof window !== 'undefined' ? window : this);
