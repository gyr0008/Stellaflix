/*!
 * 03b-local-playlist-store.js — 本地歌单持久化与 CRUD
 * 专用存储键 stellaflix-local-playlists；首次加载时从旧键 stellaflix-user-playlists
 * 迁移带 localUserPlaylist 标记的条目，绝不回写旧键（其中混有在线平台歌单）。
 */
(function () {
  'use strict';

  var STORE_KEY = 'stellaflix-local-playlists';
  var LEGACY_KEY = 'stellaflix-user-playlists';
  var NAME_MAX = 40;
  var MAX_SONGS = 1000;

  var playlists = null;

  function storage() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (e) { }
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    return null;
  }

  function readKey(key) {
    var store = storage();
    if (!store) return null;
    try {
      var raw = store.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function normalizeName(value) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
  }

  function makeId() {
    return 'local-pl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function songRef(song) {
    if (!song) return '';
    if (song.localKey) return 'lk:' + song.localKey;
    if (song.id) return 'id:' + song.id;
    var name = String(song.name || song.title || '');
    var artist = String(song.singer || song.artist || '');
    return (name || artist) ? ((name + '|' + artist).toLowerCase()) : '';
  }

  function sanitize(raw) {
    var pl = raw && typeof raw === 'object' ? raw : {};
    if (!pl.id) pl.id = makeId();
    pl.name = normalizeName(pl.name) || '本地歌单';
    pl.songs = Array.isArray(pl.songs) ? pl.songs.filter(function (s) { return s && typeof s === 'object'; }) : [];
    pl.trackCount = pl.songs.length;
    pl.localUserPlaylist = true;
    if (typeof pl.cover !== 'string') pl.cover = '';
    if (typeof pl.updatedAt !== 'number') pl.updatedAt = Date.now();
    return pl;
  }

  function persist() {
    var store = storage();
    if (!store) return false;
    try {
      store.setItem(STORE_KEY, JSON.stringify(playlists || []));
      return true;
    } catch (e) {
      return false;
    }
  }

  function load(force) {
    if (playlists && !force) return playlists;
    var disk = readKey(STORE_KEY);
    if (Array.isArray(disk)) {
      playlists = disk.filter(function (pl) { return pl && typeof pl === 'object'; }).map(sanitize);
    } else {
      var legacy = readKey(LEGACY_KEY);
      playlists = (Array.isArray(legacy) ? legacy : [])
        .filter(function (pl) { return pl && pl.localUserPlaylist; })
        .map(sanitize);
      persist();
    }
    return playlists;
  }

  function findById(id) {
    load();
    id = String(id == null ? '' : id);
    for (var i = 0; i < playlists.length; i++) {
      if (String(playlists[i].id) === id) return playlists[i];
    }
    return null;
  }

  function findByName(name) {
    var wanted = normalizeName(name).toLowerCase();
    if (!wanted) return null;
    load();
    for (var i = 0; i < playlists.length; i++) {
      if (normalizeName(playlists[i].name).toLowerCase() === wanted) return playlists[i];
    }
    return null;
  }

  function userPlaylistsRef() {
    if (typeof window === 'undefined') return null;
    if (!Array.isArray(window.userPlaylists)) {
      try {
        if (typeof window.userPlaylists === 'undefined' || window.userPlaylists === null) window.userPlaylists = [];
        else return null;
      } catch (e) {
        return null;
      }
    }
    return window.userPlaylists;
  }

  function mirrorIntoUserPlaylists() {
    var target = userPlaylistsRef();
    load();
    if (!target) return;
    playlists.forEach(function (pl) {
      for (var i = 0; i < target.length; i++) {
        if (target[i] && String(target[i].id) === String(pl.id)) {
          if (target[i] !== pl && Number(target[i].updatedAt) > Number(pl.updatedAt)) {
            playlists[playlists.indexOf(pl)] = target[i];
          } else {
            target[i] = pl;
          }
          return;
        }
      }
      target.unshift(pl);
    });
    for (var j = 0; j < target.length; j++) {
      var entry = target[j];
      if (entry && entry.localUserPlaylist && playlists.indexOf(entry) === -1 && !findById(entry.id)) {
        playlists.push(sanitize(entry));
      }
    }
  }

  function unmirrorFromUserPlaylists(id) {
    var target = userPlaylistsRef();
    if (!target) return;
    id = String(id);
    for (var i = target.length - 1; i >= 0; i--) {
      if (target[i] && target[i].localUserPlaylist && String(target[i].id) === id) target.splice(i, 1);
    }
  }

  function create(name) {
    var clean = normalizeName(name);
    if (!clean) return { ok: false, error: 'PLAYLIST_NAME_REQUIRED', message: '请提供歌单名称' };
    var existing = findByName(clean);
    if (existing) return { ok: true, created: false, playlist: existing };
    var pl = sanitize({ id: makeId(), name: clean, songs: [], cover: '', creator: '本地歌单', createdAt: Date.now(), updatedAt: Date.now() });
    load();
    playlists.unshift(pl);
    if (!persist()) {
      playlists = playlists.filter(function (item) { return item !== pl; });
      return { ok: false, error: 'PLAYLIST_SAVE_FAILED', message: '本地歌单保存失败' };
    }
    mirrorIntoUserPlaylists();
    return { ok: true, created: true, playlist: pl };
  }

  function rename(id, name) {
    var pl = findById(id);
    if (!pl) return { ok: false, error: 'PLAYLIST_NOT_FOUND', message: '没有找到该歌单' };
    var clean = normalizeName(name);
    if (!clean) return { ok: false, error: 'PLAYLIST_NAME_REQUIRED', message: '请提供歌单名称' };
    var clash = findByName(clean);
    if (clash && clash !== pl) return { ok: false, error: 'PLAYLIST_NAME_EXISTS', message: '已有同名歌单：' + clean };
    pl.name = clean;
    pl.updatedAt = Date.now();
    if (!persist()) return { ok: false, error: 'PLAYLIST_SAVE_FAILED', message: '本地歌单保存失败' };
    mirrorIntoUserPlaylists();
    return { ok: true, playlist: pl };
  }

  function remove(id) {
    var pl = findById(id);
    if (!pl) return { ok: false, error: 'PLAYLIST_NOT_FOUND', message: '没有找到该歌单' };
    playlists = playlists.filter(function (item) { return item !== pl; });
    if (!persist()) return { ok: false, error: 'PLAYLIST_SAVE_FAILED', message: '本地歌单保存失败' };
    unmirrorFromUserPlaylists(pl.id);
    return { ok: true, playlist: pl };
  }

  function addSong(id, song) {
    var pl = findById(id);
    if (!pl) return { ok: false, error: 'PLAYLIST_NOT_FOUND', message: '没有找到该歌单' };
    if (!song || typeof song !== 'object') return { ok: false, error: 'NO_SONG', message: '没有可以收藏的歌曲' };
    pl.songs = Array.isArray(pl.songs) ? pl.songs : [];
    var ref = songRef(song);
    if (!ref) return { ok: false, error: 'SONG_IDENTITY_MISSING', message: '歌曲缺少标识' };
    for (var i = 0; i < pl.songs.length; i++) {
      if (songRef(pl.songs[i]) === ref) return { ok: true, added: 0, duplicate: true, playlist: pl };
    }
    if (pl.songs.length >= MAX_SONGS) return { ok: false, error: 'PLAYLIST_LIMIT_REACHED', message: '单个歌单最多 ' + MAX_SONGS + ' 首歌曲' };
    var stored;
    try {
      stored = typeof window.cloneSong === 'function' ? window.cloneSong(song) : JSON.parse(JSON.stringify(song));
    } catch (e) {
      stored = Object.assign({}, song);
    }
    pl.songs.unshift(stored);
    pl.trackCount = pl.songs.length;
    if (!pl.cover) pl.cover = stored.cover || stored.picUrl || '';
    pl.updatedAt = Date.now();
    if (!persist()) {
      pl.songs.shift();
      pl.trackCount = pl.songs.length;
      return { ok: false, error: 'PLAYLIST_SAVE_FAILED', message: '本地歌单保存失败' };
    }
    return { ok: true, added: 1, duplicate: false, playlist: pl };
  }

  function removeSong(id, ref) {
    var pl = findById(id);
    if (!pl) return { ok: false, error: 'PLAYLIST_NOT_FOUND', message: '没有找到该歌单' };
    pl.songs = Array.isArray(pl.songs) ? pl.songs : [];
    var wanted = String(ref == null ? '' : ref);
    if (!wanted) return { ok: false, error: 'SONG_REF_MISSING', message: '缺少歌曲标识' };
    var removed = null;
    pl.songs = pl.songs.filter(function (song) {
      if (removed) return true;
      var matches = song && (song.localKey === wanted || songRef(song) === wanted || songRef(song) === 'lk:' + wanted);
      if (matches) {
        removed = song;
        return false;
      }
      return true;
    });
    if (!removed) return { ok: false, error: 'SONG_NOT_IN_PLAYLIST', message: '歌单里没有这首歌' };
    pl.trackCount = pl.songs.length;
    pl.updatedAt = Date.now();
    persist();
    return { ok: true, playlist: pl, removed: removed };
  }

  function resolveSongs(idOrPlaylist, library) {
    var pl = (idOrPlaylist && typeof idOrPlaylist === 'object') ? idOrPlaylist : findById(idOrPlaylist);
    var stored = pl && Array.isArray(pl.songs) ? pl.songs : [];
    var byKey = Object.create(null);
    (Array.isArray(library) ? library : []).forEach(function (track) {
      if (track && track.localKey) byKey[track.localKey] = track;
    });
    var songs = [];
    var missingCount = 0;
    stored.forEach(function (song) {
      if (!song) return;
      if (song.localKey) {
        var fresh = byKey[song.localKey];
        if (fresh) songs.push(fresh);
        else missingCount++;
        return;
      }
      songs.push(song);
    });
    return { songs: songs, missingCount: missingCount };
  }

  function list() {
    load();
    return playlists.slice();
  }

  function save() {
    load();
    mirrorIntoUserPlaylists();
    return persist();
  }

  window.localPlaylistStore = {
    STORE_KEY: STORE_KEY,
    LEGACY_KEY: LEGACY_KEY,
    list: list,
    get: findById,
    create: create,
    rename: rename,
    remove: remove,
    addSong: addSong,
    removeSong: removeSong,
    resolveSongs: resolveSongs,
    songRef: songRef,
    save: save,
    load: load,
  };

  window.localPlaylistSongKey = function (song) {
    if (!song) return '';
    if (song.localKey) return song.localKey;
    if (song.id) return String(song.id);
    return String(song.name || song.title || '') + '|' + String(song.singer || song.artist || '');
  };

  // 覆盖 agent-adapter.js 的降级桩：AI 助手与 UI 共用同一份存储
  window.ensureLocalUserPlaylistsLoaded = function (force) {
    load(!!force);
    mirrorIntoUserPlaylists();
    return { ok: true, loaded: playlists.length };
  };

  window.saveLocalUserPlaylists = function () {
    return save();
  };
})();
