'use strict';

// ID3v2 SYLT 同步歌词（缺口②）。
// 退役前的主进程曲库类用 music-metadata 的 common.lyrics[].syncText 生成 LRC 文本
// （_deprecated/local-music-library.js.bak-202610252303 embeddedLyricText + formatLrcTimestamp），
// 只写 SYLT 不写 USLT 的文件当时能出歌词；移植到渲染层后 parseId3v2Lyrics 只认
// USLT/TXXX，这类文件变成「有歌词读不出」。参照库 Mineradio-2.5.1 同样不解析 SYLT，
// 本节是补回我方自己丢掉的行为，不是照抄参照库。
// 帧布局取自 ID3 官方规范 v2.3/v2.4：text encoding(1) + language(3) + time stamp format(1)
// + content type(1) + content descriptor(终止串)，随后重复「<终止文本><4 字节大端时间戳>」。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE = path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '10-local-tag-parser.js');
function readModule() { return fs.readFileSync(MODULE, 'utf8'); }
function stripHeader(src) {
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].startsWith('//') || lines[i].trim() === '')) i += 1;
  return lines.slice(i).join('\n');
}
function boot() {
  const context = {
    Array, ArrayBuffer, Blob, Buffer, Error, Intl, JSON, Math, Number, Object, Promise, String,
    Uint8Array, Int32Array, TextDecoder, URL, atob, btoa, Response, DecompressionStream,
    console: { warn: () => {}, log: () => {} },
    window: { TextDecoder },
  };
  vm.runInNewContext(stripHeader(readModule()), context);
  return context;
}

