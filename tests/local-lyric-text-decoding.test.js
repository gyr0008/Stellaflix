'use strict';

// 04-shelf/10+11 的文本/歌词解码链回归守卫。
// 这批函数在参照库里是连续一段（public/app.js L33376-33827），移植时被 block1/block2
// 的分界整段跳过，留下 decodeLocalTextBuffer / readLocalLyricText 调用未定义符号。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

function read(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8'); }
function stripHeader(src) {
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].startsWith('//') || lines[i].trim() === '')) i += 1;
  return lines.slice(i).join('\n');
}

function boot() {
  const store = new Map();
  const context = {
    Array, ArrayBuffer, Blob, Buffer, Error, Intl, JSON, Math, Number, Object, Promise, String,
    Uint8Array, Int32Array, TextDecoder, URL, atob, btoa, Response, DecompressionStream,
    console: { warn: () => {}, log: () => {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    hydrateCustomCover: (song) => song,
    songCustomLyricKey: (song) => (song && song.name ? 'key:' + song.name : ''),
    LOCAL_LYRIC_PICK_STORE_KEY: 'stellaflix-local-lyric-picks-v1',
    localLyricPicks: {},
    localLyricPicksHydrated: false,
    window: { TextDecoder },
  };
  vm.runInNewContext(
    stripHeader(read('public/js/modules/04-shelf/11-local-track-map.js')) + '\n'
    + stripHeader(read('public/js/modules/04-shelf/10-local-tag-parser.js')),
    context
  );
  return context;
}

// 「世界和平」的 GB18030 落盘字节；这段字节不是合法 UTF-8，也不含 BOM。
const GB18030_BYTES = Buffer.concat([
  Buffer.from('[00:01.00]', 'ascii'),
  Buffer.from([0xca, 0xc0, 0xbd, 0xe7, 0xba, 0xcd, 0xc6, 0xbd]),
]);

test('decodeLocalTextBuffer：非 UTF-8 简体中文落到 gb18030', () => {
  const ctx = boot();
  assert.equal(ctx.decodeLocalTextBuffer(new Uint8Array(GB18030_BYTES)), '[00:01.00]世界和平');
});

test('decodeLocalTextBuffer：合法 UTF-8 原样返回，不被候选编码改写', () => {
  const ctx = boot();
  const text = '[00:01.00]我爱音乐\n[00:05.00]第二句';
  assert.equal(ctx.decodeLocalTextBuffer(new Uint8Array(Buffer.from(text, 'utf8'))), text);
});

test('decodeLocalTextBuffer：剥 UTF-8 BOM，且带 BOM 时不再猜编码', () => {
  const ctx = boot();
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[00:01.00]歌词', 'utf8')]);
  assert.equal(ctx.decodeLocalTextBuffer(new Uint8Array(bytes)), '[00:01.00]歌词');
});

test('decodeLocalTextBuffer：无 BOM 的 UTF-16LE 靠零字节分布嗅出', () => {
  const ctx = boot();
  const body = Buffer.from('[00:01.00]第一句歌词第二句', 'utf16le');
  assert.equal(ctx.decodeLocalTextBuffer(new Uint8Array(body)), '[00:01.00]第一句歌词第二句');
});

test('readLocalLyricText：File 形态走 arrayBuffer 通道并解码', async () => {
  const ctx = boot();
  const bytes = new Uint8Array(GB18030_BYTES);
  const file = { name: 'song.lrc', arrayBuffer: async () => bytes.buffer };
  assert.equal(await ctx.readLocalLyricText(file), '[00:01.00]世界和平');
});

function krcFileBytes(plainText) {
  const deflated = zlib.deflateSync(Buffer.from(plainText, 'utf8'));
  const magic = Buffer.from([0x6b, 0x72, 0x63, 0x31]);
  const key = [0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69];
  const body = Buffer.alloc(deflated.length);
  for (let i = 0; i < deflated.length; i++) body[i] = deflated[i] ^ key[i % key.length];
  return Buffer.concat([magic, body]);
}

test('decodeLyricFileBuffer：KRC 加密二进制先异或还原再解压', async () => {
  const ctx = boot();
  const plain = '[00:01.00]酷狗加密歌词';
  const out = await ctx.decodeLyricFileBuffer(new Uint8Array(krcFileBytes(plain)));
  assert.equal(out, plain);
});

test('decodeLyricFileBuffer：普通 LRC 文本不受加密分支影响', async () => {
  const ctx = boot();
  const text = '[00:01.00]plain lrc\n[00:02.00]second';
  assert.equal(await ctx.decodeLyricFileBuffer(new Uint8Array(Buffer.from(text, 'utf8'))), text);
});

test('qrcEncryptedPayloadBytes：认十六进制密文，拒明文与残包', () => {
  const ctx = boot();
  const hex = Buffer.from('4142434445464748' + '0123456789abcdef', 'ascii');
  const payload = ctx.qrcEncryptedPayloadBytes(new Uint8Array(hex));
  assert.ok(payload instanceof ctx.Uint8Array);
  assert.equal(payload.length, 16);
  assert.deepEqual(Array.from(payload.subarray(0, 8)), [0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48]);
  assert.deepEqual(Array.from(payload.subarray(8)), [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
  assert.equal(ctx.qrcEncryptedPayloadBytes(new Uint8Array(Buffer.from('[00:01.00]abc', 'ascii'))), null);
  assert.equal(ctx.qrcEncryptedPayloadBytes(new Uint8Array(Buffer.from('414243', 'ascii'))), null);
});

test('applyStoredLocalLyricPick：按记住的候选标识改写歌词文件', () => {
  const ctx = boot();
  const a = { name: 'song.lrc', relativePath: 'Album/Song.lrc' };
  const b = { name: 'Song_en.lrc', relativePath: 'Album/Song_en.lrc' };
  const song = { name: 'Song', localLyricFile: a, localLyricFileName: 'song.lrc', localLyricCandidates: [a, b] };
  const picked = ctx.applyStoredLocalLyricPick(song);
  assert.equal(picked.localLyricFile, a, '没有记录时保留自动匹配');

  // 选择记录只惰性读一次，写入必须在首次取用前落盘。
  const seeded = boot();
  seeded.localStorage.setItem('stellaflix-local-lyric-picks-v1', JSON.stringify({ 'key:Song': 'album/song_en.lrc' }));
  const again = seeded.applyStoredLocalLyricPick({
    name: 'Song', localLyricFile: a, localLyricFileName: 'song.lrc', localLyricCandidates: [a, b],
  });
  assert.equal(again.localLyricFile, b, '命中记录后换到记住的候选');
  assert.equal(again.localLyricFileName, 'Song_en.lrc');

  const single = seeded.applyStoredLocalLyricPick({ name: 'Song', localLyricFile: a, localLyricCandidates: [a] });
  assert.equal(single.localLyricFile, a, '单候选不猜');
});
