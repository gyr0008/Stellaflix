/*!
 * @name 青听音乐
 * @description 基于GitHub青听音乐项目
 * @version 1.0.0
 * @author GitHub 青听音乐
 */
const DEV_ENABLE = false
// API_URL 可配置：优先使用运行时注入的 globalThis.lx.config.backendUrl（由「第三方音源管理器」的后端地址输入框提供）；
// 未配置时回退到内置默认（青听公共后端，可能已失效）。不内置、不探测任何私有接口或代理服务。
const API_URL = (typeof globalThis.lx !== 'undefined' && globalThis.lx && globalThis.lx.config && typeof globalThis.lx.config.backendUrl === 'string' && globalThis.lx.config.backendUrl)
  ? globalThis.lx.config.backendUrl
  : 'https://musicserver.haitangw.cc/v1/music/resolve-url'

// 线路音质声明，依据 QingMusic 官方公开音源配置 music.json 逐条对齐：
//   https://13413.kstore.vip/QingMusic/music.json
// 官方 levels → 本表映射（仅取洛雪四档能表达的部分）：
//   kw  standard/exhigh/lossless/atmos/atmos_plus/master  → 128k/320k/flac            （官方无 hires，不可声明 flac24bit）
//   kg  standard/exhigh/lossless/hires/atmos/clear        → 128k/320k/flac/flac24bit
//   wy  standard/exhigh/lossless/hires/sky/jyeffect/jymaster → 128k/320k/flac/flac24bit
//   tx  standard/exhigh/lossless                          → 128k/320k/flac
//   mg  standard                                          → 128k
// atmos / atmos_plus / master / clear / sky / jyeffect / jymaster 在洛雪音质体系内无对应档位，暂不映射。
const MUSIC_QUALITY = {
  kw: ['128k', '320k', 'flac'],
  kg: ['128k', '320k', 'flac', 'flac24bit'],
  wy: ['128k', '320k', 'flac', 'flac24bit'],
  tx: ['128k', '320k', 'flac'],
  mg: ['128k'],
}
// 洛雪音质档位 -> 青听 level 档位
const LEVEL_MAP = {
  '128k': 'standard',
  '320k': 'exhigh',
  'flac': 'lossless',
  'flac24bit': 'hires',
}
const MUSIC_SOURCE = Object.keys(MUSIC_QUALITY)
const { EVENT_NAMES, request, on, send, env, version } = globalThis.lx

const httpFetch = (url, options = { method: 'GET' }) => {
  return new Promise((resolve, reject) => {
    request(url, options, (err, resp, body) => {
      if (err) return reject(err)
      resolve({ ...resp, body })
    })
  })
}

const handleGetMusicUrl = async (source, musicInfo, quality) => {
  // rid 契约按洛雪客户端约定做长兜底链：
  // kg 官方脚本用 hash，tx 官方脚本用 strMediaMid ?? songmid，wy/mg/kw 用 songmid（不同脚本差异较大）。
  // 这里用最深层的 ?? 链把所有入口都覆盖，同时保持 ?? 短路逻辑（不使用 '||' 以免把 '0'/'false' 当空）。
  const rid = musicInfo.hash
    ?? musicInfo.songmid
    ?? musicInfo.strMediaMid
    ?? musicInfo.id
    ?? (musicInfo.meta && (musicInfo.meta.strMediaMid ?? musicInfo.meta.id ?? musicInfo.meta.songId))
    ?? '';
  if (!rid) throw new Error('rid should not be empty');
  const level = LEVEL_MAP[quality] ?? 'standard';

  const resp = await httpFetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `${env ? `lx-music-${env}/${version}` : `lx-music-request/${version}`}`,
    },
    body: JSON.stringify({ source, rid: String(rid), level }),
  })
  const body = resp.body
  if (!body || typeof body !== 'object') throw new Error('response invalid')
  if (Number(body.code) !== 0) throw new Error(body.message || body.msg || `code ${body.code}`)
  const url = body.data && body.data.url
  if (!url || typeof url !== 'string') throw new Error('url missing')
  return url
}

const musicSources = {}
MUSIC_SOURCE.forEach(item => {
  musicSources[item] = {
    name: item,
    type: 'music',
    actions: ['musicUrl'],
    qualitys: MUSIC_QUALITY[item],
  }
})

on(EVENT_NAMES.request, ({ action, source, info }) => {
  switch (action) {
    case 'musicUrl':
      return handleGetMusicUrl(source, info.musicInfo, info.type)
        .then(data => Promise.resolve(data))
        .catch(err => Promise.reject(err))
    default:
      return Promise.reject('action not support')
  }
})
send(EVENT_NAMES.inited, { status: true, openDevTools: DEV_ENABLE, sources: musicSources })
