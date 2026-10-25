'use strict';

/**
 * tests/quality-preference-normalize.test.js — server 侧音质词汇归一（T15 审查追加钉桩）
 *
 * server.js 的 normalizeQualityPreference 服务**保留**的网易云/QQ 兼容链
 * （vkey 候选模板、推荐候选），不是 lx 五档链路（前端 00-api-quality-output.js 归 T12 管）。
 * 本文件锁死其别名表——尤其 T15 审查指出的缺口：LX 词汇 flac24bit 必须归 hires，
 * 否则音源脚本回传的 24bit 档在候选梯队里退化成默认。
 *
 * 取函数源码在 vm 内单跑（与 tests/radio-modes.test.js 的 namedFunctionSource 同款口径），
 * 不起服务端进程。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!declaration) throw new Error(`MISSING_FUNCTION:${name}`);
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.index, index + 1);
    }
  }
  throw new Error(`UNBALANCED_FUNCTION:${name}`);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  namedFunctionSource(serverSrc, 'normalizeQualityPreference') + '\nthis.normalize = normalizeQualityPreference;',
  sandbox
);
const normalize = sandbox.normalize;

test('LX 词汇 flac24bit 归 hires（T15 审查追加：24bit FLAC 属最高解析档）', () => {
  assert.equal(normalize('flac24bit'), 'hires');
  assert.equal(normalize('FLAC24BIT'), 'hires');
});

test('旧平台词汇别名表逐档锁死', () => {
  for (const v of ['jymaster', 'master', 'studio', 'svip']) assert.equal(normalize(v), 'jymaster', v);
  for (const v of ['hires', 'hi-res', 'highres', 'zhenyin', 'spatial']) assert.equal(normalize(v), 'hires', v);
  for (const v of ['lossless', 'flac', 'sq']) assert.equal(normalize(v), 'lossless', v);
  for (const v of ['exhigh', 'high', '320', '320k', 'hq']) assert.equal(normalize(v), 'exhigh', v);
  for (const v of ['standard', 'normal', '128', '128k', 'std']) assert.equal(normalize(v), 'standard', v);
});

test('空值/未知词落 hires（保留链默认=最高解析档，不静默降质）', () => {
  assert.equal(normalize(''), 'hires');
  assert.equal(normalize(null), 'hires');
  assert.equal(normalize('nonsense'), 'hires');
});
