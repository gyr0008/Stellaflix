'use strict';

/* ============================================================
   Radio Modes — 音乐电台
   从 Stellaflix-LX-Music-1.6.0 移植并适配 Stellaflix 2.1.0
   ============================================================ */

var RADIO_MODE_FAVORITES_KEY = 'stellaflix-radio-mode-favorites-v1';
var radioModeFavoriteIds = (function () {
  try {
    var saved = JSON.parse(localStorage.getItem(RADIO_MODE_FAVORITES_KEY) || '[]');
    return Array.isArray(saved) ? saved.map(String).filter(Boolean) : [];
  } catch (_error) {
    return [];
  }
})();

var radioModeState = { category: 'all', loadingId: '', requestToken: 0, orderNonce: 0 };

var RADIO_MODE_DEFINITIONS = [
  { id: 'personal', category: 'personal', kicker: 'FOR YOU', title: '私人漫游', sub: '从你的常听歌手与本地收藏继续发现', keywords: [], queries: ['华语流行歌曲', '宝藏流行单曲', '热门流行歌曲'], a: '#5b7cff', b: '#7734b8' },
  { id: 'heartbeat', category: 'personal', kicker: 'HEARTBEAT', title: '心动模式', sub: '喜欢过的旋律，混入一些相似惊喜', keywords: ['喜欢', '收藏'], queries: ['王心凌', '梁静茹', '周兴哲'], a: '#ff758f', b: '#a62972' },
  { id: 'daily', category: 'scene', kicker: 'DAILY FLOW', title: '今日漫游', sub: '今天值得循环的流行歌曲与新鲜旋律', keywords: [], queries: ['今日流行新歌', '热门华语歌曲', '流行热歌'], a: '#4fd6c8', b: '#186f8f' },
  { id: 'commute', category: 'scene', kicker: 'ON THE WAY', title: '通勤节拍', sub: '适合路上、地铁和城市穿行的节奏', keywords: ['流行', '节奏'], queries: ['五月天', '苏打绿', '张杰'], a: '#ffb65a', b: '#e4503e' },
  { id: 'late', category: 'scene', kicker: 'AFTER DARK', title: '深夜氛围', sub: '安静人声与有空间感的夜晚歌曲', keywords: ['治愈', '安静', '夜', '钢琴'], queries: ['陈绮贞', '陈粒', '孙燕姿'], a: '#4a5f88', b: '#171d42' },
  { id: 'study', category: 'scene', kicker: 'FOCUS', title: '专注电台', sub: '少打扰的纯音乐、钢琴与轻节拍', keywords: ['纯音乐', '钢琴', '轻音乐', 'instrumental'], queries: ['久石让', 'Bandari', 'Richard Clayderman'], a: '#78c6a3', b: '#35645d' },
  { id: 'morning', category: 'scene', kicker: 'GOOD MORNING', title: '清晨唤醒', sub: '明亮、轻快，给新一天一个舒服开场', keywords: ['清晨', '早晨', '阳光', '轻快'], queries: ['苏打绿', '旅行团乐队', '房东的猫'], a: '#ffd166', b: '#ef8354' },
  { id: 'rain', category: 'scene', kicker: 'RAINY CAFE', title: '雨天咖啡馆', sub: '雨声之外，是温暖松弛的旋律与爵士', keywords: ['雨', '咖啡', '爵士', '慵懒'], queries: ['Norah Jones', '小野丽莎', '陈绮贞'], a: '#69a8c8', b: '#44546a' },
  { id: 'roadtrip', category: 'scene', kicker: 'ROAD TRIP', title: '公路旅行', sub: '向远方行驶时适合一起唱的歌', keywords: ['旅行', '公路', '开车', '民谣'], queries: ['许巍', '朴树', '逃跑计划'], a: '#f6bd60', b: '#bc6c25' },
  { id: 'sleep', category: 'scene', kicker: 'SLEEP TIGHT', title: '睡前轻音乐', sub: '只保留舒缓器乐与安静旋律，不含助眠节目', keywords: ['睡前', '舒缓', '钢琴', '纯音乐'], queries: ['坂本龙一', '久石让', 'Bandari'], a: '#7189bf', b: '#342e59' },
  { id: 'dj', category: 'energy', kicker: 'HOT DJ', title: '热门 DJ', sub: '只收录带 DJ、Remix、串烧或混音标识的舞曲', keywords: ['dj', 'remix', 'mix', '串烧', '车载'], queries: ['热门 DJ 舞曲 Remix', '车载 DJ 舞曲', '电音 DJ 串烧'], searchSources: 'tx,wy,kw,kg,mg', a: '#35bfff', b: '#3c34d9' },
  { id: 'high', category: 'energy', kicker: 'HIGH ENERGY', title: '高燃模式', sub: '副歌起飞，适合运动与快速回血', keywords: ['高燃', '热血', '摇滚'], queries: ['Imagine Dragons', 'Linkin Park', 'Fall Out Boy'], a: '#ff4b4b', b: '#8b162d' },
  { id: 'game', category: 'energy', kicker: 'GAME ON', title: '游戏战歌', sub: '开局、团战和 Boss 时刻的推进感', keywords: ['游戏', 'game', 'bgm', '电竞'], queries: ['英雄联盟 主题曲', '王者荣耀 游戏原声', '魔兽世界 游戏原声'], a: '#29d6d0', b: '#1477c9' },
  { id: 'nightrun', category: 'energy', kicker: 'NIGHT RUN', title: '城市夜跑', sub: '稳定拍点与电子律动，把步伐带起来', keywords: ['夜跑', '运动', '跑步', '电子'], queries: ['The Weeknd', 'Dua Lipa', 'Calvin Harris'], a: '#00d4aa', b: '#075985' },
  { id: 'anime', category: 'style', kicker: 'ANIME', title: '二次元', sub: '动画、虚拟歌姬与熟悉的日系旋律', keywords: ['动漫', '动画', '初音', 'anime', 'vocaloid'], queries: ['Aimer', 'LiSA 日本歌手', 'RADWIMPS'], a: '#f786c4', b: '#7356d8' },
  { id: 'jpop', category: 'style', kicker: 'J-POP', title: '日本流行', sub: '清亮人声与层次丰富的日系编曲', keywords: ['日语', 'j-pop', 'jpop', '日本'], queries: ['J-POP 日本流行歌曲', '米津玄师', 'YOASOBI'], a: '#ef6262', b: '#a21842' },
  { id: 'kpop', category: 'style', kicker: 'K-POP', title: '韩流热单', sub: '舞台感、流行制作与抓耳副歌', keywords: ['韩语', 'k-pop', 'kpop', '韩国'], queries: ['BLACKPINK', 'BTS', 'NewJeans'], a: '#ff7eb3', b: '#7a5195' },
  { id: 'rnb', category: 'style', kicker: 'R&B', title: 'R&B 夜色', sub: '松弛律动、丝滑转音与低饱和夜晚', keywords: ['r&b', 'rnb', 'soul'], queries: ['方大同', '陶喆 R&B', '周杰伦 R&B'], a: '#8f9e24', b: '#465c0f' },
  { id: 'chinese', category: 'style', kicker: 'MANDOPOP', title: '华语流行', sub: '熟悉的表达，也加入正在发生的新歌', keywords: ['华语', '中文'], queries: ['周杰伦', '林俊杰', '孙燕姿'], a: '#4b8db5', b: '#214965' },
  { id: 'cantonese', category: 'style', kicker: 'CANTOPOP', title: '粤语金曲', sub: '港乐旋律、粤语新声与经典回忆', keywords: ['粤语', '港乐', '香港'], queries: ['陈奕迅 粤语', '张国荣 粤语', 'Beyond 粤语'], a: '#e76f51', b: '#7f1d1d' },
  { id: 'rock', category: 'style', kicker: 'ROCK', title: '摇滚现场', sub: '吉他、鼓点和不需要解释的释放', keywords: ['摇滚', 'rock', '乐队'], queries: ['五月天', 'Beyond', '草东没有派对'], a: '#d65d3f', b: '#77271e' },
  { id: 'folk', category: 'style', kicker: 'ACOUSTIC', title: '独立民谣', sub: '木吉他、故事感和不拥挤的人声', keywords: ['民谣', '木吉他', '独立'], queries: ['赵雷', '宋冬野', '陈鸿宇'], a: '#b08968', b: '#5e503f' },
  { id: 'jazz', category: 'style', kicker: 'JAZZ CLUB', title: '爵士酒馆', sub: '夜色、铜管、钢琴与松弛摇摆', keywords: ['爵士', 'jazz', 'swing'], queries: ['Norah Jones', 'Chet Baker', 'Diana Krall'], a: '#c59d5f', b: '#5c3d2e' },
  { id: 'classical', category: 'style', kicker: 'CLASSICAL', title: '古典乐章', sub: '钢琴、弦乐与交响作品的完整呼吸', keywords: ['古典', '钢琴', '交响', 'classical'], queries: ['Beethoven', 'Chopin', 'Mozart'], a: '#a8a29e', b: '#44403c' },
  { id: 'guofeng', category: 'style', kicker: 'CHINESE STYLE', title: '国风雅韵', sub: '古风人声、民族器乐与东方意境', keywords: ['古风', '国风', '中国风'], queries: ['许嵩 中国风', '周深 国风', '银临 古风'], a: '#d4a373', b: '#606c38' },
  { id: 'retro', category: 'style', kicker: 'GOLDEN OLDIES', title: '复古金曲', sub: '八九十年代的华语旋律与共同记忆', keywords: ['经典', '老歌', '怀旧'], queries: ['邓丽君', '张学友', '刘德华'], a: '#cb997e', b: '#6b4f4f' },
  { id: 'bgm', category: 'style', kicker: 'SOUNDTRACK', title: 'BGM 背景音乐', sub: '电影、动漫与游戏里的无歌词叙事', keywords: ['bgm', '原声', 'ost', '纯音乐'], queries: ['Hans Zimmer', '久石让', '坂本龙一'], a: '#68717c', b: '#2c3542' },
  { id: 'electronic', category: 'style', kicker: 'ELECTRONIC', title: '电子脉冲', sub: '合成器、低频与整齐推进的律动', keywords: ['电子', 'electronic', 'edm'], queries: ['Porter Robinson', 'Madeon', 'Avicii'], a: '#7b5cff', b: '#173ea7' },
  { id: 'healing', category: 'personal', kicker: 'LET IT GO', title: '失恋疗愈', sub: '允许难过，也把旋律慢慢唱到释怀', keywords: ['失恋', '伤感', '释怀', '情歌'], queries: ['梁静茹', 'A-Lin', '周兴哲'], a: '#9d4edd', b: '#3c096c' }
];

