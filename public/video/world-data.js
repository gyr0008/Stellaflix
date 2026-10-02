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
    { id: 'r-sh', roomId: 'room-sh', name: '上海',   lon: 121.47, lat: 31.23,  status: 'playing', title: '《星际穿越》',   people: 3, alwaysExpanded: true },
    { id: 'r-tk', roomId: 'room-tk', name: '东京',   lon: 139.69, lat: 35.69,  status: 'playing', title: '《千与千寻》',   people: 2, alwaysExpanded: true },
    { id: 'r-ny', roomId: 'room-ny', name: '纽约',   lon: -74.01, lat: 40.71,  status: 'playing', title: '《奥本海默》',   people: 5, alwaysExpanded: true },
    { id: 'r-ld', roomId: 'room-ld', name: '伦敦',   lon: -0.13,  lat: 51.51,  status: 'online',  title: '《盗梦空间》',   people: 2, alwaysExpanded: true },
    { id: 'r-pr', roomId: 'room-pr', name: '巴黎',   lon: 2.35,   lat: 48.86,  status: 'online',  title: '《天使爱美丽》', people: 1, alwaysExpanded: true },
    { id: 'r-sy', roomId: 'room-sy', name: '悉尼',   lon: 151.21, lat: -33.87, status: 'online',  title: '《疯狂的麦克斯》', people: 2, alwaysExpanded: true },
    { id: 'r-ri', roomId: 'room-ri', name: '里约',   lon: -43.17, lat: -22.91, status: 'online',  title: '《上帝之城》',   people: 4, alwaysExpanded: true },
    { id: 'r-ct', roomId: 'room-ct', name: '开普敦', lon: 18.42,  lat: -33.92, status: 'online',  title: '《第九区》',     people: 1, alwaysExpanded: true },
    { id: 'r-mb', roomId: 'room-mb', name: '孟买',   lon: 72.88,  lat: 19.08,  status: 'playing', title: '《三傻》',       people: 6, alwaysExpanded: true },
    { id: 'r-ms', roomId: 'room-ms', name: '莫斯科', lon: 37.62,  lat: 55.76,  status: 'online',  title: '《潜行者》',     people: 2, alwaysExpanded: true }
  ];

  // 由 roomId 稳定散列出色相（对齐 hearthere「每座灯塔有自己的颜色」）
  function hashHue(str) {
    var h = 2166136261;
    var s = String(str || 'x');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h) / 2147483647;
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

  function normalize(r) {
    if (!r) return null;
    var roomId = r.roomId || r.id;
    var c = colorsFor(roomId);
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
    DEMO_ROOMS.forEach(function (d) {
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
      var demo = DEMO_ROOMS.slice();
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
