# 本地化音乐资料库（歌单/专辑/艺人三轴页面）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec 实现音乐资料库前端：单全屏层三轴网格+二级详情、聚合读层、`window.stellaMlibSeam` 数据缝契约与 fake-seam 测试基建。

**Architecture:** 三个新模块进 `public/js/modules/04-shelf/`（读层纯函数 / 页面渲染 / 绑定），CSS 独立新文件；页面数据只来自 `stellaMlibRead`，读层只依赖 `window.stellaMlibSeam`（由并行会话挂载，本计划提供 fake 桩测试）。真相源=body 类。

**Tech Stack:** 原生 JS（IIFE 挂 window）、node:test + node:vm（无浏览器）、node 文本断言测 CSS、`npm run bundle`。

**Spec:** `docs/superpowers/specs/2026-10-18-local-music-library-design.md`（逐节经主人确认，像素数值与空态文案表以 spec 为准）

## Global Constraints

- 命名空间 `.stella-mlib-*`；body 类名 `mlib-active` / `mlib-axis-playlists|mlib-axis-albums|mlib-axis-artists` / `mlib-detail-open` / `mlib-leaving` / `stella-mlib-has-hover`（html 元素）。
- CSS 中 `rgba(0, 245, 212` 字面量**零出现**；辉光一律 `var(--home-accent)`（token 定义在 `public/css/index.css:317`）。
- 像素数值（照 spec §2，源=参照库 `MineRadio-Apple-Music-…-2.1.0\public\css\index.css`）：safe-top 126px / safe-bottom 150px / fade-bottom 22px / edge-feather 56px / gutter `clamp(24px,3.2vw,56px)`；网格 `repeat(var(--mlib-cols,5),minmax(0,1fr))`、container 断点 1080/860/620/380→4/3/2/1 列、艺人轴 6 列、gap `clamp(16px,1.8vw,26px) clamp(14px,1.6vw,24px)`；封面圆角 18px、底 `rgba(255,255,255,.045)`、影 `0 18px 48px rgba(0,0,0,.42)` + `inset 0 1px 0 rgba(255,255,255,.10)`、img 淡入 `.38s ease`、微光 `1.6s linear`；hover 整卡 `translateY(-4px)` `.22s cubic-bezier(.16,1,.3,1)` 不 scale；播放钮 44×44 `blur(20px) saturate(1.2)`；艺人头像 50%；空态盒 22px；返回钮 999px；进入 `translateY(22px) scale(.994) blur(10px)`→`.46s/.58s cubic-bezier(.16,1,.3,1)`，离场 `.26s`；卡标题 14px/620、副 11.5px `.60`、eyebrow 10.5px/800/.18em、页标题 `clamp(30px,3.4vw,44px)`/700。
- 数据不变量：album 按 `albumId`、artist 按稳定 `artistId` 归并，**绝不按名字字符串**；无 albumId 曲目不进专辑轴；排序归读层、页面禁止重排；DOM 属性只放 `data-mlib-id`，卡数据进 payload Map；UI 不自动重试。
- 每改动 JS 模块的任务，收尾必须：`index-loader.js` 登记路径 + `npm run bundle` 重跑通过（产物 gitignore，不入库）。
- **提交协议覆盖**：本仓规矩是只在主人明示「提交」时才 commit。执行期每个 Task 结尾**不跑 `git commit`**，改为把改动文件清单记入执行台账；计划全部完成并经主人下令后一次性分批提交。子代理 prompt 里必须写明此条。
- 并发警告：`public/index.html`、`public/css/index.css`、`server.js` 正被壁纸/LX 并行会话在途修改——本计划不碰 `index.css`（CSS 走新文件），`index.html` 只做列明的三处小改；子代理严禁 `git stash -u`、严禁重启/杀掉 :3000 桌面服务（验证一律 `PORT=3999` 同命令内起→测→杀，或纯 node 测试不启服务）。
- 中文拼音档：首字符 CJK 区间 `\u4e00-\u9fff` 检测；拼音 key 用缝侧 `sortKeyPinyin` 字段，缺失时该实体归「其他」组；不引第三方分词库。

---

### Task 1: 读层纯归一层（albumsFromTracks / artistsFromTracks / playlistsFrom + sortKey）

