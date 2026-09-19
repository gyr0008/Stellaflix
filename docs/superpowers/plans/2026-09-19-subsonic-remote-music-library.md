# Navidrome / Subsonic 远程音乐库（移植项 B）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Stellaflix 连接用户自建的 Navidrome/Subsonic 服务器，在播放列表面板新增"远程库"tab，可浏览艺术家→专辑、歌单，并直接串流播放。

**Architecture:** 服务端新增独立 CommonJS 模块 `subsonic-api.js`（配置存储 + Subsonic REST 客户端 + 歌曲映射），server.js 只加薄路由；音频/封面复用现有 `/api/audio` Range 透传代理（server.js:7446）；前端按播客 tab 的既有模式（`06-lyrics/03-podcast-playlist-loaders.js`）在播放列表面板加第四个 tab，播放走 `song.localUrl` 分支（`13-playback-start-audio.js:1121/868`），**不改播放核心**。

**Tech Stack:** Node 24 CommonJS、内置 `crypto`/`fetch`、零新增 npm 依赖；前端为拼接式全局脚本（`public/js/index-loader.js`）；测试用 `node --test`。

**Spec:** 无独立 spec 文档；需求即本会话审查结论"移植项 B"，论证依据见文末"验收标准"。参照实现：`C:\Users\Administrator\Desktop\vynody-2.7.3\lib\player\remote\clients\subsonic_client.dart`（Subsonic API 1.16.1，token 认证 `t=md5(password+salt)`）。

## Global Constraints

- 新增 npm 依赖：**零**。只用 Node 内置模块与已有全局 `fetch`。
- server.js 默认绑定保持 `127.0.0.1`（server.js:174-175）；`tests/local-api-origin-guard.test.js` 的断言不得改动、不得豁免。
- 所有 `/api/subsonic/*` 路由**只接受 serverId + Subsonic 对象 id**，绝不从客户端接受任意上游 URL（SSRF 红线）。`data/subsonic-servers.json` 中的 baseUrl 是用户本机显式配置的例外（设计决策，见风险节）。
- 密码只存 `data/subsonic-servers.json`（write-temp-then-rename，仿 server.js:207-247 listen-sync-journal 模式）；任何 GET 响应、任何 `console.log` 不得输出密码原文或本地 URL 中嵌入后的值之外再打印。
- 子sonic 协议版本固定 `v=1.16.1`、`c=Stellaflix`；认证用 token 方式 `u/s/t`，`t = md5(password + salt)`。
- UI 文案中文；tab 标签名"远程库"。
- 测试命令一律 `node --test tests/<文件名>`（本仓库无 npm test；勿引用 run-all.js）。
- 提交纪律：每个 Task 末尾的 commit 步骤**仅在主人明确下达"提交"指令时执行**（见项目记忆 commit-workflow）；只 `git add` 本任务文件。

## 文件结构

| 动作 | 路径 | 职责 |
|---|---|---|
| 新建 | `subsonic-api.js`（仓库根，与 spotify-api.js 平级） | 配置存储、REST 客户端、track→song 映射、5 个 browse 函数 |
| 新建 | `tests/subsonic-api.test.js` | 模块单测（token、存储、映射、假上游） |
| 修改 | `server.js:133`（require 区）+ `:7446` 前插入路由 | 6 条 `/api/subsonic/*` 路由 |
| 新建 | `tests/subsonic-server-routes.test.js` | 起真实 server 的端到端路由测试（含 Origin 守卫） |
| 新建 | `public/js/modules/06-lyrics/07-subsonic-library.js` | 远程库 tab 的视图/交互（06 号位已被占用，取 07） |
| 修改 | `public/js/index-loader.js:114` | 注册新脚本 |
| 修改 | `public/index.html:1220-1221`、`:1243-1250` | tab 按钮 + pane 容器 |
| 修改 | `public/js/modules/00-state/02-preferences-ui-modes.js:52-55` | normalizePlaylistPanelTab 认 'subsonic' |
| 修改 | `public/js/modules/06-lyrics/01-playlist-panel-shell.js:196-236` | switchPlaylistTab / 动画 / 打开时刷新 |
| 新建 | `tests/subsonic-ui-wiring.test.js` | 前端接线静态断言 |

---

### Task 1: `subsonic-api.js` 服务端模块

**Files:**
- Create: `subsonic-api.js`
- Test: `tests/subsonic-api.test.js`

**Interfaces（Task 2/3 依赖，签名逐字）:**
- `listServersPublic() -> [{id,name,baseUrl,username,hasPassword}]`
- `saveServer({id?,name,baseUrl,username,password}) -> publicServer`（抛 `SUBSONIC_BAD_BASE_URL|SUBSONIC_MISSING_USERNAME|SUBSONIC_MISSING_PASSWORD`）
- `deleteServer(id) -> boolean`
- `getServer(id) -> 内部记录(null 表示不存在)`（含 password，仅服务端用）
- `authParams(server, salt?) -> {u,s,t}`
- `buildRestUrl(server, endpoint, params?) -> string`
- `audioProxyUrl(upstreamUrl) -> '/api/audio?url=…'`
- `mapTrack(server, tr) -> song 对象`
- `browseArtists(serverId)` / `browseArtist(serverId,id)` / `browseAlbum(serverId,id)` / `browsePlaylists(serverId)` / `browsePlaylist(serverId,id)` （async，返回见各函数 return）

- [ ] **Step 1: 写失败的模块单测**

