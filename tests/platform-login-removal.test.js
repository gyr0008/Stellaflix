'use strict';

/**
 * tests/platform-login-removal.test.js — 平台登录族 + 五平台官方 API 整批退役钉桩（批 T16d）
 *
 * 主人裁定（2026-10-31）：
 *  ①1 /api/song/url 当时保留为无凭证公开端点；批 T18（2026-11-01，主人选项2）改判
 *      随官方直链一并退役——在线播放地址只来自用户音源脚本 /api/lx-source/resolve；
 *  ①2 各平台 user/playlists 族退役，前端歌单面板改 local-only；
 *  ①3 /api/album/detail + /api/artist/detail 保留；/api/album/subscribe(/check) 落 404；
 *  ①4 /api/discover/home + NeteaseCloudMusicApi 依赖保留（未登录回 starter）。
 *
 * 于是保留面 = 网易云公开元数据 6 条：/api/playlist/tracks、
 * /api/album/detail、/api/artist/detail、/api/lyric、/api/search、/api/discover/home。
 * 其余平台登录族（netease 18 条散点 + qq 10 + kugou 11 + qishui 15 + spotify 16）
 * 全部经一条统一守卫落 404 { ok:false, error:'REMOVED' }。
 *
 * 端口 3991（3992 归 16c podocast-removal，3999 他程占用）。
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// ---------- ① 进程内起服：退役端点全落 404 REMOVED ----------
const PORT = 3991;
process.env.PORT = String(PORT);
delete process.env.HOST;

const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;

async function waitListening() {
  if (server.listening) return;
  await new Promise((resolve) => server.once('listening', resolve));
}

// netease 18 条（登录/账号态/写回） + qq 10 + kugou 11 + qishui 15 + spotify 16
const RETIRED_ENDPOINTS = [
  '/api/platform/capabilities',
  '/api/listen/total',
  '/api/login/cookie',
  '/api/login/qr/key',
  '/api/login/qr/create',
  '/api/login/qr/check',
  '/api/login/status',
  '/api/logout',
  '/api/user/playlists',
  '/api/album/subscribe',
  '/api/album/subscribe/check?id=1',
  '/api/playlist/subscribe',
  '/api/song/like/check',
  '/api/song/like',
  '/api/playlist/create',
  '/api/playlist/add-song',
  '/api/song/comments?id=1',
  '/api/song/comments/like',
  '/api/song/url?id=441102546',
  '/api/qq/search?keywords=test',
  '/api/qq/lyric?songmid=x',
  '/api/qq/login/status',
  '/api/qq/login/cookie',
  '/api/qq/logout',
  '/api/qq/user/playlists',
  '/api/qq/playlist/tracks?id=x',
  '/api/qq/artist/detail?mid=x',
  '/api/qq/album/detail?mid=x',
  '/api/qq/song/comments?id=x',
  '/api/kugou/search?keywords=test',
  '/api/kugou/recommendations',
  '/api/kugou/lyric?hash=x',
  '/api/kugou/login/status',
  '/api/kugou/login/cookie',
  '/api/kugou/logout',
  '/api/kugou/user/playlists',
  '/api/kugou/playlist/tracks?id=1',
  '/api/kugou/song/like/check',
  '/api/kugou/song/like',
  '/api/kugou/playlist/add-song',
  '/api/qishui/login/qrcode',
  '/api/qishui/login/check',
  '/api/qishui/login/status',
  '/api/qishui/logout',
  '/api/qishui/search?keywords=test',
  '/api/qishui/feed',
  '/api/qishui/user/playlists',
  '/api/qishui/playlist/tracks?id=1',
  '/api/qishui/song/like/check',
  '/api/qishui/song/like',
  '/api/qishui/playlist/collect',
  '/api/qishui/playlist/add-song',
  '/api/qishui/album/collect',
  '/api/qishui/song/comments?id=1',
  '/api/qishui/lyric?id=1',
  '/api/spotify/status',
  '/api/spotify/config',
  '/api/spotify/logout',
  '/api/spotify/user/playlists',
  '/api/spotify/song/like/check',
  '/api/spotify/song/like',
  '/api/spotify/album/like/check',
  '/api/spotify/album/like',
  '/api/spotify/playlist/add-song',
  '/api/spotify/playlist/create',
  '/api/spotify/playlist/collect',
  '/api/spotify/playlist/tracks?id=x',
  '/api/spotify/album/detail?id=x',
  '/api/spotify/search?q=test',
  '/api/spotify/recommendations',
  '/api/spotify/lyric?id=x',
];

for (const endpoint of RETIRED_ENDPOINTS) {
  test('① ' + endpoint + ' 落 404 REMOVED（平台登录族退役）', async () => {
    await waitListening();
    const res = await fetch(BASE + endpoint, { signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => null);
    assert.equal(res.status, 404, endpoint + ' 必须 404，实际 ' + res.status + ' 体=' + JSON.stringify(body));
    assert.ok(body && body.ok === false && body.error === 'REMOVED',
      endpoint + ' 必须用 { ok:false, error:\'REMOVED\' }，实际=' + JSON.stringify(body));
    assert.ok(!('cookie' in body) && !('cookies' in body) && !('token' in body)
      && !('account' in body) && !('loginUrl' in body) && !('qrUrl' in body),
      endpoint + ' 不得再返回任何账号/凭证字段，实际=' + JSON.stringify(body));
  });
}

test('① 保留面：/api/app/version 与 /api/lx-source/status 不落 REMOVED', async () => {
  await waitListening();
  const ver = await fetch(BASE + '/api/app/version', { signal: AbortSignal.timeout(15000) });
  const verBody = await ver.json().catch(() => null);
  assert.equal(ver.status, 200);
  assert.ok(verBody && typeof verBody.version === 'string' && verBody.version);
  const st = await fetch(BASE + '/api/lx-source/status', { signal: AbortSignal.timeout(15000) });
  const stBody = await st.json().catch(() => null);
  assert.ok(!(st.status === 404 && stBody && stBody.error === 'REMOVED'), '/api/lx-source/status 不得被守卫误伤');
});

test('① /api/discover/home 保留且未登录回 starter 空池（无 cookie 字段）', async () => {
  await waitListening();
  const res = await fetch(BASE + '/api/discover/home', { signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => null);
  assert.equal(res.status, 200, '体=' + JSON.stringify(body));
  assert.equal(body.loggedIn, false);
  assert.equal(body.mode, 'starter');
  assert.equal(body.user, null);
  assert.deepEqual(body.dailySongs, []);
  assert.deepEqual(body.playlists, []);
  assert.ok(!('cookie' in body) && !('cookies' in body), 'starter 载荷不得带凭证字段');
});

test('① /api/listen/report 保留为本地记录（不提交平台）', async () => {
  await waitListening();
  const res = await fetch(BASE + '/api/listen/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'netease',
      song: { id: 't16d-probe', type: 'song', name: 'probe', artist: 'probe' },
      sessionId: 't16d-probe-session',
      listenMs: 12000,
      durationMs: 12000,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => null);
  assert.equal(res.status, 200, '体=' + JSON.stringify(body));
  assert.equal(body.accepted, true);
  assert.equal(body.localRecorded, true);
  assert.equal(body.platformSubmitted, false);
  assert.ok(!('cookie' in body) && !('token' in body));
});

test('① /api/weather/radio 电台主体不被连坐', async () => {
  await waitListening();
  const res = await fetch(BASE + '/api/weather/radio', { signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => null);
  assert.ok(!(res.status === 404 && body && body.error === 'REMOVED'),
    '/api/weather/radio 不得落 REMOVED，实际=' + res.status);
});

after(() => { server.close(); });

// ---------- ② server.js 源码反证 ----------
const KEPT_NETEASE_ROUTES = [
  '/api/playlist/tracks',
  '/api/album/detail',
  '/api/artist/detail',
  '/api/lyric',
  '/api/search',
  '/api/discover/home',
];

test('② server.js：保留的网易云公开元数据路由 handler 仍在，且不在守卫名单', () => {
  const src = read('server.js');
  for (const route of KEPT_NETEASE_ROUTES) {
    assert.ok(src.includes("pn === '" + route + "'"), route + ' handler 必须保留');
    assert.ok(!src.includes("|| pn === '" + route + "'"), route + ' 不得被登记进 REMOVED 守卫');
  }
  assert.ok(!src.includes('function handleSongUrl'), '官方直链取址实现必须已随 T18 退役');
  assert.match(src, /function handleNeteaseAlbumDetail/, 'album detail 实现保留');
});

test('② server.js：五平台 require 与汽水解密运行时连根退役', () => {
  const src = read('server.js');
  for (const dead of ["require('./qq-vip-api')", "require('./kugou-api')",
    "require('./qishui-api')", "require('./qishui-qr-login')", "require('./spotify-api')",
    "require('./qishui-audio-decryptor/track-decryptor')"]) {
    assert.ok(!src.includes(dead), 'server.js 不得再残留 ' + dead);
  }
  for (const dead of ['handleKugouSearch', 'handleQishuiSearch', 'handleSpotifyStatus',
    'normalizeQQVipPayloadStrict', 'handleQQSearch', 'qishuiQrLogin']) {
    assert.ok(!src.includes(dead), 'server.js 不得再残留平台实现符号 ' + dead);
  }
});

test('② server.js：NeteaseCloudMusicApi 依赖保留（裁定 ④），登录/写回绑定退役', () => {
  const src = read('server.js');
  assert.match(src, /require\('NeteaseCloudMusicApi'\)/, 'NCM 依赖必须保留（公开元数据 7 条的供给方）');
  for (const keep of ['search', 'cloudsearch', 'song_detail',
    'album', 'artist_detail', 'artist_top_song', 'artist_songs', 'playlist_tracks',
    'playlist_detail', 'playlist_track_all', 'lyric', 'lyric_new']) {
    assert.ok(src.includes("neteaseApiFn('" + keep + "')"), '保留的 NCM 绑定 ' + keep + ' 不得误删');
  }
  for (const dead of ['login_qr_key', 'login_qr_create', 'login_qr_check', 'login_status',
    'vip_info', 'vip_info_v2', 'logout', 'user_account', 'user_playlist', 'comment_music',
    'like', 'likelist', 'song_like_check', 'album_sub', 'album_sublist', 'playlist_subscribe',
    'comment', 'comment_like', 'scrobble', 'listen_data_total', 'playlist_track_add',
    'playlist_create', 'personalized', 'recommend_resource', 'recommend_songs',
    'song_url', 'song_url_v1']) {
    assert.ok(!src.includes("neteaseApiFn('" + dead + "')"), '退役的 NCM 绑定 ' + dead + ' 不得残存');
  }
});

test('② server.js：cookie/登录态实现簇与凭证变量清零', () => {
  const src = read('server.js');
  for (const dead of ['userCookie', 'qqCookie', 'kugouCookie', 'qishuiCookie']) {
    assert.doesNotMatch(src, new RegExp('\\b' + dead + '\\b'), 'server.js 不得再持有凭证变量 ' + dead);
  }
  for (const dead of ['normalizeCookieHeader', 'rawCookieFallback', 'configuredCookieStores',
    'refreshConfiguredCookieStores', 'saveCookie', 'saveQQCookie', 'saveKugouCookie',
    'saveQishuiCookie', 'parseCookieString', 'normalizeQQCookieInput', 'requireLogin',
    'getLoginInfo', 'getPlaybackLoginInfo', 'clearNeteaseLoginInfoCache',
    'handlePlatformListenReport', 'listenSyncJournal']) {
    assert.doesNotMatch(src, new RegExp('\\b' + dead + '\\b'), 'server.js 不得再残留登录实现簇 ' + dead);
  }
  // 16e 复用的清理钩子：函数与导出口保留，改为清理历史落盘凭证文件。
  assert.match(src, /function clearAllRuntimeLoginCredentials/, '清理钩子函数保留供 16e 复用');
  assert.match(src, /server\.clearAllLoginCredentials\s*=/, '清理钩子导出口保留');
  assert.match(src, /LEGACY_COOKIE_FILES/, '清理钩子必须改为清理历史凭证文件');
  assert.match(src, /function handleLocalListenReport/, '收听上报降级为本地记录');
});

test('② server.js：退役面由一条统一路由守卫收口，非散落 if', () => {
  const src = read('server.js');
  const guardRe = /if \(\s*pn === '\/api\/platform\/capabilities'[\s\S]{0,2400}?pn\.startsWith\('\/api\/spotify\/'\)\s*\)\s*\{\s*\n\s*sendJSON\(res, \{ ok: false, error: 'REMOVED' \}, 404\);/;
  const m = src.match(guardRe);
  assert.ok(m, '必须存在一条覆盖 netease 18 散点 + 五平台前缀的统一 REMOVED 守卫');

  const guardStart = m.index;
  const guardEnd = guardStart + m[0].length;
  for (const prefix of ['/api/qq/', '/api/kugou/', '/api/qishui/', '/api/spotify/']) {
    const needle = "pn.startsWith('" + prefix + "')";
    assert.equal(src.indexOf(needle), src.lastIndexOf(needle), prefix + ' 只允许守卫内 1 处');
  }
  for (const lit of RETIRED_ENDPOINTS.map((e) => e.split('?')[0])) {
    if (/^\/api\/(qq|kugou|qishui|spotify)\//.test(lit)) continue;
    const needle = "pn === '" + lit + "'";
    const first = src.indexOf(needle);
    assert.notEqual(first, -1, '守卫应登记 ' + needle);
    assert.equal(src.lastIndexOf(needle), first, needle + ' 只允许守卫内 1 处——handler 未删净或重复登记');
    assert.ok(first >= guardStart && first < guardEnd, needle + ' 必须位于统一守卫块内而非散落 handler');
  }
  const removedCount = (src.match(/error: 'REMOVED'/g) || []).length;
  assert.ok(removedCount <= 4, 'REMOVED 只允许 世界页/播客/平台登录 三条守卫级，实际 ' + removedCount + ' 处');
});

// ---------- ② 前端登录族物理删除 ----------
const ACCOUNT_DEAD_FILES = [
  'public/js/modules/08-account/01-login-modal-utils.js',
  'public/js/modules/08-account/02-login-status.js',
  'public/js/modules/08-account/03-login-modal-flows.js',
  'public/js/modules/08-account/04-user-modal-logout.js',
  'public/js/modules/08-account/05-startup-login-guide.js',
];

test('② 08-account 登录族 5 文件物理删除 + index-loader 摘登记', () => {
  for (const rel of ACCOUNT_DEAD_FILES) {
    assert.equal(exists(rel), false, rel + ' 必须整文件删除');
  }
  const loader = read('public/js/index-loader.js');
  assert.doesNotMatch(loader, /08-account\/0[1-5]-/, 'index-loader modulePaths 不得再登记登录族');
  for (const keep of ['08-account/00-update-preview.js', '08-account/06-usage-tracker.js',
    '08-account/07-local-profile.js']) {
    assert.ok(loader.includes(keep), '保留面 ' + keep + ' 必须仍在登记表');
  }
});

function readModulePathsFromLoader() {
  const src = read('public/js/index-loader.js');
  const m = src.match(/const modulePaths = \[([\s\S]*?)\];/);
  assert.ok(m, 'index-loader.js 里应能匹配到 modulePaths 数组');
  return [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]);
}

test('② bundle 现场计数在 bundle-modules.test.js 内同步重数（114-5=109/17）', () => {
  const bundleTest = read('tests/bundle-modules.test.js');
  const paths = readModulePathsFromLoader();
  const lenM = bundleTest.match(/assert\.strictEqual\(paths\.length, (\d+)\)/);
  const runM = bundleTest.match(/assert\.strictEqual\(runs\.length, (\d+)\)/);
  assert.ok(lenM && runM, 'bundle-modules.test.js 应保留现场计数断言');
  assert.equal(String(paths.length), lenM[1],
    'modulePaths 实数(' + paths.length + ')与钉桩(' + lenM[1] + ')必须一致——删后现场重数');
  assert.equal(paths.length, 109, '08-account 登录族 5 个登记项删除后应为 109');
  assert.equal(runM[1], '17', '08-account 连续段仍剩 00/06/07，段数不变');
});

test('② 00-core-stores：登录态容器 / 五平台歌单数组 / 播客暂留变量随批摘除', () => {
  const core = read('public/js/modules/00-state/00-core-stores.js');
  for (const dead of ['var loginStatus', 'var qqLoginStatus', 'var kugouLoginStatus',
    'var qishuiLoginStatus', 'var spotifyLoginStatus', 'qqLoginStatusLastForcedAt',
    'loginStatusChecked', 'loginStatusCheckFailed', 'neteasePlaylists', 'qqPlaylists',
    'kugouPlaylists', 'qishuiPlaylists', 'spotifyPlaylists', 'myPodcastCollections',
    'myPodcastItems']) {
    assert.ok(!core.includes(dead), '00-core-stores 不得再残留 ' + dead);
  }
  assert.doesNotMatch(core, /podcasts:\s*\[\]/, 'homeDiscoverState.podcasts 暂留字段随 16d 收口摘除');
  assert.match(core, /var userPlaylists/, 'userPlaylists 兼作本地歌单容器（03b-local-playlist-store 消费）');
  assert.match(core, /var homeDiscoverState/, 'homeDiscoverState 容器保留');
});

test('② index.html：#cookie-export-prompt 弹窗 DOM 退役，本地档案入口保留', () => {
  const html = read('public/index.html');
  assert.doesNotMatch(html, /cookie-export-prompt/, '#cookie-export-prompt 必须删除（凭证导出面）');
  assert.doesNotMatch(html, /dismissCookieExportPrompt/);
  assert.doesNotMatch(html, /logoutAllAccountsAndResetEasterEgg/, 'index.html 不得再绑退役登出族');
  assert.match(html, /id="user-btn"/, '本地档案入口 #user-btn 保留');
  assert.match(html, /closeUserModal/, '用户弹窗关闭钮保留（07-local-profile 承接）');
});

test('② 登录族死符号全仓零消费方', () => {
  const deadSymbols = ['showLoginModal', 'closeLoginModal', 'openProviderLogin',
    'logoutActiveAccount', 'logoutAllAccountsAndResetEasterEgg', 'hasAnyPlatformLogin',
    'refreshQr', 'updateLoginProviderUi', 'maybeRunStartupLoginGuide', 'runLoginGuideParticles',
    'skipLoginAndFocusSearch'];
  const skipDirs = ['node_modules', '.git', '.scratch', '.superpowers', 'bundles',
    'visualizationOutputDirectory', 'dist', 'release', 'docs'];
  const offenders = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, f.name);
      if (f.isDirectory()) {
        if (skipDirs.includes(f.name)) continue;
        walk(abs);
        continue;
      }
      if (!/\.(js|html)$/.test(f.name)) continue;
      if (f.name === 'platform-login-removal.test.js') continue;
      const src = fs.readFileSync(abs, 'utf8');
      for (const sym of deadSymbols) {
        if (src.includes(sym)) {
          offenders.push(path.relative(ROOT, abs).split(path.sep).join('/') + ' → ' + sym);
        }
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, [], '死符号仍有全仓引用:\n' + offenders.join('\n'));
});

test('② 前端全仓不再出现退役端点字面量', () => {
  const offenders = [];
  const deadLiterals = ['/api/login/qr', '/api/login/status', '/api/login/cookie',
    '/api/logout', '/api/user/playlists', '/api/song/like', '/api/song/comments',
    '/api/playlist/create', '/api/playlist/add-song', '/api/playlist/subscribe',
    '/api/album/subscribe', '/api/platform/capabilities', '/api/listen/total',
    '/api/qq/', '/api/kugou/', '/api/qishui/', '/api/spotify/'];
  const scanDirs = ['public/js', 'desktop', 'scripts'];
  const hit = (rel) => {
    const src = read(rel);
    return deadLiterals.some((lit) => src.includes(lit));
  };
  for (const dir of scanDirs) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs, { recursive: true })) {
      const rel = path.posix.join(dir, String(f).split(path.sep).join('/'));
      if (!/\.(js|html)$/.test(rel)) continue;
      if (rel.includes('/bundles/')) continue;
      if (rel.includes('platform-login-removal.test.js')) continue;
      if (hit(rel)) offenders.push(rel);
    }
  }
  if (exists('public/index.html') && hit('public/index.html')) offenders.push('public/index.html');
  assert.deepEqual(offenders, [], '仍引用退役端点的文件: ' + offenders.join(', '));
});

test('② 歌单面板改 local-only：*/user/playlists 与平台目录分页退役', () => {
  const panel = read('public/js/modules/06-lyrics/01-playlist-panel-shell.js');
  assert.doesNotMatch(panel, /\/api\/user\/playlists|playlistCatalogProviderArray|rebuildUserPlaylistsFromCatalog|loadPlaylistCatalogProviderPage|requestNextPlaylistCatalogPage/,
    '五平台歌单目录分页退役');
  assert.match(panel, /localPlaylistStore|ensureLocalUserPlaylistsLoaded/, '歌单面板必须改读本地歌单');
  assert.match(panel, /function refreshUserPlaylists/, '刷新入口保留（数据源换本地）');
  const detail = read('public/js/modules/06-lyrics/02-playlist-detail.js');
  assert.doesNotMatch(detail, /\/api\/playlist\/subscribe|playlistCatalogSyncState|requestNextPlaylistCatalogPage/);
  assert.match(detail, /provider === 'local'|'local'/, '本地歌单详情渲染保留');
});

