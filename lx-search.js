'use strict';

/**
 * lx-search.js — Stellaflix 音乐搜索内置爬虫（五家无 cookie 源：tx/wy/kw/kg/mg）
 *
 * 移植自上游 Mineradio-LX-Music-1.7.0/lx-search.js：
 *  - :66-107  HTTP 层（3 次重试 + Retry-After 尊重 + 12s 超时 + UA/referer 默认头）
 *  - :109-261 五个 scraper（网易 eapi AES-128-ECB、QQ u.y.qq.com 签名、咪咕 md5 签名）
 *  - :361-394 providerHealth 熔断冷却（3 连败武装、成功复位、单源请求旁路）
 *  - :359-375 searchCache 命中语义（2min TTL、命中返回同一 value、缓存优先于冷却检查）
 *  - :406-409 缓存写入门槛（songs 非空）+ 80 条上限 FIFO 逐出
 *  - :368-411 searchAll Promise.allSettled 聚合 + `source|songmid||id` 去重 + 逐源 failures
 *
 * 身份转换：源展示别名以本仓既有前端标签表为准（public/js/modules/05-playback/07-search.js
 * 的 LX_SEARCH_SOURCE_LABELS），端点、签名盐值、线格式逐字保留（协议词汇，非品牌身份）。
 *
 * 批 T15.5a 补移植（上游保留的免登录裸 HTTP 元数据爬虫族）：
 *  - 上游 lx-search.js:263-352 五家歌单搜索变体 + :413-448 searchPlaylists 聚合；
 *  - 上游 server.js:2145-2358 五家日榜种子（163 playlist/detail、QQ musicu.fcg 两段式、
 *    kuwo __NUXT__ 直出解析、kugou global.features、migu querycontentbyId）+ :2358 榜单目录；
 *  - 上游 server.js:2411-2466 全平台交叉汇总与 chartMode/chartLabel 契约。
 * 本批刻意不带 T6 冷却、也不带上游 dailyHotCache(6h)/playlistSearchCache(2min)（YAGNI，见 brief）。
 *
 * 有意的上游偏离（批 T6 brief 规定）：
 *  - 冷却时长曲线：上游 :391 为线性 15s×(failures-1) 封顶 120s；本实现按 brief 取
 *    指数 2s/4s/8s… 封顶 120s（Math.min(120000, 1000 * 2 ** (failures - 2))）。
 *  - 冷却 failures 条目键名：上游 :381 用 error:'SOURCE_COOLDOWN'；本实现按 brief 契约
 *    用 code:'SOURCE_COOLDOWN'（普通失败仍为 {source,error}）。
 *  - searchCache/providerHealth 上游为模块级，本实现随工厂实例作用域（与 fetchImpl/now
 *    注入同构；底部模块级默认入口仍提供全局一致行为）。
 *
 * song 冻结形状（Task 6/8/9/10/11 消费）：
 *  { source, id, songmid?, name, singer, album, interval, pic }
 *  扩展（批 T9 裁决1）：kg 条目带 hash（FileHash）；mg 条目带 copyrightId。
 *  日榜条目（批 T15.5a）同冻结形状 —— 上游 daily-hot 侧的 albumName/picUrl 一律改写为我方
 *  album/pic，strMediaMid/albumMid/types 等播放无关字段不携带（LX 脚本 resolve 只需
 *  source + songmid/hash/copyrightId + name/singer）。
 * 歌单卡形状（批 T15.5a，上游 lx-search.js:47-64 playlistResult 同款字段）：
 *  { id, input, source, sourceName, name, creator, description, cover,
 *    trackCount, playCount, collectCount, tags, url }
 */

const crypto = require('node:crypto');

const DEFAULT_SOURCES = 'tx,wy,kw,kg,mg';

// 五家展示名：取本仓既有前端标签表（07-search.js LX_SEARCH_SOURCE_LABELS）而非上游别名字表。
const SOURCE_NAMES = { tx: '小秋', wy: '小芸', kw: '小蜗', kg: '小狗', mg: '小菇' };