**Files:**
- Create: `public/js/modules/04-shelf/07-mlib-readlayer.js`
- Modify: `public/js/index-loader.js`（在 `js/modules/04-shelf/06-keyboard-camera-events.js` 之后插入一行 `'js/modules/04-shelf/07-mlib-readlayer.js',`）
- Test: `tests/mlib-readlayer-normalize.test.js`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: `window.stellaMlibRead.{albumsFromTracks, artistsFromTracks, playlistsFrom}`；卡形状 `{ id, title, sub, cover, count, sortKey, sortBucket:'latin'|'cjk'|'other', playable, meta }`；`meta` 保留 `releaseYear`（专辑）/`avatar`+`sortKeyPinyin`（艺人）/`addedAt`（歌单）。输入曲目形状 = spec §3 track：`{ id, name, artist, artistId, album, albumId, cover, duration, source, localFile, matched }`；歌单实体 = `{ id, title, cover, trackIds:[], addedAt, count? }`。

- [ ] **Step 1: 写失败测试**

```js
// tests/mlib-readlayer-normalize.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..',
  'public', 'js', 'modules', '04-shelf', '07-mlib-readlayer.js'), 'utf8');

function load() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: '07-mlib-readlayer.js' });
  return sandbox.window.stellaMlibRead;
}

const T = (o) => Object.assign({
  id: 't' + Math.random(), name: 'n', artist: 'a', artistId: 'A1',
  album: 'al', albumId: 'AL1', cover: '', duration: 200,
  source: 'local-file', localFile: 'x.mp3', matched: true,
}, o);

test('albumsFromTracks: 按 albumId 归并，无 albumId 不进轴', () => {
  const { albumsFromTracks } = load();
  const cards = albumsFromTracks([
    T({ albumId: 'AL1', album: 'X', cover: '' }),
    T({ albumId: 'AL1', album: 'X', cover: 'c1.jpg' }),
    T({ albumId: '', album: 'Y' }),
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'AL1');
  assert.equal(cards[0].count, 2);
  assert.equal(cards[0].cover, 'c1.jpg', '代表封面=任一带封面曲目');
  assert.equal(cards[0].title, 'X');
});

test('artistsFromTracks: 同 artistId 异名并一张，同名异 id 不并', () => {
  const { artistsFromTracks } = load();
  const cards = artistsFromTracks([
    T({ artistId: 'A1', artist: '张三' }),
    T({ artistId: 'A1', artist: 'Zhang San' }),
    T({ artistId: 'A2', artist: '张三' }),
  ]);
  assert.deepEqual(cards.map((c) => c.id).sort(), ['A1', 'A2']);
  assert.equal(cards.find((c) => c.id === 'A1').count, 2);
});

test('sortKey/sortBucket: 拉丁按名、CJK 判档、数字符号归 other、拼音缺失常 latin 档走 pinyin 兜底键', () => {
  const { artistsFromTracks } = load();
  const cards = artistsFromTracks([
    T({ artistId: 'L1', artist: 'Beatles' }),
    T({ artistId: 'C1', artist: '张三' }),
    T({ artistId: 'N1', artist: '100%' }),
  ]);
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.equal(byId.L1.sortBucket, 'latin');
  assert.equal(byId.C1.sortBucket, 'other', 'CJK 无 sortKeyPinyin → 其他组');
  assert.equal(byId.N1.sortBucket, 'other');
  assert.equal(byId.L1.sortKey, 'Beatles'.toLowerCase());
});

test('拼音提供时 CJK 进 cjk 档', () => {
  const { artistsFromTracks } = load();
  const cards = artistsFromTracks([T({ artistId: 'C1', artist: '张三', sortKeyPinyin: 'zhangsan' })]);
  assert.equal(cards[0].sortBucket, 'cjk');
  assert.equal(cards[0].sortKey, 'zhangsan');
});

test('playlistsFrom: 直接映射不聚合，count 缺省用 trackIds 长度', () => {
  const { playlistsFrom } = load();
  const cards = playlistsFrom([{ id: 'P1', title: '我的', cover: 'c', trackIds: ['a', 'b'], addedAt: 5 }]);
  assert.deepEqual(cards[0], {
    id: 'P1', title: '我的', sub: '', cover: 'c', count: 2,
    sortKey: 'p1', sortBucket: 'playlist', playable: true,
    meta: { addedAt: 5 },
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `node --test tests/mlib-readlayer-normalize.test.js`（Expected: 文件不存在报错）
- [ ] **Step 3: 最小实现** — 建 `07-mlib-readlayer.js`，本任务只含三个归一函数：

```js
// 本地化音乐资料库 · 聚合读层（spec: 2026-10-18-local-music-library-design.md §4）
// 纯函数层：不碰 DOM、不碰 seam（后续任务在本文件扩展）。
(function () {
  'use strict';
  var CJK = /^[\u4e00-\u9fff]/;

  function bucketOf(name, pinyin) {
    if (pinyin) return 'cjk';
    if (name && CJK.test(name)) return 'other';
    if (name && /^[a-zA-Z]/.test(name)) return 'latin';
    return 'other';
  }

  function albumsFromTracks(tracks) {
    var byId = new Map();
    (tracks || []).forEach(function (t) {
      if (!t.albumId) return; // 无 albumId 不进专辑轴（spec 铁律）
      var a = byId.get(t.albumId) || { id: t.albumId, title: t.album || t.albumId, sub: t.artist || '', cover: '', count: 0, playable: false, meta: { releaseYear: t.releaseYear || 0 } };
      a.count += 1;
      if (!a.cover && t.cover) a.cover = t.cover;
      if (t.matched) a.playable = true;
      byId.set(t.albumId, a);
    });
    var cards = Array.from(byId.values());
    cards.forEach(function (c) { c.sortKey = String(c.title).toLowerCase(); c.sortBucket = 'album'; });
    return cards;
  }

  function artistsFromTracks(tracks) {
    var byId = new Map();
    (tracks || []).forEach(function (t) {
      if (!t.artistId) return;
      var key = t.artistId;
      var a = byId.get(key) || { id: key, title: t.artist || key, sub: '', cover: '', count: 0, playable: false, meta: { avatar: '', sortKeyPinyin: t.sortKeyPinyin || '' } };
      a.count += 1;
      if (!a.meta.sortKeyPinyin && t.sortKeyPinyin) a.meta.sortKeyPinyin = t.sortKeyPinyin;
      if (t.matched) a.playable = true;
      byId.set(key, a);
    });
    var cards = Array.from(byId.values());
    cards.forEach(function (c) {
      c.sortKey = (c.meta.sortKeyPinyin || String(c.title).toLowerCase());
      c.sortBucket = bucketOf(c.title, c.meta.sortKeyPinyin);
      c.sub = c.count + ' 首';
    });
    return cards;
  }

  function playlistsFrom(playlists) {
    return (playlists || []).map(function (p) {
      var count = typeof p.count === 'number' ? p.count : ((p.trackIds || []).length);
      return { id: p.id, title: p.title, sub: count + ' 首', cover: p.cover || '', count: count,
        sortKey: String(p.id), sortBucket: 'playlist', playable: count > 0, meta: { addedAt: p.addedAt || 0 } };
    });
  }

  window.stellaMlibRead = Object.assign(window.stellaMlibRead || {}, {
    albumsFromTracks: albumsFromTracks, artistsFromTracks: artistsFromTracks, playlistsFrom: playlistsFrom,
  });
})();
```

（注：albumsFromTracks 里 `t.releaseYear` 为缝侧可选字段，spec 最小字段外新增的透传项，读不到按 0 沉底。）
- [ ] **Step 4: 跑测试确认通过** — `node --test tests/mlib-readlayer-normalize.test.js`（5/5）
- [ ] **Step 5: loader 登记 + bundle** — 改 `index-loader.js`；`npm run bundle` 通过；`node --test tests/bundle-modules.test.js` 绿
- [ ] **Step 6: 台账** — 记录文件清单，**不 commit**（见 Global Constraints）

### Task 2: 读层 seam 门面（缓存 rev / in-flight 复用 / seq 丢弃 / 三轴数据入口）

**Files:**
- Modify: `public/js/modules/04-shelf/07-mlib-readlayer.js`（文件末尾 IIFE 内追加）
- Test: `tests/mlib-readlayer-seam.test.js`

**Interfaces:**
- Consumes: Task 1 的归一函数；`window.stellaMlibSeam`（spec §3 契约：`getLibraryStats/getTracks/getPlaylists/getAlbumDetail/getArtistDetail/getPlaylistDetail/subscribe`）
- Produces: `window.stellaMlibRead.getAxisData(axis)` → `Promise<{ axis, cards, status:'ok'|'empty'|'engine-missing'|'error', error?, message? }>`（cards 已排序；'empty' 仅指引擎就绪但曲库全空）；`window.stellaMlibRead.getDetail(axis, id)` → `Promise<{ entity, tracks, status, error?, message? }>`；`window.stellaMlibRead.invalidate()`；测试钩子 `window.__stellaMlibReadResetForTests()`。

- [ ] **Step 1: 写失败测试**

```js
// tests/mlib-readlayer-seam.test.js —— 通用骨架
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '07-mlib-readlayer.js'), 'utf8');