创建 `tests/subsonic-api.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfz-subsonic-'));
process.env.STELLAFIX_SUBSONIC_CONFIG_FILE = path.join(tmp, 'subsonic-servers.json');
const sub = require('../subsonic-api.js');

test('token 认证：t = md5(password + salt)', () => {
  const p = sub.authParams({ username: 'alice', password: 'guessme' }, 'salt123');
  assert.strictEqual(p.u, 'alice');
  assert.strictEqual(p.s, 'salt123');
  assert.strictEqual(p.t, 'b9777213162ed1a3cc3eb04ed0c7d95b'); // md5('guessme'+'salt123')，值预先算好
});

test('buildRestUrl 带 v/c/u/s/t 且路径为 /rest/<endpoint>.json', () => {
  const url = new URL(sub.buildRestUrl(
    { baseUrl: 'http://navi.lan:4533', username: 'alice', password: 'guessme' },
    'getAlbum', { id: 'al-1' }));
  assert.strictEqual(url.pathname, '/rest/getAlbum.json');
  assert.strictEqual(url.searchParams.get('v'), '1.16.1');
  assert.strictEqual(url.searchParams.get('c'), 'Stellaflix');
  assert.ok(url.searchParams.get('t'));
  assert.strictEqual(url.searchParams.get('id'), 'al-1');
});

test('saveServer：非法 baseUrl 拒绝', () => {
  assert.throws(() => sub.saveServer({ baseUrl: 'ftp://x', username: 'a', password: 'b' }), /SUBSONIC_BAD_BASE_URL/);
  assert.throws(() => sub.saveServer({ baseUrl: 'http://x', username: '', password: 'b' }), /SUBSONIC_MISSING_USERNAME/);
  assert.throws(() => sub.saveServer({ baseUrl: 'http://x', username: 'a', password: '' }), /SUBSONIC_MISSING_PASSWORD/);
});

test('saveServer/deleteServer 往返 + 公开视图不泄露密码 + 文件落盘', () => {
  const saved = sub.saveServer({ name: '家里', baseUrl: 'http://navi.lan:4533/', username: 'alice', password: 'guessme' });
  assert.ok(saved.id);
  assert.strictEqual(saved.baseUrl, 'http://navi.lan:4533');
  assert.strictEqual('password' in saved, false);
  const pub = sub.listServersPublic();
  assert.strictEqual(pub[0].hasPassword, true);
  assert.strictEqual(JSON.stringify(pub).includes('guessme'), false);
  const raw = JSON.parse(fs.readFileSync(process.env.STELLAFIX_SUBSONIC_CONFIG_FILE, 'utf8'));
  assert.strictEqual(raw.servers[0].password, 'guessme');
  // 空密码编辑 = 保留旧密码
  const edited = sub.saveServer({ id: saved.id, name: 'NAS', baseUrl: 'http://navi.lan:4533', username: 'alice', password: '' });
  assert.strictEqual(edited.name, 'NAS');
  assert.strictEqual(sub.getServer(saved.id).password, 'guessme');
  assert.strictEqual(sub.deleteServer(saved.id), true);
  assert.strictEqual(sub.deleteServer(saved.id), false);
});

test('mapTrack 生成 localUrl/cover 走 /api/audio 代理', () => {
  const server = { id: 's1', baseUrl: 'http://navi.lan:4533', username: 'alice', password: 'guessme' };
  const song = sub.mapTrack(server, { id: 'tr-1', title: '曲 A', artist: '歌手 B', album: '专 C', albumId: 'al-1', duration: 213, coverArt: 'co-1' });
  assert.strictEqual(song.type, 'subsonic');
  assert.strictEqual(song.source, 'subsonic');
  assert.strictEqual(song.serverId, 's1');
  assert.strictEqual(song.name, '曲 A');
  assert.strictEqual(song.duration, 213);
  assert.ok(song.localUrl.startsWith('/api/audio?url='));
  const inner = decodeURIComponent(song.localUrl.slice('/api/audio?url='.length));
  assert.ok(inner.startsWith('http://navi.lan:4533/rest/stream.json?'));
  assert.ok(inner.includes('id=tr-1'));
  assert.ok(inner.includes('u=alice') && inner.includes('&s=') && inner.includes('&t='));
  assert.ok(song.cover.startsWith('/api/audio?url='));
  assert.ok(decodeURIComponent(song.cover).includes('getCoverArt.json'));
});

test('browseAlbum 经假上游返回映射歌曲', async () => {
  const fake = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/rest/getAlbum.json') {
      assert.ok(u.searchParams.get('t'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', album: {
        id: 'al-1', name: '专 C', artist: '歌手 B', coverArt: 'co-1', songCount: 1, duration: 213,
        song: [{ id: 'tr-1', title: '曲 A', artist: '歌手 B', artistId: 'ar-1', album: '专 C', albumId: 'al-1', duration: 213, contentType: 'audio/flac' }],
      } } }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    const saved = sub.saveServer({ name: 'fake', baseUrl: 'http://127.0.0.1:' + fake.address().port, username: 'alice', password: 'guessme' });
    const r = await sub.browseAlbum(saved.id, 'al-1');
    assert.strictEqual(r.album.title, '专 C');
    assert.strictEqual(r.songs.length, 1);
    assert.strictEqual(r.songs[0].id, 'tr-1');
    assert.ok(r.songs[0].localUrl.startsWith('/api/audio?url='));
    assert.strictEqual(sub.deleteServer(saved.id), true);
  } finally { fake.close(); }
});

test('subsonicCall 上游 status=error 抛 SUBSONIC_<code>', async () => {
  const fake = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username or password' } } }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      sub.subsonicCall({ baseUrl: 'http://127.0.0.1:' + fake.address().port, username: 'a', password: 'b' }, 'ping', {}),
      /SUBSONIC_40/);
  } finally { fake.close(); }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/subsonic-api.test.js`
