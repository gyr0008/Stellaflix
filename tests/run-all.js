'use strict';

/**
 * tests/run-all.js — 全量测试入口（npm test）
 * 逐文件串行执行 tests/*.test.js，单文件超时保护（部分 e2e 会起本地 server），
 * 结束打印汇总并以 0/1 退出。CI 与本地通用。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TESTS_DIR = __dirname;
const PER_FILE_TIMEOUT_MS = 90 * 1000;

const files = fs.readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join(TESTS_DIR, f))
  .sort();

if (files.length === 0) {
  console.error('no test files found in ' + TESTS_DIR);
  process.exit(1);
}

function runOne(file) {
  return new Promise((resolve) => {
    const name = path.basename(file);
    const child = spawn(process.execPath, [file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { CI: '1' }),
    });

    let out = '';
    const keep = (chunk) => { out += chunk.toString('utf8'); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({ name, ok: false, timedOut: true, detail: out });
    }, PER_FILE_TIMEOUT_MS);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ name, ok: code === 0, timedOut: false, code, detail: out });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ name, ok: false, timedOut: false, detail: String(err) });
    });
  });
}

(async () => {
  const results = [];
  for (const f of files) {
    process.stdout.write('▶ ' + path.basename(f) + ' ... ');
    const r = await runOne(f);
    if (r.ok) {
      console.log('PASS');
    } else {
      console.log(r.timedOut ? 'FAIL (timeout ' + (PER_FILE_TIMEOUT_MS / 1000) + 's)' : 'FAIL (exit ' + r.code + ')');
    }
    results.push(r);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n========== 汇总 ==========');
  console.log('通过 ' + (results.length - failed.length) + ' / 总 ' + results.length +
    (failed.length ? '，失败 ' + failed.length : '，全部通过'));

  if (failed.length) {
    console.log('\n失败清单与输出摘录：');
    for (const r of failed) {
      console.log('\n---- ' + r.name + ' ----');
      const tail = (r.detail || '').split('\n').filter(Boolean).slice(-12).join('\n');
      console.log(tail || '(无输出)');
    }
    process.exit(1);
  }
  process.exit(0);
})();
