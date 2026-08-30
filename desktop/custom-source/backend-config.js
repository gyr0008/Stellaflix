// 第三方音源解析后端配置（用户自填的 musicserver 类端点）
//
// 合规边界：本模块不内置、不探测任何私有接口或代理服务；仅持久化用户显式提供的地址。
// 空串 backendUrl 表示「使用脚本内置默认地址」（青听公共后端 musicserver.haitangw.cc，可能已失效，
// 仅作向后兼容保留）。启用中的音源会在保存后自动重载运行时以加载新地址。

const fs = require('node:fs');
const path = require('node:path');

const MAX_URL_LEN = 2048;
const URL_RE = /^https?:\/\/[^\s]+$/i;

function configPath(userDataDir) {
  return path.join(userDataDir || '', 'custom-source-backend.json');
}

function isValidUrl(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_URL_LEN
    && URL_RE.test(value.trim());
}

function readBackendConfig(userDataDir) {
  const file = configPath(userDataDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    return { backendUrl: '' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { backendUrl: '' };
  }
  const backendUrl = parsed && typeof parsed === 'object' && typeof parsed.backendUrl === 'string'
    ? parsed.backendUrl
    : '';
  return { backendUrl: isValidUrl(backendUrl) ? backendUrl.trim() : '' };
}

function writeBackendConfig(userDataDir, patch) {
  const next = readBackendConfig(userDataDir);
  if (patch && typeof patch === 'object') {
    if (typeof patch.backendUrl === 'string') {
      const trimmed = patch.backendUrl.trim();
      if (trimmed && !isValidUrl(trimmed)) throw new Error('INVALID_BACKEND_URL');
      next.backendUrl = trimmed;
    }
  }
  const file = configPath(userDataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return { ...next };
}

module.exports = { readBackendConfig, writeBackendConfig, isValidUrl, MAX_URL_LEN };
