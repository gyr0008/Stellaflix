// ============================================================================
// 04-shelf/10-local-tag-parser.js
// 批3-A：本地音乐自研标签解析器（block1）——1:1 移植自参照库 Mineradio-2.5.1
//   public/app.js L33833-36452。仅门牌号/品牌口径，零功能裁剪。
// 补段：L33391-33827（readLocalTextFileBytes + KRC/QRC 解密 + decodeLyricFileBuffer）。
//   这段在参照库里紧挨 block2 末尾，当初按 block1/block2 分界移植时被整段跳过，
//   留下 readLocalLyricText 调用未定义符号。参照库同段的 readLocalTextFile 无人调用，未带入。
// 读字节双路：拖入 File 走 file.slice()；主进程扫出的路径走 IPC
//   window.desktopWindow.readLocalFileRange(fullPath,start,stop)（批3-A 新增通道：
//   main=readAuthorizedLocalFileRange + preload=readLocalFileRange）。
// 依赖 block2（11-local-track-map.js）的 localFullPath / desktopLocalMusicApi：
//   模块拼接后同一全局作用域，函数声明提升，无需 import。
// 公开入口：extractLocalMetadataTags / extractEmbeddedCoverSource / extractEmbeddedLyricsText
//   / readLocalLyricText（旁挂歌词解码入口，由批3-C 引擎 13-local-library-engine.js 调用）。
// ============================================================================
async function readLocalTextFileBytes(file) {
  if (!file) return null;
  if (file.arrayBuffer) return await file.arrayBuffer();
  var fullPath = localFullPath(file);
  var api = desktopLocalMusicApi();
  if (fullPath && api && typeof api.readLocalFileRange === 'function') {
    return await readLocalFileBytes(file, 0, localFileSize(file) || null);
  }
  return new Promise(function(resolve){
    var reader = new FileReader();
    reader.onload = function(){ resolve(reader.result); };
    reader.onerror = function(){ resolve(null); };
    reader.readAsArrayBuffer(file);
  });
}
// 酷狗 KRC 加密二进制的固定头与异或密钥：头 4 字节是 `krc1`，其后整段先按这 16 字节
// 循环异或，再解 zlib 就还原成明文 KRC。这串是公开的格式常量，不是凭据。
var KRC_MAGIC = [0x6b, 0x72, 0x63, 0x31];
var KRC_XOR_KEY = [0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69];
/**
 * 剥掉 KRC 二进制头并还原异或，得到待解压的 deflate 数据。
 * @param {ArrayBuffer|Uint8Array} buffer 文件原始字节。
 * @returns {Uint8Array|null} 异或还原后的字节；不是 KRC 二进制时返回 null。
 */
function krcEncryptedPayloadBytes(buffer) {
  var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  if (bytes.length <= KRC_MAGIC.length) return null;
  for (var i = 0; i < KRC_MAGIC.length; i++) {
    if (bytes[i] !== KRC_MAGIC[i]) return null;
  }
  var out = new Uint8Array(bytes.length - KRC_MAGIC.length);
  for (var j = 0; j < out.length; j++) out[j] = bytes[KRC_MAGIC.length + j] ^ KRC_XOR_KEY[j % KRC_XOR_KEY.length];
  return out;
}
/**
 * 解压 deflate 字节。`DecompressionStream` 在 Chromium 与 Node 18+ 都是全局对象，
 * 所以这一步既不用新依赖，也能直接单测。
 * @param {Uint8Array} bytes 压缩数据。
 * @returns {Promise<Uint8Array|null>} 解压结果；失败时返回 null。
 */
async function inflateLyricBytes(bytes) {
  if (!bytes || !bytes.length || typeof DecompressionStream !== 'function') return null;
  // 带 zlib 头的以 0x78 开头，没有头的按 raw deflate 再试一次。
  var formats = bytes[0] === 0x78 ? ['deflate', 'deflate-raw'] : ['deflate-raw', 'deflate'];
  var end = bytes.length;
  for (;;) {
    var view = end === bytes.length ? bytes : bytes.subarray(0, end);
    for (var i = 0; i < formats.length; i++) {
      try {
        var source = new Response(view).body;
        if (!source) return null;
        var out = await new Response(source.pipeThrough(new DecompressionStream(formats[i]))).arrayBuffer();
        if (out && out.byteLength) return new Uint8Array(out);
      } catch (e) {}
    }
    // QRC 的 3DES 用零填充，解出来的压缩数据尾部会多几个 0，DecompressionStream 见到就报
    // trailing junk。所以整段解不开时逐个剥掉尾部的 0 重试，最多剥掉一个分组的长度。
    if (end <= bytes.length - 7 || end < 2 || bytes[end - 1] !== 0) return null;
    end--;
  }
}
// QQ 音乐 QRC 加密歌词用的是一套“形似 DES、实则私有”的分组密码：S 盒带着出厂就有的笔误、
// PC-2 有 `pos - 27` 这种怪癖、密钥按小端 32 位字寻址、只跑 15 轮加一个半轮且末尾不交换左右。
// 处处偏离标准，平台自带的 crypto / des-ede3 一律解不开，只能照算法原样移植一份。下面这些表和
// 三把密钥都是公开的格式常量，不是凭据。参考实现：apoint123/qrc-decoder。
var QRC_DES_BLOCK_SIZE = 8;
// "!@#)(*$%" / "123ZXC!@" / "!@#)(NHL" 三把 8 字节密钥的 ASCII 字节。
var QRC_DES_KEY_1 = [0x21, 0x40, 0x23, 0x29, 0x28, 0x2a, 0x24, 0x25];
var QRC_DES_KEY_2 = [0x31, 0x32, 0x33, 0x5a, 0x58, 0x43, 0x21, 0x40];
var QRC_DES_KEY_3 = [0x21, 0x40, 0x23, 0x29, 0x28, 0x4e, 0x48, 0x4c];
// 八张非标准 S 盒。第 2、4 盒里的重复值（15,2,8,15 与 10,10）是原算法自带的笔误，
// 照抄才能对上真实密文，改“对”了反而解不开。
var QRC_DES_S_BOXES = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];
// P 盒、扩展置换 E 盒、每轮左移位数、PC-1 的 C/D 两半、PC-2、初始置换与逆初始置换。
var QRC_DES_P_BOX = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
var QRC_DES_E_BOX = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
var QRC_DES_KEY_RND_SHIFT = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
var QRC_DES_KEY_PERM_C = [56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17,
  9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35];
var QRC_DES_KEY_PERM_D = [62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21,
  13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3];
var QRC_DES_KEY_COMPRESSION = [13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1,
  40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31];
var QRC_DES_IP_RULE = [34, 42, 50, 58, 2, 10, 18, 26, 36, 44, 52, 60, 4, 12, 20, 28,
  38, 46, 54, 62, 6, 14, 22, 30, 40, 48, 56, 64, 8, 16, 24, 32, 33, 41, 49, 57, 1, 9, 17, 25,
  35, 43, 51, 59, 3, 11, 19, 27, 37, 45, 53, 61, 5, 13, 21, 29, 39, 47, 55, 63, 7, 15, 23, 31];
var QRC_DES_INV_IP_RULE = [37, 5, 45, 13, 53, 21, 61, 29, 38, 6, 46, 14, 54, 22, 62, 30,
  39, 7, 47, 15, 55, 23, 63, 31, 40, 8, 48, 16, 56, 24, 64, 32, 33, 1, 41, 9, 49, 17, 57, 25,
  34, 2, 42, 10, 50, 18, 58, 26, 35, 3, 43, 11, 51, 19, 59, 27, 36, 4, 44, 12, 52, 20, 60, 28];
// 置换与 S-P 合并查找表建一次要跑二十多万次位运算，而绝大多数会话根本不会碰加密歌词，
// 所以全部推迟到第一次解密时再建。
var qrcDesTables = null;
/**
 * 把 64 位置换规则展开成“单字节 → 左右各 32 位”的查找表。输入永远只有一个字节非零，
 * 所以能逐字节预计算，运行时只做 8 次查表加按位或。
 * @param {Array<number>} rule 1 起的源位下标表，长度 64。
 * @param {Int32Array} leftTable 高 32 位输出表。
 * @param {Int32Array} rightTable 低 32 位输出表。
 * @returns {void}
 */
function qrcDesFillPermTable(rule, leftTable, rightTable) {
  for (var bytePos = 0; bytePos < 8; bytePos++) {
    var base = 56 - bytePos * 8;
    for (var byteVal = 0; byteVal < 256; byteVal++) {
      var left = 0;
      var right = 0;
      for (var i = 0; i < 64; i++) {
        var offset = 64 - rule[i] - base;
        if (offset < 0 || offset > 7) continue;
        if (!((byteVal >> offset) & 1)) continue;
        if (i < 32) left |= 1 << (31 - i);
        else right |= 1 << (63 - i);
      }
      leftTable[(bytePos << 8) | byteVal] = left;
      rightTable[(bytePos << 8) | byteVal] = right;
    }
  }
}
/**
 * 按非标准规则取 S 盒下标：高位保留，中间 5 位右移一位，最低位翻到第 5 位。
 * @param {number} a 6 位输入。
 * @returns {number} S 盒下标。
 */
function qrcDesSboxIndex(a) {
  return (a & 0x20) | ((a & 0x1f) >> 1) | ((a & 0x01) << 4);
}
/**
 * 对 32 位中间结果应用 P 盒置换。
 * @param {number} input S 盒代换后的 32 位值。
 * @returns {number} 置换结果。
 */
function qrcDesPbox(input) {
  var output = 0;
  for (var i = 0; i < 32; i++) {
    if ((input & (1 << (32 - QRC_DES_P_BOX[i]))) !== 0) output |= 1 << (31 - i);
  }
  return output;
}
/**
 * 首次解密时建好全部查找表：IP、逆 IP、S-P 合并表与 E 盒展开表。
 * @returns {object} 查找表集合。
 */
function ensureQrcDesTables() {
  if (qrcDesTables) return qrcDesTables;
  var tables = {
    ipLeft: new Int32Array(2048), ipRight: new Int32Array(2048),
    invIpLeft: new Int32Array(2048), invIpRight: new Int32Array(2048),
    sp: new Int32Array(512), eboxHigh: new Int32Array(1024), eboxLow: new Int32Array(1024),
  };
  qrcDesFillPermTable(QRC_DES_IP_RULE, tables.ipLeft, tables.ipRight);
  qrcDesFillPermTable(QRC_DES_INV_IP_RULE, tables.invIpLeft, tables.invIpRight);
  for (var box = 0; box < 8; box++) {
    for (var input = 0; input < 64; input++) {
      var nibble = QRC_DES_S_BOXES[box][qrcDesSboxIndex(input)];
      tables.sp[(box << 6) | input] = qrcDesPbox(nibble << (28 - box * 4));
    }
  }
  for (var chunk = 0; chunk < 4; chunk++) {
    var shiftIn32 = (3 - chunk) * 8;
    for (var byteVal = 0; byteVal < 256; byteVal++) {
      var high24 = 0;
      var low24 = 0;
      var expanded = byteVal << shiftIn32;
      for (var i = 0; i < 48; i++) {
        if (!((expanded >>> (32 - QRC_DES_E_BOX[i])) & 1)) continue;
        if (i < 24) high24 |= 1 << (23 - i);
        else low24 |= 1 << (47 - i);
      }
      tables.eboxHigh[(chunk << 8) | byteVal] = high24;
      tables.eboxLow[(chunk << 8) | byteVal] = low24;
    }
  }
  qrcDesTables = tables;
  return tables;
}
/**
 * 按 PC-1 的位表从 8 字节密钥里取位。这里的字节寻址是 QQ 音乐特有的：8 字节密钥被当成两个
 * 小端 32 位字拼起来，所以第 0 位实际落在 key[3] 的最高位。
 * @param {Array<number>|Uint8Array} key 8 字节密钥。
 * @param {Array<number>} table 0 起的位下标表，长度 28。
 * @returns {number} 28 位结果。
 */
function qrcDesPermuteKeyBits(key, table) {
  var output = 0;
  var mask = 1 << (table.length - 1);
  for (var i = 0; i < table.length; i++) {
    var pos = table[i];
    var bitInWord = pos & 31;
    var byteIndex = (pos >> 5) * 4 + 3 - (bitInWord >> 3);
    if ((key[byteIndex] >> (7 - (bitInWord & 7))) & 1) output |= mask;
    mask >>>= 1;
  }
  return output >>> 0;
}
/**
 * 对高位对齐（占 31..4 位）的 28 位密钥半区做循环左移。
 * @param {number} value 28 位数据。
 * @param {number} amount 左移位数。
 * @returns {number} 循环左移结果。
 */
function qrcDesRotate28(value, amount) {
  var val = (value & 0xfffffff0) >>> 0;
  return (((val << amount) | (val >>> (28 - amount))) & 0xfffffff0) >>> 0;
}
/**
 * 生成 16 个轮密钥，每个拆成高低两个 24 位存进一维数组。解密模式下轮密钥倒序写入，
 * 于是加解密可以共用同一个分组函数。
 * @param {Array<number>|Uint8Array} key 8 字节密钥。
 * @param {boolean} decrypt true 生成解密轮密钥。
 * @returns {Int32Array} 长度 32 的轮密钥表。
 */
function qrcDesKeySchedule(key, decrypt) {
  var schedule = new Int32Array(32);
  var c = (qrcDesPermuteKeyBits(key, QRC_DES_KEY_PERM_C) << 4) >>> 0;
  var d = (qrcDesPermuteKeyBits(key, QRC_DES_KEY_PERM_D) << 4) >>> 0;
  for (var i = 0; i < 16; i++) {
    c = qrcDesRotate28(c, QRC_DES_KEY_RND_SHIFT[i]);
    d = qrcDesRotate28(d, QRC_DES_KEY_RND_SHIFT[i]);
    var high24 = 0;
    var low24 = 0;
    for (var k = 0; k < QRC_DES_KEY_COMPRESSION.length; k++) {
      var pos = QRC_DES_KEY_COMPRESSION[k];
      // `pos - 27` 不是笔误，是这套算法自己的规则。
      var bit = pos < 28 ? (c >>> (31 - pos)) & 1 : (d >>> (31 - (pos - 27))) & 1;
      if (!bit) continue;
      if (k < 24) high24 |= 1 << (23 - k);
      else low24 |= 1 << (47 - k);
    }
    var slot = (decrypt ? 15 - i : i) * 2;
    schedule[slot] = high24;
    schedule[slot + 1] = low24;
  }
  return schedule;
}
/**
 * 轮函数：E 盒扩展 → 与轮密钥异或 → 八次 S-P 合并查表。
 * @param {number} state 32 位右半区。
 * @param {number} keyHigh24 轮密钥高 24 位。
 * @param {number} keyLow24 轮密钥低 24 位。
 * @param {object} t 查找表集合。
 * @returns {number} 32 位轮函数输出。
 */
function qrcDesRound(state, keyHigh24, keyLow24, t) {
  var b0 = (state >>> 24) & 0xff;
  var b1 = (state >>> 16) & 0xff;
  var b2 = (state >>> 8) & 0xff;
  var b3 = state & 0xff;
  var high = (t.eboxHigh[b0] | t.eboxHigh[256 | b1] | t.eboxHigh[512 | b2] | t.eboxHigh[768 | b3]) ^ keyHigh24;
  var low = (t.eboxLow[b0] | t.eboxLow[256 | b1] | t.eboxLow[512 | b2] | t.eboxLow[768 | b3]) ^ keyLow24;
  return t.sp[(high >>> 18) & 0x3f] | t.sp[64 | ((high >>> 12) & 0x3f)]
    | t.sp[128 | ((high >>> 6) & 0x3f)] | t.sp[192 | (high & 0x3f)]
    | t.sp[256 | ((low >>> 18) & 0x3f)] | t.sp[320 | ((low >>> 12) & 0x3f)]
    | t.sp[384 | ((low >>> 6) & 0x3f)] | t.sp[448 | (low & 0x3f)];
}
/**
 * 处理一个 8 字节分组：初始置换 → 15 轮 → 最后半轮（不交换左右）→ 逆初始置换。
 * @param {Uint8Array} input 输入分组。
 * @param {number} inputOffset 输入起始下标。
 * @param {Uint8Array} output 输出分组。
 * @param {number} outputOffset 输出起始下标。
 * @param {Int32Array} schedule 轮密钥表。
 * @returns {void}
 */
function qrcDesCryptBlock(input, inputOffset, output, outputOffset, schedule) {
  var t = ensureQrcDesTables();
  var left = 0;
  var right = 0;
  for (var i = 0; i < 8; i++) {
    var idx = (i << 8) | input[inputOffset + i];
    left |= t.ipLeft[idx];
    right |= t.ipRight[idx];
  }
  for (var r = 0; r < 15; r++) {
    var temp = right;
    right = (left ^ qrcDesRound(right, schedule[r * 2], schedule[r * 2 + 1], t)) >>> 0;
    left = temp;
  }
  left = (left ^ qrcDesRound(right, schedule[30], schedule[31], t)) >>> 0;
  var outLeft = 0;
  var outRight = 0;
  for (var j = 0; j < 4; j++) {
    var idxL = (j << 8) | ((left >>> (24 - j * 8)) & 0xff);
    var idxR = ((j + 4) << 8) | ((right >>> (24 - j * 8)) & 0xff);
    outLeft |= t.invIpLeft[idxL] | t.invIpLeft[idxR];
    outRight |= t.invIpRight[idxL] | t.invIpRight[idxR];
  }
  output[outputOffset] = (outLeft >>> 24) & 0xff;
  output[outputOffset + 1] = (outLeft >>> 16) & 0xff;
  output[outputOffset + 2] = (outLeft >>> 8) & 0xff;
  output[outputOffset + 3] = outLeft & 0xff;
  output[outputOffset + 4] = (outRight >>> 24) & 0xff;
  output[outputOffset + 5] = (outRight >>> 16) & 0xff;
  output[outputOffset + 6] = (outRight >>> 8) & 0xff;
  output[outputOffset + 7] = outRight & 0xff;
}
var qrcDesDecryptSchedules = null;
/**
 * 十六进制字符的字节值转半字节。
 * @param {number} code ASCII 字节值。
 * @returns {number} 0-15；不是十六进制字符时返回 -1。
 */
