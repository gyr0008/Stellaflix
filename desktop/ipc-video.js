'use strict';

/**
 * Stellaflare 影视态 — 主进程 IPC 集中处理器 (ipc-video.js)
 * ----------------------------------------------------------------------------
 * 注册所有 stellaflix-video:* 的 IPC 通道，把 invoke 派发到 mpv-controller /
 * download-manager / ffprobe / protocol-adapters。
 *
 * 与现有 main.js 的关系：
 *   - main.js 保留音乐态的所有 handler 不动
 *   - ipc-video.js 在 main.js 启动时由 initIpc() 注册到同一 ipcMain 实例
 *   - 二者职责清晰：音乐态 handler 在 main.js，影视态 handler 在本文件
 *
 * 加载顺序：main.js → require('./ipc-video') → initIpc()
 */

const { ipcMain } = require('electron');
const mpvCtrl = require('./mpv-controller');
const download = require('./download-manager');
const ffprobe = require('./ffprobe');
const videoConfig = require('./video-config');
const protocolAdapters = require('./protocol-adapters');

let _log = () => {};

function initIpc() {
  const cfg = videoConfig.get();
  mpvCtrl.setConfig(cfg);
  download.setConfig(cfg);
  ffprobe.setConfig(cfg);
  if (cfg.mpv && cfg.mpv.enableLogging) _log = (...a) => console.log('[video-ipc]', ...a);

  // ---- 播放器 ----
  ipcMain.handle('stellaflix-video:mpv-create', async (_e, opts) => {
    try { const r = await mpvCtrl.createPlayer(opts); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:mpv-destroy', async (_e, id) => {
    try { const r = await mpvCtrl.destroyPlayer(id); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:mpv-command', async (_e, { id, cmd }) => {
    try { const r = await mpvCtrl.command(id, cmd); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:mpv-get-property', async (_e, { id, name }) => {
    try { const r = await mpvCtrl.getProperty(id, name); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:mpv-set-property', async (_e, { id, name, value }) => {
    try { const r = await mpvCtrl.setProperty(id, name, value); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:mpv-seek', async (_e, { id, sec }) => {
    try { const r = await mpvCtrl.seek(id, sec); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:mpv-stop-clean', async (_e, id) => {
    try { const r = await mpvCtrl.stopAndClean(id); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:mpv-list', async () => {
    return { ok: true, data: mpvCtrl.listPlayers() };
  });
  ipcMain.handle('stellaflix-video:mpv-overlay-create', async (_e, opts) => {
    try { const r = await mpvCtrl.createOverlay(opts); return r; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:mpv-overlay-destroy', async (_e, playerId) => {
    try { const r = await mpvCtrl.destroyOverlay(playerId); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  // 事件派发：主进程 mpv event → 推送到渲染进程
  mpvCtrl._broadcast = (playerId, event, payload) => {
    let BrowserWindow;
    try { BrowserWindow = require('electron').BrowserWindow; } catch (e) { return; }
    const ch = 'stellaflix-video:mpv-event:' + playerId + ':' + event;
    BrowserWindow.getAllWindows().forEach(w => {
      try { w.webContents.send(ch, payload); } catch (e) {}
    });
  };

  // ---- 协议 ----
  ipcMain.handle('stellaflix-video:protocol-resolve-emby', async (_e, { url, creds }) => {
    try { const r = await protocolAdapters.emby.resolve(url, creds); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:protocol-resolve-alist', async (_e, { url, token }) => {
    try { const r = await protocolAdapters.alist.resolve(url, token); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:protocol-resolve-aliyun', async (_e, { fileId, driveId, refreshToken }) => {
    try { const r = await protocolAdapters.aliyun.resolve(fileId, driveId, refreshToken); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:protocol-resolve-webdav', async (_e, { url, creds }) => {
    try { const r = await protocolAdapters.webdav.resolve(url, creds); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // ---- 下载 ----
  ipcMain.handle('stellaflix-video:qbt-add', async (_e, opts) => {
    try {
      await download.start();
      const r = await download.addTorrent(opts);
      return { ok: true, data: r };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:qbt-list', async (_e, filter) => {
    try { const r = await download.listTorrents(filter); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:qbt-files', async (_e, hash) => {
    try { const r = await download.getTorrentFiles(hash); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:qbt-delete', async (_e, { hash, deleteFiles }) => {
    try { const r = await download.deleteTorrent(hash, deleteFiles); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stellaflix-video:qbt-progress', async (_e, hash) => {
    try { const r = await download.getProgress(hash); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // ---- ffmpeg ----
  ipcMain.handle('stellaflix-video:ffprobe-probe', async (_e, { input }) => {
    try { const r = await ffprobe.probe(input); return { ok: true, data: r }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  _log('video IPC handlers registered');
}

module.exports = { initIpc };
