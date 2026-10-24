'use strict';

/**
 * tests/lx-search.test.js — lx-search.js 五家内置爬虫 + 熔断冷却/搜索缓存
 * fetch 桩回放 tests/fixtures/lx-search/*.json（按移植后的 scraper 解析路径反推的最小样本），
 * 全程零真实网络；冷却退避与时钟相关断言一律走注入 now（Task 6），不做墙钟等待。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createLxSearch } = require('../lx-search');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'lx-search');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');

// 各家爬虫命中的线上域名（上游端点 verbatim），用于 fetch 桩路由。
const HOSTS = {
  tx: 'u.y.qq.com',
  wy: 'interface.music.163.com',
  kw: 'search.kuwo.cn',
  kg: 'songsearch.kugou.com',
  mg: 'jadeite.migu.cn',
};

const jsonResponse = (data) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => (typeof data === 'function' ? data() : data),
});

function makeFixtureFetch(overrides = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    for (const [source, behavior] of Object.entries(overrides)) {
      if (!url.includes(HOSTS[source])) continue;
      if (behavior === 'fail') throw new Error(`LX_TEST_DOWN_${source}`);
      if (typeof behavior === 'function') return behavior(url, options);
      return jsonResponse(behavior);
    }
    throw new Error(`LX_TEST_UNEXPECTED_URL ${url}`);
  };
  return { impl, calls };
}

const allFixtures = () => ({
  tx: JSON.parse(readFixture('tx.json')),
  wy: JSON.parse(readFixture('wy.json')),
  kw: JSON.parse(readFixture('kw.json')),
  kg: JSON.parse(readFixture('kg.json')),
  mg: JSON.parse(readFixture('mg.json')),
});

// ---------- 单源解析（song 冻结形状逐字段深比较，多余键即失败） ----------

test('searchOne tx：解析 req.data.body.item_song 为冻结 song 形状，QQ 签名与 UA/请求体透传', async () => {
  const fixture = JSON.parse(readFixture('tx.json'));
  const { impl, calls } = makeFixtureFetch({ tx: fixture });
  const { searchOne } = createLxSearch({ fetchImpl: impl });
  const songs = await searchOne('tx', { query: '周杰伦', limit: 12 });

  assert.equal(songs.length, 3, 'searchOne 不做去重，原样返回解析行');
  assert.deepStrictEqual(songs[0], {
    source: 'tx',
    id: 100200,
    songmid: '004TesTx',
    name: '夜曲',
    singer: '周杰伦、费玉清',
    album: '十一月的萧邦',
    interval: '3:34',
    pic: 'https://y.gtimg.cn/music/photo_new/T002R500x500M00008g20Z3F47tQQ0.jpg',
  });
  // 无专辑 mid 的行 album/pic 为空串，标题走 songname 回退。
  assert.deepStrictEqual(songs[2], {
    source: 'tx',
    id: 100300,
    songmid: '003Other',
    name: '黑色毛衣',
    singer: '周杰伦',
    album: '',
    interval: '4:05',
    pic: '',
  });

  const call = calls.find((c) => c.url.includes(HOSTS.tx));
  assert.ok(/^https:\/\/u\.y\.qq\.com\/cgi-bin\/musics\.fcg\?sign=zzc[0-9a-z]+$/.test(call.url), call.url);
  assert.equal(call.options.headers['user-agent'], 'QQMusic 14090508(android 12)');
  assert.equal(call.options.headers['content-type'], 'application/json');
  assert.equal(call.options.headers.referer, 'https://u.y.qq.com/');
  const body = JSON.parse(call.options.body);
  assert.equal(body.req.module, 'music.search.SearchCgiService');
  assert.equal(body.req.method, 'DoSearchForQQMusicMobile');
  assert.equal(body.req.param.query, '周杰伦');
  assert.equal(body.req.param.num_per_page, 12);
});

test('searchOne wy：eapi AES-128-ECB 参数加密可回解，resources 解析为冻结 song 形状', async () => {
  const fixture = JSON.parse(readFixture('wy.json'));
  const { impl, calls } = makeFixtureFetch({ wy: fixture });
  const { searchOne } = createLxSearch({ fetchImpl: impl });
  const songs = await searchOne('wy', { query: '测试芸', limit: 10 });

  assert.deepStrictEqual(songs, [{
    source: 'wy',
    id: '952700',
    songmid: '952700',
    name: '芸测试曲',
    singer: '芸歌手',
    album: '芸专辑',
    interval: '3:12',
    pic: 'https://p3.music.126.net/cover.jpg',
  }]);

  const call = calls.find((c) => c.url.includes(HOSTS.wy));
  assert.equal(call.url, 'http://interface.music.163.com/eapi/batch');
  assert.equal(call.options.method, 'POST');
  const params = new URLSearchParams(call.options.body).get('params');
  assert.ok(/^[0-9A-F]+$/.test(params), 'params 必须为大写十六进制密文');
  const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null);
  const plain = Buffer.concat([decipher.update(Buffer.from(params, 'hex')), decipher.final()]).toString('utf8');
  const [apiPath, payloadText, digest] = plain.split('-36cd479b6b5-');
  assert.equal(apiPath, '/api/search/song/list/page');
  const payload = JSON.parse(payloadText);
  assert.equal(payload.keyword, '测试芸');
  assert.equal(payload.limit, 10);
  assert.equal(digest, crypto.createHash('md5').update(`nobody${apiPath}use${payloadText}md5forencrypt`).digest('hex'));
});

test('searchOne kw：abslist 解析，MUSIC_ 前缀剥离与封面相对路径归一', async () => {
  const fixture = JSON.parse(readFixture('kw.json'));
  const { impl } = makeFixtureFetch({ kw: fixture });
  const { searchOne } = createLxSearch({ fetchImpl: impl });
  const songs = await searchOne('kw', { query: '测试蜗', limit: 12 });

  assert.deepStrictEqual(songs[0], {
    source: 'kw',
    id: '345678',
    songmid: '345678',
    name: '蜗测试曲',
    singer: '蜗歌手',
    album: '蜗专辑',
    interval: '3:05',
    pic: 'https://img1.kuwo.cn/star/albumcover/500/34/5678.jpg',
  });
  assert.equal(songs[1].pic, 'https://img1.kuwo.cn/star/albumcover/500/99/999.jpg',
    '绝对 star/albumcover 链接同样按上游规则重写到 img1/500');
});

test('searchOne kg：Singers 数组拼接、SingerName 回退，limit 上限钳到 30', async () => {
  const fixture = JSON.parse(readFixture('kg.json'));
  const { impl, calls } = makeFixtureFetch({ kg: fixture });
  const { searchOne } = createLxSearch({ fetchImpl: impl });
  const songs = await searchOne('kg', { query: '测试狗', limit: 99 });

  assert.deepStrictEqual(songs, [
    {
      source: 'kg',
      id: 8880001,
      songmid: 8880001,
      hash: 'ABCDEF0123456789',
      name: '狗测试曲',
      singer: '狗歌手甲、狗歌手乙',
      album: '狗专辑',
      interval: '3:20',
      pic: '',
    },
    {
      source: 'kg',
      id: 8880002,
      songmid: 8880002,
      hash: '',
      name: '无歌手曲',
      singer: '独歌手',
      album: '',
      interval: '0:00',
      pic: '',
    },
  ]);
  assert.ok(calls[0].url.includes('pagesize=30'), 'limit 钳制上限 30（上游 :371 语义）');
});

test('searchOne mg：md5 签名头齐备，songResultData 分组展平并过滤缺 copyrightId 行', async () => {
  const fixture = JSON.parse(readFixture('mg.json'));
  const { impl, calls } = makeFixtureFetch({ mg: fixture });
  const { searchOne } = createLxSearch({ fetchImpl: impl });
  const songs = await searchOne('mg', { query: '测试菇', limit: 12 });

  assert.deepStrictEqual(songs, [
    {
      source: 'mg',
      id: 'mg_600001',
      songmid: 'mg_600001',
      copyrightId: 'CR_600001',
      name: '菇测试曲',
      singer: '菇歌手',
      album: '菇专辑',
      interval: '4:00',
      pic: 'https://p5.migu.cn/3.jpg',
    },
    {
      source: 'mg',
      id: 'mg_600002',
      songmid: 'mg_600002',
      copyrightId: 'CR_600002',
      name: '无图曲',
      singer: '备选歌手',
      album: '',
      interval: '1:05',
      pic: '',
    },
  ]);

  const headers = calls[0].options.headers;
  assert.equal(headers.uiVersion, 'A_music_3.6.1');
  assert.equal(headers.channel, '0146921');
  assert.match(headers.deviceId, /^[0-9A-F]{32}$/);
  assert.match(headers.timestamp, /^\d{13}$/);
  assert.match(headers.sign, /^[0-9a-f]{32}$/);
});

// ---------- searchAll 聚合 ----------

test('searchAll：五家并发聚合 + `source|songmid||id` 去重，无 failures', async () => {
  const { impl, calls } = makeFixtureFetch(allFixtures());
  const { searchAll } = createLxSearch({ fetchImpl: impl });
  const { songs, failures } = await searchAll({ query: '周杰伦' });

  assert.deepStrictEqual(failures, []);
  const bySource = {};
  for (const song of songs) (bySource[song.source] ||= []).push(song);
  assert.deepStrictEqual(Object.keys(bySource).sort(), ['kg', 'kw', 'mg', 'tx', 'wy']);
  assert.equal(bySource.tx.length, 2, '同 mid 重复行被去重（fixture 第 1/2 行同 mid）');
  assert.equal(calls.length, 5);
});

test('searchAll：单源失败上浮 {source,error}，其余四家不受牵连', async () => {
  const { impl } = makeFixtureFetch({ ...allFixtures(), kw: 'fail' });
  const { searchAll } = createLxSearch({ fetchImpl: impl });
  const { songs, failures } = await searchAll({ query: '测试' });

  assert.deepStrictEqual(failures, [{ source: 'kw', error: 'LX_TEST_DOWN_kw' }]);
  assert.deepStrictEqual([...new Set(songs.map((s) => s.source))].sort(), ['kg', 'mg', 'tx', 'wy']);
});

test('searchAll：sources 数组/逗号串都只圈定 fan-out', async () => {
  const fixtures = allFixtures();
  const a = makeFixtureFetch(fixtures);
  const searchA = createLxSearch({ fetchImpl: a.impl });
  const resA = await searchA.searchAll({ query: '测试', sources: ['kg'] });
  assert.equal(a.calls.length, 1);
  assert.ok(a.calls[0].url.includes(HOSTS.kg));
  assert.equal(resA.songs.length, 2);

  const b = makeFixtureFetch(fixtures);
  const searchB = createLxSearch({ fetchImpl: b.impl });
  await searchB.searchAll({ query: '测试', sources: 'tx,bogus,mg' });
  assert.equal(b.calls.length, 2);
  assert.ok(b.calls.every((c) => c.url.includes(HOSTS.tx) || c.url.includes(HOSTS.mg)));
});

test('searchAll：空 query 直接返回空结果且不出网', async () => {
  const { impl, calls } = makeFixtureFetch(allFixtures());
  const { searchAll } = createLxSearch({ fetchImpl: impl });
  const result = await searchAll({ query: '   ' });
  assert.deepStrictEqual(result, { songs: [], failures: [] });
  assert.equal(calls.length, 0);
});

// ---------- HTTP 层（上游 :66-107） ----------

test('fetchJson：429 按 Retry-After 秒数退避后重试，第三次成功', async () => {
  let attempt = 0;
  const fixture = JSON.parse(readFixture('kg.json'));
  const impl = async () => {
    attempt += 1;
    if (attempt < 3) {
      const headerValue = attempt === 1 ? '1' : '0';
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? headerValue : null) },
        json: async () => ({}),
      };
    }
    return jsonResponse(fixture);
  };
  const { searchOne } = createLxSearch({ fetchImpl: impl });
  const started = Date.now();
  const songs = await searchOne('kg', { query: '测试', limit: 12 });
  const elapsed = Date.now() - started;
  assert.equal(attempt, 3);
  assert.equal(songs.length, 2);
  // 首轮 Retry-After:1 → max(350, 1000)=1s；次轮退避 700ms。取整下界 950ms 防计时抖动。
  assert.ok(elapsed >= 950, `Retry-After 未生效？elapsed=${elapsed}`);
});

test('fetchJson：非可重试错误立即上浮，不消耗三次重试', async () => {
  let attempt = 0;
  const { searchOne } = createLxSearch({ fetchImpl: async () => { attempt += 1; throw new Error('LX_TEST_BOOM'); } });
  await assert.rejects(searchOne('tx', { query: '测试' }), /LX_TEST_BOOM/);
  assert.equal(attempt, 1);
});

// ---------- 熔断冷却 + 搜索缓存（Task 6，上游 :361-394 / :359-375 / :406-409） ----------

test('熔断冷却：同一源连续 3 败后第 4 次 searchAll 不出网，failures 含 {source,code:"SOURCE_COOLDOWN"}，他源不受牵连', async () => {
  const { impl, calls } = makeFixtureFetch({ ...allFixtures(), kw: 'fail' });
  const { searchAll } = createLxSearch({ fetchImpl: impl, now: () => 1_700_000_000_000 });
  const kwCalls = () => calls.filter((c) => c.url.includes(HOSTS.kw)).length;
  const kgCalls = () => calls.filter((c) => c.url.includes(HOSTS.kg)).length;

  for (let i = 1; i <= 3; i++) {
    const { failures } = await searchAll({ query: `冷却${i}`, sources: ['kg', 'kw'] });
    assert.deepStrictEqual(failures, [{ source: 'kw', error: 'LX_TEST_DOWN_kw' }]);
  }
  assert.equal(kwCalls(), 3);

  const fourth = await searchAll({ query: '冷却4', sources: ['kg', 'kw'] });
  assert.equal(kwCalls(), 3, '第 4 次不得再碰 kw 的 fetch');
  assert.deepStrictEqual(fourth.failures, [{ source: 'kw', code: 'SOURCE_COOLDOWN' }]);
  assert.equal(kgCalls(), 4, 'kg 不因 kw 冷却被跳过');
  assert.ok(fourth.songs.some((s) => s.source === 'kg'));
});

test('指数退避：连续失败冷却时长 2s/4s/8s/16s/32s/64s 翻倍递增，封顶 120s（注入时钟边界断言）', async () => {
  let clock = 1_700_000_000_000;
  const { impl, calls } = makeFixtureFetch({ ...allFixtures(), kw: 'fail' });
  const { searchAll } = createLxSearch({ fetchImpl: impl, now: () => clock });
  const kwCalls = () => calls.filter((c) => c.url.includes(HOSTS.kw)).length;

  // 前三败逐次出网；第 3 败后武装 2s 冷却。
  for (let i = 1; i <= 3; i++) await searchAll({ query: `退避${i}`, sources: ['kg', 'kw'] });
  assert.equal(kwCalls(), 3);

  // 每档：距上次失败 ms-1 仍拒绝，恰好 ms 放行（放行那次再败 → 进入下一档时长）。
  // 第 9 败理论值 1000*2^7=128s，本档断言恰好 120s 放行即证明封顶生效。
  let attempted = 3;
  for (const ms of [2000, 4000, 8000, 16000, 32000, 64000, 120000]) {
    attempted += 1;
    clock += ms - 1;
    const blocked = await searchAll({ query: `退避边界${ms}拒`, sources: ['kg', 'kw'] });
    assert.equal(kwCalls(), attempted - 1, `上次失败后 ${ms - 1}ms 应仍处冷却`);
    assert.deepStrictEqual(blocked.failures, [{ source: 'kw', code: 'SOURCE_COOLDOWN' }]);
    clock += 1;
    await searchAll({ query: `退避边界${ms}放`, sources: ['kg', 'kw'] });
    assert.equal(kwCalls(), attempted, `上次失败后恰好 ${ms}ms 应放行`);
  }
});

test('复位语义：源恢复成功后 strikes 清零，需再连续 3 败才重新熔断（上游 :387-388）', async () => {
  const kwFixture = JSON.parse(readFixture('kw.json'));
  let kwDown = true;
  const { impl, calls } = makeFixtureFetch({
    ...allFixtures(),
    kw: () => {
      if (kwDown) throw new Error('LX_TEST_DOWN_kw');
      return jsonResponse(kwFixture);
    },
  });
  const { searchAll } = createLxSearch({ fetchImpl: impl, now: () => 1_700_000_000_000 });
  const kwCalls = () => calls.filter((c) => c.url.includes(HOSTS.kw)).length;

  await searchAll({ query: '复位1', sources: ['kg', 'kw'] });
  await searchAll({ query: '复位2', sources: ['kg', 'kw'] });
  kwDown = false;
  const ok = await searchAll({ query: '复位3', sources: ['kg', 'kw'] });
  assert.deepStrictEqual(ok.failures, [], '恢复成功不再带 failures');
  assert.ok(ok.songs.some((s) => s.source === 'kw'));

  kwDown = true;
  for (let i = 4; i <= 6; i++) await searchAll({ query: `复位${i}`, sources: ['kg', 'kw'] });
  assert.equal(kwCalls(), 6, '复位后须再满 3 连败才冷却，第 6 次调用仍出了网');
  const blocked = await searchAll({ query: '复位7', sources: ['kg', 'kw'] });
  assert.deepStrictEqual(blocked.failures, [{ source: 'kw', code: 'SOURCE_COOLDOWN' }]);
});

test('上游语义保留：仅请求单源时整体旁路冷却检查（:377 requested.length===1），避免全冷却死锁', async () => {
  const { impl, calls } = makeFixtureFetch({ ...allFixtures(), kw: 'fail' });
  const { searchAll } = createLxSearch({ fetchImpl: impl, now: () => 1_700_000_000_000 });
  const kwCalls = () => calls.filter((c) => c.url.includes(HOSTS.kw)).length;

  for (let i = 1; i <= 4; i++) await searchAll({ query: `旁路${i}`, sources: ['kg', 'kw'] });
  assert.equal(kwCalls(), 3, '第 4 次多源调用已被冷却拦下');
  const solo = await searchAll({ query: '旁路单源', sources: ['kw'] });
  assert.equal(kwCalls(), 4, '单源请求照上游语义照常出网');
  assert.deepStrictEqual(solo.failures, [{ source: 'kw', error: 'LX_TEST_DOWN_kw' }]);
});

test('搜索缓存：同 query 2min 内命中缓存不出网，返回同一结果对象（含逐源 failures 原样回放，上游 :375/:407）', async () => {
  let clock = 1_700_000_000_000;
  const { impl, calls } = makeFixtureFetch({ ...allFixtures(), kw: 'fail' });
  const { searchAll } = createLxSearch({ fetchImpl: impl, now: () => clock });

  const first = await searchAll({ query: '缓存查询' });
  assert.equal(calls.length, 5);
  clock += 119_999;
  const second = await searchAll({ query: '缓存查询' });
  assert.equal(calls.length, 5, 'TTL 内二次调用不得出网');
  assert.strictEqual(second, first, '缓存命中返回上游 :375 的同一 value 引用');
  assert.deepStrictEqual(second.failures, [{ source: 'kw', error: 'LX_TEST_DOWN_kw' }], 'failures 随缓存原样回放');

  clock += 2; // 累计 120001ms，超出 TTL（上游判定为 < 2min）
  await searchAll({ query: '缓存查询' });
  assert.equal(calls.length, 10, 'TTL 过期后重新出网');
});

test('仅 songs 非空才写缓存：全源失败的 searchAll 不进缓存（上游 :406 songs.length 门槛）', async () => {
  const { impl, calls } = makeFixtureFetch({ tx: 'fail', wy: 'fail', kw: 'fail', kg: 'fail', mg: 'fail' });
  const { searchAll } = createLxSearch({ fetchImpl: impl, now: () => 1_700_000_000_000 });
  await searchAll({ query: '全败查询' });
  const second = await searchAll({ query: '全败查询' });
  assert.equal(calls.length, 10, '无结果不缓存，二次调用照常出网');
  assert.equal(second.failures.length, 5);
});

test('缓存上限 80 条：第 81 条写入时逐出最旧条目（上游 :408 keys().next() FIFO）', async () => {
  const { impl, calls } = makeFixtureFetch(allFixtures());
  const { searchAll } = createLxSearch({ fetchImpl: impl, now: () => 1_700_000_000_000 });
  const kgCalls = () => calls.filter((c) => c.url.includes(HOSTS.kg)).length;

  for (let i = 1; i <= 81; i++) await searchAll({ query: `条目-${i}`, sources: ['kg'] });
  assert.equal(kgCalls(), 81);
  await searchAll({ query: '条目-81', sources: ['kg'] });
  assert.equal(kgCalls(), 81, '最新条目仍在缓存');
  await searchAll({ query: '条目-1', sources: ['kg'] });
  assert.equal(kgCalls(), 82, '最旧条目已在第 81 条写入时被逐出');
});

test('未知源：searchOne 抛 LX_SEARCH_UNKNOWN_SOURCE', async () => {
  const { impl } = makeFixtureFetch(allFixtures());
  const { searchOne } = createLxSearch({ fetchImpl: impl });
  await assert.rejects(searchOne('bogus', { query: '测试' }), /LX_SEARCH_UNKNOWN_SOURCE/);
});

test('模块级便捷导出与工厂并存（对齐上游 module.exports 习惯）', () => {
  const mod = require('../lx-search');
  assert.equal(typeof mod.createLxSearch, 'function');
  assert.equal(typeof mod.searchAll, 'function');
  assert.equal(typeof mod.searchOne, 'function');
});