function qrcHexNibble(code) {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}
/**
 * 识别 QRC 加密数据并取出待解密字节。两种在野形态都收：接口原样落盘的十六进制文本，
 * 以及直接写成二进制的密文。判定只看内容，所以后缀被改过也能认出来。
 * @param {ArrayBuffer|Uint8Array} buffer 文件原始字节。
 * @returns {Uint8Array|null} 待解密字节；不像 QRC 密文时返回 null。
 */
function qrcEncryptedPayloadBytes(buffer) {
  var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  if (bytes.length < 2 * QRC_DES_BLOCK_SIZE) return null;
  // 带 BOM 的一律是文本，不用往密文上猜。
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return null;
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return null;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return null;
  var nibbles = 0;
  var hexOnly = true;
  var hasControl = false;
  for (var i = 0; i < bytes.length; i++) {
    var code = bytes[i];
    if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20) continue;
    if (hexOnly) {
      if (qrcHexNibble(code) < 0) hexOnly = false;
      else nibbles++;
    }
    if (code < 0x20) hasControl = true;
  }
  if (hexOnly) {
    if (!nibbles || nibbles % (2 * QRC_DES_BLOCK_SIZE) !== 0) return null;
    var out = new Uint8Array(nibbles >> 1);
    var written = 0;
    var high = -1;
    for (var j = 0; j < bytes.length; j++) {
      var nibble = qrcHexNibble(bytes[j]);
      if (nibble < 0) continue;
      if (high < 0) { high = nibble; continue; }
      out[written++] = (high << 4) | nibble;
      high = -1;
    }
    return out;
  }
  // 不是十六进制文本时，只有“含控制字符且长度对齐分组”的才当二进制密文看。
  if (!hasControl || bytes.length % QRC_DES_BLOCK_SIZE !== 0) return null;
  return bytes;
}
/**
 * 逐分组跑 3DES 解密链 D(K3) → E(K2) → D(K1)。
 * @param {Uint8Array} bytes 长度为 8 的整数倍的密文。
 * @returns {Uint8Array} 解密结果。
 */
function qrc3desDecryptBytes(bytes) {
  if (!qrcDesDecryptSchedules) {
    qrcDesDecryptSchedules = [
      qrcDesKeySchedule(QRC_DES_KEY_3, true),
      qrcDesKeySchedule(QRC_DES_KEY_2, false),
      qrcDesKeySchedule(QRC_DES_KEY_1, true),
    ];
  }
  var out = new Uint8Array(bytes.length);
  var stage1 = new Uint8Array(QRC_DES_BLOCK_SIZE);
  var stage2 = new Uint8Array(QRC_DES_BLOCK_SIZE);
  for (var i = 0; i + QRC_DES_BLOCK_SIZE <= bytes.length; i += QRC_DES_BLOCK_SIZE) {
    qrcDesCryptBlock(bytes, i, stage1, 0, qrcDesDecryptSchedules[0]);
    qrcDesCryptBlock(stage1, 0, stage2, 0, qrcDesDecryptSchedules[1]);
    qrcDesCryptBlock(stage2, 0, out, i, qrcDesDecryptSchedules[2]);
  }
  return out;
}
/**
 * 还原 QRC 加密歌词：3DES 解密后解 zlib，并剥掉解压结果自带的 UTF-8 BOM。
 * @param {ArrayBuffer|Uint8Array} buffer 文件原始字节。
 * @returns {Promise<Uint8Array|null>} 明文字节；不是 QRC 密文或还原失败时返回 null。
 */
async function qrcDecryptedLyricBytes(buffer) {
  var payload = qrcEncryptedPayloadBytes(buffer);
  if (!payload) return null;
  var inflated = await inflateLyricBytes(qrc3desDecryptBytes(payload));
  if (!inflated || !inflated.length) return null;
  if (inflated.length >= 3 && inflated[0] === 0xef && inflated[1] === 0xbb && inflated[2] === 0xbf) {
    return inflated.subarray(3);
  }
  return inflated;
}
/**
 * 解码歌词文件字节：KRC 加密二进制先还原成明文，QRC 加密数据先过 3DES 再解压，
 * 其余一律走通用文本解码。按内容特征而不是后缀分流，所以改了后缀名的加密歌词也能读出来。
 * @param {ArrayBuffer|Uint8Array} buffer 文件字节。
 * @returns {Promise<string>} 歌词文本。
 */
async function decodeLyricFileBuffer(buffer) {
  var krcPayload = krcEncryptedPayloadBytes(buffer);
  if (krcPayload) {
    var krcPlain = await inflateLyricBytes(krcPayload);
    return krcPlain ? decodeLocalTextBuffer(krcPlain) : '';
  }
  var qrcPlain = await qrcDecryptedLyricBytes(buffer);
  if (qrcPlain) return decodeLocalTextBuffer(qrcPlain);
  return decodeLocalTextBuffer(buffer);
}
/**
 * 读取并解码本地歌词文件；KRC/QRC 加密歌词先解密解压，其余走通用文本解码。
 * @param {object} file 浏览器 File 或桌面本地文件记录。
 * @returns {Promise<string>} 歌词文本。
 */
async function readLocalLyricText(file) {
  if (!file) return '';
  var bytes = await readLocalTextFileBytes(file);
  return bytes ? await decodeLyricFileBuffer(bytes) : '';
}
function readFileAsDataUrl(file) {
  return new Promise(function(resolve){
    if (!file) { resolve(''); return; }
    var fullPath = localFullPath(file);
    var api = desktopLocalMusicApi();
    if (fullPath && api && typeof api.readLocalFileDataUrl === 'function') {
      api.readLocalFileDataUrl(fullPath).then(function(result){
        resolve(result && result.ok ? String(result.dataUrl || '') : '');
      }).catch(function(){ resolve(''); });
      return;
    }
    var reader = new FileReader();
    reader.onload = function(){ resolve(String(reader.result || '')); };
    reader.onerror = function(){ resolve(''); };
    reader.readAsDataURL(file);
  });
}
/**
 * 把主进程返回的 base64 分块直接写入唯一最终数组，避免整段 atob 二进制字符串峰值。
 * @param {Array<string>} chunks base64 字符串块。
 * @param {number} byteLength 预期总字节数。
 * @returns {Uint8Array} 完整文件范围字节。
 */
function base64ChunksToBytes(chunks, byteLength) {
  if (!Array.isArray(chunks)) throw new Error('LOCAL_FILE_RANGE_CHUNKS_INVALID');
  var expectedLength = Math.max(0, Number(byteLength) || 0);
  var bytes = new Uint8Array(expectedLength);
  var offset = 0;
  // 每块独立解码，使短命 binary 字符串上限由固定 IPC 块大小决定。
  for (var chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    var binary = atob(String(chunks[chunkIdx] || ''));
    if (offset + binary.length > expectedLength) throw new Error('LOCAL_FILE_RANGE_LENGTH_MISMATCH');
    for (var byteIdx = 0; byteIdx < binary.length; byteIdx++) bytes[offset + byteIdx] = binary.charCodeAt(byteIdx);
    offset += binary.length;
  }
  if (offset !== expectedLength) throw new Error('LOCAL_FILE_RANGE_LENGTH_MISMATCH');
  return bytes;
}
var localFileRangeReadBatches = [];
/**
 * 判断批次是否属于同一本地文件和同一起始偏移。
 * @param {object} batch 在途范围读取批次。
 * @param {object} file 本地 File 或桌面文件记录。
 * @param {string} fullPath 桌面文件绝对路径。
 * @param {number} start 起始字节偏移。
 * @returns {boolean} 是否可在同一批次内复用。
 */
function matchesLocalFileRangeReadBatch(batch, file, fullPath, start) {
  if (!batch || batch.start !== start) return false;
  if (batch.fullPath || fullPath) return !!batch.fullPath && batch.fullPath === fullPath;
  return batch.file === file;
}
/**
 * 判断已启动批次的读取范围能否覆盖新请求。
 * @param {number} batchStop 批次结束偏移；0 表示读取到文件结尾。
 * @param {number} requestedStop 新请求结束偏移；0 表示读取到文件结尾。
 * @returns {boolean} 已启动批次是否足以服务新请求。
 */
function localFileRangeReadCovers(batchStop, requestedStop) {
  if (!batchStop) return true;
  return !!requestedStop && requestedStop <= batchStop;
}
/**
 * 查找可合并的排队或在途范围读取批次。
 * @param {object} file 本地 File 或桌面文件记录。
 * @param {string} fullPath 桌面文件绝对路径。
 * @param {number} start 起始字节偏移。
 * @param {number} stop 结束字节偏移；0 表示读取到文件结尾。
 * @returns {object|null} 可复用批次。
 */
function findLocalFileRangeReadBatch(file, fullPath, start, stop) {
  for (var i = 0; i < localFileRangeReadBatches.length; i++) {
    var batch = localFileRangeReadBatches[i];
    if (!matchesLocalFileRangeReadBatch(batch, file, fullPath, start)) continue;
    if (!batch.started || localFileRangeReadCovers(batch.stop, stop)) return batch;
  }
  return null;
}
/**
 * 从全局在途表移除指定批次，避免完成后继续持有文件和等待者。
 * @param {object} batch 已完成或失败的范围读取批次。
 * @returns {void}
 */
function removeLocalFileRangeReadBatch(batch) {
  var index = localFileRangeReadBatches.indexOf(batch);
  if (index < 0) return;
  var last = localFileRangeReadBatches.pop();
  if (index < localFileRangeReadBatches.length) localFileRangeReadBatches[index] = last;
}
/**
 * 执行一次真实文件范围读取，不参与请求合并。
 * @param {object} file 本地 File 或桌面文件记录。
 * @param {number} start 起始字节偏移。
 * @param {number} stop 结束字节偏移；0 表示读取到文件结尾。
 * @returns {Promise<Uint8Array>} 读取到的字节。
 */
async function readLocalFileBytesDirect(file, start, stop) {
  if (file && file.slice) {
    return new Uint8Array(await file.slice(start, stop || undefined).arrayBuffer());
  }
  var fullPath = localFullPath(file);
  var api = desktopLocalMusicApi();
  if (!fullPath || !api || typeof api.readLocalFileRange !== 'function') return new Uint8Array();
  var result = await api.readLocalFileRange(fullPath, start, stop || null);
  return result && result.ok ? base64ChunksToBytes(result.base64Chunks, result.byteLength) : new Uint8Array();
}
/**
 * 用批次结果完成全部等待者；较小范围通过视图复用，不复制底层字节。
 * @param {object} batch 已取得最终字节的读取批次。
 * @param {Uint8Array} bytes 最大范围读取结果。
 * @returns {void}
 */
function resolveLocalFileRangeReadBatch(batch, bytes) {
  var waiters = batch.waiters;
  batch.waiters = [];
  for (var i = 0; i < waiters.length; i++) {
    var waiter = waiters[i];
    var requestedLength = waiter.stop ? Math.max(0, waiter.stop - batch.start) : bytes.length;
    waiter.resolve(requestedLength < bytes.length ? bytes.subarray(0, requestedLength) : bytes);
  }
}
/**
 * 用同一错误拒绝批次中的全部等待者。
 * @param {object} batch 读取失败的批次。
 * @param {*} error 底层读取错误。
 * @returns {void}
 */
function rejectLocalFileRangeReadBatch(batch, error) {
  var waiters = batch.waiters;
  batch.waiters = [];
  for (var i = 0; i < waiters.length; i++) waiters[i].reject(error);
}
/**
 * 在当前微任务轮收集完范围后启动唯一底层读取，并在完成后释放批次所有权。
 * @param {object} batch 待读取批次。
 * @returns {Promise<void>} 批次完成 Promise。
 */
async function startLocalFileRangeReadBatch(batch) {
  if (batch.started) return;
  batch.started = true;
  try {
    var bytes = await readLocalFileBytesDirect(batch.file, batch.start, batch.stop);
    removeLocalFileRangeReadBatch(batch);
    resolveLocalFileRangeReadBatch(batch, bytes);
  } catch (error) {
    removeLocalFileRangeReadBatch(batch);
    rejectLocalFileRangeReadBatch(batch, error);
  }
}
/**
 * 读取本地文件指定范围；浏览器 File 直接切片，桌面路径通过分块 IPC 解码。
 * @param {object} file 本地 File 或桌面文件记录。
 * @param {number} start 起始字节偏移。
 * @param {number|null} end 结束字节偏移，不含该位置。
 * @returns {Promise<Uint8Array>} 读取到的字节。
 */
async function readLocalFileBytes(file, start, end) {
  start = Math.max(0, Number(start) || 0);
  var size = localFileSize(file);
  var stop = end == null ? size : Math.max(start, Number(end) || 0);
  var fullPath = localFullPath(file);
  var batch = findLocalFileRangeReadBatch(file, fullPath, start, stop);
  if (!batch) {
    batch = {
      file: file,
      fullPath: fullPath,
      start: start,
      stop: stop,
      started: false,
      waiters: []
    };
    localFileRangeReadBatches.push(batch);
    Promise.resolve(batch).then(startLocalFileRangeReadBatch);
  } else if (!batch.started) {
    // 排队阶段允许扩大到最大范围，使同轮元数据、歌词和封面只触发一次底层读取。
    if (!batch.stop || !stop) batch.stop = 0;
    else if (stop > batch.stop) batch.stop = stop;
  }
  /**
   * 登记当前调用者需要的原始范围，批次完成时按该长度返回共享视图。
   * @param {Function} resolve Promise 完成函数。
   * @param {Function} reject Promise 拒绝函数。
   * @returns {void}
   */
  function registerLocalFileRangeReadWaiter(resolve, reject) {
    batch.waiters.push({ stop: stop, resolve: resolve, reject: reject });
  }
  return new Promise(registerLocalFileRangeReadWaiter);
}
var FLAC_METADATA_INITIAL_PROBE_BYTES = 8;
var FLAC_METADATA_FALLBACK_PROBE_BYTES = 4096 + 8;
var FLAC_METADATA_SESSION_MAX_BLOCKS = 1024;
var localFlacMetadataSessionReadBatches = [];
/**
 * 查找可复用的 FLAC metadata 目录扫描批次。
 * @param {object} file 本地 File 或桌面文件记录。
 * @param {string} fullPath 桌面文件绝对路径。
 * @param {number} maxScan 本轮允许扫描的最大绝对偏移。
 * @returns {object|null} 可复用批次；已启动轻量批次不能服务完整请求。
 */
function findLocalFlacMetadataSessionReadBatch(file, fullPath, maxScan) {
  for (var i = 0; i < localFlacMetadataSessionReadBatches.length; i++) {
    var batch = localFlacMetadataSessionReadBatches[i];
    if (!matchesLocalFileRangeReadBatch(batch, file, fullPath, 0)) continue;
    if (!batch.started || batch.maxScan >= maxScan) return batch;
  }
  return null;
}
/**
 * 从全局表移除已完成的 FLAC metadata 目录批次。
 * @param {object} batch 已完成或失败的批次。
 * @returns {void}
 */
function removeLocalFlacMetadataSessionReadBatch(batch) {
  var index = localFlacMetadataSessionReadBatches.indexOf(batch);
  if (index < 0) return;
  var last = localFlacMetadataSessionReadBatches.pop();
  if (index < localFlacMetadataSessionReadBatches.length) localFlacMetadataSessionReadBatches[index] = last;
}
/**
 * 只读取 FLAC marker、block 头部和长度，跳过无消费者的 PADDING payload。
 * @param {object} file 本地 File 或桌面文件记录。
 * @param {number} maxScan 轻量或完整扫描的绝对偏移上限。
 * @returns {Promise<object>} 只含小探针和 block descriptor 的短生命周期会话。
 */
async function readFlacMetadataSessionDirect(file, maxScan) {
  var fileSize = localFileSize(file) || 0;
  var limit = Math.min(fileSize || maxScan, maxScan);
  var probeBytes = new Uint8Array();
  if (limit > 0) probeBytes = await readLocalFileBytes(file, 0, Math.min(limit, FLAC_METADATA_INITIAL_PROBE_BYTES));
  var metadataStart = asciiFromBytes(probeBytes, 0, 4) === 'fLaC' ? 4 : -1;
  if (metadataStart < 0 && limit > probeBytes.length) {
    probeBytes = await readLocalFileBytes(file, 0, Math.min(limit, FLAC_METADATA_FALLBACK_PROBE_BYTES));
    metadataStart = findFlacMetadataStart(probeBytes);
  }
  var blocks = [];
  var resolvedStop = metadataStart >= 0 ? metadataStart : probeBytes.length;
  var reachedLastBlock = false;
  var pos = metadataStart;
  var blockCount = 0;
  while (pos >= 0 && pos + 4 <= limit && blockCount < FLAC_METADATA_SESSION_MAX_BLOCKS) {
    var headerBytes = probeBytes;
    var headerOffset = pos;
    if (pos + 4 > probeBytes.length) {
      headerBytes = await readLocalFileBytes(file, pos, pos + 4);
      headerOffset = 0;
    }
    if (headerOffset + 4 > headerBytes.length) break;
    var header = headerBytes[headerOffset];
    var length = uint24BE(headerBytes, headerOffset + 1);
    var payloadStart = pos + 4;
    var payloadEnd = payloadStart + length;
    // 轻量上限、文件末尾或损坏长度之外不生成 descriptor，消费者因此保持可重试。
    if (payloadEnd < payloadStart || payloadEnd > limit) break;
    var last = !!(header & 0x80);
    blocks.push({
      type: header & 0x7f,
      last: last,
      length: length,
      payloadStart: payloadStart,
      payloadEnd: payloadEnd
    });
    resolvedStop = payloadEnd;
    blockCount++;
    if (last) {
      reachedLastBlock = true;
      break;
    }
    pos = payloadEnd;
  }
  return {
    probeBytes: probeBytes,
    metadataStart: metadataStart,
    blocks: blocks,
    resolvedStop: resolvedStop,
    reachedLastBlock: reachedLastBlock,
    fullyRead: !!(fileSize && (probeBytes.length >= fileSize || resolvedStop >= fileSize))
  };
}
/**
 * 读取单个 FLAC metadata block payload；探针内直接返回共享视图，探针外只读精确范围。
 * @param {object} file 本地 File 或桌面文件记录。
 * @param {object} session metadata 目录扫描结果。
 * @param {object} block 目标 block descriptor。
 * @returns {Promise<Uint8Array|null>} 完整 payload；短读时返回 null。
 */