test('② 收藏弹窗改 local-only：在线歌单写回与登录闸退役', () => {
  const src = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
  assert.doesNotMatch(src, /ensureLoggedInForAction|songAccountLoginStatus|showLoginModal/);
  assert.doesNotMatch(src, /\/api\/playlist\/create|\/api\/playlist\/add-song|\/api\/album\/subscribe/);
  assert.match(src, /localPlaylistStore/, '收藏到本地歌单的链路保留');
  assert.match(src, /\/api\/album\/detail/, '专辑详情（保留面）不得误删');
  assert.match(src, /\/api\/artist\/detail/, '艺人详情（保留面）不得误删');
});

test('② §5 采集面：消费模块摘除登录族触点', () => {
  const wallpaper = read('public/js/modules/05-playback/04-home-empty-wallpaper.js');
  assert.doesNotMatch(wallpaper, /skipLoginAndFocusSearch|closeLoginModal|hasAnyPlatformLogin/);
  const discover = read('public/js/modules/05-playback/03-home-discover-weather.js');
  assert.doesNotMatch(discover, /loggedOutHome|\/api\/login\/status/, '登录门槛文案分支随登录态退役坍缩');
  assert.match(discover, /\/api\/discover\/home/, '裁定 ①4：/api/discover/home 消费点保留');
  const dash = read('public/js/modules/05-playback/03a-home-dashboard.js');
  assert.doesNotMatch(dash, /loginStatus|qqLoginStatus|kugouLoginStatus|qishuiLoginStatus|spotifyLoginStatus/,
    '03a 默认页签不再从登录态派生（official 分支退役）');
  const expose = read('public/js/modules/12-expose-inline-globals.js');
  assert.doesNotMatch(expose, /logoutActiveAccount|logoutAllAccountsAndResetEasterEgg/);
  const startup = read('public/js/modules/10-shell/05-startup-bindings.js');
  assert.doesNotMatch(startup, /LoginStatusAutoRefresh|maybeRunStartupLoginGuide/);
  const idle = read('public/js/modules/09-idle-toast-libraries.js');
  assert.doesNotMatch(idle, /loginGuideAnimating/);
  const peek = read('public/js/modules/10-shell/02-peek-panels-upload.js');
  assert.doesNotMatch(peek, /loginGuideAnimating/);
});

