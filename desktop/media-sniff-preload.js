'use strict';
// 媒体嗅探窗口专用 preload：页内 JS 钩子经 IPC 回传，不依赖 console-message 签名差异。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__sfvSniff', {
  report(url, tag) {
    try {
      ipcRenderer.send('sfv-sniff-media', String(url || ''), String(tag || ''));
    } catch (e) {}
  }
});