async function readFlacMetadataBlockBytes(file, session, block) {
  if (block.payloadStart >= 0 && block.payloadEnd <= session.probeBytes.length) {
    return session.probeBytes.subarray(block.payloadStart, block.payloadEnd);
  }
  var bytes = await readLocalFileBytes(file, block.payloadStart, block.payloadEnd);
  return bytes.length === block.length ? bytes : null;
}
/**
 * 用同一 descriptor 会话完成共享批次中的全部 FLAC 消费者。
 * @param {object} batch 已完成扫描的共享批次。
 * @param {object} session metadata descriptor 会话。
 * @returns {void}
 */
function resolveLocalFlacMetadataSessionReadBatch(batch, session) {
  var waiters = batch.waiters;
  batch.waiters = [];
  for (var i = 0; i < waiters.length; i++) waiters[i].resolve(session);
}
/**
 * 用同一底层错误拒绝共享批次中的全部 FLAC 消费者。
 * @param {object} batch 读取失败的共享批次。
 * @param {*} error 底层读取错误。
 * @returns {void}
 */
function rejectLocalFlacMetadataSessionReadBatch(batch, error) {
  var waiters = batch.waiters;
  batch.waiters = [];
  for (var i = 0; i < waiters.length; i++) waiters[i].reject(error);
}
/**
 * 在当前微任务轮收集 light/full 需求后启动唯一 FLAC metadata 目录扫描。
 * @param {object} batch 待执行的共享批次。
 * @returns {Promise<void>} 批次完成 Promise。
 */
async function startLocalFlacMetadataSessionReadBatch(batch) {
  if (batch.started) return;
  batch.started = true;
  try {
    var session = await readFlacMetadataSessionDirect(batch.file, batch.maxScan);
    removeLocalFlacMetadataSessionReadBatch(batch);
    resolveLocalFlacMetadataSessionReadBatch(batch, session);
  } catch (error) {
    removeLocalFlacMetadataSessionReadBatch(batch);
    rejectLocalFlacMetadataSessionReadBatch(batch, error);
  }
}
/**
 * 为 FLAC 元数据、歌词和封面共享一次短生命周期的 descriptor 扫描。
 * @param {object} file 本地 File 或桌面文件记录。
 * @param {{light?:boolean}=} opts 是否限制在后台轻量扫描边界内。
 * @returns {Promise<object>} metadata descriptor 会话；不包含完整连续前缀。
 */
function readFlacMetadataSession(file, opts) {
  opts = opts || {};
  var maxScan = opts.light ? LOCAL_ASSET_LIGHT_SCAN_BYTES : 32 * 1024 * 1024;
  var fullPath = localFullPath(file);
  var batch = findLocalFlacMetadataSessionReadBatch(file, fullPath, maxScan);
  if (!batch) {
    batch = {
      file: file,
      fullPath: fullPath,
      start: 0,
      maxScan: maxScan,
      started: false,
      waiters: []
    };
    localFlacMetadataSessionReadBatches.push(batch);
    Promise.resolve(batch).then(startLocalFlacMetadataSessionReadBatch);
  } else if (!batch.started && maxScan > batch.maxScan) {
    // 同一微任务轮出现前台请求时，把尚未启动的轻量扫描提升为完整扫描。
    batch.maxScan = maxScan;
  }
  /**
   * 登记需要共享本轮 FLAC metadata descriptor 的调用者。
   * @param {Function} resolve Promise 完成函数。
   * @param {Function} reject Promise 拒绝函数。
   * @returns {void}
   */
  function registerLocalFlacMetadataSessionWaiter(resolve, reject) {
    batch.waiters.push({ resolve: resolve, reject: reject });
  }
  return new Promise(registerLocalFlacMetadataSessionWaiter);
}
function asciiFromBytes(bytes, start, len) {
  var out = '';
  for (var i = 0; i < len && start + i < bytes.length; i++) out += String.fromCharCode(bytes[start + i]);
  return out;
}
function synchsafeInt(bytes, offset) {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}
function uint24BE(bytes, offset) {
  return ((bytes[offset] || 0) << 16) | ((bytes[offset + 1] || 0) << 8) | (bytes[offset + 2] || 0);
}
function uint32BE(bytes, offset) {
  return ((bytes[offset] || 0) * 0x1000000) + (((bytes[offset + 1] || 0) << 16) | ((bytes[offset + 2] || 0) << 8) | (bytes[offset + 3] || 0));
}
function uint32LE(bytes, offset) {
  return (bytes[offset] || 0) + ((bytes[offset + 1] || 0) * 0x100) + ((bytes[offset + 2] || 0) * 0x10000) + ((bytes[offset + 3] || 0) * 0x1000000);
}
/**
 * 读取小端 16 位无符号整数。
 * @param {Uint8Array} bytes 字节。
 * @param {number} offset 起始偏移。
 * @returns {number} 读取到的数值。
 */
function uint16LE(bytes, offset) {
  return (bytes[offset] || 0) + ((bytes[offset + 1] || 0) * 0x100);
}
/**
 * 读取小端 64 位无符号整数；超过 2^53 的值会损失精度，音频头部不会出现。
 * @param {Uint8Array} bytes 字节。
 * @param {number} offset 起始偏移。
 * @returns {number} 读取到的数值。
 */
function uint64LE(bytes, offset) {
  return uint32LE(bytes, offset) + uint32LE(bytes, offset + 4) * 4294967296;
}
function utf8FromBytes(bytes, start, len) {
  return decodeBytesWithEncoding(bytes.subarray(start, start + len), 'utf-8');
}
var localTextDecoderCache = Object.create(null);
function localTextDecoder(encoding) {
  encoding = encoding || 'utf-8';
  if (!localTextDecoderCache[encoding]) localTextDecoderCache[encoding] = new TextDecoder(encoding);
  return localTextDecoderCache[encoding];
}
function decodeBytesWithEncoding(bytes, encoding) {
  try {
    return localTextDecoder(encoding).decode(bytes).replace(/^\uFEFF/, '');
  } catch (e) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
}
var localStrictUtf8Decoder;
/**
 * 严格 UTF-8 解码；遇到非法字节序列会抛错，用于判定标签是否真的是 UTF-8。
 * @param {Uint8Array} bytes 待解码字节。
 * @returns {string} 解码结果。
 */
function decodeStrictUtf8Bytes(bytes) {
  if (localStrictUtf8Decoder === undefined) {
    try {
      localStrictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
    } catch (e) {
      localStrictUtf8Decoder = null;
    }
  }
  if (!localStrictUtf8Decoder) throw new Error('STRICT_UTF8_UNAVAILABLE');
  return localStrictUtf8Decoder.decode(bytes).replace(/^\uFEFF/, '');
}
/**
 * 解码历史遗留编码的标签文本（ID3v1、ID3v2 latin1 帧、RIFF INFO）。
 * 纯 ASCII 与 UTF-8 走严格解码；否则按中文标签最常见的 GBK 处理，仍失败才退回 latin1。
 * @param {Uint8Array} bytes 待解码字节。
 * @returns {string} 解码结果。
 */
function decodeLegacyTagText(bytes) {
  if (!bytes || !bytes.length) return '';
  try {
    return decodeStrictUtf8Bytes(bytes);
  } catch (e) {}
  var gbk = decodeBytesWithEncoding(bytes, 'gbk');
  // 含替换字符说明不是 GBK，多为西欧 latin1 标签。
  if (gbk && gbk.indexOf('\ufffd') < 0) return gbk;
  return decodeBytesWithEncoding(bytes, 'latin1');
}
/**
 * 按 ID3v2 编码字节解码指定区间文本。
 * @param {Uint8Array} bytes 标签字节。
 * @param {number} start 文本起始偏移。
 * @param {number} end 文本结束偏移，不含该位置。
 * @param {number} enc ID3v2 编码标识。
 * @returns {string} 解码结果。
 */
function decodeId3TextWithEncoding(bytes, start, end, enc) {
  if (start >= end) return '';
  var body = bytes.subarray(start, end);
  if (enc === 1) {
    if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return decodeBytesWithEncoding(body.subarray(2), 'utf-16be');
    if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return decodeBytesWithEncoding(body.subarray(2), 'utf-16le');
    return decodeBytesWithEncoding(body, 'utf-16le');
  }
  if (enc === 2) return decodeBytesWithEncoding(body, 'utf-16be');
  if (enc === 3) return decodeBytesWithEncoding(body, 'utf-8');
  return decodeLegacyTagText(body);
}
function decodeId3TextFrame(bytes, start, end) {
  if (start >= end) return '';
  return decodeId3TextWithEncoding(bytes, start + 1, end, bytes[start] || 0);
}
// ID3v1 数字流派表：ID3v2 的 TCON 允许写成 "(17)" 或裸数字，M4A 的 gnre atom 也是 1-based 数字，
// 没有这张表就只能把 "(17)" 原样显示给用户。索引 133 的原始名称是种族歧视词，这里换成通行的 Afro-Punk。
var ID3V1_GENRE_NAMES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop',
  'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap',
  'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks',
  'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance',
  'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
  'AlternRock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock',
  'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream',
  'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle',
  'Native American', 'Cabaret', 'New Wave', 'Psychadelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi',
  'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
  'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebob', 'Latin', 'Revival',
  'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock',
  'Big Band', 'Chorus', 'Easy Listening', 'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera',
  'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove', 'Satire', 'Slow Jam',
  'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle',
  'Duet', 'Punk Rock', 'Drum Solo', 'A capella', 'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass',
  'Club-House', 'Hardcore', 'Terror', 'Indie', 'BritPop', 'Afro-Punk', 'Polsk Punk', 'Beat',
  'Christian Gangsta Rap', 'Heavy Metal', 'Black Metal', 'Crossover', 'Contemporary Christian', 'Christian Rock', 'Merengue', 'Salsa',
  'Thrash Metal', 'Anime', 'JPop', 'Synthpop', 'Abstract', 'Art Rock', 'Baroque', 'Bhangra',
  'Big Beat', 'Breakbeat', 'Chillout', 'Downtempo', 'Dub', 'EBM', 'Eclectic', 'Electro',
  'Electroclash', 'Emo', 'Experimental', 'Garage', 'Global', 'IDM', 'Illbient', 'Industro-Goth',
  'Jam Band', 'Krautrock', 'Leftfield', 'Lounge', 'Math Rock', 'New Romantic', 'Nu-Breakz', 'Post-Punk',
  'Post-Rock', 'Psytrance', 'Shoegaze', 'Space Rock', 'Trop Rock', 'World Music', 'Neoclassical', 'Audiobook',
  'Audio Theatre', 'Neue Deutsche Welle', 'Podcast', 'Indie Rock', 'G-Funk', 'Dubstep', 'Garage Rock', 'Psybient',
];
function normalizeLocalMetadataValue(value) {
  return String(value || '')
    .replace(/\u0000+/g, ' / ')
    .replace(/\s+/g, ' ')
    .replace(/\s+\/\s+/g, ' / ')
    .trim();
}
function isLocalSourcePlaceholderMetadata(value) {
  var normalized = String(value || '')
    .toLowerCase()
    .replace(/[\s._\-]+/g, '')
    .replace(/[（(【\[]/g, '')
    .replace(/[）)】\]]/g, '');
  return normalized === 'kuwo'
    || normalized === '酷我'
    || normalized === '酷我音乐'
    || normalized === 'kugou'
    || normalized === '酷狗'
    || normalized === 'qqmusic'
    || normalized === 'qq音乐'
    || normalized === 'netease'
    || normalized === '网易云音乐';
}
function putLocalMetadataTag(tags, key, value) {
  value = normalizeLocalMetadataValue(value);
  if (!value) return;
  if (key === 'title' && !tags.title) tags.title = value;
  else if (key === 'artist' && !tags.artist) tags.artist = value;
  else if (key === 'album' && !tags.album) tags.album = value;
  else if (key === 'albumArtist' && !tags.albumArtist) tags.albumArtist = value;
  else if (key === 'genre') {
    var genreName = normalizeLocalMetadataGenre(value);
    if (genreName && !tags.genre) tags.genre = genreName;
  }
  else if (key === 'track' && !tags.track) tags.track = value;
  else if (key === 'year' && !tags.year) tags.year = value;
}
/**
 * 归一化流派文本。ID3v1 数字流派会被写成 "(17)" 或裸数字，需要还原成可读名称。
 * @param {string} value 原始流派文本。
 * @returns {string} 可展示的流派名称。
 */
function normalizeLocalMetadataGenre(value) {
  var text = String(value || '').trim();
  if (!text) return '';
  var numeric = /^\(?(\d{1,3})\)?$/.exec(text);
  if (numeric) {
    var name = ID3V1_GENRE_NAMES[Number(numeric[1])];
    return name || '';
  }
  // "(17)Rock" 这类前缀式写法保留后面的可读名称。
  var prefixed = /^\((\d{1,3})\)\s*(.+)$/.exec(text);
  if (prefixed) return String(prefixed[2] || '').trim();
  return text;
}
function id3TextFrameKey(id) {
  switch (id) {
    case 'TIT2':
    case 'TT2':
      return 'title';
    case 'TPE1':
    case 'TP1':
      return 'artist';
    case 'TALB':
    case 'TAL':
      return 'album';
    case 'TPE2':
    case 'TP2':
      return 'albumArtist';
    case 'TCON':
    case 'TCO':
      return 'genre';
    case 'TRCK':
    case 'TRK':
      return 'track';
    case 'TYER':
    case 'TDRC':
    case 'TYE':
      return 'year';
    default:
      return '';
  }
}
/**
 * 读取 MP3 文件头部的完整 ID3v2 标签字节。
 * @param {File|object} file 本地 MP3 文件记录。
 * @returns {Promise<Uint8Array>} 标签字节；没有标签时长度为 0。
 */
async function readMp3Id3v2Bytes(file) {
  var result = await readId3v2TagBytes(file, 0, ID3_MAX_TAG_BYTES);
  return result.bytes;
}
/**
 * 解析 MP3 ID3v2 展示元数据。
 * @param {File|object} file 本地 MP3 文件记录。
 * @returns {Promise<object>} 标签对象。
 */
async function extractMp3LocalMetadata(file) {
  var bytes = await readMp3Id3v2Bytes(file);
  return bytes.length ? parseId3v2Tags(bytes, 0, {}) : {};
}
// ReplayGain 标签解析：REPLAYGAIN_* 文本项、ID3v2 TXXX/RVA2、APEv2 项与 MP4 `----` 自定义项共用同一套字段名与取值规则。
var REPLAY_GAIN_TAG_DB_LIMIT = 60;
var REPLAY_GAIN_TAG_PEAK_LIMIT = 64;
// R128 以 -23 LUFS 为参考，ReplayGain 以 -18 LUFS 为参考，换算时补足 5 dB。
var REPLAY_GAIN_R128_REFERENCE_OFFSET_DB = 5;
/**
 * 把任意来源的 ReplayGain 标签名映射到统一字段名。
 * @param {string} key 原始标签名。
 * @returns {string} 统一字段名；不是 ReplayGain 标签时返回空字符串。
 */
function replayGainTagField(key) {
  var flat = String(key == null ? '' : key).replace(/[\s_\-.]/g, '').toUpperCase();
  if (flat === 'REPLAYGAINTRACKGAIN') return 'trackGainDb';
  if (flat === 'REPLAYGAINTRACKPEAK') return 'trackPeak';
  if (flat === 'REPLAYGAINALBUMGAIN') return 'albumGainDb';
  if (flat === 'REPLAYGAINALBUMPEAK') return 'albumPeak';
  if (flat === 'R128TRACKGAIN') return 'r128TrackGainDb';
  if (flat === 'R128ALBUMGAIN') return 'r128AlbumGainDb';
  return '';
}
/**
 * 写入一个 ReplayGain 字段，按“首个可解析值胜出”处理重复标签。
 * @param {object} target ReplayGain 原始值容器。
 * @param {string} field 统一字段名。
 * @param {*} value 原始标签值。
 * @returns {boolean} 是否写入成功。
 */
function putReplayGainTag(target, field, value) {
  if (!target || !field) return false;
  if (Object.prototype.hasOwnProperty.call(target, field)) return false;
  var parsed = null;
  if (field === 'trackPeak' || field === 'albumPeak') parsed = parseReplayGainPeak(value);
  else if (field === 'r128TrackGainDb' || field === 'r128AlbumGainDb') parsed = parseReplayGainR128(value);
  else parsed = parseReplayGainDb(value);
  if (parsed == null) return false;
  target[field] = parsed;
  return true;
}
/**
 * 惰性创建标签结果上的 ReplayGain 原始值容器。
 * @param {object} tags 标签结果对象。
 * @returns {object} ReplayGain 原始值容器。
 */
function localMetadataReplayGainTarget(tags) {
  if (!tags.replayGain || typeof tags.replayGain !== 'object') tags.replayGain = {};
  return tags.replayGain;
}
/**
 * 解析 ReplayGain 增益文本，接受 "-7.06 dB"、"+3.2dB" 与裸数字，并拒绝明显越界值。
 * @param {*} value 原始增益值。
 * @returns {number|null} 增益 dB；无法解析时返回 null。
 */
function parseReplayGainDb(value) {
  if (typeof value === 'number') {
    return isFinite(value) && Math.abs(value) <= REPLAY_GAIN_TAG_DB_LIMIT ? value : null;
  }
  var text = String(value == null ? '' : value).trim();
  if (!text) return null;
  var match = /^([+-]?\d+(?:\.\d+)?)\s*(?:db)?$/i.exec(text);
  if (!match) return null;
  var db = Number(match[1]);
  if (!isFinite(db) || Math.abs(db) > REPLAY_GAIN_TAG_DB_LIMIT) return null;
  return db;
}
/**
 * 解析 ReplayGain 峰值文本。峰值以 1.0 为满刻度，超过上限说明标签损坏。
 * @param {*} value 原始峰值。
 * @returns {number|null} 峰值；无法解析时返回 null。
 */
function parseReplayGainPeak(value) {
  var peak = typeof value === 'number' ? value : Number(String(value == null ? '' : value).trim());
  if (!isFinite(peak) || peak <= 0 || peak > REPLAY_GAIN_TAG_PEAK_LIMIT) return null;
  return peak;
}
/**
 * 解析 Opus R128 增益（Q7.8 定点整数），并换算到 ReplayGain 的参考响度。
 * @param {*} value 原始 R128 值。
 * @returns {number|null} 增益 dB；无法解析时返回 null。
 */
