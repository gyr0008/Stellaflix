'use strict';

/**
 * daily-hot-api.js —— 「各平台排行榜」服务端垂直切片
 *
 * 移植来源：Mineradio-LX-Music-1.7.0 server.js:2047-2466
 *（逐字摘录见本仓 .scratch/daily-hot-port-source.md §1.2-§1.9）。
 * 1:1 保持：6 小时缓存窗口与命中判定、综合榜每平台配额
 * `Math.min(60, Math.max(25, Math.ceil(limit/5)+15))`、`归一化歌名|歌手` 去重键、
 * 名次轮转交错合并、tx8/wy4/kw3/kg3/mg1 子榜目录、响应字段名与 LX 原生行字段。
 *
 * 偏离（结构性，行为不变）：
 *   1) 抓取实现改为工厂注入 `createDailyHotApi({ fetchJson, fetchText, now })`，
 *      调用形状与 LX 一致 `(url, { method, headers, body, timeoutMs })`；未注入时
 *      走本文件的 LX 原实现。LX 优先 electronNet.fetch（Chromium 栈、跟随系统代理），
 *      SF 是纯 Node → globalThis.fetch，丢失系统代理跟随（源料 §4.1）。
 *      Task 2 接真实抓取时请包装本文件导出的 `dailyHotFetchJsonDefault` /
 *      `dailyHotFetchTextDefault`（默认 UA、`referer:'https://music.163.com/'`、
 *      `redirect:'follow'`、`Number(options.timeoutMs)||12000` 都在其中）；注入一个
 *      不套用这些缺省的裸 fetcher 不是推荐路径 —— 那等于把 LX 缺省实现再抄一遍。
 *   2) dailyHotCache 由 LX 的模块单例改为工厂闭包（每实例独立，便于单测）。
 *   3) getDailyHotSongs 内 `Date.now()` → 注入的 `now()`，仅为驱动 6h 窗口测试。
 *   4) 目录常量 LX 原名 PLATFORM_CHART_CATALOG（计划文档写作 PLATFORM_CHARTS），
 *      两个名字都导出；normalizeDailyHotSong 是对 LX 三个平台映射器的分发器。
 *   5) 平台表 ['tx','wy','kw','kg','mg'] LX 在配额式与 all 分支各硬编码一次（源料 §1.9），
 *      此处抽为单一共享常量供两处共用，值、顺序与公式结果（limit=100 → 35）不变。
 */

// ====================================================================
//  Daily hot 30 recommendation
// ====================================================================
const DAILY_HOT_CACHE_MS = 6 * 60 * 60 * 1000;