function boot(seam) {
  const sandbox = { console, setTimeout, Promise };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'readlayer' });
  if (seam) sandbox.window.stellaMlibSeam = seam;
  sandbox.window.__stellaMlibReadResetForTests();
  return sandbox.window.stellaMlibRead;
}
const track = (o) => Object.assign({ id: 't', name: 'n', artist: 'A', artistId: 'A1', album: 'X', albumId: 'AL1', cover: '', duration: 1, source: 'local-file', localFile: 'f', matched: true }, o);

test('engine-missing：缝未挂载 → status=engine-missing 空卡，不 throw', async () => {
  const read = boot(null);
  const r = await read.getAxisData('albums');
  assert.equal(r.status, 'engine-missing');
  assert.deepEqual(r.cards, []);
});

test('ok + 排序：专辑按 releaseYear 降序、无年份沉底按标题', async () => {
  const read = boot({
    getLibraryStats: async () => ({ ready: true, rev: 1 }),
    getTracks: async () => ({ tracks: [
      track({ albumId: 'a', album: 'B', releaseYear: 2001 }),
      track({ albumId: 'b', album: 'A', releaseYear: 2020 }),
      track({ albumId: 'c', album: 'Z' }),
    ], rev: 1 }),
    subscribe: () => () => {},
  });
  const r = await read.getAxisData('albums');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.cards.map((c) => c.id), ['b', 'a', 'c']);
});