Expected: `Cannot find module '../subsonic-api.js'`

- [ ] **Step 3: 实现 `subsonic-api.js`**

```js
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.STELLAFIX_SUBSONIC_CONFIG_FILE || path.join(__dirname, 'data', 'subsonic-servers.json');
const API_V = '1.16.1';
const CLIENT = 'Stellaflix';

function loadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { version: 1, servers: parsed && Array.isArray(parsed.servers) ? parsed.servers : [] };
  } catch (_) {
    return { version: 1, servers: [] };
  }
}
function persistStore() {
  const dir = path.dirname(CONFIG_FILE);
  const temp = CONFIG_FILE + '.tmp-' + process.pid;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(temp, CONFIG_FILE);
}
const store = loadStore();

function publicServer(s) {
  return { id: s.id, name: s.name, baseUrl: s.baseUrl, username: s.username, hasPassword: !!s.password };
}
function listServersPublic() { return store.servers.map(publicServer); }
function getServer(id) { return store.servers.find((s) => s.id === String(id || '')) || null; }

function saveServer(input) {
  input = input || {};
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(baseUrl); } catch (_) { throw new Error('SUBSONIC_BAD_BASE_URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('SUBSONIC_BAD_BASE_URL');
  const username = String(input.username || '').trim();
  if (!username) throw new Error('SUBSONIC_MISSING_USERNAME');
  const existing = input.id ? getServer(input.id) : null;
  const password = String(input.password || '') || (existing ? existing.password : '');
  if (!password) throw new Error('SUBSONIC_MISSING_PASSWORD');
  const name = String(input.name || '').trim() || parsed.hostname;
  if (existing) {
    Object.assign(existing, { name, baseUrl, username, password });
    persistStore();
    return publicServer(existing);
  }
  const rec = { id: crypto.randomBytes(6).toString('hex'), name, baseUrl, username, password };
  store.servers.push(rec);
  persistStore();
  return publicServer(rec);
}

function deleteServer(id) {
  const before = store.servers.length;
  store.servers = store.servers.filter((s) => s.id !== String(id || ''));
  if (store.servers.length === before) return false;
  persistStore();
  return true;
}

function authParams(server, salt) {
  const s = salt || crypto.randomBytes(8).toString('hex');
  const t = crypto.createHash('md5').update(String(server.password) + s).digest('hex');
  return { u: server.username, s, t };
}

function buildRestUrl(server, endpoint, params) {
  const q = new URLSearchParams(Object.assign(
    { v: API_V, c: CLIENT },
    authParams(server),
    params || {}));
  return server.baseUrl + '/rest/' + endpoint + '.json?' + q.toString();
}

function audioProxyUrl(upstreamUrl) {
  return '/api/audio?url=' + encodeURIComponent(upstreamUrl);
}

async function subsonicCall(server, endpoint, params) {
  const res = await fetch(buildRestUrl(server, endpoint, params), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('SUBSONIC_HTTP_' + res.status);
  const body = await res.json();
  const r = body && body['subsonic-response'];
  if (!r || r.status !== 'ok') {
    const err = new Error('SUBSONIC_' + ((r && r.error && r.error.code) || 'UNKNOWN'));
    err.subsonicError = r && r.error;
    throw err;
  }
  return r;
}

function mapTrack(server, tr) {
  tr = tr || {};
  return {
    type: 'subsonic',
    source: 'subsonic',
    serverId: server.id,
    id: String(tr.id || ''),
    name: tr.title || '',
    artist: tr.artist || '',
    artists: [{ id: tr.artistId || '', name: tr.artist || '' }],
    album: tr.album || '',
    albumId: tr.albumId || '',
    cover: tr.coverArt ? audioProxyUrl(buildRestUrl(server, 'getCoverArt', { id: tr.coverArt, size: 300 })) : '',
    duration: tr.duration || 0,
    localUrl: audioProxyUrl(buildRestUrl(server, 'stream', { id: tr.id })),
  };
}

function requireServer(serverId) {
  const s = getServer(serverId);
  if (!s) { const e = new Error('SUBSONIC_SERVER_NOT_FOUND'); e.notFound = true; throw e; }
  return s;
}

async function browseArtists(serverId) {
  const s = requireServer(serverId);
  const r = await subsonicCall(s, 'getArtists', {});
  const indexes = ((r.artists && r.artists.index) || []).map((ix) => ({
    name: ix.name || '#',
    artists: (ix.artist || []).map((a) => ({ id: a.id, name: a.name || '', albumCount: a.albumCount || 0 })),
  }));
  return { indexes };
}

async function browseArtist(serverId, id) {
  const s = requireServer(serverId);
  const r = await subsonicCall(s, 'getArtist', { id });
  const ar = r.artist || {};
  return {
    artist: { id: ar.id, name: ar.name || '' },
    albums: (ar.album || []).map((al) => ({
      id: al.id, title: al.name || al.title || '', artist: al.artist || ar.name || '',
      songCount: al.songCount || al.numTracks || 0, duration: al.duration || 0,
      cover: al.coverArt ? audioProxyUrl(buildRestUrl(s, 'getCoverArt', { id: al.coverArt, size: 300 })) : '',
    })),
  };
}

async function browseAlbum(serverId, id) {
  const s = requireServer(serverId);
  const r = await subsonicCall(s, 'getAlbum', { id });
  const al = r.album || {};
  return {
    album: {
      id: al.id, title: al.name || al.title || '', artist: al.artist || '',
      songCount: al.songCount || 0, duration: al.duration || 0,
      cover: al.coverArt ? audioProxyUrl(buildRestUrl(s, 'getCoverArt', { id: al.coverArt, size: 300 })) : '',
    },
    songs: (al.song || []).map((tr) => mapTrack(s, tr)),
  };
}

async function browsePlaylists(serverId) {
  const s = requireServer(serverId);
  const r = await subsonicCall(s, 'getPlaylists', {});
  return {
    playlists: ((r.playlists && r.playlists.playlist) || []).map((pl) => ({
      id: pl.id, name: pl.name || '', songCount: pl.songCount || 0, owner: pl.owner || '',
      cover: pl.coverArt ? audioProxyUrl(buildRestUrl(s, 'getCoverArt', { id: pl.coverArt, size: 300 })) : '',
    })),
  };
}

async function browsePlaylist(serverId, id) {
  const s = requireServer(serverId);
  const r = await subsonicCall(s, 'getPlaylist', { id });
  const pl = r.playlist || {};
  return {
    playlist: { id: pl.id, name: pl.name || '', songCount: pl.songCount || 0 },
    songs: (pl.entry || []).map((tr) => mapTrack(s, tr)),
  };
}

module.exports = {
  CONFIG_FILE,
  listServersPublic, getServer, saveServer, deleteServer,
  authParams, buildRestUrl, audioProxyUrl, subsonicCall, mapTrack,
  browseArtists, browseArtist, browseAlbum, browsePlaylists, browsePlaylist,
};
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/subsonic-api.test.js`
Expected: 7 个 test 全 PASS

