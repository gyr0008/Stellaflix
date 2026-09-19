/*
 * Stellaflix 影视模块 — TMDB 元数据客户端 (海报 / 简介 / 评分 / 年份)
 *
 * 用途：统一视频海报与简介。TMDB 是「元数据服务」（海报图 + 文字简介），并非视频源，
 *       因此不违反 §0.3「内容层（api_site 视频地址）必须为空」的合规红线。
 *       ⚠️ TMDB API 条款强制要求显示署名：
 *         "This product uses the TMDB API but is not endorsed or certified by TMDB"
 *         集成到 UI 时必须保留该署名（建议放在设置页/关于页/页脚）。
 *
 * 认证：采用 v3 API Key（作为 query 参数 api_key 拼在 URL 内）。
 *       原因：本应用 /api/proxy 仅白名单透传弹弹play 专用头（x-appid 等），不透传
 *       Authorization；v3 api_key 放在 target URL 内天然绕过该限制，无需改 proxy。
 *       注：TMDB v3 key 设计为可在客户端使用（非秘密凭证），但本仓库已不再内置真实 key
 *       （DEFAULT_API_KEY 置空）：必须由 localStorage('stellaflix-tmdb-key') 或设置页自填提供，
 *       避免开源后被他人盗用/触发 TMDB 限额。TMDB v3 key 可在后台随时 revoke/重置。
 *       申请：https://www.themoviedb.org/settings/api（Developer 免费档，非商业免费）。
 *
 * 重要：本机网络环境下标准域名 api.themoviedb.org 不可达（连接被拒），
 *       可用域名为 api.tmdb.org（实测 200）。DEFAULT_BASE 据此设置。
 *
 * 网络：所有请求经 /api/proxy 转发，解决浏览器 CORS；中文优先 language=zh-CN&region=CN。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // 本机实测：api.themoviedb.org 连接失败(000)，api.tmdb.org 返回 200。以可用域名为准。
  var DEFAULT_BASE = 'https://api.tmdb.org/3';
  var IMG_BASE = 'https://image.tmdb.org/t/p/';

  // 仓库内不再内置真实 key（避免开源后被盗用 / 触发 TMDB 限额）。
  // 已配置过的用户不受影响：localStorage('stellaflix-tmdb-key') 优先级高于此默认值。
  // 未配置时各接口 reject 'TMDB_KEY_REQUIRED'，调用方已有 catch，仅 TMDB 元数据降级、不影响播放。
  var DEFAULT_API_KEY = '';

  var LS_KEY = 'stellaflix-tmdb-key';

  var cfg = {
    baseUrl: DEFAULT_BASE,
    proxyBase: '',
    apiKey: DEFAULT_API_KEY,
    language: 'zh-CN',
    region: 'CN'
  };

  // apiKey 优先级（运行时读取，避免模块加载时写死）：
  //   ① localStorage('stellaflix-tmdb-key') 用户自填（设置页 UI 写入）—— 最高优先；
  //   ② setApiKey(k) 运行时显式覆盖（内存态，刷新失效）；
  //   ③ DEFAULT_API_KEY 兜底（仓库内已置空，需用户自填）。
  // 用 getter/setter 替换原数据属性：所有既有读取点（request / search / getDetails /
  // popular / discover / trending / upcoming / getCollection）自动生效，无需逐处改动；
  // setter 保留 setApiKey 公共 API 语义（strict 模式下不抛错）。
  var _runtimeKey = '';
  Object.defineProperty(cfg, 'apiKey', {
    configurable: true,
    enumerable: true,
    get: function () {
      try {
        var v = (global.localStorage && global.localStorage.getItem(LS_KEY)) || '';
        if (v) return v;
      } catch (e) { /* 隐私/无痕模式静默降级 */ }
      if (_runtimeKey) return _runtimeKey;
      return DEFAULT_API_KEY;
    },
    set: function (k) { _runtimeKey = (k || ''); }
  });

  function buildProxyUrl(path, query) {
    var qs = Object.keys(query).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]);
    }).join('&');
    var target = cfg.baseUrl + path + (qs ? '?' + qs : '');
    return (cfg.proxyBase || '') + '/api/proxy?url=' + encodeURIComponent(target);
  }

  function request(path, query) {
    var q = Object.assign({ api_key: cfg.apiKey, language: cfg.language, region: cfg.region }, query || {});
    var url = buildProxyUrl(path, q);
    if (!global.fetch) return Promise.reject(new Error('TMDB_NO_FETCH'));
    return global.fetch(url).then(function (r) {
      if (!r.ok) throw new Error('TMDB_HTTP_' + r.status);
      // [修复2026-09-12] 上游异常（Cloudflare 拦截页 / 代理错误页 / 站点维护页）会以 2xx
      // 返回 HTML，直接 r.json() 会抛 `SyntaxError: Unexpected token '<'`，在 DevTools 里
      // 表现为「Uncaught (in promise)」噪音，且掩盖真实原因。先校验 content-type 再解析。
      var ct = (r.headers && typeof r.headers.get === 'function') ? (r.headers.get('content-type') || '') : '';
      if (ct && ct.toLowerCase().indexOf('json') < 0) throw new Error('TMDB_NON_JSON');
      return r.json().catch(function () { throw new Error('TMDB_BAD_JSON'); });
    });
  }

  function posterUrl(path, size) {
    if (!path) return null;
    // 网格缩略图默认 w342（~342px，足够 6 列响应式卡片；详情页传 'w500' 覆盖）
    var full = IMG_BASE + (size || 'w342') + path;
    // TMDB 图片 CDN (image.tmdb.org) 在部分网络（沙箱/中国大陆常见）被浏览器侧封锁，
    // 直接 <img>/background-image 静默失败 → 海报空白。走本地 /api/proxy 转发，
    // 服务端可达 image.tmdb.org（22:3x 沙箱实测 HTTP 200 / 4.17s）。
    // 注意：poster-cache 缓存后存为 data:，下次直接读本地；本路径仅未缓存的远程海报生效。
    return (cfg.proxyBase || '') + '/api/proxy?url=' + encodeURIComponent(full);
  }

  // 标题 logo（透明 PNG，无海报背景）—— 详情页主标题区优先用这个，
  // 渲染真正的电影标题设计（鬼玩人爆裂红字 / 异魂白字 / 蚁人红蓝 Marvel 字）
  // 而非整张竖版人物海报。
  // size 默认 'original'（logo 体积小, 矢量效果无压力, 透明 PNG 全分辨率更好）
  function logoUrl(path, size) {
    if (!path) return null;
    var full = IMG_BASE + (size || 'original') + path;
    return (cfg.proxyBase || '') + '/api/proxy?url=' + encodeURIComponent(full);
  }

  // 搜索电影 + 剧集（含 person 但过滤掉），用于「按标题补全海报/简介」
  function search(query) {
    if (!cfg.apiKey) return Promise.reject(new Error('TMDB_KEY_REQUIRED'));
    return request('/search/multi', { query: query, include_adult: 'false' }).then(function (j) {
      return (j.results || []).map(function (r) {
        return {
          id: r.id,
          mediaType: r.media_type,                 // movie / tv
          title: r.title || r.name || '',
          originalTitle: r.original_title || r.original_name || '',
          year: (r.release_date || r.first_air_date || '').slice(0, 4),
          overview: r.overview || '',
          poster: posterUrl(r.poster_path),
          rating: r.vote_average || 0
        };
      }).filter(function (x) { return x.mediaType === 'movie' || x.mediaType === 'tv'; });
    });
  }

  // 单条目详情（补全简介 / 海报 / 背景图）
  function getDetails(id, mediaType) {
    if (!cfg.apiKey) return Promise.reject(new Error('TMDB_KEY_REQUIRED'));
    var path = '/' + (mediaType === 'tv' ? 'tv' : 'movie') + '/' + id;
    return request(path, {}).then(function (r) {
      return {
        id: r.id, mediaType: mediaType,
        title: r.title || r.name || '',
        year: (r.release_date || r.first_air_date || '').slice(0, 4),
        overview: r.overview || '',
        poster: posterUrl(r.poster_path, 'w500'),
        backdrop: posterUrl(r.backdrop_path, 'w780'),
        rating: r.vote_average || 0,
        genres: (r.genres || []).map(function (g) { return g.name; }),
        originalLanguage: r.original_language || ''
      };
    });
  }

  // 便捷：按标题取最相关的**有海报的** TMDB 匹配
  //
  // 核心原则：宁可无海报（🎬），也不要把不相关内容的海报错配给当前条目。
  // 策略：原始标题搜 → 清洗后(保留季数)重试 → 仍无则 null
  function bestMatch(title) {
    if (!title) return Promise.resolve(null);
    var q = String(title).trim();
    return findBestMatch(q).then(function (m) {
      if (m) return m;
      var clean = cleanTitle(q);
      if (clean && clean !== q) return findBestMatch(clean);
      return null;
    });
  }

  /**
   * 从 TMDB 搜索结果中选取最佳匹配。
   *
   * 算法：
   *   1. 对每个结果计算与查询词的标题相关性得分（0~1）
   *   2. 按得分降序排列
   *   3. 在高相关性结果（score ≥ 0.45）中找第一个有 poster 的
   *   4. 若高相关结果均无 poster → 返回 null（显示 🎬，不降级到低相关+有图）
   *   5. 若最高分结果本身就是低相关（< 0.30）→ 返回 null（查询词在 TMDB 无有效匹配）
   *
   * 这解决了「盲取首个有 poster 者」导致的不同剧/不同季共用同一张热门海报的问题。
   */
  function findBestMatch(query) {
    return search(query).then(function (list) {
      if (!list || !list.length) return null;

      // 评分 & 排序
      var scored = [];
      for (var i = 0; i < list.length; i++) {
        scored.push({
          item: list[i],
          score: titleScore(query, list[i].title) +
                 titleScore(query, list[i].originalTitle || '') * 0.7
        });
      }
      scored.sort(function (a, b) { return b.score - a.score; });

      // 最高分太低 → TMDB 根本没有相关内容，直接放弃
      if (scored[0].score < 0.30) return null;

      // 在高相关区间（score ≥ 0.45）中找有 poster 的
      var bestWithPoster = null;
      for (var j = 0; j < scored.length; j++) {
        if (scored[j].item.poster) {
          if (scored[j].score >= 0.45) return scored[j].item;
          // 低相关但有图 → 记为备选，但不优先返回
          if (!bestWithPoster) bestWithPoster = scored[j].item;
        }
        // 一旦分数降到 0.25 以下，后续更不可能有好的，提前退出
        if (scored[j].score < 0.25) break;
      }

      // 高相关区全部无 poster → 返回 null（🎬）优于错配海报
      // 仅当完全没有高相关结果时才用备选
      return bestWithPoster; // 可能为 null
    });
  }

  /**
   * 计算查询词与候选标题的相关性得分（0 ~ 1）。
   *
   * 评分规则（按优先级）：
   *   - 完全一致（忽略空格/大小写）：1.0
   *   - 一方包含另一方（子串匹配）：0.85
   *   - 去空格后字符重叠率 × 长度惩罚因子：0.15 ~ 0.70
   */
  function titleScore(query, candidate) {
    if (!query || !candidate) return 0;
    var q = query.replace(/\s+/g, '').toLowerCase();
    var c = candidate.replace(/\s+/g, '').toLowerCase();
    if (!q || !c) return 0;

    // 完全一致
    if (q === c) return 1.0;

    // 子串包含
    if (c.indexOf(q) >= 0) return 0.85;       // 候选包含查询（如"画江湖之不良人第六季"含"第六季"）
    if (q.indexOf(c) >= 0) return 0.80;       // 查询包含候选

    // 字符重叠率
    var qLen = q.length;
    var cLen = c.length;
    var hits = 0;
    for (var i = 0; i < qLen; i++) {
      if (c.indexOf(q.charAt(i)) >= 0) hits++;
    }
    var rawRatio = hits / qLen;

    // 长度惩罚：候选标题比查询长很多时，重叠率要打折
    // 例：查"不良人"，候选"画江湖之不良人"——虽然字符全命中，但候选多了很多无关字
    var lenPenalty = qLen <= cLen ? (qLen / cLen) : (cLen / qLen);

    return rawRatio * rawRatio * lenPenalty; // 平方让高分更高、低分更低
  }

  /**
   * 清洗规则源标题——仅去除纯噪音，**保留季数**。
   * 去掉：语言/格式/括号备注/规则源前缀。保留：第X季/Season X/Sx。
   * 例："一人之下 第二季 日语版" → "一人之下 第二季"
   *     "一人之下 第一季（动态漫）" → "一人之下"
   *     "动态漫画 一人之下" → "一人之下"
   */
  function cleanTitle(t) {
    return t
      .replace(/\s*[(（][^)）]*[)）]\s*/g, ' ')        // 括号备注：（动态漫）、(日语版)
      // 季数已保留——不再删除，避免不同季退化成同一搜索词导致海报雷同
      .replace(/\s*(日语版|国语版|普通话版|双语版)\s*/g, '') // 语言
      .replace(/\s*(动态漫?|动态漫画)\s*/g, '')           // 格式
      .replace(/点击查看\s*[:：]?\s*/g, '')               // 规则源前缀
      .replace(/\s{2,}/g, ' ').trim();                    // 压缩空格
  }

  // 热门/流行列表（用于电影/动漫分页默认网格，无需搜索词）
  // mediaType: 'movie' | 'anime'(动画 = tv 流按 genre 16 过滤)
  // 返回归一化数组：{ id, mediaType, title, originalTitle, year, overview, poster, rating, genreIds }
  function normalizeList(j) {
    return (j.results || []).map(function (r) {
      return {
        id: r.id,
        mediaType: r.media_type || (r.first_air_date ? 'tv' : 'movie'),
        title: r.title || r.name || '',
        originalTitle: r.original_title || r.original_name || '',
        year: (r.release_date || r.first_air_date || '').slice(0, 4),
        overview: r.overview || '',
        poster: posterUrl(r.poster_path),
        posterPath: r.poster_path,
        rating: r.vote_average || 0,
        voteCount: r.vote_count || 0,
        popularity: r.popularity || 0,
        adult: !!r.adult,
        genreIds: r.genre_ids || [],
        originalLanguage: r.original_language || ''
      };
    });
  }

  function popular(mediaType, page) {
    if (!cfg.apiKey) return Promise.reject(new Error('TMDB_KEY_REQUIRED'));
    var p = page || 1;
    return request('/movie/popular', { page: p }).then(normalizeList);
  }

  // 通用 discover 查询（片单引擎 collections.js 使用）：支持任意筛选参数组合
  // params: { with_genres, sort_by, primary_release_year, vote_average_gte, ... }
  // 返回 normalizeList 格式数组：{ id, mediaType, title, year, poster, rating, genreIds }
  function discover(params) {
    if (!cfg.apiKey) return Promise.reject(new Error('TMDB_KEY_REQUIRED'));
    var q = Object.assign({ page: 1 }, params || {});
    return request('/discover/movie', q).then(normalizeList);
  }

  // 趋势榜（片单「推荐」类使用）：mediaType=movie|tv，timeWindow=day|week
  function trending(mediaType, timeWindow) {
    if (!cfg.apiKey) return Promise.reject(new Error('TMDB_KEY_REQUIRED'));
    var mt = mediaType === 'tv' ? 'tv' : 'movie';
    var tw = timeWindow === 'day' ? 'day' : 'week';
    return request('/trending/' + mt + '/' + tw, {}).then(normalizeList);
  }

  // 即将上映（片单「推荐」类使用）
  function upcoming(page) {
    if (!cfg.apiKey) return Promise.reject(new Error('TMDB_KEY_REQUIRED'));
    return request('/movie/upcoming', { page: page || 1 }).then(normalizeList);
  }

  // 官方合集详情（片单「主题」类使用）：collectionId → { id, name, overview, poster, backdrop, parts[] }
  function getCollection(collectionId) {
    if (!cfg.apiKey) return Promise.reject(new Error('TMDB_KEY_REQUIRED'));
    return request('/collection/' + collectionId, {}).then(function (r) {
      return {
        id: r.id,
        name: r.name || '',
        overview: r.overview || '',
        poster: posterUrl(r.poster_path),
        backdrop: posterUrl(r.backdrop_path, 'w780'),
        parts: (r.parts || []).map(function (p) {
          return {
            id: p.id,
            mediaType: p.media_type || 'movie',
            title: p.title || p.name || '',
            originalTitle: p.original_title || p.original_name || '',
            year: (p.release_date || '').slice(0, 4),
            overview: p.overview || '',
            poster: posterUrl(p.poster_path),
            backdrop: posterUrl(p.backdrop_path, 'w780'),
            rating: p.vote_average || 0,
            genreIds: p.genre_ids || [],
            originalLanguage: p.original_language || ''
          };
        })
      };
    });
  }

  // 详情页一次性聚合：主信息 + 演职员 + 相似影片（一次请求拿全，避免多次往返）
  // 返回 { backdrop, runtime, genres[], cast[{id,name,character,profile}], similar[{...normalizeList}], logos[{file_path,iso_639_1,vote_average,width,height}], ... }
  // 无 key / 网络失败 → reject，调用方静默降级（不展示该模块即可）。
  function getDetailBundle(id, mediaType) {
    if (!cfg.apiKey) return Promise.reject(new Error('TMDB_KEY_REQUIRED'));
    if (!id) return Promise.reject(new Error('TMDB_NO_ID'));
    var path = '/' + (mediaType === 'tv' ? 'tv' : 'movie') + '/' + id;
    // 并行：主详情(credits,similar) + 图片
    // include_image_language=zh,en,null 强制拉中文/英文/无语言 logo，
    // 避免主请求 language=zh-CN 时返回的 logos 被过滤为空。
    return Promise.all([
      request(path, { append_to_response: 'credits,similar' }),
      request(path + '/images', { include_image_language: 'zh,en,null' })
    ]).then(function (arr) {
      var r = arr[0];
      var imgRes = arr[1] || {};
      var cast = (r.credits && r.credits.cast ? r.credits.cast : []).slice(0, 12).map(function (c) {
        return {
          id: c.id,
          name: c.name || c.original_name || '',
          character: c.character || '',
          profile: posterUrl(c.profile_path, 'w185')
        };
      });
      // 类似影片：合并 recommendations（用户行为推荐，更可信）+ similar（题材相似），
      // 去重后按「评分 × log10(评分人数+1) + popularity×0.05」排序，过滤无海报/标题/
      // 成人/评分人数过少/评分过低的低质量条目，只保留可信度高的真实推荐。
      var rawSimilar = normalizeList(r.similar || {});
      var rawRec = normalizeList(r.recommendations || {});
      var seen = {};
      var similar = [];
      function addRec(list, source) {
        for (var i = 0; i < list.length; i++) {
          var x = list[i];
          if (!x || !x.id) continue;
          var k = x.mediaType + ':' + x.id;
          if (seen[k]) continue;
          seen[k] = true;
          x._recSource = source;
          similar.push(x);
        }
      }
      addRec(rawRec, 'recommendations');
      addRec(rawSimilar, 'similar');
      similar = similar.filter(function (m) {
        return m.title && m.posterPath && !m.adult && m.voteCount >= 15 && m.rating >= 2.5;
      }).sort(function (a, b) {
        var sa = (a.rating || 0) * Math.log10(Math.max(a.voteCount, 1) + 1) + (a.popularity || 0) * 0.05;
        var sb = (b.rating || 0) * Math.log10(Math.max(b.voteCount, 1) + 1) + (b.popularity || 0) * 0.05;
        return sb - sa;
      }).slice(0, 18);
      var rt = r.runtime || (r.episode_run_time && r.episode_run_time[0]) || 0;
      var genres = (r.genres || []).map(function (g) { return g.name; });
      var companies = (r.production_companies || []).map(function (c) {
        return { id: c.id, name: c.name || '', logo: posterUrl(c.logo_path, 'w342') };
      });
      var collection = r.belongs_to_collection
        ? { id: r.belongs_to_collection.id, name: r.belongs_to_collection.name || '', poster: posterUrl(r.belongs_to_collection.poster_path, 'w342') }
        : null;
      // TV 分季（排除 specials season_number===0）：详情页「分季」入口用
      var seasons = (r.seasons || []).filter(function (s) {
        return s && s.season_number > 0;
      }).map(function (s) {
        return {
          seasonNumber: s.season_number,
          name: s.name || ('第' + s.season_number + '季'),
          episodeCount: s.episode_count || 0,
          poster: posterUrl(s.poster_path, 'w342'),
          airDate: s.air_date || ''
        };
      });
      return {
        // 详情页 HEADER / 标题所需（2026-08-06 重设计接入）
        title: r.title || r.name || '',
        originalTitle: r.original_title || r.original_name || '',
        voteAverage: r.vote_average || 0,
        releaseDate: r.release_date || r.first_air_date || '',
        overview: r.overview || '',
        poster: posterUrl(r.poster_path, 'w500'),
        backdrop: posterUrl(r.backdrop_path, 'w1280'),
        runtime: rt,
        genres: genres,
        cast: cast,
        similar: similar,
        seasons: seasons,
        // logos: 透明 PNG 标题矢量图（zh > en > null > others 排序在 detail.js 做）
        // 这里只做原始数据透传，让 detail.js 按当前语言/评分策略挑选
        images: {
          backdrops: (imgRes.backdrops || []).slice(0, 12).map(function (b) { return { file_path: b.file_path }; }),
          logos: (imgRes.logos || []).map(function (l) {
            return {
              file_path: l.file_path,
              iso_639_1: l.iso_639_1 || null,    // 'zh' / 'en' / null
              vote_average: l.vote_average || 0,
              width: l.width || 0,
              height: l.height || 0
            };
          })
        },
        companies: companies,
        collection: collection
      };
    });
  }

  // 单部影片标题 logo 列表（供「类似影片」卡片按需展示 title logo）。
  // 不并入 getDetailBundle：similar 至多 18 条，逐条塞进主请求会显著拖慢详情页渲染；
  // 改为卡片渲染时按需异步拉取，缺失/失败回退 original_title 文字即可。
  // 返回 [{ file_path, iso_639_1, vote_average, width, height }]
  function getMovieLogos(id, mediaType) {
    if (!cfg.apiKey) return Promise.reject(new Error('TMDB_KEY_REQUIRED'));
    if (!id) return Promise.reject(new Error('TMDB_NO_ID'));
    var path = '/' + (mediaType === 'tv' ? 'tv' : 'movie') + '/' + id + '/images';
    // 同 getDetailBundle：强制 zh,en,null，避免 language=zh-CN 时 logos 被过滤为空
    return request(path, { include_image_language: 'zh,en,null' }).then(function (imgRes) {
      return (imgRes.logos || []).map(function (l) {
        return {
          file_path: l.file_path,
          iso_639_1: l.iso_639_1 || null,
          vote_average: l.vote_average || 0,
          width: l.width || 0,
          height: l.height || 0
        };
      });
    });
  }

  // 外部 ID（关联豆瓣用：拿 imdb_id）。返回 { imdbId, id }
  function getExternalIds(id, mediaType) {
    if (!cfg.apiKey) return Promise.reject(new Error('TMDB_KEY_REQUIRED'));
    if (!id) return Promise.reject(new Error('TMDB_NO_ID'));
    var path = '/' + (mediaType === 'tv' ? 'tv' : 'movie') + '/' + id + '/external_ids';
    return request(path, {}).then(function (r) {
      return { imdbId: r.imdb_id || '', id: r.id };
    });
  }

  // 评论列表（兜底数据源：豆瓣不可达时直连 TMDB 评论）。
  // 返回 [{ author, rating(0~10 或 null), content, url }]，排序由调用方处理。
  function getReviews(id, mediaType) {
    if (!cfg.apiKey) return Promise.reject(new Error('TMDB_KEY_REQUIRED'));
    if (!id) return Promise.reject(new Error('TMDB_NO_ID'));
    var path = '/' + (mediaType === 'tv' ? 'tv' : 'movie') + '/' + id + '/reviews';
    return request(path, { page: 1 }).then(function (r) {
      return (r.results || []).map(function (x) {
        return {
          author: x.author || '',
          rating: (x.author_details && x.author_details.rating) || null,
          content: x.content || '',
          url: x.url || ''
        };
      });
    });
  }

  // ---- 片单二级页元数据字典（零额外请求：列表响应自带 genre_ids/original_language）----
  // TMDB movie+tv 类型 ID → 中文（language=zh-CN 下的官方译名）
  var GENRE_NAMES = {
    28: '动作', 12: '冒险', 16: '动画', 35: '喜剧', 80: '犯罪', 99: '纪录片',
    18: '剧情', 10751: '家庭', 14: '奇幻', 36: '历史', 27: '恐怖', 10402: '音乐',
    9648: '悬疑', 10749: '爱情', 878: '科幻', 10770: '电视电影', 53: '惊悚',
    10752: '战争', 37: '西部', 10759: '冒险', 10762: '少儿', 10763: '新闻',
    10764: '真人秀', 10765: '科幻', 10766: '肥皂剧', 10767: '脱口秀', 10768: '政治'
  };
  // original_language（ISO 639-1）→ 中文地区近似（列表级只有语言没有国家，片单场景够用）
  var LANG_REGION = {
    zh: '内地', en: '美国', ja: '日本', ko: '韩国', fr: '法国', de: '德国',
    es: '西班牙', ru: '俄罗斯', it: '意大利', th: '泰国', hi: '印度', sv: '瑞典',
    da: '丹麦', pt: '葡萄牙', nl: '荷兰', pl: '波兰', cs: '捷克', id: '印尼',
    ta: '印度', tr: '土耳其', ar: '阿拉伯'
  };
  function genreNames(ids) {
    return (ids || []).map(function (g) { return GENRE_NAMES[g]; }).filter(Boolean).join('、');
  }
  function regionLabel(lang) {
    var key = String(lang || '').split('-')[0].toLowerCase();
    return LANG_REGION[key] || '';
  }

  var tmdb = {
    configure: function (o) {
      if (!o) return;
      if (o.baseUrl) cfg.baseUrl = o.baseUrl;
      if (o.proxyBase != null) cfg.proxyBase = o.proxyBase;
      if (o.language) cfg.language = o.language;
      if (o.region) cfg.region = o.region;
    },
    setApiKey: function (k) { cfg.apiKey = k || ''; },
    getApiKey: function () { return cfg.apiKey; },
    hasKey: function () { return !!cfg.apiKey; },
    openKeySettings: (SFV.tmdbSettings && SFV.tmdbSettings.openKeySettings) || function () {},
    posterUrl: posterUrl,
    logoUrl: logoUrl,
    search: search,
    getDetails: getDetails,
    bestMatch: bestMatch,
    popular: popular,
    discover: discover,
    trending: trending,
    upcoming: upcoming,
    getCollection: getCollection,
    getDetailBundle: getDetailBundle,
    getMovieLogos: getMovieLogos,
    getExternalIds: getExternalIds,
    getReviews: getReviews,
    genreNames: genreNames,
    regionLabel: regionLabel
  };

  SFV.tmdb = tmdb;
})(typeof window !== 'undefined' ? window : this);