test('rev 缓存命中：seam 只被调一次；rev 变化后重取', async () => {
  let calls = 0; let rev = 1;
  const read = boot({
    getLibraryStats: async () => ({ ready: true, rev }),
    getTracks: async () => { calls += 1; return { tracks: [track({})], rev }; },
    subscribe: () => () => {},
  });
  await read.getAxisData('albums'); await read.getAxisData('albums');
  assert.equal(calls, 1, 'rev 相同命中缓存');
  rev = 2;
  await read.getAxisData('albums');
  assert.equal(calls, 2, 'rev 变化缓存作废');
});

test('并发去重：同轴 in-flight 复用同一 promise', async () => {
  let calls = 0;
  const read = boot({
    getLibraryStats: async () => ({ ready: true, rev: 1 }),
    getTracks: async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); return { tracks: [track({})], rev: 1 }; },
    subscribe: () => () => {},
  });
  const [a, b] = await Promise.all([read.getAxisData('albums'), read.getAxisData('albums')]);
  assert.equal(calls, 1); assert.equal(a.cards.length, b.cards.length);
});

test('seq 丢弃：rev 中途变化时旧响应不污染缓存', async () => {
  let rev = 1;
  const read = boot({
    getLibraryStats: async () => ({ ready: true, rev }),
    getTracks: async () => {
      const mine = rev;
      await new Promise((r) => setTimeout(r, mine === 1 ? 20 : 1));
      return { tracks: [track({ albumId: 'v' + mine })], rev: mine };
    },
    subscribe: () => () => {},
  });
  const p1 = read.getAxisData('albums');       // rev 1 慢
  await new Promise((r) => setTimeout(r, 5));
  rev = 2;
  const p2 = read.getAxisData('albums');       // rev 2 快
  await p1; const r2 = await p2;
  assert.equal(r2.cards[0].id, 'v2');
  const r3 = await read.getAxisData('albums');
  assert.equal(r3.cards[0].id, 'v2', '慢旧响应不得覆盖缓存');
});