function radioModeDefinition(id) {
  return RADIO_MODE_DEFINITIONS.find(function (item) { return item.id === String(id || ''); }) || null;
}

function isRadioModeFavorite(id) {
  return radioModeFavoriteIds.indexOf(String(id || '')) >= 0;
}

function saveRadioModeFavorites() {
  try { localStorage.setItem(RADIO_MODE_FAVORITES_KEY, JSON.stringify(radioModeFavoriteIds)); } catch (_error) {}
}

function toggleRadioModeFavorite(id, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  id = String(id || '');
  if (!radioModeDefinition(id)) return;
  var index = radioModeFavoriteIds.indexOf(id);
  if (index >= 0) {
    radioModeFavoriteIds.splice(index, 1);
    showToast('已取消收藏电台');
  } else {
    radioModeFavoriteIds.unshift(id);
    showToast('已收藏电台，并置顶显示');
  }
  saveRadioModeFavorites();
  renderRadioModes();
}

function localSongSearchText(song) {
  if (!song) return '';
  return String(song.name || song.title || '') + ' ' +
    String(song.singer || song.artist || song.author || '') + ' ' +
    String(song.albumName || song.album || '');
}

function radioSongKey(song) {
  if (!song) return '';
  if (song.localPath) return 'local|' + String(song.localPath).toLowerCase();
  var source = radioNormalizeSource(song.source || song.provider || song.type || '');
  var remoteId = song.songmid || song.id || song.hash || '';
  if (remoteId) return source + '|' + String(remoteId);
  return simpleSearchNorm(song.name || song.title || '') + '|' + simpleSearchNorm(song.singer || song.artist || '');
}

