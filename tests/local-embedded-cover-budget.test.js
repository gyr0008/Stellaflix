'use strict';

// 内嵌封面像素预算守卫（缺口①）。
// 退役前的主进程曲库类 _deprecated/local-music-library.js.bak-202610252303 有
// coverWithinBudget()：单张封面 >6MB 直接拒；能读出宽高则限边长 ≤4096、像素 ≤12M；
// 读不出宽高退到 1MB 上限。移植到渲染层标签解析时只带上了「帧长度 ≤64MB」的
// ID3_MAX_PICTURE_BYTES，像素预算整段丢失——低配机上 8K 内嵌封面会直接把解码打爆。
// 参照库（Mineradio-2.5.1）本身没有这层守卫，本节是我方自研能力补回。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_SOURCE = path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '10-local-tag-parser.js');

function readModule() { return fs.readFileSync(MODULE_SOURCE, 'utf8'); }
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

/** PNG：签名 8 字节 + IHDR 长度/类型，宽高是偏移 16/20 的两个 uint32BE。 */
function pngBytes(width, height, tailLength) {
  const bytes = new Uint8Array(Math.max(24, tailLength || 24));
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((v, i) => { bytes[i] = v; });
  bytes[8] = 0; bytes[9] = 0; bytes[10] = 0; bytes[11] = 13;
  [0x49, 0x48, 0x44, 0x52].forEach((v, i) => { bytes[12 + i] = v; });
  bytes[16] = (width >>> 24) & 0xff; bytes[17] = (width >>> 16) & 0xff; bytes[18] = (width >>> 8) & 0xff; bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff; bytes[21] = (height >>> 16) & 0xff; bytes[22] = (height >>> 8) & 0xff; bytes[23] = height & 0xff;
  return bytes;
}
/** GIF89a：宽/高是偏移 6/8 的两个 uint16LE。 */
function gifBytes(width, height) {
  const bytes = new Uint8Array(32);
  Buffer.from('GIF89a').copy(Buffer.from(bytes.buffer), 0);
  bytes[6] = width & 0xff; bytes[7] = (width >>> 8) & 0xff;
  bytes[8] = height & 0xff; bytes[9] = (height >>> 8) & 0xff;
  return bytes;
}
/** BMP：宽/高是偏移 18/22 的两个 int32LE。 */
function bmpBytes(width, height) {
  const bytes = new Uint8Array(64);
  bytes[0] = 0x42; bytes[1] = 0x4d;
  const put = (off, value) => {
    for (let i = 0; i < 4; i++) bytes[off + i] = Math.floor(value / Math.pow(256, i)) & 0xff;
  };
  put(18, width); put(22, height);
  return bytes;
}
/** JPEG：从 offset 2 扫段，SOF 段内先高后宽（+5/+7 两个 uint16BE）。 */
function jpegBytes(width, height, withSof) {
  const bytes = new Uint8Array(64);
  bytes[0] = 0xff; bytes[1] = 0xd8;
  if (withSof === false) { bytes[2] = 0xff; bytes[3] = 0xdb; return bytes; }
  bytes[2] = 0xff; bytes[3] = 0xc0;
  bytes[4] = 0; bytes[5] = 17;            // 段长
  bytes[6] = 8;                            // 精度
  bytes[7] = (height >>> 8) & 0xff; bytes[8] = height & 0xff;
  bytes[9] = (width >>> 8) & 0xff; bytes[10] = width & 0xff;
  return bytes;
}
/** WebP VP8X：宽/高是偏移 24/27 的两个 3 字节 LE，且各减一。 */
function webpExtendedBytes(width, height) {
  const bytes = new Uint8Array(40);
  const ascii = (off, text) => { for (let i = 0; i < text.length; i++) bytes[off + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF'); ascii(8, 'WEBP'); ascii(12, 'VP8X');
  bytes[24] = (width - 1) & 0xff; bytes[25] = ((width - 1) >> 8) & 0xff; bytes[26] = ((width - 1) >> 16) & 0xff;
  bytes[27] = (height - 1) & 0xff; bytes[28] = ((height - 1) >> 8) & 0xff; bytes[29] = ((height - 1) >> 16) & 0xff;
  return bytes;
}
/** ID3v2.3 标签，把任意 payload 塞进单个 APIC 帧。 */
function id3v23WithPicture(imageBytes, mime) {
  const mimeBytes = Buffer.from(mime || 'image/png', 'ascii');
  const frameData = Buffer.concat([
    Buffer.from([0x00]), mimeBytes, Buffer.from([0x00]), Buffer.from([0x03]), Buffer.from([0x00]),
    Buffer.from(imageBytes),
  ]);
  const frameHeader = Buffer.concat([
    Buffer.from('APIC', 'ascii'),
    Buffer.from([(frameData.length >>> 24) & 0xff, (frameData.length >>> 16) & 0xff, (frameData.length >>> 8) & 0xff, frameData.length & 0xff]),
    Buffer.from([0, 0]),
  ]);
  const body = Buffer.concat([frameHeader, frameData]);
  const header = Buffer.concat([
    Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]),
    Buffer.from([(body.length >>> 21) & 0x7f, (body.length >>> 14) & 0x7f, (body.length >>> 7) & 0x7f, body.length & 0x7f]),
  ]);
  return new Uint8Array(Buffer.concat([header, body]));
}