test('error 如实上浮：缝返回 error → status=error + message 透传', async () => {
  const read = boot({
    getLibraryStats: async () => ({ ready: true, rev: 1 }),
    getTracks: async () => ({ tracks: [], error: { code: 'ENGINE_BOOT', message: '索引重建中' } }),
    subscribe: () => () => {},
  });
  const r = await read.getAxisData('albums');
  assert.equal(r.status, 'error');
  assert.equal(r.message, '索引重建中');
});
```

（`'other'` 分组排序由页面插入分界条，见 Task 5；读层只保证 `sortBucket` 标记与组内有序。）
- [ ] **Step 2: 确认失败** — `node --test tests/mlib-readlayer-seam.test.js`（getAxisData 未定义）
- [ ] **Step 3: 实现** — 在 readlayer IIFE 内追加：每轴 `cache[axis]={rev,data}`、`inflight[axis]=promise`、`seq[axis]` 计数器；`async fetchTracks()/fetchPlaylists()`（缝缺方法→engine-missing；error→status=error 且 message=error.message；tracks+playlists 全空且 ready→'empty'）；`getAxisData(axis)` 按轴选源（playlists→playlistsFrom+按 addedAt 降序；albums→albumsFromTracks+年降序标题兜底；artists→artistsFromTracks+bucket 档序 latin<cjk<other 组内 sortKey localeCompare('zh-Hans-CN') 仅用于组内一次比较，输出前预计算，热路径外）；`invalidate()` 清空三缓存；resetForTests 钩子。sortKey 比较实现细节：跨组序固定 `latin→cjk→other`（分界条插在 other 前）。
- [ ] **Step 4: 通过** — 6/6；再跑 Task 1 测试不回归
- [ ] **Step 5: `npm run bundle`** 通过
- [ ] **Step 6: 台账记录，不 commit**

### Task 3: 读层状态文案表（诚实空态，文案归读层）

**Files:**
- Modify: `public/js/modules/04-shelf/07-mlib-readlayer.js`
- Test: `tests/mlib-readlayer-copy.test.js`

**Interfaces:**
- Consumes: Task 2 的 status 体系
- Produces: `window.stellaMlibRead.getStateCopy(axis, result)` → `{ heading, hint, action }`（action: `'import'|'retry'|null`）；`getDetail` 失败分支 message 透传（已具，测试钉住）。

- [ ] **Step 1: 写失败测试**

```js
// tests/mlib-readlayer-copy.test.js（骨架同 Task 2 load() 模式）
test('文案表逐字锁定 spec §5', () => {
  const read = loadWithReadlayer();
  assert.deepEqual(read.getStateCopy('albums', { status: 'engine-missing' }), {
    heading: '曲库引擎尚未就绪', hint: '导入歌单或本地音乐后这里会自动出现', action: null });
  assert.deepEqual(read.getStateCopy('albums', { status: 'empty' }), {
    heading: '曲库还是空的', hint: '从首页「导入」卡片开始', action: 'import' });
  assert.equal(read.getStateCopy('albums', { status: 'ok', cards: [] }).heading, '这个板块还没有内容');
  assert.equal(read.getStateCopy('albums', { status: 'error', message: '索引重建中' }).heading, '索引重建中');
  assert.equal(read.getStateCopy('albums', { status: 'error', message: '索引重建中' }).action, 'retry');
});
test('不可播提示', () => {
  assert.equal(loadWithReadlayer().unplayableHint(), '未匹配到可播来源');
});
```

- [ ] **Step 2: 失败** → **Step 3: 实现**（`getStateCopy`：ok+cards 空时 hint 按轴措辞——albums「专辑按曲库里的专辑信息归组，导入匹配后自动出现」、artists「艺人按曲库里的艺人信息归组…」、playlists「导入歌单后自动出现」；error→heading 直接用缝 message 不改写；`unplayableHint()` 返回常量）→ **Step 4: 通过** → **Step 5: bundle** → **Step 6: 台账，不 commit**

### Task 4: 页面层骨架（index.html 结构 + music-library.css 像素语言 + token 契约测试）

**Files:**
- Modify: `public/index.html`（三处：`<head>` 在 `wallpaper-engine.css` link 之后加一行；`#empty-home` 闭合之后加 `#music-library` section；三张新卡加 `data-mlib-axis` 属性——现有 PLAYLISTS/ALBUMS/ARTISTS 三卡，值分别 `playlists/albums/artists`）
- Create: `public/css/music-library.css`
- Test: `tests/mlib-page-contract.test.js`（CSS token 断言 + index.html 结构断言）

**Interfaces:**
- Produces: DOM id 约定 `music-library` / `music-library-scroll` / `mlib-view-grid` / `mlib-view-detail` / `mlib-grid-wrap`（container 上下文挂在包裹层，不挂滚动容器——滚动容器上 container-type 会失效）/ `mlib-grid` / `mlib-state-box` / `mlib-detail-back` / `mlib-detail-head` / `mlib-detail-tracks`；html 类 `stella-mlib-has-hover`。

