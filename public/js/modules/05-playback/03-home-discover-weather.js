function fallbackHomeTiles() {
  // 批 T16b：「登录同步歌单」卡随平台登录门槛一并离场（其点击指向 16a 已摘除的 #login-modal）。
  return [
    { kind: 'search', title: '搜索一首歌', sub: '原唱优先', query: '' },
    { kind: 'local', title: '导入本地音乐', sub: '本地文件也能可视化' },
  ];
}
function homeTileCover(item) {
  if (!item) return '';
  if (item.kind === 'song') return songCoverSrc(item.song, 220);
  return item.cover ? coverUrlWithSize(item.cover, 220) : '';
}
function homeToneForItem(item, index) {
  if (!item) return 'daily';
  if (item.kind === 'recent') return 'search';
  if (item.kind === 'profile') return 'local';
  if (item.tone) return item.tone;
  if (item.kind === 'song') return index % 2 ? 'search' : 'daily';
  if (item.kind === 'playlist') return 'playlist';
  if (item.kind === 'local') return 'local';
  if (item.kind === 'search') return 'search';
  return ['daily', 'playlist', 'local', 'guide', 'search'][index % 5];
}
function renderHomeMosaic(items) {
  var cells = document.querySelectorAll('#home-mosaic .home-mosaic-cell');
  if (!cells.length) return;
  var covers = [];
  (items || []).forEach(function (item) {
    var cover = homeTileCover(item);
    if (cover) covers.push(cover);
  });
  for (var i = 0; i < cells.length; i++) {
    var src = covers[i] || covers[(i + 1) % Math.max(1, covers.length)] || '';
    cells[i].style.backgroundImage = src ? 'url("' + cssImageUrl(src) + '")' : '';
    cells[i].classList.toggle('has-cover', !!src);
    cells[i].classList.toggle('home-skeleton', !src && homeDiscoverState.loading);
  }
}
function renderHomeTiles() {
  var row = document.getElementById('home-tile-row');
  var title = document.getElementById('home-rail-title');
  var note = document.getElementById('home-rail-note');
  if (!row) return;
  var tiles = [];
  var summary = homeListenSummary();
  if (summary.recent && tiles.length < 5) {
    tiles.push({ kind: 'recent', title: summary.recent.name || '继续听', sub: summary.recent.artist || summary.recent.source || '', cover: summary.recent.cover, record: summary.recent });
  }
  if (summary.topArtist && tiles.length < 5) {
    tiles.push({ kind: 'profile', title: summary.topArtist.name, sub: '常听歌手 · ' + summary.topArtist.plays + ' 次', query: summary.topArtist.name });
  }
  if (!tiles.length) tiles = fallbackHomeTiles();
  tiles = tiles.slice(0, 5);
  if (title) title.textContent = summary.recent ? '接着听' : '先从这里开始';
  if (note) {
    var liveNote = homeDiscoverState.updatedAt ? '刚刚更新 · 点击即可播放' : '点击即可播放';
    note.textContent = homeDiscoverState.loading ? '正在整理推荐' : (homeDiscoverState.error ? '离线精选' : liveNote);
  }
  row.innerHTML = tiles.map(function (item, i) {
    var cover = homeTileCover(item);
    var tone = homeToneForItem(item, i);
    var coverClass = 'home-tile-cover' + (cover ? ' has-cover' : '');
    return '<button class="home-tile' + (!cover && homeDiscoverState.loading ? ' home-skeleton' : '') + '" data-home-tone="' + escHtml(tone) + '" type="button" onclick="handleHomeTileClick(' + i + ')">' +
      '<div class="' + coverClass + '" style="' + (cover ? 'background-image:url(&quot;' + escHtml(cssImageUrl(cover)) + '&quot;)' : '') + '"></div>' +
      '<div class="home-tile-title">' + escHtml(item.title || '') + '</div>' +
      '<div class="home-tile-sub">' + escHtml(item.sub || '') + '</div>' +
      '</button>';
  }).join('');
  row._homeTiles = tiles;
  renderHomeMosaic(tiles);
}
function renderHomeDiscover() {
  // 双态隔离（P0）：影视态下禁止重渲音乐首页（覆盖 #home-tile-row 与 .home-hero 文案），避免覆盖影视态首页。
  // 影视态首页由 public/video/home.js 的 render() 独立接管；此处早退彻底阻断 13+ 音乐调用点污染影视首页。
  if (document.body.classList.contains('video-space-active') || (window.StellaflixVideo && window.StellaflixVideo.state && window.StellaflixVideo.state.isVideo && window.StellaflixVideo.state.isVideo())) return;
  var sub = document.getElementById('home-subtitle');
  var weatherTitle = document.getElementById('home-weather-title');
  var weatherKicker = document.getElementById('home-weather-kicker');
  var weatherMeta = document.getElementById('home-weather-meta');
  if (weatherTitle) weatherTitle.textContent = '我的音乐库';
  if (weatherKicker) weatherKicker.textContent = 'Stellaflix · Your Library';
  if (sub) sub.textContent = '从你的歌单、最近播放、平台推荐和常听歌手开始。';
  if (weatherMeta) {
    var meta = ['个人推荐', '平台歌单', '热门电台'];
    weatherMeta.innerHTML = meta.map(function (text) { return '<span class="home-weather-pill">' + escHtml(text) + '</span>'; }).join('');
  }
  var playlistItem = homeDiscoverState.playlists[0] || null;
  var summary = homeListenSummary();
  var weatherCardTitle = document.getElementById('home-weather-card-title');
  var weatherCardSub = document.getElementById('home-weather-card-sub');
  var dailyTitle = document.getElementById('home-daily-title');
  var dailySub = document.getElementById('home-daily-sub');
  var privateTitle = document.getElementById('home-private-title');
  var privateSub = document.getElementById('home-private-sub');
  var continueTitle = document.getElementById('home-continue-title');
  var continueSub = document.getElementById('home-continue-sub');
  var profileTitle = document.getElementById('home-profile-title');
  var profileSub = document.getElementById('home-profile-sub');
  var libTitle = document.getElementById('home-library-title');
  var libSub = document.getElementById('home-library-sub');
  if (weatherCardTitle) weatherCardTitle.textContent = '我的歌单';
  if (weatherCardSub) {
    weatherCardSub.textContent = playlistItem ? (((playlistItem.trackCount || 0) ? playlistItem.trackCount + ' 首 · ' : '') + (playlistItem.creator || '打开左侧歌单库')) : '打开左侧歌单库';
  }
  if (continueTitle) continueTitle.textContent = summary.recent ? summary.recent.name : '继续听';
  if (continueSub) continueSub.textContent = summary.recent ? (summary.recent.artist || summary.recent.source || '最近播放') : '最近播放会出现在这里';
  if (profileTitle) profileTitle.textContent = summary.topArtist ? summary.topArtist.name : (summary.topSong ? summary.topSong.name : '听歌画像');
  if (profileSub) profileSub.textContent = summary.topArtist ? ('常听歌手 · ' + summary.topArtist.plays + ' 次') : (summary.totalPlays ? summary.totalPlays + ' 次有效播放' : '播放几首后生成偏好');
  if (dailyTitle) dailyTitle.textContent = '每日推荐';
  if (dailySub) dailySub.textContent = '播放后会在这里生成今日队列';
  if (privateTitle) privateTitle.textContent = '推荐歌曲';
  if (privateSub) privateSub.textContent = '播放几首后会补全推荐';
  if (libTitle) libTitle.textContent = '更多歌曲';
  if (libSub) libSub.textContent = '播放后会继续补全推荐';
  setHomeArt('home-weather-art', (userPlaylists[0] && userPlaylists[0].cover) || summary.recent && summary.recent.cover, 280);
  setHomeArt('home-daily-art', '', 280);
  setHomeArt('home-private-art', summary.recent && summary.recent.cover, 280);
  setHomeArt('home-continue-art', summary.recent && summary.recent.cover, 280);
  setHomeArt('home-profile-art', summary.topSong && summary.topSong.cover || summary.recent && summary.recent.cover, 280);
  setHomeArt('home-library-art', '', 280);
  renderHomeTiles();
}
async function loadHomeDiscover(force) {
  if (homeDiscoverState.loading) return;
  if (homeDiscoverState.loaded && !force) return;
  var token = ++homeDiscoverToken;
  homeDiscoverState.loading = true;
  homeDiscoverState.error = '';
  renderHomeDiscover();
  try {
    var data = await apiJson('/api/discover/home?t=' + Date.now());
    if (token !== homeDiscoverToken) return;
    homeDiscoverState.loggedIn = !!(data && data.loggedIn);
    homeDiscoverState.mode = data && data.mode || (homeDiscoverState.loggedIn ? 'member' : 'starter');
    homeDiscoverState.songs = homeDiscoverState.loggedIn ? (data && data.dailySongs || []).map(cloneSong) : [];
    homeDiscoverState.playlists = homeDiscoverState.loggedIn ? ((data && data.playlists && data.playlists.length) ? data.playlists : userPlaylists.slice(0, 10)) : [];
    homeDiscoverState.updatedAt = Number(data && data.updatedAt) || Date.now();
    homeDiscoverState.loaded = true;
  } catch (e) {
    console.warn('home discover failed:', e);
    if (token === homeDiscoverToken) homeDiscoverState.error = 'DISCOVER_FAILED';
  } finally {
    if (token === homeDiscoverToken) {
      homeDiscoverState.loading = false;
      renderHomeDiscover();
    }
  }
}
