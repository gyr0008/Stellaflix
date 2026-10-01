'use strict';
/** 运行：node --test tests/huilian-qbt-upload-form.test.js */
const test = require('node:test');
const assert = require('node:assert');
const dm = require('../desktop/download-manager');

test('buildAddFormBody: magnet 分支 = urlencoded', () => {
  const r = dm.buildAddFormBody({ url: 'magnet:?xt=urn:btih:abc' }, { qbt: { defaultSavePath: 'D:/x' } });
  assert.strictEqual(r.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(/urls=magnet/.test(r.body.toString()));
  assert.ok(/sequentialDownload=true/.test(r.body.toString()));
});
test('buildAddFormBody: base64 分支 = multipart 含 torrents 文件段', () => {
  const r = dm.buildAddFormBody({ torrentBase64: Buffer.from('TOR').toString('base64'), fileName: 'a.torrent' }, { qbt: { defaultSavePath: 'D:/x' } });
  assert.match(r.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  const s = r.body.toString('latin1');
  assert.ok(s.includes('name="torrents"; filename="a.torrent"'));
  assert.ok(s.includes('Content-Disposition: form-data; name="sequentialDownload"'));
});
test('buildAddFormBody: 两者皆空 → throw', () => {
  assert.throws(() => dm.buildAddFormBody({}, { qbt: {} }));
});

// ---- 以下为补充的字节结构 / 安全断言（不改变上面三条契约）----

test('buildAddFormBody: multipart 字节结构正确（boundary 行 / CRLF / 终止符 / 文件字节）', () => {
  const raw = Buffer.from('TOR');
  const r = dm.buildAddFormBody({ torrentBase64: raw.toString('base64'), fileName: 'a.torrent' }, { qbt: { defaultSavePath: 'D:/x' } });
  const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(r.headers['Content-Type'])[1];
  const s = r.body.toString('latin1');
  // 首段以 --boundary\r\n 开头；段间以 \r\n--boundary\r\n 分隔，共 7 个字段段
  assert.ok(s.startsWith('--' + boundary + '\r\n'), '首段前缀必须是 --boundary + CRLF');
  assert.strictEqual(s.split('\r\n--' + boundary + '\r\n').length, 7, '应切出 7 个字段段（6 个文本 + 1 个文件）');
  assert.ok(s.includes('\r\n\r\n' + raw.toString('latin1') + '\r\n'), '文件段头部以空行结尾，内容后紧跟 CRLF');
  // 终止符：--boundary-- 结尾
  assert.ok(s.endsWith('\r\n--' + boundary + '--\r\n'), '必须以 --boundary-- 终止符收尾');
  // savepath 值按 config 落到表单里
  assert.ok(s.includes('Content-Disposition: form-data; name="savepath"\r\n\r\nD:/x\r\n'), 'savepath 段值来自 cfg');
  // 文件段声明 Content-Type
  assert.ok(s.includes('Content-Type: application/x-bittorrent'), '文件段应带 x-bittorrent 类型');
  // 纯 Buffer 返回，长度与 latin1 文本一致（字节级构造，非字符串拼接后转码丢字节）
  assert.ok(Buffer.isBuffer(r.body), 'multipart body 必须是 Buffer');
  assert.strictEqual(r.body.length, Buffer.from(s, 'latin1').length);
});

test('buildAddFormBody: fileName 含 CR/LF/引号时被净化（防 multipart header 注入）', () => {
  const evil = 'a"b\r\nX-Injected: 1\r\nc.torrent';
  const r = dm.buildAddFormBody({ torrentBase64: Buffer.from('TORMAYBE').toString('base64'), fileName: evil }, { qbt: {} });
  const s = r.body.toString('latin1');
  // 净化后 CR/LF 已去除，注入文本不可能成为独立 header 行（真实安全属性）
  assert.ok(!s.split('\r\n').some(l => /^X-Injected:/.test(l)), '不得出现被注入的伪 header 行');
  const line = s.split('\r\n').find(l => l.indexOf('name="torrents"') !== -1);
  assert.ok(line, '必须存在 torrents 文件段');
  // 净化后：整行只有包裹用的 4 个引号，且 filename 内无 CR/LF/引号
  assert.strictEqual((line.match(/"/g) || []).length, 4, 'Content-Disposition 行只允许 4 个引号');
  assert.match(line, /^Content-Disposition: form-data; name="torrents"; filename="[^"\r\n]*"$/);
});

test('buildAddFormBody: url 分支字段集与既有实现一致（savepath/autoTMM/paused/seedingTimeLimit/firstLastPiecePrio）', () => {
  const r = dm.buildAddFormBody({ url: 'magnet:?x', savePath: 'E:/y', autoStart: false }, { qbt: { defaultSavePath: 'D:/x' } });
  const body = r.body.toString();
  assert.ok(body.includes('savepath=E%3A%2Fy'), 'opts.savePath 优先于 cfg');
  assert.ok(body.includes('autoTMM=false'));
  assert.ok(body.includes('paused=true'), 'autoStart=false → paused=true');
  assert.ok(body.includes('seedingTimeLimit=0'));
  assert.ok(body.includes('firstLastPiecePrio=true'));
});