- [ ] **Step 1: 写失败测试**（要点，全部 fs 文本断言）

```js
const css = fs.readFileSync('public/css/music-library.css', 'utf8');
test('像素 token 契约', () => {
  for (const tok of ['126px', '150px', '22px', '56px', 'clamp(24px,3.2vw,56px)',
    'border-radius: 18px', 'border-radius: 50%', 'border-radius: 999px',
    'translateY(-4px)', 'translateY(22px) scale(.994)', 'blur(10px)', '.26s',
    'max-width: 1080px', 'max-width: 860px', 'max-width: 620px', 'max-width: 380px',
    'aspect-ratio: 1 / 1', 'rgba(255, 255, 255, .045)', '0 18px 48px rgba(0, 0, 0, .42)'])
    assert.ok(css.includes(tok), '缺 token: ' + tok);
  assert.ok(!css.includes('rgba(0, 245, 212'), '青色字面量违禁');
  assert.match(css, /var\(--home-accent\)/);
  assert.ok(/\.stella-mlib-/.test(css));
});
test('index.html 骨架', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.ok(html.includes('href="css/music-library.css"'));
  assert.ok(html.includes('id="music-library"'));
  for (const a of ['playlists', 'albums', 'artists']) assert.ok(html.includes('data-mlib-axis="' + a + '"'));
});
```

- [ ] **Step 2: 失败**（CSS 文件不存在）
- [ ] **Step 3: 实现** — `music-library.css` 按 Global Constraints 数值逐条落地（结构参照 `MineRadio-Apple-Music-…-2.1.0\public\css\index.css:1693-3157` 的 `.mlib-*` 规则**反向改名移植**：只取页面壳/网格/卡片/详情/状态盒/返回钮，删除 `#mlib-nav`、`.mlib-source-dot`；`#music-library` 选择器名保留不变因其为 Stellaflix 自有根层；body 类用本计划名称；`#empty-home` 让位规则 `body.mlib-active #empty-home{opacity:0!important;pointer-events:none!important}`）。`index.html` 新增：

```html
<section id="music-library" aria-hidden="true">
  <div id="music-library-scroll">
    <div id="mlib-view-grid">
      <div id="mlib-grid-wrap"><div id="mlib-grid"></div><div id="mlib-state-box"></div></div>
    </div>
    <div id="mlib-view-detail">
      <button id="mlib-detail-back" type="button">返回</button>
      <div id="mlib-detail-head"></div>
      <div id="mlib-detail-tracks"></div>
    </div>
  </div>
</section>
```

- [ ] **Step 4: 通过** → **Step 5: 台账，不 commit**（Task 4 无 JS 模块改动则免 bundle；index.html 改动与 loader 无关）

### Task 5: 页面三轴网格渲染（渲染器 + payload Map + 封面/头像三级兜底 + 分界条 + 状态盒）

**Files:**
- Modify: `public/index.html`（head 或 body 尾加 `<script src="js/modules/04-shelf/08-mlib-page.js"></script>` 兜底段——与既有逐文件加载方式一致；同时 loader 登记供 bundle 路径）
- Create: `public/js/modules/04-shelf/08-mlib-page.js`
- Modify: `public/js/index-loader.js`
- Test: `tests/mlib-page-grid.test.js`（vm + fakeDom；fakeDom 工具放 `tests/helpers/mlib-fake-dom.js` 供 Task 6/7/8 复用）

**Interfaces:**
- Consumes: `stellaMlibRead.getAxisData/getStateCopy/unplayableHint`（Task 2/3）
- Produces: `window.stellaMlibPage.openAxis(axis)`（写 body 类+渲染）、`window.stellaMlibPage.close()`、`window.__mlibGridPayloadForTests`（Map）、fakeDom 约定（Task 6-8 引用）。

- [ ] **Step 1: 写 fakeDom + 失败测试**

