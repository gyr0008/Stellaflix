/*
 * Stellaflix 影视模块 — 详情页 跨源播放搜索/选源子系统 (拆债 #3)
 *
 * 从 detail.js 抽出的「播放按钮 → 跨源搜同片 → 候选选源/解析 → 单集直播/多集选集」
 * 逻辑块（VIDEO_MODULE_PLAN §六.6 单文件 <=500 行约束）。
 * 仅依赖 SFV.detail（el/esc/toast 经 facade 复用）、detail-core 纯数据层(D)，
 * 以及运行期 SFV.kazumi / SFV.sources / SFV.online / SFV.sourcePicker / SFV.model。
 *
 * 契约：本文件须在 detail.js 之后加载（SFV.detail.el/toast 已就绪）；
 * detail.js 的播放按钮点击委托 SFV.detailSource.searchAndPick。幂等守卫保证重复加载跳过。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.detailSource) return; // 幂等守卫

  var D = SFV.detail; // detail-core 纯数据层（isKazumiView/buildCandidates…）
  var doc = (typeof document !== 'undefined') ? document : null;
  // 复用 detail.js 的 DOM 助手（须在 detail.js 之后加载）
  var el = (SFV.detail && SFV.detail.el) || function (tag, cls, text) {
    var n = doc.createElement(tag || 'div');
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  var toast = (SFV.detail && SFV.detail.toast) || function () {};

  // F2：重入守卫令牌。每次 searchAndPick 自增；仍在进行中的上一轮源搜索回调
  // 若 token 不匹配则整段丢弃，避免把上一部影片的候选/状态点/回退写入「重开后的面板」
  // （对齐 Kazumi AsyncSessionOwner/AsyncSession 的 isStale/isActive 失效机制）。
  var searchToken = 0;
  // 模块级运行态：searchAndPick 当轮搜索的源单元/视图/候选池，供 B2 的
  // retrySource / searchSourceWithKeyword 复用（按 sourceKey 重查单源）。
  var runState = null;
  // B1：按 sourceKey 缓存最近一次 captcha 上下文（searchURL/antiConfig/keyword/ruleName），
  // 供「进行验证」webview 弹窗取用与「已验证，重试」前读回分区 cookie 注入重查。
  var captchaCtxByKey = {};

  /**
   * 加载可播放的剧集列表（plays）。
   *   - Kazumi：经桥接层 getChapters 解析规则源
   *   - CMS10：经 sources.detail 取 vod_play_url 后 parsePlayUrl
   * 返回 Promise<{plays:Array}>，plays 形如 [{from, episodes:[{name,url,index}]}]。
   */
  function loadPlays(view) {
    return new Promise(function (resolve, reject) {
      if (!view) { reject(new Error('缺少影片信息')); return; }
      if (D.isKazumiView(view)) {
        if (!SFV.kazumi || typeof SFV.kazumi.getChapters !== 'function') {
          reject(new Error('Kazumi 模块未加载')); return;
        }
        SFV.kazumi.getChapters(view.ruleName, view.src).then(function (res) {
          resolve({ plays: (res && res.plays) || [] });
        }).catch(reject);
      } else if (view.source && view.vodId != null) {
        if (!SFV.sources || typeof SFV.sources.detail !== 'function') {
          reject(new Error('片源模块未加载')); return;
        }
        SFV.sources.detail(view.source, view.vodId).then(function (res) {
          resolve({ plays: (res && res.plays) || [] });
        }).catch(reject);
      } else {
        reject(new Error('该影片暂无关联片源'));
      }
    });
  }

  /**
   * 在 sections 区域渲染选集网格（多集时）。
   * 2026-08-18 已禁用：用户要求详情页不再显示选集区域，多集源直接播放第一集。
   */
  function renderEpisodeSection(sections, view, play) {
    return;
    // 保留原实现供未来恢复：
    // if (!sections || !play || !play.episodes || !play.episodes.length) return;
    // var existing = sections.querySelector('.sfv-plex-episode-section');
    // if (existing) existing.parentNode.removeChild(existing);
    // var sec = el('div', 'sfv-plex-episode-section');
    // sec.appendChild(el('div', 'sfv-plex-section', '选集 · ' + (play.from || '默认线路')));
    // var grid = el('div', 'sfv-plex-episodes');
    // play.episodes.forEach(function (ep) {
    //   var btn = el('button', 'sfv-plex-episode');
    //   btn.type = 'button';
    //   btn.textContent = ep.name || ('第' + (ep.index + 1) + '集');
    //   btn.addEventListener('click', function () { doPlayEpisode(view, ep, play); });
    //   grid.appendChild(btn);
    // });
    // sec.appendChild(grid);
    // sections.insertBefore(sec, sections.firstChild);
    // if (sections.scrollIntoView) {
    //   setTimeout(function () { sections.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 30);
    // }
  }

  /**
   * 调用统一的单集播放入口。
   */
  function doPlayEpisode(view, ep, play) {
    if (!SFV.online || typeof SFV.online.playEpisode !== 'function') {
      toast('播放模块未就绪'); return;
    }
    SFV.online.playEpisode(view, ep, play);
  }

  /**
   * 播放按钮点击：跨源搜同片 -> 多源弹窗 / 直播 / 回退自带源。
   */
  function onPlayClick(view, sections) {
    searchAndPick(view, sections);
  }

  /**
   * 跨源搜同片（阶段2 流式填充）：
   * 先开空弹窗（所有源 Tab 显示「等待」灰点）→ 逐源并发搜 → 每源完成即刷新
   * 状态点（成功/无结果/错误）与增量填充该源命中卡片。对齐 Kazumi SourceSheet
   * 「先弹窗后流式填充」时序，避免「全部搜完才弹」的长时间等待。
   *
   * 候选拼装 / 解析流程对齐 hall.js openPoster / playCandidate（已验证路径）。
   */
  function searchAndPick(view, sections) {
    if (!SFV.online || typeof SFV.online.playEpisode !== 'function') {
      toast('播放模块未就绪'); return;
    }
    if (!view) { toast('缺少影片信息'); return; }
    var title = (view.title || '').trim();
    if (!title) { toast('该影片缺少标题，无法搜索播放源'); return; }

    // F2：开启新一轮搜索，使任何仍在途的上一轮回调失效（陈旧回调会整段丢弃）。
    searchToken++;
    var myToken = searchToken;

    // 1) 枚举源单元（CMS 启用源 + Kazumi 启用规则），每个单元对应一个 Tab/隔离键。
    var units = collectSourceUnits();
    if (!units.length) {
      toast('未配置任何播放源，先去「视觉控制台 → 片源/规则」导入'); return;
    }

    // 2) 先开空弹窗：所有源 Tab 等态灰点 + 源内「搜索中」占位（对齐 Kazumi 先弹后填）。
    var candidates = [];   // 扁平候选池（含 sourceKey）
    var idxByKey = {};      // sourceKey -> 该源已写入扁平池的候选 [{i,c}]（增量用）
    units.forEach(function (u) { idxByKey[u.key] = []; });

    var preGroups = units.map(function (u) {
      // 透传 ref（含 ruleName/id）供验证码弹窗按 sourceKey 取规则名（B1）。
      return { sourceKey: u.key, sourceName: u.sourceName, ref: u.ref };
    });

    // 模块级运行态：供 retrySource / searchSourceWithKeyword 按 sourceKey 重查单源（B2）。
    captchaCtxByKey = {}; // 清旧态，避免上一轮 captcha 上下文污染本轮
    runState = {
      units: units, view: view, sections: sections, title: title,
      candidates: candidates, idxByKey: idxByKey,
      pendingTotal: units.length, settledCount: 0, everHasResult: false
    };

    if (SFV.sourcePicker && SFV.sourcePicker.open) {
      SFV.sourcePicker.open({
        title: title, poster: view.pic,
        candidates: candidates,
        groups: preGroups,   // 阶段2 流式：显式预建源 Tab（每个单元一 Tab）
        onPick: function (c) { playCandidate(c, view, sections); }
      });
    }

    // 3) 逐源并发搜，完成即增量填充。
    units.forEach(function (u) {
      queryOneUnit(u, title, myToken, false);
    });
  }

  /**
   * 单源搜索 + 增量填充（searchAndPick 与 B2 重查共用，单一真相源）。
   * @param {Object} u       源单元 { kind, key, sourceName, ref }
   * @param {string} kw      搜索关键词（初始=影片标题；重查=别名/自定义词）
   * @param {number} token   本轮搜索令牌（F2 陈旧丢弃）
   * @param {boolean} isRetry 是否重查（重查不触发全局 settled/fallback 计数）
   */
  function queryOneUnit(u, kw, token, isRetry) {
    if (!runState) return;
    var rs = runState;
    var p;
    if (u.kind === 'cms') {
      p = (SFV.sources && SFV.sources.search)
        ? SFV.sources.search(kw, { sources: [u.ref], timeout: 12000 })
            .then(function (res) { return { items: (res && res.items) || [], errors: (res && res.errors) || [] }; })
        : Promise.resolve({ items: [], errors: [] });
    } else {
      p = (SFV.kazumi && SFV.kazumi.searchRule)
        ? SFV.kazumi.searchRule(u.ref.name, kw).then(function (res) {
            // B1：保留 captcha/antiConfig/searchURL 顶层字段——searchRule 在 captcha 态下
            // 把它们放在顶层（非 errors[] 内），原 .then 曾把它们整体丢弃导致 captchaCtx 无法填充。
            return {
              items: (res && res.items) || [],
              errors: (res && res.errors) || [],
              captcha: res ? res.captcha : undefined,
              antiConfig: res ? res.antiConfig : undefined,
              searchURL: res ? res.searchURL : undefined
            };
          })
        : Promise.resolve({ items: [], errors: [] });
    }
    p.then(function (res) {
      if (token !== searchToken) return; // F2：陈旧回调整段丢弃，不写入当前面板
      // B1：桥接层已把 CaptchaRequiredException 透传为 res.errors[].captcha，
      // 命中即点亮 captcha 蓝点（对齐 Kazumi captcha 态），不走 ok/none。
      var capErr = (res && res.errors || []).filter(function (e) { return e && e.captcha; })[0];
      if (capErr) {
        if (SFV.sourcePicker && SFV.sourcePicker.setStatus) {
          SFV.sourcePicker.setStatus(u.key, 'captcha');
        }
        if (SFV.sourcePicker && SFV.sourcePicker.setSourceWaiting) {
          SFV.sourcePicker.setSourceWaiting(u.key, false);
        }
        // 缓存 captcha 上下文（searchURL/antiConfig/keyword/ruleName），供 webview 弹窗与重查 cookie 注入。
        captchaCtxByKey[u.key] = {
          sourceKey: u.key,
          keyword: kw,
          searchURL: res.searchURL || null,
          antiConfig: res.antiConfig || null,
          ruleName: u.ref.name,
          sourceName: u.sourceName
        };
        return;
      }
      // 桥接层透传的普通错误（searchRule 已改为 resolve 而非 reject，异常名得以保留）→ error 态。
      if (res && res.errors && res.errors.length) {
        if (SFV.sourcePicker && SFV.sourcePicker.setStatus) {
          SFV.sourcePicker.setStatus(u.key, 'error');
        }
        if (SFV.sourcePicker && SFV.sourcePicker.setSourceWaiting) {
          SFV.sourcePicker.setSourceWaiting(u.key, false);
        }
        return;
      }
      var items = (res && res.items) || [];
      // 归一化为带 sourceKey 的扁平候选（对齐 buildCandidates 单源形态）
      var srcCands = normalizeUnitItems(u, items, rs.view);
      srcCands.forEach(function (c) {
        var i = rs.candidates.length;
        rs.candidates.push(c);
        rs.idxByKey[u.key].push({ i: i, c: c });
      });
      if (rs.idxByKey[u.key].length) rs.everHasResult = true;
      // 增量填充该源卡片 + 状态点
      if (SFV.sourcePicker && SFV.sourcePicker.appendSource) {
        SFV.sourcePicker.appendSource(u.key, rs.idxByKey[u.key]);
      }
      if (SFV.sourcePicker && SFV.sourcePicker.setSourceWaiting) {
        SFV.sourcePicker.setSourceWaiting(u.key, false);
      }
    }).catch(function (e) {
      if (token !== searchToken) return; // F2：陈旧回调整段丢弃
      // 单源失败 → 状态点红（error），不阻断其他源
      if (SFV.sourcePicker && SFV.sourcePicker.setStatus) {
        SFV.sourcePicker.setStatus(u.key, 'error');
      }
      if (SFV.sourcePicker && SFV.sourcePicker.setSourceWaiting) {
        SFV.sourcePicker.setSourceWaiting(u.key, false);
      }
      console.warn('[detail-source] 源搜索失败 ' + u.key + ':', e && e.message);
    }).then(function () {
      if (token !== searchToken) return; // F2：陈旧回调整段丢弃，不触发回退
      if (isRetry) return;               // 重查不计入全局 fallback 判定
      rs.settledCount++;
      // 全部源结束后仍未命中任何 → 回退自带源（对齐旧逻辑）
      if (rs.settledCount >= rs.pendingTotal && !rs.everHasResult) {
        fallbackOwnSource(rs.view, rs.sections);
      }
    });
  }

  /**
   * B2 + B1：按 sourceKey 重查单源（错误态「重试」/验证码态「重试」共用）。
   * 新令牌使任何在途旧回调失效；成功则刷新该源卡片与状态点，失败则点 error/captcha。
   * 若该源此刻处于 captcha 态，重查前经 IPC 从 webview 专用分区读回验证码 cookie 注入
   * kazumi-bridge-captcha 的 store，使重查请求带上已验证 cookie（对齐 Kazumi 验证码闭环）。
   */
  async function retrySource(sourceKey) {
    if (!runState) return;
    var u = runState.units.filter(function (x) { return x.key === sourceKey; })[0];
    if (!u) return;
    // B1：仅当存在 captcha 上下文时才注入 cookie（避免错误态重查误带 cookie）。
    var ctx = captchaCtxByKey[sourceKey];
    if (ctx && ctx.searchURL && SFV.kazumiBridgeCaptcha &&
        typeof SFV.kazumiBridgeCaptcha.getCaptchaCookiesViaIPC === 'function') {
      try {
        var cookie = await SFV.kazumiBridgeCaptcha.getCaptchaCookiesViaIPC(ctx.searchURL);
        if (cookie) SFV.kazumiBridgeCaptcha.setCaptchaCookies(ctx.ruleName || u.ref.name, cookie);
      } catch (e) {
        console.warn('[detail-source] 读 captcha cookie 失败，按无 cookie 重查:', e && e.message);
      }
    }
    searchToken++;
    queryOneUnit(u, runState.title, searchToken, true);
  }

  /**
   * B1：供验证码弹窗(source-picker-captcha.showCaptchaDialog)/测试读取某源的 captcha 上下文
   * （searchURL/antiConfig/keyword/ruleName/sourceName）。retrySource 也据此判断是否注入 cookie。
   */
  function getCaptchaCtx(sourceKey) {
    return captchaCtxByKey[sourceKey] || null;
  }

  /**
   * B2：按 sourceKey 用自定义关键词重查单源（「别名检索」/「手动检索」共用）。
   * 空关键词直接忽略，避免无效重查。
   */
  function searchSourceWithKeyword(sourceKey, keyword) {
    if (!runState) return;
    var u = runState.units.filter(function (x) { return x.key === sourceKey; })[0];
    if (!u) return;
    var kw = String(keyword == null ? '' : keyword).trim();
    if (!kw) return;
    searchToken++;
    queryOneUnit(u, kw, searchToken, true);
  }

  /**
   * 枚举参与搜索的源单元（CMS 启用源 + Kazumi 启用规则）。
   * 每个单元带稳定隔离键 sourceKey（cms:<id> / kazumi:<ruleName>）。
   */
  function collectSourceUnits() {
    var units = [];
    var cmsList = (SFV.sources && SFV.sources.getEnabledSources) ? SFV.sources.getEnabledSources() : [];
    cmsList.forEach(function (s) {
      units.push({ kind: 'cms', key: 'cms:' + s.id, sourceName: s.name, ref: s });
    });
    var kzRules = (SFV.kazumi && SFV.kazumi.getEnabledSearchRules) ? SFV.kazumi.getEnabledSearchRules() : [];
    kzRules.forEach(function (r) {
      units.push({ kind: 'kazumi', key: 'kazumi:' + r.name, sourceName: r.name, ref: r });
    });
    return units;
  }

  /**
   * 把单源搜索到的 items 归一化为带 sourceKey 的扁平候选（形态对齐 buildCandidates 单源结果）。
   * 复用 SFV.detail.classifyCandidateEmbed 判定 isEmbed。
   */
  function normalizeUnitItems(u, items, view) {
    var out = [];
    (items || []).forEach(function (it) {
      if (u.kind === 'cms') {
        var v = (it && it.variants && it.variants.length) ? it.variants[0] : it;
        if (!v) return;
        var c = {
          id: 'cms:' + (v.sourceId || '') + ':' + (v.vodId || ''),
          label: (v.sourceName || v.sourceId || 'CMS') + (v.remarks ? ' · ' + v.remarks : ''),
          sub: (it.title || '') + (it.year ? ' (' + it.year + ')' : ''),
          title: it.title || '',
          kind: 'cms', group: (v.sourceName || v.sourceId || 'CMS'),
          isEmbed: D.classifyCandidateEmbed({ kind: 'cms', _ref: v }), _ref: v,
          sourceKey: u.key
        };
        out.push(c);
      } else {
        var c2 = {
          id: 'kz:' + (it.ruleName || '') + ':' + (it.src || ''),
          label: (it.ruleName || 'Kazumi'),
          sub: it.title || (view && view.title) || '',
          title: it.title || (view && view.title) || '',
          kind: 'kazumi', ruleName: it.ruleName || '', group: (it.ruleName || 'Kazumi'),
          isEmbed: D.classifyCandidateEmbed({ kind: 'kazumi', ruleName: it.ruleName, _ref: it }), _ref: it,
          sourceKey: u.key
        };
        out.push(c2);
      }
    });
    return out;
  }

  /**
   * 候选 → 解析剧集 → 单集直播 / 多集渲染选集区（对齐 hall.js playCandidate）。
   */
  function playCandidate(c, view, sections) {
    if (!c) return;
    if (c.kind === 'kazumi') {
      var ref = c._ref;
      toast('正在解析 Kazumi 源…');
      if (!SFV.kazumi || !SFV.kazumi.getChapters) { toast('Kazumi 不可用'); return; }
      SFV.kazumi.getChapters(ref.ruleName, ref.src).then(function (res) {
        var plays = (res && res.plays) || [];
        var chosen = plays[0];
        var episodes = (chosen && chosen.episodes) || [];
        if (!episodes.length) { toast('该源无可播放剧集'); return; }
        var v2 = {
          key: 'kazumi:' + (ref.ruleName || '') + ':' + (ref.src || ''),
          title: (view && view.title) || ref.title || c.label,
          pic: (view && view.pic) || ref.pic || '',
          year: (view && view.year) || '',
          source: { id: 'kazumi:' + (ref.ruleName || ''), name: ref.ruleName || 'Kazumi' },
          vodId: ref.src, isKazumi: true, ruleName: ref.ruleName
        };
        // 阶段3：多线路全部传入编排器（播放器侧线路切换），不再只在详情页禁用选集
        if (episodes.length === 1 && plays.length === 1) doPlayEpisode(v2, episodes[0], plays[0]);
        else SFV.online.playEpisode(v2, episodes[0], plays[0], { plays: plays, fromIndex: 0 });
      }).catch(function (e) { toast('Kazumi 解析失败：' + (e && e.message ? e.message : '')); });
    } else {
      var v = c._ref;
      toast('正在获取播放地址…');
      if (!SFV.sources || !SFV.sources.detail) { toast('CMS 不可用'); return; }
      SFV.sources.detail(v.sourceId, v.vodId).then(function (res) {
        if (!res || !res.ok || !res.plays || !res.plays.length) { toast('该源无播放地址'); return; }
        var v2 = {
          key: (v.sourceId || '?') + ':' + (v.vodId || ''),
          title: (view && view.title) || v.title || c.label,
          pic: (view && view.pic) || v.pic || '',
          year: (view && view.year) || v.year || '',
          source: { id: v.sourceId, name: v.sourceName }, vodId: v.vodId
        };
        var play0 = res.plays[0];
        // 阶段3：多线路全部传入编排器（播放器侧线路切换）
        if (play0.episodes.length === 1 && res.plays.length === 1) doPlayEpisode(v2, play0.episodes[0], play0);
        else SFV.online.playEpisode(v2, play0.episodes[0], play0, { plays: res.plays, fromIndex: 0 });
      }).catch(function (e) { toast('获取播放地址失败：' + (e && e.message ? e.message : '')); });
    }
  }

  /**
   * 0 候选回退：尝试详情自带源（CMS vodId / Kazumi rule），否则提示未找到。
   */
  function fallbackOwnSource(view, sections) {
    var title = (view && view.title) || '';
    if (D.isKazumiView(view) || (view && view.source && view.vodId != null)) {
      loadPlays(view).then(function (res) {
        var plays = (res && res.plays) || [];
        view._plays = plays;
        if (!plays.length || !plays[0] || !plays[0].episodes || !plays[0].episodes.length) {
          toast('未找到「' + title + '」的可用播放源'); return;
        }
        var play = plays[0];
        // 阶段3：多线路全部传入编排器（播放器侧线路切换）
        if (play.episodes.length === 1 && plays.length === 1) doPlayEpisode(view, play.episodes[0], play);
        else SFV.online.playEpisode(view, play.episodes[0], play, { plays: plays, fromIndex: 0 });
      }).catch(function () {
        toast('未找到「' + title + '」的可用播放源');
      });
    } else {
      toast('未找到「' + title + '」的可用播放源');
    }
  }

  SFV.detailSource = {
    searchAndPick: searchAndPick,
    retrySource: retrySource,
    searchSourceWithKeyword: searchSourceWithKeyword,
    getCaptchaCtx: getCaptchaCtx,
    loadPlays: loadPlays,
    renderEpisodeSection: renderEpisodeSection,
    doPlayEpisode: doPlayEpisode,
    playCandidate: playCandidate,
    fallbackOwnSource: fallbackOwnSource,
    onPlayClick: onPlayClick
  };
})(typeof window !== 'undefined' ? window : this);