var RADIO_NON_MUSIC_PATTERN = /(播客|电台节目|有声|朗读|朗诵|诵读|评书|相声|脱口秀|访谈|课程|语录|鸡汤|心理测试|睡眠故事|睡前故事|情感故事|助眠解压|掏耳|采耳|按摩|颅内|触发音|白噪音|冥想引导|asmr|audio\s*book|podcast)/i;
var RADIO_NON_MUSIC_ARTIST_PATTERN = /^(路乃嘉|子劲|疗愈音律|胖达|睡眠研究所|喜马拉雅|蜻蜓FM|懒人听书)$/i;

function isRadioMusicSong(song) {
  if (!song) return false;
  if (song.type === 'podcast-radio' || song.radioId || song.programId) return false;
  if (!song.id && !song.songmid && !song.hash && !song.localPath) return false;
  var title = String(song.name || song.title || '').trim();
  var artist = String(song.singer || song.artist || '').trim();
  if (!title || !artist) return false;
  var combined = title + ' ' + artist + ' ' + String(song.album || '');
  if (RADIO_NON_MUSIC_PATTERN.test(combined) || RADIO_NON_MUSIC_ARTIST_PATTERN.test(artist)) return false;
  if (/^\s*\d{1,3}[.、]\s*/.test(title)) return false;
  if (/第\s*\d+\s*(期|集|章)|\bEP\.?\s*\d+\b/i.test(title)) return false;
  if (/(人生是|永远不要|自我成长|好好心疼|认清一个|真正成熟的爱|朋友圈点赞|不用回我信息|恋爱中|你是我不聊天|爱而不得.*忘而不舍)/.test(title)) return false;
  if (title.length > 42) return false;
  if (title.length > 12 && /[，,“”]/.test(title)) return false;
  if (title.length > 18 && /[？?：:]|\.\.\.|…/.test(title)) return false;
  return true;
}

