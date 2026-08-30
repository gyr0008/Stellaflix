/*
 * Stellaflix 影视模块 — 播放器纯层核心 (T-#6-序6)
 *
 * 从 public/video/player.js 抽取的零依赖纯函数：
 *   fmt / extractEpisode / normalizeAnimeName
 * 不触碰 DOM / localStorage / SFV.* 命名空间，可独立单测与 vm 沙箱验证。
 *
 * 须先于 player.js 加载（index.html 与脚本加载数组均已插入）。
 * 幂等守卫：重复加载安全跳过，不覆盖已注册 facade。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.playerCore) return; // 幂等守卫

  // 时长格式化：秒 → "m:ss"（区别于 home.js 的 fmtTime 中文格式）
  function fmt(sec) {
    sec = Math.max(0, sec | 0);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  // 从标题提取集数（对齐 Kazumi extractEpisodeNumber）
  // 匹配：第3集 / 第03话 / 第12集 / EP03 / E.5 / S01E05 / 01-05 / 第3期 等
  function extractEpisode(title) {
    if (!title) return null;
    var patterns = [
      /(?:第\s*(\d+)\s*[话集季期])/i,           // 第3集 / 第03话 / 第12季
      /[Ss](\d{1,2})\s*[Ee]?[Pp]?(\d{1,2})/,   // S01E05 / S1EP3（取 episode）
      /(?:EP|[Ee])[Pp]?\s*\.?\s*(\d+)/i,        // EP03 / ep3 / E.5
      /(\d{1,2})\s*-\s*\d{1,2}/,                // 01-05 / 1-12（取后半部分）
      /\.(\d{1,3})\./,                           // 点分集数：.03. / .12.（CMS10 常见命名）
      /\s-\s*(\d{1,3})(?:\s|$|\[)/,              // 独立横杠集数：- 12 / - 12 [1080p]
      /^(\d{1,2})(?!\d)/                          // 纯数字开头：03 / 12
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = title.match(patterns[i]);
      if (m) {
        // S01E05 格式返回第二个捕获组（E 部分）
        var num = m[m.length - 1]; // 取最后一个捕获组
        if (num) return parseInt(num, 10) || null;
      }
    }
    return null;
  }

  // 番名归一化：去除集数标记与分辨率/编码后缀，仅用于弹弹play 搜索关键词，
  // 提升「脏标题（如 进击的巨人.03.BDRip）」的番剧匹配率。集数已由 extractEpisode 单独提取。
  function normalizeAnimeName(title) {
    if (!title) return title;
    var t = String(title);
    // 先按站点标签分隔符 ' · ' 截断，只保留番名部分
    // 标题格式 {番名} · {标签}，标签可能是"正片"/"线路A"/"第X话"等站点标记，
    // 混入搜索词会导致弹弹play 匹配失败（DANMAKU_NO_EPISODE）。比枚举标签词更稳。
    t = t.split(' · ')[0];
    // 0) 去除方括号源标记 / 分辨率（如 [AGE] / [1080p]，Kazumi 规则源常见）
    t = t.replace(/\[[^\]]*\]/g, ' ');
    // 1) 去除集数标记（保留本函数仅用于番名搜索）
    t = t.replace(/(?:第\s*\d+\s*[话集季期])|[Ss]\d{1,2}[Ee][Pp]?\d{1,2}|(?:[Ee][Pp]?\s*\.?\s*\d+)|(?:\.\s*\d{1,3}\s*\.)|(?:\s*-\s*\d{1,3}(?:\s|$))/g, ' ');
    // 2) 去除常见后缀噪声（分辨率/编码/封装）
    t = t.replace(/\b(?:BDRip|BRRip|WEB[-]?DL|WEBRip|HDTV|HDRip|DVDRip|BluRay|BD|AAC|FLAC|MP4|MKV|AVI|HEVC|x264|x265|10bit|8bit|2160p|1080p|720p|4K|H264|H265)\b/gi, ' ');
    // 3) 统一分隔符并清理多余空格
    t = t.replace(/[._•·]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return t;
  }

  // 选集身份值对象（对齐 F5：与 Kazumi VideoEpisodeSelection {episode, road} 同构）。
  // 内容相等（equals）、可生成稳定 key / 确定性 hash，用于跨线路相等比较与观看历史键。
  function makeEpisodeSelection(road, episode) {
    var r = road | 0, e = episode | 0;
    return {
      road: r,
      episode: e,
      equals: function (o) {
        return !!(o && o.road === r && o.episode === e);
      },
      hash: function () {
        // 确定性哈希：road*31 + episode（与 Kazumi Object.hash(episode, road) 语义一致）
        return r * 31 + e;
      },
      key: function () {
        return r + ':' + e;
      },
      toString: function () {
        return 'EpisodeSelection(road:' + r + ', episode:' + e + ')';
      }
    };
  }

  SFV.playerCore = {
    fmt: fmt,
    extractEpisode: extractEpisode,
    normalizeAnimeName: normalizeAnimeName,
    makeEpisodeSelection: makeEpisodeSelection
  };
})(typeof window !== 'undefined' ? window : this);