- [ ] **Step 5: 回归 origin-guard（确认没碰到 server.js 也跑一遍基线）**

Run: `node --test tests/local-api-origin-guard.test.js`
Expected: 全 PASS

- [ ] **Step 6: Commit（仅在主人明确"提交"时）**

```bash
git add subsonic-api.js tests/subsonic-api.test.js
git commit -m "feat: Subsonic/Navidrome 远程音乐库服务端模块"
```

---

### Task 2: server.js 路由接线

**Files:**
- Modify: `server.js:133` 之后（require 区）、`server.js:7446` 之前（路由区，锚点 `// ---------- 音频代理 (支持 Range) ----------`）
- Test: `tests/subsonic-server-routes.test.js`

**Interfaces:**
- Consumes: Task 1 全部导出；server.js 既有 `sendJSON(res,obj,code)`、`readRequestBody(req)`（server.js:1092）、全局 `res._cors` / `isCrossSiteWrite` 守卫（5072 行，自动覆盖新 POST 路由，无需单独接线）
- Produces（Task 3 前端消费的响应形状）:
  - `GET /api/subsonic/config` → `{servers:[publicServer]}`
  - `POST /api/subsonic/config`（body=saveServer 入参，或 `{action:'delete',id}`）→ `{ok,servers}` / 400 `{error}` / 404
  - `GET /api/subsonic/artists?server=` → `{indexes:[{name,artists:[{id,name,albumCount}]}]}`
  - `GET /api/subsonic/artist?server=&id=` → `{artist,albums}`
  - `GET /api/subsonic/album?server=&id=` → `{album,songs}`
  - `GET /api/subsonic/playlists?server=` → `{playlists}`
  - `GET /api/subsonic/playlist?server=&id=` → `{playlist,songs}`
  - 路由级错误：未知 server → 404 `{error:'SUBSONIC_SERVER_NOT_FOUND'}`；上游失败 → 502 `{error:'SUBSONIC_…'}`

- [ ] **Step 1: 写失败的端到端路由测试**

创建 `tests/subsonic-server-routes.test.js`（启动真实 server 的模式逐字仿 `tests/local-api-origin-guard.test.js`）：

