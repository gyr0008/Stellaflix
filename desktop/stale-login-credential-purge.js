'use strict';

// 公开分发口径：LX 世界观不再持有任何平台 cookie。此模块只在启动链里做一次性清理，
// 把旧版本落盘的明文凭证删掉；标记文件存在即跳过，force 供显式用户动作复用。

const fs = require('node:fs');
const path = require('node:path');

const STALE_LOGIN_CREDENTIAL_FILES = [
  '.cookie',
  '.qq-cookie',
  '.kugou-cookie',
  '.qishui-cookie',
  '.qishui-token',
  '.qishui-oauth.json',
  '.qishui-qr-identity.json',
  '.qishui-qr-login.json',
  '.spotify-token.json',
  '.spotify-credentials.json',
  '.kugou-vip-evidence.json',
];

function purgeStaleLoginCredentials(options) {
  const opts = options || {};
  const dirs = Array.isArray(opts.dirs) ? opts.dirs : [];
  const markerFile = opts.markerFile || '';
  const force = opts.force === true;
  if (!force && markerFile) {
    try {
      if (fs.existsSync(markerFile)) return { ok: true, skipped: true, removed: [] };
    } catch (_) { /* 标记不可读视为未清理 */ }
  }
  const removed = [];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of STALE_LOGIN_CREDENTIAL_FILES) {
      const file = path.join(dir, name);
      try {
        if (!fs.existsSync(file)) continue;
        fs.unlinkSync(file);
        removed.push(name);
      } catch (_) { /* 只读/占用：尽力而为，不阻塞启动 */ }
    }
  }
  if (markerFile) {
    try {
      fs.mkdirSync(path.dirname(markerFile), { recursive: true });
      fs.writeFileSync(markerFile, JSON.stringify({ purgedAt: new Date().toISOString(), removed }));
    } catch (_) { /* 标记写失败：下次启动再试 */ }
  }
  return { ok: true, skipped: false, removed };
}

module.exports = { STALE_LOGIN_CREDENTIAL_FILES, purgeStaleLoginCredentials };