function parseReplayGainR128(value) {
  var text = String(value == null ? '' : value).trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  var db = Number(text) / 256 + REPLAY_GAIN_R128_REFERENCE_OFFSET_DB;
  if (!isFinite(db) || Math.abs(db) > REPLAY_GAIN_TAG_DB_LIMIT) return null;
  return db;
}
/**
 * 把原始 ReplayGain 标签整理成播放端可直接使用的结构，真实 ReplayGain 优先于 R128 折算值。
 * @param {object} raw 原始值容器。
 * @returns {object|null} 归一化结果；没有任何可用增益时返回 null。
 */
function normalizeReplayGainInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var info = { resolved: 1 };
  var trackGain = typeof raw.trackGainDb === 'number' ? raw.trackGainDb : raw.r128TrackGainDb;
  var albumGain = typeof raw.albumGainDb === 'number' ? raw.albumGainDb : raw.r128AlbumGainDb;
  if (typeof trackGain === 'number' && isFinite(trackGain)) info.trackGainDb = Math.round(trackGain * 1000) / 1000;
  if (typeof albumGain === 'number' && isFinite(albumGain)) info.albumGainDb = Math.round(albumGain * 1000) / 1000;
  if (typeof raw.trackPeak === 'number' && isFinite(raw.trackPeak)) info.trackPeak = Math.round(raw.trackPeak * 1000000) / 1000000;
  if (typeof raw.albumPeak === 'number' && isFinite(raw.albumPeak)) info.albumPeak = Math.round(raw.albumPeak * 1000000) / 1000000;
  if (typeof info.trackGainDb !== 'number' && typeof info.albumGainDb !== 'number') return null;
  return info;
}
/**
 * 收尾标签结果里的 ReplayGain：仅在整文件扫描完成时落盘，避免轻量扫描写入半截标签。
 * @param {object} tags 标签结果对象。
 * @returns {object} 原样返回的标签结果对象。
 */
function finalizeLocalMetadataReplayGain(tags) {
  if (!tags || typeof tags !== 'object') return tags;
  if (!tags.replayGain) return tags;
  var normalized = tags._mineradioScanComplete === false ? null : normalizeReplayGainInfo(tags.replayGain);
  if (normalized) tags.replayGain = normalized;
  else delete tags.replayGain;
  return tags;
}
/**
 * 把 Vorbis comment key 映射到播放器展示元数据字段。
 * @param {string} key 原始 Vorbis 字段名。
 * @returns {string} 播放器字段名；无消费者的排序字段返回空字符串。
 */
function vorbisCommentKey(key) {
  key = String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (key === 'TITLE') return 'title';
  if (key === 'ARTIST' || key === 'PERFORMER') return 'artist';
  if (key === 'ALBUM') return 'album';
  if (key === 'ALBUMARTIST') return 'albumArtist';
  if (key === 'GENRE') return 'genre';
  if (key === 'TRACKNUMBER' || key === 'TRACK') return 'track';
  if (key === 'DATE' || key === 'YEAR') return 'year';
  return '';
}
/**
 * 在指定字节范围内查找单字节分隔符，避免为判断 Vorbis key 先解码完整 value。
 * @param {Uint8Array} bytes 待扫描字节。
 * @param {number} start 起始偏移。
 * @param {number} end 结束偏移，不含该位置。
 * @param {number} value 目标单字节值。
 * @returns {number} 首个匹配偏移，未找到时返回 -1。
 */
function findByteInRange(bytes, start, end, value) {
  // Vorbis key/value 分隔符是单字节 ASCII，直接扫描可隔离大型无关 value。
  for (var i = start; i < end; i++) {
    if (bytes[i] === value) return i;
  }
  return -1;
}
/**
 * 把单个 VORBIS_COMMENT payload 合并到跨 block 的展示元数据结果。
 * @param {Uint8Array} bytes 完整 Vorbis payload。
 * @param {object} tags 跨 block 复用的标签结果。
 * @returns {void}
 */
function parseFlacMetadataVorbisPayload(bytes, tags) {
  var end = bytes.length;
  if (end <= 8) return;
  var p = 0;
  var vendorLen = uint32LE(bytes, p); p += 4 + vendorLen;
  if (p + 4 > end) return;
  var count = Math.min(uint32LE(bytes, p), 10000); p += 4;
  for (var i = 0; i < count && p + 4 <= end; i++) {
    var commentLen = uint32LE(bytes, p); p += 4;
    // 只有越界才说明 block 损坏；零长度 comment 仅跳过当前计数项。
    if (p + commentLen > end) break;
    if (!commentLen) continue;
    var commentStart = p;
    var commentEnd = p + commentLen;
    p = commentEnd;
    var eq = findByteInRange(bytes, commentStart, commentEnd, 61);
    if (eq <= commentStart) continue;
    var rawKey = utf8FromBytes(bytes, commentStart, eq - commentStart);
    var rgField = replayGainTagField(rawKey);
    if (rgField) {
      putReplayGainTag(localMetadataReplayGainTarget(tags), rgField, utf8FromBytes(bytes, eq + 1, commentEnd - eq - 1));
      continue;
    }
    var key = vorbisCommentKey(rawKey);
    if (!key || tags[key]) continue;
    putLocalMetadataTag(tags, key, utf8FromBytes(bytes, eq + 1, commentEnd - eq - 1));
  }
}
/**
 * 解析 FLAC Vorbis 展示元数据，并标记轻量范围是否足以得出最终结果。
 * @param {File|object} file 本地 FLAC 文件记录。
 * @param {{light?:boolean}=} opts 是否限制为后台轻量读取范围。
 * @returns {Promise<object>} 标签对象；`_mineradioScanComplete=false` 表示需要完整重试。
 */
async function extractFlacLocalMetadata(file, opts) {
  opts = opts || {};
  var session = await readFlacMetadataSession(file, opts);
  var tags = {};
  if (session.metadataStart < 0) {
    tags._mineradioScanComplete = session.fullyRead;
    return tags;
  }
  var commentResolved = false;
  var payloadIncomplete = false;
  for (var blockIndex = 0; blockIndex < session.blocks.length; blockIndex++) {
    var block = session.blocks[blockIndex];
    if (block.type !== 4) continue;
    var bytes = await readFlacMetadataBlockBytes(file, session, block);
    if (!bytes) {
      payloadIncomplete = true;
      break;
    }
    commentResolved = true;
    parseFlacMetadataVorbisPayload(bytes, tags);
  }
  tags._mineradioScanComplete = !payloadIncomplete && (commentResolved || session.reachedLastBlock || session.fullyRead);
  return tags;
}
var M4A_MAX_ATOM_HEADERS = 4096;
var M4A_MAX_TEXT_BYTES = 1024 * 1024;
var M4A_MAX_COVER_BYTES = 64 * 1024 * 1024;
var localM4aMetadataSessionBatches = [];
/**
 * 读取 MP4/M4A atom 头，支持普通尺寸、扩展尺寸和延伸到父容器末尾的零尺寸。
 * @param {File|object} file 本地 M4A 文件记录。
 * @param {number} offset atom 起始绝对偏移。
 * @param {number} parentEnd 父容器结束偏移，不含该位置。
 * @returns {Promise<object|null>} atom 描述；短读或越界时返回 null。
 */
async function readM4aAtomHeader(file, offset, parentEnd) {
  var head = await readLocalFileBytes(file, offset, Math.min(parentEnd, offset + 16));
  if (head.length < 8) return null;
  var size32 = uint32BE(head, 0);
  var type = asciiFromBytes(head, 4, 4);
  var headerSize = 8;
  var size = size32;
  if (size32 === 1) {
    if (head.length < 16) return null;
    var high = uint32BE(head, 8);
    var low = uint32BE(head, 12);
    size = high * 0x100000000 + low;
    headerSize = 16;
  } else if (size32 === 0) {
    size = parentEnd - offset;
  }
  if (!type || !Number.isSafeInteger(size) || size < headerSize || offset + size > parentEnd) return null;
  return { type: type, offset: offset, headerSize: headerSize, size: size, end: offset + size };
}
/**
 * 查找 M4A 顶层 moov atom；扫描只读取各顶层 atom 头，不读取 mdat 音频数据。
 * @param {File|object} file 本地 M4A 文件记录。
 * @param {{light?:boolean}=} opts 是否限制后台轻量扫描范围。
 * @returns {Promise<object>} moov 描述及扫描完成状态。
 */
async function readM4aMoovDescriptor(file, opts) {
  opts = opts || {};
  var fileSize = localFileSize(file) || 0;
  var scanLimit = opts.light ? Math.min(fileSize, LOCAL_ASSET_LIGHT_SCAN_BYTES) : fileSize;
  var pos = 0;
  var count = 0;
  while (pos + 8 <= fileSize && pos < scanLimit && count++ < M4A_MAX_ATOM_HEADERS) {
    var atom = await readM4aAtomHeader(file, pos, fileSize);
    if (!atom) return { moov: null, complete: false };
    if (atom.type === 'moov') {
      // 轻量范围只覆盖到 moov 头时不进入容器，避免后台一次性读取完整 metadata。
      if (atom.end > scanLimit) return { moov: null, complete: false };
      return { moov: atom, complete: atom.end <= scanLimit };
    }
    pos = atom.end;
    if (pos > scanLimit) return { moov: null, complete: false };
  }
  return { moov: null, complete: pos >= fileSize };
}
/**
 * 在 moov/udta/meta 容器路径中定位 ilst，跳过不包含展示标签的音频轨道 atom。
 * @param {File|object} file 本地 M4A 文件记录。
 * @param {object} container 当前容器 atom。
 * @param {number} depth 当前递归层级。
 * @returns {Promise<object|null>} ilst atom 描述；未找到时返回 null。
 */
async function findM4aIlstAtom(file, container, depth) {
  if (!container || depth > 4) return null;
  var childStart = container.offset + container.headerSize + (container.type === 'meta' ? 4 : 0);
  var childCount = 0;
  while (childStart + 8 <= container.end && childCount++ < M4A_MAX_ATOM_HEADERS) {
    var child = await readM4aAtomHeader(file, childStart, container.end);
    if (!child) return null;
    if (child.type === 'ilst') return child;
    if (child.type === 'moov' || child.type === 'udta' || child.type === 'meta') {
      var nested = await findM4aIlstAtom(file, child, depth + 1);
      if (nested) return nested;
    }
    childStart = child.end;
  }
  return null;
}
/**
 * 读取并缓存一次 M4A metadata 目录描述，合并同一文件的并发元数据和封面请求。
 * @param {File|object} file 本地 M4A 文件记录。
 * @param {{light?:boolean}=} opts 是否限制后台轻量扫描范围。
 * @returns {Promise<object>} ilst 描述与是否完成扫描。
 */
function readM4aMetadataSession(file, opts) {
  opts = opts || {};
  var fullPath = localFullPath(file);
  var light = !!opts.light;
  for (var i = 0; i < localM4aMetadataSessionBatches.length; i++) {
    var cached = localM4aMetadataSessionBatches[i];
    if (cached.file !== file && (!fullPath || cached.fullPath !== fullPath)) continue;
    // 前台完整解析不能复用后台轻量批次，否则 moov 跨范围时会把空结果误当成最终结果。
    if (light || !cached.light) return cached.promise;
  }
  var batch = {
    file: file,
    fullPath: fullPath,
    light: light,
    complete: false,
    promise: null
  };
  batch.promise = (async function(){
    var descriptor = await readM4aMoovDescriptor(file, { light: light });
    if (!descriptor.moov) return { ilst: null, complete: descriptor.complete };
    var ilst = await findM4aIlstAtom(file, descriptor.moov, 0);
    return { ilst: ilst, complete: descriptor.complete };
  })().finally(function(){
    var index = localM4aMetadataSessionBatches.indexOf(batch);
    if (index >= 0) localM4aMetadataSessionBatches.splice(index, 1);
  });
  localM4aMetadataSessionBatches.push(batch);
  return batch.promise;
}
/**
 * 读取 M4A ilst 项中的 data 子 atom。
 * @param {File|object} file 本地 M4A 文件记录。
 * @param {object} item ilst 项 atom。
 * @returns {Promise<object|null>} data atom 描述及数据起止偏移。
 */
async function readM4aItemDataAtom(file, item) {
  var pos = item.offset + item.headerSize;
  while (pos + 8 <= item.end) {
    var child = await readM4aAtomHeader(file, pos, item.end);
    if (!child) return null;
    if (child.type === 'data') {
      // 标准 data atom 的类型指示器和区域指示器各占 4 字节，值从 payload 第 8 字节开始。
      var dataStart = child.offset + child.headerSize + 8;
      if (dataStart > child.end) return null;
      var dataTypeBytes = await readLocalFileBytes(file, child.offset + child.headerSize, child.offset + child.headerSize + 4);
      var dataType = dataTypeBytes.length === 4 ? uint24BE(dataTypeBytes, 1) : 0;
      return { atom: child, dataStart: dataStart, dataEnd: child.end, dataType: dataType };
    }
    pos = child.end;
  }
  return null;
}
/**
 * 把 M4A data atom 的文本字节解码为播放器展示值。
 * @param {Uint8Array} bytes 文本 payload。
 * @param {number} dataType iTunes data 类型。
 * @returns {string} 归一化文本。
 */
function decodeM4aText(bytes, dataType) {
  var value = dataType === 2 ? decodeBytesWithEncoding(bytes, 'utf-16be') : utf8FromBytes(bytes, 0, bytes.length);
  return normalizeLocalMetadataValue(value);
}
/**
 * 将 M4A ilst 项类型映射为播放器字段。
 * @param {string} type ilst 项类型。
 * @returns {string} 展示字段名；不支持的项返回空字符串。
 */
function m4aMetadataKey(type) {
  if (type === '\u00a9nam') return 'title';
  if (type === '\u00a9ART') return 'artist';
  if (type === '\u00a9alb') return 'album';
  if (type === 'aART') return 'albumArtist';
  if (type === '\u00a9gen' || type === 'gnre') return 'genre';
  if (type === '\u00a9day') return 'year';
  if (type === 'trkn') return 'track';
  return '';
}
/**
 * 读取 M4A `----` 自定义项的 name 子 atom，得到 ReplayGain 之类的自定义标签名。
 * @param {File|object} file 本地 M4A 文件记录。
 * @param {object} item ilst 项 atom。
 * @returns {Promise<string>} 自定义标签名；不存在时返回空字符串。
 */
async function readM4aFreeformName(file, item) {
  var pos = item.offset + item.headerSize;
  while (pos + 8 <= item.end) {
    var child = await readM4aAtomHeader(file, pos, item.end);
    if (!child) return '';
    if (child.type === 'name') {
      // name atom 的 payload 前 4 字节是 version/flags，之后才是名称文本。
      var nameStart = child.offset + child.headerSize + 4;
      var nameLength = child.end - nameStart;
      if (nameLength <= 0 || nameLength > M4A_MAX_TEXT_BYTES) return '';
      var nameBytes = await readLocalFileBytes(file, nameStart, child.end);
      return nameBytes.length === nameLength ? utf8FromBytes(nameBytes, 0, nameBytes.length) : '';
    }
    pos = child.end;
  }
  return '';
}
/**
 * 解析 M4A ilst 中的展示标签和内嵌封面。
 * @param {File|object} file 本地 M4A 文件记录。
 * @param {object} ilst ilst atom 描述。
 * @param {{tags?:object,cover?:boolean}} result 消费者结果对象。
 * @returns {Promise<void>} 解析完成 Promise。
 */
async function parseM4aIlst(file, ilst, result) {
  var pos = ilst.offset + ilst.headerSize;
  var count = 0;
  while (pos + 8 <= ilst.end && count++ < M4A_MAX_ATOM_HEADERS) {
    var item = await readM4aAtomHeader(file, pos, ilst.end);
    if (!item) break;
    var data = await readM4aItemDataAtom(file, item);
    if (data) {
      var type = data.atom.type;
      if (item.type === 'covr' && result.cover !== undefined) {
        var coverLength = data.dataEnd - data.dataStart;
        if (coverLength > 0 && coverLength <= M4A_MAX_COVER_BYTES) {
          var coverBytes = await readLocalFileBytes(file, data.dataStart, data.dataEnd);
          if (coverBytes.length === coverLength) {
            var mime = data.dataType === 13 ? 'image/jpeg' : (data.dataType === 14 ? 'image/png' : '');
            if (!mime) mime = coverBytes[0] === 0x89 && coverBytes[1] === 0x50 ? 'image/png' : 'image/jpeg';
            result.cover = blobBytesToCoverBlob(coverBytes, mime);
          }
        }
      } else if (item.type === '----' && result.tags) {
        var freeformLength = data.dataEnd - data.dataStart;
        if (freeformLength > 0 && freeformLength <= M4A_MAX_TEXT_BYTES) {
          var rgField = replayGainTagField(await readM4aFreeformName(file, item));
          if (rgField) {
            var rgBytes = await readLocalFileBytes(file, data.dataStart, data.dataEnd);
            if (rgBytes.length === freeformLength) {
              putReplayGainTag(localMetadataReplayGainTarget(result.tags), rgField, decodeM4aText(rgBytes, data.dataType || 1));
            }
          }
        }
      } else if (result.tags) {
        var key = m4aMetadataKey(item.type);
        var payloadLength = data.dataEnd - data.dataStart;
        if (key && payloadLength > 0 && payloadLength <= M4A_MAX_TEXT_BYTES) {
          var payload = await readLocalFileBytes(file, data.dataStart, data.dataEnd);
          if (payload.length === payloadLength) {
            if (key === 'track') {
              if (payload.length >= 4) putLocalMetadataTag(result.tags, key, String((payload[2] << 8) | payload[3]));
            } else if (key === 'genre' && item.type === 'gnre') {
              // gnre 是二进制 atom，存 1-based ID3v1 流派序号；转成 0-based 数字交给流派归一化解析成名称。
              if (payload.length >= 2) {
                var genreIndex = (payload[0] << 8) | payload[1];
                if (genreIndex >= 1) putLocalMetadataTag(result.tags, key, String(genreIndex - 1));
              }
            } else {
              putLocalMetadataTag(result.tags, key, decodeM4aText(payload, data.dataType || 1));
            }
          }
        }
      }
    }
    pos = item.end;
  }
}
/**
 * 解析 M4A iTunes 标签，并在轻量目录未覆盖 moov 时标记为可重试。
 * @param {File|object} file 本地 M4A 文件记录。
 * @param {{light?:boolean}=} opts 是否限制后台轻量扫描范围。
 * @returns {Promise<object>} 播放器展示标签。
 */