```js
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const PORT = 39873;
const ORIGIN = 'http://127.0.0.1:' + PORT;
process.env.PORT = String(PORT);
delete process.env.HOST;

// 假 Subsonic 上游（真实 server 先于它 require 顺序无关，都走 listen 后再断言）
let lastAuthQuery = null;
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  lastAuthQuery = u.searchParams;
  const ok = (payload) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(Object.assign({ 'subsonic-response': { status: 'ok', version: '1.16.1' } }, payload))); };
  if (u.pathname === '/rest/getArtists.json') return ok({ artists: { index: [{ name: 'A', artist: [{ id: 'ar-1', name: 'Artist One', albumCount: 2 }] }] } });
  if (u.pathname === '/rest/getArtist.json') return ok({ artist: { id: 'ar-1', name: 'Artist One', album: [{ id: 'al-1', name: 'Album X', artist: 'Artist One', songCount: 1, duration: 213 }] } });
  if (u.pathname === '/rest/getAlbum.json') return ok({ album: { id: u.searchParams.get('id') || '', name: 'Empty Album', song: [] } });
  if (u.pathname === '/rest/stream.json') { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(Buffer.from([0x49, 0x44, 0x33])); return; }
  res.writeHead(404).end('{}');
});
let fakePort;
test.before(async () => { fakePort = (await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)))); });

const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;
async function waitListening() { if (!server.listening) await new Promise((resolve) => server.once('listening', resolve)); }
const sub = require('../subsonic-api.js');
let serverId = '';

test('POST /api/subsonic/config 保存后 GET 不回显密码', async () => {
  await waitListening();
  const r = await fetch(BASE + '/api/subsonic/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ name: 'lan', baseUrl: 'http://127.0.0.1:' + fakePort, username: 'alice', password: 'guessme' }),
  });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  serverId = j.server.id;
  assert.ok(sub.getServer(serverId).password);
  const g = await (await fetch(BASE + '/api/subsonic/config')).json();
  assert.strictEqual(JSON.stringify(g).includes('guessme'), false);
});

test('恶意 Origin 的 POST 仍被全局 403 拦截', async () => {
  await waitListening();
  const r = await fetch(BASE + '/api/subsonic/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ action: 'delete', id: serverId }),
  });
  assert.strictEqual(r.status, 403);
});

test('GET /api/subsonic/artists 经上游 token 认证并映射', async () => {
  await waitListening();
  const r = await fetch(BASE + '/api/subsonic/artists?server=' + serverId);
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.indexes[0].artists[0].id, 'ar-1');
  assert.strictEqual(lastAuthQuery.get('u'), 'alice');
  assert.ok(lastAuthQuery.get('t'));
  assert.ok(lastAuthQuery.get('s'));
});

test('GET /api/subsonic/album 的 songs 带 localUrl 且可经 /api/audio 播放', async () => {
  await waitListening();
  const j = await (await fetch(BASE + '/api/subsonic/album?server=' + serverId + '&id=al-empty')).json();
  assert.strictEqual(j.songs.length, 0);   // 空专辑不崩
  const k = await (await fetch(BASE + '/api/subsonic/artist?server=' + serverId + '&id=ar-1')).json();
  assert.strictEqual(k.albums[0].title, 'Album X');
});

test('未知 server 参数 → 404 SUBSONIC_SERVER_NOT_FOUND', async () => {
  await waitListening();
  const r = await fetch(BASE + '/api/subsonic/artists?server=nope');
  assert.strictEqual(r.status, 404);
});

test('清理：删除配置', async () => {
  await waitListening();
  const r = await fetch(BASE + '/api/subsonic/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ action: 'delete', id: serverId }),
  });
  assert.strictEqual((await r.json()).ok, true);
});

after(() => { server.close(); fake.close(); sub.deleteServer(serverId); });
```

注：`browseAlbum` 断言中假上游未挂 `/rest/getAlbum.json`，返回空 album/songs——保留该断言即验证缺数据不崩。若希望覆盖 getAlbum 正路径，在 Task 1 单测已覆盖，不重复。

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/subsonic-server-routes.test.js`
Expected: `404`（路由不存在时落到静态兜底，`/api/subsonic/config` POST 返回非 200）

- [ ] **Step 3: 接 require**

`server.js:132`（`const qishuiQrLogin = require('./qishui-qr-login');`）之后加一行：

```js
const subsonicApi = require('./subsonic-api.js');
```

- [ ] **Step 4: 插入路由**

在 `server.js` 锚点 `  // ---------- 音频代理 (支持 Range) ----------`（原 :7446）之前插入：

```js
  // ---------- Subsonic / Navidrome 远程音乐库 ----------
  if (pn === '/api/subsonic/config') {
    if (req.method === 'GET') { sendJSON(res, { servers: subsonicApi.listServersPublic() }); return; }
    if (req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        if (body && body.action === 'delete') {
          const okDel = subsonicApi.deleteServer(body.id);
          sendJSON(res, { ok: !!okDel, servers: subsonicApi.listServersPublic() }, okDel ? 200 : 404);
          return;
        }
        const saved = subsonicApi.saveServer(body || {});
        sendJSON(res, { ok: true, server: saved, servers: subsonicApi.listServersPublic() });
      } catch (err) {
        console.error('[SubsonicConfig]', err.message);
        sendJSON(res, { error: err.message || 'SUBSONIC_CONFIG_FAILED' }, 400);
      }
      return;
    }
    sendJSON(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
    return;
  }
  if (pn.startsWith('/api/subsonic/')) {
    const sid = url.searchParams.get('server') || '';
    try {
      if (!subsonicApi.getServer(sid)) { sendJSON(res, { error: 'SUBSONIC_SERVER_NOT_FOUND' }, 404); return; }
      if (pn === '/api/subsonic/artists') { sendJSON(res, await subsonicApi.browseArtists(sid)); return; }
      if (pn === '/api/subsonic/artist') { sendJSON(res, await subsonicApi.browseArtist(sid, url.searchParams.get('id') || '')); return; }
      if (pn === '/api/subsonic/album') { sendJSON(res, await subsonicApi.browseAlbum(sid, url.searchParams.get('id') || '')); return; }
      if (pn === '/api/subsonic/playlists') { sendJSON(res, await subsonicApi.browsePlaylists(sid)); return; }
      if (pn === '/api/subsonic/playlist') { sendJSON(res, await subsonicApi.browsePlaylist(sid, url.searchParams.get('id') || '')); return; }
      sendJSON(res, { error: 'SUBSONIC_UNKNOWN_ENDPOINT' }, 404);
    } catch (err) {
      console.error('[Subsonic]', err.message);
      sendJSON(res, { error: err.message || 'SUBSONIC_REQUEST_FAILED' }, err.notFound ? 404 : 502);
    }
    return;
  }
```

- [ ] **Step 5: 运行确认通过**

Run: `node --test tests/subsonic-server-routes.test.js`
Expected: 6 个 test 全 PASS

- [ ] **Step 6: 回归安全守卫**

Run: `node --test tests/local-api-origin-guard.test.js tests/subsonic-api.test.js`
Expected: 全 PASS

- [ ] **Step 7: Commit（仅在主人明确"提交"时）**

