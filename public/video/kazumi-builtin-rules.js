/**
 * 内置 Kazumi 规则清单（随 Stellaflix 分发，走本地打包进 app.asar）
 *
 * 设计原则（2026-10-01 重建版，吸收 2026-10-01 首次内置被整体回滚的教训）：
 *  1. **内置的前提是「源真的能用」**。本清单第一条 netflixgc 已实测：
 *     搜索 110 条 / 7 线路 9~10 集 / 抽样 14 部 14/14 拿到真实 m3u8 直链（HTTP 206）。
 *     旧教训：骚火（SA）当时唯一条目不可用 → 整段回滚。故本文件由
 *     tests/kazumi-builtin-rules.test.js 守着，禁止塞入未实测的条目。
 *     2026-10-01 追加 555dy 系三镜像（555k31 / 5k12 / 5k20）：三站 /api.php/provide/vod
 *     四个采集动作全部返 5 字节「域名未授权」→ 无 CMS10 格式，只走本规则通道；
 *     实测搜索 119 条 / 12 线路 × 12 集 / 端到端抽样 12/12 真 m3u8（详见 test 注释）。
 *  2. **字段必须来自真实采集**，不得照抄模板。netflixgc 所有 xpath 均从线上真实 DOM 现采。
 *  3. **可移除**：面板「移除」写 dismissed 集合，之后不再自动注册，用户不会被反复塞回。
 *  4. 本文件必须放在 public/video/kazumi/ **之外**（该目录是只读红线，禁止改动）。
 *
 * 加载架构约束（index-loader.js）：所有 modulePaths 被拼进同一个 try 块同步执行，
 * 块内的 async function 不泄漏到全局。因此本文件一律用 IIFE + 显式挂载，
 * 不得使用顶层 async function 声明，也不得依赖 var 泄漏。
 */
