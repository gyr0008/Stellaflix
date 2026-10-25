'use strict';

// 批3-A：主进程 readAuthorizedLocalFileRange（标签解析器经 IPC 取字节范围）契约测试。
// 从真实 main.js 切出该函数在 vm 里跑（不复制实现），注入真实 fs/Buffer + 假授权器。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
const SLICE_START = 'async function readAuthorizedLocalFileRange(filePath, start, end) {';
const SLICE_END = "ipcMain.handle('stellaflix-local-file-read-range'";

function loadRangeSandbox(allowedRoot) {
  const start = MAIN.indexOf(SLICE_START);
  const end = MAIN.indexOf(SLICE_END);
  assert.ok(start >= 0 && end > start, 'readAuthorizedLocalFileRange 实现缺失或接缝错乱');
  const src = MAIN.slice(start, end);
  const context = {
    fs, Buffer, Math, Number, console,
    resolveAuthorizedLocalFile: (p) => {
      const t = path.resolve(String(p || ''));
      if (t !== allowedRoot && !t.startsWith(allowedRoot + path.sep)) {
        throw new Error('LOCAL_FILE_NOT_AUTHORIZED');
      }
      return t;
    },
  };
  vm.runInNewContext(`${src}\nthis.readRange = readAuthorizedLocalFileRange;`, context);
  return context;
}

function decodeChunks(res) {
  return Buffer.concat(res.base64Chunks.map((c) => Buffer.from(c, 'base64')));
}

test('整文件读取：base64 分块拼回与原字节一致', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-rr-'));
  const ctx = loadRangeSandbox(root);
  try {
    const file = path.join(root, 'a.bin');
    const bytes = Buffer.from('hello-local-range-reader-' + 'x'.repeat(100));
    fs.writeFileSync(file, bytes);
    const res = await ctx.readRange(file, 0, null);
    assert.equal(res.ok, true);
    assert.equal(res.size, bytes.length);
    assert.equal(res.byteLength, bytes.length);
    assert.ok(decodeChunks(res).equals(bytes), '整文件读回应与原字节一致');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('子范围读取 [start,end) 精确切片', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-rr-'));
  const ctx = loadRangeSandbox(root);
  try {
    const file = path.join(root, 'b.bin');
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i % 251));
    fs.writeFileSync(file, bytes);
    const res = await ctx.readRange(file, 10, 40);
    assert.equal(res.byteLength, 30, '应读 30 字节');
    assert.equal(res.start, 10);
    assert.ok(decodeChunks(res).equals(bytes.subarray(10, 40)), '子范围应精确');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('起止越界 clamp：start 超尾→空；end 超尾→夹到文件大小', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-rr-'));
  const ctx = loadRangeSandbox(root);
  try {
    const file = path.join(root, 'c.bin');
    const bytes = Buffer.from('clamp-me-please');
    fs.writeFileSync(file, bytes);

    const beyond = await ctx.readRange(file, bytes.length + 100, null);
    assert.equal(beyond.byteLength, 0, 'start 越过文件尾应为空');
    assert.equal(beyond.base64Chunks.length, 0, 'start 越过文件尾应无分块');

    const endClamped = await ctx.readRange(file, 0, bytes.length + 9999);
    assert.equal(endClamped.end, bytes.length, 'end 应被夹到文件大小');
    assert.ok(decodeChunks(endClamped).equals(bytes), '夹紧后仍应读全');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('超 768KB 范围分多块 base64，拼回一致', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-rr-'));
  const ctx = loadRangeSandbox(root);
  try {
    const file = path.join(root, 'big.bin');
    const bytes = Buffer.alloc(2 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) % 256;
    fs.writeFileSync(file, bytes);
    const res = await ctx.readRange(file, 0, null);
    assert.ok(res.base64Chunks.length > 1, '超 768KB 应分多块');
    assert.equal(res.byteLength, bytes.length);
    assert.ok(decodeChunks(res).equals(bytes), '多块拼回应与原字节一致');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('越权路径：授权器抛错，函数向上抛（handler 会转成 {ok:false}）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-rr-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-rr-out-'));
  const ctx = loadRangeSandbox(root);
  try {
    const file = path.join(outside, 'stranger.bin');
    fs.writeFileSync(file, 'x');
    await assert.rejects(() => ctx.readRange(file, 0, null), /LOCAL_FILE_NOT_AUTHORIZED/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
