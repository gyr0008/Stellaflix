'use strict';

/* ============================================================
   Daily Hot — 各平台排行榜
   1:1 移植自 Mineradio-LX-Music-1.7.0 public/index.html：
     状态与目录 25789-25796 / 源标签与子榜 26048-26091 / 选择·渲染·加载更多 26332-26401 /
     加载 26402-26441 / 播放四动作 26442-26472。
   服务端切片 = daily-hot-api.js + server.js 的 GET /api/daily-hot、GET /api/platform-charts。

   偏离（只动壳层，行为、数值与文案逐字保留）：
   1) LX 用自家 secondary-view 页面体系（primaryView / setSecondaryPage / closeSecondaryView /
      setPrimaryNavActive / closePlaylistPanelForSecondaryView / setPeek / openPrimaryView）。
      SF 无该体系 → 按 04a-radio-modes.js 先例改用 SF 弹窗壳：#daily-hot-ranking-mask +
      openDailyHotRanking / closeDailyHotRanking；LX 的 kicker / secondary-title / secondary-subtitle
      三行文案搬进弹窗头部。
   2) LX 行副标题 = songDisplaySubtitle → songArtistText → normalizeLocalMetadataValue 本地元数据链，
      SF 全库不存在该链（属「本地资料库」切片）。排行榜行只带 name/singer/albumName，两条路径取值等价，
      故 platformRankingArtistText 直取 LX songArtistText 的同名候选字段（artist/singer/author/
      artistName/singerName），为空时回落 songSourceLabel(song) —— 与 LX songDisplaySubtitle 的末路一致。
   3) snapshotQueueForUndo（播整榜前存可撤销快照）SF 不存在，与 04a 同样省略。
   4) 「打开音乐库」LX = openPrimaryView('library')，SF 等价物 = openHomeLibrary()。
   5) normalizeLxSourceName / escAttr 在 SF 无全局版（escAttr 只有两处模块私有副本），
      前者照 LX 原名带上，后者改名 dailyHotEscAttr 以免覆盖别人的全局。
   ============================================================ */

var platformRankingState = { source:'all', chartId:'', songs:[], cache:Object.create(null), loading:false, error:'', requestToken:0, chartMode:'', chartLabel:'', renderLimit:40 };
var PLATFORM_RANKING_CATALOG = {
  tx:[{id:'26',name:'热歌榜'},{id:'62',name:'飙升榜'},{id:'27',name:'新歌榜'},{id:'4',name:'流行指数榜'},{id:'5',name:'内地榜'},{id:'3',name:'欧美榜'},{id:'16',name:'韩国榜'},{id:'17',name:'日本榜'}],
  wy:[{id:'3778678',name:'热歌榜'},{id:'19723756',name:'飙升榜'},{id:'3779629',name:'新歌榜'},{id:'2884035',name:'原创榜'}],
  kw:[{id:'16',name:'热歌榜'},{id:'17',name:'新歌榜'},{id:'93',name:'飙升榜'}],
  kg:[{id:'8888',name:'TOP 500'},{id:'6666',name:'飙升榜'},{id:'31308',name:'新歌榜'}],
  mg:[{id:'27186466',name:'尖叫热歌榜'}]
};

// 偏离 5：LX index.html:31689 原名照搬；SF 若日后引入同名链，删本副本即可。
function normalizeLxSourceName(value) {
  var sourceName = String(value || '').toLowerCase();
  return ({ qq:'tx', netease:'wy', kuwo:'kw', kugou:'kg', migu:'mg' })[sourceName] || sourceName;
}

// 偏离 5：LX index.html:23155 的 escAttr，改名避免抢占别处同名全局。
function dailyHotEscAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(ch){
    return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;';
  });
}

function platformRankingSourceLabel(source) {
  source = normalizeLxSourceName(source || 'all');
  return ({ all:'综合', tx:'小秋', wy:'小芸', kw:'小蜗', kg:'小狗', mg:'小菇' })[source] || String(source || '综合').toUpperCase();
}

