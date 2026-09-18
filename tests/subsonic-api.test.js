const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfz-subsonic-'));
process.env.STELLAFIX_SUBSONIC_CONFIG_FILE = path.join(tmp, 'subsonic-servers.json');
const sub = require('../subsonic-api.js');

test('token 认证：t = md5(password + salt)', () => {
  const p = sub.authParams({ username: 'alice', password: 'guessme' }, 'salt123');
  assert.strictEqual(p.u, 'alice');
  assert.strictEqual(p.s, 'salt123');
  assert.strictEqual(p.t, 'b9777213162ed1a3cc3eb04ed0c7d95b'); // md5('guessme'+'salt123')，值预先算好
});

test('buildRestUrl 带 v/c/u/s/t 且路径为 /rest/<endpoint>.json', () => {
  const url = new URL(sub.buildRestUrl(
    { baseUrl: 'http://navi.lan:4533', username: 'alice', password: 'guessme' },
    'getAlbum', { id: 'al-1' }));
  assert.strictEqual(url.pathname, '/rest/getAlbum.json');
  assert.strictEqual(url.searchParams.get('v'), '1.16.1');
  assert.strictEqual(url.searchParams.get('c'), 'Stellaflix');
  assert.ok(url.searchParams.get('t'));
  assert.strictEqual(url.searchParams.get('id'), 'al-1');
});

test('saveServer：非法 baseUrl 拒绝', () => {
  assert.throws(() => sub.saveServer({ baseUrl: 'ftp://x', username: 'a', password: 'b' }), /SUBSONIC_BAD_BASE_URL/);
  assert.throws(() => sub.saveServer({ baseUrl: 'http://x', username: '', password: 'b' }), /SUBSONIC_MISSING_USERNAME/);
  assert.throws(() => sub.saveServer({ baseUrl: 'http://x', username: 'a', password: '' }), /SUBSONIC_MISSING_PASSWORD/);
});

test('saveServer/deleteServer 往返 + 公开视图不泄露密码 + 文件落盘', () => {
  const saved = sub.saveServer({ name: '家里', baseUrl: 'http://navi.lan:4533/', username: 'alice', password: 'guessme' });
  assert.ok(saved.id);
  assert.strictEqual(saved.baseUrl, 'http://navi.lan:4533');
  assert.strictEqual('password' in saved, false);
  const pub = sub.listServersPublic();
  assert.strictEqual(pub[0].hasPassword, true);
  assert.strictEqual(JSON.stringify(pub).includes('guessme'), false);
  const raw = JSON.parse(fs.readFileSync(process.env.STELLAFIX_SUBSONIC_CONFIG_FILE, 'utf8'));
  assert.strictEqual(raw.servers[0].password, 'guessme');
  // 空密码编辑 = 保留旧密码
  const edited = sub.saveServer({ id: saved.id, name: 'NAS', baseUrl: 'http://navi.lan:4533', username: 'alice', password: '' });
  assert.strictEqual(edited.name, 'NAS');
  assert.strictEqual(sub.getServer(saved.id).password, 'guessme');
  assert.strictEqual(sub.deleteServer(saved.id), true);
  assert.strictEqual(sub.deleteServer(saved.id), false);
});

test('mapTrack 生成 localUrl/cover 走 /api/audio 代理', () => {
  const server = { id: 's1', baseUrl: 'http://navi.lan:4533', username: 'alice', password: 'guessme' };
  const song = sub.mapTrack(server, { id: 'tr-1', title: '曲 A', artist: '歌手 B', album: '专 C', albumId: 'al-1', duration: 213, coverArt: 'co-1' });
  assert.strictEqual(song.type, 'subsonic');
  assert.strictEqual(song.source, 'subsonic');
  assert.strictEqual(song.serverId, 's1');
  assert.strictEqual(song.name, '曲 A');
  assert.strictEqual(song.duration, 213);
  assert.ok(song.localUrl.startsWith('/api/audio?url='));
  const inner = decodeURIComponent(song.localUrl.slice('/api/audio?url='.length));
  assert.ok(inner.startsWith('http://navi.lan:4533/rest/stream.json?'));
  assert.ok(inner.includes('id=tr-1'));
  assert.ok(inner.includes('u=alice') && inner.includes('&s=') && inner.includes('&t='));
  assert.ok(song.cover.startsWith('/api/audio?url='));
  assert.ok(decodeURIComponent(song.cover).includes('getCoverArt.json'));
});

test('browseAlbum 经假上游返回映射歌曲', async () => {
  const fake = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/rest/getAlbum.json') {
      assert.ok(u.searchParams.get('t'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', album: {
        id: 'al-1', name: '专 C', artist: '歌手 B', coverArt: 'co-1', songCount: 1, duration: 213,
        song: [{ id: 'tr-1', title: '曲 A', artist: '歌手 B', artistId: 'ar-1', album: '专 C', albumId: 'al-1', duration: 213, contentType: 'audio/flac' }],
      } } }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    const saved = sub.saveServer({ name: 'fake', baseUrl: 'http://127.0.0.1:' + fake.address().port, username: 'alice', password: 'guessme' });
    const r = await sub.browseAlbum(saved.id, 'al-1');
    assert.strictEqual(r.album.title, '专 C');
    assert.strictEqual(r.songs.length, 1);
    assert.strictEqual(r.songs[0].id, 'tr-1');
    assert.ok(r.songs[0].localUrl.startsWith('/api/audio?url='));
    assert.strictEqual(sub.deleteServer(saved.id), true);
  } finally { fake.close(); }
});

test('subsonicCall 上游 status=error 抛 SUBSONIC_<code>', async () => {
  const fake = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username or password' } } }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      sub.subsonicCall({ baseUrl: 'http://127.0.0.1:' + fake.address().port, username: 'a', password: 'b' }, 'ping', {}),
      /SUBSONIC_40/);
  } finally { fake.close(); }
});