// ---------- ③ 分发/打包面 ----------
const PLATFORM_ROOT_FILES = ['qq-vip-api.js', 'kugou-api.js', 'qishui-api.js',
  'qishui-qr-login.js', 'spotify-api.js', 'qishui-auth-v6.js'];

test('③ 五平台根文件（含 qishui-auth-v6/qr-login）物理删除', () => {
  for (const f of PLATFORM_ROOT_FILES) {
    assert.equal(exists(f), false, f + ' 必须整文件删除');
  }
  assert.equal(exists('qishui-auth-v6'), false, 'qishui-auth-v6/ 运行时目录必须删除');
  assert.equal(exists('scripts/qishui-passport-live-smoke.js'), false, '汽水登录 live smoke 脚本必须删除');
});

test('③ package.json：保留 NCM 依赖，摘登录/QR 打包条目', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies && 'NeteaseCloudMusicApi' in pkg.dependencies,
    '裁定 ①4：NeteaseCloudMusicApi 依赖保留');
  for (const f of ['qishui-auth-v6.js', 'qishui-qr-login.js', 'qishui-auth-v6/**/*']) {
    assert.ok(!pkg.build.files.includes(f), 'build.files 不得再打包 ' + f);
  }
  assert.ok(pkg.build.files.includes('platform-playlist-import.js'), 'lx 导入口 platform-playlist-import 保留');
  assert.ok(!pkg.build.files.some((f) => String(f).includes('qishui-audio-decryptor')), '16e：解密运行时无消费方，打包白名单须摘除');
  assert.ok(pkg.build.files.includes('*-api.js'), 'agent-api.js 由通配符覆盖，不得误删');
  assert.doesNotMatch(read('electron-builder.internal-beta.json'), /qishui-auth-v6|qishui-qr-login/);
});