async function extractM4aLocalMetadata(file, opts) {
  var session = await readM4aMetadataSession(file, opts);
  var tags = {};
  if (session.ilst) await parseM4aIlst(file, session.ilst, { tags: tags });
  tags._mineradioScanComplete = !!session.complete;
  return tags;
}
/**
 * 解析 M4A covr 封面并返回短生命周期 Blob，避免先构造完整 data URL。
 * @param {File|object} file 本地 M4A 文件记录。
 * @param {{light?:boolean}=} opts 是否限制后台轻量扫描范围。
 * @returns {Promise<Blob|null>} 封面 Blob；没有封面时返回 null。
 */
async function extractM4aEmbeddedCoverSource(file, opts) {
  var session = await readM4aMetadataSession(file, opts);
  if (!session.ilst) return null;
  var result = { cover: null };
  await parseM4aIlst(file, session.ilst, result);
  return result.cover || null;
}
var EMPTY_LOCAL_BYTES = new Uint8Array(0);
var ID3_MAX_TAG_BYTES = 48 * 1024 * 1024;
var ID3_MAX_PICTURE_BYTES = 64 * 1024 * 1024;
// 常见 ID3v2 标签连封面一起也在 256KB 以内，一次探针读完可省掉第二次整段读取。
var ID3_PROBE_BYTES = 256 * 1024;
var ID3_FRAME_ID_RE = /^[A-Z0-9]+$/;
/**
 * 读取 ID3v2 标签总长度（含 10 字节头与可选 footer），用于跳过前置标签。
 * @param {Uint8Array} bytes 含标签头的字节。
 * @param {number} start 标签起始偏移。
 * @returns {number} 标签总字节数；不是 ID3v2 标签时返回 0。
 */
function id3v2TagTotalBytes(bytes, start) {
  if (bytes.length < start + 10 || asciiFromBytes(bytes, start, 3) !== 'ID3') return 0;
  var size = synchsafeInt(bytes, start + 6);
  if (size <= 0 || size > ID3_MAX_TAG_BYTES) return 0;
  return 10 + size + ((bytes[start + 5] & 0x10) ? 10 : 0);
}
/**
 * 遍历 ID3v2 帧，兼容 v2.2 的 3 字节帧 ID 与 v2.3/v2.4 的 4 字节帧 ID。
 * @param {Uint8Array} bytes 标签字节。
 * @param {number} start 标签起始偏移。
 * @param {function(string, number, number, number): (boolean|void)} handler 帧回调；返回 true 表示提前结束。
 * @returns {boolean} handler 是否提前命中。
 */
function walkId3v2Frames(bytes, start, handler) {
  if (bytes.length < start + 10 || asciiFromBytes(bytes, start, 3) !== 'ID3') return false;
  var version = bytes[start + 3] || 3;
  var tagSize = synchsafeInt(bytes, start + 6);
  if (tagSize <= 0 || tagSize > ID3_MAX_TAG_BYTES) return false;
  var end = Math.min(bytes.length, start + 10 + tagSize);
  var pos = start + 10;
  if (version >= 3 && (bytes[start + 5] & 0x40) && pos + 4 <= end) {
    // 扩展头长度在 v2.4 是 synchsafe 且含自身，v2.3 是普通 uint32 且不含自身。
    var extSize = version === 4 ? synchsafeInt(bytes, pos) : uint32BE(bytes, pos);
    if (extSize > 0 && extSize < end - pos) pos += version === 4 ? extSize : extSize + 4;
  }
  var idLen = version === 2 ? 3 : 4;
  var headerLen = version === 2 ? 6 : 10;
  while (pos + headerLen <= end) {
    var id = asciiFromBytes(bytes, pos, idLen);
    var size = version === 2 ? uint24BE(bytes, pos + idLen)
      : (version === 4 ? synchsafeInt(bytes, pos + idLen) : uint32BE(bytes, pos + idLen));
    // 帧 ID 只允许大写字母和数字，填充区会在这里终止扫描。
    if (size <= 0 || id.length < idLen || !ID3_FRAME_ID_RE.test(id)) break;
    var frameStart = pos + headerLen;
    var frameEnd = Math.min(end, frameStart + size);
    if (handler(id, frameStart, frameEnd, version) === true) return true;
    pos = frameEnd;
  }
  return false;
}
/**
 * 从 RVA2 帧读取主音量增益。峰值字段各家 tagger 归一化方式不一致，这里只取增益。
 * @param {Uint8Array} bytes 标签字节。
 * @param {number} frameStart 帧数据起点。
 * @param {number} frameEnd 帧数据终点，不含该位置。
 * @returns {number|null} 增益 dB；没有主音量声道时返回 null。
 */
function readId3v2Rva2MasterGain(bytes, frameStart, frameEnd) {
  var idEnd = findZero(bytes, frameStart, frameEnd, 1);
  if (idEnd < 0) return null;
  var pos = idEnd + 1;
  while (pos + 3 <= frameEnd) {
    var channel = bytes[pos];
    var raw = (bytes[pos + 1] << 8) | bytes[pos + 2];
    if (raw & 0x8000) raw -= 0x10000;
    var peakBits = bytes[pos + 3] || 0;
    // 主音量声道(0x01)才是整轨增益，其余声道对播放端没有意义。
    if (channel === 1) return raw / 512;
    pos += 4 + Math.ceil(peakBits / 8);
  }
  return null;
}
/**
 * 解析 ID3v2 文本帧到展示标签。
 * @param {Uint8Array} bytes 标签字节。
 * @param {number} start 标签起始偏移。
 * @param {object} tags 展示标签结果。
 * @returns {object} 传入的标签对象。
 */
function parseId3v2Tags(bytes, start, tags) {
  /**
   * 把可识别文本帧写入展示标签，并顺带收集 ReplayGain。
   * @param {string} id 帧 ID。
   * @param {number} frameStart 帧数据起点。
   * @param {number} frameEnd 帧数据终点，不含该位置。
   * @param {number} version ID3v2 主版本。
   * @returns {boolean} 是否结束遍历。
   */
  function handleId3TextFrame(id, frameStart, frameEnd, version) {
    if (id === 'RVA2' || (version === 2 && id === 'RVA')) {
      var rva2Gain = readId3v2Rva2MasterGain(bytes, frameStart, frameEnd);
      if (rva2Gain != null) putReplayGainTag(localMetadataReplayGainTarget(tags), 'trackGainDb', rva2Gain);
      return false;
    }
    if ((id === 'TXXX' || (version === 2 && id === 'TXX')) && frameEnd - frameStart >= 2) {
      var enc = bytes[frameStart] || 0;
      var wide = (enc === 1 || enc === 2) ? 2 : 1;
      var descEnd = findZero(bytes, frameStart + 1, frameEnd, wide);
      if (descEnd < 0) return false;
      var rgField = replayGainTagField(decodeId3TextWithEncoding(bytes, frameStart + 1, descEnd, enc));
      if (rgField) {
        putReplayGainTag(localMetadataReplayGainTarget(tags), rgField, decodeId3TextWithEncoding(bytes, descEnd + wide, frameEnd, enc));
        return false;
      }
    }
    var key = id3TextFrameKey(id);
    if (key) putLocalMetadataTag(tags, key, decodeId3TextFrame(bytes, frameStart, frameEnd));
    return false;
  }
  walkId3v2Frames(bytes, start, handleId3TextFrame);
  return tags;
}
/**
 * 解析 ID3v2 APIC/PIC 图片，返回短生命周期封面 Blob。
 * @param {Uint8Array} bytes 标签字节。
 * @param {number} start 标签起始偏移。
 * @returns {Blob|null} 封面 Blob；没有图片时返回 null。
 */
function parseId3v2Picture(bytes, start) {
  var found = null;
  /**
   * 解析单个图片帧；命中后立即结束遍历。
   * @param {string} id 帧 ID。
   * @param {number} frameStart 帧数据起点。
   * @param {number} frameEnd 帧数据终点，不含该位置。
   * @param {number} version ID3v2 主版本。
   * @returns {boolean} 是否结束遍历。
   */
  function handleId3PictureFrame(id, frameStart, frameEnd, version) {
    if (frameEnd - frameStart < 8) return false;
    var enc = bytes[frameStart] || 0;
    var wide = (enc === 1 || enc === 2) ? 2 : 1;
    var mime = '';
    var descStart = 0;
    if (version >= 3 && id === 'APIC') {
      var mimeEnd = findZero(bytes, frameStart + 1, frameEnd, 1);
      if (mimeEnd < 0) return false;
      mime = asciiFromBytes(bytes, frameStart + 1, mimeEnd - frameStart - 1) || 'image/jpeg';
      // MIME 为 "-->" 时帧内是图片 URL 而不是图片数据。
      if (mime === '-->') return false;
      descStart = mimeEnd + 2;
    } else if (version === 2 && id === 'PIC') {
      mime = asciiFromBytes(bytes, frameStart + 1, 3).toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
      descStart = frameStart + 5;
    } else {
      return false;
    }
    var descEnd = findZero(bytes, descStart, frameEnd, wide);
    var imageStart = descEnd >= 0 ? descEnd + wide : descStart;
    if (imageStart >= frameEnd || frameEnd - imageStart > ID3_MAX_PICTURE_BYTES) return false;
    found = blobBytesToCoverBlob(bytes.subarray(imageStart, frameEnd), mime);
    return true;
  }
  walkId3v2Frames(bytes, start, handleId3PictureFrame);
  return found;
}
/**
 * 解析 ID3v2 内嵌歌词，USLT 与 TXXX(LYRICS) 共用既有优先级规则。
 * @param {Uint8Array} bytes 标签字节。
 * @param {number} start 标签起始偏移。
 * @returns {string} 优先级最高的歌词文本。
 */
function parseId3v2Lyrics(bytes, start) {
  var best = { priority: 0, text: '' };
  /**
   * 收集单个歌词候选帧。
   * @param {string} id 帧 ID。
   * @param {number} frameStart 帧数据起点。
   * @param {number} frameEnd 帧数据终点，不含该位置。
   * @param {number} version ID3v2 主版本。
   * @returns {boolean} 是否结束遍历。
   */
  function handleId3LyricFrame(id, frameStart, frameEnd, version) {
    var isUslt = id === 'USLT' || (version === 2 && id === 'ULT');
    var isTxxx = id === 'TXXX' || (version === 2 && id === 'TXX');
    if ((!isUslt && !isTxxx) || frameEnd - frameStart < 2) return false;
    var enc = bytes[frameStart] || 0;
    var wide = (enc === 1 || enc === 2) ? 2 : 1;
    // USLT 在编码字节后还有 3 字节语言码，之后才是描述符。
    var descStart = frameStart + 1 + (isUslt ? 3 : 0);
    var descEnd = findZero(bytes, descStart, frameEnd, wide);
    if (descEnd < 0) return false;
    var key = isUslt ? 'LYRICS' : decodeId3TextWithEncoding(bytes, descStart, descEnd, enc);
    var maxPriority = embeddedLyricFieldMaxPriority(key);
    if (best.priority >= maxPriority) return false;
    var textStart = descEnd + wide;
    // 未知描述符只有存在完整 LRC 时间标签才可能命中回退优先级。
    if (maxPriority === 25 && wide === 1 && !hasEmbeddedLyricTimeTagBytes(bytes, textStart, frameEnd)) return false;
    var value = normalizeEmbeddedLyricText(decodeId3TextWithEncoding(bytes, textStart, frameEnd, enc));
    var priority = embeddedLyricFieldPriority(key, value);
    if (value && priority > best.priority) {
      best.priority = priority;
      best.text = value;
    }
    return best.priority >= 100;
  }
  walkId3v2Frames(bytes, start, handleId3LyricFrame);
  return best.text;
}
/**
 * 去掉 ID3v1 定长字段尾部的 NUL 与空格填充。
 * @param {Uint8Array} bytes 标签字节。
 * @param {number} start 字段起始偏移。
 * @param {number} len 字段长度。
 * @returns {Uint8Array} 去填充后的字节视图。
 */
function trimId3v1Field(bytes, start, len) {
  var end = Math.min(bytes.length, start + len);
  while (end > start && (bytes[end - 1] === 0 || bytes[end - 1] === 0x20)) end--;
  return bytes.subarray(start, end);
}
/**
 * 解析 128 字节 ID3v1 标签，作为 APEv2/ID3v2 缺失字段的兜底。
 * @param {Uint8Array} bytes 含标签的字节。
 * @param {number} start 标签起始偏移。
 * @param {object} tags 展示标签结果。
 * @returns {boolean} 是否命中 ID3v1 标签。
 */
function parseId3v1Tags(bytes, start, tags) {
  if (bytes.length < start + 128 || asciiFromBytes(bytes, start, 3) !== 'TAG') return false;
  putLocalMetadataTag(tags, 'title', decodeLegacyTagText(trimId3v1Field(bytes, start + 3, 30)));
  putLocalMetadataTag(tags, 'artist', decodeLegacyTagText(trimId3v1Field(bytes, start + 33, 30)));
  putLocalMetadataTag(tags, 'album', decodeLegacyTagText(trimId3v1Field(bytes, start + 63, 30)));
  putLocalMetadataTag(tags, 'year', decodeLegacyTagText(trimId3v1Field(bytes, start + 93, 4)));
  // ID3v1.1 把音轨号写在 comment 末字节，前一字节必须为 0。
  if (!bytes[start + 125] && bytes[start + 126]) putLocalMetadataTag(tags, 'track', String(bytes[start + 126]));
  return true;
}
var LOCAL_HEADER_WINDOW_BYTES = 64 * 1024;
/**
 * 拼接多个字节片段。
 * @param {Array<Uint8Array>} parts 字节片段。
 * @param {number} total 片段总长度。
 * @returns {Uint8Array} 拼接结果。
 */
function concatLocalBytes(parts, total) {
  if (parts.length === 1) return parts[0];
  var out = new Uint8Array(total);
  var offset = 0;
  for (var i = 0; i < parts.length; i++) {
    out.set(parts[i], offset);
    offset += parts[i].length;
  }
  return out;
}
/**
 * 构造带滑动窗口的本地文件读取器：顺序解析容器头时按窗口批量读取，避免逐字段 IPC 往返。
 * 返回的字节视图在下一次窗口未命中时会失效，需要跨读取保留时必须自行复制。
 * @param {File|object} file 本地音频文件记录。
 * @param {number} maxOffset 允许扫描的最大绝对偏移；0 表示不限制。
 * @returns {object} 窗口读取器。
 */
function localHeaderWindow(file, maxOffset) {
  var size = localFileSize(file) || 0;
  var limit = maxOffset > 0 ? Math.min(size, maxOffset) : size;
  var buffer = null;
  var base = 0;
  return {
    size: size,
    limit: limit,
    /**
     * 读取指定区间；超出扫描上限或文件结尾时返回短结果。
     * @param {number} offset 起始偏移。
     * @param {number} length 请求长度。
     * @returns {Promise<Uint8Array>} 读取到的字节视图。
     */
    at: async function(offset, length) {
      offset = Math.max(0, Math.floor(Number(offset) || 0));
      length = Math.max(0, Math.floor(Number(length) || 0));
      if (!length || offset >= limit) return EMPTY_LOCAL_BYTES;
      var want = Math.min(length, limit - offset);
      if (buffer && offset >= base && offset + want <= base + buffer.length) {
        return buffer.subarray(offset - base, offset - base + want);
      }
      var span = Math.min(limit - offset, Math.max(want, LOCAL_HEADER_WINDOW_BYTES));
      var bytes = await readLocalFileBytes(file, offset, offset + span);
      buffer = bytes;
      base = offset;
      return bytes.length > want ? bytes.subarray(0, want) : bytes;
    },
    /**
     * 释放窗口缓冲，使大范围读取结果可尽早回收。
     * @returns {void}
     */
    release: function() {
      buffer = null;
    }
  };
}
var OGG_MAX_SCAN_PAGES = 4096;
var OGG_MAX_PACKET_BYTES = 32 * 1024 * 1024;
var OGG_TAIL_SCAN_BYTES = 64 * 1024;
var OGG_FLAC_METADATA_PACKETS = 12;
/**
 * 读取 Ogg 页头中的 64 位 granule position。
 * @param {Uint8Array} bytes 页头字节。
 * @param {number} offset granule 字段偏移。
 * @returns {number} granule 值；-1 表示该页内没有包结束。
 */
function oggGranuleValue(bytes, offset) {
  var low = uint32LE(bytes, offset);
  var high = uint32LE(bytes, offset + 4);
  if (low === 4294967295 && high === 4294967295) return -1;
  return high * 4294967296 + low;
}
/**
 * 读取单个 Ogg 页头，并复制分段表。
 * @param {object} win 窗口读取器。
 * @param {number} offset 页起始偏移。
 * @returns {Promise<object|null>} 页描述；不是完整合法页时返回 null。
 */
async function readOggPageHeader(win, offset) {
  var head = await win.at(offset, 27);
  if (head.length < 27 || asciiFromBytes(head, 0, 4) !== 'OggS' || head[4] !== 0) return null;
  var segCount = head[26];
  var page = {
    flags: head[5],
    granule: oggGranuleValue(head, 6),
    serial: uint32LE(head, 14),
    segCount: segCount,
    lacing: EMPTY_LOCAL_BYTES,
    dataStart: offset + 27 + segCount,
    dataLength: 0,
    nextOffset: 0
  };
  if (segCount) {
    var table = await win.at(offset + 27, segCount);
    if (table.length < segCount) return null;
    // 分段表必须复制：读取 payload 会让窗口视图失效。
    page.lacing = table.slice();
    for (var i = 0; i < segCount; i++) page.dataLength += page.lacing[i];
  }
  page.nextOffset = page.dataStart + page.dataLength;
  return page;
}
/**
 * 把一页 payload 按分段表切成数据包，跨页包在 pending 中累积。
 * @param {object} page 页描述。
 * @param {Uint8Array} payload 页 payload。
 * @param {Array<Uint8Array>} packets 已完成的数据包。
 * @param {{parts:Array<Uint8Array>,length:number}} pending 跨页累积状态。
 * @param {number} wanted 需要的包数量。
 * @returns {boolean} 是否仍可继续扫描。
 */