function durationText(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function singers(value) {
  if (!Array.isArray(value)) return String(value || '');
  return value.map(item => item && (item.name || item.singerName)).filter(Boolean).join('、');
}

function kuwoCoverUrl(item) {
  item = item || {};
  let value = String(item.picUrl || item.pic || item.PIC || item.web_albumpic_short || item.web_album_pic || item.albumpic || item.hts_MVPIC || item.MVPIC || '').trim();
  if (!value) return '';
  value = value.replace(/^https?:\/\/[^/]+\/star\/albumcover\/\d+\//i, '');
  value = value.replace(/^\d+\//, '');
  if (/^https?:\/\//i.test(value)) return value;
  return `https://img1.kuwo.cn/star/albumcover/500/${value.replace(/^\/+/, '')}`;
}

function clampLimit(limit) {
  return Math.min(Math.max(Number(limit) || 12, 1), 30);
}

// ---------- 批 T15.5a：纯函数 normalizer（无网络，模块级共享） ----------

// 上游 lx-search.js:32-45：歌单侧车字段带 HTML 实体与标签，展示前统一清洗。
function cleanText(value) {
  return String(value || '')
    .replace(/&nbsp;|&#32;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 上游 lx-search.js:47-64 playlistResult：字段集合即前端歌单卡契约（本批照抄，
// 仅 sourceName 取我方 SOURCE_NAMES；封面 http→https 同上游）。
function playlistCard(source, item) {
  item = item || {};
  const id = String(item.id || '').trim();
  return {
    id,
    input: String(item.input || id).trim(),
    source,
    sourceName: SOURCE_NAMES[source] || source,
    name: cleanText(item.name) || `${SOURCE_NAMES[source] || source}歌单`,
    creator: cleanText(item.creator),
    description: cleanText(item.description),
    cover: String(item.cover || '').replace(/^http:\/\//i, 'https://'),
    trackCount: Math.max(0, Number(item.trackCount) || 0),
    playCount: Math.max(0, Number(item.playCount) || 0),
    collectCount: Math.max(0, Number(item.collectCount) || 0),
    tags: Array.isArray(item.tags) ? item.tags.map(cleanText).filter(Boolean).slice(0, 5) : [],
    url: String(item.url || ''),
  };
}

function createLxSearch({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  // 上游 :66-107 HTTP 层：3 次重试 + Retry-After 尊重 + 12s 超时 + UA/referer 默认头。
  // 批 T15.5a 拆出 consume（response → 载荷），JSON 与文本两条链路共用同一退避/头约定；
  // 上游 playlist 侧的 useNodeFetch 开关属 Electron net 适配，本仓 fetchImpl 即全局 fetch，无对应需求。
  async function request(url, options, consume) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const fetchOptions = { ...options };
        const response = await fetchImpl(url, {
          ...fetchOptions,
          signal: controller.signal,
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            referer: new URL(url).origin + '/',
            ...(fetchOptions.headers || {}),
          },
        });
        if (!response.ok) {
          const error = new Error(`HTTP_${response.status}`);
          const retryAfter = response.headers && response.headers.get && response.headers.get('retry-after');
          if (retryAfter) {
            const seconds = Number(retryAfter);
            const dateDelay = Date.parse(retryAfter) - Date.now();
            error.retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, dateDelay);
          }
          throw error;
        }
        return await consume(response);
      } catch (error) {
        lastError = error;
        const retryable = /HTTP_(?:429|5\d\d)|abort|timeout|fetch|network|socket|ECONN|ENOTFOUND/i.test(String(error && (error.message || error)));
        if (!retryable || attempt >= 2) throw error;
        const exponentialDelay = 350 * (2 ** attempt);
        const retryAfterDelay = Math.min(10000, Math.max(0, Number(error.retryAfterMs) || 0));
        await new Promise(resolve => setTimeout(resolve, Math.max(exponentialDelay, retryAfterDelay)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('SEARCH_REQUEST_FAILED');
  }

  function fetchJson(url, options = {}) {
    return request(url, options, response => response.json());
  }

  function fetchText(url, options = {}) {
    return request(url, options, response => response.text());
  }

  // ---------- 五家 scraper（上游 :109-261，输出归一为冻结 song 形状） ----------

  async function searchKw(query, limit) {
    const url = `https://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(query)}&pn=0&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`;
    const data = await fetchJson(url);
    return (data.abslist || []).map(item => ({
      source: 'kw',
      id: String(item.MUSICRID || '').replace('MUSIC_', ''),
      songmid: String(item.MUSICRID || '').replace('MUSIC_', ''),
      name: item.SONGNAME || '',
      singer: item.ARTIST || '',
      album: item.ALBUM || '',
      interval: durationText(item.DURATION),
      pic: kuwoCoverUrl(item),
    }));
  }

  async function searchKg(query, limit) {
    const baseUrl = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(query)}&page=1&pagesize=${limit}&userid=0&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1`;
    let rows = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const data = await fetchJson(`${baseUrl}&_=${Date.now()}_${attempt}`);
      rows = data?.data?.lists || [];
      if (rows.length) break;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 380 * (2 ** attempt)));
    }
    return rows.map(item => ({
      source: 'kg',
      id: item.Audioid,
      songmid: item.Audioid,
      // T9 裁决1（歌曲形态补全）：kg 解析器需要 hash/FileHash。
      hash: String(item.FileHash || ''),
      name: item.SongName || '',
      singer: singers(item.Singers) || item.SingerName || '',
      album: item.AlbumName || '',
      interval: durationText(item.Duration),
      pic: '',
    }));
  }

  async function searchWy(query, limit) {
    const apiPath = '/api/search/song/list/page';
    const payload = JSON.stringify({
      keyword: query, needCorrect: '1', channel: 'typing', offset: 0,
      scene: 'normal', total: true, limit,
    });
    const digest = crypto.createHash('md5').update(`nobody${apiPath}use${payload}md5forencrypt`).digest('hex');
    const plain = `${apiPath}-36cd479b6b5-${payload}-36cd479b6b5-${digest}`;
    const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null);
    const params = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]).toString('hex').toUpperCase();
    const data = await fetchJson('http://interface.music.163.com/eapi/batch', {
      method: 'POST',
      headers: {
        origin: 'https://music.163.com',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ params }).toString(),
    });
    const resources = data?.data?.resources || [];
    return resources.map(resource => resource?.baseInfo?.simpleSongData).filter(Boolean).map(item => ({
      source: 'wy',
      id: item.id,
      songmid: item.id,
      name: item.name || '',
      singer: singers(item.ar),
      album: item.al?.name || '',
      interval: durationText((item.dt || 0) / 1000),
      pic: item.al?.picUrl || '',
    }));
  }

  function qqSign(text) {
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    const part1 = [23, 14, 6, 36, 16, 40, 7, 19].map(index => hash[index]).join('');
    const part2 = [16, 1, 32, 12, 19, 27, 8, 5].map(index => hash[index]).join('');
    const scramble = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];
    const bytes = scramble.map((value, index) => value ^ parseInt(hash.slice(index * 2, index * 2 + 2), 16));
    const middle = Buffer.from(bytes).toString('base64').replace(/[\\/+=]/g, '');
    return `zzc${part1}${middle}${part2}`.toLowerCase();
  }

  async function searchTx(query, limit) {
    const body = {
      comm: {
        ct: '11', cv: '14090508', v: '14090508', tmeAppID: 'qqmusic',
        phonetype: 'EBG-AN10', os_ver: '12', OpenUDID: '0', QIMEI36: '0',
        udid: '0', chid: '0', aid: '0', oaid: '0', taid: '0', tid: '0',
        wid: '0', uid: '0', sid: '0', modeSwitch: '6', teenMode: '0',
        ui_mode: '2', nettype: '1020',
      },
      req: {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicMobile',
        param: {
          search_type: 0, searchid: Math.random().toString().slice(2), query,
          page_num: 1, num_per_page: limit, highlight: 0, nqc_flag: 0,
          multi_zhida: 0, cat: 2, grp: 1, sin: 0, sem: 0,
        },
      },
    };
    const text = JSON.stringify(body);
    const data = await fetchJson(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${qqSign(text)}`, {
      method: 'POST',
      headers: { 'user-agent': 'QQMusic 14090508(android 12)', 'content-type': 'application/json' },
      body: text,
    });
    const list = data?.req?.data?.body?.item_song || [];
    return list.map(item => {
      const albumMid = item.album?.mid || item.albummid || '';
      return {
        source: 'tx',
        id: item.id || item.songid,
        songmid: item.mid || item.songmid,
        name: item.title || item.songname || item.name || '',
        singer: singers(item.singer),
        album: item.album?.name || item.albumname || '',
        interval: durationText(item.interval),
        pic: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg` : '',
      };
    });
  }

  async function searchMg(query, limit) {
    const timestamp = String(Date.now());
    const deviceId = '963B7AA0D21511ED807EE5846EC87D20';
    const sign = crypto.createHash('md5').update(`${query}6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${timestamp}`).digest('hex');
    const url = `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(query)}&pageNo=1&sort=0&sid=USS`;
    const data = await fetchJson(url, { headers: { uiVersion: 'A_music_3.6.1', deviceId, timestamp, sign, channel: '0146921' } });
    const groups = data?.songResultData?.resultList || [];
    return groups.flat().filter(item => item.songId && item.copyrightId).map(item => ({
      source: 'mg',
      id: item.songId,
      songmid: item.songId,
      // T9 裁决1（歌曲形态补全）：mg 解析器需要 copyrightId。
      copyrightId: String(item.copyrightId || ''),
      name: item.name || '',
      singer: singers(item.singerList),
      album: item.album || '',
      interval: durationText(item.duration),
      pic: item.img3 || item.img2 || item.img1 || '',
    }));
  }

  const SCRAPERS = { tx: searchTx, wy: searchWy, kw: searchKw, kg: searchKg, mg: searchMg };

  // ---------- 五家歌单搜索变体（批 T15.5a，上游 lx-search.js:263-352；免登录裸 HTTP） ----------

  async function searchTxPlaylists(query, limit, page = 1) {
    const url = `https://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist?remoteplace=txt.yqq.playlist&searchid=${Date.now()}&query=${encodeURIComponent(query)}&page_no=${page}&num_per_page=${limit}&format=json`;
    const data = await fetchJson(url, { headers: { referer: 'https://y.qq.com/' } });
    return (data?.data?.list || []).map(item => playlistCard('tx', {
      id: item.dissid,
      name: item.dissname,
      creator: item.creator?.name,
      description: item.introduction,
      cover: item.imgurl,
      trackCount: item.song_count || item.copyrightnum,
      playCount: item.listennum,
      url: item.dissid ? `https://y.qq.com/n/ryqq/playlist/${item.dissid}` : '',
    }));
  }

  async function searchWyPlaylists(query, limit, page = 1) {
    const url = `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(query)}&type=1000&offset=${(page - 1) * limit}&limit=${limit}`;
    const data = await fetchJson(url, { headers: { referer: 'https://music.163.com/' } });
    return (data?.result?.playlists || []).map(item => playlistCard('wy', {
      id: item.id,
      name: item.name,
      creator: item.creator?.nickname,
      description: item.description,
      cover: item.coverImgUrl,
      trackCount: item.trackCount,
      playCount: item.playCount,
      collectCount: item.bookCount,
      tags: item.officialTags,
      url: item.id ? `https://music.163.com/playlist?id=${item.id}` : '',
    }));
  }

  async function searchKwPlaylists(query, limit, page = 1) {
    const url = `https://search.kuwo.cn/r.s?all=${encodeURIComponent(query)}&ft=playlist&client=kt&pn=${page - 1}&rn=${limit}&rformat=json&encoding=utf8&mobi=1`;
    const data = await fetchJson(url);
    return (data?.abslist || []).map(item => {
      const id = item.playlistid || item.DC_TARGETID;
      return playlistCard('kw', {
        id,
        name: item.name,
        creator: item.nickname,
        description: item.intro,
        cover: item.hts_pic || item.pic,
        trackCount: item.songnum,
        playCount: item.playcnt,
        tags: String(item.tags || '').split(/[;,，]/),
        url: id ? `https://www.kuwo.cn/playlist_detail/${id}` : '',
      });
    });
  }

  async function searchKgPlaylists(query, limit, page = 1) {
    const url = `https://specialsearch.kugou.com/special_search?keyword=${encodeURIComponent(query)}&page=${page}&pagesize=${limit}&platform=WebFilter&filter=0&iscorrection=1`;
    const data = await fetchJson(url, { headers: { referer: 'https://www.kugou.com/' } });
    return (data?.data?.lists || []).map(item => playlistCard('kg', {
      id: item.specialid,
      name: item.specialname,
      creator: item.nickname,
      description: item.intro,
      cover: item.img,
      trackCount: item.song_count,
      playCount: item.total_play_count || item.play_count,
      collectCount: item.collect_count,
      tags: String(item.tag_str || '').split(/[;,，]/),
      url: item.specialid ? `https://www.kugou.com/yy/special/single/${item.specialid}.html` : '',
    }));
  }

  // 歌单检索复用 searchMg 同款签名盐与头（sid/开关位不同：searchSwitch 只开 songlist）。
  async function searchMgPlaylists(query, limit, page = 1) {
    const timestamp = String(Date.now());
    const deviceId = '963B7AA0D21511ED807EE5846EC87D20';
    const sign = crypto.createHash('md5').update(`${query}6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${timestamp}`).digest('hex');
    const searchSwitch = encodeURIComponent(JSON.stringify({
      song: 0, album: 0, singer: 0, tagSong: 0, mvSong: 0, bestShow: 0, songlist: 1, lyricSong: 0,
    }));
    const url = `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=${searchSwitch}&pageSize=${limit}&text=${encodeURIComponent(query)}&pageNo=${page}&sort=0&sid=USS`;
    const data = await fetchJson(url, { headers: { uiVersion: 'A_music_3.6.1', deviceId, timestamp, sign, channel: '0146921' } });
    return (data?.songListResultData?.result || []).map(item => playlistCard('mg', {
      id: item.id,
      name: item.name,
      creator: item.userName,
      description: item.intro,
      cover: item.musicListPicUrl,
      trackCount: item.musicNum,
      playCount: item.playNum,
      collectCount: item.keepNum,
      tags: item.ts,
      url: item.id ? `https://music.migu.cn/v3/music/playlist/${item.id}` : '',
    }));
  }

  const PLAYLIST_SCRAPERS = {
    tx: searchTxPlaylists, wy: searchWyPlaylists, kw: searchKwPlaylists,
    kg: searchKgPlaylists, mg: searchMgPlaylists,
  };

  function resolvePlaylistSources(sources) {
    const list = Array.isArray(sources)
      ? sources
      : String(sources || DEFAULT_SOURCES).split(',');
    return list.map(source => String(source).trim()).filter(source => PLAYLIST_SCRAPERS[source]);
  }

  // 上游 lx-search.js:413-448 searchPlaylists；我方改对象参数（同 searchAll 裁决4），
  // 失败项沿本仓 {source,error} 形状（上游的 name 别名字段不携带）；缓存与冷却本批不接（YAGNI）。
  async function searchPlaylists({ query, limit, page, sources } = {}) {
    const q = String(query || '').trim();
    if (!q) return { ok: true, playlists: [], failures: [] };
    const safeLimit = clampLimit(limit);
    const safePage = Math.min(Math.max(Number(page) || 1, 1), 50);
    const requested = resolvePlaylistSources(sources);
    const settled = await Promise.allSettled(requested.map(source => PLAYLIST_SCRAPERS[source](q, safeLimit, safePage)));
    const playlists = [];
    const failures = [];
    settled.forEach((result, index) => {
      const source = requested[index];
      if (result.status === 'fulfilled') playlists.push(...result.value);
      else failures.push({ source, error: result.reason?.message || 'PLAYLIST_SEARCH_FAILED' });
    });
    const seen = new Set();
    return {
      // 上游 :432 语义：只要有源成功返回就 ok，逐源失败另表。
      ok: playlists.length > 0 || failures.length < requested.length,
      playlists: playlists.filter(item => {
        const key = `${item.source}|${item.id}`;
        if (!item.id || !item.name || seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
      failures,
      page: safePage,
      query: q,
    };
  }

  // ---------- 熔断冷却 + 搜索缓存（上游 :359-375、:361-394、:406-409；批 T6 启用） ----------
  const searchCache = new Map();
  const providerHealth = new Map();
  const SEARCH_CACHE_TTL_MS = 2 * 60 * 1000;
  const SEARCH_CACHE_MAX_ENTRIES = 80;

  // 上游 :363-366 providerState：懒初始化 {failures, cooldownUntil}。
  function providerState(source) {
    if (!providerHealth.has(source)) providerHealth.set(source, { failures: 0, cooldownUntil: 0 });
    return providerHealth.get(source);
  }

  function resolveRequestedSources(sources) {
    const list = Array.isArray(sources)
      ? sources
      : String(sources || DEFAULT_SOURCES).split(',');
    return list.map(source => String(source).trim()).filter(source => SCRAPERS[source]);
  }

  async function searchOne(source, { query, limit } = {}) {
    const scraper = SCRAPERS[String(source || '').trim()];
    if (!scraper) throw new Error(`LX_SEARCH_UNKNOWN_SOURCE:${source}`);
    const q = String(query || '').trim();
    if (!q) return [];
    return scraper(q, clampLimit(limit));
  }

  async function searchAll({ query, limit, sources } = {}) {
    const q = String(query || '').trim();
    if (!q) return { songs: [], failures: [] };
    const safeLimit = clampLimit(limit);
    const requested = resolveRequestedSources(sources);
    // 上游 :373-375：缓存键 = 源列表|limit|小写 query；命中优先于冷却检查。
    const cacheKey = `${requested.join(',')}|${safeLimit}|${q.toLowerCase()}`;
    const cached = searchCache.get(cacheKey);
    if (cached && now() - cached.time < SEARCH_CACHE_TTL_MS) return cached.value;

    // 上游 :376-378：requested.length===1 时整体旁路冷却（避免单源查询被永久锁死）。
    const nowMs = now();
    const active = requested.filter(source => requested.length === 1 || providerState(source).cooldownUntil <= nowMs);
    const cooled = requested.filter(source => !active.includes(source));

    const settled = await Promise.allSettled(active.map(source => SCRAPERS[source](q, safeLimit)));
    const songs = [];
    // 上游 :381 冷却失败项前置；name 别名属身份转换不携带，code 键名按 T6 契约。
    const failures = cooled.map(source => ({ source, code: 'SOURCE_COOLDOWN' }));
    settled.forEach((result, index) => {
      const source = active[index];
      const health = providerState(source);
      if (result.status === 'fulfilled') {
        songs.push(...result.value);
        health.failures = 0;
        health.cooldownUntil = 0;
      } else {
        health.failures += 1;
        // 上游 :391 曲线为 15s×(failures-1) 封顶 120s；T6 brief 规定指数 2s/4s… 封顶 120s。
        if (health.failures >= 3) health.cooldownUntil = now() + Math.min(120000, 1000 * 2 ** (health.failures - 2));
        failures.push({ source, error: result.reason?.message || 'SEARCH_FAILED' });
      }
    });
    const seen = new Set();
    const value = {
      songs: songs.filter(song => {
        const key = `${song.source}|${song.songmid || song.id}`;
        if (!song.name || seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
      failures,
    };
    // 上游 :406-408：仅结果非空才写缓存；超过 80 条按插入序逐出最旧。
    if (value.songs.length) {
      searchCache.set(cacheKey, { time: now(), value });
      if (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) searchCache.delete(searchCache.keys().next().value);
    }
    return value;
  }

  return { searchAll, searchOne, searchPlaylists };
}

// 模块级便捷入口（对齐上游 module.exports 直接可用习惯；默认走全局 fetch）。
const defaultLxSearch = createLxSearch();

module.exports = {
  createLxSearch,
  searchAll: (params) => defaultLxSearch.searchAll(params),
  searchOne: (source, params) => defaultLxSearch.searchOne(source, params),
  searchPlaylists: (params) => defaultLxSearch.searchPlaylists(params),
  SOURCE_NAMES,
};