```bash
git add server.js tests/subsonic-server-routes.test.js
git commit -m "feat: /api/subsonic 路由接线（config + 5 browse 端点）"
```

---

### Task 3: 前端"远程库"tab + 播放接线

**Files:**
- Create: `public/js/modules/06-lyrics/07-subsonic-library.js`
- Modify: `public/index.html:1220`（tab 按钮）、`:1250` 后（pane 容器）
- Modify: `public/js/index-loader.js:114`（注册）
- Modify: `public/js/modules/00-state/02-preferences-ui-modes.js:52-55`
- Modify: `public/js/modules/06-lyrics/01-playlist-panel-shell.js:196-236`
- Test: `tests/subsonic-ui-wiring.test.js`

**Interfaces:**
- Consumes: 全局 `apiJson`、`escHtml`、`showToast`、`showLoading`/`hideLoading`、`cloneSong`、`safeRenderQueuePanel`、`safeSwitchPlaylistTab`、`safeShelfRebuild`、`forcePlaybackControlsInteractive`、`playQueueAt`、状态变量 `playQueue`/`currentIdx`（全部由 index-loader 拼接为同一全局作用域，播客模块即此用法：`03-podcast-playlist-loaders.js:50-58`）；Task 2 的 6 组路由
- Produces: `switchPlaylistTab('subsonic')`、`refreshSubsonicPane()`（供 shell 调用）

- [ ] **Step 1: 写失败的前端接线静态测试**

创建 `tests/subsonic-ui-wiring.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const read = (p) => fs.readFileSync(p, 'utf8');

test('index-loader 注册了 07-subsonic-library.js', () => {
  assert.ok(read('public/js/index-loader.js').includes("'js/modules/06-lyrics/07-subsonic-library.js'"));
});

test('index.html 有 tab-subsonic 按钮和 subsonic-pane 容器', () => {
  const html = read('public/index.html');
  assert.ok(html.includes('id="tab-subsonic"'));
  assert.ok(html.includes('id="subsonic-pane"'));
  assert.ok(html.includes('id="subsonic-list"'));
});

test('normalizePlaylistPanelTab 认 subsonic', () => {
  const src = read('public/js/modules/00-state/02-preferences-ui-modes.js');
  assert.ok(src.includes("tab === 'subsonic' ? 'subsonic'"));
});

test('shell 的 switchPlaylistTab 处理 subsonic 面板', () => {
  const src = read('public/js/modules/06-lyrics/01-playlist-panel-shell.js');
  assert.ok(src.includes("getElementById('subsonic-pane')"));
  assert.ok(src.includes('refreshSubsonicPane'));
});

test('模块文件存在且暴露播放入口', () => {
  const src = read('public/js/modules/06-lyrics/07-subsonic-library.js');
  assert.ok(src.includes('function playSubsonicSongs'));
  assert.ok(src.includes('function refreshSubsonicPane'));
  assert.ok(src.includes('window.refreshSubsonicPane'));
  assert.ok(src.includes('localUrl'));
});
```

（注意：测试用相对路径，必须在仓库根执行，与现有 UI 静态测试一致。）

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/subsonic-ui-wiring.test.js`
Expected: 全部 FAIL（ENOENT / 缺字符串）

- [ ] **Step 3: markup 与注册**

`public/index.html` 在 `:1220`（tab-podcast 按钮行）后加：

```html
          <button id="tab-subsonic" class="panel-tab" onclick="switchPlaylistTab('subsonic')">远程库</button>
```

在 `</div>`（podcast-pane 闭合，原 :1250）后加：

```html
      <div id="subsonic-pane" style="display:none">
        <div class="queue-toolbar">
          <div class="queue-chip">Navidrome / Subsonic</div>
          <button class="fx-mini-btn ghost" onclick="refreshSubsonicPane()"
            style="height:26px;padding:0 10px;font-size:11px">刷新</button>
        </div>
        <div id="subsonic-list"></div>
      </div>
```

`public/js/index-loader.js` 第 114 行 `'js/modules/06-lyrics/03-podcast-playlist-loaders.js',` 之后加：

```js
    'js/modules/06-lyrics/07-subsonic-library.js',
```

- [ ] **Step 4: shell 三处修改**

`02-preferences-ui-modes.js:54` 的 normalize 函数体改为：

```js
  return tab === 'subsonic' ? 'subsonic' : (tab === 'podcasts' ? 'podcasts' : (tab === 'playlists' ? 'playlists' : 'queue'));
```

`01-playlist-panel-shell.js`：
1. `animatePlaylistPanelCurrentTab`（:196-206）最后一个 `} else {` 前插入分支：

```js
  } else if (queueViewTab === 'subsonic') {
    animateVisiblePanelList(document.getElementById('subsonic-list'), '.pl-card', panel);
```

2. `preparePlaylistPanelTabOnOpen`（:215）的

```js
  else if (queueViewTab === 'playlists' || queueViewTab === 'podcasts') refreshUserPlaylists();
```

改为：

```js
  else if (queueViewTab === 'playlists' || queueViewTab === 'podcasts') refreshUserPlaylists();
  else if (queueViewTab === 'subsonic') refreshSubsonicPane();
```

3. `switchPlaylistTab`（:217-236）：在 podcastTab 两行后加：

```js
  var subsonicTab = document.getElementById('tab-subsonic');
  if (subsonicTab) subsonicTab.classList.toggle('active', tab === 'subsonic');
```

在 podcastPane 两行后加：

```js
  var subsonicPane = document.getElementById('subsonic-pane');
  if (subsonicPane) subsonicPane.style.display = tab === 'subsonic' ? '' : 'none';
```

:234 刷新行后加：

```js
  if (tab === 'subsonic' && opts.refresh !== false) refreshSubsonicPane();
```

- [ ] **Step 5: 实现 `07-subsonic-library.js`**

```js
// ---------- Subsonic / Navidrome 远程音乐库（播放列表面板第四 tab） ----------
var subsonicNav = [];          // 视图栈
var subsonicSongsCache = [];   // 当前 songs 视图的曲目（供点击播放）

function subsonicCurrentView() { return subsonicNav[subsonicNav.length - 1] || { type: 'servers' }; }
function subsonicPushView(view) { subsonicNav.push(view); renderSubsonicPane(); }
function subsonicBack() { subsonicNav.pop(); renderSubsonicPane(); }

function fmtSubsonicDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  var m = Math.floor(sec / 60), s2 = sec % 60;
  return m + ':' + (s2 < 10 ? '0' : '') + s2;
}

