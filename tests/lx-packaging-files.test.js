// tests/lx-packaging-files.test.js — 根级模块必须落在打包白名单里
//
// 背景：build.files 是显式白名单（不是「除…之外全打包」），漏一个根级模块＝装好的包里
// server.js / desktop/main.js 的 require('./xxx') 直接 MODULE_NOT_FOUND，本地服务起不来。
// 批 T1–T7 新增的 lx-source-host.js / lx-search.js 就栽在这：源码树跑得通、
// verify-pack-requirements.js 也只查硬编码 11 项，缺口一路假绿到打包前。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function requiredRootModules() {
  const roots = new Set(
    fs.readdirSync(ROOT).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3))
  );
  const sources = [read('server.js')].concat(
    fs.readdirSync(path.join(ROOT, 'desktop'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => read(path.join('desktop', f)))
  );
  const found = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/require\(['"]\.\/([a-z0-9_-]+)['"]\)/gi)) {
      if (roots.has(m[1])) found.add(m[1] + '.js');
    }
  }
  return [...found].sort();
}

// 只承认「正向、非递归」条目作为覆盖依据：`desktop/**\/*` 之类管不到根级散文件。
function coveredBy(files, fileName) {
  return files.some((entry) => {
    if (typeof entry !== 'string' || entry.startsWith('!') || entry.includes('**')) return false;
    if (entry.includes('*')) {
      const re = new RegExp('^' + entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\w.-]*') + '$');
      return re.test(fileName);
    }
    return entry === fileName;
  });
}

test('① server/主进程 require 的每个根级模块都在 package.json 的 build.files 里', () => {
  const files = JSON.parse(read('package.json')).build.files;
  const missing = requiredRootModules().filter((name) => !coveredBy(files, name));
  assert.deepStrictEqual(missing, [], 'build.files 漏掉根级模块（打包后 require 即崩）: ' + missing.join(', '));
});

test('② 同一批根级模块也都在 internal-beta 构建的 files 里', () => {
  const files = JSON.parse(read('electron-builder.internal-beta.json')).files;
  const missing = requiredRootModules().filter((name) => !coveredBy(files, name));
  assert.deepStrictEqual(missing, [], 'beta 构建 files 漏掉根级模块: ' + missing.join(', '));
});

test('③ lx 引擎两模块被两份构建配置显式收录（防白名单再次漏登）', () => {
  const pkg = JSON.parse(read('package.json')).build.files;
  const beta = JSON.parse(read('electron-builder.internal-beta.json')).files;
  for (const name of ['lx-source-host.js', 'lx-search.js']) {
    assert.ok(coveredBy(pkg, name), 'package.json build.files 必须收录 ' + name);
    assert.ok(coveredBy(beta, name), 'beta files 必须收录 ' + name);
  }
});