```js
// tests/mlib-page-grid.test.js 关键断言
test('卡渲染：payload 进 Map 不进 DOM 属性', async () => {
  const { win } = bootPageWithFakeDom({ axisData: { axis: 'albums', status: 'ok', cards: [
    { id: 'AL1', title: 'X', sub: 'A', cover: 'c.jpg', count: 2, playable: true, sortBucket: 'album' },
  ] } });
  await win.stellaMlibPage.openAxis('albums');
  const card = doc.querySelector('[data-mlib-id="AL1"]');   // DOM 只有 id
  assert.ok(card);
  assert.ok(!card.getAttribute('data-title'), '标题不得进属性');
  assert.equal(win.__mlibGridPayloadForTests.get(card).title, 'X');
});
test('esc 文本注入防御', () => { /* 卡 title='<img src=x>' → 渲染产物转义，querySelector 查不到 img */ });
test('无封面卡：stella-mlib-art 无 has-cover 类，用底色占位（不生成蓝盘 SVG）', () => {});
test('艺人头像兜底：avatar 图→首字母 span（class 含 stella-mlib-artist-art）', () => {});
test('other 组前插分界条跨整行（class stella-mlib-artist-divider）', () => {});
test('status=empty → state-box 显示 getStateCopy 文案且带去导入钮', () => {});
```

（实现者注意：fakeDom 只需实现页面模块用到的 API 面——getElementById/querySelector(All) 按 id/class/data 属性匹配、createElement、classList、textContent、setAttribute、innerHTML setter（记录字符串即可）、appendChild、dataset。**页面模块本身应只用这套子集写代码。**）
- [ ] **Step 2: 失败** → **Step 3: 实现 `08-mlib-page.js`**：网格渲染器（三轴共用，卡 HTML 由 esc 文本拼接，同 `homeDashboardCardHtml` 仓内既有模式）；`html.classList` hover 探测（`matchMedia('(hover:hover)')` 有则置类）；状态盒分支；`openAxis` 先清 grid（骨架清空）再 async 填充；`seq` 丢弃在 UI 侧同样比对 `getAxisData` 完成时的 `requestedSeq`。
- [ ] **Step 4: 通过**（含 Task 5 全部；`node --test tests/mlib-page-grid.test.js`）
- [ ] **Step 5: loader 登记 `08-mlib-page.js` + `npm run bundle` + `node --test tests/bundle-modules.test.js`**
- [ ] **Step 6: 台账，不 commit**

### Task 6: 二级详情视图（详情渲染 + 进入/返回滚动记录恢复 + ESC 第一级）

**Files:**
- Modify: `public/js/modules/04-shelf/08-mlib-page.js`
- Modify: `public/index.html`（`mlib-detail-back` 已是 svg+文本占位则不动）
- Test: `tests/mlib-page-detail.test.js`（复用 Task 5 fakeDom helper）

**Interfaces:**
- Consumes: `stellaMlibRead.getDetail(axis,id)`
- Produces: `window.stellaMlibPage.openDetail(axis, id)`、`closeDetail()`；body 类 `mlib-detail-open`。

- [ ] **Step 1: 失败测试**：断言 ①openDetail 后 body 类含 `mlib-detail-open`、网格视图 `aria-hidden`、详情头部 eyebrow/title/head-meta 与曲目行渲染（行只带 `data-mlib-track-id`，行数据进 `__mlibDetailPayloadForTests`）②进入前 scroll 值被记录、closeDetail 后恢复且移除 `mlib-detail-open` ③详情 status=error 时头部照常+列表区状态盒（缝 message 透传）④matched:false 行播放钮带 `disabled` 且 title=unplayableHint()。
- [ ] **Step 2: 失败** → **Step 3: 实现**（`scrollEl.scrollTop` 记录/恢复；曲目行 = 序号+封面小图(可空)+曲名+艺人次级+时长）→ **Step 4: 通过** → **Step 5: bundle** → **Step 6: 台账，不 commit**

### Task 7: 绑定与 shell 行为（三卡委托点击 / body 类真相源 / ESC 两级 / 让位复位）

**Files:**
- Create: `public/js/modules/04-shelf/09-mlib-bindings.js`
- Modify: `public/js/index-loader.js`
- Modify: `tests/home-quick-cards-library-entries.test.js`（夹具卡定义补 `data-mlib-axis`，断言静态三卡属性存在）
- Test: `tests/mlib-bindings-contract.test.js`

**Interfaces:**
- Consumes: `stellaMlibPage.openAxis/close/openDetail/closeDetail`（fake 可桩）
- Produces: 全局函数 `window.mlibOpenAxis(axis)` / `window.mlibClose()`（vm 直调面）。

- [ ] **Step 1: 失败测试**

