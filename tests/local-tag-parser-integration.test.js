'use strict';

// 批3-A 集成验证：把 block2（11-local-track-map.js）+ block1（10-local-tag-parser.js）
// 按生产拼接顺序合进同一 vm 全局作用域，喂「路径型文件描述 + 假 desktopWindow.readLocalFileRange」，
// 走完整链路：block2.localFullPath → block1.readLocalFileBytesDirect → IPC 字节范围 → FLAC 解析。
// 目的：证明两块拆分后，block1 对 block2 的依赖（localFullPath/desktopLocalMusicApi）经拼接真实可解析，
// 且 block2.localSongKeyFromFile 产出与批2-B-2 扫描同构的 songKey。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BLOCK2 = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '11-local-track-map.js'), 'utf8');
const BLOCK1 = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '10-local-tag-parser.js'), 'utf8');

function u32le(value) { const o = Buffer.alloc(4); o.writeUInt32LE(value >>> 0, 0); return o; }
function buildFlacStreamInfo(sr, ch, bits, total) {
  const info = Buffer.alloc(34);
  info.writeUInt16BE(4096, 0); info.writeUInt16BE(4096, 2);
  info[10] = (sr >>> 12) & 0xff; info[11] = (sr >>> 4) & 0xff;
  info[12] = ((sr & 0x0f) << 4) | (((ch - 1) & 0x07) << 1) | (((bits - 1) >>> 4) & 0x01);
  info[13] = (((bits - 1) & 0x0f) << 4) | (Math.floor(total / 4294967296) & 0x0f);
  info.writeUInt32BE(total % 4294967296, 14);
  return info;
}
function flacBlockHeader(type, last, length) {
  return Buffer.from([(last ? 0x80 : 0) | (type & 0x7f), (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff]);
}
function flacBlock(type, last, body) { return Buffer.concat([flacBlockHeader(type, last, body.length), body]); }
function vorbis(items) {
  const v = Buffer.from('stellaflix-test', 'utf8');
  const parts = [u32le(v.length), v, u32le(items.length)];
  for (const it of items) { parts.push(u32le(it.length)); parts.push(it); }
  return Buffer.concat(parts);
}
function nativeFlac(items) {
  return Buffer.concat([Buffer.from('fLaC', 'ascii'), flacBlock(0, false, buildFlacStreamInfo(44100, 2, 16, 132300)), flacBlock(4, true, vorbis(items))]);
}

// 去掉两块的文档头 banner，只留真实代码（block1 头 12 行 / block2 头 11 行）。
function stripHeader(src) {
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].startsWith('//') || lines[i].trim() === '')) i += 1;
  return lines.slice(i).join('\n');
}

function loadIntegrated(flacBytes) {
  const requests = [];
  const fullPath = 'C:\\Music\\track.flac';
  const readLocalFileRange = (fp, start, end) => {
    requests.push({ fp, start, end });
    const from = Math.min(Math.max(0, start), flacBytes.length);
    const stop = end == null ? flacBytes.length : Math.min(flacBytes.length, end);
    const range = flacBytes.subarray(from, Math.max(from, stop));
    return Promise.resolve({ ok: true, base64Chunks: [range.toString('base64')], byteLength: range.length });
  };
  const context = {
    Array, Blob, Error, Intl, Math, Number, Object, Promise, String, TextDecoder, Uint8Array, atob,
    LOCAL_ASSET_LIGHT_SCAN_BYTES: 4 * 1024 * 1024,
    console: { warn: () => {} },
    // hydrateCustomCover 属 05-playback/01-cover-custom-map.js（生产拼接时在场），此隔离测试只装 block1+block2，打直通桩。
    hydrateCustomCover: (song) => song,
    window: { desktopWindow: { isDesktop: true, readLocalFileRange } },
  };
  // 生产拼接顺序：block2 先（定义 localFullPath/desktopLocalMusicApi），block1 后。
  vm.runInNewContext(
    stripHeader(BLOCK2) + '\n' + stripHeader(BLOCK1)
      + '\nthis.extractTags = extractLocalMetadataTags;'
      + '\nthis.songKeyFromFile = localSongKeyFromFile;'
      + '\nthis.makeSong = makeLocalSongFromFile;',
    context
  );
  return { context, requests, file: { name: 'track.flac', fullPath, size: flacBytes.length, url: 'http://127.0.0.1:3000/api/local-file?token=x' } };
}

test('block1+block2 拼接后：路径型文件经真实 localFullPath→IPC 范围读→FLAC 标签解析全链路通', async () => {
  const flac = nativeFlac([
    Buffer.from('TITLE=集成曲', 'utf8'),
    Buffer.from('ARTIST=集成艺人', 'utf8'),
    Buffer.from('ALBUM=集成专辑', 'utf8'),
  ]);
  const h = loadIntegrated(flac);
  const tags = await h.context.extractTags(h.file, {});
  assert.equal(tags.title, '集成曲');
  assert.equal(tags.artist, '集成艺人');
  assert.equal(tags.album, '集成专辑');
  // 确实经过了 IPC 范围读（block2.localFullPath + block1.readLocalFileBytesDirect 协作）。
  assert.ok(h.requests.length >= 1, '应经 readLocalFileRange 读到字节');
  assert.ok(h.requests.every((r) => r.fp === 'C:\\Music\\track.flac'), '读的应是由 block2.localFullPath 产出的绝对路径');
});

test('block2.localSongKeyFromFile 产出 绝对路径:大小:修改时间（与批2-B-2 扫描 songKey 同构）', () => {
  const h = loadIntegrated(nativeFlac([Buffer.from('ARTIST=x', 'utf8')]));
  const key = h.context.songKeyFromFile({ name: 'track.flac', fullPath: 'C:\\Music\\track.flac', size: 1234, lastModified: 5678 });
  assert.equal(key, 'C:\\Music\\track.flac:1234:5678', 'songKey 应为 绝对路径:大小:修改时间');
});

test('block2.makeLocalSongFromFile 组装曲目对象（localKey/localFile/url 齐备）', () => {
  const h = loadIntegrated(nativeFlac([Buffer.from('ARTIST=x', 'utf8')]));
  const song = h.context.makeSong({ name: 'track.flac', fullPath: 'C:\\Music\\track.flac', size: 10, lastModified: 20, url: 'http://127.0.0.1:3000/api/local-file?token=x' }, null, null, []);
  assert.ok(song && typeof song === 'object', '应产出曲目对象');
  assert.equal(song.type, 'local', '应标记为 local');
  assert.equal(song.localFileUrl, 'http://127.0.0.1:3000/api/local-file?token=x', '播放 url 应取自 file.url（落 localFileUrl）');
  assert.ok(song.localKey, '应生成 localKey');
  assert.equal(song.localFormat, 'FLAC', 'localFormat 应由 localAudioFormatLabel 给出');
});
