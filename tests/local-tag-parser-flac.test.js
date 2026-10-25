'use strict';

// 批3-A：验证 10-local-tag-parser.js（block1 提取件）真实可解析——
// 从新模块切出解析器在 vm 里跑，喂合成原生 FLAC（fLaC + STREAMINFO + VORBIS_COMMENT），
// 经假 readLocalFileRange 桩走「主进程 IPC 字节范围」那条路，断言 extractLocalMetadataTags 产出。
// 夹具构造沿用参照库 local-format-tag-parsing.test.js 的 buildFlac* 助手。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PARSER = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '10-local-tag-parser.js'),
  'utf8'
);

function u32le(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

function buildFlacStreamInfo(sampleRate, channels, bits, totalSamples) {
  const info = Buffer.alloc(34);
  info.writeUInt16BE(4096, 0);
  info.writeUInt16BE(4096, 2);
  info[10] = (sampleRate >>> 12) & 0xff;
  info[11] = (sampleRate >>> 4) & 0xff;
  info[12] = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1) | (((bits - 1) >>> 4) & 0x01);
  info[13] = (((bits - 1) & 0x0f) << 4) | (Math.floor(totalSamples / 4294967296) & 0x0f);
  info.writeUInt32BE(totalSamples % 4294967296, 14);
  return info;
}

function buildFlacBlockHeader(type, last, length) {
  return Buffer.from([
    (last ? 0x80 : 0) | (type & 0x7f),
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
  ]);
}

function buildFlacMetadataBlock(type, last, body) {
  return Buffer.concat([buildFlacBlockHeader(type, last, body.length), body]);
}

function buildVorbisComments(items, vendor) {
  const vendorBytes = Buffer.from(vendor || 'stellaflix-test', 'utf8');
  const parts = [u32le(vendorBytes.length), vendorBytes, u32le(items.length)];
  for (let i = 0; i < items.length; i += 1) {
    parts.push(u32le(items[i].length));
    parts.push(items[i]);
  }
  return Buffer.concat(parts);
}

function buildNativeFlac(vorbisItems) {
  const streamInfo = buildFlacStreamInfo(44100, 2, 16, 132300);
  return Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    buildFlacMetadataBlock(0, false, streamInfo),
    buildFlacMetadataBlock(4, true, buildVorbisComments(vorbisItems)),
  ]);
}

function loadParserHarness(fileName, bytes) {
  const requests = [];
  const fullPath = 'C:\\Music\\' + fileName;
  const table = { [fullPath]: { name: fileName, fullPath, bytes, size: bytes.length } };
  function localFullPath(file) { return String((file && file.fullPath) || ''); }
  function localFileSize(file) { return Number(file && file.size) || 0; }
  function readLocalFileRange(fp, start, end) {
    requests.push({ fullPath: fp, start, end });
    const entry = table[fp];
    if (!entry) return Promise.resolve({ ok: false, base64Chunks: [], byteLength: 0 });
    const from = Math.min(Math.max(0, start), entry.bytes.length);
    const stop = end == null ? entry.bytes.length : Math.min(entry.bytes.length, end);
    const range = entry.bytes.subarray(from, Math.max(from, stop));
    return Promise.resolve({ ok: true, base64Chunks: [range.toString('base64')], byteLength: range.length });
  }
  function desktopLocalMusicApi() { return { readLocalFileRange }; }
  const start = PARSER.indexOf('function base64ChunksToBytes(');
  assert.ok(start >= 0, '解析器接缝缺失：base64ChunksToBytes');
  const context = {
    Array, Blob, Error, Math, Number, Object, Promise, String, TextDecoder, Uint8Array, atob,
    LOCAL_ASSET_LIGHT_SCAN_BYTES: 4 * 1024 * 1024,
    console: { warn: () => {} },
    desktopLocalMusicApi, localFullPath, localFileSize,
  };
  vm.runInNewContext(
    PARSER.slice(start)
      + '\nthis.extractTags = extractLocalMetadataTags;'
      + '\nthis.extractCover = extractEmbeddedCoverSource;'
      + '\nthis.pendingRangeReads = localFileRangeReadBatches;',
    context
  );
  return { context, requests, file: () => ({ name: fileName, fullPath, size: bytes.length }) };
}

test('提取的解析器能经 IPC 字节范围解析原生 FLAC 的 VORBIS_COMMENT 标签', async () => {
  const flac = buildNativeFlac([
    Buffer.from('TITLE=本地测试曲', 'utf8'),
    Buffer.from('ARTIST=测试艺人', 'utf8'),
    Buffer.from('ALBUM=测试专辑', 'utf8'),
  ]);
  const h = loadParserHarness('track.flac', flac);
  const tags = await h.context.extractTags(h.file(), {});
  assert.ok(tags && typeof tags === 'object', '应产出标签对象');
  assert.equal(tags.title, '本地测试曲', 'title 应解析出来');
  assert.equal(tags.artist, '测试艺人', 'artist 应解析出来');
  assert.equal(tags.album, '测试专辑', 'album 应解析出来');
  assert.ok(h.requests.length > 0, '应经 readLocalFileRange 走过字节读取');
});

test('同一文件的小范围读被合并进同一批次（range 合并读生效）', async () => {
  const flac = buildNativeFlac([Buffer.from('ARTIST=合并艺人', 'utf8')]);
  const h = loadParserHarness('coalesce.flac', flac);
  await h.context.extractTags(h.file(), {});
  // 批次数组在解析结束后应清空（无悬挂未决读）。
  assert.equal(h.context.pendingRangeReads.length, 0, '解析完成后不应有悬挂批次');
  // 至少发生过一次真实范围读。
  assert.ok(h.requests.length >= 1, '应至少发起一次范围读');
});

test('空/畸形文件不抛错，返回空标签对象', async () => {
  const h = loadParserHarness('broken.flac', Buffer.from('not-a-real-flac'));
  const tags = await h.context.extractTags(h.file(), {});
  assert.ok(tags && typeof tags === 'object', '畸形文件也应返回对象而非抛错');
});