(function (global) {
  'use strict';

  if (!global) { return; }
  var SFV = global.StellaflixVideo;
  if (!SFV) { global.StellaflixVideo = SFV = {}; }

  var NS = 'kazumi-builtin';
  var DISMISS_KEY = 'stellaflix-video-kazumi-builtin-dismissed';

  /**
   * 内置规则清单。
   * baseURL / searchURL / searchList / searchName / searchResult / chapterRoads / chapterResult
   * 全部来自 netflixgc.org 线上真实 DOM 实采，并通过
   * tests/kazumi-builtin-rules.test.js 的 Schema.validate() 与绝对 URL 断言。
   */
  var BUILTIN_RULES = [
    {
      api: '4',
      type: 'video',
      name: '奈飞工厂 NetflixGC',
      version: '1.0',
      baseURL: 'https://netflixgc.org/',
      searchURL: 'https://netflixgc.org/index.php?m=vod-search&wd=@keyword',
      searchList: "//div[contains(@class,'public-list-box')]",
      searchName: "//a[contains(@class,'time-title')]",
      searchResult: "//a[contains(@class,'public-list-exp')]",
      chapterRoads: "//ul[contains(@class,'anthology-list-play')]",
      chapterResult: "//li/a",
      searchMode: 'xpath',
      chapterMode: 'xpath',
      muliSources: true,
      useWebview: true,
      useNativePlayer: true
    },
    // ---- 555dy 系三镜像（2026-10-01 追加）------------------------------------
    // 定性：三站 /api.php/provide/vod 对 ac=list&wd / ac=list&id / ac=detail /
    // ac=search 四个动作全部返 200 + text/html + 5 字节「域名未授权」，
    // 即站点后台关闭了 CMS10 采集口 → 无 CMS10 片源通道，只能走 Kazumi 规则通道 B。
    // 三镜像同源（搜索页 md5 一致），故 searchList/searchName/searchResult /
    // chapterRoads/chapterResult 五条 xpath 完全相同，差异只在 baseURL / searchURL。
    // 实测：搜索 119 条真实 /voddetail/ 条目（0 条专题/文章，链接唯一）；
    // 详情页 12 线路 × 12 集 = 144 集全绝对化；端到端抽样 12/12 嗅到真 m3u8 直链。
    // 播放块是明文 + 斜杠转义（"url":"https:\/\/v.fengbao10.com\/...\/index.m3u8"，
    // 分集名可能写成 JS 转义 \u7b2c08\u96c6），由 kazumi-bridge-core.js 的
    // maccms-play-plain 策略（排在 iframe-src 之前）还原 —— 见该策略的顺序契约。
    // 规则源文件（离线导入用）：outputs/video-source-import/stellaflix-kazumi-rules-555dy.json
    {
      api: '4',
      type: 'video',
      name: '555dy系 · 555k31',
      version: '1.0',
      baseURL: 'https://www.555k31.com/',
      searchURL: 'https://www.555k31.com/index.php?m=vod-search&wd=@keyword',
      searchList: "//div[contains(@class,'module-items')][contains(@class,'module-poster-items-base')]//a[contains(@class,'module-poster-item')]",
      searchName: "//div[contains(@class,'module-poster-item-title')]",
      searchResult: 'self::a',
      chapterRoads: "//div[contains(@class,'module-play-list-content')]",
      chapterResult: "//a[contains(@class,'module-play-list-link')]",
      searchMode: 'xpath',
      chapterMode: 'xpath',
      muliSources: true,
      useWebview: true,
      useNativePlayer: true
    },
    {
      api: '4',
      type: 'video',
      name: '555dy系 · 5k12',
      version: '1.0',
      baseURL: 'https://5k12.top/',
      searchURL: 'https://5k12.top/index.php?m=vod-search&wd=@keyword',
      searchList: "//div[contains(@class,'module-items')][contains(@class,'module-poster-items-base')]//a[contains(@class,'module-poster-item')]",
      searchName: "//div[contains(@class,'module-poster-item-title')]",
      searchResult: 'self::a',
      chapterRoads: "//div[contains(@class,'module-play-list-content')]",
      chapterResult: "//a[contains(@class,'module-play-list-link')]",
      searchMode: 'xpath',
      chapterMode: 'xpath',
      muliSources: true,
      useWebview: true,
      useNativePlayer: true
    },
    {
      api: '4',
      type: 'video',
      name: '555dy系 · 5k20',
      version: '1.0',
      baseURL: 'https://www.5k20.top/',
      searchURL: 'https://www.5k20.top/index.php?m=vod-search&wd=@keyword',
      searchList: "//div[contains(@class,'module-items')][contains(@class,'module-poster-items-base')]//a[contains(@class,'module-poster-item')]",
      searchName: "//div[contains(@class,'module-poster-item-title')]",
      searchResult: 'self::a',
      chapterRoads: "//div[contains(@class,'module-play-list-content')]",
      chapterResult: "//a[contains(@class,'module-play-list-link')]",
      searchMode: 'xpath',
      chapterMode: 'xpath',
      muliSources: true,
      useWebview: true,
      useNativePlayer: true
    }
  ];

  // ------------------------------------------------------------------ dismissed（用户显式移除的不再注册）

  var memoryDismissed = {};

  function readDismissed() {
    try {
      var ls = global.localStorage;
      if (!ls) { return memoryDismissed; }
      var raw = ls.getItem(DISMISS_KEY);
      if (!raw) { return {}; }
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
      return memoryDismissed;
    }
  }

  function writeDismissed(map) {
    memoryDismissed = map;
    try {
      var ls = global.localStorage;
      if (!ls) { return; }
      ls.setItem(DISMISS_KEY, JSON.stringify(map));
    } catch (e) { /* 隐私模式 / 沙箱无 localStorage：内存态即可 */ }
  }

  function isDismissed(name) {
    return !!readDismissed()[String(name).toLowerCase()];
  }

  function dismiss(name) {
    var map = readDismissed();
    map[String(name).toLowerCase()] = true;
    writeDismissed(map);
  }

  // ------------------------------------------------------------------ 注册 / 查询

  function bridge() {
    return (SFV && SFV.kazumi) ? SFV.kazumi : null;
  }

  function isInstalled(name) {
    var kz = bridge();
    if (!kz || !kz.listRules) { return false; }
    try {
      var rules = kz.listRules() || [];
      for (var i = 0; i < rules.length; i++) {
        if (String(rules[i].name || '').toLowerCase() === String(name).toLowerCase()) { return true; }
      }
    } catch (e) { /* 忽略：按未安装处理 */ }
    return false;
  }

  /** 幂等注册一条内置规则到规则管理器（localStorage `kazumi-rules`）。 */
  function installOne(rule) {
    if (!rule || !rule.name) { return false; }
    if (isDismissed(rule.name)) { return false; }
    var kz = bridge();
    if (!kz || !kz.importRule) { return false; }
    try {
      kz.importRule(rule);
      return true;
    } catch (e) {
      console.warn('[' + NS + '] 内置规则[' + rule.name + ']注册失败:', e && e.message ? e.message : e);
      return false;
    }
  }

  /** 面板「安装」按钮走这里：幂等 + 失败抛出（由调用方提示）。 */
  function installByName(name) {
    for (var i = 0; i < BUILTIN_RULES.length; i++) {
      if (String(BUILTIN_RULES[i].name).toLowerCase() === String(name).toLowerCase()) {
        var ok = installOne(BUILTIN_RULES[i]);
        if (!ok) { throw new Error('内置规则未就绪（可能已移除或桥接层未加载）'); }
        return true;
      }
    }
    throw new Error('未找到内置规则: ' + name);
  }

  /** 启动时自动注册全部未 dismissed 的内置规则（开箱可用，无需手动导入）。 */
  function installAll() {
    var added = [];
    for (var i = 0; i < BUILTIN_RULES.length; i++) {
      var r = BUILTIN_RULES[i];
      if (isDismissed(r.name)) { continue; }
      if (isInstalled(r.name)) { continue; }
      if (installOne(r)) { added.push(r.name); }
    }
    if (added.length) {
      console.info('[' + NS + '] 已注册内置规则: ' + added.join('、'));
    }
    return added;
  }

  // ------------------------------------------------------------------ 暴露

  SFV.builtinRules = BUILTIN_RULES;
  SFV.getBuiltinRules = function () { return BUILTIN_RULES.slice(); };
  SFV.getBuiltinRule = function (name) {
    for (var i = 0; i < BUILTIN_RULES.length; i++) {
      if (String(BUILTIN_RULES[i].name).toLowerCase() === String(name).toLowerCase()) { return BUILTIN_RULES[i]; }
    }
    return null;
  };
  SFV.isBuiltinInstalled = isInstalled;
  SFV.isBuiltinDismissed = isDismissed;
  SFV.dismissBuiltinRule = dismiss;
  SFV.installBuiltinRule = installByName;
  SFV.installBuiltinRules = installAll;

  // 自动注册。桥接层若尚未加载（脚本顺序异常），静默跳过 —— 面板里仍可点「安装」兜底。
  try {
    installAll();
  } catch (e) {
    console.warn('[' + NS + '] 自动注册失败（可忽略，面板可手动安装）:', e && e.message ? e.message : e);
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