function normalizePlatformRankingSource(source) {
  source = normalizeLxSourceName(source || 'all');
  return /^(all|tx|wy|kw|kg|mg)$/.test(source) ? source : 'all';
}

function updatePlatformRankingTabs() {
  document.querySelectorAll('[data-ranking-source]').forEach(function(button){
    var active = button.getAttribute('data-ranking-source') === platformRankingState.source;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  var chartTabs = document.getElementById('ranking-chart-tabs');
  var charts = PLATFORM_RANKING_CATALOG[platformRankingState.source] || [];
  if (charts.length && !charts.some(function(item){ return item.id === platformRankingState.chartId; })) platformRankingState.chartId = charts[0].id;
  if (chartTabs) {
    chartTabs.hidden = platformRankingState.source === 'all';
    chartTabs.innerHTML = charts.map(function(item){
      return '<button class="playlist-square-tag' + (item.id === platformRankingState.chartId ? ' active' : '') + '" type="button" role="tab" onclick="selectPlatformChart(\'' + dailyHotEscAttr(item.id) + '\')">' + escHtml(item.name) + '</button>';
    }).join('');
  }
  var title = document.getElementById('ranking-summary-title');
  var activeChart = charts.find(function(item){ return item.id === platformRankingState.chartId; });
  if (title) title.textContent = platformRankingState.source === 'all' ? '综合热榜' : platformRankingSourceLabel(platformRankingState.source) + (activeChart ? activeChart.name : '热榜');
}

// 偏离 1：LX openPlatformRanking 的 secondary-view 导航段换成 SF 弹窗开合，其余同序。
function openDailyHotRanking(source) {
  platformRankingState.source = normalizePlatformRankingSource(source || platformRankingState.source);
  var mask = document.getElementById('daily-hot-ranking-mask');
  if (!mask) return;
  platformRankingState.previousFocus = document.activeElement;
  mask.classList.add('show');
  mask.setAttribute('aria-hidden', 'false');
  updatePlatformRankingTabs();
  loadPlatformRanking(platformRankingState.source, false);
  setTimeout(function () {
    var activeTab = mask.querySelector('[data-ranking-source="' + platformRankingState.source + '"]');
    if (activeTab) activeTab.focus();
  }, 0);
}

function closeDailyHotRanking() {
  var mask = document.getElementById('daily-hot-ranking-mask');
  if (!mask) return;
  mask.classList.remove('show');
  mask.setAttribute('aria-hidden', 'true');
  var previous = platformRankingState.previousFocus;
  if (previous && typeof previous.focus === 'function') {
    try { previous.focus(); } catch (_error) {}
  }
  platformRankingState.previousFocus = null;
}

function selectPlatformRanking(source) {
  source = normalizePlatformRankingSource(source);
  if (platformRankingState.loading && source === platformRankingState.source) return;
  platformRankingState.source = source;
  platformRankingState.chartId = ((PLATFORM_RANKING_CATALOG[source] || [])[0] || {}).id || '';
  platformRankingState.renderLimit = 40;
  updatePlatformRankingTabs();
  loadPlatformRanking(source, false);
}

function selectPlatformChart(chartId) {
  if (platformRankingState.loading && String(chartId) === platformRankingState.chartId) return;
  platformRankingState.chartId = String(chartId || '');
  platformRankingState.renderLimit = 40;
  updatePlatformRankingTabs();
  loadPlatformRanking(platformRankingState.source, false);
}

function refreshPlatformRanking() {
  platformRankingState.renderLimit = 40;
  loadPlatformRanking(platformRankingState.source, true);
}

function platformRankingQueueSong(song, index) {
  var queued = cloneSong(song || {});
  var source = normalizeLxSourceName(queued.source || queued.provider || queued.type);
  if (/^(tx|wy|kw|kg|mg)$/.test(source)) queued.type = 'online-queue';
  queued.rankingIndex = Number(index) || 0;
  queued.rankingName = platformRankingSourceLabel(platformRankingState.source) + '热榜';
  return queued;
}

// 偏离 2：等价取代 LX 的 songDisplaySubtitle(song)（候选字段同名同序，仅缺本地元数据清洗）。
function platformRankingArtistText(song) {
  song = song || {};
  var candidates = [song.artist, song.singer, song.author, song.artistName, song.singerName];
  for (var i = 0; i < candidates.length; i++) {
    var value = candidates[i];
    if (Array.isArray(value)) {
      value = value.map(function(item){
        return item && (item.name || item.artist || item.singer) || '';
      }).filter(Boolean).join(' / ');
    } else if (value && typeof value === 'object') {
      value = value.name || value.artist || value.singer || '';
    }
    value = String(value == null ? '' : value).trim();
    if (value) return value;
  }
  return '';
}

// 偏离 2：等价取代 LX 的 songDisplaySubtitle(song)（候选字段同名同序，仅缺本地元数据清洗；
// 排行榜行永远不是 type:'local'，故 LX 的本地音质分支在本页不可达，未随迁）。
function platformRankingSubtitleText(song) {
  if (!song) return '';
  var artist = platformRankingArtistText(song);
  var album = String(song.album || '').trim();
  var bits = [];
  if (artist) bits.push(artist);
  if (album && bits.indexOf(album) < 0) bits.push(album);
  return bits.join(' · ') || songSourceLabel(song);
}

// LX index.html:26378-26392 的行模板，逐字提取为具名函数（node 侧可测，模板串未改）。
function platformRankingRowHtml(song, index) {
  var cover = songCoverSrc(song, 110);
  var coverHtml = cover ? '<img class="ranking-cover" src="' + escHtml(cover) + '" alt="" loading="lazy" width="50" height="50">' : '<span class="ranking-cover"></span>';
  var title = song.name || song.title || '未知歌曲';
  var subtitle = platformRankingSubtitleText(song) || song.albumName || '未知歌手';
  return '<div class="ranking-row" role="button" tabindex="0" data-ranking-index="' + index + '" onclick="if(!event.target.closest(\'button\'))playPlatformRankingSong(' + index + ')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();playPlatformRankingSong(' + index + ')}">' +
    '<span class="ranking-number">' + String(index + 1).padStart(2, '0') + '</span>' + coverHtml +
    '<span class="ranking-copy"><span class="ranking-song-title">' + escHtml(title) + '</span><span class="ranking-song-sub">' + escHtml(subtitle) + '</span></span>' +
    '<span class="ranking-source">' + escHtml(platformRankingSourceLabel(song.source || platformRankingState.source)) + '</span>' +
    '<span class="ranking-row-actions"><button class="ranking-icon-btn" type="button" onclick="event.stopPropagation();playPlatformRankingSong(' + index + ')" title="播放" aria-label="播放 ' + escHtml(title) + '">▶</button><button class="ranking-icon-btn" type="button" onclick="event.stopPropagation();queuePlatformRankingSong(' + index + ')" title="下一首播放" aria-label="下一首播放 ' + escHtml(title) + '">＋</button><button class="ranking-icon-btn" type="button" onclick="event.stopPropagation();collectPlatformRankingSong(' + index + ')" title="收藏到歌单" aria-label="收藏 ' + escHtml(title) + '">♡</button></span></div>';
}

function renderPlatformRanking() {
  var root = document.getElementById('platform-ranking-list');
  var note = document.getElementById('ranking-summary-note');
  if (!root) return;
  updatePlatformRankingTabs();
  if (platformRankingState.loading) {
    root.innerHTML = '<div class="ranking-state"><strong>正在加载' + escHtml(platformRankingSourceLabel(platformRankingState.source)) + '热榜</strong>正在读取该平台自己的榜单数据…</div>';
    if (note) note.textContent = '各平台榜单相互独立，首次切换可能需要一些时间';
    return;
  }
  if (platformRankingState.error && !platformRankingState.songs.length) {
    root.innerHTML = '<div class="ranking-state"><strong>榜单暂时没有加载成功</strong>' + escHtml(platformRankingState.error) + ' · 可点击“刷新榜单”重试</div>';
    if (note) note.textContent = '当前平台音源暂不可用，可以切换其他平台';
    return;
  }
  var songs = platformRankingState.songs || [];
  if (!songs.length) {
    root.innerHTML = '<div class="ranking-state"><strong>这个平台暂时没有榜单歌曲</strong>请确认对应音源已导入，或切换到综合榜</div>';
    if (note) note.textContent = '未找到可播放的榜单歌曲';
    return;
  }
  if (note) {
    var chartLabel = platformRankingState.chartLabel || (platformRankingSourceLabel(platformRankingState.source) + '热榜');
    note.textContent = songs.length + ' 首 · ' + chartLabel + ' · 保留平台原始名次 · 每 6 小时更新';
  }
  var renderLimit = Math.min(songs.length, Math.max(40, Number(platformRankingState.renderLimit) || 40));
  root.innerHTML = songs.slice(0, renderLimit).map(platformRankingRowHtml).join('') + (songs.length > renderLimit ? '<button class="ranking-load-more" type="button" onclick="growPlatformRankingRenderLimit()">加载更多 · 已显示 ' + renderLimit + '/' + songs.length + '</button>' : '');
}

function growPlatformRankingRenderLimit() {
  platformRankingState.renderLimit = Math.min((platformRankingState.songs || []).length, (Number(platformRankingState.renderLimit) || 40) + 40);
  renderPlatformRanking();
}

async function loadPlatformRanking(source, force) {
  source = normalizePlatformRankingSource(source);
  platformRankingState.source = source;
  var cacheKey = source + '|' + (platformRankingState.chartId || 'default');
  var cached = platformRankingState.cache[cacheKey];
  if (!cached || force) platformRankingState.renderLimit = 40;
  if (!force && cached && Array.isArray(cached.songs) && cached.songs.length) {
    platformRankingState.songs = cached.songs.map(cloneSong);
    platformRankingState.chartMode = cached.chartMode || '';
    platformRankingState.chartLabel = cached.chartLabel || '';
    platformRankingState.error = '';
    platformRankingState.loading = false;
    renderPlatformRanking();
    return;
  }
  var token = ++platformRankingState.requestToken;
  platformRankingState.loading = true;
  platformRankingState.error = '';
  platformRankingState.songs = cached && cached.songs ? cached.songs.map(cloneSong) : [];
  renderPlatformRanking();
  try {
    var result = await apiJson('/api/daily-hot?limit=100&source=' + encodeURIComponent(source) + (platformRankingState.chartId ? '&chart=' + encodeURIComponent(platformRankingState.chartId) : '') + (force ? '&refresh=1' : '') + '&t=' + Date.now(), { timeoutMs:100000 });
    if (token !== platformRankingState.requestToken || source !== platformRankingState.source) return;
    var songs = result && Array.isArray(result.songs) ? result.songs.filter(function(song){ return song && song.name; }).map(cloneSong) : [];
    if (!songs.length) throw new Error(result && result.error || '没有获取到榜单歌曲');
    platformRankingState.cache[cacheKey] = { songs:songs.map(cloneSong), updatedAt:Number(result.updatedAt) || Date.now(), chartMode:String(result.chartMode || ''), chartLabel:String(result.chartLabel || '') };
    platformRankingState.songs = songs;
    platformRankingState.chartMode = String(result.chartMode || '');
    platformRankingState.chartLabel = String(result.chartLabel || '');
    platformRankingState.error = '';
  } catch (error) {
    if (token !== platformRankingState.requestToken) return;
    platformRankingState.error = error && error.message || '排行榜加载失败';
  } finally {
    if (token === platformRankingState.requestToken) {
      platformRankingState.loading = false;
      renderPlatformRanking();
    }
  }
}

function playPlatformRankingSong(index) {
  index = Number(index) || 0;
  var songs = platformRankingState.songs || [];
  if (!songs[index]) return;
  var queuedSong = platformRankingQueueSong(songs[index], index);
  playQueue.push(queuedSong);
  currentIdx = playQueue.length - 1;
  safeRenderQueuePanel('platform-ranking-play', { scrollCurrent:true });
  closeDailyHotRanking(); // 偏离 1
  forcePlaybackControlsInteractive();
  playQueueAt(currentIdx, { manual:true, context:{ type:'platform-ranking', playlistName:platformRankingSourceLabel(platformRankingState.source) + '热榜' } }).catch(function(error){ console.warn('[PlatformRankingPlay]', error); });
}

function playAllPlatformRanking() {
  if (!(platformRankingState.songs || []).length) { showToast('榜单还没有加载完成'); return; }
  // 偏离 3：LX 此处先 snapshotQueueForUndo('播放整个榜单')，SF 无撤销快照体系
  playQueue = platformRankingState.songs.map(platformRankingQueueSong);
  currentIdx = 0;
  safeRenderQueuePanel('platform-ranking-play-all', { scrollCurrent:true });
  closeDailyHotRanking(); // 偏离 1
  forcePlaybackControlsInteractive();
  playQueueAt(0, { manual:true, context:{ type:'platform-ranking', playlistName:platformRankingState.chartLabel || platformRankingSourceLabel(platformRankingState.source) + '热榜' } }).catch(function(error){ console.warn('[PlatformRankingPlayAll]', error); });
}

function queuePlatformRankingSong(index) {
  var song = (platformRankingState.songs || [])[Number(index) || 0];
  if (!song) return;
  queueDetailSongNext(platformRankingQueueSong(song, index));
}

function collectPlatformRankingSong(index) {
  var song = (platformRankingState.songs || [])[Number(index) || 0];
  if (song) openCollectModal(platformRankingQueueSong(song, index));
}

// 偏离 1 + 4：LX 摘要条的「打开音乐库」= openPrimaryView('library')，SF 走自家片库入口。
function openDailyHotMusicLibrary() {
  if (typeof openHomeLibrary === 'function') {
    closeDailyHotRanking();
    openHomeLibrary();
  } else {
    showToast('音乐库暂不可用');
  }
}

function bindDailyHotRankingControls() {
  var mask = document.getElementById('daily-hot-ranking-mask');
  if (!mask || mask.dataset.dailyHotBound === '1') return;
  mask.dataset.dailyHotBound = '1';
  var closeBtn = mask.querySelector('#daily-hot-ranking-close');
  if (closeBtn) closeBtn.addEventListener('click', closeDailyHotRanking);
  mask.addEventListener('click', function (event) {
    if (event.target === mask) closeDailyHotRanking();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && mask.classList.contains('show')) closeDailyHotRanking();
  });
}

if (typeof document !== 'undefined') bindDailyHotRankingControls();

window.openDailyHotRanking = openDailyHotRanking;
window.closeDailyHotRanking = closeDailyHotRanking;
window.selectPlatformRanking = selectPlatformRanking;
window.selectPlatformChart = selectPlatformChart;
window.refreshPlatformRanking = refreshPlatformRanking;
window.playPlatformRankingSong = playPlatformRankingSong;
window.playAllPlatformRanking = playAllPlatformRanking;
window.queuePlatformRankingSong = queuePlatformRankingSong;
window.collectPlatformRankingSong = collectPlatformRankingSong;
window.growPlatformRankingRenderLimit = growPlatformRankingRenderLimit;
window.openDailyHotMusicLibrary = openDailyHotMusicLibrary;
window.__platformRankingRowHtml = platformRankingRowHtml;
window.__platformRankingState = platformRankingState;
window.__PLATFORM_RANKING_CATALOG = PLATFORM_RANKING_CATALOG;
