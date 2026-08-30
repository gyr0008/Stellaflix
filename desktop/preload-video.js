'use strict';

/**
 * Stellaflare 影视态 — 渲染进程桥接 (preload-video.js)
 * ----------------------------------------------------------------------------
 * 通过 Electron contextBridge 把视频模块能力暴露给渲染进程（public/video/*.js），
 * 遵循项目已有的 desktopWindow 风格：每个能力 = 一个 invoke / on* 函数对。
 *
 * API 命名空间：window.stellaflixVideo
 *   - player.*            ：mpv 播放器生命周期（create / destroy / command / seek）
 *   - player.on*          ：播放器事件订阅
 *   - protocol.resolve*   ：各协议解析（Emby / Alist / Aliyun / WebDAV）
 *   - download.*          ：qBittorrent 任务管理
 *   - ffmpeg.*            ：ffprobe 元数据探测
 *
 * 设计原则：
 *   - 只暴露"安全白名单"操作，绝不暴露 shell / fs / child_process
 *   - 路径由主进程解析，渲染进程拿不到 __appData__ 等绝对路径
 *   - 与音乐态 window.desktopWindow 共存，零交叉
 */

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
  // 播放器
  mpvCreate: 'stellaflix-video:mpv-create',
  mpvDestroy: 'stellaflix-video:mpv-destroy',
  mpvCommand: 'stellaflix-video:mpv-command',
  mpvGetProperty: 'stellaflix-video:mpv-get-property',
  mpvSetProperty: 'stellaflix-video:mpv-set-property',
  mpvSeek: 'stellaflix-video:mpv-seek',
  mpvStopClean: 'stellaflix-video:mpv-stop-clean',
  mpvList: 'stellaflix-video:mpv-list',
  mpvEvent: 'stellaflix-video:mpv-event',
  // 协议
  protocolResolveEmby: 'stellaflix-video:protocol-resolve-emby',
  protocolResolveAlist: 'stellaflix-video:protocol-resolve-alist',
  protocolResolveAliyun: 'stellaflix-video:protocol-resolve-aliyun',
  protocolResolveWebdav: 'stellaflix-video:protocol-resolve-webdav',
  // 下载
  qbtAdd: 'stellaflix-video:qbt-add',
  qbtList: 'stellaflix-video:qbt-list',
  qbtFiles: 'stellaflix-video:qbt-files',
  qbtDelete: 'stellaflix-video:qbt-delete',
  qbtProgress: 'stellaflix-video:qbt-progress',
  // ffmpeg
  ffprobeProbe: 'stellaflix-video:ffprobe-probe',
};

const player = {
  create: (opts) => ipcRenderer.invoke(CHANNELS.mpvCreate, opts || {}),
  destroy: (id) => ipcRenderer.invoke(CHANNELS.mpvDestroy, id),
  command: (id, cmdArr) => ipcRenderer.invoke(CHANNELS.mpvCommand, { id, cmd: cmdArr }),
  getProperty: (id, name) => ipcRenderer.invoke(CHANNELS.mpvGetProperty, { id, name }),
  setProperty: (id, name, value) => ipcRenderer.invoke(CHANNELS.mpvSetProperty, { id, name, value }),
  seek: (id, sec) => ipcRenderer.invoke(CHANNELS.mpvSeek, { id, sec }),
  stopAndClean: (id) => ipcRenderer.invoke(CHANNELS.mpvStopClean, id),
  list: () => ipcRenderer.invoke(CHANNELS.mpvList),
  createOverlay: (opts) => ipcRenderer.invoke('stellaflix-video:mpv-overlay-create', opts || {}),
  destroyOverlay: (playerId) => ipcRenderer.invoke('stellaflix-video:mpv-overlay-destroy', playerId),
  onEvent: (playerId, event, cb) => {
    if (typeof cb !== 'function') return () => {};
    const ch = CHANNELS.mpvEvent + ':' + playerId + ':' + event;
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  },
  onAllEvents: (playerId, cb) => player.onEvent(playerId, '*', cb),
};

const protocol = {
  resolveEmby: (url, creds) => ipcRenderer.invoke(CHANNELS.protocolResolveEmby, { url, creds }),
  resolveAlist: (url, token) => ipcRenderer.invoke(CHANNELS.protocolResolveAlist, { url, token }),
  resolveAliyun: (fileId, driveId, refreshToken) => ipcRenderer.invoke(CHANNELS.protocolResolveAliyun, { fileId, driveId, refreshToken }),
  resolveWebdav: (url, creds) => ipcRenderer.invoke(CHANNELS.protocolResolveWebdav, { url, creds }),
};

const download = {
  addTorrent: (opts) => ipcRenderer.invoke(CHANNELS.qbtAdd, opts || {}),
  list: (filter) => ipcRenderer.invoke(CHANNELS.qbtList, filter),
  files: (hash) => ipcRenderer.invoke(CHANNELS.qbtFiles, hash),
  delete: (hash, deleteFiles) => ipcRenderer.invoke(CHANNELS.qbtDelete, { hash, deleteFiles }),
  progress: (hash) => ipcRenderer.invoke(CHANNELS.qbtProgress, hash),
};

const ffmpeg = {
  probe: (input) => ipcRenderer.invoke(CHANNELS.ffprobeProbe, { input }),
};

contextBridge.exposeInMainWorld('stellaflixVideo', {
  player, protocol, download, ffmpeg,
});