var RADIO_DJ_TRACK_PATTERN = /(?:\bdj\b|dj\s*版|dj舞曲|remix|re-?mix|bootleg|mashup|dance\s*mix|club\s*mix|电子舞曲|混音|串烧|慢摇|嗨曲|车载\s*dj)/i;

function isRadioDjSong(song) {
  if (!isRadioMusicSong(song)) return false;
  var title = [song.name, song.title].filter(Boolean).join(' ');
  var album = [typeof song.album === 'string' ? song.album : '', song.albumName].filter(Boolean).join(' ');
  return RADIO_DJ_TRACK_PATTERN.test(title) || RADIO_DJ_TRACK_PATTERN.test(album);
}

function radioModeAcceptsSong(mode, song) {
  if (!isRadioMusicSong(song)) return false;
  return !mode || mode.id !== 'dj' || isRadioDjSong(song);
}

function radioUniqueSongs(songs, limit) {
  var seen = Object.create(null);
  var out = [];
  (songs || []).forEach(function (song) {
    if (!isRadioMusicSong(song) || out.length >= limit) return;
    var key = radioSongKey(song);
    if (!key || seen[key]) return;
    seen[key] = true;
    out.push(cloneSong(song));
  });
  return out;
}

function radioSeedValue(text) {
  var value = 2166136261;
  String(text || '').split('').forEach(function (char) { value = Math.imul(value ^ char.charCodeAt(0), 16777619); });
  return value >>> 0;
}

