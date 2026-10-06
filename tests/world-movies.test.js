'use strict';

/**
 * 轮㉖b：世界页灯塔＝各国实时热门电影（取数源修正版，用户批准 2026-10-04「动工」）
 *   ① tmdb.popular region 透传（保留：回落链第三级仍用 region）
 *   ② world-movies 装配：主链 = tmdb.discover(with_origin_country=本国 +
 *      sort_by=popularity.desc + 近3年窗) → 无未占用结果则宽窗 discover →
 *      仍无则 popular(region)；跨国串行去重（claimed 电影 id），16 塔不同片
 *   ③ 缓存：localStorage 快照键升 world-movies-v2（旧 v1「全蜘蛛侠」快照作废）
 *   ④ world-data 基座替换：live 站顶掉十演示塔；无 live 回退 DEMO_ROOMS（铁律不删）
 *   ⑤ world-flags 扩 8 国（DE/IT/ES/KR/MX/CA/TR/NL）
 * 根因备忘：TMDB /movie/popular?region 只按"该国上映过"过滤、排序仍是全球流行度
 *   （论坛版主确认），故不能当分国榜用；分国热门必须 discover + with_origin_country。
 * 运行：node --test tests/world-movies.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function baseSandbox(extra) {
  const sandbox = Object.assign({
    console, Math, Date, Object, Array, String, Number, Boolean, JSON, Error, RegExp,
    Promise, Map, Set, isFinite, isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout, setInterval, clearInterval
  }, extra || {});
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function loadFile(sandbox, rel) {
  const p = path.join(root, rel);
  assert.ok(fs.existsSync(p), rel + ' 应存在');
  vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox);
}

// ---------------------------------------------------------------- ① tmdb region
test('tmdb.popular 第三参 region 透传到代理 URL', async () => {
  const urls = [];
  const sandbox = baseSandbox({
    localStorage: { getItem: () => 'TESTKEY', setItem: () => {} },
    fetch: (u) => {
      urls.push(String(u));
      return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ results: [] }) });
    }
  });
  loadFile(sandbox, path.join('public', 'video', 'tmdb.js'));
  const list = await sandbox.StellaflixVideo.tmdb.popular('movie', 1, { region: 'KR' });
  assert.deepEqual(list, []);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/api\/proxy\?url=/);
  assert.ok(decodeURIComponent(urls[0]).includes('region=KR'), 'region 必须覆盖默认 CN: ' + urls[0]);
  // 不传第三参保持原行为（默认 region=CN）
  await sandbox.StellaflixVideo.tmdb.popular('movie', 1);
  assert.ok(decodeURIComponent(urls[1]).includes('region=CN'));
});

// ---------------------------------------------------------------- ② world-movies 装配
function movieFixture(cc, over) {
  return Object.assign({
    // id 取双字母混合，防 IN/IT 同首字母撞 id 被跨国去重误吞
    id: 1000 + cc.charCodeAt(0) * 100 + cc.charCodeAt(1), title: '影片' + cc, posterPath: '/p' + cc + '.jpg',
    overview: '简介' + cc, popularity: 1234, adult: false
  }, over || {});
}

// opts:
//   win:  {cc: [...]}  带日期窗 discover 的返回（缺省=该国单片 fixture；[] = 无近期新片）
//   wide: {cc: [...]}  宽窗（无日期参）discover 的返回（缺省=[]）
//   pop:  {cc: [...]}  popular(region=cc) 的返回（缺省=[]）
//   failDiscover: [cc] discover 两级全挂；failPopular: [cc] popular 挂
function loadMovies(opts) {
  const o = opts || {};
  const sandbox = baseSandbox(o.sandbox);
  const discoverCalls = [];
  const popularCalls = [];
  sandbox.StellaflixVideo = sandbox.StellaflixVideo || {};
  sandbox.StellaflixVideo.tmdb = {
    discover: (params) => {
      const cc = params && params.with_origin_country;
      discoverCalls.push(params);
      if ((o.failDiscover || []).indexOf(cc) >= 0) return Promise.reject(new Error('TMDB_DOWN'));
      if (params['primary_release_date.gte'] != null) {
        return Promise.resolve(o.win && o.win[cc] !== undefined ? o.win[cc] : [movieFixture(cc)]);
      }
      return Promise.resolve(o.wide && o.wide[cc] !== undefined ? o.wide[cc] : []);
    },
    popular: (mt, page, q) => {
      const cc = q && q.region;
      popularCalls.push(cc);
      if ((o.failPopular || []).indexOf(cc) >= 0) return Promise.reject(new Error('TMDB_DOWN'));
      return Promise.resolve(o.pop && o.pop[cc] !== undefined ? o.pop[cc] : []);
    }
  };
  loadFile(sandbox, path.join('public', 'video', 'world-movies.js'));
  return { movies: sandbox.StellaflixVideo.worldMovies, discoverCalls, popularCalls, sandbox };
}

test('world-movies 国家集：16 国、码唯一、字段齐', () => {
  const { movies } = loadMovies({});
  assert.ok(movies, '应挂 SFV.worldMovies');
  const cs = movies.COUNTRIES;
  assert.equal(cs.length, 16);
  assert.equal(new Set(cs.map(c => c.cc)).size, 16);
  ['US', 'GB', 'FR', 'DE', 'IT', 'ES', 'JP', 'KR', 'IN', 'BR', 'MX', 'AU', 'CA', 'RU', 'TR', 'NL'].forEach(cc => {
    const c = cs.find(x => x.cc === cc);
    assert.ok(c, '缺国家 ' + cc);
    assert.ok(c.city && c.country && isFinite(c.lon) && isFinite(c.lat), cc + ' 城市/国名/坐标齐');
  });
});

test('refresh() 主链=discover 分国榜：16 国各一次、参数齐、映射不变', async () => {
  const { movies, discoverCalls, popularCalls } = loadMovies({});
  const changed = await movies.refresh();
  assert.equal(changed, true);
  assert.equal(discoverCalls.length, 16, '16 国各拉一次主链（默认每国首查有片，不进宽窗/popular）');
  assert.equal(popularCalls.length, 0, '主链有片时不发 popular');
  const kr = discoverCalls.find(p => p.with_origin_country === 'KR');
  assert.ok(kr, 'KR 走 discover(with_origin_country)');
  assert.equal(kr.sort_by, 'popularity.desc', '按流行度排序');
  const gte = kr['primary_release_date.gte'];
  assert.match(String(gte), /^\d{4}-\d{2}-\d{2}$/, '日期窗 YYYY-MM-DD');
  const days = (Date.now() - new Date(gte + 'T00:00:00Z').getTime()) / 864e5;
  assert.ok(days > 1090 && days < 1100, '窗约 3 年（1095 天），实际 ' + days.toFixed(0));
  const st = movies.stations();
  assert.equal(st.length, 16);
  const krSt = st.find(s => s.cc === 'KR');
  assert.equal(krSt.id, 'r-KR');
  assert.equal(krSt.roomId, 'room-kr');
  assert.equal(krSt.status, 'playing');
  assert.equal(krSt.ownerType, 'system');
  assert.equal(krSt.alwaysExpanded, true);
  assert.equal(krSt.countryCode, 'KR');
  assert.equal(krSt.title, '《影片KR》');
  assert.equal(krSt.coverUrl, 'https://image.tmdb.org/t/p/w780/pKR.jpg');
  assert.equal(krSt.descriptionZh, '简介KR');
  assert.equal(krSt.people, 3, 'popularity 1234 → log10≈3.09 → 3');
  assert.ok(isFinite(krSt.lon) && isFinite(krSt.lat));
});

test('跨国去重：撞车取该国列表下一部，16 塔不同片', async () => {
  const jia = movieFixture('GLOBAL', { id: 5001, title: '全球爆款', posterPath: '/jia.jpg', overview: 'o' });
  const { movies } = loadMovies({
    win: {
      US: [jia, movieFixture('US', { id: 5002, title: '美国本土片' })],
      GB: [jia, movieFixture('GB', { id: 5003, title: '英国本土片' })]
    }
  });
  await movies.refresh();
  const st = movies.stations();
  assert.equal(st.find(s => s.cc === 'US').title, '《全球爆款》', '美国按 COUNTRIES 序先占爆款');
  assert.equal(st.find(s => s.cc === 'GB').title, '《英国本土片》', '英国撞车后取下一部');
  const titles = st.map(s => s.title);
  assert.equal(new Set(titles).size, 16, '16 塔片名互不相同');
});

test('无近期新片 → 宽窗 discover（去日期参）重试', async () => {
  const { movies, discoverCalls, popularCalls } = loadMovies({
    win: { JP: [] },
    wide: { JP: [movieFixture('JP', { id: 6001, title: '日本老片' })] }
  });
  await movies.refresh();
  const jpCalls = discoverCalls.filter(p => p.with_origin_country === 'JP');
  assert.equal(jpCalls.length, 2, '首查空 → 宽窗二查');
  assert.ok(jpCalls[0]['primary_release_date.gte'] != null);
  assert.equal(jpCalls[1]['primary_release_date.gte'], undefined, '宽窗不带日期参');
  assert.equal(jpCalls[1].with_origin_country, 'JP');
  assert.equal(popularCalls.indexOf('JP'), -1, '宽窗有片不发 popular');
  assert.equal(movies.stations().find(s => s.cc === 'JP').title, '《日本老片》');
});

test('两级 discover 均无 → popular(region) 兜底取首个未占用片', async () => {
  const old = movieFixture('NL', { id: 7001, title: '荷兰冷门片' });
  const { movies, popularCalls } = loadMovies({
    win: { NL: [] },
    wide: { NL: [] },
    pop: { NL: [old] }
  });
  await movies.refresh();
  assert.ok(popularCalls.indexOf('NL') >= 0, 'NL 走 popular 兜底');
  assert.equal(movies.stations().find(s => s.cc === 'NL').title, '《荷兰冷门片》');
});

test('单国全链失败仅跳过该格，其余照常落位', async () => {
  const { movies } = loadMovies({ failDiscover: ['TR'], failPopular: ['TR'] });
  await movies.refresh();
  const st = movies.stations();
  assert.equal(st.length, 15);
  assert.ok(!st.find(s => s.cc === 'TR'));
});

test('全失败且无缓存 → stations() 空数组（由 world-data 回落演示基座）', async () => {
  const all = ['US', 'GB', 'FR', 'DE', 'IT', 'ES', 'JP', 'KR', 'IN', 'BR', 'MX', 'AU', 'CA', 'RU', 'TR', 'NL'];
  const { movies } = loadMovies({ failDiscover: all, failPopular: all });
  const changed = await movies.refresh();
  assert.equal(movies.stations().length, 0);
  assert.equal(changed, false);
});

// ---------------------------------------------------------------- ③ 缓存与 TTL
function makeLS(initial) {
  const m = Object.assign({}, initial || {});
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, _dump: m };
}

test('refresh 成功后写 v2 快照；新实例无网络秒 hydrate', async () => {
  const ls = makeLS();
  const a = loadMovies({ sandbox: { localStorage: ls } });
  await a.movies.refresh();
  assert.ok(ls.getItem('world-movies-v2'), '快照键 world-movies-v2 已写');
  const b = loadMovies({ sandbox: { localStorage: ls } });
  assert.equal(b.movies.stations().length, 16, '冷启动直接读到缓存');
  const before = b.discoverCalls.length;
  const changed = await b.movies.refresh();
  assert.equal(changed, false);
  assert.equal(b.discoverCalls.length, before, '6h 内不重拉');
});

test('快照超 6h → refresh 重拉并覆盖', async () => {
  const ls = makeLS();
  const a = loadMovies({ sandbox: { localStorage: ls } });
  await a.movies.refresh();
  const snap = JSON.parse(ls.getItem('world-movies-v2'));
  snap.ts = snap.ts - (6 * 3600 * 1000 + 1000);
  snap.stations[0].title = '《过期片》';
  ls.setItem('world-movies-v2', JSON.stringify(snap));
  const b = loadMovies({ sandbox: { localStorage: ls } });
  assert.equal(b.movies.stations()[b.movies.stations().findIndex(s => s.cc === snap.stations[0].cc)].title, '《过期片》', '先秒出旧快照');
  const changed = await b.movies.refresh();
  assert.equal(changed, true);
  assert.notEqual(JSON.parse(ls.getItem('world-movies-v2')).stations.find(s => s.cc === snap.stations[0].cc).title, '《过期片》', '重拉后覆盖');
});

test('旧 v1「全蜘蛛侠」快照作废：不读、不写 v1', async () => {
  const stale = JSON.stringify({ ts: Date.now(), stations: [movieFixture('US', { id: 1, title: '蜘蛛侠' })] });
  const ls = makeLS({ 'world-movies-v1': stale });
  const a = loadMovies({ sandbox: { localStorage: ls } });
  assert.equal(a.movies.stations().length, 0, 'v1 快照不再水合');
  await a.movies.refresh();
  assert.equal(ls.getItem('world-movies-v1'), stale, 'v1 键原样不动');
  assert.ok(ls.getItem('world-movies-v2'), '只写 v2');
});

// ---------------------------------------------------------------- ④ world-data 基座替换
function loadData(sandbox) {
  loadFile(sandbox, path.join('public', 'video', 'world-data.js'));
  return sandbox.StellaflixVideo.worldData;
}

test('world-data：live 站在时顶掉演示十塔（merge 基座=live），真实房间仍在前', async () => {
  const live = [
    { cc: 'KR', id: 'r-KR', roomId: 'room-kr', name: '首尔', lon: 126.98, lat: 37.57, status: 'playing', title: '《甲》', people: 3, alwaysExpanded: true, ownerType: 'system', countryCode: 'KR', city: '首尔', country: '韩国', coverUrl: 'https://image.tmdb.org/t/p/w780/a.jpg', descriptionZh: 'x' },
    { cc: 'DE', id: 'r-DE', roomId: 'room-de', name: '柏林', lon: 13.4, lat: 52.52, status: 'playing', title: '《乙》', people: 2, alwaysExpanded: true, ownerType: 'system', countryCode: 'DE', city: '柏林', country: '德国', coverUrl: 'https://image.tmdb.org/t/p/w780/b.jpg', descriptionZh: 'y' }
  ];
  const sandbox = baseSandbox({
    fetch: () => Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ ok: true, rooms: [] }) }),
    StellaflixVideo: { worldMovies: { stations: () => live.map(s => Object.assign({}, s)) } }
  });
  const wd = loadData(sandbox);
  const info = await wd.fetchRooms({});
  const ids = info.rooms.map(r => r.id);
  assert.ok(ids.indexOf('r-KR') >= 0 && ids.indexOf('r-DE') >= 0, 'live 站上球');
  assert.ok(ids.indexOf('r-sh') < 0, '演示十塔让位');
  const de = info.rooms.find(r => r.id === 'r-DE');
  assert.ok(Array.isArray(de.colorTop) && de.colorTop.length === 3, '装配期 colorsFor 上色（㉓ 教训）');
});

test('world-data：无 live（模块缺席/空）→ 回退 DEMO_ROOMS 十塔（现行为不回归）', async () => {
  const sandbox = baseSandbox({
    fetch: () => Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ ok: true, rooms: [] }) })
  });
  const wd = loadData(sandbox);
  const info = await wd.fetchRooms({});
  const ids = info.rooms.map(r => r.id);
  ['r-sh', 'r-tk', 'r-ny', 'r-ms'].forEach(id => assert.ok(ids.indexOf(id) >= 0, id + ' 回落在场'));
});

test('降级路径（api/rooms 挂）同样走 live 基座', async () => {
  const live = [{ cc: 'KR', id: 'r-KR', roomId: 'room-kr', name: '首尔', lon: 126.98, lat: 37.57, status: 'playing', title: '《甲》', people: 3, alwaysExpanded: true, ownerType: 'system', countryCode: 'KR', city: '首尔', country: '韩国' }];
  const sandbox = baseSandbox({
    fetch: () => Promise.reject(new Error('DOWN')),
    StellaflixVideo: { worldMovies: { stations: () => live.slice() } }
  });
  const wd = loadData(sandbox);
  const info = await wd.fetchRooms({});
  assert.equal(info.degraded, true);
  assert.ok(info.rooms.map(r => r.id).indexOf('r-KR') >= 0);
});

// ---------------------------------------------------------------- ⑤ flags 扩容
test('world-flags 覆盖 18 码（十旧 + DE/IT/ES/KR/MX/CA/TR/NL）', () => {
  const sandbox = baseSandbox({});
  loadFile(sandbox, path.join('public', 'video', 'world-flags.js'));
  const wf = sandbox.StellaflixVideo.worldFlags;
  ['DE', 'IT', 'ES', 'KR', 'MX', 'CA', 'TR', 'NL'].forEach(cc => {
    assert.ok(wf.flagSvgFor(cc).length > 30, cc + ' 旗面非空');
    assert.match(wf.flagFramedUrl(cc), /^data:image\/svg\+xml,/);
  });
  assert.equal(wf.flagFramedUrl('ZZ'), null, '未知码仍回落 null');
});

// ---------------------------------------------------------------- 接线源断言
test('接线：index.html manifest、page-world mount 后 refresh→tick、world-movies 装载序', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(html, /"video\/world-movies\.js",/, 'manifest 行');
  const pw = fs.readFileSync(path.join(root, 'public', 'video', 'page-world.js'), 'utf8');
  assert.match(pw, /SFV\.worldMovies\.refresh\(\)/, 'refresh 接线');
});
