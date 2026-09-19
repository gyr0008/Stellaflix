const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 39873;
const ORIGIN = 'http://127.0.0.1:' + PORT;
process.env.PORT = String(PORT);
delete process.env.HOST;

// 凭证库隔离：必须在 require('../server.js')（它 require subsonic-api）之前设置，
// 否则 saveServer 会写进 app 真实的 data/subsonic-servers.json
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfz-subsonic-routes-'));
process.env.STELLAFIX_SUBSONIC_CONFIG_FILE = path.join(tmp, 'subsonic-servers.json');

// 假 Subsonic 上游（真实 server 先于它 require 顺序无关，都走 listen 后再断言）
let lastAuthQuery = null;
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  lastAuthQuery = u.searchParams;
  const ok = (payload) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ 'subsonic-response': Object.assign({ status: 'ok', version: '1.16.1' }, payload) })); };
  // 仿真 Navidrome：无 f=json 一律回 XML（res.json() 解析必炸 → 暴露缺参回归）
  if (u.searchParams.get('f') !== 'json') {
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end('<?xml version="1.0" encoding="UTF-8"?><subsonic-response status="failed"/>');
    return;
  }
  if (u.pathname === '/rest/getArtists.view') return ok({ artists: { index: [{ name: 'A', artist: [{ id: 'ar-1', name: 'Artist One', albumCount: 2 }] }] } });
  if (u.pathname === '/rest/getArtist.view') return ok({ artist: { id: 'ar-1', name: 'Artist One', album: [{ id: 'al-1', name: 'Album X', artist: 'Artist One', songCount: 1, duration: 213 }] } });
  if (u.pathname === '/rest/getAlbum.view') {
    const aid = u.searchParams.get('id') || '';
    const song = aid === 'al-empty' ? [] : [{ id: 'tr-9', title: 'Song Nine', artist: 'Artist One', artistId: 'ar-1', album: 'Album X', albumId: aid, duration: 12, contentType: 'audio/mpeg' }];
    return ok({ album: { id: aid, name: aid === 'al-empty' ? 'Empty Album' : 'Album X', songCount: song.length, song } });
  }
  if (u.pathname === '/rest/stream.view') { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(Buffer.from([0x49, 0x44, 0x33])); return; }
  res.writeHead(404).end('{}');
});
let fakePort;
test.before(async () => { fakePort = (await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(fake.address().port)))); });

const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;
async function waitListening() { if (!server.listening) await new Promise((resolve) => server.once('listening', resolve)); }
const sub = require('../subsonic-api.js');
let serverId = '';

test('POST /api/subsonic/config 保存后 GET 不回显密码', async () => {
  await waitListening();
  assert.strictEqual(sub.CONFIG_FILE, process.env.STELLAFIX_SUBSONIC_CONFIG_FILE);   // 隔离生效：不写真实凭证库
  const r = await fetch(BASE + '/api/subsonic/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ name: 'lan', baseUrl: 'http://127.0.0.1:' + fakePort, username: 'alice', password: 'guessme' }),
  });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  serverId = j.server.id;
  assert.ok(sub.getServer(serverId).password);
  const g = await (await fetch(BASE + '/api/subsonic/config')).json();
  assert.strictEqual(JSON.stringify(g).includes('guessme'), false);
});

test('恶意 Origin 的 POST 仍被全局 403 拦截', async () => {
  await waitListening();
  const r = await fetch(BASE + '/api/subsonic/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ action: 'delete', id: serverId }),
  });
  assert.strictEqual(r.status, 403);
});

test('POST /api/subsonic/config 携带未知 id 保存 → 404，不静默新建重复记录', async () => {
  await waitListening();
  const idsBefore = new Set((await (await fetch(BASE + '/api/subsonic/config')).json()).servers.map((s) => s.id));
  const r = await fetch(BASE + '/api/subsonic/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ id: 'no-such-id', name: 'ghost', baseUrl: 'http://127.0.0.1:' + fakePort, username: 'bob', password: 'pw' }),
  });
  const j = await r.json().catch(() => ({}));
  // RED 兜底：若保存分支误放行（走到 saveServer 新建），清掉幽灵记录，不污染真实配置文件
  if (r.status === 200) {
    for (const s of (j.servers || [])) if (!idsBefore.has(s.id)) sub.deleteServer(s.id);
  }
  assert.strictEqual(r.status, 404);
  assert.strictEqual(j.error, 'SUBSONIC_SERVER_NOT_FOUND');
});

test('GET /api/subsonic/artists 经上游 token 认证并映射', async () => {
  await waitListening();
  const r = await fetch(BASE + '/api/subsonic/artists?server=' + serverId);
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.indexes[0].artists[0].id, 'ar-1');
  assert.strictEqual(lastAuthQuery.get('u'), 'alice');
  assert.ok(lastAuthQuery.get('t'));
  assert.ok(lastAuthQuery.get('s'));
});

test('GET /api/subsonic/album 的 songs 带 localUrl 且可经 /api/audio 播放', async () => {
  await waitListening();
  const empty = await (await fetch(BASE + '/api/subsonic/album?server=' + serverId + '&id=al-empty')).json();
  assert.strictEqual(empty.songs.length, 0);   // 空专辑不崩
  const j = await (await fetch(BASE + '/api/subsonic/album?server=' + serverId + '&id=al-1')).json();
  assert.strictEqual(j.songs.length, 1);
  assert.strictEqual(j.songs[0].id, 'tr-9');
  assert.ok(j.songs[0].localUrl.startsWith('/api/audio?url='));
  // 真集成验证：播放地址交给既有 /api/audio 代理能取回上游音频字节
  const audio = await fetch(BASE + j.songs[0].localUrl);
  assert.strictEqual(audio.status, 200);
  assert.deepStrictEqual(Buffer.from(await audio.arrayBuffer()), Buffer.from([0x49, 0x44, 0x33]));
  const k = await (await fetch(BASE + '/api/subsonic/artist?server=' + serverId + '&id=ar-1')).json();
  assert.strictEqual(k.albums[0].title, 'Album X');
});

test('未知 server 参数 → 404 SUBSONIC_SERVER_NOT_FOUND', async () => {
  await waitListening();
  const r = await fetch(BASE + '/api/subsonic/artists?server=nope');
  assert.strictEqual(r.status, 404);
  const j = await r.json();
  assert.strictEqual(j.error, 'SUBSONIC_SERVER_NOT_FOUND');
});

test('清理：删除配置', async () => {
  await waitListening();
  const r = await fetch(BASE + '/api/subsonic/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ action: 'delete', id: serverId }),
  });
  assert.strictEqual((await r.json()).ok, true);
});

after(() => {
  server.close();
  fake.close();
  sub.deleteServer(serverId);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 临时目录清不掉不影响结论 */ }
});
