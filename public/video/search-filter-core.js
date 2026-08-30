/*
 * Stellaflix 影视模块 — 搜索筛选核心模型与查询语法
 *
 * 设计演变：
 *   初始 1:1 移植自 Kazumi 2.2.6 search_parser.dart（正向「想看」筛选）。
 *   2026-08-06 起改为「纯排除」模型：筛选器只收集「不想看」的排除项，
 *   结果 = 搜索全量 − 排除项；排序作为中性重排保留。
 *
 * 设计原则：
 *   - 纯逻辑，无任何 DOM/BOM 依赖，可在浏览器与 Node 测试环境运行
 *   - 字段语义全部为「排除」（exclude*），与 UI / 客户端过滤一一对应
 *   - 排除维度无法表达为 CMS/Bangumi 的查询语法，统一在客户端做结果过滤；
 *     fromFilterState 仅序列化正向意图（keyword + sort），不发送排除 token
 *   - 不引入任何第三方库
 */
(function (global) {
  'use strict';

  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  if (SFV.SearchFilterCore) return; // 幂等

  /* ------------------------------------------------------------------
   * 默认池（供 UI 多选取用）
   * ------------------------------------------------------------------ */

  // 关键词候选池（作为「隐藏关键词（简介）」的快捷勾选，亦可自定义）
  var DEFAULT_KEYWORDS = [
    '续集', '真人化', '日常', '搞笑', '奇幻', '恋爱', '悬疑',
    '热血', '治愈', '异世界'
  ];

  // 地区池（对齐 CMS10 vod_area 常见取值）
  var DEFAULT_REGIONS = [
    '大陆', '香港', '台湾', '美国', '日本', '韩国', '英国', '法国', '泰国', '其他'
  ];

  // 视频类型池（模糊匹配 CMS type_name：电影→动作片/喜剧片…，动漫→动漫，等）
  var DEFAULT_TYPES = ['电影', '剧集', '动漫', '纪录片', '综艺'];

  // 垃圾视频类型（智能屏蔽默认项）：AI 漫剧 / 竖屏短剧 / 微短剧等
  // 这些类型 CMS10 通常不细分，但部分源会直接打 type_name，命中即隐藏。
  var DEFAULT_JUNK_TYPES = ['微短剧', '短剧', 'AI漫剧', '漫剧', '竖屏剧', '小程序剧'];

  // 垃圾视频关键词（智能屏蔽默认项）：聚焦「形态标记」+「最具辨识度的烂俗套路」，
  // 不碰正常都市/甜宠剧通用词，避免误伤。命中 title/content/remarks 任一即隐藏。
  var DEFAULT_JUNK_KEYWORDS = [
    'AI短剧', '竖屏短剧', 'AI漫剧', '重生', '逆袭', '霸总', '赘婿', '毒妃', '神豪', '龙傲天'
  ];

  /* ------------------------------------------------------------------
   * 工具
   * ------------------------------------------------------------------ */

  function formatDateTime(d) {
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // ------------------------------------------------------------------
  // 多源结果聚合（方案 B 本地归并，零 TMDB 请求）
  // 背景：CMS10 源内已按 title|year 归并（sources.dedupe），但只做
  // toLowerCase 不清洗标题；Kazumi 规则源结果完全独立成卡。导致同名
  // 但写法不同（"一人之下 第一季" / "一人之下第一季" / "…（动态漫）"）
  // 在搜索页占多张卡，且各自调 TMDB 补图 → 压力剧增。
  // 这里再做一层「清洗标题 + 年份」归并，把异构源合为一张卡。
  // ------------------------------------------------------------------

  // 多源结果聚合身份键清洗
  // 原则：
  // 1. 「源噪声」（语言/画质/源标识）只影响播放体验，不影响作品身份，应去掉。
  // 2. 「身份标记」（第X季/剧场版/OVA/SP/特别篇/番外/动态漫/动画版…）代表不同
  //    作品或不同版本，必须保留并归一化，否则会把不同季合并成一张卡。
  // ------------------------------------------------------------------

  // 源噪声：整体替换，避免误伤正常汉字。
  var SOURCE_NOISE = [
    '国语版', '国配', '国粤', '粤语', '日语版', '日语', '双语', '中英', '简体',
    '繁体', '中字', '高清', 'HD', '1080P', '1080p', '720P', '720p', '4K', '4k',
    '修复版', '未删减', '完整版', '独家', '会员', '抢先', '预告', 'PV', '合集', '全集'
  ];

  // 季数正则：第1季 / 第一季 / 第十季 等
  var SEASON_RE = /第([0-9一二三四五六七八九十百]+)季/g;
  // 身份标记：剧场版/OVA/SP/特别篇/番外/动态漫/动画版等影响作品身份的版本词
  var EDITION_RE = /(剧场版|电影版|OVA|SP|特别篇|番外|前传|后传|外传|动态漫画|动态漫|动画版|漫画版|真人版|真人电影|网络剧|网剧版|网络电影|TV版|tv版| tv版| TV版)/g;

  // 从标题提取并归一化身份标记（第X季 → Sx，其余保留小写）。
  function extractIdentityMarkers(s) {
    var markers = [];
    var map = {
      '一': '1', '二': '2', '三': '3', '四': '4', '五': '5',
      '六': '6', '七': '7', '八': '8', '九': '9', '十': '10', '百': '100'
    };
    s.replace(SEASON_RE, function (m, p1) {
      markers.push('S' + (map[p1] || p1));
      return '';
    });
    s.replace(EDITION_RE, function (m) {
      markers.push(m.toLowerCase().replace(/\s+/g, ''));
      return '';
    });
    return markers.sort().join('+');
  }

  // 清洗标题用于聚合身份键：保留季数/版本标记，仅去掉源噪声与空白/分隔符。
  function cleanTitleForAgg(t) {
    if (!t) return '';
    var s = String(t).trim();
    // 去全角/半角空白
    s = s.replace(/[　\s]+/g, '');
    // 提取身份标记（在去除括号之前，避免括号内标记丢失）
    var markers = extractIdentityMarkers(s);
    // 去括号及括号内内容（含中文「（）」、英文「()」、方头「【】」）
    s = s.replace(/[（(][^（）()]*[)）]/g, '');
    s = s.replace(/[【][^【】]*[】]/g, '');
    // 再次去掉已提取过的身份标记本体
    s = s.replace(SEASON_RE, '');
    s = s.replace(EDITION_RE, '');
    // 去源噪声
    for (var i = 0; i < SOURCE_NOISE.length; i++) {
      s = s.split(SOURCE_NOISE[i]).join('');
    }
    // 去残留分隔符
    s = s.replace(/[·・\-—_~.。・]/g, '');
    s = s.toLowerCase();
    // 身份键 = 基础标题 [+ 标记]
    return markers ? (s + '|' + markers) : s;
  }

  // 把单个搜索结果项拆分为「统一 variant 描述」数组。
  // CMS item.variants 是 normalizeVod 对象数组；Kazumi item.variants 是
  // { key, sourceId:'kazumi:..', vodId, isKazumi, ruleName, src } 数组。
  function _variantsOf(it) {
    if (it.variants && it.variants.length) return it.variants;
    return [it]; // 兜底：自身作为单一 variant
  }

  /**
   * 按 (清洗标题, 年份) 归并异构搜索结果（CMS10 + Kazumi）。
   * @returns {Array} 聚合后的卡片列表，每张卡：
   *   { title, year, pic, typeName, area, remarks, content, playUrl,
   *     isKazumi, variants, cmsVars, kzVars, _localKey }
   *   - variants：合并后的全部来源（CMS 在前，Kazumi 在后）
   *   - isKazumi：仅当全部来源都是 Kazumi 时为 true（混合卡默认走 CMS 播放）
   */
  function aggregateByLocalKey(items) {
    var groups = {};
    var order = [];
    function ensureGroup(lk) {
      if (!groups[lk]) {
        groups[lk] = {
          localKey: lk, title: '', year: '', pic: '', typeName: '', area: '',
          remarks: '', content: '', playUrl: '', cmsVars: [], kzVars: []
        };
        order.push(lk);
      }
      return groups[lk];
    }
    (items || []).forEach(function (it) {
      if (!it || !it.title) return;
      var clean = cleanTitleForAgg(it.title);
      var year = it.year || '';
      var lk = clean + '|' + year;
      var g;
      if (year) {
        g = ensureGroup(lk);
      } else {
        // 空年份（如 Kazumi 规则源不返回年份）：并入同清洗标题的已有组
        // （优先带年份的），否则新建空年组。这样无年份的规则源也能和带
        // 年份的 CMS 结果归并成同一张卡。
        var found = null;
        var keys = Object.keys(groups);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf(clean + '|') === 0) { found = keys[i]; break; }
        }
        g = found ? groups[found] : ensureGroup(lk);
      }
      if (!g.title && it.title) g.title = it.title;
      if (!g.year && it.year) g.year = it.year;
      if (!g.pic && it.pic) g.pic = it.pic;
      if (!g.typeName && it.typeName) g.typeName = it.typeName;
      if (!g.area && it.area) g.area = it.area;
      if (!g.remarks && it.remarks) g.remarks = it.remarks;
      if (!g.content && it.content) g.content = it.content;
      if (!g.playUrl && it.playUrl) g.playUrl = it.playUrl;
      _variantsOf(it).forEach(function (v) {
        if (v && v.isKazumi) g.kzVars.push(v);
        else g.cmsVars.push(v);
      });
    });
    return order.map(function (lk) {
      var g = groups[lk];
      var variants = g.cmsVars.concat(g.kzVars);
      return {
        title: g.title, year: g.year, pic: g.pic, typeName: g.typeName,
        area: g.area, remarks: g.remarks, content: g.content, playUrl: g.playUrl,
        isKazumi: g.cmsVars.length === 0, // 仅全 Kazumi 才走规则详情
        variants: variants, cmsVars: g.cmsVars, kzVars: g.kzVars,
        _localKey: lk
      };
    });
  }

  // 双向包含匹配：a 含 b 或 b 含 a（用于 typeName / area 的柔性排除）
  function containsEither(a, b) {
    return (a && a.indexOf(b) >= 0) || (b && b.indexOf(a) >= 0);
  }

  /* ------------------------------------------------------------------
   * 播放源候选收敛（方案 C：详情页 / 浏览厅「选择播放源」弹窗专用）
   *   背景：CMS10 搜索是子串匹配（ac=videolist&wd=关键词），会返回标题里
   *   含有查询词但完全不同的影片（如搜「你的名字」带回「请以你的名字呼唤我」）。
   *   detail.js / hall.js 的 buildCandidates 原样枚举所有搜索结果，弹窗于是
   *   混入大量无关源。这里按「当前影片标题」收敛候选：
   *     1) 严格匹配（清洗后标题完全一致，归一掉「你的名字。」/「你的名字」）→ 直接用；
   *     2) 无严格匹配 → 宽松相关度排序取 Top N（长度越近、包含越强越靠前）；
   *     3) 全部无关（score 都为 0）→ 返回空，交由上层回退到详情自带源。
   *   候选对象需含 `title` 字段（即影片名，用于清洗比对）。
   * ------------------------------------------------------------------ */
  function filterCandidatesForQuery(candidates, query, opts) {
    opts = opts || {};
    var topN = (opts.topN != null) ? opts.topN : 8;
    if (!candidates || !candidates.length) return [];
    var q = (query || '').trim();
    if (!q) return candidates.slice();
    var cq = cleanTitleForAgg(q);
    if (!cq) return candidates.slice();

    // 1) 严格匹配：清洗后标题完全一致（"你的名字。" 与 "你的名字" 归一同键）
    var exact = candidates.filter(function (c) {
      var t = (c && c.title) || '';
      return cleanTitleForAgg(t) === cq;
    });
    if (exact.length) return exact;

    // 2) 无严格匹配：宽松相关度排序，取 Top N（长度越接近、包含关系越强越靠前）
    function score(c) {
      var t = (c && c.title) || '';
      var ct = cleanTitleForAgg(t);
      if (!ct) return -1;
      if (ct === cq) return 10000;                                          // 防御性全覆盖
      if (ct.indexOf(cq) === 0) return 1000 - Math.abs(ct.length - cq.length); // 标题以查询开头
      if (ct.indexOf(cq) >= 0) return 500 - Math.abs(ct.length - cq.length);   // 标题包含查询
      if (cq.indexOf(ct) === 0 && ct.length >= 2) return 200;                   // 查询包含标题
      return 0;
    }
    var ranked = candidates
      .map(function (c) { return { c: c, s: score(c) }; })
      .filter(function (x) { return x.s > 0; })
      .sort(function (a, b) { return b.s - a.s; })
      .map(function (x) { return x.c; });
    return ranked.slice(0, topN);
  }

  /* ------------------------------------------------------------------
   * 搜索结果相关性排序（搜索面板专用，对齐 Kazumi L0 身份锚定带来的干净效果）
   *   背景：CMS10 搜索为子串匹配，搜索面板把全部子串命中按清洗标题+年份
   *   归并成独立卡片后原样出网格，没有相关性排序，于是搜「你的名字」会把
   *   「请以你的名字呼唤我」等无关影片也列出来（用户痛点）。
   *   复用 cleanTitleForAgg 算分并排序：
   *     精确匹配(清洗后全等)   → 10000
   *     标题以查询开头         → 1000 - 长度差
   *     标题包含查询           → 500 - 长度差
   *     查询包含标题(≥2字)     → 200
   *     否则                   → 0（无关）
   *   收敛规则：
   *     - 存在强匹配(精确/开头)时，只保留强匹配项，剔除纯包含(不同作品)噪声；
   *       于是「你的名字」置顶、剔除非开头的「请以你的名字呼唤我」，同时保留
   *       开头匹配的「你的名字是玫瑰」与续集（视作同前缀相关）。
   *     - 无强匹配时，保留所有相关(分数>0)项并按分降序，取 Top N。
   *   与 filterCandidatesForQuery(方案 C，严格优先、可能只留精确)不同，本函数
   *   用于「发现型」搜索面板：保留前缀相关项、仅剔除明显跨作品的子串噪声。
   * ------------------------------------------------------------------ */
  function rankSearchResults(items, query, opts) {
    opts = opts || {};
    var topN = (opts.topN != null) ? opts.topN : 24;
    if (!items || !items.length) return [];
    var q = (query || '').trim();
    if (!q) return items.slice();
    var cq = cleanTitleForAgg(q);
    if (!cq) return items.slice();

    // 分类：strong = 精确匹配或标题以查询开头（同作品/同前缀，视为强相关）；
    // 其余仅按相关性分数(>0)判定是否相关。强相关的分数基准须高于 1000，
    // 否则长标题的 startsWith 相减后会跌破阈值被误判为弱匹配。
    function classify(it) {
      var t = (it && it.title) || '';
      var ct = cleanTitleForAgg(t);
      if (!ct) return { s: -1, strong: false };
      if (ct === cq) return { s: 10000, strong: true };
      if (ct.indexOf(cq) === 0) return { s: 2000 - Math.abs(ct.length - cq.length), strong: true };
      if (ct.indexOf(cq) >= 0) return { s: 1000 - Math.abs(ct.length - cq.length), strong: false };
      if (cq.indexOf(ct) === 0 && ct.length >= 2) return { s: 500, strong: false };
      return { s: 0, strong: false };
    }
    var scored = items.map(function (it) { return { it: it, c: classify(it) }; });
    var hasStrong = scored.some(function (x) { return x.c.strong; });
    var kept = hasStrong
      ? scored.filter(function (x) { return x.c.strong; })
      : scored.filter(function (x) { return x.c.s > 0; });
    kept.sort(function (a, b) { return b.c.s - a.c.s; });
    return kept.slice(0, topN).map(function (x) { return x.it; });
  }

  /* ------------------------------------------------------------------
   * SearchFilterState（纯排除模型）
   *   所有 exclude* 字段表示「要隐藏的内容」；排序为中性重排。
   * ------------------------------------------------------------------ */

  function SearchFilterState(opts) {
    opts = opts || {};
    this.id = opts.id || '';
    this.keyword = opts.keyword || '';
    this.sort = opts.sort || 'heat';
    // 排除维度
    this.excludeKeywords = opts.excludeKeywords ? opts.excludeKeywords.slice() : []; // 简介含任一关键词即隐藏
    this.excludeRegions = opts.excludeRegions ? opts.excludeRegions.slice() : [];
    this.excludeTypes = opts.excludeTypes ? opts.excludeTypes.slice() : [];
    this.excludeBeforeYear = (opts.excludeBeforeYear != null) ? opts.excludeBeforeYear : null; // 隐藏早于该年的
    this.minScore = (opts.minScore != null) ? opts.minScore : null;       // 隐藏低于该分的（TMDB 补全）
    this.excludeEpisodeAbove = (opts.excludeEpisodeAbove != null) ? opts.excludeEpisodeAbove : null; // 隐藏集数超过该值的（竖屏短剧识别，默认关）
  }

  /**
   * 返回「智能屏蔽」默认排除项（垃圾视频：AI 漫剧 / 竖屏短剧 / 微短剧等）。
   * 每次调用返回全新数组，避免外部修改污染常量。
   */
  function buildJunkDefaults() {
    return {
      excludeTypes: DEFAULT_JUNK_TYPES.slice(),
      excludeKeywords: DEFAULT_JUNK_KEYWORDS.slice()
    };
  }

  SearchFilterState.prototype.isIdSearch = function () {
    return this.id !== '';
  };

  // 是否含有「高级筛选」（任一排除维度非空，或排序非默认）
  SearchFilterState.prototype.hasAdvancedFilters = function () {
    return this.excludeKeywords.length > 0 ||
      this.excludeRegions.length > 0 ||
      this.excludeTypes.length > 0 ||
      this.excludeBeforeYear != null ||
      this.minScore != null ||
      this.excludeEpisodeAbove != null ||
      this.sort !== 'heat';
  };

  SearchFilterState.prototype.copyWith = function (o) {
    o = o || {};
    return new SearchFilterState({
      id: o.id !== undefined ? o.id : this.id,
      keyword: o.keyword !== undefined ? o.keyword : this.keyword,
      sort: o.sort !== undefined ? o.sort : this.sort,
      excludeKeywords: o.excludeKeywords !== undefined ? o.excludeKeywords : this.excludeKeywords,
      excludeRegions: o.excludeRegions !== undefined ? o.excludeRegions : this.excludeRegions,
      excludeTypes: o.excludeTypes !== undefined ? o.excludeTypes : this.excludeTypes,
      excludeBeforeYear: o.excludeBeforeYear !== undefined ? o.excludeBeforeYear : this.excludeBeforeYear,
      minScore: o.minScore !== undefined ? o.minScore : this.minScore,
      excludeEpisodeAbove: o.excludeEpisodeAbove !== undefined ? o.excludeEpisodeAbove : this.excludeEpisodeAbove
    });
  };

  /* ------------------------------------------------------------------
   * SearchParser（仅序列化正向意图 keyword + sort）
   *   排除维度无法表达为 CMS/Bangumi 查询语法，统一走客户端过滤，
   *   因此 fromFilterState 不产出任何 exclude token。
   * ------------------------------------------------------------------ */

  var FIELD_NAMES = 'id|tag|sort|season|date|rank|score|weekday|nsfw';

  var SRC = {
    sort: 'sort:([\\w\\-]+)',
    token: '(?:^|\\s)?(?:' + FIELD_NAMES + '):[^\\s]*?(?=(?:\\s|$)|(?:' + FIELD_NAMES + '):)'
  };
  function rx(key, flags) {
    return new RegExp(SRC[key], flags || 'i');
  }

  function SearchParser(query) {
    this.query = query || '';
  }

  SearchParser.prototype.parseSort = function () {
    var m = rx('sort').exec(this.query);
    return m ? m[1].toLowerCase() : null;
  };

  SearchParser.prototype.parseKeywords = function () {
    // 对齐 Kazumi 的 replaceAll(_tokenRegExp(), ' ')，必须全局替换
    var s = this.query.replace(rx('token', 'gi'), ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  };

  SearchParser.prototype.toFilterState = function () {
    return new SearchFilterState({
      keyword: this.parseKeywords(),
      sort: this.parseSort() || 'heat'
    });
  };

  SearchParser.fromFilterState = function (state) {
    var tokens = [];
    var kw = (state.keyword || '').trim();
    if (kw) tokens.push(kw);

    // 正向意图：仅排序 hint 可透传；排除维度一律走客户端过滤
    if (state.sort && state.sort !== 'heat') {
      tokens.push('sort:' + state.sort);
    }
    // 注意：排除维度（exclude*）不进入 DSL —— CMS/Bangumi 不支持排除语义

    return tokens.join(' ').trim();
  };

  /* ------------------------------------------------------------------
   * 辅助标签
   * ------------------------------------------------------------------ */

  function sortLabel(sort) {
    switch (sort) {
      case 'match': return '匹配';
      default: return '热度';
    }
  }

  // 类型池 → 中文展示（供 chips/UI 复用）
  function typeLabel(t) { return t; }

  /* ------------------------------------------------------------------
   * 导出
   * ------------------------------------------------------------------ */

  SFV.SearchFilterCore = {
    DEFAULT_KEYWORDS: DEFAULT_KEYWORDS,
    DEFAULT_REGIONS: DEFAULT_REGIONS,
    DEFAULT_TYPES: DEFAULT_TYPES,
    DEFAULT_JUNK_TYPES: DEFAULT_JUNK_TYPES,
    DEFAULT_JUNK_KEYWORDS: DEFAULT_JUNK_KEYWORDS,
    buildJunkDefaults: buildJunkDefaults,
    SearchFilterState: SearchFilterState,
    SearchParser: SearchParser,
    formatDateTime: formatDateTime,
    containsEither: containsEither,
    sortLabel: sortLabel,
    typeLabel: typeLabel,
    cleanTitleForAgg: cleanTitleForAgg,
    aggregateByLocalKey: aggregateByLocalKey,
    extractIdentityMarkers: extractIdentityMarkers,
    filterCandidatesForQuery: filterCandidatesForQuery,
    rankSearchResults: rankSearchResults
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SFV.SearchFilterCore;
  }

})(typeof window !== 'undefined' ? window : this);
