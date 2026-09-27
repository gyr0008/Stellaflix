/*
 * Stellaflix 影视模块 — 片单数据引擎 (Step 5 片单功能)
 *
 * 数据策略（2026-09-19 收敛：删除 C 玩法用户片单夹）：
 *   - B 主干：TMDB 动态查询（discover / collection / list / trending / upcoming）
 *   - A 补充：硬编码编辑精选（static-list，TMDB 无法用查询表达的策展片单）
 *
 * 对外 API（SFV.collections）：
 *   getByTab(tabId)                  → 该 tab 下的片单列表（含封面/计数占位）
 *   getItems(collDef)                → 该片单的影片列表（normalizeList 格式，喂 renderGrid）
 *
 * 合规：本文件零硬编码视频源；仅元数据（海报/简介）来自 TMDB，符合 §0.3。
 * 双态隔离：本模块不感知音乐态，仅由影视态页面调用。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // ---------------------------------------------------------------- 预置片单目录（2026-09-26 官方映射批：全量替换）
  // tab 归属即浮层 OVERLAY_TABS 的 4 类；每周新番走 BANGUMI 卡（online.openCalendar），不在本目录
  // 所有 collectionId / listId 均经 themoviedb.org 站内检索与 /list/{id} 页面逐一核实（禁臆测 ID）
  // type:
  //   'tmdb-trending'   → trending(mediaType, timeWindow)
  //   'tmdb-popular'    → popular(mediaType)   —— CATALOG 暂无条目，能力保留（海报墙 adapter 直调 tmdb.popular）
  //   'tmdb-upcoming'   → upcoming()
  //   'tmdb-collection' → getCollection(collectionId)          —— TMDB 官方合集
  //   'tmdb-list'       → getListAll(listId)                   —— 社区名榜（TMDB 无官方榜单体系，副标题标创建者）
  //   'tmdb-discover'   → discoverAll(query)   —— 逐页拉全（2026-09-26 用户指令：片单不限条数；无 discoverAll 时回退单页）
  //   'static-list'     → A 补充：tmdbIds 数组，逐条 getDetails 补全
  //   'placeholder'     → 即将上线占位
  var CATALOG = [
    // ===== 推荐 (featured) =====
    { id: 'trending-week', title: '本周热门', sub: '全球观众正在看',
      type: 'tmdb-trending', mediaType: 'movie', timeWindow: 'week', tab: 'featured', warm: '#e74c3c' },
    { id: 'trending-tv-week', title: '本周热播剧', sub: '追剧不踩雷',
      type: 'tmdb-trending', mediaType: 'tv', timeWindow: 'week', tab: 'featured', warm: '#3498db' },
    { id: 'upcoming', title: '即将上映', sub: '值得期待的新片',
      type: 'tmdb-upcoming', tab: 'featured', warm: '#1abc9c' },

    // ===== 系列 (series) —— 26 个已核实 TMDB 官方合集（DC 209=站内 404 不存在，移入榜单社区榜 8005）+ 4 个影人合集 =====
    { id: 'coll-mcu', title: '漫威电影宇宙', sub: '从钢铁侠到终局之战',
      type: 'tmdb-collection', collectionId: 86311, tab: 'series', warm: '#c0392b' },
    { id: 'coll-starwars', title: '星球大战系列', sub: '天行者传奇',
      type: 'tmdb-collection', collectionId: 10, tab: 'series', warm: '#f39c12' },
    { id: 'coll-harrypotter', title: '哈利·波特全集', sub: '霍格沃茨魔法世界',
      type: 'tmdb-collection', collectionId: 1241, tab: 'series', warm: '#1abc9c' },
    { id: 'coll-jurassic', title: '侏罗纪公园系列', sub: '恐龙复活冒险',
      type: 'tmdb-collection', collectionId: 328, tab: 'series', warm: '#27ae60' },
    { id: 'coll-fastfurious', title: '速度与激情系列', sub: '家庭与速度',
      type: 'tmdb-collection', collectionId: 9485, tab: 'series', warm: '#e67e22' },
    { id: 'coll-lotr', title: '指环王系列', sub: '中洲史诗',
      type: 'tmdb-collection', collectionId: 119, tab: 'series', warm: '#8e44ad' },
    { id: 'coll-hobbit', title: '霍比特人系列', sub: '史矛革与至尊魔戒前传',
      type: 'tmdb-collection', collectionId: 121938, tab: 'series', warm: '#9b59b6' },
    { id: 'coll-bond', title: '007 詹姆斯·邦德系列', sub: '银幕最伟大特工',
      type: 'tmdb-collection', collectionId: 645, tab: 'series', warm: '#2c3e50' },
    { id: 'coll-backtofuture', title: '回到未来系列', sub: '时间旅行经典',
      type: 'tmdb-collection', collectionId: 264, tab: 'series', warm: '#d35400' },
    { id: 'coll-toystory', title: '玩具总动员系列', sub: '玩具们的冒险',
      type: 'tmdb-collection', collectionId: 10194, tab: 'series', warm: '#f1c40f' },
    { id: 'coll-godfather', title: '教父系列', sub: '影史史诗黑帮传奇',
      type: 'tmdb-collection', collectionId: 230, tab: 'series', warm: '#7f8c8d' },
    { id: 'coll-pirates', title: '加勒比海盗系列', sub: '杰克船长的传奇',
      type: 'tmdb-collection', collectionId: 295, tab: 'series', warm: '#16a085' },
    { id: 'coll-matrix', title: '黑客帝国系列', sub: '超越现实的科幻觉醒',
      type: 'tmdb-collection', collectionId: 2344, tab: 'series', warm: '#00b894' },
    { id: 'coll-mission', title: '碟中谍系列', sub: '伊森·亨特特工宇宙',
      type: 'tmdb-collection', collectionId: 87359, tab: 'series', warm: '#e74c3c' },
    { id: 'coll-darkknight', title: '黑暗骑士三部曲', sub: '诺兰蝙蝠侠传奇',
      type: 'tmdb-collection', collectionId: 263, tab: 'series', warm: '#34495e' },
    { id: 'coll-batman', title: '蝙蝠侠系列电影', sub: '哥谭暗夜骑士',
      type: 'tmdb-collection', collectionId: 120794, tab: 'series', warm: '#2980b9' },
    { id: 'coll-kungfupanda', title: '功夫熊猫系列', sub: '阿宝的武侠世界',
      type: 'tmdb-collection', collectionId: 77816, tab: 'series', warm: '#27ae60' },
    { id: 'coll-despicable', title: '神偷奶爸系列', sub: '格鲁与女孩们',
      type: 'tmdb-collection', collectionId: 86066, tab: 'series', warm: '#9b59b6' },
    { id: 'coll-minions', title: '小黄人大眼萌系列', sub: '香蕉味欢乐',
      type: 'tmdb-collection', collectionId: 544669, tab: 'series', warm: '#f1c40f' },
    { id: 'coll-iceage', title: '冰川时代系列', sub: '史前动物爆笑冒险',
      type: 'tmdb-collection', collectionId: 8354, tab: 'series', warm: '#3498db' },
    { id: 'coll-transformers', title: '变形金刚系列', sub: '汽车人 vs 霸天虎',
      type: 'tmdb-collection', collectionId: 8650, tab: 'series', warm: '#c0392b' },
    { id: 'coll-fantasticbeasts', title: '神奇动物系列', sub: '魔法世界动物图鉴',
      type: 'tmdb-collection', collectionId: 435259, tab: 'series', warm: '#16a085' },
    { id: 'coll-spiderman', title: '蜘蛛侠系列（山姆·雷米）', sub: '能力越大责任越大',
      type: 'tmdb-collection', collectionId: 556, tab: 'series', warm: '#e74c3c' },
    { id: 'coll-asm', title: '超凡蜘蛛侠系列', sub: '加菲尔德版蛛侠',
      type: 'tmdb-collection', collectionId: 125574, tab: 'series', warm: '#2980b9' },
    { id: 'coll-spiderverse', title: '蜘蛛侠：平行宇宙系列', sub: '多元宇宙动画神作',
      type: 'tmdb-collection', collectionId: 573436, tab: 'series', warm: '#e91e63' },
    { id: 'coll-boonie', title: '熊出没电影宇宙', sub: '春节档国民动画',
      type: 'tmdb-collection', collectionId: 814181, tab: 'series', warm: '#27ae60' },

    // ===== 系列 (series) —— 影人专区（2026-09-26 逐片核实定案：见 tests/home-collections-actor-zones.test.js、
    //   tests/home-collections-animation-zones.test.js）。全部 static-list：discover with_people 会把
    //   制片/编剧/客串条目混进「全集」（例：宫崎骏 only 编剧的《借东西的小人阿莉埃蒂》）。
    //   成龙专区卡已删（09-26 用户裁定）。
    //   周星驰 → 站内无任何相关社区榜，按用户品级图逐片编目 47 部（影片页 og:title 逐条回读；
    //     190452 Pepito Piscinas / 187977 五星战队大连者 系误挂已剔，补 108003 行运一条龙）
    { id: 'person-stephenchow', title: '周星驰电影专区', sub: '无厘头喜剧之王',
      type: 'static-list', tmdbIds: [
        9470, 53168, 11770, 41387, 13345, 21835, 37703, 55156, 37702, 13688,
        381890, 60145, 51730, 51731, 47647, 53165, 66657, 53163, 47648, 41343,
        45452, 70573, 41364, 40346, 57663, 53658, 32517, 52324,
        64083, 170657, 75197, 56124, 173653, 148380, 56118, 135061, 138960,
        45487, 575138, 53281, 73414, 160182, 73417, 69727, 74287, 35038, 108003,
      ], tab: 'series', warm: '#e67e22' },
    //   宫崎骏（person 608）→ 12 部长片 + 10 部导演短片，ID 取自站内人页 123 条回链逐条 og:title 回读
    { id: 'person-miyazaki', title: '宫崎骏动画全集', sub: '吉卜力造梦师 · 12长片10短片',
      type: 'static-list', tab: 'series', warm: '#16a085', tmdbIds: [
        15371, 81, 10515, 8392, 16859, 11621, 128, 129, 4935, 12429, 149870, 508883,
        188541, 158483, 222462, 222475, 222480, 222661, 222664, 214676, 508884, 1658826,
      ] },
    //   新海诚（person 74091）→ 8 部长片 + 7 部短片，同上核实（26 条人页回链）
    { id: 'person-shinkai', title: '新海诚动画专区', sub: '每一帧都是壁纸 · 8长片7短片',
      type: 'static-list', tab: 'series', warm: '#3498db', tmdbIds: [
        37910, 12924, 38142, 79707, 198375, 372058, 568160, 916224,
        73799, 449420, 18143, 277095, 222715, 1111342, 1492940,
      ] },

    // ===== 榜单 (lists) —— 社区名榜（TMDB 无官方榜单，来源与创建者明示）；中国奖项占位卡已删（2026-09-26 用户裁定）=====
    { id: 'list-imdb250', title: 'IMDb Top 250', sub: '社区榜 · Fernando K',
      type: 'tmdb-list', listId: 634, tab: 'lists', warm: '#f5c518' },
    { id: 'list-oscars', title: '历届奥斯卡最佳影片', sub: '社区榜 · travisbell',
      type: 'tmdb-list', listId: 28, tab: 'lists', warm: '#f1c40f' },
    { id: 'list-afi-thriller', title: 'AFI 百大惊悚片', sub: '社区榜 · endtheme',
      type: 'tmdb-list', listId: 43, tab: 'lists', warm: '#34495e' },
    { id: 'list-afi-comedy', title: 'AFI 百大喜剧片', sub: '社区榜 · Filmsomniac',
      type: 'tmdb-list', listId: 3682, tab: 'lists', warm: '#e67e22' },
    { id: 'list-dceu', title: 'DC 扩展宇宙', sub: '社区榜 · Harish-P',
      type: 'tmdb-list', listId: 8005, tab: 'lists', warm: '#2980b9' },
    // ===== TMDB 高分榜 → 名次段 5 张（2026-09-27 用户指令「把上千部的大榜二次分类，每个 ≤100 部」）=====
    // 原 top-rated 是 discover 无 limit，命中数=TMDB 全库（投票≥5000 的池子本身几千部）。
    // 名次段的依据=IMDb/豆瓣榜单自身的阅读结构（「第 1-100 名」天然就是一张可浏览的榜）。
    // 5 段共用原榜的排序与门槛（vote_average.desc + vote_count.gte 5000），否则段间名次无可比性；
    // rankFrom 由 tmdb.discoverRank 换算成起始页与页内偏移（不必先拉完区间前的几百条再丢）。
    { id: 'top-rated-1-100', title: 'TMDB 高分榜 · 前100', sub: '全球口碑 第 1-100 名',
      type: 'tmdb-discover', rankFrom: 1, limit: 100, tab: 'lists', warm: '#1abc9c',
      query: { sort_by: 'vote_average.desc', 'vote_count.gte': '5000' } },
    { id: 'top-rated-101-200', title: 'TMDB 高分榜 · 101-200', sub: '全球口碑 第 101-200 名',
      type: 'tmdb-discover', rankFrom: 101, limit: 100, tab: 'lists', warm: '#16a085',
      query: { sort_by: 'vote_average.desc', 'vote_count.gte': '5000' } },
    { id: 'top-rated-201-300', title: 'TMDB 高分榜 · 201-300', sub: '全球口碑 第 201-300 名',
      type: 'tmdb-discover', rankFrom: 201, limit: 100, tab: 'lists', warm: '#00b894',
      query: { sort_by: 'vote_average.desc', 'vote_count.gte': '5000' } },
    { id: 'top-rated-301-400', title: 'TMDB 高分榜 · 301-400', sub: '全球口碑 第 301-400 名',
      type: 'tmdb-discover', rankFrom: 301, limit: 100, tab: 'lists', warm: '#0984e3',
      query: { sort_by: 'vote_average.desc', 'vote_count.gte': '5000' } },
    { id: 'top-rated-401-500', title: 'TMDB 高分榜 · 401-500', sub: '全球口碑 第 401-500 名',
      type: 'tmdb-discover', rankFrom: 401, limit: 100, tab: 'lists', warm: '#1e3799',
      query: { sort_by: 'vote_average.desc', 'vote_count.gte': '5000' } },
    // ===== 影史百大 → 影史分期年代带 4 张 =====
    // 分界依据（有来源）：北京电影学院「电影史类课程设置」与维基百科「美国电影」条目的通行分期
    // （默片/黄金时代 → 新好莱坞 → 当代），华语侧按 1990（新浪潮已成势）/2010 分界。
    // 门槛继承原 classic-alltime（8.0 分以上 + 3000 投票），否则「百大」口径漂移。
    { id: 'classic-golden-age', title: '影史百大 · 默片与黄金时代', sub: '1960 前',
      type: 'tmdb-discover', limit: 100, tab: 'lists', warm: '#f1c40f',
      query: { sort_by: 'vote_average.desc', 'vote_average.gte': '8.0', 'vote_count.gte': '3000', 'primary_release_date.lte': '1959-12-31' } },
    { id: 'classic-new-hollywood', title: '影史百大 · 新好莱坞', sub: '1960-1989',
      type: 'tmdb-discover', limit: 100, tab: 'lists', warm: '#d4ac0d',
      query: { sort_by: 'vote_average.desc', 'vote_average.gte': '8.0', 'vote_count.gte': '3000', 'primary_release_date.gte': '1960-01-01', 'primary_release_date.lte': '1989-12-31' } },
    { id: 'classic-modern', title: '影史百大 · 现代经典', sub: '1990-2009',
      type: 'tmdb-discover', limit: 100, tab: 'lists', warm: '#b7950b',
      query: { sort_by: 'vote_average.desc', 'vote_average.gte': '8.0', 'vote_count.gte': '3000', 'primary_release_date.gte': '1990-01-01', 'primary_release_date.lte': '2009-12-31' } },
    { id: 'classic-contemporary', title: '影史百大 · 当代高分', sub: '2010 至今',
      type: 'tmdb-discover', limit: 100, tab: 'lists', warm: '#9a7d0a',
      query: { sort_by: 'vote_average.desc', 'vote_average.gte': '8.0', 'vote_count.gte': '3000', 'primary_release_date.gte': '2010-01-01' } },
    // ===== 年度高分榜 5 张：榜单本身就是「某一年」，不再拆桶，只补 limit:100 硬上限（09-27 裁定）=====
    { id: 'top-2024', title: '2024 年评分最高', sub: '年度佳片',
      type: 'tmdb-discover', limit: 100, tab: 'lists', warm: '#1abc9c',
      query: { 'primary_release_year': '2024', 'sort_by': 'vote_average.desc', 'vote_count.gte': '200' } },
    { id: 'top-2023', title: '2023 年评分最高', sub: '年度佳片',
      type: 'tmdb-discover', limit: 100, tab: 'lists', warm: '#3498db',
      query: { 'primary_release_year': '2023', 'sort_by': 'vote_average.desc', 'vote_count.gte': '200' } },
    { id: 'top-2022', title: '2022 年评分最高', sub: '年度佳片',
      type: 'tmdb-discover', limit: 100, tab: 'lists', warm: '#e67e22',
      query: { 'primary_release_year': '2022', 'sort_by': 'vote_average.desc', 'vote_count.gte': '200' } },
    { id: 'top-2021', title: '2021 年评分最高', sub: '年度佳片',
      type: 'tmdb-discover', limit: 100, tab: 'lists', warm: '#9b59b6',
      query: { 'primary_release_year': '2021', 'sort_by': 'vote_average.desc', 'vote_count.gte': '200' } },
    { id: 'top-2020s', title: '2020 至今高分', sub: '近五年口碑佳片',
      type: 'tmdb-discover', limit: 100, tab: 'lists', warm: '#2ecc71',
      query: { 'primary_release_date.gte': '2020-01-01', 'sort_by': 'vote_average.desc', 'vote_average.gte': '7.8', 'vote_count.gte': '500' } },
    { id: 'oscar-best-picture', title: '奥斯卡最佳影片', sub: '历届最高荣誉',
      type: 'static-list', tmdbIds: [19404, 424, 11216, 70160, 524, 278, 238, 389, 13, 105], tab: 'lists', warm: '#c9a227' },
    // ===== 华语榜：动画桶天然小（只补 limit），跨年代大榜按年代带拆 =====
    { id: 'list-chinese-animation', title: '华语动画榜', sub: '国漫高分精选',
      type: 'tmdb-discover', limit: 100, tab: 'lists', warm: '#e91e63',
      query: { with_genres: '16', with_original_language: 'zh', sort_by: 'vote_average.desc', 'vote_count.gte': '50' } },
    { id: 'chinese-classic-old', title: '华语经典 · 邵氏到八十年代', sub: '1990 前',
      type: 'tmdb-discover', limit: 100, tab: 'lists', warm: '#f39c12',
      query: { with_original_language: 'zh', sort_by: 'vote_average.desc', 'vote_count.gte': '150', 'primary_release_date.lte': '1989-12-31' } },
    { id: 'chinese-classic-newwave', title: '华语经典 · 新浪潮黄金十年', sub: '1990-2009',
      type: 'tmdb-discover', limit: 100, tab: 'lists', warm: '#e55039',
      query: { with_original_language: 'zh', sort_by: 'vote_average.desc', 'vote_count.gte': '150', 'primary_release_date.gte': '1990-01-01', 'primary_release_date.lte': '2009-12-31' } },
    { id: 'chinese-classic-recent', title: '华语经典 · 近十余年', sub: '2010 至今',
      type: 'tmdb-discover', limit: 100, tab: 'lists', warm: '#eb984e',
      query: { with_original_language: 'zh', sort_by: 'vote_average.desc', 'vote_count.gte': '150', 'primary_release_date.gte': '2010-01-01' } },

    // ===== 类型 (genres) —— 二次分类体系（2026-09-27 用户指令）=====
    // 旧 11 张母类型卡「火爆动作 2003 部 / 欢乐喜剧 2814 部 / 剧情佳作 3492 部」的根因：
    // 母卡 = 单类型 discover + 无 limit，而 2026-09-26 指令①「所有片单不限制最多数量」把
    // discover 切成 discoverAll 无限分页 → 计数=TMDB 该类型全库命中数。
    // 用户裁定：母卡整体删除，只留 ≤100 部的子卡；≤100 = 主题过滤天然收窄 + limit:100 硬截断（双保险）。
    // 分桶思想来自影史类型学（维基百科「电影类型」/ 百度百科「动作片」/ 豆瓣类型子榜的通行子分类），
    // 但过滤参数只用**本仓库可验证的硬参数**：
    //   · with_genres 交集（逗号=AND）——ID 全部取自 tmdb.js GENRE_NAMES（站内 zh-CN 官方类型表）
    //   · with_original_language / .not —— ISO 639-1 原产语言（华语/日系/英式/非英语）
    //   · primary_release_date.lte —— 年代窗（影史经典桶）
    //   · vote_average.gte —— 评分带（硬核高分桶）
    //   每张子卡叠加**恰好一条**正交轴（见 tests/home-collections-genre-subdivide.test.js），
    //   保证「桶为什么小」可解释，而不是随手叠参数。
    // 不用 with_keywords 的原因：无 key 时关键词 ID 无法证实存在（api 只回 Invalid API key，
    // 站内 keyword 页本机不可达），且官方 talk 证实该参数一次只认一个 ID。凭记忆写 ID 已错过两次
    // （合集 209=404、周星驰 190452=西语片误挂），不在 38 张卡上重犯。
    // 门槛分级：双/三类型交集=样本已窄（150~200）；单类型+语言窗更窄（50~100）；纯类型+年代窗最高（300）。
    { id: 'genre-action-kungfu', title: '港产功夫硬汉', sub: '拳拳到肉华语动作',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#e74c3c',
      query: { with_genres: '28', with_original_language: 'zh', sort_by: 'vote_average.desc', 'vote_count.gte': '50' } },
    { id: 'genre-action-war', title: '战火动作', sub: '枪林弹雨',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#c0392b',
      query: { with_genres: '28,10752', sort_by: 'vote_average.desc', 'vote_count.gte': '150' } },
    { id: 'genre-action-fantasy', title: '奇幻动作 · 超英神话', sub: '视效爽片',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#d35400',
      query: { with_genres: '28,14', sort_by: 'vote_average.desc', 'vote_count.gte': '150' } },
    { id: 'genre-action-classic', title: '影史老派动作', sub: '2000 前硬核',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#e67e22',
      query: { with_genres: '28', 'primary_release_date.lte': '1999-12-31', sort_by: 'vote_average.desc', 'vote_count.gte': '200' } },

    { id: 'genre-comedy-romance', title: '爱情喜剧', sub: '笑中带甜',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#f39c12',
      query: { with_genres: '35,10749', sort_by: 'vote_average.desc', 'vote_count.gte': '150' } },
    { id: 'genre-comedy-noir', title: '黑色幽默', sub: '荒诞犯罪喜剧',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#f1c40f',
      query: { with_genres: '35,80', sort_by: 'vote_average.desc', 'vote_count.gte': '150' } },
    { id: 'genre-comedy-animation', title: '动画喜剧', sub: '笑闹不打扰',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#d4ac0d',
      query: { with_genres: '35,16', sort_by: 'vote_average.desc', 'vote_count.gte': '150' } },
    { id: 'genre-comedy-brit', title: '英式冷幽默', sub: '英伦尴尬喜剧',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#b7950b',
      query: { with_genres: '35', with_original_language: 'en-GB', sort_by: 'vote_average.desc', 'vote_count.gte': '80' } },

    { id: 'genre-animation-japan', title: '日系剧场版动画', sub: '燃与泪',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#e91e63',
      query: { with_genres: '16', with_original_language: 'ja', sort_by: 'vote_average.desc', 'vote_count.gte': '100' } },
    { id: 'genre-animation-china', title: '华语国漫', sub: '从大圣到深海',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#c2185b',
      query: { with_genres: '16', with_original_language: 'zh', sort_by: 'vote_average.desc', 'vote_count.gte': '50' } },
    { id: 'genre-animation-western', title: '欧美合家欢动画', sub: '迪士尼 · 皮克斯',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#9b59b6',
      query: { with_genres: '16', with_original_language: 'en', sort_by: 'vote_average.desc', 'vote_count.gte': '200' } },
    { id: 'genre-animation-adult', title: '成人向剧情动画', sub: '不止给孩子看',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#8e44ad',
      query: { with_genres: '16,18', sort_by: 'vote_average.desc', 'vote_count.gte': '80' } },

    { id: 'genre-drama-classic', title: '影史文艺剧情', sub: '人性深度',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#6c5ce7',
      query: { with_genres: '18', 'primary_release_date.lte': '1999-12-31', sort_by: 'vote_average.desc', 'vote_count.gte': '300' } },
    { id: 'genre-drama-epic', title: '史诗古装剧情', sub: '大时代小人物',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#4a69bd',
      query: { with_genres: '18,10752', sort_by: 'vote_average.desc', 'vote_count.gte': '150' } },
    { id: 'genre-drama-biopic', title: '真人真事改编', sub: '银幕传记',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#3c6382',
      query: { with_genres: '18,36', sort_by: 'vote_average.desc', 'vote_count.gte': '150' } },
    { id: 'genre-drama-mystery', title: '悬疑剧情', sub: '静水流深',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#4834d4',
      query: { with_genres: '18,9648', sort_by: 'vote_average.desc', 'vote_count.gte': '150' } },

    { id: 'genre-romance-chinese', title: '华语爱情', sub: '青春与遗憾',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#ff6b81',
      query: { with_genres: '10749', with_original_language: 'zh', sort_by: 'vote_average.desc', 'vote_count.gte': '50' } },
    { id: 'genre-romance-classic', title: '年代经典爱情', sub: '旧日柔情',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#fd79a8',
      query: { with_genres: '10749', 'primary_release_date.lte': '1999-12-31', sort_by: 'vote_average.desc', 'vote_count.gte': '150' } },
    { id: 'genre-romance-music', title: '爱情 & 音乐剧', sub: '唱着相爱',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#e84393',
      query: { with_genres: '10749,10402', sort_by: 'vote_average.desc', 'vote_count.gte': '100' } },

    { id: 'genre-scifi-space', title: '太空冒险', sub: '浩瀚宇宙',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#2c3e50',
      query: { with_genres: '878,12', sort_by: 'vote_average.desc', 'vote_count.gte': '150' } },
    { id: 'genre-scifi-hard', title: '硬核高分科幻', sub: '8 分以上口碑',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#1e3799',
      query: { with_genres: '878', 'vote_average.gte': '8.0', sort_by: 'vote_average.desc', 'vote_count.gte': '300' } },
    { id: 'genre-scifi-cyber', title: '赛博 & 人工智能', sub: '机器与未来',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#00b894',
      query: { with_genres: '878,28', sort_by: 'vote_average.desc', 'vote_count.gte': '150' } },
    { id: 'genre-scifi-intl', title: '非英语科幻', sub: '欧亚想象',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#0984e3',
      query: { with_genres: '878', 'with_original_language.not': 'en', sort_by: 'vote_average.desc', 'vote_count.gte': '80' } },

    { id: 'genre-horror-supernatural', title: '超自然恐怖', sub: '鬼怪与附身',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#2d3436',
      query: { with_genres: '27,14', sort_by: 'vote_average.desc', 'vote_count.gte': '150' } },
    { id: 'genre-horror-psychological', title: '心理惊悚恐怖', sub: '人心最暗',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#636e72',
      query: { with_genres: '27,18,53', sort_by: 'vote_average.desc', 'vote_count.gte': '150' } },
    { id: 'genre-horror-asia', title: '亚洲恐怖', sub: '东亚阴森',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#b71540',
      query: { with_genres: '27', with_original_language: 'ja,ko,zh', sort_by: 'vote_average.desc', 'vote_count.gte': '50' } },

    { id: 'genre-mystery-detective', title: '侦探推理', sub: '线索与真相',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#535c68',
      query: { with_genres: '9648,80', sort_by: 'vote_average.desc', 'vote_count.gte': '200' } },
    { id: 'genre-mystery-thriller', title: '惊悚悬疑', sub: '步步紧逼',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#7f8fa6',
      query: { with_genres: '9648,53', sort_by: 'vote_average.desc', 'vote_count.gte': '200' } },
    { id: 'genre-mystery-young', title: '少年冒险解谜', sub: '寻宝探秘',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#f97f51',
      query: { with_genres: '9648,12', sort_by: 'vote_average.desc', 'vote_count.gte': '80' } },

    { id: 'genre-crime-classic', title: '影史经典犯罪', sub: '黑色电影',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#283747',
      query: { with_genres: '80', 'primary_release_date.lte': '1989-12-31', sort_by: 'vote_average.desc', 'vote_count.gte': '200' } },
    { id: 'genre-crime-thriller', title: '犯罪惊悚', sub: '亡命倒计时',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#576574',
      query: { with_genres: '80,53', sort_by: 'vote_average.desc', 'vote_count.gte': '200' } },
    { id: 'genre-crime-drama', title: '犯罪剧情', sub: '罪与罚',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#833471',
      query: { with_genres: '80,18', sort_by: 'vote_average.desc', 'vote_count.gte': '200' } },
    { id: 'genre-crime-biopic', title: '真实罪案改编', sub: '案子来自卷宗',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#6f1e51',
      query: { with_genres: '80,36', sort_by: 'vote_average.desc', 'vote_count.gte': '80' } },

    { id: 'genre-family-animation', title: '动画合家欢', sub: '全家一起看',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#1abc9c',
      query: { with_genres: '10751,16', sort_by: 'vote_average.desc', 'vote_count.gte': '200' } },
    { id: 'genre-family-romance', title: '真人温情合家欢', sub: '家庭与爱',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#48c9b0',
      query: { with_genres: '10751,10749', sort_by: 'vote_average.desc', 'vote_count.gte': '80' } },
    { id: 'genre-family-fantasy', title: '奇幻合家欢', sub: '魔法与冒险',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#16a085',
      query: { with_genres: '10751,14', sort_by: 'vote_average.desc', 'vote_count.gte': '150' } },

    { id: 'genre-war-intl', title: '非英语战争史诗', sub: '他国战场',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#a04000',
      query: { with_genres: '10752', 'with_original_language.not': 'en', sort_by: 'vote_average.desc', 'vote_count.gte': '80' } },
    { id: 'genre-war-history', title: '战争历史传记', sub: '真实战役',
      type: 'tmdb-discover', limit: 100, tab: 'genres', warm: '#873600',
      query: { with_genres: '10752,36', sort_by: 'vote_average.desc', 'vote_count.gte': '80' } }
  ];

  // 2002~2026 逐年高分动画榜（2026-09-26 用户指令③：「2002到2026年的高分动画榜拆成独立片单，
  // 每个片单选15部」）。25 年 × 15 部 = 375 条不做人工编目（ID 人工编目出过错：合集 209 系 404），
  // 排序与选片交给 TMDB discover 实时结果：with_genres=16 + primary_release_year + 评分降序
  // + 投票数门槛（防 10 人 9.8 分占位），limit=15 由 fetchItems 截断（单页 20 条即够，不拉全量分页）。
  var ANIM_YEAR_FROM = 2002, ANIM_YEAR_TO = 2026;
  var ANIM_YEAR_WARM = ['#9b59b6', '#8e44ad', '#6a89cc', '#4a69bd', '#3c6382', '#6c5ce7', '#2c3a47', '#4834d4'];
  for (var ay = ANIM_YEAR_FROM; ay <= ANIM_YEAR_TO; ay++) {
    CATALOG.push({
      id: 'anim-top-' + ay, title: ay + ' 年度高分动画', sub: '当年全球口碑 TOP15',
      type: 'tmdb-discover', limit: 15, tab: 'lists', warm: ANIM_YEAR_WARM[(ay - ANIM_YEAR_FROM) % ANIM_YEAR_WARM.length],
      query: {
        with_genres: '16', primary_release_year: String(ay), sort_by: 'vote_average.desc',
        'vote_count.gte': ay >= ANIM_YEAR_TO - 1 ? '50' : '150',
      },
    });
  }

  // 独立键，不与（已删除的）用户片单夹耦合，便于搜索结果前端过滤
  var MARKS_KEY = 'stellaflix-view-marks';
  var LS = global.localStorage;

  // ---------------------------------------------------------------- 对外方法
  function getByTab(tabId) {
    return CATALOG.filter(function (c) { return c.tab === tabId; }).map(function (c) {
      return {
        id: c.id, title: c.title, sub: c.sub || '',
        type: c.type, warm: c.warm || '#333',
        // 占位计数（真实数量在 getItems 后刷新）
        count: (c.type === 'placeholder') ? 0 : null,
        collectionId: c.collectionId, query: c.query,
        listId: c.listId, limit: c.limit, rankFrom: c.rankFrom,
        tmdbIds: c.tmdbIds, mediaType: c.mediaType, timeWindow: c.timeWindow,
        tab: c.tab
      };
    });
  }

  // 取单个片单的影片列表（统一 normalizeList 格式）
  // 内存缓存：封面回填与二级页共用在途/已完成结果；static-list 逐条 getDetails，
  // 不缓存则每次开浮层/切 tab 都是请求风暴。失败不进缓存（下次重试）。
  var ITEMS_TTL_MS = 10 * 60 * 1000;
  var itemsCache = {}; // def.id -> { ts, promise }
  function getItems(def) {
    if (!def || !def.id) return fetchItems(def);
    var hit = itemsCache[def.id];
    if (hit && Date.now() - hit.ts < ITEMS_TTL_MS) return hit.promise;
    var entry = { ts: Date.now(), promise: null };
    entry.promise = fetchItems(def).catch(function (e) {
      if (itemsCache[def.id] === entry) delete itemsCache[def.id];
      throw e;
    });
    itemsCache[def.id] = entry;
    return entry.promise;
  }

  function fetchItems(def) {
    if (!def) return Promise.reject(new Error('NO_DEF'));
    var tmdb = SFV.tmdb;
    if (!tmdb || !tmdb.hasKey || !tmdb.hasKey()) return Promise.reject(new Error('TMDB_KEY_REQUIRED'));

    switch (def.type) {
      case 'tmdb-trending':
        return tmdb.trending(def.mediaType || 'movie', def.timeWindow || 'week');
      case 'tmdb-popular':
        return tmdb.popular(def.mediaType || 'movie');
      case 'tmdb-upcoming':
        return tmdb.upcoming();
      case 'tmdb-collection':
        return tmdb.getCollection(def.collectionId).then(function (c) {
          // 用 parts 作为影片列表（已含 poster/title/year/rating）
          return (c.parts || []).map(function (p) {
            return {
              id: p.id, mediaType: p.mediaType || 'movie',
              title: p.title, year: p.year, poster: p.poster,
              rating: p.rating, overview: p.overview, backdrop: p.backdrop
            };
          });
        });
      case 'tmdb-list':
        if (!def.listId) return Promise.reject(new Error('TMDB_NO_ID'));
        if (typeof tmdb.getListAll !== 'function') return Promise.reject(new Error('TMDB_LIST_UNSUPPORTED'));
        return tmdb.getListAll(def.listId).then(function (r) { return (r && r.items) || []; });
      case 'tmdb-discover':
        // def.rankFrom（2026-09-27 榜单名次段卡）：只取区间那 100 名，交给 discoverRank 换算页码/偏移。
        // 旧 tmdb.js 没有 discoverRank 时回退「拉全量再切片」——结果同一批，代价是多几个分页请求。
        if (def.rankFrom > 0) {
          var from = Number(def.rankFrom);
          var cnt = def.limit > 0 ? Number(def.limit) : 100;
          if (typeof tmdb.discoverRank === 'function') return tmdb.discoverRank(def.query || {}, from, cnt);
          if (typeof tmdb.discoverAll === 'function') {
            return tmdb.discoverAll(def.query || {}).then(function (all) {
              return (all || []).slice(from - 1, from - 1 + cnt);
            });
          }
          return tmdb.discover(def.query || {}).then(function (r) { return (r || []).slice(from - 1, from - 1 + cnt); });
        }
        // def.limit（年度榜这类「只取前 N」的卡）：单页 20 条足够覆盖，省掉全量分页往返
        if (def.limit > 0) {
          return tmdb.discover(def.query || {}).then(function (r) { return (r || []).slice(0, def.limit); });
        }
        // 无 limit = 全量分页（用户指令：片单不限条数）；旧 tmdb.js 无 discoverAll 时回退单页
        if (typeof tmdb.discoverAll === 'function') return tmdb.discoverAll(def.query || {});
        return tmdb.discover(def.query || {});
      case 'static-list':
        // A 补充：逐条 getDetails 补全（数量少，串行可控）
        return resolveStatic(def.tmdbIds || []);
      default:
        return Promise.reject(new Error('UNKNOWN_TYPE_' + def.type));
    }
  }

  // static-list：优先用 TMDB chunk 端点 /3/movie?ids=… 批量取详情（≤20 id/请求，
  // 周星驰专区 39 部 = 2 请求，替代 39 个串行往返）；chunk 漏返或整体失败 → 逐条 getDetails 兜底。
  var CHUNK_SIZE = 20;
  function mapDetail(r, mediaType) {
    var tmdb = SFV.tmdb;
    return {
      id: r.id, mediaType: mediaType || 'movie',
      title: r.title || r.name || '', year: (r.release_date || r.first_air_date || '').slice(0, 4),
      overview: r.overview || '', poster: tmdb.posterUrl(r.poster_path, 'w500'),
      backdrop: tmdb.posterUrl(r.backdrop_path, 'w780'), rating: r.vote_average || 0
    };
  }
  function resolveOne(id) {
    return SFV.tmdb.getDetails(id, 'movie').then(function (d) {
      return {
        id: d.id, mediaType: 'movie', title: d.title, year: d.year,
        poster: d.poster, rating: d.rating, overview: d.overview, backdrop: d.backdrop
      };
    }).catch(function () { return null; });
  }
  function resolveStatic(ids) {
    var tmdb = SFV.tmdb;
    var uniq = [];
    (ids || []).forEach(function (id) { if (uniq.indexOf(id) < 0) uniq.push(id); });
    if (!tmdb || typeof tmdb.request !== 'function') {
      return Promise.all(uniq.map(resolveOne)).then(function (rs) { return rs.filter(Boolean); });
    }
    var batches = [];
    for (var i = 0; i < uniq.length; i += CHUNK_SIZE) batches.push(uniq.slice(i, i + CHUNK_SIZE));
    return Promise.all(batches.map(function (b) {
      return tmdb.request('/movie', { ids: b.join(',') }).then(function (j) {
        // 多 id 返回 { results: [...] }；上游对单 id 有时直接回对象，两种形态都收
        if (j && Array.isArray(j.results)) return j.results;
        if (j && j.id != null) return [j];
        return [];
      }).catch(function () { return []; });
    })).then(function (chunks) {
      var byId = {};
      chunks.forEach(function (list) {
        (list || []).forEach(function (r) { if (r && r.id != null) byId[r.id] = r; });
      });
      var missing = uniq.filter(function (id) { return !byId[id]; });
      return Promise.all(missing.map(resolveOne)).then(function (extra) {
        var extraById = {};
        missing.forEach(function (id, k) { extraById[id] = extra[k]; });
        return uniq.map(function (id) {
          return byId[id] ? mapDetail(byId[id], 'movie') : extraById[id];
        }).filter(Boolean);
      });
    });
  }

  // 海报平均色：同 URL 复用在途/已完成 promise，失败不进缓存（与 getItems 同策略）。
  // 入参可为条目对象或其 poster URL；实际请求经 SFV.tmdb.getPosterColor → /api/image-color。
  var colorCache = {}; // poster -> promise
  function getPosterColor(posterOrItem) {
    var poster = posterOrItem && typeof posterOrItem === 'object' ? posterOrItem.poster : posterOrItem;
    if (!poster) return Promise.reject(new Error('COLOR_NO_POSTER'));
    if (colorCache[poster]) return colorCache[poster];
    var tmdb = SFV.tmdb;
    if (!tmdb || typeof tmdb.getPosterColor !== 'function') return Promise.reject(new Error('COLOR_UNAVAILABLE'));
    var p = tmdb.getPosterColor(poster).catch(function (e) {
      if (colorCache[poster] === p) delete colorCache[poster];
      throw e;
    });
    colorCache[poster] = p;
    return p;
  }

  // ---------------------------------------------------------------- 看过 / 弃 标记（Kazumi 隐藏已看/已弃）
  // 主键策略：搜索结果去重后无单一 id，以其身份键（小写 title|year）为主；
  // TMDB 条目（含 mediaType/id）回退 mediaType:id；源 variant 直接用其复合 key。
  function loadMarks() {
    if (!LS) return { watched: {}, abandoned: {} };
    try {
      var raw = LS.getItem(MARKS_KEY);
      if (!raw) return { watched: {}, abandoned: {} };
      var p = JSON.parse(raw);
      return { watched: p.watched || {}, abandoned: p.abandoned || {} };
    } catch (e) { return { watched: {}, abandoned: {} }; }
  }
  function saveMarks(data) {
    if (!LS) return false;
    try { LS.setItem(MARKS_KEY, JSON.stringify(data)); return true; }
    catch (e) { return false; }
  }
  function markKey(item) {
    if (!item) return null;
    if (item.key) return String(item.key);
    if (item.title) return String(item.title).toLowerCase() + '|' + (item.year || '');
    if (item.id != null) return (item.mediaType || 'movie') + ':' + item.id;
    return null;
  }
  function setMark(item, type, on) {
    var k = markKey(item);
    if (!k) return false;
    type = (type === 'abandoned') ? 'abandoned' : 'watched';
    var d = loadMarks();
    if (on) d[type][k] = Date.now();
    else delete d[type][k];
    return saveMarks(d);
  }
  function isMarked(item, type) {
    var k = markKey(item);
    if (!k) return false;
    type = (type === 'abandoned') ? 'abandoned' : 'watched';
    return !!loadMarks()[type][k];
  }
  function markWatched(item) { return setMark(item, 'watched', true); }
  function unmarkWatched(item) { return setMark(item, 'watched', false); }
  function isWatched(item) { return isMarked(item, 'watched'); }
  function markAbandoned(item) { return setMark(item, 'abandoned', true); }
  function unmarkAbandoned(item) { return setMark(item, 'abandoned', false); }
  function isAbandoned(item) { return isMarked(item, 'abandoned'); }
  function toggleMark(item, type) {
    if (isMarked(item, type)) { setMark(item, type, false); return false; }
    setMark(item, type, true); return true;
  }
  // 批量判定辅助：返回某类型下的主键集合（供搜索结果前端隐藏过滤）
  function getMarkedKeys(type) {
    type = (type === 'abandoned') ? 'abandoned' : 'watched';
    var d = loadMarks();
    return Object.keys(d[type] || {});
  }

  // ---------------------------------------------------------------- 导出
  SFV.collections = {
    getByTab: getByTab,
    getItems: getItems,
    getPosterColor: getPosterColor,
    // 看过 / 弃 标记
    markWatched: markWatched,
    unmarkWatched: unmarkWatched,
    isWatched: isWatched,
    markAbandoned: markAbandoned,
    unmarkAbandoned: unmarkAbandoned,
    isAbandoned: isAbandoned,
    toggleMark: toggleMark,
    getMarkedKeys: getMarkedKeys
  };
})(typeof window !== 'undefined' ? window : this);
