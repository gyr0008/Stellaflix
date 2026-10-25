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
 *       { "name": "示例源", "file": "示例源.js", "sha256": "<hex>", "size": 1234,
 *         "desc": "这条规则的说明文案（可选，desc/description/comment 任一）" }
 *     ]
 *   }
 *   <file> 与 manifest.json 同目录。顶层可选 "description" 作仓库级文案。
 *
 * 两个入口：
 *   - previewRules(repoUrl)  只读：只拉 manifest，列出规则名 + 文案 + 大小/sha256，不拉正文、零写入。
 *     校验与 syncRules 共用 _loadManifest ⇒ 预览通过就不会在下载时才因清单格式失败。
 *   - syncRules(repoUrl, dir) 下载：实时抓取仓库并原子替换 rules/js。
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
const MAX_REDIRECTS = 5;
// 规则是给人读的 js，正常几十 KB；设硬上限防「仓库一个 500MB 文件」把宿主内存吃光
const MAX_BYTES = 4 * 1024 * 1024;

function _get(url, timeoutMs, _hops) {
  const hops = _hops || 0;
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { reject(new Error('bad-url ' + url)); return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('unsupported-scheme ' + parsed.protocol));
      return;
    }
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(url, {timeout: timeoutMs || FETCH_TIMEOUT_MS}, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) {
          reject(new Error('redirect-loop ' + url));
          return;
        }
        let next;
        try {
          next = new URL(res.headers.location, url);
        } catch (e) {
          reject(new Error('bad-redirect-location ' + res.headers.location));
          return;
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          reject(new Error('redirect-to-' + next.protocol));
          return;
        }
        _get(next.href, timeoutMs, hops + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP_' + res.statusCode + ' ' + url));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_BYTES) {
          req.destroy();
          reject(new Error('too-large ' + url + ' >' + MAX_BYTES + 'B'));
          return;
        }
        chunks.push(c);
      });
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

/** 仓库根归一：去尾斜杠，只允许 http(s)。非法返回 null。 */
function _repoRoot(repoUrl) {
  const root = String(repoUrl || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(root) ? root : null;
}

/**
 * 拉取 + 校验 manifest（syncRules 与 previewRules 共用 = 预览通过即下载不会因清单再失败）。
 * @returns {Promise<{ok:boolean, rules:Array<{name,file,sha256,size,desc}>, version:string, description:string, reason:string|null}>}
 */
async function _loadManifest(root, opts) {
  const out = {ok: false, rules: [], version: '', description: '', reason: null};
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
    out.rules.push({
      name: String((r && r.name) || file),
      file,
      sha256: expect,
      size: Number(r && r.size) || 0,
      // 文案由仓库自备（可选字段）；程序不代写任何规则说明
      desc: String((r && (r.desc || r.description || r.comment)) || ''),
    });
  }
  out.ok = true;
  out.version = String(manifest.version || '');
  out.description = String(manifest.description || manifest.desc || '');
  return out;
}

/**
 * 只读预览外挂规则仓库：列清单 + 每条文案，不拉正文、不写盘。
 * 用途 = 用户在点「下载规则」之前先在页面上看清仓库里有什么。
 * @param {string} repoUrl 仓库根（manifest.json 所在目录）
 * @param {object} [opts] {timeoutMs}
 * @returns {Promise<{ok:boolean, version?:string, description?:string, rules?:Array, reason?:string|null}>}
 */
async function previewRules(repoUrl, opts) {
  const out = {ok: false, version: '', description: '', rules: [], reason: null};
  const root = _repoRoot(repoUrl);
  if (!root) {
    out.reason = 'repoUrl 必须是 http(s) 地址';
    return out;
  }
  const loaded = await _loadManifest(root, opts);
  if (!loaded.ok) {
    out.reason = loaded.reason;
    return out;
  }
  out.ok = true;
  out.version = loaded.version;
  out.description = loaded.description;
  out.rules = loaded.rules;
  return out;
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
  const root = _repoRoot(repoUrl);
  if (!root) {
    out.reason = 'repoUrl 必须是 http(s) 地址';
    return out;
  }
  if (!fs.existsSync(rulesJsDir)) {
    out.reason = 'rules 目录不存在: ' + rulesJsDir;
    return out;
  }

  // 1) 拉取并校验 manifest（文件名/sha256 合法性在这里一次过完）
  const loaded = await _loadManifest(root, opts);
  if (!loaded.ok) {
    out.reason = loaded.reason;
    return out;
  }

  // 2) 拉取全部规则文件并校验 sha256 —— 任一失败即整体放弃（零写入 = 回滚）
  const wanted = new Map(); // file -> {content, sha256, name}
  for (const item of loaded.rules) {
    let buf;
    try {
      buf = await _get(root + '/' + encodeURIComponent(item.file), opts && opts.timeoutMs);
    } catch (e) {
      out.reason = '规则拉取失败: ' + item.file + ' — ' + e.message;
      return out;
    }
    const actual = _sha256(buf);
    if (actual !== item.sha256) {
      out.reason = 'sha256 不符（疑似篡改/传输损坏）: ' + item.file;
      return out;
    }
    wanted.set(item.file, {content: buf, sha256: actual, name: item.name});
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
  out.version = loaded.version;
  return out;
}

module.exports = {syncRules, previewRules, safeRuleFileName, _sha256};