```js
test('委托点击：三卡 → 对应轴；data-mlib-axis 是唯一映射源', () => {});
test('影视态不响应：body 含 video-home-collapsed 时点击不开资料库', () => {});
test('ESC 两级：详情→网格→关闭；资料库未开时不拦截', () => {});
test('mlib-active 期间重复点同一卡幂等（不重放入场动画）', () => {});
test('关闭走 mlib-leaving：先置 leaving 类，420ms 后摘 active/leaving（timer 可注入假 clock）', () => {});
```

- [ ] **Step 2: 失败** → **Step 3: 实现 `09-mlib-bindings.js`**：document click 委托找 `closest('[data-mlib-axis]')`；`mlibOpenAxis` = 摘 leaving/其余轴类→置 `mlib-active mlib-axis-<x>`；`mlibClose` = 置 `mlib-leaving`，`setTimeout(...,420)` 后摘 `mlib-active mlib-leaving mlib-detail-open`（timer 经 `window.__mlibTimer || setTimeout` 取，测试可注入）；ESC capture 监听按上序分级处理。
- [ ] **Step 4: 通过** → **Step 5: loader+bundle+`node --test tests/home-quick-cards-library-entries.test.js`（批A 契约同步后仍绿）** → **Step 6: 台账，不 commit**

### Task 8: 播放接线（整张播放 / 单曲入队 / 去导入按钮）

**Files:**
- Modify: `public/js/modules/04-shelf/08-mlib-page.js`
- Test: `tests/mlib-page-playback.test.js`（复用 fakeDom）

**Interfaces:**
- Consumes: `queueSong(song, opts)` / `queueSongNext(song)`（`05-playback/10-queue-actions.js:1/30` 全局函数，测试桩注入；「立即播放某曲」走既有换源链，实施首步先 grep `playSearchResult` 与 `setCurrentSong` 类现成入口核对，不新造播放路径）；`window.openPlatformPlaylistImport()`（`platform-playlist-import.js:341`，导入弹窗入口，桩注入）；缝可选 `playableFromTrack(track)`。
- Produces: 卡播放钮点击→`stellaMlibRead.getDetail` 取曲目→`matched` 曲目转 song 对象依序 `queueSong`（本地优先由既有队列链处理，页面不判 localFile）；单曲行点击→`queueSong(song)`；「去导入」→`openPlatformPlaylistImport()`；`matched:false` 曲目在整张播放中被过滤。

- [ ] **Step 1: 失败测试**：①整张播放只入 matched 曲目（3 首含 1 unmatched → queueSong 调 2 次）②track→song 映射字段 `{ name, ARTIST, COVER, duration, source:'mlib', localFile, mlibTrackId }`（键名对齐仓内 song 对象惯例：实现者先 grep `homeDiscoverState.songs` 生成处核对字段大小写再定，测试按核对结果写死）③unmatched 单曲钮点击不产生调用 ④「去导入」桩被调。
- [ ] **Step 2-6: 失败→实现→通过→bundle→台账（不 commit）**

### Task 9: 全量回归 + 桌面真机冒烟清单交付

- [ ] **Step 1:** `npm test` 全绿（基线 205/205 + 本计划新增 ≥5 个测试文件；若 proxy-image-disk-cache 偶发红，单跑复核 `node --test tests/proxy-image-disk-cache.test.js`）
- [ ] **Step 2:** `npm run bundle` 新鲜度：manifest 含 07/08/09 三新模块
- [ ] **Step 3:** 输出主人冒烟清单（spec §7 七项 + 「缝未挂载时三页空态可见」一项，共 8 项）——不启 :3000、不杀任何进程
- [ ] **Step 4:** 台账汇总全部文件清单；**等主人「提交」指令**，届时只 stage 本计划文件（`index.html` 只加本计划三处 hunk——壁纸会话同文件在途，stage 前 `git diff` 逐 hunk 核对）

---

## Self-Review 结论（已执行）

1. Spec 覆盖：§1→T1-3/T4-7；§2→T4；§3→T2 契约面+T8；§4→T1-3；§5→T3/T5/T6；§6→各 T 测试步+T9；§8 越界=计划无对应任务，一致。
2. 占位符：Task 8 song 字段大小写以「先 grep 核对再写死」的显式动作替代 TBD，合规。
3. 类型一致：卡形状七字段 T1 定义、T5 消费同名；`getStateCopy` 返回三元组 T3 定义 T5/T6 消费；`getAxisData/getDetail` T2 定义 T5/T6/T8 消费——名称签名已互查一致。
