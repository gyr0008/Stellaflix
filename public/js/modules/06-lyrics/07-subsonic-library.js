// ---------- Subsonic / Navidrome 远程音乐库（播放列表面板第四 tab） ----------
var subsonicNav = [];          // 视图栈
var subsonicSongsCache = [];   // 当前 songs 视图的曲目（供点击播放）
var subsonicRenderSeq = 0;     // 渲染序号：快速钻入→返回时，过期异步渲染不得覆盖新视图的 innerHTML/行索引

function subsonicCurrentView() { return subsonicNav[subsonicNav.length - 1] || { type: 'servers' }; }
function subsonicPushView(view) { subsonicNav.push(view); renderSubsonicPane(); }
function subsonicBack() { subsonicNav.pop(); renderSubsonicPane(); }

function fmtSubsonicDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  var m = Math.floor(sec / 60), s2 = sec % 60;
  return m + ':' + (s2 < 10 ? '0' : '') + s2;
}

// 远程值（serverId / artistId / albumId / playlistId / trackId / cover 地址）插入 HTML 属性前必须用这个。
// 共享的 escHtml 走 textContent→innerHTML，只转义 & < >，不转义双引号，
// 于是 `x" onmouseover="alert(1)` 这类 id 能闭合属性并注入事件处理器（同源脚本执行）。
// 只在本模块内加，不改公共 escHtml（全站共用）。
function subAttr(s) { return escHtml(String(s == null ? '' : s)).replace(/"/g, '&quot;'); }

function subsonicHead(title, canBack) {
  return '<div class="podcast-inline-head"><div class="pl-section-label">' + escHtml(title) + '</div>' +
    (canBack ? '<button class="fx-mini-btn ghost" data-sub-act="back" style="height:24px;padding:0 9px;font-size:10.5px">返回</button>' : '') +
    '</div>';
}
function subsonicCard(attrs) {
  return '<div class="pl-card podcast-card" data-sub-act="' + subAttr(attrs.act) + '"' +
    (attrs.id ? ' data-sub-id="' + subAttr(attrs.id) + '"' : '') +
    (attrs.extra || '') + '>' +
    (attrs.cover ? '<img src="' + subAttr(attrs.cover) + '" alt="" loading="lazy" decoding="async" style="width:44px;height:44px;border-radius:8px;flex-shrink:0" onerror="this.style.opacity=0.2">' : '<div style="width:44px;height:44px;border-radius:8px;background:rgba(0,245,212,.07);flex-shrink:0"></div>') +
    '<div style="flex:1;min-width:0"><div class="pl-name">' + escHtml(attrs.name || '') + '</div><div class="pl-sub">' + escHtml(attrs.sub || '') + '</div></div>' +
    (attrs.tail || '') + '</div>';
}

async function renderSubsonicPane() {
  var $list = document.getElementById('subsonic-list');
  if (!$list) return;
  var view = subsonicCurrentView();
  showLoading();
  var seq = ++subsonicRenderSeq;
  try {
    if (view.type === 'servers') {
      var r = await apiJson('/api/subsonic/config');
      // apiJson 不拦非 2xx：后端 {error:'SUBSONIC_…'} 会以正常 JSON 返回体落地，
      // 不显式抛出就会被下面的 || [] 兜底吞成「暂无内容」空态。
      if (r && r.error) throw new Error(r.error);
      var servers = r.servers || [];
      var cards = servers.map(function (s) {
        return subsonicCard({ act: 'server', id: s.id, name: s.name, sub: s.username + ' @ ' + s.baseUrl,
          extra: ' data-sub-server-id="' + subAttr(s.id) + '"',
          // 「歌单」是 playlists 视图的唯一入口：渲染分支里 view.type === 'playlists' 只有经此才可达
          tail: '<span style="display:flex;gap:6px;align-items:center">' +
            '<button class="fx-mini-btn ghost" data-sub-act="server-playlists" data-sub-id="' + subAttr(s.id) + '" style="height:24px;padding:0 9px;font-size:10.5px">歌单</button>' +
            '<button class="fx-mini-btn ghost" data-sub-act="delete-server" data-sub-id="' + subAttr(s.id) + '" style="height:24px;padding:0 9px;font-size:10.5px">删除</button></span>' });
      }).join('');
      var empty = '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">尚未添加服务器</div>';
      var form = '<form id="subsonic-server-form" style="padding:10px;display:flex;flex-direction:column;gap:6px">' +
        '<input id="subsonic-name" placeholder="名称（如：家里NAS）" style="height:28px;font-size:12px" autocomplete="off">' +
        '<input id="subsonic-url" placeholder="服务器地址 http://…:4533" style="height:28px;font-size:12px" autocomplete="off">' +
        '<input id="subsonic-user" placeholder="用户名" style="height:28px;font-size:12px" autocomplete="off">' +
        '<input id="subsonic-pass" type="password" placeholder="密码" style="height:28px;font-size:12px" autocomplete="new-password">' +
        '<button type="submit" class="fx-mini-btn ghost" style="height:28px;font-size:12px">保存</button></form>';
      if (seq !== subsonicRenderSeq) return;
      $list.innerHTML = subsonicHead('远程音乐库', false) + (cards || empty) + form;
      return;
    }
    if (view.type === 'artists') {
      var ra = await apiJson('/api/subsonic/artists?server=' + encodeURIComponent(view.serverId));
      if (ra && ra.error) throw new Error(ra.error);
      var groups = (ra.indexes || []).map(function (ix) {
        return '<div class="pl-section-label" style="opacity:.5">' + escHtml(ix.name) + '</div>' +
          ix.artists.map(function (a) {
            return subsonicCard({ act: 'artist', id: a.id, name: a.name, sub: (a.albumCount || 0) + ' 张专辑', extra: ' data-sub-server-id="' + subAttr(view.serverId) + '"' });
          }).join('');
      }).join('');
      if (seq !== subsonicRenderSeq) return;
      $list.innerHTML = subsonicHead('艺术家', true) + (groups || '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">暂无内容</div>');
      return;
    }
    if (view.type === 'albums' || view.type === 'playlists') {
      var url2 = view.type === 'albums'
        ? '/api/subsonic/artist?server=' + encodeURIComponent(view.serverId) + '&id=' + encodeURIComponent(view.artistId)
        : '/api/subsonic/playlists?server=' + encodeURIComponent(view.serverId);
      var r2 = await apiJson(url2);
      if (r2 && r2.error) throw new Error(r2.error);
      var items = view.type === 'albums' ? (r2.albums || []) : (r2.playlists || []);
      subsonicNav[subsonicNav.length - 1].items = items;
      var itemCards = items.map(function (it) {
        return subsonicCard({ act: view.type === 'albums' ? 'album' : 'playlist', id: it.id, name: it.title || it.name, sub: (it.artist || it.owner || '') + (it.songCount ? ' · ' + it.songCount + ' 首' : ''), cover: it.cover, extra: ' data-sub-server-id="' + subAttr(view.serverId) + '"' });
      }).join('');
      if (seq !== subsonicRenderSeq) return;
      $list.innerHTML = subsonicHead(view.title || (view.type === 'albums' ? '专辑' : '歌单'), true) +
        (itemCards || '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">暂无内容</div>');
      return;
    }
    if (view.type === 'songs') {
      var r3 = await apiJson(view.endpoint);
      if (r3 && r3.error) throw new Error(r3.error);
      // 只保留带 localUrl（/api/audio?url=… 代理串流地址）的曲目：
      // 行内 data-sub-id 是本数组下标，渲染与播放必须共用同一份过滤后的数组，索引才不会错位。
      var songs = (r3.songs || []).filter(function (sg) { return sg && sg.localUrl; });
      view.songs = songs;
      subsonicSongsCache = songs;
      var meta = r3.album || r3.playlist || {};
      var songRows = songs.map(function (sg, i) {
        return subsonicCard({ act: 'play', id: i, name: sg.name, sub: sg.artist + (sg.album ? ' — ' + sg.album : ''), cover: sg.cover, tail: '<span style="font-size:10.5px;opacity:.5">' + fmtSubsonicDuration(sg.duration) + '</span>' });
      }).join('');
      if (seq !== subsonicRenderSeq) return;
      $list.innerHTML = subsonicHead(view.title || meta.title || meta.name || '曲目', true) +
        (songRows || '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">暂无曲目</div>');
      return;
    }
    if (seq !== subsonicRenderSeq) return;
    $list.innerHTML = '';
  } catch (e) {
    console.warn('[Subsonic]', e);
    // canBack 取决于栈是否真有上一层：servers 视图（栈空）出错时不该出现「返回」按钮，
    // 点了会 pop 空数组并渲染出无意义的空态。
    if (seq !== subsonicRenderSeq) return;
    $list.innerHTML = subsonicHead(subsonicCurrentView().title || '远程音乐库', subsonicNav.length > 0) +
      '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">加载失败: ' + escHtml(e.message || String(e)) + '</div>';
  } finally {
    hideLoading();
  }
}

function refreshSubsonicPane() { return renderSubsonicPane(); }

async function playSubsonicSongs(songs, idx) {
  if (!songs || !songs.length) { showToast('没有可播放的曲目'); return; }
  playQueue = songs.map(cloneSong);
  currentIdx = Math.max(0, Math.min(idx || 0, songs.length - 1));
  safeRenderQueuePanel('subsonic');
  safeSwitchPlaylistTab('queue', 'subsonic');
  safeShelfRebuild('subsonic', true);
  forcePlaybackControlsInteractive();
  await playQueueAt(currentIdx);
}

async function submitSubsonicServer() {
  var get = function (id) { return (document.getElementById(id) || {}).value || ''; };
  var body = { name: get('subsonic-name').trim(), baseUrl: get('subsonic-url').trim(), username: get('subsonic-user').trim(), password: get('subsonic-pass') };
  if (!body.baseUrl || !body.username || !body.password) { showToast('请填写地址、用户名和密码'); return; }
  try {
    var r = await apiJson('/api/subsonic/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.error) { showToast('保存失败: ' + r.error); return; }
    showToast('已保存');
    await renderSubsonicPane();
  } catch (e) { showToast('保存失败: ' + (e.message || e)); }
}

var $subsonicList = document.getElementById('subsonic-list');
if ($subsonicList) {
  $subsonicList.addEventListener('submit', function (e) {
    if (e.target && e.target.id === 'subsonic-server-form') {
      e.preventDefault();
      submitSubsonicServer();
    }
  });
  $subsonicList.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-sub-act]') : null;
    if (!el) return;
    var act = el.getAttribute('data-sub-act');
    var id = el.getAttribute('data-sub-id');
    var serverId = el.getAttribute('data-sub-server-id') || (subsonicCurrentView().serverId || '');
    // 名称取自所属卡片（卡内按钮如「歌单」「删除」自身没有 .pl-name 子节点）
    var card = (el.closest && el.closest('.pl-card')) || el;
    var title = (card.querySelector('.pl-name') || {}).textContent || '';
    if (act === 'back') { subsonicBack(); return; }
    if (act === 'delete-server') {
      // 非 async 回调 + then 双分支：apiJson 在网络层失败时会 reject，缺第二个处理器会变成
      // Uncaught (in promise)（拼接脚本里的顶层监听回调没有 try/catch 兜底），故显式收敛。
      // 失败要有反馈：reject（断网/超时）与 2xx 但 ok:false / {error:…}（id 不存在）都要提示「删除失败」。
      apiJson('/api/subsonic/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', id: id }) })
        .then(function (rd) {
          if (rd && (rd.error || rd.ok === false)) { showToast('删除失败'); renderSubsonicPane(); return; }
          renderSubsonicPane();
        }, function (e) { console.warn('[Subsonic]', e); showToast('删除失败'); renderSubsonicPane(); });
      return;
    }
    if (act === 'server') { subsonicPushView({ type: 'artists', serverId: id, title: title }); return; }
    if (act === 'server-playlists') { subsonicPushView({ type: 'playlists', serverId: id, title: title + ' · 歌单' }); return; }
    if (act === 'artist') { subsonicPushView({ type: 'albums', serverId: serverId, artistId: id, title: title }); return; }
    if (act === 'album') { subsonicPushView({ type: 'songs', serverId: serverId, title: title, endpoint: '/api/subsonic/album?server=' + encodeURIComponent(serverId) + '&id=' + encodeURIComponent(id) }); return; }
    if (act === 'playlist') { subsonicPushView({ type: 'songs', serverId: serverId, title: title, endpoint: '/api/subsonic/playlist?server=' + encodeURIComponent(serverId) + '&id=' + encodeURIComponent(id) }); return; }
    if (act === 'play') {
      var view = subsonicCurrentView();
      playSubsonicSongs(view.songs || subsonicSongsCache, parseInt(id, 10) || 0);
    }
  });
}
window.refreshSubsonicPane = refreshSubsonicPane;
window.submitSubsonicServer = submitSubsonicServer;
