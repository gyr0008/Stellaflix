/*
 * Stellaflix 影视模块 — 灯塔模式 · 模拟信标数据 (Phase 1)
 *
 * 仅用于 Phase 1 无网络功能的本地可视化验收（§八 Phase 1 目标：用模拟数据）。
 * 真实数据由 edge.js（Phase 2）从 Cloudflare 拉取，本模块届时下线或被替换。
 *
 * 海报使用内联 SVG data-URI，避免依赖网络图片，保证离线可渲染。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});
  var STATE = LH.STATE;

  function posterDataUri(title, hex) {
    var esc = String(title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="220">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + hex + '"/>' +
      '<stop offset="1" stop-color="#0b0e16"/>' +
      '</linearGradient></defs>' +
      '<rect width="160" height="220" fill="url(#g)"/>' +
      '<text x="80" y="120" font-size="22" fill="rgba(255,255,255,0.92)" ' +
      'text-anchor="middle" font-family="sans-serif">' +
      esc.slice(0, 6) + '</text></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  var CITIES = [
    { city: '北京', country: 'CN', lat: 39.9042, lng: 116.4074 },
    { city: '上海', country: 'CN', lat: 31.2304, lng: 121.4737 },
    { city: '广州', country: 'CN', lat: 23.1291, lng: 113.2644 },
    { city: '成都', country: 'CN', lat: 30.5728, lng: 104.0668 },
    { city: '杭州', country: 'CN', lat: 30.2741, lng: 120.1551 },
    { city: '武汉', country: 'CN', lat: 30.5928, lng: 114.3055 },
    { city: '西安', country: 'CN', lat: 34.3416, lng: 108.9398 },
    { city: '深圳', country: 'CN', lat: 22.5431, lng: 114.0579 },
    { city: '重庆', country: 'CN', lat: 29.5630, lng: 106.5516 },
    { city: '南京', country: 'CN', lat: 32.0603, lng: 118.7969 },
    { city: '纽约', country: 'US', lat: 40.7128, lng: -74.0060 },
    { city: '伦敦', country: 'GB', lat: 51.5074, lng: -0.1278 },
    { city: '东京', country: 'JP', lat: 35.6762, lng: 139.6503 },
    { city: '巴黎', country: 'FR', lat: 48.8566, lng: 2.3522 },
    { city: '悉尼', country: 'AU', lat: -33.8688, lng: 151.2093 }
  ];

  var PLAYING = [
    { title: '葬送的芙莉莲', season: 1, episode: 12, hex: '#5b8def', quality: '1080P' },
    { title: '进击的巨人 第三季', season: 3, episode: 5, hex: '#d9603b', quality: '1080P' },
    { title: '繁花', season: 1, episode: 20, hex: '#caa24a', quality: '4K' },
    { title: '奥本海默', season: 0, episode: 0, hex: '#7a6cc4', quality: '4K' },
    { title: '周处除三害', season: 0, episode: 0, hex: '#c44b6a', quality: '1080P' },
    { title: '蓝色监狱', season: 2, episode: 8, hex: '#3b9ec4', quality: '1080P' },
    { title: '间谍过家家', season: 2, episode: 3, hex: '#d9a23b', quality: '1080P' }
  ];

  // 生成模拟信标：前 N 个为播放中/在线，其余为 IDLE，外加若干 GHOST。
  function generateMockBeacons() {
    var out = [];
    var now = Date.now();

    // 播放中信标（带海报/片名/人数）
    for (var i = 0; i < PLAYING.length; i++) {
      var c = CITIES[i % CITIES.length];
      var p = PLAYING[i];
      out.push({
        id: 'mock-live-' + i,
        lat: c.lat, lng: c.lng, city: c.city, country: c.country,
        nickname: '灯塔' + (1000 + i),
        state: i % 5 === 0 ? STATE.JOINED_HOST : STATE.PLAYING,
        video: {
          title: p.title, season: p.season, episode: p.episode,
          posterUrl: posterDataUri(p.title, p.hex), quality: p.quality
        },
        viewers: 1 + (i % 4),
        roomCode: i % 5 === 0 ? randomCode() : null,
        lastSeen: now, isGhost: false
      });
    }

    // 仅在线（IDLE）信标
    for (var j = PLAYING.length; j < CITIES.length; j++) {
      var cc = CITIES[j];
      out.push({
        id: 'mock-idle-' + j,
        lat: cc.lat, lng: cc.lng, city: cc.city, country: cc.country,
        nickname: '灯塔' + (2000 + j),
        state: STATE.IDLE, video: null, viewers: 1, roomCode: null,
        lastSeen: now, isGhost: false
      });
    }

    // 幽灵灯（24h 内离线回放）：暗淡、无脉冲
    var ghostCities = [CITIES[3], CITIES[6], CITIES[10], CITIES[13]];
    for (var k = 0; k < ghostCities.length; k++) {
      var gc = ghostCities[k];
      var gp = PLAYING[k % PLAYING.length];
      out.push({
        id: 'mock-ghost-' + k,
        lat: gc.lat, lng: gc.lng, city: gc.city, country: gc.country,
        nickname: '灯塔' + (3000 + k),
        state: STATE.GHOST,
        video: {
          title: gp.title, season: gp.season, episode: gp.episode,
          posterUrl: posterDataUri(gp.title, gp.hex), quality: gp.quality
        },
        viewers: 0, roomCode: null,
        lastSeen: now - (3600 * 1000 * (k + 2)), isGhost: true
      });
    }

    return out;
  }

  function randomCode() {
    var s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var r = '';
    for (var i = 0; i < 6; i++) r += s[Math.floor(Math.random() * s.length)];
    return r;
  }

  LH.mock = { generateMockBeacons: generateMockBeacons, posterDataUri: posterDataUri };
})(typeof window !== 'undefined' ? window : this);
