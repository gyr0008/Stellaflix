// 前端 songToLxMusicInfo() 曾把原生歌曲整体塞进 _raw，顶层只留 name/singer/album/interval，
// 导致这里取不到 provider/hash/songmid，最终 rid 为空、音源脚本抛 "rid should not be empty"。
// 解包规则：_raw 作为基底，顶层非空字段覆盖 _raw 同名项（顶层是调用方显式意图，优先级更高）。
function unwrapRawSong(song) {
  if (!song || typeof song !== 'object') return {};
  const inner = song._raw && typeof song._raw === 'object' ? song._raw : null;
  if (!inner) return song;
  const merged = { ...inner };
  for (const key of Object.keys(song)) {
    if (key === '_raw') continue;
    const value = song[key];
    if (value === undefined || value === null || value === '') continue;
    merged[key] = value;
  }
  return merged;
}

function providerName(song) {
  return String(song?.provider || song?.source || song?.type || '').toLowerCase();
}

function platformKey(input) {
  const song = unwrapRawSong(input);
  const provider = providerName(song);
  // Mineradio 官方五平台 + 洛雪脚本常用别名
  if (provider === 'qq' || provider === 'tx') return 'tx';
  if (provider === 'netease' || provider === 'wy') return 'wy';
  if (provider === 'kugou' || provider === 'kugoumusic' || provider === 'kg') return 'kg';
  // 酷我(kw) / 咪咕(mg) 直接映射
  if (provider === 'kuwo' || provider === 'kw') return 'kw';
  if (provider === 'migu' || provider === 'mg') return 'mg';
  // 汽水音乐(Tencent 版权池) → 用 tx 线路尝试
  if (provider === 'qishui' || provider === 'qishuimusic') return 'tx';
  // Spotify → 用 mg 线路尝试（咪咕海外曲目覆盖较广）；脚本若不支持 mg 会被候选过滤自动跳过
  if (provider === 'spotify' || provider === 'sp' || provider === 'yt' || provider === 'youtube') return 'mg';
  // 本地歌曲不参与第三方解析
  if (provider === 'local' || provider === 'file') return null;
  return null;
}

function formatSeconds(rawSeconds) {
  const seconds = Math.max(0, Number(rawSeconds) || 0);
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function songDurationSeconds(song, source) {
  const value = Number(song?.duration ?? song?.dt ?? song?.interval) || 0;
  if ((source === 'wy' || source === 'kg') && (song?.duration != null || song?.dt != null)) return value / 1000;
  return value > 10_000 ? value / 1000 : value;
}

function artistText(value) {
  if (Array.isArray(value)) {
    return value.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean).join('、');
  }
  return String(value || '');
}

function albumName(song) {
  if (song?.album && typeof song.album === 'object') return String(song.album.name || '');
  return String(song?.album || song?.albumName || '');
}