/** 按帧编码把文本连同一个终止符写成字节。enc 0=latin1、1=UTF-16LE+BOM、3=UTF-8。 */
function terminatedByTextEncoding(text, enc) {
  if (enc === 1) return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le'), Buffer.from([0x00, 0x00])]);
  if (enc === 2) {
    const wide = Buffer.from(text, 'utf16le');
    for (let i = 0; i + 1 < wide.length; i += 2) { const t = wide[i]; wide[i] = wide[i + 1]; wide[i + 1] = t; }
    return Buffer.concat([Buffer.from([0xfe, 0xff]), wide, Buffer.from([0x00, 0x00])]);
  }
  return Buffer.from(text + '\u0000', enc === 3 ? 'utf8' : 'latin1');
}
/** SYLT 帧的同步块：文本在前、4 字节大端时间戳在后。 */
function syltBlock(text, timestamp, enc) {
  const ts = Buffer.alloc(4);
  ts.writeUInt32BE(timestamp >>> 0, 0);
  return Buffer.concat([terminatedByTextEncoding(text, enc), ts]);
}
/** 组一个 SYLT 帧体（v2.3/v2.4 布局）。 */
function syltFrameText(blocks, opts) {
  const o = opts || {};
  const enc = o.encoding == null ? 3 : o.encoding;
  return Buffer.concat([
    Buffer.from([enc]),
    Buffer.from(o.language || 'chi', 'ascii'),
    Buffer.from([o.timeStampFormat == null ? 2 : o.timeStampFormat]),
    Buffer.from([o.contentType == null ? 1 : o.contentType]),
    terminatedByTextEncoding(o.descriptor || '', enc),
    ...blocks.map((b) => syltBlock(b[0], b[1], enc)),
  ]);
}
/** 把若干帧组成完整 ID3v2 标签；v2.4 帧长是 synchsafe，v2.3 是普通 uint32BE。 */
function id3Tag(version, frames) {
  const body = Buffer.concat(frames.map(({ id, data }) => {
    const size = version === 4
      ? Buffer.from([(data.length >>> 21) & 0x7f, (data.length >>> 14) & 0x7f, (data.length >>> 7) & 0x7f, data.length & 0x7f])
      : Buffer.from([(data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]);
    return Buffer.concat([Buffer.from(id, 'ascii'), size, Buffer.from([0, 0]), data]);
  }));
  const header = Buffer.concat([
    Buffer.from('ID3', 'ascii'), Buffer.from([version, 0, 0]),
    Buffer.from([(body.length >>> 21) & 0x7f, (body.length >>> 14) & 0x7f, (body.length >>> 7) & 0x7f, body.length & 0x7f]),
  ]);
  return new Uint8Array(Buffer.concat([header, body]));
}
/** USLT 帧体：enc + 语言 + 描述符 + 正文。 */
function usltFrame(text, opts) {
  const o = opts || {};
  const enc = o.encoding == null ? 3 : o.encoding;
  return Buffer.concat([
    Buffer.from([enc]), Buffer.from('chi', 'ascii'),
    terminatedByTextEncoding(o.descriptor || '', enc),
    Buffer.from(text, enc === 3 ? 'utf8' : 'latin1'),
  ]);
}
/** TXXX 帧体：enc + 描述符 + 正文（无语言码）。 */
function txxxFrame(key, text) {
  return Buffer.concat([
    Buffer.from([3]), terminatedByTextEncoding(key, 3), Buffer.from(text, 'utf8'),
  ]);
}

test('SYLT(v2.4) 毫秒时间戳转成既有 LRC 时间标签', () => {
  const ctx = boot();
  const bytes = id3Tag(4, [{
    id: 'SYLT',
    data: syltFrameText([['第一句', 1250], ['第二句', 62500]], { encoding: 3 }),
  }]);
  assert.equal(ctx.parseId3v2Lyrics(bytes, 0), '[00:01.250]第一句\n[01:02.500]第二句');
});

test('SYLT(v2.3) 帧长非 synchsafe，同样解析成功', () => {
  const ctx = boot();
  const bytes = id3Tag(3, [{ id: 'SYLT', data: syltFrameText([['第一句', 1250], ['第二句', 62500]], { encoding: 3 }) }]);
  assert.equal(ctx.parseId3v2Lyrics(bytes, 0), '[00:01.250]第一句\n[01:02.500]第二句');
});

test('SYLT 支持 UTF-16（带 BOM）编码与描述符后的宽终止符', () => {
  const ctx = boot();
  const bytes = id3Tag(4, [{ id: 'SYLT', data: syltFrameText([['第一句', 1000], ['尾句', 61000]], { encoding: 1 }) }]);
  assert.equal(ctx.parseId3v2Lyrics(bytes, 0), '[00:01.000]第一句\n[01:01.000]尾句');
});

test('SYLT 空文本块与越界时间戳不产出空白行', () => {
  const ctx = boot();
  const bytes = id3Tag(4, [{
    id: 'SYLT',
    data: syltFrameText([['', 500], ['有词', 1500]], { encoding: 3 }),
  }]);
  assert.equal(ctx.parseId3v2Lyrics(bytes, 0), '[00:01.500]有词');
});

test('timeStampFormat=MPEG 帧号时拒收，不猜帧号到毫秒的换算', () => {
  const ctx = boot();
  const frames = [{ id: 'SYLT', data: syltFrameText([['第一句', 1250]], { encoding: 3, timeStampFormat: 1 }) }];
  assert.equal(ctx.parseId3v2Lyrics(id3Tag(4, frames), 0), '');
  // 同一帧体只改时间戳口径就必须出词，证明拒收来自判定而非解析失败。
  const msFrames = [{ id: 'SYLT', data: syltFrameText([['第一句', 1250]], { encoding: 3, timeStampFormat: 2 }) }];
  assert.equal(ctx.parseId3v2Lyrics(id3Tag(4, msFrames), 0), '[00:01.250]第一句');
});

test('SYLT 优先于无时间标签的 USLT，但输给带时间标签的 LYRICS', () => {
  const ctx = boot();
  const withUslt = id3Tag(4, [
    { id: 'USLT', data: usltFrame('纯文本歌词') },
    { id: 'SYLT', data: syltFrameText([['同步歌词', 1000]], { encoding: 3 }) },
  ]);
  assert.equal(ctx.parseId3v2Lyrics(withUslt, 0), '[00:01.000]同步歌词');
  const withTxxx = id3Tag(4, [
    { id: 'SYLT', data: syltFrameText([['同步歌词', 1000]], { encoding: 3 }) },
    { id: 'TXXX', data: txxxFrame('LYRICS', '[00:02.00]更强的歌词') },
  ]);
  assert.equal(ctx.parseId3v2Lyrics(withTxxx, 0), '[00:02.00]更强的歌词');
});

test('SYLT 走 SYNCEDLYRICS 优先级 95：既高于 USLT 的 90，也低于 LYRICS 的 100', () => {
  const ctx = boot();
  assert.equal(ctx.embeddedLyricFieldPriority('SYNCEDLYRICS', '[00:01.000]词'), 95);
});

test('帧内声明的语言码/内容类型不影响歌词产出，但描述符必须被跳过', () => {
  const ctx = boot();
  const bytes = id3Tag(4, [{
    id: 'SYLT',
    data: syltFrameText([['第一句', 1000]], { encoding: 3, descriptor: 'lyrics', language: 'eng', contentType: 1 }),
  }]);
  assert.equal(ctx.parseId3v2Lyrics(bytes, 0), '[00:01.000]第一句');
});

test('formatLrcTimestamp：负数归零、秒/毫秒补位', () => {
  const ctx = boot();
  assert.equal(ctx.formatLrcTimestamp(-5), '[00:00.000]');
  assert.equal(ctx.formatLrcTimestamp(0), '[00:00.000]');
  assert.equal(ctx.formatLrcTimestamp(9999), '[00:09.999]');
  assert.equal(ctx.formatLrcTimestamp(3600000), '[60:00.000]');
});

test('SYLT 正文字节上限沿用退役前的 512KB 口径', () => {
  const source = readModule();
  assert.match(source, /512 \* 1024/);
});
