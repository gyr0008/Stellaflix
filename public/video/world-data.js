/*
 * Stellaflix 影视模块 — 世界页数据源（M5 房间语义）
 *
 * 产品定位：世界页的信标 = 「正在放映的房间」。
 *   · 每座灯塔 = 一个开放的「一起看」房间
 *   · 卡片显示「N 人一起看《X》」
 *   · 主按钮 = 进入房间（world-room.js）
 *
 * 数据链路：
 *   GET /api/rooms  →  world-room-api.js（本地 server.js，内存房间表）
 *   拉不到就降级演示房间，世界页永远有灯塔可看、可点，不白屏。
 *
 * 隐私边界：房间列表只含 roomId / 城市级坐标 / 人数 / 片名，
 * 不含 IP、deviceId、精确位置。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var lastResult = null;

  // 演示房间（房间服务不可用时的兜底）
  var DEMO_ROOMS = [
    { id: 'r-sh', roomId: 'room-sh', name: '上海', lon: 121.47, lat: 31.23, status: 'playing', title: '《星际穿越》', people: 3, alwaysExpanded: true, ownerType: 'system', countryCode: 'CN', city: '上海', country: '中国', coverUrl: 'https://image.tmdb.org/t/p/w780/8sNiAPPYU14PUepFNeSNGUTiHW.jpg', descriptionZh: '近未来，地球环境持续恶化，枯萎病和沙尘暴让越来越多农作物消失，人类的生存前景也变得岌岌可危。曾为NASA飞行员的库珀如今与家人在农场生活，一次偶然发现的异常重力现象，却将他和女儿墨菲引向一个仍在秘密运作的NASA基地。布兰德教授告诉他，多年前土星附近出现了一处神秘虫洞，人类已经通过它寻找太阳系之外可能适合居住的新世界。为了给地球上的人类寻找延续文明的希望，库珀决定告别家人，与艾米莉亚·布兰德等人踏上一场穿越虫洞、前往遥远星系的探索之旅。然而在浩瀚宇宙中，距离与时间都将成为他们从未真正面对过的考验……' },
    { id: 'r-tk', roomId: 'room-tk', name: '东京', lon: 139.69, lat: 35.69, status: 'playing', title: '《千与千寻》', people: 2, alwaysExpanded: true, ownerType: 'system', countryCode: 'JP', city: '东京', country: '日本', coverUrl: 'https://image.tmdb.org/t/p/w780/6oaL4DP75yABrd5EbC4H2zq5ghc.jpg', descriptionZh: '10岁的千寻跟随父母搬家途中，意外穿过一条神秘隧道，闯入了一个属于神灵的奇异世界。父母因为擅自吃下供奉给神灵的食物而被变成猪，惊慌失措的千寻则在神秘少年白龙的帮助下得以留下。为了在这个世界生存并寻找救回父母的方法，她不得不到汤婆婆掌管的“油屋”浴场工作。在形形色色的神灵与不可思议的遭遇中，原本胆小任性的千寻开始学会独自面对困难，而她也必须找到离开这里、带父母重返人类世界的方法……' },
    { id: 'r-ny', roomId: 'room-ny', name: '纽约', lon: -74.01, lat: 40.71, status: 'playing', title: '《奥本海默》', people: 5, alwaysExpanded: true, ownerType: 'system', countryCode: 'US', city: '纽约', country: '美国', coverUrl: 'https://image.tmdb.org/t/p/w780/neeNHeXjMF5fXoCJRsOmkNGC7q.jpg', descriptionZh: '随着战争阴云笼罩世界，各国之间的军事竞赛愈演愈烈。为了抢占先机，美国军方找到量子力学与核物理学家罗伯特·奥本海默，任命他领导洛斯阿拉莫斯实验室，并参与推进绝密的曼哈顿计划。在科学家们争分夺秒的研发下，人类历史上第一颗原子弹最终在荒漠中成功引爆。然而，当这种足以改变世界的力量真正诞生后，奥本海默也开始重新审视自己的选择以及核武器可能带来的后果。随着战争结束，他的政治立场和过往经历又让他逐渐卷入一场更加复杂的政治风暴……' },
    { id: 'r-ld', roomId: 'room-ld', name: '伦敦', lon: -0.13, lat: 51.51, status: 'online', title: '《盗梦空间》', people: 2, alwaysExpanded: true, ownerType: 'system', countryCode: 'GB', city: '伦敦', country: '英国', coverUrl: 'https://image.tmdb.org/t/p/w780/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg', descriptionZh: '道姆·柯布与同事阿瑟和纳什在一次针对日本能源大亨齐藤（渡边谦 饰）的盗梦行动中失败，反被齐藤利用。齐藤威逼利诱因遭通缉而流亡海外的柯布帮他拆分他竞争对手的公司，采取极端措施在其唯一继承人罗伯特·费希尔的深层潜意识中种下放弃家族公司、自立门户的想法。为了重返美国，柯布偷偷求助于岳父迈尔斯，吸收了年轻的梦境设计师艾里阿德妮、梦境演员艾姆斯和药剂师约瑟夫加入行动。在一层层递进的梦境中，柯布不仅要对付费希尔潜意识的本能反抗，还必须直面已逝妻子梅尔的处处破坏，实际情况远比预想危险得多……' },
    { id: 'r-pr', roomId: 'room-pr', name: '巴黎', lon: 2.35, lat: 48.86, status: 'online', title: '《天使爱美丽》', people: 1, alwaysExpanded: true, ownerType: 'system', countryCode: 'FR', city: '巴黎', country: '法国', coverUrl: 'https://image.tmdb.org/t/p/w780/6n53UI4mX9QMfe2S0Pgt8mGebY1.jpg', descriptionZh: '艾米莉（奥黛丽·塔图 Audrey Tautou 饰）有着别人看来不幸的童年——父亲给她做健康检查时，发现她心跳过快，便断定她患上心脏病，从此艾米莉与学校绝缘。随后因为一桩意外，母亲在她眼前突然死去。这一切都毫不影响艾米莉对生活的豁达乐观。1997年，戴安娜王妃的去世让她倍感人生的孤独脆弱，艾米莉从此开始了一系列助人计划，包括自闭忧郁的邻居老人，被老板刻薄的菜摊伙计、遗失了童年器物的旧房东、爱情失意的咖啡店同事。但她万万想不到，成人录象带商店店员尼诺（马修·卡索维 Mathieu Kassovitz 饰），竟成为她的棘手对象，艾米莉开始了令人哭笑不得的另类计划……' },
    { id: 'r-sy', roomId: 'room-sy', name: '悉尼', lon: 151.21, lat: -33.87, status: 'online', title: '《疯狂的麦克斯》', people: 2, alwaysExpanded: true, ownerType: 'system', countryCode: 'AU', city: '悉尼', country: '澳大利亚', coverUrl: 'https://image.tmdb.org/t/p/w780/mWQg2INejtX1PCWRAN4vseadA6H.jpg', descriptionZh: '在不远的未来，公路骑士们在道路上肆虐，所过之处留下疯狂破坏的痕迹。为了追逐盗取了警用车的“黑暗骑士”，警方付出了重大代价，幸有比骑士更加疯狂的麦克斯（梅尔·吉布森 Mel Gibson 饰）出场，迫使黑暗骑士车祸身亡。黑暗骑士的同伙们发誓报仇，他们降临小镇，要接回黑暗骑士的尸身，并且肆意凌虐弱者，麦克斯和搭档古斯（Steve Bisley 饰）抓获凶手后，却因为无人敢指认，只得容忍他们继续逍遥法外。古斯被公路骑士们抓到，身负重伤，而麦克斯的妻子杰西（琼妮·萨缪尔 Joanne Samuel 饰）也被他们恐吓骚扰，有“疯狂”之称的麦克斯不再隐忍，向骑士们展开回击。 乔治·米勒 詹姆斯·麦考斯兰' },
    { id: 'r-ri', roomId: 'room-ri', name: '里约', lon: -43.17, lat: -22.91, status: 'online', title: '《上帝之城》', people: 4, alwaysExpanded: true, ownerType: 'system', countryCode: 'BR', city: '里约', country: '巴西', coverUrl: 'https://image.tmdb.org/t/p/w780/uvitbjFU4JqvMwIkMWHp69bmUzG.jpg', descriptionZh: '巴西里约热内卢的贫民窟，这里是“上帝之城”，更是魔鬼也会叹息着转身的地方。 阿炮带着我们到了这里，他见证了这里二十多年来被残暴、贪婪、复仇、野心、背叛、掠夺所裹挟的混乱生活以及最终导致的一场灾难性的黑帮争斗。虽然从小就要 辗转于匪徒间求生存，但胆小怕事的性格与自我保护的本能却使他一直能平安度日。 60年代初，阿毛、阿夹和阿呆是这里的“少年三侠”，在抢劫完旅馆之后，他们三人分道扬镳，阿夹重回上帝的怀抱，而阿呆和阿毛纷纷付出了生命的代价。' },
    { id: 'r-ct', roomId: 'room-ct', name: '开普敦', lon: 18.42, lat: -33.92, status: 'online', title: '《第九区》', people: 1, alwaysExpanded: true, ownerType: 'system', countryCode: 'ZA', city: '开普敦', country: '南非', coverUrl: 'https://image.tmdb.org/t/p/w780/jhM3wgWUrrOkz9r4xwV5cV5RhI4.jpg', descriptionZh: '1990 年，一艘巨大的飞船出现在地球上空，人们惶恐不安，却又分外好奇。经过一段时间紧张的等待，外星飞船始终没有动静。人类终于小心翼翼靠近它，强行走进舱内，结果发现了不计其数的外星人。他们形容丑陋，宛如虾子，而且健康状况极差，虚弱无力。原来这是一群来自外星的难民，他们最终被地球人接纳，并隔离在南非约翰内斯堡的一片区域内生活，此地名为“第九区”。经过长达 20 年的繁衍，外星难民的数量扩张至 180 万之多，且和周边人类的矛盾冲突不断，越来越多的人类呼吁将“大虾”赶出地球。MNU（列国同盟组织）经过磋商，决定将外星难民迁移到更为偏远的区域。MNU 外星事务部门的特工威库斯（Sharlto Copley 饰）专门负责搬迁工作。威库斯在动员过程中傲慢随意，与当地居民冲突频频。最终，他为自己的行为付出代价，外星人的神秘流体将其感染，威库斯慢慢变成了外星人的模样。此时威库斯才真正体会到了外星移民在地球上受到的不公待遇，他决定做些什么改变局面……' },
    { id: 'r-mb', roomId: 'room-mb', name: '孟买', lon: 72.88, lat: 19.08, status: 'playing', title: '《三傻》', people: 6, alwaysExpanded: true, ownerType: 'system', countryCode: 'IN', city: '孟买', country: '印度', coverUrl: 'https://image.tmdb.org/t/p/w780/u7kuUaySqXBVAtqEl9vkTkAzHV9.jpg', descriptionZh: '十年前，法兰、拉杜与兰乔在印度顶尖的皇家工程学院相识并成为好友。面对竞争激烈、崇尚成绩与服从的教育环境，特立独行的兰乔始终坚持真正的学习来自兴趣与理解，并一次次挑战校长“病毒”的教育理念。他的想法也逐渐影响着背负家庭期待的法兰和拉杜，鼓励两人重新思考自己真正想要的人生。与此同时，兰乔与信奉死记硬背的模范生“消音器”针锋相对，两人甚至立下十年后再论成败的约定。十年过去，当法兰和拉杜再次踏上寻找这位昔日好友的旅程，那段关于友情、梦想与选择的大学往事也随之重新浮现……' },
    { id: 'r-ms', roomId: 'room-ms', name: '莫斯科', lon: 37.62, lat: 55.76, status: 'online', title: '《潜行者》', people: 2, alwaysExpanded: true, ownerType: 'system', countryCode: 'RU', city: '莫斯科', country: '俄罗斯', coverUrl: 'https://image.tmdb.org/t/p/w780/6yrbWzzrPp7pwz6zHdifspJk8t3.jpg', descriptionZh: '安德烈·塔可夫斯基在苏联时期的最后一部作品，是一次穿越神秘后末日景观的形而上学旅程，亦是一场独一无二的精妙观影体验。受雇的向导——“潜行者”——带领一位作家和一位教授深入“区”的核心地带，这个长期封闭的灾难禁区中，三人最终逼近了传说中的“房间”：一个据称能实现人内心深处最隐秘愿望的地方。改编自阿尔卡季与鲍里斯·斯特鲁加茨基兄弟的科幻小说，塔可夫斯基以丰富的物质细节和有机的氛围感，构建出一个沉浸式的世界。作为一则宗教寓言、对当时政治焦虑的反思，亦或是对电影本身的冥想——本片通过展开多重可能的意涵，将观众全然包围。[标准收藏]' }
  ];

  // 由 roomId 稳定散列出色相（对齐 hearthere「每座灯塔有自己的颜色」）
  function hashHue(str) {
    var h = 2166136261;
    var s = String(str || 'x');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    // lowbias32 雪崩终结器（Chris Wellons）：FNV 终值高位对同前缀等长 id 相关，
    // 十演示房色相曾全挤红黄绿段（0.057–0.379）→ 混匀后铺满全色环
    var z = h >>> 0;
    z ^= z >>> 16; z = Math.imul(z, 0x7feb352d);
    z ^= z >>> 15; z = Math.imul(z, 0x846ca68b);
    z ^= z >>> 16;
    return (z >>> 0) / 4294967296;
  }
  function hueToRgb(h) {
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var q = 1 - f;
    switch (i % 6) {
      case 0: return [1, f, 0];
      case 1: return [q, 1, 0];
      case 2: return [0, 1, f];
      case 3: return [0, q, 1];
      case 4: return [f, 0, 1];
      default: return [1, 0, q];
    }
  }
  function colorsFor(id) {
    // deck 消费端 toColorVec（hearthere Ai :11338-11341）按 0..255 输入 /255 归一，
    // 此处必须输出 0..255 刻度（修复轮⑧b：曾输出 0..1 → 真实房间灯塔近黑）
    var top = hueToRgb(hashHue(id));
    return {
      colorTop: top.map(function (v) { return Math.round(v * 255); }),
      colorBottom: top.map(function (v) { return Math.round(v * 255 * 0.32); })
    };
  }

  // 轮㉓-C：演示房与真实房同权装配散列色——此前 mergeWithDemo/降级支路裸推
  // DEMO_ROOMS（无 colorTop）→ roomToStation 落默认薰衣草 → 十塔同色
  DEMO_ROOMS.forEach(function (d) {
    var c = colorsFor(d.roomId || d.id);
    d.colorTop = c.colorTop;
    d.colorBottom = c.colorBottom;
  });

  // 轮㉖（用户裁决 2026-10-03）：灯塔基座 = 各国实时热映（SFV.worldMovies），
  // 有 live 即在球、顶掉演示十塔；无 live（模块缺席/全败）回落 DEMO_ROOMS。
  // live 站不经 normalize（字段已是站形状，normalize 会剥掉 countryCode/city 等），
  // 装配期补 colorsFor 上色（㉓ 教训：缺 colorTop 全落默认薰衣草）。
  function baseStations() {
    var live = [];
    try {
      var lm = SFV.worldMovies;
      var arr = lm && lm.stations ? lm.stations() : [];
      if (Array.isArray(arr)) live = arr;
    } catch (e) { /* live 源异常不炸数据面，回落演示 */ }
    if (!live.length) return DEMO_ROOMS.slice();
    return live.map(function (s) {
      var o = Object.assign({}, s);
      if (!o.colorTop) {
        var c = colorsFor(o.roomId || o.id);
        o.colorTop = c.colorTop;
        o.colorBottom = c.colorBottom;
      }
      return o;
    });
  }

  function currentCoverUrl(r) {
    try {
      var ws = SFV.worldSync;
      var cur = ws && ws.currentTrack ? ws.currentTrack(r, Date.now()) : null;
      return cur && cur.cover ? cur.cover : '';
    } catch (e) { return ''; }
  }

  function normalize(r) {
    if (!r) return null;
    var roomId = r.roomId || r.id;
    var c = colorsFor(roomId);
    var coverUrl = currentCoverUrl(r);
    return {
      id: 'room-' + roomId,
      roomId: roomId,
      name: r.name || '放映房间',
      lon: Number(r.lon) || 0,
      lat: Number(r.lat) || 0,
      status: r.status === 'playing' ? 'playing' : 'online',
      title: r.title || '一起看',
      people: Number(r.people) || 1,
      // Task 7：queue_update 进度面透传（world-sync.currentTrack 消费）；
      // status 枚举映射保持原样，渲染层语义不回退
      playlist: r.playlist || null,
      // 轮㉔：当前轨海报 = 灯塔提色色源（缺位不造值，deck applyPosterColor 空串短路）
      coverUrl: coverUrl || undefined,
      lastHeartbeat: Number(r.lastHeartbeat) || 0,
      colorTop: c.colorTop,
      colorBottom: c.colorBottom,
      // 步骤③：塔身展开谓词（hearthere :13262）要求 alwaysExpanded/system/自建三者之一；
      // 本地放映房间按用户裁决走数据层标记，渲染层谓词保持逐字
      alwaysExpanded: true
    };
  }

  // ============================================================
  //  方案 A（2026-10-01 用户裁决）：创建放映落塔 = 离线城市词典命中 → 城市坐标；
  //  未命中 → 调用方落回视野中心。不联网、不新增依赖（符合仓库铁律）。
  //  key 全小写；中文名原样 + 常见英文名各一条。济宁坐标与用户实测(116.59,35.41)一致。
  // ============================================================
  var CITY_COORDS = {
    // —— 中国 ——
    '北京': { lon: 116.41, lat: 39.90 }, 'beijing': { lon: 116.41, lat: 39.90 },
    '上海': { lon: 121.47, lat: 31.23 }, 'shanghai': { lon: 121.47, lat: 31.23 },
    '广州': { lon: 113.26, lat: 23.13 }, 'guangzhou': { lon: 113.26, lat: 23.13 },
    '深圳': { lon: 114.06, lat: 22.54 }, 'shenzhen': { lon: 114.06, lat: 22.54 },
    '杭州': { lon: 120.16, lat: 30.27 }, 'hangzhou': { lon: 120.16, lat: 30.27 },
    '南京': { lon: 118.78, lat: 32.06 }, 'nanjing': { lon: 118.78, lat: 32.06 },
    '武汉': { lon: 114.30, lat: 30.59 }, 'wuhan': { lon: 114.30, lat: 30.59 },
    '成都': { lon: 104.07, lat: 30.57 }, 'chengdu': { lon: 104.07, lat: 30.57 },
    '重庆': { lon: 106.55, lat: 29.56 }, 'chongqing': { lon: 106.55, lat: 29.56 },
    '西安': { lon: 108.94, lat: 34.34 }, 'xian': { lon: 108.94, lat: 34.34 },
    '济宁': { lon: 116.59, lat: 35.41 }, 'jining': { lon: 116.59, lat: 35.41 },
    '天津': { lon: 117.20, lat: 39.13 }, 'tianjin': { lon: 117.20, lat: 39.13 },
    '苏州': { lon: 120.62, lat: 31.32 }, 'suzhou': { lon: 120.62, lat: 31.32 },
    '长沙': { lon: 112.94, lat: 28.23 }, 'changsha': { lon: 112.94, lat: 28.23 },
    '郑州': { lon: 113.63, lat: 34.75 }, 'zhengzhou': { lon: 113.63, lat: 34.75 },
    '青岛': { lon: 120.38, lat: 36.07 }, 'qingdao': { lon: 120.38, lat: 36.07 },
    '沈阳': { lon: 123.43, lat: 41.80 }, 'shenyang': { lon: 123.43, lat: 41.80 },
    '大连': { lon: 121.62, lat: 38.91 }, 'dalian': { lon: 121.62, lat: 38.91 },
    '厦门': { lon: 118.09, lat: 24.48 }, 'xiamen': { lon: 118.09, lat: 24.48 },
    '福州': { lon: 119.30, lat: 26.08 }, 'fuzhou': { lon: 119.30, lat: 26.08 },
    '昆明': { lon: 102.83, lat: 24.88 }, 'kunming': { lon: 102.83, lat: 24.88 },
    '贵阳': { lon: 106.63, lat: 26.65 }, 'guiyang': { lon: 106.63, lat: 26.65 },
    '兰州': { lon: 103.83, lat: 36.06 }, 'lanzhou': { lon: 103.83, lat: 36.06 },
    '乌鲁木齐': { lon: 87.62, lat: 43.79 }, 'urumqi': { lon: 87.62, lat: 43.79 },
    '拉萨': { lon: 91.14, lat: 29.66 }, 'lhasa': { lon: 91.14, lat: 29.66 },
    '哈尔滨': { lon: 126.53, lat: 45.80 }, 'harbin': { lon: 126.53, lat: 45.80 },
    '济南': { lon: 117.12, lat: 36.65 }, 'jinan': { lon: 117.12, lat: 36.65 },
    '无锡': { lon: 120.30, lat: 31.57 }, 'wuxi': { lon: 120.30, lat: 31.57 },
    '宁波': { lon: 121.55, lat: 29.88 }, 'ningbo': { lon: 121.55, lat: 29.88 },
    '合肥': { lon: 117.28, lat: 31.86 }, 'hefei': { lon: 117.28, lat: 31.86 },
    '南昌': { lon: 115.89, lat: 28.68 }, 'nanchang': { lon: 115.89, lat: 28.68 },
    '太原': { lon: 112.55, lat: 37.87 }, 'taiyuan': { lon: 112.55, lat: 37.87 },
    '石家庄': { lon: 114.51, lat: 38.04 }, 'shijiazhuang': { lon: 114.51, lat: 38.04 },
    '南宁': { lon: 108.37, lat: 22.82 }, 'nanning': { lon: 108.37, lat: 22.82 },
    '海口': { lon: 110.20, lat: 20.04 }, 'haikou': { lon: 110.20, lat: 20.04 },
    '银川': { lon: 106.23, lat: 38.49 }, 'yinchuan': { lon: 106.23, lat: 38.49 },
    '西宁': { lon: 101.78, lat: 36.62 }, 'xining': { lon: 101.78, lat: 36.62 },
    '呼和浩特': { lon: 111.75, lat: 40.84 }, 'hohhot': { lon: 111.75, lat: 40.84 },
    '东莞': { lon: 113.75, lat: 23.02 }, 'dongguan': { lon: 113.75, lat: 23.02 },
    '佛山': { lon: 113.12, lat: 23.02 }, 'foshan': { lon: 113.12, lat: 23.02 },
    '温州': { lon: 120.70, lat: 28.00 }, 'wenzhou': { lon: 120.70, lat: 28.00 },
    '烟台': { lon: 121.45, lat: 37.46 }, 'yantai': { lon: 121.45, lat: 37.46 },
    '洛阳': { lon: 112.45, lat: 34.62 }, 'luoyang': { lon: 112.45, lat: 34.62 },
    // —— 东亚 ——
    '东京': { lon: 139.69, lat: 35.69 }, 'tokyo': { lon: 139.69, lat: 35.69 },
    '大阪': { lon: 135.50, lat: 34.69 }, 'osaka': { lon: 135.50, lat: 34.69 },
    '名古屋': { lon: 136.91, lat: 35.18 }, 'nagoya': { lon: 136.91, lat: 35.18 },
    '札幌': { lon: 141.35, lat: 43.07 }, 'sapporo': { lon: 141.35, lat: 43.07 },
    '福冈': { lon: 130.40, lat: 33.59 }, 'fukuoka': { lon: 130.40, lat: 33.59 },
    '首尔': { lon: 126.98, lat: 37.57 }, 'seoul': { lon: 126.98, lat: 37.57 },
    '釜山': { lon: 129.04, lat: 35.11 }, 'busan': { lon: 129.04, lat: 35.11 },
    // —— 东南亚 / 南亚 / 中东 ——
    '新加坡': { lon: 103.82, lat: 1.35 }, 'singapore': { lon: 103.82, lat: 1.35 },
    '曼谷': { lon: 100.50, lat: 13.75 }, 'bangkok': { lon: 100.50, lat: 13.75 },
    '吉隆坡': { lon: 101.69, lat: 3.14 }, 'kuala lumpur': { lon: 101.69, lat: 3.14 },
    '雅加达': { lon: 106.85, lat: -6.21 }, 'jakarta': { lon: 106.85, lat: -6.21 },
    '马尼拉': { lon: 120.98, lat: 14.60 }, 'manila': { lon: 120.98, lat: 14.60 },
    '河内': { lon: 105.85, lat: 21.03 }, 'hanoi': { lon: 105.85, lat: 21.03 },
    '胡志明市': { lon: 106.66, lat: 10.78 }, 'ho chi minh': { lon: 106.66, lat: 10.78 },
    '孟买': { lon: 72.88, lat: 19.08 }, 'mumbai': { lon: 72.88, lat: 19.08 },
    '德里': { lon: 77.21, lat: 28.61 }, 'delhi': { lon: 77.21, lat: 28.61 },
    '新德里': { lon: 77.21, lat: 28.61 }, 'new delhi': { lon: 77.21, lat: 28.61 },
    '加尔各答': { lon: 88.36, lat: 22.57 }, 'kolkata': { lon: 88.36, lat: 22.57 },
    '班加罗尔': { lon: 77.59, lat: 12.97 }, 'bangalore': { lon: 77.59, lat: 12.97 },
    '卡拉奇': { lon: 67.01, lat: 24.86 }, 'karachi': { lon: 67.01, lat: 24.86 },
    '德黑兰': { lon: 51.39, lat: 35.69 }, 'tehran': { lon: 51.39, lat: 35.69 },
    '迪拜': { lon: 55.27, lat: 25.20 }, 'dubai': { lon: 55.27, lat: 25.20 },
    '利雅得': { lon: 46.72, lat: 24.71 }, 'riyadh': { lon: 46.72, lat: 24.71 },
    '伊斯坦布尔': { lon: 28.98, lat: 41.01 }, 'istanbul': { lon: 28.98, lat: 41.01 },
    // —— 欧洲 ——
    '伦敦': { lon: -0.13, lat: 51.51 }, 'london': { lon: -0.13, lat: 51.51 },
    '巴黎': { lon: 2.35, lat: 48.86 }, 'paris': { lon: 2.35, lat: 48.86 },
    '柏林': { lon: 13.40, lat: 52.52 }, 'berlin': { lon: 13.40, lat: 52.52 },
    '罗马': { lon: 12.50, lat: 41.90 }, 'rome': { lon: 12.50, lat: 41.90 },
    '马德里': { lon: -3.70, lat: 40.42 }, 'madrid': { lon: -3.70, lat: 40.42 },
    '阿姆斯特丹': { lon: 4.90, lat: 52.37 }, 'amsterdam': { lon: 4.90, lat: 52.37 },
    '维也纳': { lon: 16.37, lat: 48.21 }, 'vienna': { lon: 16.37, lat: 48.21 },
    '苏黎世': { lon: 8.54, lat: 47.37 }, 'zurich': { lon: 8.54, lat: 47.37 },
    '斯德哥尔摩': { lon: 18.07, lat: 59.33 }, 'stockholm': { lon: 18.07, lat: 59.33 },
    '奥斯陆': { lon: 10.75, lat: 59.91 }, 'oslo': { lon: 10.75, lat: 59.91 },
    '赫尔辛基': { lon: 24.94, lat: 60.17 }, 'helsinki': { lon: 24.94, lat: 60.17 },
    '哥本哈根': { lon: 12.57, lat: 55.68 }, 'copenhagen': { lon: 12.57, lat: 55.68 },
    '华沙': { lon: 21.01, lat: 52.23 }, 'warsaw': { lon: 21.01, lat: 52.23 },
    '布拉格': { lon: 14.42, lat: 50.08 }, 'prague': { lon: 14.42, lat: 50.08 },
    '布达佩斯': { lon: 19.04, lat: 47.50 }, 'budapest': { lon: 19.04, lat: 47.50 },
    '雅典': { lon: 23.73, lat: 37.98 }, 'athens': { lon: 23.73, lat: 37.98 },
    '莫斯科': { lon: 37.62, lat: 55.76 }, 'moscow': { lon: 37.62, lat: 55.76 },
    // —— 非洲 ——
    '开罗': { lon: 31.24, lat: 30.04 }, 'cairo': { lon: 31.24, lat: 30.04 },
    '拉各斯': { lon: 3.38, lat: 6.52 }, 'lagos': { lon: 3.38, lat: 6.52 },
    '开普敦': { lon: 18.42, lat: -33.92 }, 'cape town': { lon: 18.42, lat: -33.92 },
    '约翰内斯堡': { lon: 28.05, lat: -26.20 }, 'johannesburg': { lon: 28.05, lat: -26.20 },
    '内罗毕': { lon: 36.82, lat: -1.29 }, 'nairobi': { lon: 36.82, lat: -1.29 },
    // —— 北美 ——
    '纽约': { lon: -74.01, lat: 40.71 }, 'new york': { lon: -74.01, lat: 40.71 },
    '洛杉矶': { lon: -118.24, lat: 34.05 }, 'los angeles': { lon: -118.24, lat: 34.05 },
    '旧金山': { lon: -122.42, lat: 37.77 }, 'san francisco': { lon: -122.42, lat: 37.77 },
    '芝加哥': { lon: -87.63, lat: 41.88 }, 'chicago': { lon: -87.63, lat: 41.88 },
    '多伦多': { lon: -79.38, lat: 43.65 }, 'toronto': { lon: -79.38, lat: 43.65 },
    '温哥华': { lon: -123.12, lat: 49.28 }, 'vancouver': { lon: -123.12, lat: 49.28 },
    '墨西哥城': { lon: -99.13, lat: 19.43 }, 'mexico city': { lon: -99.13, lat: 19.43 },
    '哈瓦那': { lon: -82.38, lat: 23.11 }, 'havana': { lon: -82.38, lat: 23.11 },
    '火奴鲁鲁': { lon: -157.86, lat: 21.31 }, 'honolulu': { lon: -157.86, lat: 21.31 },
    '檀香山': { lon: -157.86, lat: 21.31 },
    // —— 南美 ——
    '圣保罗': { lon: -46.63, lat: -23.55 }, 'sao paulo': { lon: -46.63, lat: -23.55 },
    '里约': { lon: -43.17, lat: -22.91 }, 'rio': { lon: -43.17, lat: -22.91 },
    '里约热内卢': { lon: -43.17, lat: -22.91 }, 'rio de janeiro': { lon: -43.17, lat: -22.91 },
    '布宜诺斯艾利斯': { lon: -58.38, lat: -34.60 }, 'buenos aires': { lon: -58.38, lat: -34.60 },
    '利马': { lon: -77.04, lat: -12.05 }, 'lima': { lon: -77.04, lat: -12.05 },
    '波哥大': { lon: -74.07, lat: 4.61 }, 'bogota': { lon: -74.07, lat: 4.61 },
    '圣地亚哥': { lon: -70.67, lat: -33.45 }, 'santiago': { lon: -70.67, lat: -33.45 },
    // —— 大洋洲 ——
    '悉尼': { lon: 151.21, lat: -33.87 }, 'sydney': { lon: 151.21, lat: -33.87 },
    '墨尔本': { lon: 144.96, lat: -37.81 }, 'melbourne': { lon: 144.96, lat: -37.81 },
    '堪培拉': { lon: 149.13, lat: -35.31 }, 'canberra': { lon: 149.13, lat: -35.31 },
    '奥克兰': { lon: 174.76, lat: -36.85 }, 'auckland': { lon: 174.76, lat: -36.85 },
    '惠灵顿': { lon: 174.78, lat: -41.29 }, 'wellington': { lon: 174.78, lat: -41.29 }
  };

  // 命中返回 {lon,lat} 拷贝，未命中返回 null（调用方落回视野中心）。
  // 匹配顺序：原样 trim → 小写 → 去掉结尾「市」 → 去「市」后小写。
  function cityLookup(name) {
    if (name == null) return null;
    var raw = String(name).trim();
    if (!raw) return null;
    var lower = raw.toLowerCase();
    var hit = CITY_COORDS[raw] || CITY_COORDS[lower];
    if (!hit && /市$/.test(raw)) {
      var stripped = raw.slice(0, -1);
      hit = CITY_COORDS[stripped] || CITY_COORDS[stripped.toLowerCase()];
    }
    return hit ? { lon: hit.lon, lat: hit.lat } : null;
  }

  function get(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (typeof fetch !== 'function') { reject(new Error('NO_FETCH')); return; }
      var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('TIMEOUT'));
      }, timeoutMs || 12000);
      fetch(url, ctrl ? { signal: ctrl.signal } : undefined).then(function (r) {
        clearTimeout(timer);
        if (!r.ok) {
          return r.json().then(function (body) {
            var msg = (body && (body.message || body.error)) || ('HTTP_' + r.status);
            throw new Error(msg);
          }, function () {
            throw new Error('HTTP_' + r.status);
          });
        }
        return r.json();
      }).then(function (j) {
        clearTimeout(timer);
        resolve(j);
      }, function (e) {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  // A4（修复轮⑥）：真实房间与演示灯塔 merge 共存（用户裁决）。
  // 旧语义「真实≥1 → 全量替换」会把 10 座演示灯塔从地球上抹掉，
  // 用户感知为「创建了灯塔，其他灯塔全没了」。现真实在前、按 roomId 去重。
  function mergeWithDemo(realRooms) {
    var seen = {};
    var out = [];
    (realRooms || []).forEach(function (r) {
      if (!r) return;
      if (r.roomId) seen['rid:' + r.roomId] = true;
      if (r.id) seen['id:' + r.id] = true;
      out.push(r);
    });
    baseStations().forEach(function (d) {
      if (seen['rid:' + d.roomId] || seen['id:' + d.id]) return;
      out.push(d);
    });
    return out;
  }

  /**
   * 拉取开放的「一起看」房间。
   * @param {object} opts { limit }
   * @returns {Promise<{ok, count, rooms, source, degraded}>}
   */
  function fetchRooms(opts) {
    opts = opts || {};
    return get('api/rooms', 12000).then(function (j) {
      if (j && j.ok && Array.isArray(j.rooms)) {
        var rooms = mergeWithDemo(j.rooms.map(normalize).filter(Boolean));
        if (opts.limit) rooms = rooms.slice(0, opts.limit);
        if (rooms.length) {
          lastResult = { ok: true, count: rooms.length, rooms: rooms, source: '本地房间信令', degraded: false };
          return lastResult;
        }
      }
      throw new Error('EMPTY');
    }).catch(function (e) {
      console.warn('[world-data] 拉取放映房间失败，降级演示房间', e && e.message);
      var demo = baseStations();
      if (opts.limit) demo = demo.slice(0, opts.limit);
      lastResult = {
        ok: true,
        count: demo.length,
        rooms: demo,
        source: '演示房间（' + (e && e.message ? e.message : '房间服务不可达') + '）',
        degraded: true
      };
      return lastResult;
    });
  }

  function demoRooms() {
    return DEMO_ROOMS.slice();
  }

  SFV.worldData = {
    fetchRooms: fetchRooms,
    demoRooms: demoRooms,
    normalize: normalize,
    cityLookup: cityLookup,
    CITY_COORDS: CITY_COORDS,
    get lastResult() { return lastResult; }
  };
})(typeof window !== 'undefined' ? window : this);
