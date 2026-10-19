/*
 * drpy-rules-repo.js — 外挂规则仓库同步（批 3 · 新文件）
 *
 * 协议（manifest v1）：仓库 = 任意静态托管（GitHub raw / 自建 NAS），根下放：
 *   manifest.json:
 *   {
 *     "manifest_version": 1,
 *     "version": "2026.10.19-1",
 *     "updated_at": "2026-10-19T22:00:00Z",
 *     "rules": [
 *       { "name": "示例源", "file": "示例源.js", "sha256": "<hex>", "size": 1234 }
 *     ]
 *   }
 *   <file> 与 manifest.json 同目录。
 *
 * 同步语义：
 *   - 全量对账：manifest 是「托管文件」的唯一事实源
 *   - sha256 逐条校验，任一不符 → 整体放弃（本次零写入 = 自动回滚到旧规则集）
 *   - 原子落盘：先写 staging 目录，全部就绪后一次性替换进 rules/js/
 *   - 托管台账 .drpy-sync-managed.json 记录本次管理的文件；上次托管但本次
 *     manifest 不再包含的文件会被移除；非托管文件（用户手放的）永不触碰
 *   - drpyS 对 rules/js 有监听，替换后热加载自动生效（批 1 实测）
 *
 * 安全：
 *   - repoUrl 仅接受 http(s)；file 名取 basename，拒绝路径穿越
 *   - 出厂仓库地址为空：Stellaflix 不内置、不推荐任何规则仓库（合规红线）
 */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FETCH_TIMEOUT_MS = 15 * 1000;
const LEDGER_NAME = '.drpy-sync-managed.json';

function _get(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, {timeout: timeoutMs || FETCH_TIMEOUT_MS}, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        _get(next, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP_' + res.statusCode + ' ' + url));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + url)); });
    req.on('error', reject);
  });
}

function _sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 安全化规则文件名：仅允许 basename + .js 后缀，拒绝穿越。
 */
function safeRuleFileName(file) {
  const base = path.basename(String(file == null ? '' : file).trim());
  if (!base || base.startsWith('.') || !base.endsWith('.js')) return null;
  if (base.includes('/') || base.includes('\\')) return null; // basename 后不应再含分隔符
  if (base === LEDGER_NAME) return null;
  return base;
}

/**
 * 同步外挂规则仓库到 rules/js。
 * @param {string} repoUrl 仓库根（manifest.json 所在目录）
 * @param {string} rulesJsDir drpy-lite 的 rules/js 绝对路径
 * @param {object} [opts] {timeoutMs}
 * @returns {Promise<{ok:boolean, version?:string, added:number, updated:number, removed:number, reason?:string|null}>}
 */
async function syncRules(repoUrl, rulesJsDir, opts) {
  const out = {ok: false, added: 0, updated: 0, removed: 0, reason: null};
  const root = String(repoUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(root)) {
    out.reason = 'repoUrl 必须是 http(s) 地址';
    return out;
  }
  if (!fs.existsSync(rulesJsDir)) {
    out.reason = 'rules 目录不存在: ' + rulesJsDir;
    return out;
  }

  // 1) 拉取并解析 manifest
  let manifest;
  try {
    const raw = await _get(root + '/manifest.json', opts && opts.timeoutMs);
    manifest = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    out.reason = 'manifest 拉取/解析失败: ' + e.message;
    return out;
  }
  if (!manifest || manifest.manifest_version !== 1 || !Array.isArray(manifest.rules)) {
    out.reason = 'manifest 格式非法（需要 manifest_version=1 与 rules 数组）';
    return out;
  }

  // 2) 拉取全部规则文件并校验 sha256 —— 任一失败即整体放弃（零写入 = 回滚）
  const wanted = new Map(); // file -> {content, sha256, name}
  for (const r of manifest.rules) {
    const file = safeRuleFileName(r && r.file);
    if (!file) {
      out.reason = '非法规则文件名: ' + JSON.stringify(r && r.file);
      return out;
    }
    const expect = String((r && r.sha256) || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expect)) {
      out.reason = 'sha256 缺失或格式非法: ' + file;
      return out;
    }
    let buf;
    try {
      buf = await _get(root + '/' + encodeURIComponent(file), opts && opts.timeoutMs);
    } catch (e) {
      out.reason = '规则拉取失败: ' + file + ' — ' + e.message;
      return out;
    }
    const actual = _sha256(buf);
    if (actual !== expect) {
      out.reason = 'sha256 不符（疑似篡改/传输损坏）: ' + file;
      return out;
    }
    wanted.set(file, {content: buf, sha256: actual, name: String((r && r.name) || file)});
  }

  // 3) 托管台账：上次同步管理的文件
  const ledgerPath = path.join(rulesJsDir, LEDGER_NAME);
  let managed = [];
  try {
    managed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (!Array.isArray(managed)) managed = [];
  } catch (e) { /* 首次同步 */ }

  // 4) staging 原子落盘
  const staging = path.join(rulesJsDir, '.staging-' + Date.now());
  try {
    fs.mkdirSync(staging, {recursive: true});
    for (const [file, item] of wanted) {
      fs.writeFileSync(path.join(staging, file), item.content);
    }
  } catch (e) {
    try { fs.rmSync(staging, {recursive: true, force: true}); } catch (_) {}
    out.reason = 'staging 写入失败: ' + e.message;
    return out;
  }

  // 5) 替换进 rules/js + 更新台账 + 移除不再托管的旧文件
  try {
    for (const [file, item] of wanted) {
      const dest = path.join(rulesJsDir, file);
      const isNew = !fs.existsSync(dest);
      const oldSha = (() => {
        try { return _sha256(fs.readFileSync(dest)); } catch (e) { return null; }
      })();
      if (oldSha === item.sha256) {
        // 内容相同：跳过（避免触发无谓的热加载）
      } else if (isNew) {
        out.added += 1;
      } else {
        out.updated += 1;
      }
      if (oldSha !== item.sha256) {
        fs.copyFileSync(path.join(staging, file), dest);
      }
    }
    for (const old of managed) {
      if (!wanted.has(old)) {
        const p = path.join(rulesJsDir, old);
        try { fs.rmSync(p, {force: true}); out.removed += 1; } catch (_) {}
      }
    }
    fs.writeFileSync(ledgerPath, JSON.stringify([...wanted.keys()], null, 2));
  } catch (e) {
    out.reason = '落盘失败: ' + e.message;
    return out;
  } finally {
    try { fs.rmSync(staging, {recursive: true, force: true}); } catch (_) {}
  }

  out.ok = true;
  out.version = String(manifest.version || '');
  return out;
}

module.exports = {syncRules, safeRuleFileName, _sha256};