test('③ verify-pack-requirements.js 同步摘退役文件要求（防打包假绿/假红）', () => {
  const src = read('scripts/verify-pack-requirements.js');
  for (const dead of ['kugou-api.js', 'qishui-api.js', 'qishui-auth-v6.js',
    'qishui-qr-login.js', 'qq-vip-api.js', 'spotify-api.js', 'qishui-auth-v6/']) {
    assert.ok(!src.includes(dead), 'verify-pack 不得再要求 ' + dead);
  }
  assert.ok(src.includes('agent-api.js'), 'agent-api 保留面不误删');
});

test('③ quick-check.js 不再读取已退役模块文件/断言登录族符号', () => {
  const src = read('scripts/quick-check.js');
  for (const dead of ['01-login-modal-utils', '02-login-status',
    '03-login-modal-flows', '04-user-modal-logout', '05-startup-login-guide',
    'qishui-auth-v6.js', 'showLoginModal', 'updateLoginProviderUi', 'openProviderLogin',
    'qqLoginStatusText', 'refreshQQVipStatusNow', 'SPOTIFY_DEVELOPER_DASHBOARD_URL',
    'scheduleLoginWorkflowEdges', 'selectLoginProviderNode', 'openQishuiPublicSearch',
    'openSpotifyDeveloperDashboard']) {
    assert.ok(!src.includes(dead), 'quick-check 不得再断言退役面 ' + dead + '（ENOENT/假绿）');
  }
});

