function songFromListenRecord(record) {
  if (!record) return null;
  var provider = record.sourceKey || '';
  if (!provider && record.type === 'qq') provider = 'qq';
  if (!provider) provider = record.mid ? 'qq' : 'netease';
  return {
    provider: provider,
    source: provider,
    type: record.type || (provider === 'qq' ? 'qq' : 'song'),
    id: record.id || record.mid || record.key || '',
    mid: record.mid || '',
    songmid: record.mid || '',
    mediaMid: record.mediaMid || '',
    name: record.name || '继续听',
    artist: record.artist || '',
    cover: record.cover || '',
  };
}
async function playHomeRecent(record) {
  record = record || homeListenSummary().recent;
  if (!record) {
    showToast('还没有听歌记录');
    return;
  }
  var song = songFromListenRecord(record);
  if (!song || (!song.id && !song.mid)) {
    runHomeSearch(record.name || '');
    return;
  }
  activeRadioContext = null;
  playQueue = [cloneSong(song)];
  currentIdx = 0;
  safeRenderQueuePanel('home-recent-song');
  safeShelfRebuild('home-recent-song', true);
  forcePlaybackControlsInteractive();
  await playQueueAt(0);
}
function openHomeInsight() {
  var summary = homeListenSummary();
  if (summary.topArtist && summary.topArtist.name) {
    runHomeSearch(summary.topArtist.name);
    return;
  }
  if (summary.topSong && summary.topSong.name) {
    runHomeSearch(summary.topSong.name);
    return;
  }
  showToast('播放几首歌后会生成听歌画像');
}
// 影视画像：取今日观看时长最长的影片名 → 打开影视搜索页并立即搜索
function openHomeVideoInsight() {
  var SFV = (typeof window !== 'undefined' && window.StellaflixVideo) ? window.StellaflixVideo : null;
  var kw = '';
  try {
    if (SFV && SFV.watchHistory && SFV.watchHistory.getTodayInsight) {
      var info = SFV.watchHistory.getTodayInsight();
      kw = (info && info.longestTitle) ? info.longestTitle : '';
    }
    // 兜底：今日无数据时尝试从最近一条历史取 title 作为画像关键词
    if (!kw && SFV && SFV.watchHistory && SFV.watchHistory.getAll) {
      var all = SFV.watchHistory.getAll();
      if (all && all[0]) kw = all[0].title || '';
    }
  } catch (e) { kw = ''; }
  kw = String(kw || '').trim();
  if (!kw) {
    if (typeof showToast === 'function') showToast('看几部影片后会生成影视画像');
    return;
  }
  if (SFV && SFV.online && typeof SFV.online.openSearchPage === 'function'
      && typeof SFV.online.doInlineSearch === 'function') {
    SFV.online.openSearchPage();
    // 等搜索页焦点动画 + 初始化完成后自动填入并触发搜索
    setTimeout(function () {
      try { SFV.online.doInlineSearch(kw); } catch (e) {
        if (typeof showToast === 'function') showToast('影视画像搜索失败');
      }
    }, 280);
    return;
  }
  // 加载序兜底：SFV.online 未就绪时仅提示关键词
  if (typeof showToast === 'function') showToast('影视画像关键词：' + kw);
}
function handleHomeTileClick(index) {
  var row = document.getElementById('home-tile-row');
  var item = row && row._homeTiles && row._homeTiles[index];
  if (!item) return;
  if (item.kind === 'recent') playHomeRecent(item.record);
  else if (item.kind === 'profile') openHomeInsight();
  else if (item.kind === 'song') playHomeSong(item.index);
  else if (item.kind === 'login') showLoginModal({ source: 'home-tile' });
  else if (item.kind === 'local') openHomeLocalImport();
  else if (item.kind === 'guide') openHomeProductGuide();
  else if (item.kind === 'playlist') openHomePlaylist(item.index);
  else if (item.kind === 'podcast') openHomePodcast(item.index);
  else if (item.kind === 'podcastSearch') { setSearchMode('podcast'); loadPodcastHot(); }
  else if (item.kind === 'library') openHomeLibrary();
  else runHomeSearch(item.query || item.title || '');
}