function appendOggPagePackets(page, payload, packets, pending, wanted) {
  var pos = 0;
  for (var i = 0; i < page.segCount && packets.length < wanted; i++) {
    var length = page.lacing[i];
    if (length) {
      // 复制：窗口视图会在下一次未命中读取时失效。
      pending.parts.push(payload.slice(pos, pos + length));
      pending.length += length;
      pos += length;
      if (pending.length > OGG_MAX_PACKET_BYTES) return false;
    }
    // 分段长度 255 表示包在下一段继续。
    if (length === 255) continue;
    packets.push(concatLocalBytes(pending.parts, pending.length));
    pending.parts = [];
    pending.length = 0;
  }
  return true;
}
/**
 * 从首个逻辑流收集前若干个完整数据包。
 * @param {object} win 窗口读取器。
 * @param {number} start 首页起始偏移。
 * @param {number} wanted 需要的包数量。
 * @returns {Promise<object>} `{packets, serial, complete}`；complete=false 表示扫描范围内包不完整。
 */
async function readOggStreamPackets(win, start, wanted) {
  var offset = start;
  var serial = -1;
  var packets = [];
  var pending = { parts: [], length: 0 };
  var complete = true;
  for (var pageIndex = 0; pageIndex < OGG_MAX_SCAN_PAGES && packets.length < wanted; pageIndex++) {
    var page = await readOggPageHeader(win, offset);
    if (!page) { complete = false; break; }
    offset = page.nextOffset;
    if (serial < 0) serial = page.serial;
    // 复用流里其它逻辑流的页与本流的包无关。
    if (page.serial !== serial) continue;
    var payload = page.dataLength ? await win.at(page.dataStart, page.dataLength) : EMPTY_LOCAL_BYTES;
    if (payload.length < page.dataLength) { complete = false; break; }
    if (!appendOggPagePackets(page, payload, packets, pending, wanted)) { complete = false; break; }
  }
  return { packets: packets, serial: serial, complete: complete };
}
/**
 * 解析 Ogg 首包中的编解码信息。
 * @param {Uint8Array} packet 逻辑流第一个数据包。
 * @returns {object|null} 编解码描述；无法识别时返回 null。
 */
function parseOggCodecInfo(packet) {
  if (!packet || packet.length < 19) return null;
  if (packet.length >= 30 && packet[0] === 1 && asciiFromBytes(packet, 1, 6) === 'vorbis') {
    var vorbisRate = uint32LE(packet, 12);
    return {
      codec: 'vorbis', channels: packet[11], sampleRate: vorbisRate,
      granuleRate: vorbisRate, preSkip: 0, totalSamples: 0
    };
  }
  if (asciiFromBytes(packet, 0, 8) === 'OpusHead') {
    // Opus 的 granule position 恒为 48kHz 计数，且包含头部 pre-skip。
    return {
      codec: 'opus', channels: packet[9], sampleRate: uint32LE(packet, 12) || 48000,
      granuleRate: 48000, preSkip: packet[10] + (packet[11] << 8), totalSamples: 0
    };
  }
  if (packet.length >= 51 && packet[0] === 127 && asciiFromBytes(packet, 1, 4) === 'FLAC' &&
      asciiFromBytes(packet, 9, 4) === 'fLaC') {
    // Ogg FLAC 首包内嵌完整 STREAMINFO：4 字节 block 头后是 34 字节内容。
    var s = 17;
    var flacRate = (packet[s + 10] << 12) | (packet[s + 11] << 4) | (packet[s + 12] >> 4);
    return {
      codec: 'flac', channels: ((packet[s + 12] >> 1) & 7) + 1, sampleRate: flacRate,
      granuleRate: flacRate, preSkip: 0,
      totalSamples: (packet[s + 13] & 15) * 4294967296 + uint32BE(packet, s + 14)
    };
  }
  return null;
}
/**
 * 取出 Ogg 第二个包中的 Vorbis comment payload。
 * @param {string} codec 编解码标识。
 * @param {Uint8Array} packet 第二个数据包。
 * @returns {Uint8Array} comment payload；不是注释包时长度为 0。
 */
function oggCommentPayload(codec, packet) {
  if (!packet || !packet.length) return EMPTY_LOCAL_BYTES;
  if (codec === 'vorbis') {
    if (packet.length > 7 && packet[0] === 3 && asciiFromBytes(packet, 1, 6) === 'vorbis') return packet.subarray(7);
    return EMPTY_LOCAL_BYTES;
  }
  if (codec === 'opus') {
    if (packet.length > 8 && asciiFromBytes(packet, 0, 8) === 'OpusTags') return packet.subarray(8);
    return EMPTY_LOCAL_BYTES;
  }
  // Ogg FLAC 第二个包是裸 METADATA_BLOCK，类型 4 才是 VORBIS_COMMENT。
  if (packet.length > 4 && (packet[0] & 0x7f) === 4) return packet.subarray(4);
  return EMPTY_LOCAL_BYTES;
}
/**
 * 遍历 Vorbis comment payload 中的字段，key 归一化后回调。
 * @param {Uint8Array} bytes payload 字节。
 * @param {function(string, number, number):boolean} handler 字段回调，返回 true 结束遍历。
 * @returns {boolean} 是否被回调提前结束。
 */
function forEachVorbisComment(bytes, handler) {
  var end = bytes.length;
  if (end <= 8) return false;
  var p = 4 + uint32LE(bytes, 0);
  if (p + 4 > end) return false;
  var count = Math.min(uint32LE(bytes, p), 10000);
  p += 4;
  for (var i = 0; i < count && p + 4 <= end; i++) {
    var length = uint32LE(bytes, p);
    p += 4;
    // 只有越界才说明 payload 损坏；零长度字段仅跳过当前计数项。
    if (p + length > end) break;
    var start = p;
    p += length;
    var eq = findByteInRange(bytes, start, p, 61);
    if (eq <= start) continue;
    var key = asciiFromBytes(bytes, start, eq - start).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (handler(key, eq + 1, p) === true) return true;
  }
  return false;
}
/**
 * 解码 Vorbis comment 中的 base64 value。
 * @param {Uint8Array} bytes payload 字节。
 * @param {number} start value 起始偏移。
 * @param {number} end value 结束偏移，不含该位置。
 * @returns {Uint8Array} 解码字节；无效时长度为 0。
 */