function radioShuffle(list, seedText) {
  var out = (list || []).slice();
  var seed = radioSeedValue(seedText) || 1;
  function next() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
  for (var i = out.length - 1; i > 0; i--) {
    var j = Math.floor(next() * (i + 1));
    var swap = out[i]; out[i] = out[j]; out[j] = swap;
  }
  return out;
}

function radioNormalizeSource(value) {
  var map = {
    qq: 'tx', tx: 'tx',
    netease: 'wy', wy: 'wy', 网易云: 'wy', 网易云音乐: 'wy',
    kuwo: 'kw', kw: 'kw', 酷我: 'kw',
    kugou: 'kg', kg: 'kg', 酷狗: 'kg', 酷狗音乐: 'kg',
    migu: 'mg', mg: 'mg', 咪咕: 'mg',
    spotify: 'spotify'
  };
  return map[String(value || '').trim().toLowerCase()] || String(value || '');
}

function radioModeLocalSongs(mode) {
  var pool = (typeof homeDashboardLocalSongs === 'function') ? homeDashboardLocalSongs() : [];
  var preferred = [];
  if (mode.id === 'heartbeat' && typeof heartbeatPlaylist === 'function') {
    var heart = heartbeatPlaylist();
    if (heart && Array.isArray(heart.songs)) preferred = preferred.concat(heart.songs.map(cloneSong));
  }
  var norms = (mode.keywords || []).map(simpleSearchNorm).filter(Boolean);
  var matched = pool.filter(function (song) {
    if (!norms.length || mode.id === 'personal' || mode.id === 'daily') return true;
    var text = simpleSearchNorm(localSongSearchText(song));
    return norms.some(function (keyword) { return text.indexOf(keyword) >= 0; });
  });
  if (mode.id === 'personal') {
    try {
      var summary = homeListenSummary();
      if (summary && summary.topArtist && summary.topArtist.name) {
        var artistNorm = simpleSearchNorm(summary.topArtist.name);
        matched.sort(function (a, b) {
          return (simpleSearchNorm(localSongSearchText(b)).indexOf(artistNorm) >= 0 ? 1 : 0) -
            (simpleSearchNorm(localSongSearchText(a)).indexOf(artistNorm) >= 0 ? 1 : 0);
        });
      }
    } catch (_error) {}
  }
  return radioUniqueSongs(preferred.concat(radioShuffle(matched, mode.id + '|' + radioModeState.orderNonce)), 60);
}

async function buildRadioModeSongs(mode) {
  var local = radioModeLocalSongs(mode);
  var queries = (mode.queries || []).slice();
  if (mode.id === 'personal') {
    try {
      var summary = homeListenSummary();
      if (summary && summary.topArtist && summary.topArtist.name) queries.unshift(summary.topArtist.name);
    } catch (_error) {}
  }
  queries.push(mode.title);
  queries = queries.filter(function (item, index, list) { return item && list.indexOf(item) === index; }).slice(0, 3);
  // Stellaflix 没有 LX 的 /api/lx-source/search（它依赖外部 LX 脚本源），
  // 复用 Stellaflix 自带的 /api/search（网易云统一搜索）为电台模式补全网络结果。
  var batches = await Promise.all(queries.map(function (query) {
    return apiJson('/api/search?keywords=' + encodeURIComponent(query) + '&limit=36&t=' + Date.now(), { timeoutMs: 32000 })
      .then(function (result) {
        var items = result && Array.isArray(result.songs) ? result.songs : [];
        return items.filter(function (song) { return radioModeAcceptsSong(mode, song); }).slice(0, 24);
      })
      .catch(function (error) { console.warn('[RadioModeSearch]', query, error); return []; });
  }));
  var combined = local.slice();
  batches.forEach(function (items) { combined = combined.concat(items); });
  var songs = radioUniqueSongs(combined, 60).filter(function (song) { return radioModeAcceptsSong(mode, song); });
  return radioShuffle(songs, mode.id + '|queue|' + Date.now() + '|' + radioModeState.orderNonce).slice(0, 60);
}

