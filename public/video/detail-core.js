/*
 * Stellaflix 影视详情页 — 候选/embed 分类 + logo 挑选 纯数据层 (T134 拆分)
 *
 * 从 detail.js 抽出的零 DOM 依赖逻辑：
 *   - isKazumiView       判断 view 是否来自 Kazumi 规则源
 *   - pickBestLogo       从 TMDB logos 数组按语言优先级挑最佳
 *   - classifyCandidateEmbed  候选级 embed / 直链分类（P3）
 *   - buildCandidates    跨源搜同片候选拼装（严格复用 hall.js 字段映射）
 *
 * 本文件先于 detail.js 加载，通过 SFV.detail 暴露基础 facade，
 * detail.js 在其上叠加 build / enrich / 播放接线（DOM 层）。
 * kazumi-bridge.js / online.js 调用的 classifyCandidateEmbed / buildCandidates
 * 即来自此层。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  if (SFV.detail) return; // 幂等守卫：detail.js 也会定义 SFV.detail

  /**
   * 判断当前 view 是否来自 Kazumi 规则源。
   */
  function isKazumiView(view) {
    return !!(view && (view.ruleName || view.isKazumi ||
      (view.source && view.source.id && String(view.source.id).indexOf('kazumi:') === 0)));
  }

  /**
   * 从 TMDB logos 数组中挑选最佳 logo
   * 排序规则：
   *   1) 语言优先级：zh 系列(0) > en(1) > null(无语言, 2) > 其他(3)
   *   2) 同语种按 vote_average 降序
   * 接收空数组/null → 返回 null（让调用方走文字回退）
   */
  function pickBestLogo(logos) {
    if (!logos || !logos.length) return null;
    function rank(iso) {
      if (!iso) return 2;
      var s = String(iso).toLowerCase();
      if (s === 'zh' || s.indexOf('zh-') === 0) return 0;   // zh / zh-CN / zh-TW / zh-HK
      if (s === 'en') return 1;
      return 3;
    }
    var sorted = logos.slice().sort(function (a, b) {
      var ra = rank(a.iso_639_1), rb = rank(b.iso_639_1);
      if (ra !== rb) return ra - rb;
      return (b.vote_average || 0) - (a.vote_average || 0);
    });
    return sorted[0];
  }

  /**
   * 候选级 embed / 直链分类（P3）。
   * - CMS 候选：始终经 source-adapter 直链播放 → isEmbed=false。
   * - Kazumi 候选：依据规则解析模式判断——XPath/parser/web 规则产出解析器页需 iframe 内嵌 → true；
   *   API/CMS10 规则直出媒体 → false。规则模式经 SFV.kazumi.getRuleMode 获取，
   *   缺模块/未知规则安全降级为 false（播放时 resolvePlayUrl 仍会最终校正）。
   * @param {{kind:string, ruleName?:string, _ref?:Object}} c
   * @returns {boolean}
   */
  function classifyCandidateEmbed(c) {
    if (!c) return false;
    if (c.kind === 'cms') return false;
    if (c.kind === 'kazumi') {
      var rn = c.ruleName || (c._ref && c._ref.ruleName) || '';
      var mode = (SFV.kazumi && typeof SFV.kazumi.getRuleMode === 'function')
        ? SFV.kazumi.getRuleMode(rn) : null;
      return mode === 'xpath' || mode === 'parser' || mode === 'web';
    }
    return false;
  }

  /**
   * 计算候选的稳定来源键（修复审查 P1：来源身份 = 可变字符串 → 改用不变 ID）。
   * - CMS 候选：绑定源的持久 id（source.id，localStorage 持久化，由 genId() 生成）。
   * - Kazumi 候选：绑定规则名 ruleName（规则文件内唯一，更新规则会改 ruleName 视为不同源）。
   * 该键贯穿「隔离 / 面板 Tab / 状态 / 结果去重」，与展示名解耦，避免同名/大小写差异破坏隔离。
   * @param {{kind:string, _ref?:Object, ruleName?:string}} c
   * @returns {string}
   */
  function sourceKeyOf(c) {
    if (!c) return '';
    if (c.kind === 'cms') {
      var sid = (c._ref && c._ref.sourceId) || '';
      return 'cms:' + sid;
    }
    if (c.kind === 'kazumi') {
      var rn = c.ruleName || (c._ref && c._ref.ruleName) || '';
      return 'kazumi:' + rn;
    }
    return '';
  }

  /**
   * 跨线路剧集对齐（修复审查 P7：Kazumi 原 _resolveOnlineEpisode 仅按位置索引，
   * 两线路集数不等/顺序不一致会越界崩溃或静默播错集）。
   * 策略：优先用「集标识(episode.name)」在目标线路精确匹配同一集；
   *   未命中（含两线路集数不等/顺序不一致）→ 返回 null，由上层提示「该线路无此集」，
   *   绝不静默播错集或越界崩溃。仅在无标识的兜底场景按 index 取值并做越界保护。
   *
   * @param {Array<{from:string, episodes:Array<{name:string,url:string,index:number}>}>} plays
   * @param {number} targetFromIndex  目标线路索引
   * @param {string} [identifier]     当前播放集的标识名（优先按名匹配）
   * @param {number} [currentIndex]   当前集在当前线路的 index（仅无标识时兜底）
   * @returns {{from:string, episode:Object, fromIndex:number, episodeIndex:number, matched:boolean}|null}
   */
  function alignEpisodeByIdentifier(plays, targetFromIndex, identifier, currentIndex) {
    if (!plays || !plays.length) return null;
    if (!(targetFromIndex >= 0 && targetFromIndex < plays.length)) return null;
    var target = plays[targetFromIndex];
    var eps = (target && target.episodes) || [];
    if (!eps.length) return null;

    if (identifier != null && String(identifier).trim() !== '') {
      var key = String(identifier).trim().toLowerCase();
      for (var i = 0; i < eps.length; i++) {
        if (String(eps[i].name || '').trim().toLowerCase() === key) {
          return { from: target.from, episode: eps[i], fromIndex: targetFromIndex,
                   episodeIndex: i, matched: true };
        }
      }
      // 名称未命中：两线路集数/顺序不一致，返回 null 由上层提示，避免静默错集
      return null;
    }

    // 无标识（极少见）：按 index 兜底，越界返回 null 防止崩溃
    var idx = (typeof currentIndex === 'number' && currentIndex >= 0) ? currentIndex : 0;
    if (idx >= eps.length) return null;
    return { from: target.from, episode: eps[idx], fromIndex: targetFromIndex,
             episodeIndex: idx, matched: false };
  }

  /**
   * 拼装候选列表（严格复用 hall.js openPoster 字段映射）。
   * 每个候选注入稳定 sourceKey（P1 隔离键，见 sourceKeyOf）。
   * @param {Array} arr = [cmsRes, kzRes]
   */
  function buildCandidates(arr, view) {
    var cms = (arr && arr[0]) || { items: [] };
    var kz = (arr && arr[1]) || { items: [] };
    var candidates = [];
    (cms.items || []).forEach(function (it) {
      var variants = (it.variants && it.variants.length) ? it.variants : [it];
      variants.forEach(function (v) {
        var cand = {
          id: 'cms:' + (v.sourceId || '') + ':' + (v.vodId || ''),
          label: (v.sourceName || v.sourceId || 'CMS') + (v.remarks ? ' · ' + v.remarks : ''),
          sub: it.title + (it.year ? ' (' + it.year + ')' : ''),
          title: it.title || '',
          kind: 'cms', group: (v.sourceName || v.sourceId || 'CMS'),
          isEmbed: classifyCandidateEmbed({ kind: 'cms', _ref: v }), _ref: v
        };
        cand.sourceKey = sourceKeyOf(cand);
        candidates.push(cand);
      });
    });
    (kz.items || []).forEach(function (it) {
      var cand = {
        id: 'kz:' + (it.ruleName || '') + ':' + (it.src || ''),
        label: (it.ruleName || 'Kazumi'),
        sub: it.title || (view && view.title) || '',
        title: it.title || (view && view.title) || '',
        kind: 'kazumi', ruleName: it.ruleName || '', group: (it.ruleName || 'Kazumi'),
        isEmbed: classifyCandidateEmbed({ kind: 'kazumi', ruleName: it.ruleName, _ref: it }), _ref: it
      };
      cand.sourceKey = sourceKeyOf(cand);
      candidates.push(cand);
    });
    // 收敛到与所点影片真正相关的候选（先严格匹配，无果再宽松 Top N），
    // 避免弹窗混入子串命中但无关的源。
    if (SFV.SearchFilterCore && SFV.SearchFilterCore.filterCandidatesForQuery && view) {
      candidates = SFV.SearchFilterCore.filterCandidatesForQuery(candidates, view.title, { topN: 8 });
    }
    return candidates;
  }

  // 基础 facade：仅含纯数据层；DOM 层（build 等）由 detail.js 叠加。
  // 注意：若 detail.js 先于本文件加载（异常顺序），幂等守卫已 return，
  // SFV.detail 将只剩 DOM 层，此时 classifyCandidateEmbed/buildCandidates 缺失。
  // 正常运行保证 detail-core.js 先于 detail.js（index.html 顺序约束）。
  SFV.detail = {
    isKazumiView: isKazumiView,
    pickBestLogo: pickBestLogo,
    classifyCandidateEmbed: classifyCandidateEmbed,
    buildCandidates: buildCandidates,
    sourceKeyOf: sourceKeyOf,
    alignEpisodeByIdentifier: alignEpisodeByIdentifier
  };
})(typeof window !== 'undefined' ? window : this);