function dailyHotDurationText(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function dailyHotNormalizeText(value) {
  return String(value || '').toLowerCase().replace(/&amp;/g, '&').replace(/[\s·•・,，、/\\|_\-]+/g, ' ').trim();
}
function dailyHotSingers(value) {
  if (!Array.isArray(value)) return String(value || '');
  return value.map(item => item && (item.name || item.singerName)).filter(Boolean).join('、');
}

// 偏离: LX 的 dailyHotFetchJson/dailyHotFetchText 原样保留，只把 electronNet 选择器换成 globalThis.fetch。
//       这两个缺省实现已导出（模块面 + 工厂返回值），Task 2 的真实 fetcher 应当包装它们而不是重抄
//       默认 UA / referer / redirect / 超时逻辑。
async function dailyHotFetchJsonDefault(targetUrl, options = {}) {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('FETCH_UNAVAILABLE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 12000);
  try {
    const response = await fetchImpl(targetUrl, {
      method: options.method || 'GET',
      redirect: 'follow',
      signal: controller.signal,
      body: options.body,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'referer': 'https://music.163.com/',
        ...(options.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
async function dailyHotFetchTextDefault(targetUrl, options = {}) {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('FETCH_UNAVAILABLE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 12000);
  try {
    const response = await fetchImpl(targetUrl, {
      method: options.method || 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(options.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 网易 wy

function dailyHotSongFromNeteaseTrack(item) {
  item = item || {};
  const album = item.album || item.al || {};
  const durationMs = Number(item.duration == null ? item.dt : item.duration) || 0;
  return {
    id: item.id,
    songmid: item.id,
    name: item.name || '',
    singer: dailyHotSingers(item.artists || item.ar),
    albumName: album.name || '',
    albumId: album.id || '',
    picUrl: album.picUrl || '',
    interval: dailyHotDurationText(durationMs / 1000),
    source: 'wy',
    types: ['flac', '320k', '128k'],
  };
}

// 源料注：dailyHotSongKey/dailyHotPushUnique 在本切片实际调用链外（历史死代码），按 §4.7 逐字照搬
function dailyHotSongKey(song) {
  song = song || {};
  return [
    String(song.source || '').toLowerCase(),
    String(song.songmid || song.id || song.hash || song.copyrightId || ''),
    dailyHotNormalizeText(song.name),
    dailyHotNormalizeText(song.singer || song.artist),
  ].join('|');
}
function dailyHotPushUnique(list, song, seen, limit) {
  if (!song || !song.name || list.length >= limit) return false;
  const key = dailyHotSongKey(song);
  if (seen.has(key)) return false;
  seen.add(key);
  list.push(song);
  return true;
}

// ---------------------------------------------------------------- QQ tx

function dailyHotSongFromQQRank(item) {
  item = item?.data || item || {};
  const albumMid = item.albummid || item.album?.mid || '';
  const mediaMid = item.strMediaMid || item.file?.media_mid || item.songmid || item.mid || '';
  return {
    id: item.songid || item.id,
    songmid: item.songmid || item.mid,
    name: item.songname || item.title || item.name || '',
    singer: dailyHotSingers(item.singer),
    albumName: item.albumname || item.album?.name || '',
    albumId: albumMid,
    albumMid,
    strMediaMid: mediaMid,
    picUrl: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg` : '',
    interval: dailyHotDurationText(item.interval),
    source: 'tx',
    types: ['flac', '320k', '128k'],
  };
}

// ---------------------------------------------------------------- 酷我 kw

function dailyHotSplitTopLevelArguments(text) {
  const output = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      output.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  output.push(text.slice(start).trim());
  return output;
}
function dailyHotDecodeNuxtToken(token, argumentMap) {
  token = String(token || '').trim();
  if (Object.prototype.hasOwnProperty.call(argumentMap, token) && argumentMap[token] !== token) {
    return dailyHotDecodeNuxtToken(argumentMap[token], argumentMap);
  }
  if (/^"(?:\\.|[^"\\])*"$/.test(token)) {
    try { return JSON.parse(token); } catch (_error) {}
  }
  return '';
}

// ---------------------------------------------------------------- 咪咕 mg

function dailyHotSongFromMiguRank(row) {
  const item = row?.objectInfo || row || {};
  const images = Array.isArray(item.albumImgs) ? item.albumImgs : [];
  const image = images.find(entry => String(entry?.imgSizeType) === '01') || images[0] || {};
  return {
    id:item.songId || item.contentId || item.copyrightId,
    songmid:item.songId || item.contentId || item.copyrightId,
    copyrightId:item.copyrightId || '',
    name:item.songName || item.name || '',
    singer:item.singer || dailyHotSingers(item.artists),
    albumName:item.album || item.albumName || '',
    albumId:item.albumId || '',
    picUrl:image.webpImg || image.img || '',
    interval:item.length || '',
    lrcUrl:item.lrcUrl || '',
    mrcUrl:item.mrcUrl || '',
    trcUrl:item.trcUrl || '',
    source:'mg',
    types:['flac24bit', 'flac', '320k', '128k'],
  };
}

// 偏离: LX 无统一入口，三个映射器在各抓取器内联调用；此分发器不改变任何字段语义，
//       kw/kg 的行由抓取器直接构造（上游已建好行对象），故原样返回。
//       source 先转小写再分发，'WY'/'TX' 之类大写平台码不再静默落回 raw。
function normalizeDailyHotSong(raw, source) {
  const code = String(source || '').toLowerCase();
  if (code === 'tx') return dailyHotSongFromQQRank(raw);
  if (code === 'wy') return dailyHotSongFromNeteaseTrack(raw);
  if (code === 'mg') return dailyHotSongFromMiguRank(raw);
  return raw;
}

// ---------------------------------------------------------------- 榜单目录

// 偏离: LX server.js:2358 原名 PLATFORM_CHART_CATALOG（计划文档写作 PLATFORM_CHARTS，两名字都导出）
const PLATFORM_CHART_CATALOG = {
  tx:[
    { id:'26', name:'热歌榜' }, { id:'62', name:'飙升榜' }, { id:'27', name:'新歌榜' },
    { id:'4', name:'流行指数榜' }, { id:'5', name:'内地榜' }, { id:'3', name:'欧美榜' },
    { id:'16', name:'韩国榜' }, { id:'17', name:'日本榜' },
  ],
  wy:[
    { id:'3778678', name:'热歌榜' }, { id:'19723756', name:'飙升榜' },
    { id:'3779629', name:'新歌榜' }, { id:'2884035', name:'原创榜' },
  ],
  kw:[
    { id:'16', name:'热歌榜' }, { id:'17', name:'新歌榜' }, { id:'93', name:'飙升榜' },
  ],
  kg:[
    { id:'8888', name:'TOP 500' }, { id:'6666', name:'飙升榜' }, { id:'31308', name:'新歌榜' },
  ],
  mg:[{ id:'27186466', name:'尖叫热歌榜' }],
};
function platformChartDefinition(source, chartId) {
  const rows = PLATFORM_CHART_CATALOG[source] || [];
  return rows.find(item => String(item.id) === String(chartId || '')) || rows[0] || null;
}

// ---------------------------------------------------------------- 混榜

function dailyHotContentKey(song) {
  return `${dailyHotNormalizeText(song?.name)}|${dailyHotNormalizeText(song?.singer || song?.artist)}`;
}
function mixPlatformCharts(results, limit) {
  const output = [];
  const seen = new Set();
  let row = 0;
  while (output.length < limit) {
    let added = false;
    for (const result of results) {
      const song = result?.songs?.[row];
      if (!song) continue;
      const key = dailyHotContentKey(song);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      output.push(song);
      added = true;
      if (output.length >= limit) break;
    }
    row += 1;
    if (!added && results.every(result => !result?.songs?.[row])) break;
  }
  return output;
}
// 偏离: LX 在配额式与 getDailyHotSongs 的 all 分支各硬编码一次同一张平台表（源料 §1.9 内两处）；
//       此处只留一份共享常量，两处共用，数组内容与顺序与 LX 逐字一致，
//       公式 `Math.min(60, Math.max(25, Math.ceil(limit/sources.length)+15))` 与结果（limit=100 → 35）不变。
const DAILY_HOT_SOURCES = ['tx', 'wy', 'kw', 'kg', 'mg'];

// 偏离: LX 在 getDailyHotSongs 内内联同一表达式（server.js:2455），抽出仅供单测直接断言
function dailyHotPerPlatformLimit(limit) {
  const sources = DAILY_HOT_SOURCES;
  return Math.min(60, Math.max(25, Math.ceil(limit / sources.length) + 15));
}

// ---------------------------------------------------------------- 工厂

function createDailyHotApi(apiOptions = {}) {
  const injectedFetchJson = typeof apiOptions.fetchJson === 'function' ? apiOptions.fetchJson : null;
  const injectedFetchText = typeof apiOptions.fetchText === 'function' ? apiOptions.fetchText : null;
  const nowImpl = typeof apiOptions.now === 'function' ? apiOptions.now : Date.now;
  // 偏离: 缓存表挂在工厂闭包而非 LX 的模块单例（行为一致，仅隔离测试状态）
  let dailyHotCache = Object.create(null);

  async function dailyHotFetchJson(targetUrl, options = {}) {
    // 偏离: 优先走注入实现，调用形状与 LX 一致
    if (injectedFetchJson) return injectedFetchJson(targetUrl, options);
    return dailyHotFetchJsonDefault(targetUrl, options);
  }
  async function dailyHotFetchText(targetUrl, options = {}) {
    // 偏离: 优先走注入实现，调用形状与 LX 一致
    if (injectedFetchText) return injectedFetchText(targetUrl, options);
    return dailyHotFetchTextDefault(targetUrl, options);
  }

  async function fetchNeteaseHotSeeds(limit, chartId = '3778678') {
    const endpoints = [
      `https://music.163.com/api/playlist/detail?id=${encodeURIComponent(chartId)}`,
      `https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(chartId)}`,
    ];
    let lastError = null;
    for (const endpoint of endpoints) {
      try {
        const data = await dailyHotFetchJson(endpoint, { timeoutMs: 14000 });
        const tracks = data?.result?.tracks || data?.playlist?.tracks || [];
        const songs = tracks.map(dailyHotSongFromNeteaseTrack).filter(song => song.name);
        if (songs.length) return songs.slice(0, limit);
      } catch (err) {
        lastError = err;
        console.warn('[DailyHotSeeds]', endpoint, err.message || err);
      }
    }
    if (lastError) throw lastError;
    return [];
  }

  async function fetchQQHotSeeds(limit, chartId = '26') {
    const target = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
    const headers = { referer:'https://y.qq.com/n/ryqq/toplist/26', 'content-type':'application/json' };
    const allBody = {
      comm:{ ct:24, cv:0 },
      req_1:{ module:'musicToplist.ToplistInfoServer', method:'GetAll', param:{} },
    };
    const all = await dailyHotFetchJson(target, {
      method:'POST', timeoutMs:14000, headers, body:JSON.stringify(allBody),
    });
    const groups = all?.req_1?.data?.group || [];
    const requestedTopId = Number(chartId) || 26;
    const hot = groups.flatMap(group => group?.toplist || []).find(item => Number(item?.topId) === requestedTopId);
    if (!hot?.period) throw new Error('QQ_HOT_CHART_PERIOD_MISSING');
    const detailBody = {
      comm:{ ct:24, cv:0 },
      req_1:{
        module:'musicToplist.ToplistInfoServer', method:'GetDetail',
        param:{ topid:requestedTopId, offset:0, num:Math.max(30, limit), period:hot.period },
      },
    };
    const data = await dailyHotFetchJson(target, {
      method:'POST', timeoutMs:14000, headers, body:JSON.stringify(detailBody),
    });
    return (data?.req_1?.data?.songInfoList || [])
      .map(dailyHotSongFromQQRank)
      .filter(song => song.name)
      .slice(0, limit);
  }

  async function fetchKuwoHotSeeds(limit, chartId = '16') {
    const html = await dailyHotFetchText(`https://m.kuwo.cn/newh5app/ranklist_detail/${encodeURIComponent(chartId)}`, {
      timeoutMs: 16000,
      headers: { referer:'https://m.kuwo.cn/newh5app/ranklist' },
    });
    const match = html.match(/<script>\s*window\.__NUXT__=([\s\S]*?)<\/script>/i);
    if (!match) throw new Error('KUWO_CHART_DATA_MISSING');
    const expression = match[1].trim().replace(/;$/, '');
    const functionMatch = expression.match(/^\(function\(([^)]*)\)\{([\s\S]*)\}\(([\s\S]*)\)\)$/);
    if (!functionMatch) throw new Error('KUWO_CHART_FORMAT_CHANGED');
    const parameters = functionMatch[1].split(',').map(value => value.trim());
    const argumentsList = dailyHotSplitTopLevelArguments(functionMatch[3]);
    const argumentMap = Object.create(null);
    parameters.forEach((parameter, index) => { argumentMap[parameter] = argumentsList[index]; });
    const rows = [];
    const rowPattern = /\w+\[\d+\]=\{id:(\d+),name:([^,]+),pic:("(?:\\.|[^"\\])*"|[^,]+),album_name:([^,]+),artist_name:("(?:\\.|[^"\\])*"|[^,]+)/g;
    let rowMatch;
    while ((rowMatch = rowPattern.exec(functionMatch[2])) && rows.length < limit) {
      rows.push({
        id:rowMatch[1],
        name:dailyHotDecodeNuxtToken(rowMatch[2], argumentMap),
        pic:dailyHotDecodeNuxtToken(rowMatch[3], argumentMap),
        albumName:dailyHotDecodeNuxtToken(rowMatch[4], argumentMap),
        singer:dailyHotDecodeNuxtToken(rowMatch[5], argumentMap),
      });
    }
    return rows.map(item => ({
      id: item.id,
      songmid: item.id,
      name: item.name || '',
      singer: item.singer || '',
      albumName: item.albumName || '',
      albumId: '',
      picUrl: item.pic || '',
      interval: '',
      source: 'kw',
      types: ['flac24bit', 'flac', '320k', '128k'],
    })).filter(song => song.name);
  }

  async function fetchKugouHotSeeds(limit, chartId = '8888') {
    const output = [];
    const seen = new Set();
    const pageCount = Math.max(1, Math.ceil(limit / 22));
    for (let page = 1; page <= pageCount && output.length < limit; page += 1) {
      const html = await dailyHotFetchText(`https://www.kugou.com/yy/rank/home/${page}-${encodeURIComponent(chartId)}.html`, {
        timeoutMs: 16000,
        headers: { referer:'https://www.kugou.com/yy/html/rank.html' },
      });
      const match = html.match(/global\.features\s*=\s*(\[[\s\S]*?\]);/i);
      if (!match) continue;
      let rows = [];
      try { rows = JSON.parse(match[1]); } catch (_error) { rows = []; }
      rows.forEach(item => {
        const hash = String(item.Hash || item.hash || '');
        if (!hash || seen.has(hash) || output.length >= limit) return;
        seen.add(hash);
        const singer = String(item.author_name || '').trim();
        const fileName = String(item.FileName || item.filename || '').trim();
        let name = fileName;
        const prefix = singer ? `${singer} - ` : '';
        if (prefix && fileName.startsWith(prefix)) name = fileName.slice(prefix.length);
        else if (fileName.includes(' - ')) name = fileName.split(' - ').slice(1).join(' - ');
        output.push({
          id: item.audio_id || item.Audioid || hash,
          songmid: item.audio_id || item.Audioid || hash,
          hash,
          name,
          singer,
          albumId: item.album_id || '',
          interval: dailyHotDurationText(item.timeLen),
          source:'kg',
          types:['flac24bit', 'flac', '320k', '128k'],
        });
      });
    }
    return output;
  }

  async function fetchMiguHotSeeds(limit, chartId = '27186466') {
    const target = `https://app.c.nf.migu.cn/MIGUM3.0/v1.0/content/querycontentbyId.do?columnId=${encodeURIComponent(chartId)}&needAll=0`;
    const data = await dailyHotFetchJson(target, {
      timeoutMs:18000,
      headers:{ referer:'https://music.migu.cn/' },
    });
    if (String(data?.code || '') !== '000000') throw new Error(data?.info || 'MIGU_HOT_CHART_FAILED');
    return (data?.columnInfo?.contents || [])
      .map(dailyHotSongFromMiguRank)
      .filter(song => song.name)
      .slice(0, limit);
  }

  async function fetchPlatformNativeHotSeeds(source, limit, chartId) {
    if (source === 'tx') return fetchQQHotSeeds(limit, chartId);
    if (source === 'wy') return fetchNeteaseHotSeeds(limit, chartId);
    if (source === 'kw') return fetchKuwoHotSeeds(limit, chartId);
    if (source === 'kg') return fetchKugouHotSeeds(limit, chartId);
    if (source === 'mg') return fetchMiguHotSeeds(limit, chartId);
    return [];
  }
  async function fetchSinglePlatformHotResult(source, limit, requestedChart) {
    const chart = platformChartDefinition(source, requestedChart);
    let nativeSongs = [];
    let nativeError = '';
    try {
      nativeSongs = await fetchPlatformNativeHotSeeds(source, Math.max(limit, 30), chart && chart.id);
    } catch (error) {
      nativeError = error?.message || String(error || 'PLATFORM_CHART_FAILED');
      console.warn('[PlatformChart]', source, nativeError);
    }
    // 榜单必须保持平台返回的原始名次。接口失败或数量不足时宁可少展示，
    // 也不能再用关键词搜索结果补满，否则普通搜索结果会伪装成榜单名次。
    const songs = nativeSongs.slice(0, limit);
    const label = `${{ tx:'小秋', wy:'小芸', kw:'小蜗', kg:'小狗', mg:'小菇' }[source] || source.toUpperCase()}${chart?.name || '热歌榜'}`;
    return {
      songs,
      chartMode:nativeSongs.length ? 'native' : 'unavailable',
      chartLabel:nativeSongs.length ? `${label} · 平台原榜 ${songs.length} 首` : `${label} · 暂不可用`,
      chartId:chart?.id || '',
      chartName:chart?.name || '',
      nativeError,
    };
  }

  async function getDailyHotSongs(limit, requestedSource, forceRefresh, requestedChart) {
    limit = Math.min(Math.max(Number(limit) || 100, 1), 100);
    const source = /^(tx|wy|kw|kg|mg)$/.test(String(requestedSource || '').toLowerCase())
      ? String(requestedSource).toLowerCase()
      : 'all';
    const chart = source === 'all' ? null : platformChartDefinition(source, requestedChart);
    const cacheKey = `${source}|${chart?.id || 'default'}`;
    const cached = dailyHotCache[cacheKey];
    const now = nowImpl(); // 偏离: LX 为 Date.now()
    const cachedIsAuthentic = cached && !/(?:expanded|fallback|supplemented)/.test(String(cached.chartMode || ''));
    if (!forceRefresh && cachedIsAuthentic && now - cached.time < DAILY_HOT_CACHE_MS && cached.songs.length >= limit) {
      return { ok: true, songs: cached.songs.slice(0, limit), cached: true, updatedAt: cached.time, chartSource:source, chartMode:cached.chartMode, chartLabel:cached.chartLabel, chartId:chart?.id || '' };
    }
    let songs = [];
    let chartMode = 'native';
    let chartLabel = '';
    if (source === 'all') {
      const sources = DAILY_HOT_SOURCES; // 偏离: 与 dailyHotPerPlatformLimit 共用同一张平台表
      const perPlatformLimit = dailyHotPerPlatformLimit(limit);
      const results = await Promise.all(sources.map(item => fetchSinglePlatformHotResult(item, perPlatformLimit)));
      songs = mixPlatformCharts(results, limit);
      chartMode = 'mixed-native';
      chartLabel = '各平台真实榜单交叉汇总';
    } else {
      const result = await fetchSinglePlatformHotResult(source, limit, chart && chart.id);
      songs = result.songs;
      chartMode = result.chartMode;
      chartLabel = result.chartLabel;
    }
    dailyHotCache[cacheKey] = { time:now, songs, chartMode, chartLabel };
    return { ok:songs.length > 0, songs, cached:false, updatedAt:now, chartSource:source, chartMode, chartLabel, chartId:chart?.id || '', error:songs.length ? '' : '平台暂未返回可验证的真实榜单' };
  }

  return {
    getDailyHotSongs,
    mixPlatformCharts,
    normalizeDailyHotSong,
    dailyHotPerPlatformLimit,
    PLATFORM_CHART_CATALOG,
    // 偏离: 兼容计划文档命名的别名，与 PLATFORM_CHART_CATALOG 同一对象（LX 只有前者）
    PLATFORM_CHARTS: PLATFORM_CHART_CATALOG,
    DAILY_HOT_CACHE_MS,
    // 偏离: LX 的缺省抓取实现是模块私有；导出以便 Task 2 包装复用（文件头偏离 1）
    dailyHotFetchJsonDefault,
    dailyHotFetchTextDefault,
    // 偏离: LX 的缓存表（内部变量名 dailyHotCache 保持 LX 原样）是模块私有；
    //       __dailyHotCache 是【仅测试缝】—— 单测用它观察缓存、构造「历史脏缓存」
    //       （LX 抓取路径已不再产出 fallback/expanded/supplemented，该判定只能喂旧数据验证）。
    //       导出的是闭包里同一个活对象，改它即改到闭包；Task 2 不依赖此字段。
    __dailyHotCache: dailyHotCache,
  };
}

module.exports = {
  createDailyHotApi,
  DAILY_HOT_CACHE_MS,
  PLATFORM_CHART_CATALOG,
  // 偏离: 兼容计划文档命名的别名，与 PLATFORM_CHART_CATALOG 同一对象（LX 只有前者）
  PLATFORM_CHARTS: PLATFORM_CHART_CATALOG,
  normalizeDailyHotSong,
  mixPlatformCharts,
  dailyHotPerPlatformLimit,
  // 偏离: 导出 LX 缺省抓取实现，供 Task 2 包装，避免在 server.js 重抄 UA/referer/redirect/超时
  dailyHotFetchJsonDefault,
  dailyHotFetchTextDefault,
};