function radioModeQueueSong(song, mode) {
  var queued = cloneSong(song || {});
  var source = radioNormalizeSource(queued.source || queued.provider || queued.type);
  if (queued.type !== 'local' && /^(tx|wy|kw|kg|mg)$/.test(source)) queued.type = 'online-queue';
  queued.radioModeId = mode.id;
  queued.radioModeName = mode.title;
  return queued;
}

async function playRadioMode(id) {
  var mode = radioModeDefinition(id);
  if (!mode || radioModeState.loadingId) return;
  var token = ++radioModeState.requestToken;
  radioModeState.loadingId = mode.id;
  renderRadioModes();
  try {
    var songs = await buildRadioModeSongs(mode);
    if (token !== radioModeState.requestToken) return;
    if (!songs.length) throw new Error('没有找到可播放的歌曲');
    playQueue = songs.map(function (song) { return radioModeQueueSong(song, mode); });
    currentIdx = 0;
    if (typeof safeRenderQueuePanel === 'function') safeRenderQueuePanel('radio-mode-play', { scrollCurrent: true });
    closeRadioModes();
    if (typeof forcePlaybackControlsInteractive === 'function') forcePlaybackControlsInteractive();
    await playQueueAt(0, { manual: true, context: { type: 'radio-mode', playlistName: mode.title + '电台' } });
    showToast(mode.title + ' · 已生成 ' + playQueue.length + ' 首');
  } catch (error) {
    console.warn('[RadioModePlay]', error);
    showToast(error && error.message || '电台暂时无法播放');
  } finally {
    if (token === radioModeState.requestToken) {
      radioModeState.loadingId = '';
      renderRadioModes();
    }
  }
}