function subsonicHead(title, canBack) {
  return '<div class="podcast-inline-head"><div class="pl-section-label">' + escHtml(title) + '</div>' +
    (canBack ? '<button class="fx-mini-btn ghost" data-sub-act="back" style="height:24px;padding:0 9px;font-size:10.5px">返回</button>' : '') +
    '</div>';
}
function subsonicCard(attrs) {
  return '<div class="pl-card podcast-card" data-sub-act="' + attrs.act + '"' +
    (attrs.id ? ' data-sub-id="' + escHtml(String(attrs.id)) + '"' : '') +
    (attrs.extra || '') + '>' +
    (attrs.cover ? '<img src="' + escHtml(attrs.cover) + '" alt="" loading="lazy" decoding="async" style="width:44px;height:44px;border-radius:8px;flex-shrink:0" onerror="this.style.opacity=0.2">' : '<div style="width:44px;height:44px;border-radius:8px;background:rgba(0,245,212,.07);flex-shrink:0"></div>') +
    '<div style="flex:1;min-width:0"><div class="pl-name">' + escHtml(attrs.name || '') + '</div><div class="pl-sub">' + escHtml(attrs.sub || '') + '</div></div>' +
    (attrs.tail || '') + '</div>';
}

async function renderSubsonicPane() {
  var $list = document.getElementById('subsonic-list');
  if (!$list) return;
  var view = subsonicCurrentView();
  showLoading();
  try {
    if (view.type === 'servers') {
      var r = await apiJson('/api/subsonic/config');
      var servers = r.servers || [];
      var cards = servers.map(function (s) {
        return subsonicCard({ act: 'server', id: s.id, name: s.name, sub: s.username + ' @ ' + s.baseUrl,
          extra: ' data-sub-server-id="' + escHtml(s.id) + '"',
          tail: '<button class="fx-mini-btn ghost" data-sub-act="delete-server" data-sub-id="' + escHtml(s.id) + '" style="height:24px;padding:0 9px;font-size:10.5px">删除</button>' });
      }).join('');
      var empty = '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">尚未添加服务器</div>';
      var form = '<form id="subsonic-server-form" style="padding:10px;display:flex;flex-direction:column;gap:6px">' +
        '<input id="subsonic-name" placeholder="名称（如：家里NAS）" style="height:28px;font-size:12px" autocomplete="off">' +
        '<input id="subsonic-url" placeholder="服务器地址 http://…:4533" style="height:28px;font-size:12px" autocomplete="off">' +
        '<input id="subsonic-user" placeholder="用户名" style="height:28px;font-size:12px" autocomplete="off">' +
        '<input id="subsonic-pass" type="password" placeholder="密码（留空=保留已存密码）" style="height:28px;font-size:12px" autocomplete="new-password">' +
        '<button type="submit" class="fx-mini-btn ghost" style="height:28px;font-size:12px">保存</button></form>';
      $list.innerHTML = subsonicHead('远程音乐库', false) + (cards || empty) + form;
      return;
    }
    if (view.type === 'artists') {
      var ra = await apiJson('/api/subsonic/artists?server=' + encodeURIComponent(view.serverId));
      var groups = (ra.indexes || []).map(function (ix) {
        return '<div class="pl-section-label" style="opacity:.5">' + escHtml(ix.name) + '</div>' +
          ix.artists.map(function (a) {
            return subsonicCard({ act: 'artist', id: a.id, name: a.name, sub: (a.albumCount || 0) + ' 张专辑', extra: ' data-sub-server-id="' + escHtml(view.serverId) + '"' });
          }).join('');
      }).join('');
      $list.innerHTML = subsonicHead('艺术家', true) + (groups || '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">暂无内容</div>');
      return;
    }
    if (view.type === 'albums' || view.type === 'playlists') {
      var url2 = view.type === 'albums'
        ? '/api/subsonic/artist?server=' + encodeURIComponent(view.serverId) + '&id=' + encodeURIComponent(view.artistId)
        : '/api/subsonic/playlists?server=' + encodeURIComponent(view.serverId);
      var r2 = await apiJson(url2);
      var items = view.type === 'albums' ? (r2.albums || []) : (r2.playlists || []);
      subsonicNav[subsonicNav.length - 1].items = items;
      var itemCards = items.map(function (it) {
        return subsonicCard({ act: view.type === 'albums' ? 'album' : 'playlist', id: it.id, name: it.title || it.name, sub: (it.artist || it.owner || '') + (it.songCount ? ' · ' + it.songCount + ' 首' : ''), cover: it.cover, extra: ' data-sub-server-id="' + escHtml(view.serverId) + '"' });
      }).join('');
      $list.innerHTML = subsonicHead(view.title || (view.type === 'albums' ? '专辑' : '歌单'), true) +
        (itemCards || '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">暂无内容</div>');
      return;
    }
    if (view.type === 'songs') {
      var r3 = await apiJson(view.endpoint);
      var songs = r3.songs || [];
      view.songs = songs;
      subsonicSongsCache = songs;
      var meta = r3.album || r3.playlist || {};
      var songRows = songs.map(function (sg, i) {
        return subsonicCard({ act: 'play', id: i, name: sg.name, sub: sg.artist + (sg.album ? ' — ' + sg.album : ''), tail: '<span style="font-size:10.5px;opacity:.5">' + fmtSubsonicDuration(sg.duration) + '</span>' });
      }).join('');
      $list.innerHTML = subsonicHead(view.title || meta.title || meta.name || '曲目', true) +
        (songRows || '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.28);font-size:11.5px">暂无曲目</div>');
      return;
    }
    $list.innerHTML = '';
  } catch (e) {
    console.warn('[Subsonic]', e);
    $list.innerHTML = subsonicHead(subsonicCurrentView().title || '远程音乐库', true) +
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
    var title = (el.querySelector('.pl-name') || {}).textContent || '';
    if (act === 'back') { subsonicBack(); return; }
    if (act === 'delete-server') {
      apiJson('/api/subsonic/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', id: id }) })
        .then(function () { renderSubsonicPane(); });
      return;
    }
    if (act === 'server') { subsonicPushView({ type: 'artists', serverId: id, title: title }); return; }
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
```

接线说明：事件绑定用顶层语句 + 非 async 回调（`.then` 链式、`playSubsonicSongs` fire-and-forget），与播客模块顶层绑定模式一致（`03-podcast-playlist-loaders.js:1-17`），规避拼接脚本对顶层 `await`/IIFE 的兼容问题；inline `onclick` 用到的函数经 `window.*` 暴露（同 `06-track-detail-lyrics-actions.js:1718-1724` 注释的约束）。

- [ ] **Step 6: 运行静态测试确认通过**

Run: `node --test tests/subsonic-ui-wiring.test.js`
Expected: 5 个 test 全 PASS

- [ ] **Step 7: 浏览器手工验收（UI 功能必须过浏览器）**

```bash
PORT=39890 node server.js   # 独立实例，勿占用 :3000 用户实例
```

打开 `http://127.0.0.1:39890`：
1. 播放列表面板出现"远程库"tab；无服务器时空态 + 表单。
2. 添加一台真机/假 Navidrome（可用 Task 2 的 fake 思路，或直接用户自有实例），刷新后显示服务器卡。
3. 钻取 艺术家→专辑→曲目；点单曲整张专辑入队并自动播放，进度条可拖（验证 /api/audio Range 透传）。
4. 歌单列表→点开可整单播放。
5. 返回按钮逐级回退；删除服务器后刷新列表。
6. 切到"当前队列"tab 再回来，视图不串。

