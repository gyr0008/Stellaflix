/*
 * Stellaflix 影视模块 — 搜索筛选核心模型与查询语法
 *
 * 设计演变：
 *   初始 1:1 移植自 Kazumi 2.2.6 search_parser.dart（正向「想看」筛选）。
 *   2026-08-06 起改为「纯排除」模型：筛选器只收集「不想看」的排除项，
 *   结果 = 搜索全量 − 排除项；排序作为中性重排保留。
 *   2026-09 起：季/版身份识别加宽（第X季/部/期、S2、末尾数字、完结季…），
 *   空年份只并入 identity 完全相同的组，避免丢季。
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
  // 2. 「身份标记」（第X季/剧场版/OVA/SP/完结季/最终季…）代表不同
  //    作品或不同版本，必须保留并归一化，否则会把不同季合并成一张卡。
  // ------------------------------------------------------------------

  // 源噪声：整体替换，避免误伤正常汉字。
  var SOURCE_NOISE = [
    '国语版', '国配', '国粤', '粤语', '日语版', '日语', '双语', '中英', '简体',
    '繁体', '中字', '高清', 'HD', '1080P', '1080p', '720P', '720p', '4K', '4k',
    '修复版', '未删减', '完整版', '独家', '会员', '抢先', '预告', 'PV', '合集', '全集'
  ];

  // 季数正则：第1季 / 第一季 / 第十一季 / 第2部 / 第3期
  var SEASON_RE = /第([0-9一二三四五六七八九十百]+)(季|部|期)/g;
  // S2 / s01（禁止吞掉 PS2 这类字母粘连）
  var SEASON_S_RE = /(?<![A-Za-z0-9])[Ss](\d{1,2})(?![0-9])/g;
  // 标题末尾数字季：一念永恒2 / 阿凡达2（要求前面是汉字，避免纯数字片名「2012」）
  var SEASON_TAIL_NUM_RE = /([一-鿿])([2-9]|[1-9][0-9])$/;
  // 罗马数字季：一念永恒Ⅱ
  var ROMAN_MAP = { 'Ⅱ': '2', 'Ⅲ': '3', 'Ⅳ': '4', 'Ⅴ': '5', 'Ⅵ': '6', 'Ⅶ': '7', 'Ⅷ': '8', 'Ⅸ': '9', 'Ⅹ': '10' };
  var SEASON_TAIL_ROMAN_RE = /([一-鿿A-Za-z])([ⅡⅢⅣⅤⅥⅦⅧⅨⅩ])$/;
  // 身份标记：剧场版/OVA/SP/完结季/最终季等影响作品身份的版本词
  var EDITION_RE = /(剧场版|电影版|OVA|SP|特别篇|番外|前传|后传|外传|完结季|完结篇|最终季|终季|动态漫画|动态漫|动画版|漫画版|真人版|真人电影|网络剧|网剧版|网络电影|TV版|tv版)/g;

  // 中文数字 → 阿拉伯数字（支持 1–99 与「百」）
  function parseCnOrDigit(n) {
    if (n == null || n === '') return '';
    var raw = String(n);
    if (/^\d+$/.test(raw)) return String(parseInt(raw, 10));
    var digits = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (raw === '十') return '10';
    if (raw === '百') return '100';
    if (raw.length === 1 && digits[raw] != null) return String(digits[raw]);
    if (raw.indexOf('十') >= 0) {
      var parts = raw.split('十');
      var tens = (parts[0] === '' || parts[0] == null) ? 1 : digits[parts[0]];
      var ones = (parts[1] === '' || parts[1] == null) ? 0 : digits[parts[1]];
      if (tens != null && ones != null) return String(tens * 10 + ones);
    }
    return raw;
  }

  // 从标题提取并归一化身份标记（第X季/S2/末尾数字/完结季 → sN 或小写版名词）。
  function extractIdentityMarkers(s) {
    if (!s) return '';
    var markers = [];
    var text = String(s).replace(/[　\s]+/g, '');
    text.replace(SEASON_RE, function (m, p1) {
      markers.push('s' + parseCnOrDigit(p1));
      return '';
    });
    text.replace(SEASON_S_RE, function (m, p1) {
      markers.push('s' + String(parseInt(p1, 10)));
      return '';
    });
    var tailNum = SEASON_TAIL_NUM_RE.exec(text);
    if (tailNum) markers.push('s' + tailNum[2]);
    var tailRoman = SEASON_TAIL_ROMAN_RE.exec(text);
    if (tailRoman && ROMAN_MAP[tailRoman[2]]) markers.push('s' + ROMAN_MAP[tailRoman[2]]);
    text.replace(EDITION_RE, function (m) {
      markers.push(m.toLowerCase().replace(/\s+/g, ''));
      return '';
    });
    var seen = {};
    var uniq = [];
    for (var i = 0; i < markers.length; i++) {
      if (!seen[markers[i]]) { seen[markers[i]] = 1; uniq.push(markers[i]); }
    }
    return uniq.sort().join('+');
  }

  // 清洗标题用于聚合身份键：保留季数/版本标记，仅去掉源噪声与空白/分隔符。
  function cleanTitleForAgg(t) {
    if (!t) return '';
    var s = String(t).trim();
    s = s.replace(/[　\s]+/g, '');
    var markers = extractIdentityMarkers(s);
    s = s.replace(/[（(][^（）()]*[)）]/g, '');
    s = s.replace(/[【][^【】]*[】]/g, '');
    s = s.replace(SEASON_RE, '');
    s = s.replace(SEASON_S_RE, '');
    s = s.replace(SEASON_TAIL_NUM_RE, '$1');
    s = s.replace(SEASON_TAIL_ROMAN_RE, '$1');
    s = s.replace(EDITION_RE, '');
    for (var i = 0; i < SOURCE_NOISE.length; i++) {
      s = s.split(SOURCE_NOISE[i]).join('');
    }
    s = s.replace(/[·・\-—_~.。・]/g, '');
    s = s.toLowerCase();
    return markers ? (s + '|' + markers) : s;
  }

  // 聚合键格式：identity|year；identity 本身可含 |markers
  function identityOfKey(lk) {
    if (!lk) return '';
    var i = String(lk).lastIndexOf('|');
    return i >= 0 ? lk.slice(0, i) : String(lk);
  }

  function baseOfIdentity(identity) {
    if (!identity) return '';
    var i = String(identity).indexOf('|');
    return i >= 0 ? identity.slice(0, i) : String(identity);
  }

  // 把单个搜索结果项拆分为「统一 variant 描述」数组。
  // CMS item.variants 是 normalizeVod 对象数组；Kazumi item.variants 是
  // { key, sourceId:'kazumi:..', vodId, isKazumi, ruleName, src } 数组。
  function _variantsOf(it) {
    if (it.variants && it.variants.length) return it.variants;
    return [it]; // 兜底：自身作为单一 variant
  }

  /**
   * 按 (清洗标题 identity, 年份) 归并异构搜索结果（CMS10 + Kazumi）。
   * 空年份只并入 identity 完全相同的组，禁止前缀误吞不同季。
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
      var year = String(it.year || '').trim();
      var g = null;
      if (year && groups[clean + '|' + year]) {
        g = groups[clean + '|' + year];
      }
      if (!g) {
        if (year) {
          var emptySame = null;
          for (var j = 0; j < order.length; j++) {
            var ek = order[j];
            if (identityOfKey(ek) === clean && groups[ek] && !groups[ek].year) {
              emptySame = ek;
              break;
            }
          }
          g = emptySame ? groups[emptySame] : ensureGroup(clean + '|' + year);
        } else {
          var found = null;
          var foundWithYear = null;
          for (var i = 0; i < order.length; i++) {
            var k = order[i];
            if (identityOfKey(k) !== clean) continue;
            if (!found) found = k;
            if (groups[k] && groups[k].year) { foundWithYear = k; break; }
          }
          var targetKey = foundWithYear || found;
          g = targetKey ? groups[targetKey] : ensureGroup(clean + '|');
        }
      }
      g.identity = clean;
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
        isKazumi: g.cmsVars.length === 0,
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
      if (ct === cq) return 10000;
      if (ct.indexOf(cq) === 0) return 1000 - Math.abs(ct.length - cq.length);
      if (ct.indexOf(cq) >= 0) return 500 - Math.abs(ct.length - cq.length);
      if (cq.indexOf(ct) === 0 && ct.length >= 2) return 200;
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
   *     - 存在强匹配(精确/开头)时，只保留强匹配项 + 同 base 的其它季/版；
   *       剔除纯包含(不同作品)噪声。
   *     - 无强匹配时，保留所有相关(分数>0)项并按分降序，取 Top N。
   * ------------------------------------------------------------------ */
  function rankSearchResults(items, query, opts) {
    opts = opts || {};
    var topN = (opts.topN != null) ? opts.topN : 24;
    if (!items || !items.length) return [];
    var q = (query || '').trim();
    if (!q) return items.slice();
    var cq = cleanTitleForAgg(q);
    if (!cq) return items.slice();

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
    var cqBase = baseOfIdentity(cq);
    var kept = hasStrong
      ? scored.filter(function (x) {
          if (x.c.strong) return true;
          // 同一 base 的其它季/版（完结季等）：即使未进 strong 也保留
          var ct = cleanTitleForAgg((x.it && x.it.title) || '');
          return !!ct && baseOfIdentity(ct) === cqBase && ct !== cqBase;
        })
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
   *   排除维度无法表达为 CMS/Bangumi 的查询语法，统一走客户端过滤，
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

  /** markers 字符串 → 人类可读季/版标签（s2→第2季，完结季→完结季） */
  function labelIdentityMarkers(markers) {
    if (!markers) return '';
    return String(markers).split('+').map(function (m) {
      if (!m) return '';
      var s = /^s(\d+)$/i.exec(m);
      if (s) return '第' + s[1] + '季';
      return m;
    }).filter(Boolean).join(' · ');
  }

  /**
   * 从一次搜索的身份卡列表中取出「同 base 的其它季/版」（不含当前 title）。
   */
  function filterSeasonSiblings(cards, currentTitle) {
    var out = [];
    if (!cards || !cards.length) return out;
    var qBase = baseOfIdentity(cleanTitleForAgg(currentTitle || ''));
    if (!qBase) return out;
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!c || !c.title) continue;
      if (String(c.title) === String(currentTitle || '')) continue;
      if (baseOfIdentity(cleanTitleForAgg(c.title)) === qBase) out.push(c);
    }
    return out;
  }

  /**
   * 从 raw 命中里捞出「同 base 的季/版，但未进入已有身份卡」的条目。
   * 场景：CMS 列表页与多源弹窗子串命中不一致，或 rank/过滤后漏卡。
   * 返回可直接追加到网格的聚合卡数组（可能为空）。
   */
  function collectSeasonFamilyHits(rawItems, existingCards, query, opts) {
    opts = opts || {};
    var limit = (opts.limit != null) ? opts.limit : 6;
    if (!rawItems || !rawItems.length) return [];
    var q = String(query || '').trim();
    if (!q) return [];
    var cq = cleanTitleForAgg(q);
    var qBase = baseOfIdentity(cq);
    if (!qBase) return [];

    var seenIdentity = {};
    (existingCards || []).forEach(function (c) {
      var idn = cleanTitleForAgg((c && c.title) || '');
      if (idn) seenIdentity[idn] = 1;
      if (c && c._localKey) seenIdentity[identityOfKey(c._localKey)] = 1;
    });

    var leftovers = [];
    (rawItems || []).forEach(function (it) {
      if (!it || !it.title) return;
      var idn = cleanTitleForAgg(it.title);
      if (!idn) return;
      var base = baseOfIdentity(idn);
      // 仅同 base（查询 base 或以查询为前缀的季族）
      if (base !== qBase && base.indexOf(qBase) !== 0) return;
      // 已有同 identity 卡 → 跳过
      if (seenIdentity[idn]) return;
      // 无标记的纯本体若已有卡则上面已跳过；此处保留「有季/版标记」的漏网命中
      leftovers.push(it);
      seenIdentity[idn] = 1;
    });
    if (!leftovers.length) return [];
    return aggregateByLocalKey(leftovers).slice(0, limit);
  }

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
    identityOfKey: identityOfKey,
    baseOfIdentity: baseOfIdentity,
    parseCnOrDigit: parseCnOrDigit,
    labelIdentityMarkers: labelIdentityMarkers,
    collectSeasonFamilyHits: collectSeasonFamilyHits,
    filterSeasonSiblings: filterSeasonSiblings,
    filterCandidatesForQuery: filterCandidatesForQuery,
    rankSearchResults: rankSearchResults
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SFV.SearchFilterCore;
  }

})(typeof window !== 'undefined' ? window : this);