function decodeBase64ValueBytes(bytes, start, end) {
  // base64 是纯 ASCII，用 latin1 解码即可得到原文，且避免逐字符拼接大字符串。
  var text = decodeBytesWithEncoding(bytes.subarray(start, end), 'latin1').replace(/[^A-Za-z0-9+/=]/g, '');
  if (text.length < 8) return EMPTY_LOCAL_BYTES;
  try {
    var binary = atob(text);
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch (e) {
    return EMPTY_LOCAL_BYTES;
  }
}
/**
 * 从图片首字节猜测 MIME，用于没有独立 MIME 字段的容器。
 * @param {Uint8Array} bytes 图片字节。
 * @returns {string} 图片 MIME。
 */
function sniffImageMime(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length > 12 && asciiFromBytes(bytes, 0, 4) === 'RIFF' && asciiFromBytes(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (bytes.length > 4 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return 'image/jpeg';
}
/**
 * 打开 Ogg 元数据会话：解析首包编解码信息与注释包。
 * @param {File|object} file 本地文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @param {number} wanted 需要收集的数据包数量。
 * @returns {Promise<object>} `{info, serial, comment, packets, complete}`。
 */
async function readOggMetadataSession(file, opts, wanted) {
  opts = opts || {};
  var win = localHeaderWindow(file, opts.light ? LOCAL_ASSET_LIGHT_SCAN_BYTES : 0);
  try {
    var read = await readOggStreamPackets(win, 0, wanted);
    var info = read.packets.length ? parseOggCodecInfo(read.packets[0]) : null;
    var comment = info && read.packets.length > 1 ? oggCommentPayload(info.codec, read.packets[1]) : EMPTY_LOCAL_BYTES;
    return {
      info: info, serial: read.serial, comment: comment,
      packets: read.packets, complete: read.complete
    };
  } finally {
    win.release();
  }
}
/**
 * 从文件尾部最后一页的 granule position 推导时长。
 * @param {File|object} file 本地文件记录。
 * @param {object} info 编解码描述。
 * @param {number} serial 目标逻辑流序号。
 * @returns {Promise<number>} 秒数；无法确定时返回 0。
 */
async function readOggTailDuration(file, info, serial) {
  var rate = info && info.granuleRate > 0 ? info.granuleRate : 0;
  if (!rate) return 0;
  if (info.totalSamples > 0) return info.totalSamples / rate;
  var size = localFileSize(file) || 0;
  if (size < 27) return 0;
  var start = Math.max(0, size - OGG_TAIL_SCAN_BYTES);
  var bytes = await readLocalFileBytes(file, start, size);
  // 末尾页的 granule 是整个逻辑流的样本总数；-1 页要继续往前找。
  for (var i = bytes.length - 27; i >= 0; i--) {
    if (bytes[i] !== 79 || asciiFromBytes(bytes, i, 4) !== 'OggS' || bytes[i + 4] !== 0) continue;
    if (uint32LE(bytes, i + 14) !== serial) continue;
    var granule = oggGranuleValue(bytes, i + 6);
    if (granule <= 0) continue;
    return Math.max(0, granule - (info.preSkip || 0)) / rate;
  }
  return 0;
}
/**
 * 解析 Vorbis comment 中的内嵌封面：优先 METADATA_BLOCK_PICTURE，其次旧式 COVERART。
 * @param {Uint8Array} bytes comment payload。
 * @returns {Blob|null} 封面 Blob；没有图片时返回 null。
 */
function vorbisCommentPictureBlob(bytes) {
  if (!bytes || !bytes.length) return null;
  var found = null;
  var legacy = EMPTY_LOCAL_BYTES;
  var legacyMime = '';
  /**
   * 收集封面候选字段。
   * @param {string} key 归一化字段名。
   * @param {number} start value 起始偏移。
   * @param {number} end value 结束偏移，不含该位置。
   * @returns {boolean} 是否结束遍历。
   */
  function handleVorbisPictureComment(key, start, end) {
    if (key === 'METADATABLOCKPICTURE') {
      var block = decodeBase64ValueBytes(bytes, start, end);
      if (block.length > 32) found = extractFlacPictureBlob(block, 0, block.length);
      return !!found;
    }
    if (key === 'COVERART' && !legacy.length) legacy = decodeBase64ValueBytes(bytes, start, end);
    else if (key === 'COVERARTMIME' && !legacyMime) legacyMime = utf8FromBytes(bytes, start, end - start).trim();
    return false;
  }
  forEachVorbisComment(bytes, handleVorbisPictureComment);
  if (found) return found;
  if (legacy.length > 32) return blobBytesToCoverBlob(legacy, legacyMime || sniffImageMime(legacy));
  return null;
}
/**
 * 解析 OGG/OPUS 展示元数据，并按 granule position 补出时长。
 * @param {File|object} file 本地 Ogg 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<object>} 标签对象；`_mineradioScanComplete=false` 表示需要完整重试。
 */
async function extractOggLocalMetadata(file, opts) {
  var session = await readOggMetadataSession(file, opts, 2);
  var tags = {};
  if (!session.info) {
    // 首包被轻量上限截断才值得完整重试；确实不是 Ogg 的文件不重试。
    tags._mineradioScanComplete = session.complete;
    return tags;
  }
  if (session.comment.length) parseFlacMetadataVorbisPayload(session.comment, tags);
  else if (!session.complete) tags._mineradioScanComplete = false;
  var duration = await readOggTailDuration(file, session.info, session.serial);
  if (duration > 0) tags.duration = duration;
  return tags;
}
/**
 * 解析 OGG/OPUS 内嵌封面。
 * @param {File|object} file 本地 Ogg 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<Blob|null>} 封面 Blob；没有封面时返回 null。
 */
async function extractOggEmbeddedCoverSource(file, opts) {
  var session = await readOggMetadataSession(file, opts, 2);
  if (!session.info) return null;
  var blob = vorbisCommentPictureBlob(session.comment);
  if (blob) return blob;
  if (session.info.codec !== 'flac') return null;
  // Ogg FLAC 的 PICTURE 是独立 METADATA_BLOCK，位于注释包之后的数据包里。
  var extended = await readOggMetadataSession(file, opts, OGG_FLAC_METADATA_PACKETS);
  for (var i = 2; i < extended.packets.length; i++) {
    var packet = extended.packets[i];
    if (packet.length > 32 && (packet[0] & 0x7f) === 6) {
      var picture = extractFlacPictureBlob(packet, 4, packet.length);
      if (picture) return picture;
    }
    // 最后一个 metadata block 之后就是音频包，没有继续扫描的价值。
    if (packet.length && (packet[0] & 0x80)) break;
  }
  return null;
}
/**
 * 解析 OGG/OPUS 内嵌歌词。
 * @param {File|object} file 本地 Ogg 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<string>} 歌词文本；没有歌词时返回空字符串。
 */
async function extractOggEmbeddedLyricsText(file, opts) {
  var session = await readOggMetadataSession(file, opts, 2);
  if (!session.comment.length) return '';
  var best = { priority: 0, text: '' };
  parseFlacLyricsVorbisPayload(session.comment, best);
  return best.text || '';
}
var RIFF_MAX_CHUNKS = 512;
var LOCAL_MAX_TAG_BYTES = 24 * 1024 * 1024;
/**
 * 判断 4 字节是否为可打印的 RIFF chunk id，用于在填充区终止目录扫描。
 * @param {Uint8Array} bytes 字节。
 * @param {number} offset 起始偏移。
 * @returns {boolean} 是否为合法 chunk id。
 */
function isRiffChunkId(bytes, offset) {
  for (var i = 0; i < 4; i++) {
    if (bytes[offset + i] < 0x20 || bytes[offset + i] > 0x7e) return false;
  }
  return true;
}
/**
 * 扫描 RIFF/RF64 chunk 目录；只记录 descriptor，不读取 chunk 内容。
 * @param {object} win 窗口读取器。
 * @returns {Promise<object|null>} `{chunks, complete}`；不是 WAVE 时返回 null。
 */
async function readRiffChunkDirectory(win) {
  var head = await win.at(0, 12);
  if (head.length < 12) return null;
  var magic = asciiFromBytes(head, 0, 4);
  var rf64 = magic === 'RF64' || magic === 'BW64';
  if ((magic !== 'RIFF' && !rf64) || asciiFromBytes(head, 8, 4) !== 'WAVE') return null;
  var riffSize = uint32LE(head, 4);
  var end = rf64 ? win.size : Math.min(win.size, 8 + riffSize);
  var result = { chunks: [], complete: true };
  var dataSize64 = -1;
  var pos = 12;
  while (pos + 8 <= end && result.chunks.length < RIFF_MAX_CHUNKS) {
    var header = await win.at(pos, 8);
    if (header.length < 8) { result.complete = false; break; }
    if (!isRiffChunkId(header, 0)) { result.complete = false; break; }
    var id = asciiFromBytes(header, 0, 4);
    var size = uint32LE(header, 4);
    var dataStart = pos + 8;
    if (id === 'ds64' && size >= 24) {
      var ds64 = await win.at(dataStart, 24);
      if (ds64.length >= 16) dataSize64 = uint64LE(ds64, 8);
    }
    // RF64 把超过 4GB 的 data 长度写成 0xFFFFFFFF，真值来自 ds64。
    if (id === 'data' && size === 4294967295 && dataSize64 >= 0) size = dataSize64;
    result.chunks.push({ id: id, start: dataStart, size: size });
    // chunk 以偶数边界对齐，奇数长度后有一个填充字节。
    pos = dataStart + size + (size % 2);
  }
  return result;
}
/**
 * 解析 WAV `fmt ` chunk。
 * @param {Uint8Array} bytes chunk 内容。
 * @returns {object} 采样格式描述。
 */
function parseWavFormatChunk(bytes) {
  var channels = uint16LE(bytes, 2);
  var sampleRate = uint32LE(bytes, 4);
  var byteRate = uint32LE(bytes, 8);
  var bits = uint16LE(bytes, 14);
  // WAVE_FORMAT_EXTENSIBLE 的真实编码写在扩展 GUID 里，位深和采样率字段仍然有效。
  if (!byteRate && sampleRate && channels && bits) byteRate = sampleRate * channels * Math.ceil(bits / 8);
  return { format: uint16LE(bytes, 0), channels: channels, sampleRate: sampleRate, byteRate: byteRate, bits: bits };
}
/**
 * 把 RIFF INFO 字段名映射到播放器展示字段。
 * @param {string} id INFO 子 chunk id。
 * @returns {string} 播放器字段名；无消费者时返回空字符串。
 */
function riffInfoTagKey(id) {
  if (id === 'INAM' || id === 'TITL') return 'title';
  if (id === 'IART' || id === 'IPRF') return 'artist';
  if (id === 'IPRD' || id === 'IALB') return 'album';
  if (id === 'IAAR' || id === 'ISBJ') return 'albumArtist';
  if (id === 'ITRK' || id === 'IPRT' || id === 'TRCK') return 'track';
  if (id === 'ICRD' || id === 'IYER' || id === 'YEAR') return 'year';
  return '';
}
/**
 * 解析 LIST/INFO chunk 中的展示元数据。
 * @param {Uint8Array} bytes LIST chunk 内容，含开头的 `INFO` 标识。
 * @param {object} tags 展示标签结果。
 * @returns {void}
 */
function parseRiffInfoTags(bytes, tags) {
  var end = bytes.length;
  var pos = 4;
  while (pos + 8 <= end) {
    if (!isRiffChunkId(bytes, pos)) break;
    var id = asciiFromBytes(bytes, pos, 4);
    var size = uint32LE(bytes, pos + 4);
    var start = pos + 8;
    var stop = Math.min(end, start + size);
    var key = riffInfoTagKey(id);
    if (key) {
      // INFO 值是 NUL 结尾的字符串，编码未规定，按 UTF-8/GBK/latin1 依次尝试。
      var zero = findZero(bytes, start, stop, 1);
      putLocalMetadataTag(tags, key, decodeLegacyTagText(bytes.subarray(start, zero >= 0 ? zero : stop)));
    }
    pos = start + size + (size % 2);
  }
}
/**
 * 打开 WAV 元数据会话：定位 fmt/data/LIST-INFO/id3 chunk。
 * chunk 目录只读 8 字节头，不受轻量上限限制；轻量模式只限制标签 chunk 的读取体积。
 * @param {File|object} file 本地 WAV 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<object|null>} 会话对象；不是 WAVE 时返回 null。
 */
async function readWavMetadataSession(file, opts) {
  opts = opts || {};
  var win = localHeaderWindow(file, 0);
  var directory = await readRiffChunkDirectory(win);
  if (!directory) {
    win.release();
    return null;
  }
  var session = {
    win: win, complete: true, fmt: null, dataSize: 0, info: null, id3: null,
    maxTagBytes: opts.light ? LOCAL_ASSET_LIGHT_SCAN_BYTES : LOCAL_MAX_TAG_BYTES
  };
  for (var i = 0; i < directory.chunks.length; i++) {
    var chunk = directory.chunks[i];
    if (chunk.id === 'fmt ' && !session.fmt && chunk.size >= 16) {
      var fmtBytes = await win.at(chunk.start, Math.min(chunk.size, 64));
      if (fmtBytes.length >= 16) session.fmt = parseWavFormatChunk(fmtBytes);
    } else if (chunk.id === 'data' && !session.dataSize) {
      session.dataSize = chunk.size;
    } else if (chunk.id === 'LIST' && !session.info && chunk.size > 4) {
      var listType = await win.at(chunk.start, 4);
      if (asciiFromBytes(listType, 0, 4) === 'INFO') session.info = chunk;
    } else if ((chunk.id === 'id3 ' || chunk.id === 'ID3 ') && !session.id3 && chunk.size >= 10) {
      session.id3 = chunk;
    }
  }
  return session;
}
/**
 * 读取一个标签 chunk 的完整内容；超过当前扫描预算时留待完整重试。
 * @param {object} session WAV 元数据会话。
 * @param {object} chunk 目标 chunk descriptor。
 * @returns {Promise<Uint8Array>} chunk 内容；跳过时长度为 0。
 */
async function readWavTagChunkBytes(session, chunk) {
  if (chunk.size > session.maxTagBytes) {
    session.complete = false;
    return EMPTY_LOCAL_BYTES;
  }
  return await session.win.at(chunk.start, chunk.size);
}
/**
 * 解析 WAV 展示元数据：id3 chunk 优先，其次 LIST/INFO，并按 fmt/data 推导时长。
 * @param {File|object} file 本地 WAV 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<object>} 标签对象；`_mineradioScanComplete=false` 表示需要完整重试。
 */
async function extractWavLocalMetadata(file, opts) {
  var session = await readWavMetadataSession(file, opts);
  if (!session) return {};
  var tags = {};
  try {
    if (session.id3) {
      var id3Bytes = await readWavTagChunkBytes(session, session.id3);
      if (id3Bytes.length >= 10) parseId3v2Tags(id3Bytes, 0, tags);
    }
    if (session.info) {
      var infoBytes = await readWavTagChunkBytes(session, session.info);
      if (infoBytes.length > 4) parseRiffInfoTags(infoBytes, tags);
    }
    var byteRate = session.fmt ? session.fmt.byteRate : 0;
    if (byteRate > 0 && session.dataSize > 0) tags.duration = session.dataSize / byteRate;
    if (!session.complete) tags._mineradioScanComplete = false;
  } finally {
    session.win.release();
  }
  return tags;
}
/**
 * 解析 WAV id3 chunk 中的内嵌封面。
 * @param {File|object} file 本地 WAV 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<Blob|null>} 封面 Blob；没有封面时返回 null。
 */
async function extractWavEmbeddedCoverSource(file, opts) {
  var session = await readWavMetadataSession(file, opts);
  if (!session) return null;
  try {
    if (!session.id3) return null;
    var bytes = await readWavTagChunkBytes(session, session.id3);
    return bytes.length >= 10 ? parseId3v2Picture(bytes, 0) : null;
  } finally {
    session.win.release();
  }
}
/**
 * 解析 WAV id3 chunk 中的内嵌歌词。
 * @param {File|object} file 本地 WAV 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<string>} 歌词文本；没有歌词时返回空字符串。
 */
async function extractWavEmbeddedLyricsText(file, opts) {
  var session = await readWavMetadataSession(file, opts);
  if (!session) return '';
  try {
    if (!session.id3) return '';
    var bytes = await readWavTagChunkBytes(session, session.id3);
    return bytes.length >= 10 ? parseId3v2Lyrics(bytes, 0) : '';
  } finally {
    session.win.release();
  }
}
/**
 * 读取指定偏移处的完整 ID3v2 标签字节。
 * @param {File|object} file 本地文件记录。
 * @param {number} start 标签起始偏移。
 * @param {number} maxBytes 本轮允许的标签体积上限。
 * @param {number=} probeBytes 首次探针读取的字节数，默认 `ID3_PROBE_BYTES`。
 * @returns {Promise<object>} `{bytes, truncated}`；truncated 表示标签超出预算需完整重试。
 */
async function readId3v2TagBytes(file, start, maxBytes, probeBytes) {
  if (start < 0) return { bytes: EMPTY_LOCAL_BYTES, truncated: false };
  var probe = probeBytes > 10 ? probeBytes : ID3_PROBE_BYTES;
  var fileSize = localFileSize(file) || 0;
  var probeEnd = fileSize ? Math.min(fileSize, start + probe) : start + probe;
  var head = await readLocalFileBytes(file, start, probeEnd);
  var total = head.length >= 10 ? id3v2TagTotalBytes(head, 0) : 0;
  if (!total) return { bytes: EMPTY_LOCAL_BYTES, truncated: false };
  if (total > maxBytes) return { bytes: EMPTY_LOCAL_BYTES, truncated: true };
  // 探针已覆盖整个标签时直接切片，避免同一段字节被读第二次。
  if (head.length >= total) return { bytes: head.subarray(0, total), truncated: false };
  var bytes = await readLocalFileBytes(file, start, start + total);
  return { bytes: bytes, truncated: false };
}
/**
 * 解析 APE 头部：版本、声道、采样率与总样本数。
 * @param {object} win 窗口读取器。
 * @returns {Promise<object|null>} 流信息；不是 APE 文件时返回 null。
 */
async function readApeStreamInfo(win) {
  var probe = await win.at(0, 10);
  // APE 允许文件头有 ID3v2，'MAC ' 之前的部分对解码器是 junk。
  var junk = probe.length >= 10 ? id3v2TagTotalBytes(probe, 0) : 0;
  var head = await win.at(junk, 128);
  if (head.length < 32 || asciiFromBytes(head, 0, 4) !== 'MAC ') return null;
  var info = { junk: junk, version: uint16LE(head, 4), channels: 0, sampleRate: 0, bps: 16, totalBlocks: 0 };
  if (info.version >= 3980) {
    var descriptorLength = uint32LE(head, 8);
    var block = await win.at(junk + (descriptorLength > 52 ? descriptorLength : 52), 24);
    if (block.length < 24) return null;
    var totalFrames = uint32LE(block, 12);
    info.bps = uint16LE(block, 16);
    info.channels = uint16LE(block, 18);
    info.sampleRate = uint32LE(block, 20);
    if (totalFrames > 0) info.totalBlocks = (totalFrames - 1) * uint32LE(block, 4) + uint32LE(block, 8);
    return info;
  }
  var compressionLevel = uint16LE(head, 6);
  var formatFlags = uint16LE(head, 8);
  info.channels = uint16LE(head, 10);
  info.sampleRate = uint32LE(head, 12);
  info.bps = (formatFlags & 1) ? 8 : ((formatFlags & 8) ? 24 : 16);
  // 3980 之前的版本不存 blocksPerFrame，只能由版本号和压缩等级推出。
  var blocksPerFrame = info.version >= 3950 ? 73728 * 4
    : ((info.version >= 3900 || (info.version >= 3800 && compressionLevel >= 4000)) ? 73728 : 9216);
  var oldTotalFrames = uint32LE(head, 24);
  if (oldTotalFrames > 0) info.totalBlocks = (oldTotalFrames - 1) * blocksPerFrame + uint32LE(head, 28);
  return info;
}
/**
 * 归一化标签字段名，去掉大小写与分隔符差异。
 * @param {string} key 原始字段名。
 * @returns {string} 归一化字段名。
 */
function normalizedTagKey(key) {
  return String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
/**
 * 定位文件尾部的 APEv2 标签与 ID3v1 标签。
 * @param {File|object} file 本地文件记录。
 * @param {number} maxTagBytes 本轮允许的标签体积上限。
 * @returns {Promise<object>} `{items, id3v1, truncated}`。
 */
async function readApeTagRegion(file, maxTagBytes) {
  var result = { items: EMPTY_LOCAL_BYTES, id3v1: EMPTY_LOCAL_BYTES, truncated: false };
  var size = localFileSize(file) || 0;
  if (size < 32) return result;
  var tail = await readLocalFileBytes(file, size - Math.min(size, 160), size);
  if (tail.length < 32) return result;
  var tailBase = size - tail.length;
  if (tail.length >= 128 && asciiFromBytes(tail, tail.length - 128, 3) === 'TAG') {
    result.id3v1 = tail.subarray(tail.length - 128);
  }
  // APEv2 footer 是文件最后 32 字节；存在 ID3v1 时再往前挪 128 字节。
  var candidates = [size - 32, result.id3v1.length ? size - 160 : -1];
  var footerPos = -1;
  for (var i = 0; i < candidates.length && footerPos < 0; i++) {
    var offset = candidates[i] - tailBase;
    if (candidates[i] < 0 || offset < 0 || offset + 32 > tail.length) continue;
    if (asciiFromBytes(tail, offset, 8) === 'APETAGEX') footerPos = candidates[i];
  }
  if (footerPos < 0) return result;
  // footer 里的 tag size 含 footer 自身，不含可选的前置 header。
  var tagSize = uint32LE(tail, footerPos - tailBase + 12);
  if (tagSize > maxTagBytes) result.truncated = true;
  else if (tagSize > 32 && footerPos + 32 - tagSize >= 0) {
    result.items = await readLocalFileBytes(file, footerPos + 32 - tagSize, footerPos);
  }
  return result;
}
/**
 * 遍历 APEv2 标签项。
 * @param {Uint8Array} bytes items 区域字节。
 * @param {function(string, number, number, number):boolean} handler 标签项回调，返回 true 结束遍历。
 * @returns {boolean} 是否被回调提前结束。
 */
function forEachApeTagItem(bytes, handler) {
  var end = bytes.length;
  var pos = 0;
  for (var i = 0; i < 10000 && pos + 10 <= end; i++) {
    var valueSize = uint32LE(bytes, pos);
    var flags = uint32LE(bytes, pos + 4);
    var keyStart = pos + 8;
    var keyEnd = findZero(bytes, keyStart, end, 1);
    if (keyEnd < 0 || keyEnd === keyStart) break;
    var valueStart = keyEnd + 1;
    var valueEnd = valueStart + valueSize;
    if (valueEnd > end) break;
    pos = valueEnd;
    if (handler(asciiFromBytes(bytes, keyStart, keyEnd - keyStart), valueStart, valueEnd, flags) === true) return true;
  }
  return false;
}
/**
 * 解析 APEv2 文本项到展示标签。
 * @param {Uint8Array} bytes items 区域字节。
 * @param {object} tags 展示标签结果。
 * @returns {void}
 */
function parseApeTagItems(bytes, tags) {
  /**
   * 写入单个文本项。
   * @param {string} key 标签项名。
   * @param {number} valueStart value 起始偏移。
   * @param {number} valueEnd value 结束偏移，不含该位置。
   * @param {number} flags 标签项 flags。
   * @returns {boolean} 是否结束遍历。
   */
  function handleApeTextItem(key, valueStart, valueEnd, flags) {
    // flags 的 bit1-2 是类型：0 为 UTF-8 文本，1 为二进制，2 为外部引用。
    if ((flags >> 1) & 3) return false;
    // 多值项用 NUL 分隔，展示只取第一个值。
    var zero = findZero(bytes, valueStart, valueEnd, 1);
    var text = decodeLegacyTagText(bytes.subarray(valueStart, zero >= 0 ? zero : valueEnd));
    var rgField = replayGainTagField(key);
    if (rgField) {
      putReplayGainTag(localMetadataReplayGainTarget(tags), rgField, text);
      return false;
    }
    var field = vorbisCommentKey(key);
    if (!field || tags[field]) return false;
    putLocalMetadataTag(tags, field, text);
    return false;
  }
  forEachApeTagItem(bytes, handleApeTextItem);
}
/**
 * 解析 APEv2 二进制封面项，优先 “Cover Art (Front)”。
 * @param {Uint8Array} bytes items 区域字节。
 * @returns {Blob|null} 封面 Blob；没有图片时返回 null。
 */
function apeTagPictureBlob(bytes) {
  var front = null;
  var other = null;
  /**
   * 收集封面候选项。
   * @param {string} key 标签项名。
   * @param {number} valueStart value 起始偏移。
   * @param {number} valueEnd value 结束偏移，不含该位置。
   * @param {number} flags 标签项 flags。
   * @returns {boolean} 是否结束遍历。
   */
  function handleApeCoverItem(key, valueStart, valueEnd, flags) {
    var normalized = normalizedTagKey(key);
    if (((flags >> 1) & 3) !== 1 || normalized.indexOf('COVERART') !== 0) return false;
    // 二进制项内容是 “文件名 + NUL + 图片字节”。
    var zero = findZero(bytes, valueStart, valueEnd, 1);
    var imageStart = zero >= 0 ? zero + 1 : valueStart;
    if (valueEnd - imageStart < 32) return false;
    var image = bytes.subarray(imageStart, valueEnd);
    var blob = blobBytesToCoverBlob(image, sniffImageMime(image));
    if (normalized === 'COVERARTFRONT') front = blob;
    else if (!other) other = blob;
    return !!front;
  }
  forEachApeTagItem(bytes, handleApeCoverItem);
  return front || other;
}
/**
 * 解析 APEv2 歌词项，沿用既有歌词字段优先级。
 * @param {Uint8Array} bytes items 区域字节。
 * @returns {string} 优先级最高的歌词文本。
 */
function apeTagLyricsText(bytes) {
  var best = { priority: 0, text: '' };
  /**
   * 收集单个歌词候选项。
   * @param {string} key 标签项名。
   * @param {number} valueStart value 起始偏移。
   * @param {number} valueEnd value 结束偏移，不含该位置。
   * @param {number} flags 标签项 flags。
   * @returns {boolean} 是否结束遍历。
   */
  function handleApeLyricItem(key, valueStart, valueEnd, flags) {
    if ((flags >> 1) & 3) return false;
    var maxPriority = embeddedLyricFieldMaxPriority(key);
    if (best.priority >= maxPriority) return false;
    // 未知字段只有存在完整 LRC 时间标签才可能命中回退优先级。
    if (maxPriority === 25 && !hasEmbeddedLyricTimeTagBytes(bytes, valueStart, valueEnd)) return false;
    var value = normalizeEmbeddedLyricText(decodeLegacyTagText(bytes.subarray(valueStart, valueEnd)));
    var priority = embeddedLyricFieldPriority(key, value);
    if (value && priority > best.priority) {
      best.priority = priority;
      best.text = value;
    }
    return best.priority >= 100;
  }
  forEachApeTagItem(bytes, handleApeLyricItem);
  return best.text;
}
/**
 * 打开 APE 元数据会话：头部流信息 + 尾部 APEv2/ID3v1 标签。
 * @param {File|object} file 本地 APE 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<object>} `{info, items, id3v1, complete}`。
 */
async function readApeMetadataSession(file, opts) {
  opts = opts || {};
  var maxTagBytes = opts.light ? LOCAL_ASSET_LIGHT_SCAN_BYTES : LOCAL_MAX_TAG_BYTES;
  var win = localHeaderWindow(file, 0);
  var info = null;
  try {
    info = await readApeStreamInfo(win);
  } finally {
    win.release();
  }
  if (!info) return { info: null, items: EMPTY_LOCAL_BYTES, id3v1: EMPTY_LOCAL_BYTES, complete: true };
  var region = await readApeTagRegion(file, maxTagBytes);
  return {
    info: info, items: region.items, id3v1: region.id3v1,
    maxTagBytes: maxTagBytes, complete: !region.truncated
  };
}
/**
 * 解析 APE 展示元数据：APEv2 优先，其次文件头 ID3v2 与尾部 ID3v1。
 * @param {File|object} file 本地 APE 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<object>} 标签对象；`_mineradioScanComplete=false` 表示需要完整重试。
 */
async function extractApeLocalMetadata(file, opts) {
  var session = await readApeMetadataSession(file, opts);
  var tags = {};
  if (!session.info) return tags;
  if (session.items.length) parseApeTagItems(session.items, tags);
  if (session.info.junk) {
    var id3 = await readId3v2TagBytes(file, 0, session.maxTagBytes);
    if (id3.bytes.length) parseId3v2Tags(id3.bytes, 0, tags);
    if (id3.truncated) tags._mineradioScanComplete = false;
  }
  if (session.id3v1.length) parseId3v1Tags(session.id3v1, 0, tags);
  if (session.info.sampleRate > 0 && session.info.totalBlocks > 0) {
    tags.duration = session.info.totalBlocks / session.info.sampleRate;
  }
  if (!session.complete) tags._mineradioScanComplete = false;
  return tags;
}
/**
 * 解析 APE 内嵌封面：APEv2 二进制项优先，其次文件头 ID3v2 的 APIC。
 * @param {File|object} file 本地 APE 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<Blob|null>} 封面 Blob；没有封面时返回 null。
 */
async function extractApeEmbeddedCoverSource(file, opts) {
  var session = await readApeMetadataSession(file, opts);
  if (!session.info) return null;
  if (session.items.length) {
    var blob = apeTagPictureBlob(session.items);
    if (blob) return blob;
  }
  if (!session.info.junk) return null;
  var id3 = await readId3v2TagBytes(file, 0, session.maxTagBytes);
  return id3.bytes.length ? parseId3v2Picture(id3.bytes, 0) : null;
}
/**
 * 解析 APE 内嵌歌词：APEv2 歌词项优先，其次文件头 ID3v2 的 USLT。
 * @param {File|object} file 本地 APE 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<string>} 歌词文本；没有歌词时返回空字符串。
 */
async function extractApeEmbeddedLyricsText(file, opts) {
  var session = await readApeMetadataSession(file, opts);
  if (!session.info) return '';
  if (session.items.length) {
    var text = apeTagLyricsText(session.items);
    if (text) return text;
  }
  if (!session.info.junk) return '';
  var id3 = await readId3v2TagBytes(file, 0, session.maxTagBytes);
  return id3.bytes.length ? parseId3v2Lyrics(id3.bytes, 0) : '';
}
/**
 * 打开 DSF 元数据会话：解析 DSD/fmt 头与 ID3v2 位置。
 * @param {File|object} file 本地 DSF 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<object|null>} 会话对象；不是 DSF 时返回 null。
 */
async function readDsfMetadataSession(file, opts) {
  opts = opts || {};
  var win = localHeaderWindow(file, 0);
  try {
    var head = await win.at(0, 28);
    if (head.length < 28 || asciiFromBytes(head, 0, 4) !== 'DSD ') return null;
    var fmtOffset = uint64LE(head, 4);
    var metadataOffset = uint64LE(head, 20);
    if (fmtOffset < 28) return null;
    var fmt = await win.at(fmtOffset, 52);
    if (fmt.length < 52 || asciiFromBytes(fmt, 0, 4) !== 'fmt ') return null;
    return {
      channels: uint32LE(fmt, 24),
      sampleRate: uint32LE(fmt, 28),
      bitsPerSample: uint32LE(fmt, 32),
      sampleCount: uint64LE(fmt, 36),
      metadataOffset: metadataOffset,
      maxTagBytes: opts.light ? LOCAL_ASSET_LIGHT_SCAN_BYTES : LOCAL_MAX_TAG_BYTES
    };
  } finally {
    win.release();
  }
}
/**
 * 读取 DSF 头部指向的 ID3v2 标签。
 * @param {File|object} file 本地 DSF 文件记录。
 * @param {object} session DSF 元数据会话。
 * @returns {Promise<object>} `{bytes, truncated}`。
 */
async function readDsfId3v2Bytes(file, session) {
  var size = localFileSize(file) || 0;
  // metadataOffset 为 0 表示文件没有标签块。
  if (!session.metadataOffset || session.metadataOffset + 10 > size) {
    return { bytes: EMPTY_LOCAL_BYTES, truncated: false };
  }
  return await readId3v2TagBytes(file, session.metadataOffset, session.maxTagBytes);
}
/**
 * 解析 DSF 展示元数据与时长。
 * @param {File|object} file 本地 DSF 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<object>} 标签对象；`_mineradioScanComplete=false` 表示需要完整重试。
 */
async function extractDsfLocalMetadata(file, opts) {
  var session = await readDsfMetadataSession(file, opts);
  if (!session) return {};
  var tags = {};
  var id3 = await readDsfId3v2Bytes(file, session);
  if (id3.bytes.length) parseId3v2Tags(id3.bytes, 0, tags);
  if (id3.truncated) tags._mineradioScanComplete = false;
  // DSF 的 sample count 是单声道 1-bit 样本数，除以 DSD 采样率即为秒数。
  if (session.sampleRate > 0 && session.sampleCount > 0) tags.duration = session.sampleCount / session.sampleRate;
  return tags;
}
/**
 * 解析 DSF 内嵌封面。
 * @param {File|object} file 本地 DSF 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<Blob|null>} 封面 Blob；没有封面时返回 null。
 */
async function extractDsfEmbeddedCoverSource(file, opts) {
  var session = await readDsfMetadataSession(file, opts);
  if (!session) return null;
  var id3 = await readDsfId3v2Bytes(file, session);
  return id3.bytes.length ? parseId3v2Picture(id3.bytes, 0) : null;
}
/**
 * 解析 DSF 内嵌歌词。
 * @param {File|object} file 本地 DSF 文件记录。
 * @param {{light?:boolean}=} opts 是否限制轻量扫描范围。
 * @returns {Promise<string>} 歌词文本；没有歌词时返回空字符串。
 */
async function extractDsfEmbeddedLyricsText(file, opts) {
  var session = await readDsfMetadataSession(file, opts);
  if (!session) return '';
  var id3 = await readDsfId3v2Bytes(file, session);
  return id3.bytes.length ? parseId3v2Lyrics(id3.bytes, 0) : '';
}
/**
 * 按音频格式提取展示元数据标签。
 * @param {File|object} file 本地音频文件记录。
 * @param {{light?:boolean}=} opts 是否限制后台轻量扫描范围。
 * @returns {Promise<object>} 展示标签对象；无法解析时为空对象。
 */
async function extractLocalMetadataTags(file, opts) {
  if (!file) return {};
  var name = String(file.name || '').toLowerCase();
  try {
    var tags = null;
    if (/\.mp3$/.test(name)) tags = await extractMp3LocalMetadata(file);
    else if (/\.flac$/.test(name)) tags = await extractFlacLocalMetadata(file, opts);
    else if (/\.m4a$/.test(name)) tags = await extractM4aLocalMetadata(file, opts);
    else if (/\.(ogg|oga|opus)$/.test(name)) tags = await extractOggLocalMetadata(file, opts);
    else if (/\.wav$/.test(name)) tags = await extractWavLocalMetadata(file, opts);
    else if (/\.ape$/.test(name)) tags = await extractApeLocalMetadata(file, opts);
    else if (/\.dsf$/.test(name)) tags = await extractDsfLocalMetadata(file, opts);
    if (tags) return finalizeLocalMetadataReplayGain(tags);
  } catch (e) {
    console.warn('[LocalMetadata]', file && file.name, e);
  }
  return {};
}
function findFlacMetadataStart(bytes) {
  var pos = asciiFromBytes(bytes, 0, 4) === 'fLaC' ? 4 : -1;
  if (pos >= 0) return pos;
  for (var scan = 0; scan < Math.min(bytes.length - 4, 4096); scan++) {
    if (asciiFromBytes(bytes, scan, 4) === 'fLaC') return scan + 4;
  }
  return -1;
}
function normalizeEmbeddedLyricText(text) {
  text = String(text || '').replace(/^\uFEFF/, '').trim();
  if (text && text.indexOf('\n') < 0 && /\\[nr]/.test(text)) {
    text = text.replace(/\\r\\n|\\n|\\r/g, '\n');
  }
  return text.replace(/\r\n?/g, '\n').trim();
}
function embeddedLyricFieldPriority(key, value) {
  var normalized = String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  var hasTimeTags = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(String(value || ''));
  if (normalized === 'LYRICS') return hasTimeTags ? 100 : 90;
  if (normalized === 'SYNCEDLYRICS' || normalized === 'SYNCLYRICS') return hasTimeTags ? 95 : 70;
  if (normalized === 'LYRIC') return hasTimeTags ? 92 : 65;
  if (normalized === 'UNSYNCEDLYRICS' || normalized === 'UNSYNCEDLYRIC') return hasTimeTags ? 80 : 45;
  return hasTimeTags ? 25 : 0;
}
/**
 * 返回歌词字段在现有规则下可能达到的最高优先级，用于跳过不可能胜出的 value 解码。
 * @param {string} key Vorbis comment 字段名。
 * @returns {number} 该字段理论最高优先级。
 */
function embeddedLyricFieldMaxPriority(key) {
  var normalized = String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized === 'LYRICS') return 100;
  if (normalized === 'SYNCEDLYRICS' || normalized === 'SYNCLYRICS') return 95;
  if (normalized === 'LYRIC') return 92;
  if (normalized === 'UNSYNCEDLYRICS' || normalized === 'UNSYNCEDLYRIC') return 80;
  return 25;
}
/**
 * 判断字节是否为现有 LRC 时间标签规则使用的 ASCII 数字。
 * @param {number} value 单字节值。
 * @returns {boolean} 是否为 0 到 9。
 */
function isAsciiDigitByte(value) {
  return value >= 48 && value <= 57;
}
/**
 * 在原始 UTF-8 字节中识别现有正则支持的 LRC 时间标签，避免仅因普通方括号解码大型未知字段。
 * @param {Uint8Array} bytes Vorbis comment 字节。
 * @param {number} start value 起始偏移。
 * @param {number} end value 结束偏移，不含该位置。
 * @returns {boolean} 是否存在 `[m:ss]`、`[m:ss.xx]` 或 `[m:ss:xx]` 形式时间标签。
 */
function hasEmbeddedLyricTimeTagBytes(bytes, start, end) {
  // 逐个方括号验证完整数字结构，保持与 embeddedLyricFieldPriority() 的正则语义一致。
  for (var i = start; i < end; i++) {
    if (bytes[i] !== 91) continue;
    var p = i + 1;
    var minuteDigits = 0;
    while (p < end && minuteDigits < 3 && isAsciiDigitByte(bytes[p])) { p++; minuteDigits++; }
    if (!minuteDigits || p >= end || bytes[p] !== 58) continue;
    p++;
    if (p + 1 >= end || !isAsciiDigitByte(bytes[p]) || !isAsciiDigitByte(bytes[p + 1])) continue;
    p += 2;
    if (p < end && bytes[p] === 93) return true;
    if (p >= end || (bytes[p] !== 46 && bytes[p] !== 58)) continue;
    p++;
    var fractionDigits = 0;
    while (p < end && fractionDigits < 3 && isAsciiDigitByte(bytes[p])) { p++; fractionDigits++; }
    if (fractionDigits && p < end && bytes[p] === 93) return true;
  }
  return false;
}
/**
 * 把单个 VORBIS_COMMENT payload 合并到跨 block 的歌词候选结果。
 * @param {Uint8Array} bytes 完整 Vorbis payload。
 * @param {{priority:number,text:string}} best 当前最高优先级结果。
 * @returns {boolean} 是否命中最高优先级并可结束后续 block 读取。
 */
function parseFlacLyricsVorbisPayload(bytes, best) {
  var end = bytes.length;
  if (end <= 8) return false;
  var p = 0;
  var vendorLen = uint32LE(bytes, p); p += 4 + vendorLen;
  if (p + 4 > end) return false;
  var count = Math.min(uint32LE(bytes, p), 10000); p += 4;
  for (var i = 0; i < count && p + 4 <= end; i++) {
    var commentLen = uint32LE(bytes, p); p += 4;
    // 只有越界才说明 block 损坏；零长度 comment 仅跳过当前计数项。
    if (p + commentLen > end) break;
    if (!commentLen) continue;
    var commentStart = p;
    var commentEnd = p + commentLen;
    p = commentEnd;
    var eq = findByteInRange(bytes, commentStart, commentEnd, 61);
    if (eq <= commentStart) continue;
    var key = utf8FromBytes(bytes, commentStart, eq - commentStart).trim();
    var valueStart = eq + 1;
    var maxPriority = embeddedLyricFieldMaxPriority(key);
    if (best.priority >= maxPriority) continue;
    // 未知字段只有存在完整 LRC 时间标签才可能命中 priority 25 回退。
    if (maxPriority === 25 && !hasEmbeddedLyricTimeTagBytes(bytes, valueStart, commentEnd)) continue;
    var value = normalizeEmbeddedLyricText(utf8FromBytes(bytes, valueStart, commentEnd - valueStart));
    var priority = embeddedLyricFieldPriority(key, value);
    if (value && priority > best.priority) {
      best.priority = priority;
      best.text = value;
      // 100 是现有优先级上限，后续字段和 block 都不可能替换当前 first-wins 结果。
      if (priority === 100) return true;
    }
  }
  return false;
}
async function extractFlacEmbeddedLyricsText(file, opts) {
  if (!file) return '';
  opts = opts || {};
  var session = await readFlacMetadataSession(file, opts);
  if (session.metadataStart < 0) return '';
  var best = { priority: 0, text: '' };
  for (var blockIndex = 0; blockIndex < session.blocks.length; blockIndex++) {
    var block = session.blocks[blockIndex];
    if (block.type !== 4 || block.length <= 8) continue;
    var bytes = await readFlacMetadataBlockBytes(file, session, block);
    if (!bytes) break;
    if (parseFlacLyricsVorbisPayload(bytes, best)) return best.text;
  }
  return best.text || '';
}
function findZero(bytes, start, end, step) {
  step = step || 1;
  for (var i = start; i < end; i += step) {
    if (step === 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
    } else if (bytes[i] === 0) {
      return i;
    }
  }
  return -1;
}
/**
 * 把内嵌图片字节固化为独立 Blob，使完整标签范围可在解析后释放。
 * @param {Uint8Array} bytes 图片字节视图。
 * @param {string} mime 图片 MIME。
 * @returns {Blob} 只持有图片稳定快照的 Blob。
 */
function blobBytesToCoverBlob(bytes, mime) {
  return new Blob([bytes], { type: mime || 'image/jpeg' });
}
/**
 * 在单个 FLAC PICTURE block 边界内解析图片，拒绝越界的可变长度字段。
 * @param {Uint8Array} bytes FLAC 元数据字节。
 * @param {number} start PICTURE block 数据起点。
 * @param {number} end PICTURE block 结束偏移。
 * @returns {Blob|null} 有效图片 Blob；损坏 block 返回 null。
 */
function extractFlacPictureBlob(bytes, start, end) {
  var p = start;
  if (p + 8 > end) return null;
  p += 4;
  var mimeLen = uint32BE(bytes, p);
  p += 4;
  if (mimeLen > end - p) return null;
  var mimeStart = p;
  p += mimeLen;
  if (p + 4 > end) return null;
  var descLen = uint32BE(bytes, p);
  p += 4;
  if (descLen > end - p) return null;
  p += descLen;
  if (p + 20 > end) return null;
  p += 16;
  var dataLen = uint32BE(bytes, p);
  p += 4;
  if (dataLen <= 0 || dataLen > end - p) return null;
  var mime = asciiFromBytes(bytes, mimeStart, mimeLen) || 'image/jpeg';
  return blobBytesToCoverBlob(bytes.subarray(p, p + dataLen), mime);
}
/**
 * 解析 MP3 APIC/PIC 并返回短生命周期封面 Blob。
 * @param {File|object} file 本地 MP3 文件记录。
 * @returns {Promise<Blob|null>} 找到的封面 Blob；没有封面时返回 null。
 */
async function extractMp3EmbeddedCoverSource(file) {
  var bytes = await readMp3Id3v2Bytes(file);
  return bytes.length ? parseId3v2Picture(bytes, 0) : null;
}
/**
 * 解析 MP3 ID3v2 内嵌歌词。
 * @param {File|object} file 本地 MP3 文件记录。
 * @returns {Promise<string>} 优先级最高的歌词文本；没有歌词时返回空字符串。
 */
async function extractMp3EmbeddedLyricsText(file) {
  var bytes = await readMp3Id3v2Bytes(file);
  return bytes.length ? parseId3v2Lyrics(bytes, 0) : '';
}
/**
 * 解析 FLAC PICTURE 并返回短生命周期封面 Blob。
 * @param {File|object} file 本地 FLAC 文件记录。
 * @param {{light?:boolean}=} opts 是否限制后台轻量扫描范围。
 * @returns {Promise<Blob|null>} 找到的封面 Blob；没有封面时返回 null。
 */
async function extractFlacEmbeddedCoverSource(file, opts) {
  opts = opts || {};
  var session = await readFlacMetadataSession(file, opts);
  if (session.metadataStart < 0) return null;
  for (var blockIndex = 0; blockIndex < session.blocks.length; blockIndex++) {
    var block = session.blocks[blockIndex];
    if (block.type === 6 && block.length > 32) {
      var bytes = await readFlacMetadataBlockBytes(file, session, block);
      if (!bytes) return null;
      var pictureBlob = extractFlacPictureBlob(bytes, 0, bytes.length);
      if (pictureBlob) return pictureBlob;
    }
  }
  return null;
}
/**
 * 按音频格式提取短生命周期内嵌封面 Blob，避免后台先构造完整 data URL。
 * @param {File|object} file 本地音频文件记录。
 * @param {{light?:boolean}=} opts 是否限制后台轻量扫描范围。
 * @returns {Promise<Blob|null>} 找到的封面 Blob；没有封面时返回 null。
 */
async function extractEmbeddedCoverSource(file, opts) {
  if (!file) return null;
  var name = String(file.name || '').toLowerCase();
  try {
    if (/\.mp3$/.test(name)) return await extractMp3EmbeddedCoverSource(file);
    if (/\.flac$/.test(name)) return await extractFlacEmbeddedCoverSource(file, opts);
    if (/\.m4a$/.test(name)) return await extractM4aEmbeddedCoverSource(file, opts);
    if (/\.(ogg|oga|opus)$/.test(name)) return await extractOggEmbeddedCoverSource(file, opts);
    if (/\.wav$/.test(name)) return await extractWavEmbeddedCoverSource(file, opts);
    if (/\.ape$/.test(name)) return await extractApeEmbeddedCoverSource(file, opts);
    if (/\.dsf$/.test(name)) return await extractDsfEmbeddedCoverSource(file, opts);
  } catch (e) {
    console.warn('[LocalEmbeddedCover]', file && file.name, e);
  }
  return null;
}
/**
 * 按音频格式提取内嵌歌词文本。
 * @param {File|object} file 本地音频文件记录。
 * @param {{light?:boolean}=} opts 是否限制后台轻量扫描范围。
 * @returns {Promise<string>} 歌词文本；没有内嵌歌词时返回空字符串。
 */
async function extractEmbeddedLyricsText(file, opts) {
  if (!file) return '';
  var name = String(file.name || '').toLowerCase();
  try {
    if (/\.mp3$/.test(name)) return await extractMp3EmbeddedLyricsText(file);
    if (/\.flac$/.test(name)) return await extractFlacEmbeddedLyricsText(file, opts);
    if (/\.(ogg|oga|opus)$/.test(name)) return await extractOggEmbeddedLyricsText(file, opts);
    if (/\.wav$/.test(name)) return await extractWavEmbeddedLyricsText(file, opts);
    if (/\.ape$/.test(name)) return await extractApeEmbeddedLyricsText(file, opts);
    if (/\.dsf$/.test(name)) return await extractDsfEmbeddedLyricsText(file, opts);
  } catch (e) {
    console.warn('[LocalEmbeddedLyrics]', file && file.name, e);
  }
  return '';
}
/**
 * 返回内嵌标签来源标签文本，用于歌词面板显示解析出处。
 * @param {object} song 本地歌曲。
 * @returns {string} 来源标签。
 */
function embeddedLyricSourceLabel(song) {
  var name = String((song && (song.localFileName || song.name)) || '').toLowerCase();
  var match = /\.([a-z0-9]+)$/.exec(name);
  return (match ? match[1].toUpperCase() : 'LOCAL') + ' LYRICS';
}
