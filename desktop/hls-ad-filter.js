'use strict';

/**
 * HLS 广告分片过滤（discontinuity 分组启发式）
 * ----------------------------------------------------------------------------
 * 与 Kazumi M3u8AdFilter 同源思路，落到 Stellaflix /api/proxy：
 *   - 按 #EXT-X-DISCONTINUITY 分组
 *   - 最长组视为正片，永不删除
 *   - 中插：组时长 < 正片 30% → 广告
 *   - 首尾：组时长 < 45s 且 < 正片 15% → 广告（保留约 60–100s 的 ED/预告）
 *   - 任意非正片组 < 10s → 广告
 *   - 过滤结果为空 → 原样返回
 *
 * 重写策略：按行保留标签（KEY/MAP/DATERANGE 等），只丢弃广告 EXTINF+URI，
 * 以及「只包住广告、前后无正片」的 DISCONTINUITY。
 *
 * 纯 Node 模块，无 Electron 依赖，可在 tests/ 直接 require。
 */

function resolveUrl(baseUrl, ref) {
  if (!ref) return ref;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) return ref;
  try {
    return new URL(ref, baseUrl).toString();
  } catch (e) {
    return ref;
  }
}

function parseSegments(content, baseUrl) {
  const lines = content.split(/\r?\n/);
  const segments = [];
  let group = 0;
  let duration = 0;
  let sawExtinf = false;

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (t === '#EXT-X-DISCONTINUITY') {
      group += 1;
      continue;
    }
    if (t.toUpperCase().startsWith('#EXTINF:')) {
      const num = t.slice(8).split(',')[0];
      duration = parseFloat(num);
      if (!isFinite(duration)) duration = 0;
      sawExtinf = true;
      continue;
    }
    if (t.charAt(0) === '#') continue;
    // URI line
    segments.push({
      uri: t,
      resolved: resolveUrl(baseUrl, t),
      duration: duration,
      group: group,
    });
    duration = 0;
    sawExtinf = false;
  }
  void sawExtinf;
  return segments;
}

function identifyAdGroups(segments) {
  if (!segments || segments.length === 0) return { adGroups: new Set(), maxDuration: 0 };

  const groups = new Map();
  for (const seg of segments) {
    if (!groups.has(seg.group)) groups.set(seg.group, []);
    groups.get(seg.group).push(seg);
  }
  if (groups.size <= 1) return { adGroups: new Set(), maxDuration: 0 };

  const durations = new Map();
  let maxDuration = 0;
  for (const [gid, list] of groups) {
    let sum = 0;
    for (const s of list) sum += s.duration;
    durations.set(gid, sum);
    if (sum > maxDuration) maxDuration = sum;
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => a - b);
  const firstKey = sortedKeys[0];
  const lastKey = sortedKeys[sortedKeys.length - 1];
  const adGroups = new Set();

  for (const gid of sortedKeys) {
    const d = durations.get(gid);
    if (d === maxDuration) continue;

    let isAd = false;
    const isEdge = gid === firstKey || gid === lastKey;

    if (isEdge) {
      if (d < 45.0 && d < maxDuration * 0.15) isAd = true;
    } else if (d < maxDuration * 0.3) {
      isAd = true;
    }
    if (d < 10.0) isAd = true;

    if (isAd) adGroups.add(gid);
  }

  return { adGroups, maxDuration };
}

/**
 * 过滤 media playlist 文本。master playlist（含 #EXT-X-STREAM-INF）原样返回。
 * @param {string} content
 * @param {string} baseUrl 用于解析相对分片 URI
 * @returns {{content: string, removed: number, changed: boolean, reason: string}}
 */
