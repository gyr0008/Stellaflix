'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.STELLAFIX_SUBSONIC_CONFIG_FILE || path.join(__dirname, 'data', 'subsonic-servers.json');
const API_V = '1.16.1';
const CLIENT = 'Stellaflix';
// 上游请求超时（ms）；测试可用 STELLAFIX_SUBSONIC_TIMEOUT_MS 缩短，生产默认 15s
const TIMEOUT_MS = Number(process.env.STELLAFIX_SUBSONIC_TIMEOUT_MS) || 15000;

function loadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { version: 1, servers: parsed && Array.isArray(parsed.servers) ? parsed.servers : [] };
  } catch (_) {
    console.warn('[Subsonic] config unreadable, starting empty:', CONFIG_FILE);
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
  // userinfo（http://user:pass@host）会被原样存储并由 GET /api/subsonic/config 回显 → 明文凭据泄漏
  if (parsed.username || parsed.password) throw new Error('SUBSONIC_BAD_BASE_URL');
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
    { v: API_V, c: CLIENT, f: 'json' },
    authParams(server),
    params || {}));
  // Navidrome 实测只路由 .view / 无后缀（.json 返回 404，Subsonic 规范里的 .json 并非通行）
  return server.baseUrl + '/rest/' + endpoint + '.view?' + q.toString();
}

function audioProxyUrl(upstreamUrl) {
  return '/api/audio?url=' + encodeURIComponent(upstreamUrl);
}

function isAbortishError(err) {
  return !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

async function subsonicCall(server, endpoint, params) {
  let res;
  try {
    res = await fetch(buildRestUrl(server, endpoint, params), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    // 上游不可达/DNS/拒绝连接等网络层错误：raw `TypeError: fetch failed` 会泄漏到路由层，
    // 统一收敛为 SUBSONIC_* 命名空间（原始错误保留在 cause 里）
    if (isAbortishError(err)) throw new Error('SUBSONIC_TIMEOUT', { cause: err });
    throw new Error('SUBSONIC_NETWORK', { cause: err });
  }
  if (!res.ok) throw new Error('SUBSONIC_HTTP_' + res.status);
  let body;
  try {
    body = await res.json();
  } catch (err) {
    if (isAbortishError(err)) throw new Error('SUBSONIC_TIMEOUT', { cause: err });
    throw new Error('SUBSONIC_BAD_JSON', { cause: err });
  }
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