test('coverWithinBudget：1×1 PNG 与常规尺寸放行', () => {
  const ctx = boot();
  assert.equal(ctx.coverWithinBudget(pngBytes(1, 1), 'image/png'), true);
  assert.equal(ctx.coverWithinBudget(pngBytes(1400, 1400), 'image/png'), true);
});

test('coverWithinBudget：PNG 边长超 4096 拒收', () => {
  const ctx = boot();
  assert.equal(ctx.coverWithinBudget(pngBytes(5000, 5000), 'image/png'), false);
  assert.equal(ctx.coverWithinBudget(pngBytes(4097, 16), 'image/png'), false);
});

test('coverWithinBudget：边长合规但总像素超 12M 拒收', () => {
  const ctx = boot();
  // 上限 12×1024×1024 = 12,582,912；4096×3072 恰好等于上限放行，+1 行才越界。
  assert.equal(ctx.coverWithinBudget(pngBytes(4096, 3072), 'image/png'), true);
  assert.equal(ctx.coverWithinBudget(pngBytes(4096, 3073), 'image/png'), false);
});

test('coverWithinBudget：JPEG SOF / GIF / BMP / WebP 各自超限都拒收', () => {
  const ctx = boot();
  assert.equal(ctx.coverWithinBudget(jpegBytes(6000, 6000), 'image/jpeg'), false);
  assert.equal(ctx.coverWithinBudget(jpegBytes(600, 400), 'image/jpeg'), true);
  assert.equal(ctx.coverWithinBudget(gifBytes(8000, 8000), 'image/gif'), false);
  assert.equal(ctx.coverWithinBudget(bmpBytes(5000, 10), 'image/bmp'), false);
  assert.equal(ctx.coverWithinBudget(webpExtendedBytes(6000, 6000), 'image/webp'), false);
  assert.equal(ctx.coverWithinBudget(webpExtendedBytes(640, 480), 'image/webp'), true);
});

test('coverWithinBudget：读不出宽高时退到 1MB 上限', () => {
  const ctx = boot();
  const smallNoSof = jpegBytes(0, 0, false);
  assert.equal(ctx.embeddedImageDimensions(smallNoSof, 'image/jpeg'), null);
  assert.equal(ctx.coverWithinBudget(smallNoSof, 'image/jpeg'), true);
  const bigNoSof = new Uint8Array(1024 * 1024 + 1);
  bigNoSof.set(smallNoSof);
  assert.equal(ctx.coverWithinBudget(bigNoSof, 'image/jpeg'), false);
});

test('coverWithinBudget：单张 >6MB 一律拒收，与像素无关', () => {
  const ctx = boot();
  const huge = pngBytes(800, 800, 6 * 1024 * 1024 + 1);
  assert.equal(ctx.coverWithinBudget(huge, 'image/png'), false);
});

test('coverWithinBudget：PNG 魔数对但缺 IHDR 块时不认头部', () => {
  const ctx = boot();
  // 各标签测试里的假封面就是「魔数 + 填充字节」，16/20 处是噪声值；
  // 只验魔数会把它读成十几亿像素而误杀，所以块类型必须是 IHDR。
  const fake = new Uint8Array(64);
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((v, i) => { fake[i] = v; });
  fake.fill(0x6d, 8);
  assert.equal(ctx.embeddedImageDimensions(fake, 'image/png'), null);
  assert.equal(ctx.coverWithinBudget(fake, 'image/png'), true);
});

test('blobBytesToCoverBlob：超预算返回 null，合规返回 Blob', () => {
  const ctx = boot();
  const ok = ctx.blobBytesToCoverBlob(pngBytes(800, 800), 'image/png');
  assert.ok(ok instanceof ctx.Blob, '合规封面应产出 Blob');
  assert.equal(ctx.blobBytesToCoverBlob(pngBytes(5000, 5000), 'image/png'), null);
});

test('parseId3v2Picture：APIC 里的超大封面端到端拿不到 Blob', () => {
  const ctx = boot();
  assert.ok(ctx.parseId3v2Picture(id3v23WithPicture(pngBytes(800, 800)), 0), '小封面仍应命中');
  assert.equal(ctx.parseId3v2Picture(id3v23WithPicture(pngBytes(5000, 5000)), 0), null);
});

test('预算常量与退役前实现同值，防止后续调参走样', () => {
  const source = readModule();
  for (const literal of ['= 6 * 1024 * 1024', '= 1024 * 1024', '= 4096', '= 12 * 1024 * 1024']) {
    assert.ok(source.includes(literal), '缺少预算常量 ' + literal);
  }
  // 守卫必须收在唯一漏斗里，而不是散在五个调用点。
  const blobSource = source.slice(source.indexOf('function blobBytesToCoverBlob'), source.indexOf('function extractFlacPictureBlob'));
  assert.match(blobSource, /if \(!coverWithinBudget\(bytes, mime\)\) return null;/);
});