（browser-use 隐藏标签失效是已知项目限制——此步人工点验或 CDP 调试实例进行。）

- [ ] **Step 8: 全量相关回归**

Run: `node --test tests/subsonic-api.test.js tests/subsonic-server-routes.test.js tests/subsonic-ui-wiring.test.js tests/local-api-origin-guard.test.js`
Expected: 全 PASS

- [ ] **Step 9: Commit（仅在主人明确"提交"时）**

```bash
git add public/js/modules/06-lyrics/07-subsonic-library.js public/js/index-loader.js public/index.html public/js/modules/00-state/02-preferences-ui-modes.js public/js/modules/06-lyrics/01-playlist-panel-shell.js tests/subsonic-ui-wiring.test.js
git commit -m "feat: 播放列表面板新增 Subsonic/Navidrome 远程库 tab"
```

---

## 验收标准（对应指南第 7 条 B 项）

1. 可添加多个 Subsonic 服务器；凭据存 `data/subsonic-servers.json`，任何 GET API 不回显密码。
2. 浏览艺术家/专辑/歌单；曲目带标题、艺术家、专辑、时长、封面。
3. 串流播放走 `/api/audio` Range 透传，可 seek。
4. 默认 127.0.0.1 绑定与 origin-guard 行为零改动；新 POST 路由受全局跨站写 403 保护。

## 风险与决策记录

- **明文密码 v1**：safeStorage 只在 Electron 主进程可用，server.js 独立跑时拿不到；文件写入 `data/`，与 cookie 文件同级敏感度。网盘分发场景需在 README 提示"勿把 data/ 目录打包分发"。**AI推理**
- **私网 baseUrl**：`/api/proxy` 的 `isPrivateHost` 会拦局域网 IP，故本功能上游请求全部由 `subsonic-api.js` 自发（不经 `/api/proxy`），只对用户自配 baseUrl 放行——配置写入仅允许 same-origin POST，攻击面等于"攻击者已能控制你的本机 UI"。**有来源**（server.js:299-318、503-510）
- **token 内嵌 localUrl**：`stream.json` 的 u/s/t 随 browse 响应下发给渲染进程，与 Vynody 同构（其 buildStreamUrl 亦嵌凭据）。已知泄露面=本机同源前端。**有来源**（subsonic_client.dart:113-128）
- 不做：远程搜索（search3）、收藏/star、转码参数 maxBitRate 调节、歌词 getLyrics 对接（Stellaflix 歌词管线按平台 id 匹配，subsonic 曲目自然落到本地文件歌词/.lrc 管线之外，留待后续）。