function filterHlsAds(content, baseUrl) {
  if (typeof content !== 'string' || content.length === 0) {
    return { content: content, removed: 0, changed: false, reason: 'empty' };
  }
  if (content.indexOf('#EXT-X-STREAM-INF') !== -1) {
    return { content: content, removed: 0, changed: false, reason: 'master-playlist' };
  }
  if (content.indexOf('#EXTM3U') === -1 && content.indexOf('#EXTINF') === -1) {
    return { content: content, removed: 0, changed: false, reason: 'not-playlist' };
  }

  // B6 直播保护：无 #EXT-X-ENDLIST 视为直播（或被截断的不完整清单）。discontinuity
  // 分组启发式只对完整 VOD 成立；过滤直播会在每次 reload 时删掉不同分片，打乱 hls.js
  // 的媒体序列对齐导致卡死。原样放行（保守侧：宁可不过滤，不可过滤错）。
  if (content.indexOf('#EXT-X-ENDLIST') === -1) {
    return { content: content, removed: 0, changed: false, reason: 'live-playlist' };
  }

  const segments = parseSegments(content, baseUrl);
  if (segments.length === 0) {
    return { content: content, removed: 0, changed: false, reason: 'no-segments' };
  }

  const { adGroups } = identifyAdGroups(segments);
  if (adGroups.size === 0) {
    return { content: content, removed: 0, changed: false, reason: 'no-ads' };
  }

  // B5 正片保护：原实现把"组归属"换算成"URI 身份"再删 —— 广告组与正片组复用同一
  // 分片 URI 时（部分源站广告直接插正片转场），正片组里的原份会被连带误删，违反
  // 文件头"最长组永不删除"的承诺。改为按"出现位置"删除：广告组的出现照删（含复用
  // URI 的那份），非广告组的出现绝不动。组归属到位置是无损映射，不经过 URI。
  const dropOccurrences = new Set(); // segments 数组下标 → 该出现要删
  for (let i = 0; i < segments.length; i++) {
    if (adGroups.has(segments[i].group)) dropOccurrences.add(i);
  }

  const lines = content.split(/\r?\n/);
  const out = [];
  let bufferedDisc = null;
  let bufferedExtinf = null;
  let uriIndex = 0; // URI 出现序号，与 parseSegments 的收集顺序一一对应

  for (const line of lines) {
    const t = line.trim();

    if (t === '#EXT-X-DISCONTINUITY') {
      bufferedDisc = line;
      continue;
    }
    if (t.toUpperCase().startsWith('#EXTINF:')) {
      bufferedExtinf = line;
      continue;
    }

    if (t && t.charAt(0) !== '#') {
      // B5：按出现位置判定 —— parseSegments 只在 URI 行收集 segment，
      // 故 uriIndex 与 segments 下标一一对应。
      if (dropOccurrences.has(uriIndex)) {
        uriIndex += 1;
        bufferedExtinf = null;
        bufferedDisc = null;
        continue;
      }
      uriIndex += 1;
      if (bufferedDisc) { out.push(bufferedDisc); bufferedDisc = null; }
      if (bufferedExtinf) { out.push(bufferedExtinf); bufferedExtinf = null; }
      out.push(line);
      continue;
    }

    // 其它标签行：若前面还压着 DISCONTINUITY/EXTINF，先冲刷再写标签
    if (bufferedDisc && t && t.charAt(0) === '#' && !/^#EXTINF:/i.test(t)) {
      out.push(bufferedDisc);
      bufferedDisc = null;
    }
    if (bufferedExtinf && t && t.charAt(0) === '#' && t !== '#EXT-X-DISCONTINUITY') {
      out.push(bufferedExtinf);
      bufferedExtinf = null;
    }
    out.push(line);
  }

  // 尾部残留（异常清单）原样冲出，避免丢标签
  if (bufferedDisc) out.push(bufferedDisc);
  if (bufferedExtinf) out.push(bufferedExtinf);

  const rewritten = out.join('\n');
  // 空结果保护：过滤后几乎没分片则回退
  const keptCount = segments.length - dropOccurrences.size;
  if (keptCount <= 0) {
    return { content: content, removed: 0, changed: false, reason: 'empty-after-filter' };
  }

  return {
    content: rewritten,
    removed: dropOccurrences.size,
    changed: rewritten !== content,
    reason: 'filtered',
  };
}

function looksLikeM3u8Url(url) {
  if (!url) return false;
  return /\.(m3u8|m3u)(\?|#|$)/i.test(String(url));
}

function looksLikeM3u8Text(text) {
  if (typeof text !== 'string') return false;
  const head = text.slice(0, 256).trim();
  return head.indexOf('#EXTM3U') !== -1 || head.indexOf('#EXTINF') !== -1;
}

module.exports = {
  filterHlsAds: filterHlsAds,
  parseSegments: parseSegments,
  identifyAdGroups: identifyAdGroups,
  resolveUrl: resolveUrl,
  looksLikeM3u8Url: looksLikeM3u8Url,
  looksLikeM3u8Text: looksLikeM3u8Text,
};