function updateRadioCategoryTabs() {
  document.querySelectorAll('[data-radio-category]').forEach(function (button) {
    var active = button.getAttribute('data-radio-category') === radioModeState.category;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function renderRadioModes() {
  var root = document.getElementById('radio-mode-grid');
  if (!root) return;
  updateRadioCategoryTabs();
  var modes = RADIO_MODE_DEFINITIONS.filter(function (mode) {
    return radioModeState.category === 'all' || mode.category === radioModeState.category;
  });
  modes = radioShuffle(modes, 'radio-order|' + radioModeState.category + '|' + radioModeState.orderNonce);
  modes.sort(function (a, b) {
    var ai = radioModeFavoriteIds.indexOf(a.id);
    var bi = radioModeFavoriteIds.indexOf(b.id);
    if (ai < 0 && bi < 0) return 0;
    if (ai < 0) return 1;
    if (bi < 0) return -1;
    return ai - bi;
  });
  root.innerHTML = modes.map(function (mode) {
    var loading = radioModeState.loadingId === mode.id;
    var favorite = isRadioModeFavorite(mode.id);
    return '<button class="radio-mode-card' + (loading ? ' loading' : '') + (favorite ? ' favorite' : '') + '" type="button" style="--radio-a:' + mode.a + ';--radio-b:' + mode.b + '" onclick="playRadioMode(\'' + mode.id + '\')" aria-label="播放' + escHtml(mode.title) + '电台">' +
      '<span class="radio-mode-kicker">' + escHtml(mode.kicker) + '</span>' +
      '<span class="radio-mode-favorite' + (favorite ? ' active' : '') + '" role="button" title="' + (favorite ? '取消收藏' : '收藏并置顶') + '" aria-label="' + (favorite ? '取消收藏' : '收藏') + escHtml(mode.title) + '" onclick="toggleRadioModeFavorite(\'' + mode.id + '\',event)"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M13.7299 3.51063L15.4899 7.03063C15.7299 7.52063 16.3699 7.99063 16.9099 8.08063L20.0999 8.61062C22.1399 8.95062 22.6199 10.4306 21.1499 11.8906L18.6699 14.3706C18.2499 14.7906 18.0199 15.6006 18.1499 16.1806L18.8599 19.2506C19.4199 21.6806 18.1299 22.6206 15.9799 21.3506L12.9899 19.5806C12.4499 19.2606 11.5599 19.2606 11.0099 19.5806L8.01991 21.3506C5.87991 22.6206 4.57991 21.6706 5.13991 19.2506L5.84991 16.1806C5.97991 15.6006 5.74991 14.7906 5.32991 14.3706L2.84991 11.8906C1.38991 10.4306 1.85991 8.95062 3.89991 8.61062L7.08991 8.08063C7.61991 7.99063 8.25991 7.52063 8.49991 7.03063L10.2599 3.51063C11.2199 1.60063 12.7799 1.6006 13.7299 3.51063Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg></span>' +
      '<span class="radio-mode-play" aria-hidden="true">' + (loading ? '↻' : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M6 11.9997V9.32968C6 6.01968 8.35 4.65968 11.22 6.31968L13.53 7.65968L15.84 8.99968C18.71 10.6597 18.71 13.3697 15.84 15.0297L13.53 16.3697L11.22 17.7097C8.35 19.3397 6 17.9897 6 14.6697V11.9997Z" stroke="#ffffff" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round" /></svg>') + '</span>' +
      '<span class="radio-mode-title">' + escHtml(mode.title) + '</span>' +
      '<span class="radio-mode-sub">' + escHtml(loading ? '正在筛选符合主题的纯歌曲…' : mode.sub) + '</span></button>';
  }).join('');
}

function openRadioModes(category) {
  radioModeState.category = /^(all|personal|scene|style|energy)$/.test(String(category || '')) ? String(category) : 'all';
  var mask = document.getElementById('home-radio-modes-mask');
  if (!mask) return;
  radioModeState.previousFocus = document.activeElement;
  mask.classList.add('show');
  mask.setAttribute('aria-hidden', 'false');
  renderRadioModes();
  setTimeout(function () {
    var activeTab = mask.querySelector('[data-radio-category="' + radioModeState.category + '"]');
    if (activeTab) activeTab.focus();
  }, 0);
}

function selectRadioCategory(category) {
  if (!/^(all|personal|scene|style|energy)$/.test(String(category || ''))) return;
  radioModeState.category = String(category);
  renderRadioModes();
}

function refreshRadioModes() {
  radioModeState.orderNonce += 1;
  renderRadioModes();
  showToast('电台顺序已换一批');
}

function closeRadioModes() {
  var mask = document.getElementById('home-radio-modes-mask');
  if (!mask) return;
  mask.classList.remove('show');
  mask.setAttribute('aria-hidden', 'true');
  var previous = radioModeState.previousFocus;
  if (previous && typeof previous.focus === 'function') {
    try { previous.focus(); } catch (_error) {}
  }
  radioModeState.previousFocus = null;
}

function bindRadioModesControls() {
  var mask = document.getElementById('home-radio-modes-mask');
  if (!mask) return;
  var closeBtn = mask.querySelector('#home-radio-modes-close');
  if (closeBtn) closeBtn.addEventListener('click', closeRadioModes);
  mask.addEventListener('click', function (event) {
    if (event.target === mask) closeRadioModes();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && mask.classList.contains('show')) closeRadioModes();
  });
}

bindRadioModesControls();

// 覆盖 agent-adapter.js 预留的桩函数，让 HTML onclick 与 AI agent 调用都走真实实现
window.openRadioModes = openRadioModes;
window.selectRadioCategory = selectRadioCategory;
window.refreshRadioModes = refreshRadioModes;
window.toggleRadioModeFavorite = toggleRadioModeFavorite;
window.playRadioMode = playRadioMode;