function toLxMusicInfo(input) {
  const song = unwrapRawSong(input);
  const source = platformKey(song) || '__any__';
  const isUnknownSource = source === '__any__';

  const albumId = song?.albumMid || song?.album_mid || song?.albumId || song?.album_id || '';
  const name = String(song?.name || song?.title || '');
  const singer = artistText(song?.artist || song?.artists || song?.singer);
  const interval = formatSeconds(songDurationSeconds(song, isUnknownSource ? 'wy' : source));
  const cover = song?.cover || song?.picUrl || null;

  // 青听海棠 rid 契约：handleGetMusicUrl(src, info) 用 info.hash ?? info.songmid
  // tx 真实线路内部再用 musicInfo.strMediaMid ?? songmid ?? meta.id ?? meta.strMediaMid
  // → 必须把"每个平台最可能用来定位音频的 ID"写进 info.songmid + info.hash 这两个 ?? 短路入口
  const rawHash = String(
    song?.hash
    || song?.fileHash
    || song?.audioHash
    || song?.mixSongId
    || ''
  ).trim().toLowerCase();

  // QQ(tx)：用 mediaMid / strMediaMid / mid 作为 rid（QingTing tx 内部 ?? 走 songmid）
  const txMediaMid = String(
    song?.mediaMid
    || song?.media_mid
    || song?.strMediaMid
    || song?.fileMediaMid
    || ''
  );
  const txMid = String(song?.mid || song?.songmid || song?.songId || song?.id || '');
  const kuwoRid = String(song?.rid || song?.kuwoRid || song?.musicRid || '');
  const miguRid = String(song?.copyrightId || song?.miguRid || song?.musicId || '');
  const genericSongmid = String(
    song?.providerSongId
    || song?.songmid
    || song?.mid
    || song?.trackId
    || song?.track_id
    || song?.id
    || ''
  );

  // hash 是 ?? 第一优先级；tx/mg/kw 各自把自身版权 ID 塞进 hash 兜底 + songmid 兜底
  const hashFallback = (() => {
    switch (source) {
      case 'kg':
        return rawHash || txMid || genericSongmid;
      case 'tx':
        return rawHash || txMediaMid || txMid || genericSongmid;
      case 'kw':
        return rawHash || kuwoRid || genericSongmid;
      case 'mg':
        return rawHash || miguRid || genericSongmid;
      case 'wy':
        return rawHash || genericSongmid;
      default:
        return rawHash || txMediaMid || txMid || kuwoRid || miguRid || genericSongmid;
    }
  })().trim();

  // songmid 是 ?? 第二优先级；tx 的真实契约再用 strMediaMid ?? songmid ?? meta.*
  const songmidFallback = (() => {
    switch (source) {
      case 'kg':
        return hashFallback;
      case 'tx':
        return txMediaMid || txMid || genericSongmid;
      case 'kw':
        return kuwoRid || genericSongmid || hashFallback;
      case 'mg':
        return miguRid || genericSongmid || hashFallback;
      case 'wy':
        return genericSongmid || hashFallback;
      default:
        return txMediaMid || txMid || kuwoRid || miguRid || genericSongmid || hashFallback;
    }
  })().trim();

  const songId = isUnknownSource
    ? (song?.id || genericSongmid || songmidFallback)
    : (source === 'tx' ? (txMid || txMediaMid || song?.id) : (song?.id || genericSongmid));

  if (source === 'kg') {
    const hash = hashFallback;
    if (!hash && !isUnknownSource) throw new Error('SOURCE_UNSUPPORTED: Missing KuGou hash');
    const albumAudioId = song?.albumAudioId || song?.album_audio_id || '';
    return {
      id: String(song?.id ?? hash),
      name,
      singer,
      source,
      interval,
      hash,
      songmid: songmidFallback || hash,
      albumId,
      albumAudioId,
      meta: {
        songId: song?.id ?? hash,
        albumName: albumName(song),
        albumId,
        albumAudioId,
        hash,
        picUrl: cover,
        qualitys: [],
        _qualitys: {},
      },
    };
  }

  const hasSongId = songId != null && String(songId) !== '';
  if (!hasSongId && !isUnknownSource && !songmidFallback && !hashFallback) {
    throw new Error('SOURCE_UNSUPPORTED: Missing song id');
  }
  const meta = {
    songId: songId || '',
    albumName: albumName(song),
    albumId,
    picUrl: cover,
    qualitys: [],
    _qualitys: {},
  };
  if (source === 'tx') {
    meta.strMediaMid = txMediaMid || songmidFallback;
    meta.id = Number(song?.qqId || song?.songId || 0) || undefined;
    meta.albumMid = String(song?.albumMid || song?.album_mid || albumId);
  }
  // 未知平台把 strMediaMid / hash / songmid 三字段尽量都填上，方便 ?? 兜底脚本继续跑
  if (isUnknownSource) {
    meta.strMediaMid = txMediaMid || songmidFallback;
    meta.id = songId ? Number(songId) || undefined : undefined;
  }
  const info = {
    id: String(song?.id ?? songId ?? songmidFallback ?? ''),
    name,
    singer,
    source,
    interval,
    meta,
    songmid: songmidFallback,
    albumId,
  };
  if (hashFallback) info.hash = hashFallback;
  if (source === 'tx' && meta.strMediaMid) info.strMediaMid = meta.strMediaMid;
  if (isUnknownSource && meta.strMediaMid && !info.strMediaMid) info.strMediaMid = meta.strMediaMid;
  return info;
}

module.exports = { platformKey, formatSeconds, toLxMusicInfo, unwrapRawSong };