test('③ 退役平台文件的 require 残留全仓清零', () => {
  const offenders = [];
  const re = /require\(['"]\.\.?\/(qq-vip-api|kugou-api|qishui-api|qishui-qr-login|spotify-api|qishui-auth-v6)['"]\)/;
  for (const f of fs.readdirSync(ROOT, { recursive: true })) {
    const rel = String(f).split(path.sep).join('/');
    if (!rel.endsWith('.js')) continue;
    if (/node_modules|\.git\/|bundles\/|\.scratch\/|\.superpowers\/|dist\/|release\//.test(rel)) continue;
    if (rel.endsWith('platform-login-removal.test.js')) continue;
    if (re.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], '仍有 require 残留指向已删平台文件: ' + offenders.join(', '));
});

test('③ desktop 登录窗口族/IPC/QR 配置退役，凭据清理块与 subsonic 保留', () => {
  const preload = read('desktop/preload.js');
  for (const dead of ['openNeteaseLogin', 'openQQLogin', 'openKugouLogin', 'openQishui',
    'openSpotifyLogin', 'clearNeteaseLogin', 'clearQQLogin', 'clearKugouLogin',
    'clearQishuiLogin', 'clearSpotifyLogin', 'exportLoginCookie']) {
    assert.ok(!preload.includes(dead), 'preload 不得再暴露登录桥 ' + dead);
  }
  const main = read('desktop/main.js');
  for (const dead of ['netease-music-open-login', 'qq-music-open-login', 'kugou-music-open-login',
    'qishui-music-clear-login', 'spotify-music-open-login', 'stellaflix-export-login-cookie',
    'QISHUI_QR_CONFIG_FILE', 'loginCookieExportMeta']) {
    assert.ok(!main.includes(dead), 'desktop/main.js 不得再登记登录窗口族 ' + dead);
  }
  assert.match(main, /subsonic/i, 'subsonic 凭据清理块一个字都不许删');
  assert.match(main, /clearAllLoginCredentials|clearAllProviderLoginState/, '16e 清理钩子入口保留');
});

// ---------- ⑤ 反证保留面（不得连坐误删） ----------
test('⑤ 保留面 server 侧：电台/收听统计/导入桥/lx 路由族/世界页守卫完好', () => {
  const src = read('server.js');
  assert.match(src, /pn === '\/api\/weather\/radio'/, '电台主体保留');
  assert.match(src, /function buildWeatherRadio/, 'buildWeatherRadio 保留');
  assert.match(src, /pn === '\/api\/listen\/report'/, '收听统计上报端点保留');
  assert.match(src, /pn === '\/api\/platform-playlist\/import'/, 'lx 导入口保留');
  assert.match(src, /pn === '\/api\/lx\/playlists'/, '/api/lx/playlists 保留');
  assert.match(src, /pn\.startsWith\('\/api\/lx-source\/'\)/, '/api/lx-source/* 路由族保留');
  assert.match(src, /pn === '\/api\/world\/beacons'/, '世界页 REMOVED 守卫保留');
  assert.match(src, /pn === '\/api\/podcast' \|\| pn\.startsWith\('\/api\/podcast\/'\)/, '播客守卫（16c）保留');
  assert.match(src, /pn === '\/api\/cover'/, '封面代理保留');
  assert.match(src, /pn === '\/api\/proxy'/, '通用代理保留');
  assert.match(src, /pn === '\/api\/audio'/, '/api/audio 代理保留（缺口台账）');
  assert.match(src, /kugouAudioReferer|KW_PLAYER_REFERER|kuwo|Kugou 播放页 Referer/i,
    'kugou referer 依赖必须内联进 server（不得 require 已删文件）');
  assert.doesNotMatch(src, /require\(['"]\.\/kugou-api['"]\)/);
});

test('⑤ 保留面前端：本地 DJ 锁拍/歌单队列分页/本地档案页/更新预览/每日推荐管线完好', () => {
  const dj = read('public/js/modules/03-beat/02-podcast-dj-analysis.js');
  assert.match(dj, /async function analyzePodcastDjBeats/, '本地 DJ 离线锁拍消费面保留');
  const loaders = read('public/js/modules/06-lyrics/03-podcast-playlist-loaders.js');
  assert.match(loaders, /function playlistQueueSource/, '歌单队列分页主体保留');
  assert.match(loaders, /function loadPlaylistIntoQueueById/, '队列灌入主体保留');
  const profile = read('public/js/modules/08-account/07-local-profile.js');
  assert.match(profile, /function showUserModal/, '本地档案页保留');
  assert.match(profile, /closeUserModal|openGsapModal/, 'closeUserModal/弹窗原语必须迁入驻地');
  assert.equal(exists('public/js/modules/08-account/00-update-preview.js'), true, '更新预览保留');
  assert.equal(exists('public/js/modules/08-account/06-usage-tracker.js'), true, '使用统计保留');
  const dash = read('public/js/modules/05-playback/03a-home-dashboard.js');
  assert.match(dash, /function loadHomePlatformFeedRecommendations/, 'daily-hot 消费管线保留');
  assert.match(dash, /\/api\/daily-hot\?source=/, 'daily-hot 调用点保留（排行榜归一）');
  assert.match(dash, /\/api\/platform-charts\?source=/, 'platform-charts 调用点保留');
  const fallback = read('public/js/modules/05-playback/11-provider-fallback.js');
  assert.match(fallback, /preResolvedPlaybackData/, 'lx 预解析起播面保留');
});

test('⑤ ynx APIKEY 端点保留，server 不新增外部密钥触点', () => {
  const src = read('server.js');
  assert.doesNotMatch(src, /de5\.net/, 'server 侧不新增 ynx 触点（api-agent 端点在 agent-api.js）');
  assert.match(read('agent-api.js'), /api-agent\.de5\.net|APIKEY|apikey/i, 'ynx APIKEY 端点保留');
});

// ---------- ⑥ 16c 套件必须保持 18/18 ----------
test('⑥ podcast-removal.test.js 保持 18 pass / 0 fail（子进程实跑）', () => {
  let out = '';
  const env = Object.assign({}, process.env);
  delete env.NODE_TEST_CONTEXT;
  try {
    out = execFileSync(process.execPath, ['--test', 'tests/podcast-removal.test.js'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, env,
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    assert.fail('podcast-removal 套件跑挂了（16d 不得改动 16c 保留面）:\n' + out.slice(-2000));
  }
  const pass = out.match(/^(?:ℹ|#)\s*pass (\d+)$/m);
  const fail = out.match(/^(?:ℹ|#)\s*fail (\d+)$/m);
  assert.ok(pass && fail, '未解析到 pass/fail 计数:\n' + out.slice(-1000));
  assert.equal(Number(pass[1]), 18, 'podcast-removal 必须恰 18 pass');
  assert.equal(Number(fail[1]), 0, 'podcast-removal 不得有 fail');
});
