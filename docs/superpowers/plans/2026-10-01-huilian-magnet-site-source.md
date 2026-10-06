# 汇联 磁力站点源提取与播放 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让汇联页与详情页都能从「磁力站点」搜索作品、就地展开版本、选版本入队并走既有 mpv 播链路；站点规则只经远端一键导入或手动粘贴，仓库与安装包内零内置规则。

**Architecture:** 五个新增渲染层模块（`huilian-magnet-enrich` 纯函数增强 / `huilian-magnet-rules` 规则 schema+存储+导入 / `huilian-magnet-source` 抓取解析+限流缓存 / `huilian-site-search` 汇联页搜索区组件 / `huilian-magnet-rules-ui` 规则面板），复用 Kazumi 的 `KazumiHttpClient` 与 `KazumiXPathEngine`（`kazumi/` 目录零改动）。入队仍走**唯一**既有通道 `huilian-page.js` 的 `submitParams → download.addTorrent`；认领键由「整串相等」扩为「整串相等 → btih 归一」两路。desktop 层零改动。

**Tech Stack:** 原生 JS IIFE 挂 `window.StellaflixVideo`（无构建步骤）、`node:vm` + 假 DOM（`tests/helpers/huilian-harness.js`）、jsdom ^24（真 XPath / `document.evaluate`）、`node --test`、qBittorrent Web API v2（经既有 desktop 桥）、mpv overlay（既有）。

**Spec:** `docs/superpowers/specs/2026-10-01-huilian-magnet-site-source-design.md`（304 行 / 12 节）。本计划逐条对着它写；冲突以 spec 为准，spec 自身不可实施处见文末「spec 修订」。

## Global Constraints

- **零内置规则（合规红线，spec §9.1）**：仓库与安装包内不得出现任何磁力站点规则、真实 `origin`、XPath 清单或 tracker 清单；一律远端导入或手动粘贴。测试用假规则的 host 必须是 `example.test` / `fixture.invalid` 这类不可解析地址。
- **`public/video/kazumi/` 目录内部禁改**（`kazumi-bridge.js:1-23` 明令，spec D1）：只用其导出面（`KazumiHttpClient`、`KazumiXPathEngine`）。
- **desktop 层零改动**（spec §0）：本计划不碰 `desktop/**`。唯一「认领」改动落在渲染层 `public/video/huilian-queue.js`。
- **qbt 随机口令不进日志 / 错误信息 / UI 文案**（spec §9.2）：不得新增任何打印点。
- **入队参数最小化**（spec §9.3）：入队只提交磁力 URL 本身（`makeAddParams` 的 `{url}` 通道），不转发站点 Cookie / 会话头 / 任何请求头；tracker 只从规则清单拼进 URL。
- **抓取 origin 白名单**（spec §9.6）：只允许规则声明的 `origin`；`/api/proxy?url=` 参数一律 `encodeURIComponent`。
- **XPath 是外部输入**（spec §9.7）：导入必须整条校验（必填齐、长度上限、`searchURL` host 等于 `origin` host、tracker 条数上限）；**不通过则整条不落盘**，不允许部分写入。
- **fixture 脱敏**（spec §9.4）：入库的抓取件不得含可直接下载的真实 btih；哈希一律替换为明显伪造的 40 位十六进制占位串。
- **渲染红线**（spec §8）：DOM 只由 `el()` / `createElement` 构造，**禁止用 `innerHTML` 拼外部文本**（站点发布名是外部输入）；所有 IPC / 网络 reject 必须经 `fail()` 或 `toast` 上浮，不许静默。
- **生命周期红线**（spec §6.4）：异步回调落地前先过 `isStale(gen)` 门禁；`unmount` 必须清空展开态与请求缓存。
- **测试基线**：`npm test`（= `node tests/run-all.js`，自动发现 `tests/*.test.js`，每文件 90s 超时）。当前基线 **148/149**，唯一失败是既有 watch-history D1 存量问题，与本计划无关；除它之外必须全绿。**不得用管道吞退出码**。
- **提交纪律**：本计划各任务末尾的 commit 步骤，仅在本计划被用户明确批准以 subagent-driven / executing-plans 模式执行时生效；用户只要求「写计划」或单独要求改某个文件时，未听到「提交」指令不得 commit，且只 stage 该任务的文件。
- **不新增 npm 依赖**；不改 `package.json` 的 `build.files`（已含 `public/**/*`，且**不含** `tests/**`，故测试与脱敏 fixture 不进包）。
- **`npm run bundle` 与本计划无关**：bundle 读的是 `public/js/index-loader.js` 的 `modulePaths`（`js/modules/**` 音乐侧），视频模块清单是 `public/index.html:2021` 的 `SFV_SCRIPTS`，两者不同源。仅当同时改了 `modulePaths` 才需跑 `npm run bundle`。

---

## 文件结构（先定边界，再拆任务）

| 文件 | 新建/修改 | 单一职责 | 不应出现在这里的 |
|---|---|---|---|
| `public/video/huilian-queue.js` | 修改 | 磁力识别（`MAGNET_RE` + 新 `extractBtih`）、add 参数、认领、可播阈值、任务视图 | 任何站点/徽章/体积逻辑 |
| `public/video/huilian-magnet-enrich.js` | 新建 | 纯函数：tracker 注入、`dn=` 补写、体积解析、徽章族解析、恒定值归约、btih 去重、筛选与排序 | DOM、网络、localStorage |
| `public/video/huilian-magnet-rules.js` | 新建 | 磁力规则 schema / 校验 / localStorage 读写 / 远端导入 / 时效判定 | 抓取、渲染 |
| `public/video/huilian-magnet-source.js` | 新建 | 抓取 + XPath 解析 + 会话缓存 + 并发上限 2 + 错误文案映射 | localStorage、DOM 渲染 |
| `public/video/huilian-site-search.js` | 新建 | 汇联页搜索区组件：搜索行 / 筛选条 / 作品横卡 / 就地展开 / 入队按钮 / 代次门禁 | 直接调 IPC |
| `public/video/huilian-magnet-rules-ui.js` | 新建 | 规则面板：列表 / 从 URL 导入 / 粘贴 JSON / 停用 / 删除 / 时效提示 | 抓取 |
| `public/video/huilian-page.js` | 修改 | 唯一入队口 `SFV.huilianEnqueue`、站点搜索区挂载/销毁、重复入队高亮定位 | 渲染站点结果（归 site-search） |
| `public/video/detail-source.js` | 修改 | 源单元枚举加 magnet 单元、magnet 候选归一、magnet 分发分支（版本弹窗→入队→跳页） | 直接读 localStorage（走 rules 模块） |
| `public/video/source-picker.js` | 修改 | 导出 `openModal`；magnet 行的图标/徽章/分组名 | 磁力业务逻辑 |
| `public/index.html` | 修改 | `SFV_SCRIPTS` 注册 5 个新文件（全部在 `"video/huilian-page.js"` 之前） | — |
| `public/video/player.css` | 修改 | 新增 `huilian-site-*` / `huilian-work-*` / `huilian-version-*` / `huilian-badge*` / `huilian-rule*` 样式带 | — |
| `public/video/hall.css` | 修改 | `.sfv-picker-badge-magnet`（picker 徽章样式带在此文件 `:444-446`） | — |
| `tests/fixtures/make-pomo-fixtures.js` | 新建 | 脱敏 fixture 生成器（可复算：哈希/名称/结构全合成） | 真实 btih / 真实选择器 / 真实域名 |
| `tests/fixtures/pomo-search-pjax.html` | 新建 | 脱敏作品卡结构 | 真实 btih / 真实站点规则 |
| `tests/fixtures/pomo-detail-sanitized.html` | 新建 | 脱敏 42 条磁力锚点 + 14 条发布名 | 真实 btih |

单文件行数约定（自觉约束，仓库无测试把守）：新文件 ≤ 250 行；`huilian-page.js` 现 348 行 → 本计划后 ≤ 430 行（唯一入队口必须留在页面内，因为它拥有 `submitParams`/`pending`/任务快照；**站点结果的渲染一律在 site-search**）。

---

### Task 1: `extractBtih` + `matchHash` btih 归一第二路

**Files:**
- Modify: `public/video/huilian-queue.js`（`MAGNET_RE:12` 附近加正则；重写 `matchHash:52-64`；导出面 `:100-105` 加 `extractBtih`）
- Test: `tests/huilian-queue.test.js`（既有 46 行，末尾扩写）

**Interfaces:**
- Consumes: 无（本任务是链底）。
- Produces: `SFV.huilianQueue.extractBtih(magnet: string|null) -> string|null`（40 位十六进制 → 小写；32 位 `[0-9a-z]` → 大写；缺 `xt=urn:btih:` / 其他长度 → `null`）。`matchHash(torrents, magnetUrl)` 契约不变（返回 `hash|string|null`），但**第一路仍是整串相等**，第二路按归一 btih。Task 2 的 `dedupeByBtih`、Task 7 的重复入队判定都调它（全仓唯一 btih 实现，spec §9.5）。

- [ ] **Step 1: 写失败测试**（追加到 `tests/huilian-queue.test.js` 末尾）

```js
const HEX40_A = '0123456789abcdef0123456789abcdef0000ab12'; // 40 位，勿改短：38 位会被判非法 → 断言假绿/假红难分
const HEX40_B = 'aabbccddeeff00112233445566778899aabbccdd';

test('extractBtih: 40 位十六进制归一为小写', () => {
  const q = load();
  assert.strictEqual(q.extractBtih('magnet:?xt=urn:btih:' + HEX40_A.toUpperCase()), HEX40_A);
});
test('extractBtih: 32 位归一为大写（base32 与十六进制截断写法都接受）', () => {
  const q = load();
  assert.strictEqual(q.extractBtih('magnet:?xt=urn:btih:abcdefghijklmnopqrstuvwxyz234567'),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
});
test('extractBtih: 缺 xt=urn:btih: / 长度非法 / 非字符串 → null', () => {
  const q = load();
  assert.strictEqual(q.extractBtih('magnet:?xt=urn:btih:abc123'), null);   // 6 位
  assert.strictEqual(q.extractBtih('magnet:?xt=urn:sha1:' + HEX40_A), null);
  assert.strictEqual(q.extractBtih(''), null);
  assert.strictEqual(q.extractBtih(null), null);
  assert.strictEqual(q.extractBtih(undefined), null);
});
test('extractBtih: 多 btih 只取首个', () => {
  const q = load();
  assert.strictEqual(q.extractBtih('magnet:?xt=urn:btih:' + HEX40_A + '&x=1&xt=urn:btih:' + HEX40_B), HEX40_A);
});
test('matchHash: 入队串带 3 个 &tr=、qbt 回吐只带 1 个且顺序不同 → 仍按 btih 认领', () => {
  const q = load();
  const mine = 'magnet:?xt=urn:btih:' + HEX40_B
    + '&tr=' + encodeURIComponent('udp://t1.example:1337/announce')
    + '&tr=' + encodeURIComponent('https://t2.example:443/announce')
    + '&tr=' + encodeURIComponent('udp://t3.example:6969/announce');
  const fromQbt = 'magnet:?xt=urn:btih:' + HEX40_B.toUpperCase()
    + '&tr=' + encodeURIComponent('udp://t3.example:6969/announce');
  assert.strictEqual(q.matchHash([{ hash: 'H2', url: 'magnet:?xt=urn:btih:' + HEX40_A },
    { hash: 'H9', magnet_uri: fromQbt }], mine), 'H9');
});
test('matchHash: 整串相等仍是第一路；两侧 btih 均非法时不得误命中', () => {
  const q = load();
  assert.strictEqual(q.matchHash([{ url: 'magnet:?xt=urn:btih:abc123' }], 'magnet:?xt=urn:btih:abc123'), null);
  assert.strictEqual(q.matchHash([{ hash: 'X', url: 'magnet:?xt=urn:btih:zzz' }], 'magnet:?xt=urn:btih:yyy'), null);
  assert.strictEqual(q.matchHash([{ hash: 'X' }], 'magnet:?xt=urn:btih:' + HEX40_A), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/huilian-queue.test.js`
Expected: FAIL — `q.extractBtih is not a function`；tracker 用例报 `null !== 'H9'`。

- [ ] **Step 3: 写最小实现**（`public/video/huilian-queue.js`）

在 `var MAGNET_RE = /^magnet:\?/i;`（现 12 行）之后插入：

```js
  // btih 提取面：只认参数分隔（? 或 &）后的 xt=urn:btih:，避免把路径片段当哈希
  var BTIH_TOKEN_RE = /[?&]xt=urn:btih:([0-9a-z]+)/i;
  var BTIH_HEX40_RE = /^[0-9a-f]{40}$/i;
  var BTIH_LEN32_RE = /^[0-9a-z]{32}$/i;
```

在 `makeAddParams` 之后（现 49 行之后）插入：

```js
  /*
   * 磁力串 → 归一 btih（全仓唯一实现，spec §9.5）。
   * 40 位十六进制 → 小写（完整 SHA1）；32 位 [0-9a-z] → 大写（base32 写法；
   * 十六进制截断的 32 位也按大写归一）。长度或字符集不符 → null。
   * 已知代价：40 位与其 32 位截断写法归一后是两个不同的键，不互相去重——
   * 站点给的永远是 40 位（spec §2 实测 42 条 data-url），故不影响本仓库链路。
   */
  function extractBtih(magnet) {
    if (typeof magnet !== 'string') return null;
    var m = BTIH_TOKEN_RE.exec(magnet);
    if (!m) return null;
    var v = m[1];
    if (BTIH_HEX40_RE.test(v)) return v.toLowerCase();
    if (BTIH_LEN32_RE.test(v)) return v.toUpperCase();
    return null;
  }
```

用下面这段整体替换现有 `matchHash`（现 51-64 行）：

```js
  /*
   * 在 torrent 列表中认领哈希。
   * 第一路：整串相等（现有直链粘贴流程依赖，tests/huilian-queue.test.js:30-34）。
   * 第二路：btih 归一。必须存在——`/api/v2/torrents/add` 无 trackers 字段
   *   （desktop/download-manager.js:192-202），tracker 只能拼进 URL，而 qbt 回吐的
   *   magnet_uri 是它自己按内部顺序重建的，与我们拼出的串很可能不同序（spec §5.6）。
   */
  function matchHash(torrents, magnetUrl) {
    // magnetUrl 为空时直接判空：否则条目同时缺 url/magnet_uri 时会 undefined===undefined 误命中
    if (!magnetUrl) return null;
    var list = Array.isArray(torrents) ? torrents : [];
    var i, t;
    for (i = 0; i < list.length; i++) {
      t = list[i];
      if (t && (t.url === magnetUrl || t.magnet_uri === magnetUrl)) return t.hash || null;
    }
    var key = extractBtih(magnetUrl);
    if (!key) return null; // 入队串 btih 非法 → 不做第二路，绝不让 null===null 误认领
    for (i = 0; i < list.length; i++) {
      t = list[i];
      if (!t) continue;
      if (extractBtih(t.url) === key || extractBtih(t.magnet_uri) === key) return t.hash || null;
    }
    return null;
  }
```

导出面（现 `SFV.huilianQueue = {`）在 `makeAddParams` 之后加一行 `extractBtih: extractBtih,`。

- [ ] **Step 4: 跑测试确认全绿**

Run: `node --test tests/huilian-queue.test.js`
Expected: PASS，12 tests（原 6 + 新 6），0 fail。原 `matchHash: 按 magnet url 认领` 用例必须仍然通过。

- [ ] **Step 5: 提交**

```bash
git add public/video/huilian-queue.js tests/huilian-queue.test.js
git commit -m "feat: 汇联 磁力源 Task1 — extractBtih 归一 + matchHash btih 第二路认领"
```

---

### Task 2: `huilian-magnet-enrich.js` — 发布名解析与入队串加工（纯函数）

**Files:**
- Create: `public/video/huilian-magnet-enrich.js`
- Test: `tests/huilian-magnet-enrich.test.js`

**Interfaces:**
- Consumes: `SFV.huilianQueue.extractBtih(magnet)`（Task 1 产出；全仓唯一 btih 解析，spec §9.5）。**注册顺序必须在 `huilian-queue.js` 之后**（Task 5 落 `index.html`）。
- Produces: `SFV.huilianMagnetEnrich`，键名固定为
  `cleanText, existingTrackers, injectTrackers, withDisplayName, parseSize, formatSize, sizeRangeText, maxBytes, parseBadges, splitConstantBadges, constantHeaderText, dedupeByBtih, matchesSizeBand, filterVersions, applyFilter, sortWorks, sortVersions, uniq`。
  版本对象形状（Task 4 产出、Task 8 消费）：`{ magnet, name, size: {text, bytes}|null, allBadges: [{family,label,cls}] }`；`allBadges` 是**原始**徽章（筛选判定一律走它，裁决⑥），显示用的行内徽章由 `splitConstantBadges` 现算，不落字段。

- [ ] **Step 1: 写失败测试**

创建 `tests/huilian-magnet-enrich.test.js`：

```js
'use strict';
/** 运行：node --test tests/huilian-magnet-enrich.test.js */
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');

function load() {
  const sandbox = { window: {}, URL: require('url').URL };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  // enrich 依赖 queue 的 extractBtih；加载顺序同 index.html 的 SFV_SCRIPTS
  vm.runInContext(fs.readFileSync('public/video/huilian-queue.js', 'utf8'), sandbox, { filename: 'huilian-queue.js' });
  vm.runInContext(fs.readFileSync('public/video/huilian-magnet-enrich.js', 'utf8'), sandbox, { filename: 'huilian-magnet-enrich.js' });
  return sandbox.window.StellaflixVideo.huilianMagnetEnrich;
}

// vm 沙箱里的数组/对象原型与宿主 realm 不同，deepStrictEqual 会因原型失败 → 统一投影成字符串比较
const labels = (bs) => (bs || []).map((b) => b.label).join(',');
const H = (i) => 'magnet:?xt=urn:btih:' + String(i).padStart(40, '0'); // 合成占位哈希，非真实指纹
const mkVers = (e, names) => names.map((n) => ({ name: n, allBadges: e.parseBadges(n) }));

const N1 = '给阿嬷的情书.2160p.WEB-DL.DV.60帧率版本.HQ.2Audio.AAC2.0.中字国配.x265-QuickIO';

test('dedupeByBtih：42 条同名多 tracker 变体 → 14 条唯一 btih，保留首次出现', () => {
  const e = load();
  const inList = [];
  for (let i = 0; i < 14; i++) for (let k = 0; k < 3; k++) inList.push({ name: 'v' + i + '-' + k, magnet: H(i) + '&tr=a&idx=' + k });
  assert.strictEqual(inList.length, 42);
  const out = e.dedupeByBtih(inList);
  assert.strictEqual(out.length, 14);
  assert.strictEqual(out.map((v) => v.name).join(','), Array.from({ length: 14 }, (_, i) => 'v' + i + '-0').join(','));
  // §9.5：取不到 btih 的条目既认领不了也入不了队 → 不给入队入口
  assert.strictEqual(e.dedupeByBtih([{ name: 'x', magnet: 'http://not-a-magnet' }]).length, 0);
  assert.strictEqual(e.dedupeByBtih(null).length, 0);
});

test('injectTrackers：已有 tr= 时一条不追加、一条不覆盖', () => {
  const e = load();
  const m = H(1) + '&tr=' + encodeURIComponent('http://have.test/announce');
  assert.strictEqual(e.injectTrackers(m, ['http://a.test/announce', 'http://b.test/announce']), m);
});

test('injectTrackers：缺 tr= 才注入，条数与编码照规则；无规则原样返回', () => {
  const e = load();
  const out = e.injectTrackers(H(1), ['http://a.test/announce?q=1', 'udp://b.test:2710']);
  assert.strictEqual(out.split('&tr=').length - 1, 2);
  assert.ok(out.indexOf('&tr=http%3A%2F%2Fa.test%2Fannounce%3Fq%3D1') > 0, 'tracker 必须 encodeURIComponent：' + out);
  assert.strictEqual(e.existingTrackers(out).join('|'), 'http://a.test/announce?q=1|udp://b.test:2710', '沙箱数组原型不同，用投影比较');
  assert.strictEqual(e.injectTrackers(H(1), []), H(1));
  assert.strictEqual(e.injectTrackers(H(1), null), H(1));
});

test('withDisplayName：已有 dn= 不覆盖，缺时才追加且清洗', () => {
  const e = load();
  assert.strictEqual(e.withDisplayName(H(1) + '&dn=keep', '新名'), H(1) + '&dn=keep');
  const out = e.withDisplayName(H(1), '片名\r\n带"引号"   与换行');
  // CR/LF 与引号一律换成空格，再折叠连续空格 → '片名 带 引号 与换行'（不是删字符，防相邻词粘连）
  assert.strictEqual(out, H(1) + '&dn=' + encodeURIComponent('片名 带 引号 与换行'));
  assert.strictEqual(e.withDisplayName(H(1), '   '), H(1), '空名不追加 dn=');
});

test('parseSize / formatSize / sizeRangeText：剥括号、可排序数值、十进制单位', () => {
  const e = load();
  assert.deepStrictEqual(Object.keys(e.parseSize('[26.76GB]')), ['text', 'bytes']);
  assert.strictEqual(e.parseSize('[26.76GB]').text, '26.76GB');
  assert.strictEqual(e.parseSize('[26.76GB]').bytes, 26760000000);
  assert.strictEqual(e.parseSize(' 850MB ').bytes, 850000000);
  assert.strictEqual(e.parseSize('2T').text, '2TB');
  assert.strictEqual(e.parseSize('没有体积'), null);
  assert.strictEqual(e.parseSize(null), null);
  assert.strictEqual(e.formatSize(26760000000), '26.76GB');
  assert.strictEqual(e.formatSize(850000000), '850MB');
  assert.strictEqual(e.sizeRangeText([{ size: { bytes: 2.89e9 } }, { size: { bytes: 26.76e9 } }]), '2.89–26.76GB');
  assert.strictEqual(e.sizeRangeText([{ size: { bytes: 2.89e9 } }]), '2.89GB');
  assert.strictEqual(e.sizeRangeText([{ name: '无体积' }]), '');
  assert.strictEqual(e.maxBytes([{ size: { bytes: 3e9 } }, { size: { bytes: 9e9 } }]), 9e9);
});

test('parseBadges：族序即视觉序、族内归一、未知 token 不进徽章', () => {
  const e = load();
  // 族序 res,hdr,fps,codec,bitrate,audio,platform,subtitle,group（§6.3）；DV 优先于 HDR
  assert.strictEqual(labels(e.parseBadges(N1)), '2160P,DV,60帧,H.265,高码,2Audio,AAC,中字,国配,QuickIO');
  assert.strictEqual(labels(e.parseBadges('测试片.2160p.DV.HDR.60fps.10bit-QuickIO')), '2160P,DV,60帧,QuickIO');
  assert.strictEqual(labels(e.parseBadges('测试片.1080p.H265.高码版.DDP2.0.iQIYI.字幕组版-QuickIO')), '1080P,H.265,高码,DDP,iQIYI,QuickIO');
  assert.strictEqual(labels(e.parseBadges('随便的名字.10bit.DTS.1080p')), '1080P', '未知 token 只留 tooltip，不进徽章');
  assert.strictEqual(labels(e.parseBadges('')), '');
  // 类名两级色阶：字幕族强调、发布组弱灰、其余中性
  const bs = e.parseBadges(N1);
  assert.strictEqual(bs.filter((b) => b.family === 'subtitle')[0].cls, 'accent');
  assert.strictEqual(bs[bs.length - 1].cls, 'dim');
  assert.strictEqual(bs[0].cls, 'neutral');
});

test('splitConstantBadges：恒定值上提卡头；掺一条不同值则该族退回行内', () => {
  const e = load();
  const A = '片.2160p.x265.2Audio.中字-Team';
  const B = '片.2160p.x265.2Audio.中字.60帧-Team';
  const r = e.splitConstantBadges(mkVers(e, [A, B]));
  assert.strictEqual(r.constant.map((c) => c.label).join(','), '2160P,H.265,2Audio,中字,Team');
  assert.strictEqual(e.constantHeaderText(r.constant), '全 2160P · 全H.265 · 全2Audio · 全中字 · 全Team');
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.rows.map(labels).join('|'), '|60帧', '行内只显差异：A 全被上提 → 空，B 剩帧率');

  const C = '片.1080p.x265.2Audio.中字-Team';
  const r2 = e.splitConstantBadges(mkVers(e, [A, B, C]));
  assert.ok(r2.constant.map((c) => c.label).join(',').indexOf('1080P') < 0);
  assert.strictEqual(r2.constant.map((c) => c.label).join(','), 'H.265,2Audio,中字,Team', '分辨率有分歧 → 该族不恒定');
  assert.strictEqual(r2.rows[2].map((b) => b.label).join(','), '1080P');

  // 版本数 <2 不上提（§6.3：恒定值说明的前提是「多个版本」）
  const r3 = e.splitConstantBadges(mkVers(e, [A]));
  assert.strictEqual(r3.constant.length, 0);
  assert.strictEqual(r3.rows.map(labels).join('|'), labels(e.parseBadges(A)));
});

test('applyFilter / sortWorks / sortVersions：§6.1 四组取值的判定语义', () => {
  const e = load();
  const v = (name, bytes, badges) => ({ name: name, size: bytes ? { bytes: bytes } : null, allBadges: badges });
  const b = (family, label) => ({ family: family, label: label, cls: 'neutral' });
  const w1 = { key: 'w1', versions: [
    v('14b', 26.76e9, [b('res', '2160P'), b('subtitle', '中字')]),
    v('5b', 5e9, [b('res', '1080P')]),
  ] };
  const w2 = { key: 'w2', versions: [v('2b', 2e9, [b('res', '1080P'), b('subtitle', '中字')])] };
  const works = [w1, w2];

  assert.strictEqual(e.applyFilter(works, { subtitle: '中字' }).map((w) => w.key).join(','), 'w1,w2');
  assert.strictEqual(e.applyFilter(works, { subtitle: '中字' })[0].versions.map((x) => x.name).join(','), '14b');
  assert.strictEqual(e.applyFilter(works, { res: '1080P' }).map((w) => w.key + ':' + w.versions.map((x) => x.name).join('+')).join(','), 'w1:5b,w2:2b');
  assert.strictEqual(e.applyFilter(works, { size: 'gt15' }).map((w) => w.key).join(','), 'w1', '筛选后无版本的作品整卡不显');
  assert.strictEqual(e.applyFilter(works, {}).map((w) => w.key).join(','), 'w1,w2', '默认体积↓（26.76>2）');
  assert.strictEqual(e.applyFilter(works, { sort: 'size-asc' }).map((w) => w.key).join(','), 'w2,w1');
  assert.strictEqual(e.applyFilter(works, { sort: 'versions-desc' }).map((w) => w.key).join(','), 'w1,w2');
  assert.strictEqual(e.applyFilter([], { res: '2160P' }).length, 0);
  assert.strictEqual(e.sortVersions(w1.versions, 'size-asc').map((x) => x.name).join(','), '5b,14b', '展开后行内同序');
  assert.strictEqual(e.matchesSizeBand(NaN, 'lt5'), false, '无体积不参与档位判定');
  assert.strictEqual(e.matchesSizeBand(26.76e9, ''), true);
  assert.strictEqual(e.uniq([1, 1, 2, 2, 3]).join(','), '1,2,3');
  // 原数组不被改动（重渲染依赖不可变输入）
  assert.strictEqual(w1.versions.length, 2);
  assert.strictEqual(works[0].key, 'w1');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/huilian-magnet-enrich.test.js`
Expected: FAIL —`Cannot find module`/读文件 `ENOENT`（`public/video/huilian-magnet-enrich.js` 还不存在）。

- [ ] **Step 3: 写实现**

创建 `public/video/huilian-magnet-enrich.js`：

```js
/*
 * Stellaflix 影视模块 — 磁力发布名解析 / 入队串加工（纯函数，无 DOM、无网络、无定时器）
 * 依赖：SFV.huilianQueue.extractBtih —— 全仓唯一 btih 解析与归一（spec §9.5），
 *       故本文件必须在 huilian-queue.js 之后注册（index.html 的 SFV_SCRIPTS 顺序）。
 * 产出：SFV.huilianMagnetEnrich
 * 约定：体积单位一律十进制（1GB = 1e9）。数值只用于比较/排序/分档，
 *       不承诺与 qBittorrent 回报的二进制字节严格相等。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var GB = 1e9;
  var CRLF_QUOTE_RE = /[\r\n"']+/g;
  var WS_RE = /\s+/g;
  var BRACKET_RE = /[[\]()]/g;

  // §9.5：站点给的任意名字先清洗 CR/LF 与引号，再进 URL 或 DOM
  function cleanText(s) {
    if (typeof s !== 'string') return '';
    return s.replace(CRLF_QUOTE_RE, ' ').replace(WS_RE, ' ').trim();
  }

  // lazy 取依赖，避免测试沙箱与浏览器两种加载路径下的硬绑定
  function btih(magnet) {
    var q = SFV.huilianQueue;
    return q && typeof q.extractBtih === 'function' ? q.extractBtih(magnet) : null;
  }

  var TR_RE = /[?&]tr=/i;
  var DN_RE = /[?&]dn=/i;

  function existingTrackers(magnet) {
    if (typeof magnet !== 'string' || !magnet) return [];
    var out = [];
    var parts = magnet.split(/[?&]/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.slice(0, 3).toLowerCase() !== 'tr=') continue;
      var raw = p.slice(3);
      var v = raw;
      try { v = decodeURIComponent(raw); } catch (err) { /* 半截 % 编码：原样登记 */ }
      if (v) out.push(v);
    }
    return out;
  }

  /*
   * 注入规则声明的 tracker。
   * 前提事实（spec §3.1）：/api/v2/torrents/add 的表字段由 collectAddFields 构造，没有 trackers 字段，
   * 所以 tracker 只能拼进磁力 URL 本身经现有 url 通道提交 —— 这也正是认领键必须 btih 归一的原因。
   * 已有 tr= 的串一律不碰：站点自己给的清单比我们的规则更贴近这条种子。
   */
  function injectTrackers(magnet, trackers) {
    if (typeof magnet !== 'string' || !magnet) return magnet;
    if (TR_RE.test(magnet)) return magnet;
    var list = Array.isArray(trackers) ? trackers : [];
    var out = magnet;
    for (var i = 0; i < list.length; i++) {
      var t = cleanText(list[i]);
      if (!t) continue;
      out += '&tr=' + encodeURIComponent(t);
    }
    return out;
  }

  function withDisplayName(magnet, name) {
    if (typeof magnet !== 'string' || !magnet) return magnet;
    if (DN_RE.test(magnet)) return magnet;
    var n = cleanText(name);
    if (!n) return magnet;
    return magnet + '&dn=' + encodeURIComponent(n);
  }

  var SIZE_RE = /(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|T|G|M|B)\b/i;
  var SIZE_UNIT = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, T: 1e12, G: 1e9, M: 1e6, K: 1e3 };
  var SIZE_LETTER = { T: 'TB', G: 'GB', M: 'MB', K: 'KB' };

  function trimNum(n) { return String(parseFloat(Number(n).toFixed(2))); }

  function parseSize(text) {
    var s = cleanText(text).replace(BRACKET_RE, ' ');   // .file-size 的 [26.76GB] → 26.76GB
    if (!s) return null;
    var m = SIZE_RE.exec(s);
    if (!m) return null;
    var num = parseFloat(m[1]);
    if (!isFinite(num) || num <= 0) return null;
    var unit = m[2].toUpperCase();
    var bytes = Math.round(num * (SIZE_UNIT[unit] || 0));
    if (!bytes) return null;
    return { text: trimNum(num) + (SIZE_LETTER[unit] || unit), bytes: bytes };
  }

  function formatSize(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '';
    if (bytes >= 1e12) return trimNum(bytes / 1e12) + 'TB';
    if (bytes >= GB) return trimNum(bytes / GB) + 'GB';
    if (bytes >= 1e6) return trimNum(bytes / 1e6) + 'MB';
    return trimNum(bytes / 1e3) + 'KB';
  }

  function bytesOf(v) {
    var s = v && v.size;
    return s && typeof s.bytes === 'number' && isFinite(s.bytes) ? s.bytes : NaN;
  }

  function sizeRangeText(versions) {
    var lo = Infinity, hi = -Infinity;
    var list = Array.isArray(versions) ? versions : [];
    for (var i = 0; i < list.length; i++) {
      var b = bytesOf(list[i]);
      if (!isFinite(b)) continue;
      if (b < lo) lo = b;
      if (b > hi) hi = b;
    }
    if (lo > hi) return '';
    if (lo === hi) return formatSize(lo);
    // 区间两端同单位书写（站点体积实测全在 GB 量级），避免 "2.89GB–26.76GB" 的重复单位
    return trimNum(lo / GB) + '–' + trimNum(hi / GB) + 'GB';
  }

  function maxBytes(versions) {
    var hi = 0;
    var list = Array.isArray(versions) ? versions : [];
    for (var i = 0; i < list.length; i++) {
      var b = bytesOf(list[i]);
      if (isFinite(b) && b > hi) hi = b;
    }
    return hi;
  }

  function countOf(versions) {
    return Array.isArray(versions) ? versions.length : 0;
  }

  /*
   * 徽章词表（spec §6.3）。数组顺序 = 视觉顺序（左→右），发布组恒末位。
   * multi:true 的族可同屏多值（字幕/配音、音轨）；其余族内互斥、取第一个命中（DV>HDR>EDR）。
   * items 顺序即族内优先级。这张表是**种子不是穷举**：fixture 测的是解析器行为，
   * 词表完整性随远端规则演进，不在本文件加校验。
   */
  var BADGE_TOKENS = [
    { family: 'res', items: [
      // 4K 与 2160p 同物，归一到筛选条用的取值 '2160P'（§6.1 要精确匹配）
      { re: /2160[pi]?|4k\b/i, label: '2160P' },
      { re: /1080[pi]?/i, label: '1080P' },
      { re: /720[pi]?/i, label: '720P' }
    ] },
    { family: 'hdr', items: [
      { re: /\bDV\b|杜比视界/i, label: 'DV' },
      { re: /\bHDR/i, label: 'HDR' },
      { re: /\bEDR\b/i, label: 'EDR' }
    ] },
    { family: 'fps', items: [
      { re: /60\s*帧|60\s*fps|\bHFR\b/i, label: '60帧' }
    ] },
    { family: 'codec', items: [
      { re: /\bAV1\b/i, label: 'AV1' },
      { re: /x265|\bHEVC\b|H\.?\s?265/i, label: 'H.265' },
      { re: /x264|\bAVC\b|H\.?\s?264/i, label: 'H.264' }
    ] },
    { family: 'bitrate', items: [
      { re: /高码|\bHQ\b/i, label: '高码' }
    ] },
    { family: 'audio', multi: true, items: [
      { re: /2\s*Audios?|双音轨/i, label: '2Audio' },
      // 不写 \bDDP\b：'DDP2.0' 的 P 与 2 都是词字符，尾 \b 永不成立 → 全漏
      { re: /\bDDP|E-?AC-?3/i, label: 'DDP' },
      { re: /\bAAC/i, label: 'AAC' }
    ] },
    { family: 'platform', multi: true, items: [
      { re: /\bYK\b/, label: 'YK' },
      { re: /\biQIYI\b/, label: 'iQIYI' }
    ] },
    { family: 'subtitle', multi: true, items: [
      { re: /中字/, label: '中字' },
      { re: /国配|国粤/, label: '国配' }
    ] },
    { family: 'group', group: true, items: [] }
  ];
  var GROUP_RE = /-([A-Za-z][A-Za-z0-9_.]{1,19})$/;
  // 色阶两级（§6.3）：字幕族强调、发布组弱灰、其余中性
  var FAMILY_CLASS = { subtitle: 'accent', group: 'dim' };

  function mkBadge(family, label) {
    return { family: family, label: label, cls: FAMILY_CLASS[family] || 'neutral' };
  }

  function uniq(list) {
    var out = [], seen = {};
    var arr = Array.isArray(list) ? list : [];
    for (var i = 0; i < arr.length; i++) {
      var k = String(arr[i]);
      if (seen['#' + k]) continue;
      seen['#' + k] = 1;
      out.push(arr[i]);
    }
    return out;
  }

  function parseBadges(name) {
    var s = cleanText(name);
    var out = [];
    if (!s) return out;
    for (var i = 0; i < BADGE_TOKENS.length; i++) {
      var fam = BADGE_TOKENS[i];
      if (fam.group) {
        var gm = GROUP_RE.exec(s);
        if (gm) out.push(mkBadge('group', gm[1]));
        continue;
      }
      var picked = [];
      for (var j = 0; j < fam.items.length; j++) {
        if (!fam.items[j].re.test(s)) continue;
        picked.push(fam.items[j].label);
        if (!fam.multi) break;
      }
      for (var k = 0; k < picked.length; k++) out.push(mkBadge(fam.family, picked[k]));
    }
    return out;
  }

  function famLabels(badges, family) {
    var out = [];
    var arr = badges || [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].family === family) out.push(arr[i].label);
    }
    return uniq(out).sort().join(',');
  }

  /*
   * 恒定值上提（§6.3）：某族在该作品**全部版本**取值一致且版本数 ≥2 → 从行内移除、写进卡头。
   * 判定一律用原始 allBadges（裁决⑥）：卡头恒定值不该让行内筛选变成筛不到。
   * 返回 { constant:[{family,label}], rows:[badge[]] } —— rows 与入参同长同序。
   */
  function splitConstantBadges(versions) {
    var list = Array.isArray(versions) ? versions : [];
    var constant = [];
    if (list.length >= 2) {
      for (var i = 0; i < BADGE_TOKENS.length; i++) {
        var fam = BADGE_TOKENS[i].family;
        var first = null, same = true, any = false;
        for (var j = 0; j < list.length; j++) {
          var v = famLabels(list[j] && list[j].allBadges, fam);
          if (v) any = true;
          if (first === null) first = v;
          else if (v !== first) { same = false; break; }
        }
        if (any && same) constant.push({ family: fam, label: first });
      }
    }
    var drop = {};
    for (var c = 0; c < constant.length; c++) drop[constant[c].family] = 1;
    var rows = [];
    for (var r = 0; r < list.length; r++) {
      var kept = [];
      var bs = (list[r] && list[r].allBadges) || [];
      for (var b = 0; b < bs.length; b++) if (bs[b] && !drop[bs[b].family]) kept.push(bs[b]);
      rows.push(kept);
    }
    return { constant: constant, rows: rows };
  }

  // 卡头文案：分辨率带空格（「全 2160P」），其余直接接（「全中字」「全国配」）—— §6.2 示例逐字
  function constantHeaderText(constant) {
    var arr = Array.isArray(constant) ? constant : [];
    var parts = [];
    for (var i = 0; i < arr.length; i++) {
      parts.push('全' + (arr[i].family === 'res' ? ' ' : '') + arr[i].label);
    }
    return parts.join(' · ');
  }

  function dedupeByBtih(list) {
    var out = [];
    var seen = {};
    var arr = Array.isArray(list) ? list : [];
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (!v) continue;
      var key = btih(v.magnet);
      if (!key) continue;
      if (seen['#' + key]) continue;
      seen['#' + key] = 1;
      out.push(v);
    }
    return out;
  }

  function matchesSizeBand(bytes, band) {
    if (band === '' || band === null || band === undefined) return true;
    if (typeof bytes !== 'number' || !isFinite(bytes)) return false;
    if (band === 'lt5') return bytes < 5 * GB;
    if (band === '5to15') return bytes >= 5 * GB && bytes <= 15 * GB;
    if (band === 'gt15') return bytes > 15 * GB;
    return true;
  }

  function hasLabel(badges, family, label) {
    var arr = badges || [];
    for (var i = 0; i < arr.length; i++) {
      var b = arr[i];
      if (b && b.family === family && String(b.label).toUpperCase() === String(label).toUpperCase()) return true;
    }
    return false;
  }

  function filterVersions(versions, f) {
    var fl = f || {};
    var out = [];
    var list = Array.isArray(versions) ? versions : [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (!v) continue;
      var bs = v.allBadges || [];
      if (fl.subtitle && !hasLabel(bs, 'subtitle', fl.subtitle)) continue;
      if (fl.res && !hasLabel(bs, 'res', fl.res)) continue;
      if (fl.size && !matchesSizeBand(bytesOf(v), fl.size)) continue;
      out.push(v);
    }
    return out;
  }

  function shallow(o) {
    var t = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) t[k] = o[k];
    return t;
  }

  function sortVersions(versions, mode) {
    var list = (Array.isArray(versions) ? versions : []).slice();
    var m = mode || 'size-desc';
    list.sort(function (a, b) {
      var d = bytesOf(b) - bytesOf(a);
      if (m === 'size-asc') return -d;
      if (m === 'versions-desc') return 0;
      return d;
    });
    return list;
  }

  function sortWorks(works, mode) {
    var list = (Array.isArray(works) ? works : []).slice();
    var m = mode || 'size-desc';
    list.sort(function (a, b) {
      if (m === 'versions-desc') {
        return countOf(b && b.versions) - countOf(a && a.versions) || maxBytes(b) - maxBytes(a);
      }
      var d = maxBytes(b && b.versions) - maxBytes(a && a.versions);
      return m === 'size-asc' ? -d : d;
    });
    return list;
  }

  // 作品级筛选 + 排序：筛选后无版本的作品整卡不显；空筛选条件返回全量（不删卡）
  function applyFilter(works, f) {
    var fl = f || {};
    var filtering = !!(fl.subtitle || fl.res || fl.size);
    var out = [];
    var list = Array.isArray(works) ? works : [];
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (!w) continue;
      var versions = filterVersions(w.versions, fl);
      if (filtering && versions.length === 0) continue;
      var copyW = shallow(w);
      copyW.versions = versions;
      out.push(copyW);
    }
    return sortWorks(out, fl.sort);
  }

  SFV.huilianMagnetEnrich = {
    cleanText: cleanText,
    existingTrackers: existingTrackers,
    injectTrackers: injectTrackers,
    withDisplayName: withDisplayName,
    parseSize: parseSize,
    formatSize: formatSize,
    sizeRangeText: sizeRangeText,
    maxBytes: maxBytes,
    parseBadges: parseBadges,
    splitConstantBadges: splitConstantBadges,
    constantHeaderText: constantHeaderText,
    dedupeByBtih: dedupeByBtih,
    matchesSizeBand: matchesSizeBand,
    filterVersions: filterVersions,
    applyFilter: applyFilter,
    sortWorks: sortWorks,
    sortVersions: sortVersions,
    uniq: uniq,
  };
})(typeof window !== 'undefined' ? window : this);
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `node --test tests/huilian-magnet-enrich.test.js`
Expected: PASS，8 tests，0 fail。若 `parseBadges` 断言不符，**改词表实现去贴合测试**（测试里的是 §6.3 归一表逐字），不要反过来放宽断言。

- [ ] **Step 5: 提交**

```bash
git add public/video/huilian-magnet-enrich.js tests/huilian-magnet-enrich.test.js
git commit -m "feat: 汇联 磁力源 Task2 — enrich 发布名徽章族/体积/tracker 注入纯函数"
```

---

### Task 3: `huilian-magnet-rules.js` — 规则 schema / 校验 / 存储 / 远端导入 / 时效

**Files:**
- Create: `public/video/huilian-magnet-rules.js`
- Test: `tests/huilian-magnet-rules.test.js`

**Interfaces:**
- Consumes: `global.KazumiHttpClient.get(url, {useProxy:true, timeoutMs})`（远端导入取文本；缺席时退回 `fetch('/api/proxy?url=…')`）。**不改 `kazumi/` 目录**。
- Produces: `SFV.huilianMagnetRules`，键名固定为
  `STORAGE_KEY, TRACKER_STALE_MS, validateRule, formatValidateError, listAll, getEnabled, get, put, remove, setEnabled, isTrackerStale, formatDate, getText, parseImport, importFromJson, importFromUrl`。
  规则对象形状（Task 4 抓取、Task 9 面板都按它）：
  `{id, name, origin, searchURL, workItemXPath, workFields:{title,altTitle,year,poster,detailUrl}, magnetItemXPath, magnetAttr, sizeXPath, trackers:[], importedAt:number, enabled:boolean}`。

- [ ] **Step 1: 写失败测试**

创建 `tests/huilian-magnet-rules.test.js`：

```js
'use strict';
/** 运行：node --test tests/huilian-magnet-rules.test.js */
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');

const SRC = 'public/video/huilian-magnet-rules.js';

function makeStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => m,
  };
}

// 假规则：host 一律 example.test（不可解析），合规红线「零内置规则」在测试里的自我约束
const RAW = {
  id: 'r1',
  name: '示例站',
  origin: 'https://example.test',
  searchURL: 'https://example.test/search.php?search={query}&pjax=1',
  workItemXPath: '//div[@class="work-card"]',
  workFields: { title: './/h2/text()', year: './/span[@class="y"]/text()' },
  magnetItemXPath: '//a[@class="magnet-link"]',
  magnetAttr: 'data-url',
  sizeXPath: './/span[@class="file-size"]/text()',
  trackers: ['udp://tracker.example.test:2710/announce', 'https://tracker.example.test/announce'],
  importedAt: 1,          // 远端给的脏值必须被导入路径覆盖
  enabled: true,
  evilExtra: '不应落盘',  // 白名单外字段必须丢
};

function load(seed, now) {
  const storage = makeStorage(seed);
  const sandbox = { window: {}, URL: require('url').URL, localStorage: storage };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'huilian-magnet-rules.js' });
  return { R: sandbox.window.StellaflixVideo.huilianMagnetRules, storage, now: now || (() => Date.now()) };
}
const seeded = () => ({ 'stellaflix-video-huilian-magnet-rules': JSON.stringify([Object.assign({}, RAW, { importedAt: 1000 })]) });

test('put → listAll：字段不丢、白名单外字段被丢（证明绕开 Kazumi rule-schema 是必要的）', () => {
  const { R } = load();
  const res = R.put(RAW);
  assert.strictEqual(res.ok, true);
  const saved = R.get('r1');
  assert.strictEqual(saved.name, '示例站');
  assert.strictEqual(saved.workFields.title, './/h2/text()');
  assert.strictEqual(saved.sizeXPath, './/span[@class="file-size"]/text()');
  assert.strictEqual(saved.trackers.length, 2);
  assert.strictEqual(saved.evilExtra, undefined, '未知字段不得进存储');
  assert.strictEqual(saved.importedAt > 0, true, '导入时由代码写 importedAt');
});

test('parseImport：一条非法 = 整批不落盘（§9.7 不允许部分写入）', () => {
  const { R, storage } = load();
  const bad = Object.assign({}, RAW, { id: 'r2', searchURL: 'https://other.test/s?q={query}' });
  const text = JSON.stringify([RAW, bad]);
  const res = R.importFromJson(text);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, '规则格式不符：searchURL 不合法。未导入任何内容。', 'host 与声明的 origin 不符 = 该字段存在但不可用');
  assert.strictEqual(R.listAll().length, 0, '整批拒绝：第一条也不许落盘');
  assert.strictEqual(storage.dump().has('stellaflix-video-huilian-magnet-rules'), false);
});

test('校验文案逐字：缺字段 / 超长 / tracker 超条数 三种失败各有确定文案', () => {
  const { R } = load();
  const miss = Object.assign({}, RAW); delete miss.magnetItemXPath;
  assert.strictEqual(R.formatValidateError(R.validateRule(miss)), '规则格式不符：缺少 magnetItemXPath。未导入任何内容。');
  const long = Object.assign({}, RAW, { searchURL: 'https://example.test/' + 'a'.repeat(600) });
  assert.strictEqual(R.formatValidateError(R.validateRule(long)), '规则格式不符：searchURL 不合法。未导入任何内容。');
  const many = Object.assign({}, RAW, { trackers: new Array(41).fill('udp://tracker.example.test:2710/announce') });
  assert.strictEqual(R.formatValidateError(R.validateRule(many)), '规则格式不符：trackers 不合法。未导入任何内容。');
  assert.strictEqual(R.validateRule(many).ok, false);
});

test('tracker 缺省 → 空数组（Task 4 据此不注入）；非法 tracker 整条拒绝', () => {
  const { R } = load();
  const noT = Object.assign({}, RAW); delete noT.trackers;
  assert.strictEqual(R.validateRule(noT).rule.trackers.length, 0);
  const dirty = Object.assign({}, RAW, { trackers: ['not a tracker url'] });
  assert.strictEqual(R.validateRule(dirty).ok, false);
  assert.strictEqual(R.formatValidateError(R.validateRule(dirty)), '规则格式不符：trackers 不合法。未导入任何内容。');
});

test('getEnabled / setEnabled / remove：停用与删除即时生效（§5.1 分区随之消失）', () => {
  const { R } = load(seeded());
  assert.strictEqual(R.getEnabled().length, 1);
  assert.strictEqual(R.setEnabled('r1', false).ok, true);
  assert.strictEqual(R.getEnabled().length, 0);
  assert.strictEqual(R.get('r1').enabled, false);
  assert.strictEqual(R.get('r1').importedAt, 1000, '开关不得重置 importedAt');
  assert.strictEqual(R.remove('r1').ok, true);
  assert.strictEqual(R.listAll().length, 0);
  assert.strictEqual(R.setEnabled('nope', true).ok, false);
});

test('isTrackerStale：仅在「有 tracker 且距 importedAt 超 180 天」时成立；formatDate 补零', () => {
  const { R } = load();
  const DAY = 86400000;
  const t0 = Date.UTC(2026, 9, 1);
  const base = { trackers: ['udp://x/announce'], importedAt: t0 - 179 * DAY };
  assert.strictEqual(R.isTrackerStale(base, t0), false);
  assert.strictEqual(R.isTrackerStale({ trackers: ['udp://x/announce'], importedAt: t0 - 181 * DAY }, t0), true);
  assert.strictEqual(R.isTrackerStale({ trackers: [], importedAt: t0 - 900 * DAY }, t0), false, '没注入过 tracker 就谈不上失效');
  assert.strictEqual(R.isTrackerStale({ trackers: ['udp://x/announce'], importedAt: 0 }, t0), false, '无导入时间 = 不作判定');
  assert.strictEqual(R.TRACKER_STALE_MS, 180 * DAY);
  assert.strictEqual(R.formatDate(new Date(2026, 9, 1).getTime()), '2026-10-01', '按本地日历日展示（用本地构造，避免时区依赖）');
  assert.strictEqual(R.formatDate(0), '');
  assert.strictEqual(R.formatDate(null), '');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/huilian-magnet-rules.test.js`
Expected: FAIL — 读文件 `ENOENT`（`public/video/huilian-magnet-rules.js` 还不存在）。

- [ ] **Step 3: 写实现**

创建 `public/video/huilian-magnet-rules.js`：

```js
/*
 * Stellaflix 影视模块 — 磁力站点规则：schema 校验 / localStorage 读写 / 远端导入 / tracker 时效
 * 依赖：global.KazumiHttpClient（可选，仅 importFromUrl 用）；缺席时退回本地 /api/proxy。
 * 产出：SFV.huilianMagnetRules
 * 合规（spec §9.1/§9.7）：仓库零内置规则；规则只来自远端导入或手动粘贴；
 *   校验不通过整条不落盘；白名单外的字段一律丢弃（这也是不复用 Kazumi rule-schema 的原因）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var STORAGE_KEY = 'stellaflix-video-huilian-magnet-rules';
  var DAY_MS = 86400000;
  // §6.6.5：阈值是拍的（样本不足定标，spec §10 列为待取证）；只读 importedAt，不起定时器
  var TRACKER_STALE_MS = 180 * DAY_MS;

  var LIMITS = { xpath: 1000, tracker: 300, trackers: 40 };  // 必填字段的长度上限在 FIELD_LIMIT
  var REQUIRED = ['id', 'name', 'origin', 'searchURL', 'workItemXPath', 'magnetItemXPath', 'magnetAttr'];
  // 必填字段各自的长度上限，一张表定死（避免下面出现三元套三元的取值式）
  var FIELD_LIMIT = {
    id: 64, name: 120, origin: 200, searchURL: 600,
    workItemXPath: 1000, magnetItemXPath: 1000, magnetAttr: 60
  };
  var WORK_FIELD_KEYS = ['title', 'altTitle', 'year', 'poster', 'detailUrl'];
  var TRACKER_RE = /^(https?:\/\/|udp:\/\/)\S+$/i;
  var ATTR_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

  /*
   * 注意：本模块的 `global` 是 window，而 window 上没有 localStorage/URL/fetch 的自由变量可见性差异
   * 在 vm 沙箱测试里会咬人（tests 用 sandbox.localStorage 注入，window 只是普通对象）。
   * 因此一律走自由变量 + typeof 守卫：浏览器与沙箱两种宿主都能取到。
   */
  function store() {
    try { return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null; } catch (e) { return null; }
  }

  function readStore() {
    var s = store();
    if (!s) return [];
    var raw = null;
    try { raw = s.getItem(STORAGE_KEY); } catch (e) { return []; }
    if (!raw) return [];
    var list = null;
    try { list = JSON.parse(raw); } catch (e) { return []; }
    return Array.isArray(list) ? list : [];
  }

  function writeStore(list) {
    var s = store();
    if (!s) return false;
    try { s.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (e) { return false; }
    return true;
  }

  function isStr(s) { return typeof s === 'string'; }
  function strOk(s, max) { return isStr(s) && s.length > 0 && s.length <= max; }
  function optStrOk(s, max) { return s === undefined || s === null || s === '' ? true : strOk(s, max); }

  function hostOf(u) {
    if (!isStr(u) || typeof URL === 'undefined') return '';
    try { return (new URL(u).host || '').toLowerCase(); } catch (e) { return ''; }
  }

  // kind: 'missing' = 字段不存在或为空；'invalid' = 存在但长度/格式/归属不合法（文案见 formatValidateError）
  function fail(field, kind) { return { ok: false, field: field, kind: kind === 'invalid' ? 'invalid' : 'missing' }; }

  /*
   * 整条校验 + 白名单重建。返回 {ok:true, rule} 或 {ok:false, field, kind}。
   * 未知字段一律不进返回对象 —— 远端 JSON 想塞什么额外的键都落不了盘。
   */
  function validateRule(raw) {
    if (!raw || typeof raw !== 'object') return fail('id');
    var i, k;
    for (i = 0; i < REQUIRED.length; i++) {
      k = REQUIRED[i];
      var v = raw[k];
      // 「没有这个字段」与「有但不可用」是两回事，文案要分开（见 formatValidateError）
      if (!isStr(v) || v.length === 0) return fail(k);
      if (v.length > FIELD_LIMIT[k]) return fail(k, 'invalid');
      // magnetAttr 是属性名（'data-url' 之类），还要额外过字符集闸，防把 XPath 或表达式当属性名
      if (k === 'magnetAttr' && !ATTR_RE.test(v)) return fail('magnetAttr', 'invalid');
    }
    var originHost = hostOf(raw.origin);
    if (!originHost) return fail('origin', 'invalid');
    // §9.6 抓取 origin 白名单：静态可查的只有 searchURL（workFields 是 XPath，无 host 可校 → 裁决⑦）
    if (hostOf(raw.searchURL) !== originHost) return fail('searchURL', 'invalid');

    if (!optStrOk(raw.sizeXPath, LIMITS.xpath)) return fail('sizeXPath', 'invalid');

    var wf = raw.workFields && typeof raw.workFields === 'object' ? raw.workFields : {};
    var workFields = {};
    for (i = 0; i < WORK_FIELD_KEYS.length; i++) {
      k = WORK_FIELD_KEYS[i];
      var fv = wf[k];
      if (fv === undefined || fv === null || fv === '') continue;
      if (!strOk(fv, LIMITS.xpath)) return fail('workFields.' + k, 'invalid');
      workFields[k] = fv;   // 只认 WORK_FIELD_KEYS 五个键，其他键直接丢
    }

    var trackers = [];
    if (raw.trackers !== undefined && raw.trackers !== null) {
      if (!Array.isArray(raw.trackers)) return fail('trackers', 'invalid');
      if (raw.trackers.length > LIMITS.trackers) return fail('trackers', 'invalid');
      for (i = 0; i < raw.trackers.length; i++) {
        var t = isStr(raw.trackers[i]) ? raw.trackers[i].trim() : '';
        if (!t) continue;
        if (t.length > LIMITS.tracker || !TRACKER_RE.test(t)) return fail('trackers', 'invalid');
        trackers.push(t);
      }
    }

    var rule = {};
    rule.id = raw.id.trim();
    rule.name = raw.name.trim();
    rule.origin = raw.origin.replace(/\s+/g, '');
    rule.searchURL = raw.searchURL;
    rule.workItemXPath = raw.workItemXPath;
    rule.workFields = workFields;
    rule.magnetItemXPath = raw.magnetItemXPath;
    rule.magnetAttr = raw.magnetAttr.trim();
    rule.sizeXPath = isStr(raw.sizeXPath) ? raw.sizeXPath : '';
    rule.trackers = trackers;
    rule.enabled = raw.enabled === false ? false : true;
    return { ok: true, rule: rule };
  }

  /*
   * §6.6.4 逐字文案：`规则格式不符：缺少 {field}。未导入任何内容。`
   * spec 只给了「缺少」一种，但字段存在却超长/归属错误时报「缺少」会把用户引到错方向，
   * 故按 kind 分「缺少 / 不合法」两式，前后缀保持一致（记入计划文末「spec 修订」⑪）。
   */
  function formatValidateError(res) {
    var field = (res && res.field) || 'id';
    if (res && res.kind === 'invalid') return '规则格式不符：' + field + ' 不合法。未导入任何内容。';
    return '规则格式不符：缺少 ' + field + '。未导入任何内容。';
  }

  function listAll() { return readStore(); }

  function getEnabled() {
    var all = readStore(), out = [];
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].enabled) out.push(all[i]);
    return out;
  }

  function get(id) {
    var all = readStore();
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === id) return all[i];
    return null;
  }

  // 同 id 覆盖；importedAt 一律由代码写（远端 JSON 的同名字段在 validateRule 里已被丢弃）
  function put(raw, nowMs) {
    var v = validateRule(raw);
    if (!v.ok) return v;
    var list = readStore();
    var at = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
    v.rule.importedAt = at;
    var replaced = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === v.rule.id) { list[i] = v.rule; replaced = true; break; }
    }
    if (!replaced) list.push(v.rule);
    // 写不进 localStorage（隐私模式/配额）不是格式问题，不能套 §6.6.4 的「缺少/不合法」文案
    if (!writeStore(list)) return { ok: false, field: 'storage', kind: 'storage' };
    return { ok: true, rule: v.rule };
  }

  function remove(id) {
    var list = readStore(), out = [], hit = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) { hit = true; continue; }
      out.push(list[i]);
    }
    if (!hit) return { ok: false, field: 'id' };
    return { ok: writeStore(out) };
  }

  // 只动 enabled，其余字段（含 importedAt）原样保留
  function setEnabled(id, enabled) {
    var list = readStore(), hit = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) { list[i].enabled = !!enabled; hit = true; break; }
    }
    if (!hit) return { ok: false, field: 'id' };
    return { ok: writeStore(list) };
  }

  function isTrackerStale(rule, nowMs) {
    if (!rule) return false;
    var n = Array.isArray(rule.trackers) ? rule.trackers.length : 0;
    if (n === 0) return false;
    var at = typeof rule.importedAt === 'number' ? rule.importedAt : 0;
    if (at <= 0) return false;
    var now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
    return now - at > TRACKER_STALE_MS;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function formatDate(ts) {
    if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return '';
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /*
   * 取远端文本。优先 KazumiHttpClient（带浏览器特征头 + /api/proxy 中转）；
   * 规则导入阶段还没有 rule，故不构造伪造头，交给代理默认行为。
   */
  function getText(url) {
    var target = isStr(url) ? url : '';
    if (!target) return Promise.reject(new Error('地址为空'));
    var client = SFV.kazumiHttpClient || global.KazumiHttpClient;
    if (client && typeof client.get === 'function') {
      return Promise.resolve(client.get(target, { useProxy: true, timeoutMs: 15000 }));
    }
    if (typeof fetch !== 'function') return Promise.reject(new Error('本地服务未就绪，无法抓取站点。'));
    return fetch('/api/proxy?url=' + encodeURIComponent(target)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  // 全批或全无：任一条非法 → ok:false + 该条的 field，调用方据此一条都不写
  function parseImport(text) {
    var data = null;
    try { data = JSON.parse(isStr(text) ? text : ''); } catch (e) { return { ok: false, field: 'json' }; }
    var arr = Array.isArray(data) ? data : (data && Array.isArray(data.rules) ? data.rules : null);
    if (!arr) return { ok: false, field: 'json' };
    if (arr.length === 0) return { ok: false, field: 'json' };
    var rules = [];
    for (var i = 0; i < arr.length; i++) {
      var v = validateRule(arr[i]);
      if (!v.ok) return v;
      rules.push(v.rule);
    }
    return { ok: true, rules: rules };
  }

  function storageError() {
    return { ok: false, error: '本地存储不可用，未导入任何内容。', field: 'storage' };
  }

  // 全批或全无：先全量校验，再快照回滚 —— 任何一条写失败都不留半套规则
  function importFromJson(text, nowMs) {
    var p = parseImport(text);
    if (!p.ok) {
      if (p.kind === 'storage') return storageError();
      return { ok: false, error: formatValidateError(p), field: p.field };
    }
    var snapshot = JSON.stringify(readStore());
    for (var i = 0; i < p.rules.length; i++) {
      var r = put(p.rules[i], nowMs);
      if (!r.ok) {
        writeStore(JSON.parse(snapshot));
        if (r.kind === 'storage') return storageError();
        return { ok: false, error: formatValidateError(r), field: r.field };
      }
    }
    return { ok: true, count: p.rules.length };
  }

  function importFromUrl(url, nowMs) {
    return getText(url).then(function (text) { return importFromJson(text, nowMs); });
  }

  SFV.huilianMagnetRules = {
    STORAGE_KEY: STORAGE_KEY,
    TRACKER_STALE_MS: TRACKER_STALE_MS,
    validateRule: validateRule,
    formatValidateError: formatValidateError,
    listAll: listAll,
    getEnabled: getEnabled,
    get: get,
    put: put,
    remove: remove,
    setEnabled: setEnabled,
    isTrackerStale: isTrackerStale,
    formatDate: formatDate,
    getText: getText,
    parseImport: parseImport,
    importFromJson: importFromJson,
    importFromUrl: importFromUrl,
  };
})(typeof window !== 'undefined' ? window : this);
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `node --test tests/huilian-magnet-rules.test.js`
Expected: PASS，6 tests，0 fail。
两处易错点，测试会立刻抓出来：① `validateRule` 的 `magnetAttr` 长度用 `FIELD_LIMIT.magnetAttr`（60）， XPath 类用 `LIMITS.xpath`（1000），别把它们对调；② `fail(field, kind)` 的第二参漏掉时，`formatValidateError` 会退化成「缺少」，第 3、4 条测试即红。**遇到红灯改实现，不要改断言** —— 断言里的文案是 §6.6.4 逐字规定。

- [ ] **Step 5: 提交**

```bash
git add public/video/huilian-magnet-rules.js tests/huilian-magnet-rules.test.js
git commit -m "feat: 汇联 磁力源 Task3 — 规则 schema 校验/导入(全批或全无)/tracker 时效"
```

---

### Task 4: 脱敏 fixture + `huilian-magnet-source.js` — 抓取解析 / 会话缓存 / 并发上限 2

**Files:**
- Create: `tests/fixtures/make-pomo-fixtures.js`（生成器，可复算；`tests/**` 不进安装包）
- Create: `tests/fixtures/pomo-search-pjax.html`、`tests/fixtures/pomo-detail-sanitized.html`（由生成器产出后入库，spec §8 点名的两个文件）
- Create: `public/video/huilian-magnet-source.js`
- Test: `tests/huilian-magnet-source.test.js`

**Interfaces:**
- Consumes: `global.KazumiHttpClient.get(url, {useProxy,timeoutMs})`（返回 Promise\<string\>；失败抛 `HTTP <status> …`；超时走 AbortError）、`global.KazumiXPathEngine.{parseHtml, queryXPathFirst, queryXPathAll, toNodeRelative}`、`SFV.huilianMagnetEnrich.*`（Task 2）。
- Produces: `SFV.huilianMagnetSource`，键名固定为
  `MAX_CONCURRENCY, buildSearchURL, absolutize, proxySrc, searchWorks, parseVersions, fetchWorks, fetchVersions, getText, mapFetchError, resetCache, runningCount, pendingCount`。
  作品对象：`{key(=详情页绝对 URL), ruleId, sourceName, title, altTitle, year, poster(=/api/proxy 串或 ''), versions:null|[]}`；
  `fetch*` 一律返回 `{ok:true, value} | {ok:false, message}`（message 已是 §7 逐字文案，组件层不再拼错误句）。

- [ ] **Step 1: 写 fixture 生成器并生成**

创建 `tests/fixtures/make-pomo-fixtures.js`：

```js
/*
 * 脱敏 fixture 生成器（spec §8 / §9.4）。
 * 结构照站点实测：作品卡 div.work-card + 详情 a.detail-link；磁力锚点 a.magnet-link，
 * 磁力串在 data-url（不是 href），且裸 btih 不带 tr=/dn=；体积在紧随其后的 span.file-size（带方括号）。
 * 内容全部合成：站点/资源 host 一律 example.test / images.example，
 * btih 一律 '0'×38 + 两位序号（明显伪造，不可下载）。
 * 运行：node tests/fixtures/make-pomo-fixtures.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const hash = (i) => '0'.repeat(38) + String(i).padStart(2, '0'); // 40 位十六进制，全伪造

// 14 条合成发布名：token 取自 spec §6.3 的词表（族齐全），体积按实测区间降序
const NAMES = [
  ['给阿嬷的情书.2160p.WEB-DL.DV.60帧率版本.HQ.2Audio.AAC2.0.中字国配.x265-QuickIO', 26.76],
  ['给阿嬷的情书.2160p.WEB-DL.DV.60帧率版本.HQ.2Audio.AAC2.0.中字.x265-QuickIO', 26.71],
  ['给阿嬷的情书.2160p.WEB-DL.DV.60帧率版本.HQ.AAC2.0.中字.x265-QuickIO', 26.68],
  ['给阿嬷的情书.2160p.WEB-DL.DV.HDR.60帧率版本.HQ.2Audio.AAC2.0.国配.x265-QuickIO', 24.9],
  ['给阿嬷的情书.2160p.WEB-DL.DV.HDR.60帧率版本.2Audio.AAC2.0.中字.x265-QuickIO', 21.4],
  ['给阿嬷的情书.2160p.WEB-DL.DV.HDR.2Audio.AAC2.0.中字国配.x265-QuickIO', 20.8],
  ['给阿嬷的情书.2160p.WEB-DL.DV.HDR.AAC2.0.中字.x265-QuickIO', 18.3],
  ['给阿嬷的情书.2160p.WEB-DL.HDR.60帧率版本.HQ.2Audio.AAC2.0.中字.x265-QuickIO', 15.6],
  ['给阿嬷的情书.2160p.WEB-DL.HDR.60帧率版本.HQ.2Audio.中字.x265-QuickIO', 12.9],
  ['给阿嬷的情书.2160p.WEB-DL.HDR.HQ.2Audio.AAC2.0.中字.x265-QuickIO', 9.88],
  ['给阿嬷的情书.1080p.WEB-DL.60帧率版本.HQ.2Audio.AAC2.0.中字.x264-QuickIO', 7.42],
  ['给阿嬷的情书.1080p.WEB-DL.2Audio.AAC2.0.中字国配.x264-QuickIO', 6.2],
  ['给阿嬷的情书.1080p.WEB-DL.AAC2.0.中字.x264-QuickIO', 4.35],
  ['给阿嬷的情书.1080p.WEB-DL.AAC2.0.中字.x264-EDR-QuickIO', 2.89],
];

// 搜索页：3 张卡 —— 2 张合规、1 张详情链越界（Task 4 的 origin 白名单用例）
const search = [
  '<!doctype html><html><body>',
  '<div class="work-card">' +
  '  <a class="detail-link" href="/work/777"></a>' +
  '  <h2 class="title">给阿嬷的情书</h2>' +
  '  <span class="alt-title">Dear_Teena</span>' +
  '  <span class="year">2026</span>' +
  '  <img class="poster" src="/p/777.jpg">' +
  '</div>',
  '<div class="work-card">' +
  '  <a class="detail-link" href="https://example.test/work/778"></a>' +
  '  <h2 class="title">另一部片</h2>' +
  '  <span class="alt-title">Another</span>' +
  '  <span class="year">2025</span>' +
  '</div>',
  '<div class="work-card">' +
  '  <a class="detail-link" href="https://other.test/work/999"></a>' +
  '  <h2 class="title">越界卡</h2>' +
  '</div>',
  '</body></html>',
].join('\n');

// 详情页：每条版本重复 3 次（实测 42 锚点 → 14 唯一 btih），data-url 裸 btih，href 是占位 '#'
const rows = [];
for (let i = 0; i < NAMES.length; i++) {
  const magnet = 'magnet:?xt=urn:btih:' + hash(i);
  for (let k = 0; k < 3; k++) {
    rows.push(
      '<li class="dl-item">' +
      '<a class="magnet-link" href="#" data-url="' + magnet + '">' + NAMES[i][0] + '</a>' +
      '<span class="file-size">[' + NAMES[i][1] + 'GB]</span>' +
      '</li>'
    );
  }
}
const detail = ['<!doctype html><html><body><ul class="dl-list">', rows.join('\n'), '</ul></body></html>'].join('\n');

fs.writeFileSync(path.join(dir, 'pomo-search-pjax.html'), search, 'utf8');
fs.writeFileSync(path.join(dir, 'pomo-detail-sanitized.html'), detail, 'utf8');
console.log('anchors=' + rows.length + ' uniqueBtih=' + NAMES.length + ' searchCards=3');
```

Run: `node tests/fixtures/make-pomo-fixtures.js`
Expected: `anchors=42 uniqueBtih=14 searchCards=3`，并生成两个 `.html`。
（生成器与产物一起入库：产物便于 review 直读，生成器保证任何改动能复算。）

- [ ] **Step 2: 写失败测试**

创建 `tests/huilian-magnet-source.test.js`：

```js
'use strict';
/** 运行：node --test tests/huilian-magnet-source.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { after } = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const RULE = {
  id: 'fixture', name: '示例站', origin: 'https://example.test',
  searchURL: 'https://example.test/search.php?search={query}&pjax=1',
  workItemXPath: '//div[@class="work-card"]',
  workFields: {
    title: './/h2[@class="title"]/text()',
    altTitle: './/span[@class="alt-title"]/text()',
    year: './/span[@class="year"]/text()',
    poster: './/img[@class="poster"]/@src',
    detailUrl: './/a[@class="detail-link"]',
  },
  magnetItemXPath: '//a[@class="magnet-link"]',
  magnetAttr: 'data-url',
  sizeXPath: 'following-sibling::span[@class="file-size"][1]/text()',
  trackers: ['udp://tracker.example.test:2710/announce'],
  importedAt: 1, enabled: true,
};

// 假 http-client：按 url 分派 fixture。defer=true 走宏任务（setTimeout）返回，
// 这样同步的 await Promise.resolve() 检查点仍能看到「只有 2 个在飞」，而 4 个最终都会完成。
// runScripts:'outside-only' 必须带——否则 window.eval 只是宿主 realm 的 eval，
// 模块会挂到 Node 的 globalThis 上而不是 jsdom 的 window 上（实测静默失败，断言全变 undefined）。
// jsdom 窗口有活动句柄，不 close 会让 node --test 跑完不退出；after() 统一收尾。
const windows = [];
function buildEnv(opt) {
  const o = opt || {};
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: RULE.origin + '/', runScripts: 'outside-only' });
  windows.push(dom.window);
  const win = dom.window;
  const calls = [];
  win.KazumiHttpClient = {
    get: function (url) {
      calls.push(url);
      if (o.failWith) return Promise.reject(new Error(o.failWith));
      if (o.defer) return new Promise((resolve) => { setTimeout(() => resolve(pickHtml(url)), 0); });
      return Promise.resolve(pickHtml(url));
    },
  };
  function pickHtml(url) {
    return url.indexOf('search.php') >= 0 ? read('tests/fixtures/pomo-search-pjax.html') : read('tests/fixtures/pomo-detail-sanitized.html');
  }
  win.eval(read('public/video/kazumi/xpath-engine.js'));
  win.eval(read('public/video/huilian-queue.js'));
  win.eval(read('public/video/huilian-magnet-enrich.js'));
  win.eval(read('public/video/huilian-magnet-source.js'));
  return { win, S: win.StellaflixVideo.huilianMagnetSource, calls };
}
after(() => { for (const w of windows) w.close(); });
const workOf = (res) => res.value[0];

test('buildSearchURL：{query} 由代码 encodeURIComponent；缺占位符 → 空串', () => {
  const { S } = buildEnv();
  assert.strictEqual(S.buildSearchURL(RULE, '阿 嬷'), 'https://example.test/search.php?search=' + encodeURIComponent('阿 嬷') + '&pjax=1');
  assert.strictEqual(S.buildSearchURL({ searchURL: 'https://example.test/s' }, 'x'), '');
  assert.strictEqual(S.buildSearchURL(null, 'x'), '');
});

test('absolutize/proxySrc：相对链接落回 origin；越界一律丢（§9.6 运行期二道闸）', () => {
  const { S } = buildEnv();
  assert.strictEqual(S.absolutize(RULE, '/work/777'), 'https://example.test/work/777');
  assert.strictEqual(S.absolutize(RULE, 'https://other.test/x'), '');
  assert.strictEqual(S.absolutize(RULE, ''), '');
  assert.strictEqual(S.absolutize(RULE, 'magnet:?xt=urn:btih:00'), 'magnet:?xt=urn:btih:00', '磁力不做 origin 判定');
  assert.strictEqual(S.proxySrc(RULE, '/p/777.jpg'), '/api/proxy?url=' + encodeURIComponent('https://example.test/p/777.jpg'));
  assert.strictEqual(S.proxySrc(RULE, 'https://other.test/p.jpg'), '');
});

test('searchWorks：卡片→作品模型字段齐；越界详情链的卡被丢；无海报走空串', async () => {
  const { S } = buildEnv();
  const res = await S.fetchWorks(RULE, '阿嬷');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.value.length, 2, '3 张卡里 other.test 那张必须丢');
  const w = workOf(res);
  assert.strictEqual(w.title, '给阿嬷的情书');
  assert.strictEqual(w.altTitle, 'Dear_Teena');
  assert.strictEqual(w.year, '2026');
  assert.strictEqual(w.key, 'https://example.test/work/777');
  assert.ok(w.poster.indexOf('/api/proxy?url=') === 0);
  assert.strictEqual(res.value[1].poster, '', '无 <img> 的卡：poster 空串，由渲染层退化纯文字块');
  assert.strictEqual(res.value[0].versions, null, '首屏不预抓详情（§6.4）');
});

test('parseVersions：42 锚点→14 唯一；磁力取 data-url 而非 href；dn 先于 tr', async () => {
  const { S } = buildEnv();
  const res = await S.fetchVersions(RULE, { key: 'https://example.test/work/777' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.value.length, 14);
  const v0 = res.value[0];
  assert.ok(v0.magnet.indexOf('magnet:?xt=urn:btih:0000') === 0, v0.magnet);
  assert.ok(v0.href === undefined, 'href="#" 的占位链接不得当磁力用（§2 实测站点放 data-url）');
  assert.ok(v0.magnet.indexOf('&dn=') < v0.magnet.indexOf('&tr='), 'dn 先于 tr：' + v0.magnet);
  assert.strictEqual(decodeURIComponent(v0.magnet.split('&dn=')[1].split('&tr=')[0]), v0.name);
  assert.ok(v0.magnet.indexOf('&tr=' + encodeURIComponent(RULE.trackers[0])) > 0);
  assert.strictEqual(v0.size.text, '26.76GB');
  assert.strictEqual(v0.size.bytes, 26760000000);
  assert.strictEqual(v0.allBadges.map((b) => b.label).join(','), '2160P,DV,60帧,H.265,高码,2Audio,AAC,中字,国配,QuickIO');
  assert.strictEqual(res.value[13].size.bytes, 2890000000, '按 fixture 顺序即体积降序');
});

test('会话缓存：同 workKey 只抓一次；resetCache 后再抓（§5.8）', async () => {
  const { S, calls } = buildEnv();
  const w = { key: 'https://example.test/work/777' };
  const first = await S.fetchVersions(RULE, w);
  const second = await S.fetchVersions(RULE, w);
  const detailCalls = calls.filter((u) => u.indexOf('search.php') < 0).length;
  assert.strictEqual(detailCalls, 1);
  assert.strictEqual(second.ok, true, '缓存命中也必须回 {ok,value} 合同形状（不得回裸数组）');
  assert.ok(Array.isArray(second.value), '缓存命中的 value 是解析结果数组');
  assert.strictEqual(second.value.length, first.value.length, '命中值与首次解析同值');
  await S.fetchVersions(RULE, { key: 'https://example.test/work/777?x=1' });
  assert.strictEqual(calls.filter((u) => u.indexOf('search.php') < 0).length, 2, 'workKey 不同 = 不同缓存槽');
  S.resetCache();
  await S.fetchVersions(RULE, w);
  assert.strictEqual(calls.filter((u) => u.indexOf('search.php') < 0).length, 3);
});

test('并发上限 2 + FIFO：四个不同作品同时发起，只有 2 个真在飞（§6.4）', async () => {
  const { S, calls } = buildEnv({ defer: true });
  const works = [1, 2, 3, 4].map((i) => ({ key: 'https://example.test/work/' + i }));
  const ps = works.map((w) => S.fetchVersions(RULE, w));
  await Promise.resolve();
  assert.strictEqual(calls.length, 2, 'MAX_CONCURRENCY=2：不得 4 个一起打代理');
  assert.strictEqual(S.runningCount(), 2);
  assert.strictEqual(S.pendingCount(), 2);
  for (const p of ps) { const r = await p; assert.strictEqual(r.ok, true); }
  assert.strictEqual(calls.length, 4, '名额交接：前一轮完成后排队作品必须被抓到');
  assert.strictEqual(S.runningCount(), 0);
  assert.strictEqual(S.pendingCount(), 0);
});

test('错误映射（§7 逐字）：HTTP 状态 / 超时 / 无代理 / 未知；失败不进缓存', async () => {
  const a = buildEnv({ failWith: 'HTTP 404 (Not Found) for https://example.test/x' });
  const r1 = await a.S.fetchWorks(RULE, '阿嬷');
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.message, '站点无响应（404）。稍后再试或换一个规则。');
  assert.strictEqual(a.S.mapFetchError({ name: 'AbortError', message: 'The operation was aborted' }), '站点无响应（超时）。稍后再试或换一个规则。');
  assert.strictEqual(a.S.mapFetchError(new Error('request timeout')), '站点无响应（超时）。稍后再试或换一个规则。');
  assert.strictEqual(a.S.mapFetchError(new Error('别的东西')), '站点无响应（未知错误）。稍后再试或换一个规则。');
  const b = buildEnv();
  b.win.KazumiHttpClient = null;
  assert.strictEqual((await b.S.fetchWorks(RULE, '阿嬷')).message, '本地服务未就绪，无法抓取站点。');
  // 失败不缓存：同一 key 再请求应重新发网络
  const before = a.calls.length;
  await a.S.fetchWorks(RULE, '阿嬷');
  assert.ok(a.calls.length > before, '错误结果不得进会话缓存');
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test tests/huilian-magnet-source.test.js`
Expected: FAIL — `read('public/video/huilian-magnet-source.js')` 报 `ENOENT`。

- [ ] **Step 4: 写实现**

创建 `public/video/huilian-magnet-source.js`：

```js
/*
 * Stellaflix 影视模块 — 磁力站点抓取：搜索页/详情页解析 + 会话缓存 + 并发上限
 * 依赖：global.KazumiHttpClient、global.KazumiXPathEngine（kazumi/ 目录零改动，只用导出面）、
 *       SFV.huilianMagnetEnrich（Task 2）。注册顺序：kazumi/* → huilian-queue → huilian-magnet-enrich → 本文件。
 * 产出：SFV.huilianMagnetSource
 * 红线：抓取只允许规则声明的 origin（§9.6）；任何 reject 必须转成 §7 文案随 {ok:false,message} 上浮，不许静默。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var MAX_CONCURRENCY = 2;      // §6.4：防「20 个作品 = 20 并发」打爆代理与站点
  var SEARCH_TIMEOUT_MS = 15000;
  var DETAIL_TIMEOUT_MS = 20000;

  function enrich() { return SFV.huilianMagnetEnrich || null; }
  function http() { return global.KazumiHttpClient || null; }
  function E() { return global.KazumiXPathEngine || null; }

  function hostOf(u) {
    if (typeof u !== 'string' || !u || typeof URL === 'undefined') return '';
    try { return (new URL(u).host || '').toLowerCase(); } catch (e) { return ''; }
  }

  /*
   * §3.1：`{query}` 由代码 encodeURIComponent。
   * 没有占位符的规则不可用（返回空串，调用方按「规则不可用」处理，不发请求）。
   */
  function buildSearchURL(rule, query) {
    if (!rule || typeof rule.searchURL !== 'string' || !rule.searchURL) return '';
    var q = typeof query === 'string' ? query.trim() : '';
    if (!q || rule.searchURL.indexOf('{query}') < 0) return '';
    return rule.searchURL.split('{query}').join(encodeURIComponent(q));
  }

  /*
   * §9.6 的运行期二道闸：站点回吐的任何链接，落不回声明的 origin 就丢。
   * 导入期只能校 searchURL 的 host（workFields 是 XPath，没有 host 可校 —— 裁决⑦），
   * 真正的越界拦截只能发生在这里。
   */
  function absolutize(rule, href) {
    if (!rule || !rule.origin || typeof href !== 'string' || !href) return '';
    var s = href.trim();
    if (/^magnet:/i.test(s)) return s;   // 磁力没有 origin 概念，不做 host 判定
    if (typeof URL === 'undefined') return '';
    var abs = '';
    try { abs = new URL(s, rule.origin).href; } catch (e) { return ''; }
    return hostOf(abs) === hostOf(rule.origin) ? abs : '';
  }

  // 站点直链在应用内可能被 CSP/混合内容拦（§10 待真机），一律先经本地代理
  function proxySrc(rule, url) {
    var abs = absolutize(rule, url);
    if (!abs) return '';
    return '/api/proxy?url=' + encodeURIComponent(abs);
  }

  function queryAll(context, expr) {
    var x = E();
    if (!x || typeof x.queryXPathAll !== 'function' || !expr) return [];
    var r = x.queryXPathAll(context, expr);
    return Array.isArray(r) ? r : [];
  }

  function queryFirst(context, expr) {
    var x = E();
    if (!x || typeof x.queryXPathFirst !== 'function' || !expr) return null;
    return x.queryXPathFirst(context, expr);
  }

  // 元素上下文必须相对化：Dart 端 queryXPath 是相对当前节点，浏览器 "/" 开头锚文档根
  function rel(expr) {
    var x = E();
    if (typeof expr !== 'string' || !expr) return '';
    return x && typeof x.toNodeRelative === 'function' ? x.toNodeRelative(expr) : expr;
  }

  function parseHtml(html) {
    var x = E();
    if (!x || typeof x.parseHtml !== 'function') throw new Error('本地服务未就绪，无法抓取站点。');
    return x.parseHtml(html);
  }

  function nodeText(node) {
    if (!node) return '';
    if (typeof node.textContent === 'string') return node.textContent;
    if (typeof node.nodeValue === 'string') return node.nodeValue;
    return '';
  }

  /*
   * workFields 约定（写死，不留解释空间）：
   *   title / altTitle / year / poster → 取节点文本（XPath 一般以 /text() 或 /@src 结尾）
   *   detailUrl → 若命中元素则取 href，否则取文本
   */
  function fieldValue(node, key) {
    if (!node) return '';
    if (key === 'detailUrl' && node.nodeType === 1 && typeof node.getAttribute === 'function') {
      var href = node.getAttribute('href') || '';
      if (href) return href;
    }
    return nodeText(node);
  }

  // 搜索页 HTML → 作品数组（不预抓详情；无标题或详情链越界的卡直接丢）
  function searchWorks(rule, html) {
    var en = enrich();
    if (!rule || !en) return [];
    var doc = parseHtml(html);
    var items = queryAll(doc, rule.workItemXPath);   // 文档上下文：'//' 本就等价 './/'，不改写
    var wf = rule.workFields || {};
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item) continue;
      var title = en.cleanText(fieldValue(queryFirst(item, rel(wf.title)), 'title'));
      if (!title) continue;
      var detail = absolutize(rule, fieldValue(queryFirst(item, rel(wf.detailUrl)), 'detailUrl'));
      if (!detail) continue;
      var work = {};
      work.key = detail;                 // §6.2：workKey 用详情页 URL，比片名稳
      work.ruleId = rule.id;
      work.sourceName = rule.name;
      work.title = title;
      work.altTitle = en.cleanText(fieldValue(queryFirst(item, rel(wf.altTitle)), 'altTitle'));
      work.year = en.cleanText(fieldValue(queryFirst(item, rel(wf.year)), 'year'));
      work.poster = proxySrc(rule, fieldValue(queryFirst(item, rel(wf.poster)), 'poster'));
      work.versions = null;
      out.push(work);
    }
    return out;
  }

  /*
   * 详情页 HTML → 版本数组。
   * 磁力串只认 rule.magnetAttr 指定的属性（实测本站在 data-url，href 是 '#' 占位，§2）。
   * 加工顺序：补 dn（站点没给才补）→ 注入 tracker（已有 tr= 一律不碰）→ 按 btih 去重。
   * dn 先于 tr：qbt 会把 dn 当显示名，拼在后头不影响认领（认领走 btih，Task 1）。
   */
  function parseVersions(rule, html) {
    var en = enrich();
    if (!rule || !en) return [];
    var doc = parseHtml(html);
    var anchors = queryAll(doc, rule.magnetItemXPath);
    var list = [];
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (!a || a.nodeType !== 1 || typeof a.getAttribute !== 'function') continue;
      var raw = a.getAttribute(rule.magnetAttr) || '';
      if (!/^magnet:\?/i.test(raw)) continue;          // 普通 http 直链不进队列
      var name = en.cleanText(nodeText(a)) || en.cleanText(a.getAttribute('title') || '');
      var size = rule.sizeXPath ? en.parseSize(nodeText(queryFirst(a, rel(rule.sizeXPath)))) : null;
      var v = {};
      v.rawMagnet = raw;
      v.magnet = en.injectTrackers(en.withDisplayName(raw, name), rule.trackers);
      v.name = name || raw;
      v.size = size;
      v.allBadges = en.parseBadges(name);
      list.push(v);
    }
    return en.dedupeByBtih(list);
  }

  var cache = {};      // key → 解析结果（会话内一次，§5.8）
  var inflight = {};   // key → 同一 promise（并发去重，防两个入口同时抓同一作品）
  var running = 0;
  var waiters = [];

  function slot() {
    if (running < MAX_CONCURRENCY) { running += 1; return Promise.resolve(); }
    return new Promise(function (resolve) { waiters.push(resolve); });   // FIFO
  }

  function release() {
    var next = waiters.shift();
    if (next) next();          // 名额直接交接，running 不减
    else running -= 1;
  }

  function getText(url, timeoutMs) {
    var client = http();
    if (!client || typeof client.get !== 'function') {
      return Promise.reject(new Error('本地服务未就绪，无法抓取站点。'));
    }
    return Promise.resolve(client.get(url, { useProxy: true, timeoutMs: timeoutMs || SEARCH_TIMEOUT_MS }));
  }

  /*
   * §7 文案表：三条模板全覆盖，未知错误也套用「站点无响应（…）」形状（裁决⑭：
   * spec 没给通用错误行，宁可用同一模板填 {status}=未知错误，也不新造第四种句式）。
   */
  function mapFetchError(err) {
    var name = err && err.name ? String(err.name) : '';
    var msg = err && err.message ? String(err.message) : String(err || '');
    if (name === 'AbortError' || /abort|timeout|timed out/i.test(msg)) return '站点无响应（超时）。稍后再试或换一个规则。';
    if (/本地服务未就绪/.test(msg)) return '本地服务未就绪，无法抓取站点。';
    var m = /HTTP (\d{3})/.exec(msg);
    if (m) return '站点无响应（' + m[1] + '）。稍后再试或换一个规则。';
    return '站点无响应（未知错误）。稍后再试或换一个规则。';
  }

  // 抓取 + 解析 + 缓存/限流。成功值进缓存；任何失败都只回 {ok:false,message}，不进缓存（可重试）
  function runCached(key, loader, parser) {
    if (Object.prototype.hasOwnProperty.call(cache, key)) return Promise.resolve({ ok: true, value: cache[key] });
    if (inflight[key]) return inflight[key];
    var p = slot().then(function () {
      return loader().then(parser).then(
        function (value) { cache[key] = value; return { ok: true, value: value }; },
        function (err) { return { ok: false, message: mapFetchError(err) }; }
      ).then(function (res) {
        inflight[key] = null;
        release();
        return res;
      });
    });
    inflight[key] = p;
    return p;
  }

  function fetchWorks(rule, query) {
    var url = buildSearchURL(rule, query);
    if (!url) return Promise.resolve({ ok: false, message: '规则格式不符：缺少 searchURL。未导入任何内容。' });
    if (!hostOf(url) || hostOf(url) !== hostOf(rule && rule.origin)) {
      return Promise.resolve({ ok: false, message: '规则格式不符：searchURL 不合法。未导入任何内容。' });
    }
    return runCached('search:' + rule.id + ':' + url, function () { return getText(url, SEARCH_TIMEOUT_MS); }, function (html) { return searchWorks(rule, html); });
  }

  function fetchVersions(rule, work) {
    if (!work || typeof work.key !== 'string' || !work.key) {
      return Promise.resolve({ ok: false, message: '这个条目里没有可用磁力链接。' });
    }
    var url = absolutize(rule, work.key);
    if (!url) return Promise.resolve({ ok: false, message: '规则格式不符：searchURL 不合法。未导入任何内容。' });
    return runCached('work:' + url, function () { return getText(url, DETAIL_TIMEOUT_MS); }, function (html) { return parseVersions(rule, html); });
  }

  function resetCache() {
    cache = {};
    inflight = {};
  }

  function runningCount() { return running; }
  function pendingCount() { return waiters.length; }

  SFV.huilianMagnetSource = {
    MAX_CONCURRENCY: MAX_CONCURRENCY,
    buildSearchURL: buildSearchURL,
    absolutize: absolutize,
    proxySrc: proxySrc,
    searchWorks: searchWorks,
    parseVersions: parseVersions,
    fetchWorks: fetchWorks,
    fetchVersions: fetchVersions,
    getText: getText,
    mapFetchError: mapFetchError,
    resetCache: resetCache,
    runningCount: runningCount,
    pendingCount: pendingCount,
  };
})(typeof window !== 'undefined' ? window : this);
```

- [ ] **Step 5: 跑测试确认全绿**

Run: `node --test tests/huilian-magnet-source.test.js`
Expected: PASS，7 tests，0 fail。
两个真实易错点（别靠改断言绕过）：
① `runCached` 里 `inflight[key] = null` 必须在 `release()` 之前，否则「同 key 并发」用例第二次仍复用旧 promise 而计数不变；
② 并发用例只断言 `calls.length === 2`（不是 4）—— 若实现把 `slot()` 写成「先计数后判断」，`runningCount()` 会变 3+，两条断言一起红。

- [ ] **Step 6: 提交**

```bash
git add tests/fixtures/make-pomo-fixtures.js tests/fixtures/pomo-search-pjax.html tests/fixtures/pomo-detail-sanitized.html public/video/huilian-magnet-source.js tests/huilian-magnet-source.test.js
git commit -m "feat: 汇联 磁力源 Task4 — 脱敏 fixture + 抓取解析/会话缓存/并发上限2"
```

### Task 5: 注册三个数据层模块 + `source-picker` 认磁力行

**Files:**
- Modify: `public/index.html:2147`（`SFV_SCRIPTS` 数组，`"video/huilian-queue.js"` 与 `"video/huilian-player-bar.js"` 之间插三行）
- Modify: `public/video/source-picker.js:69-84`（`groupBySource` 展示名）、`:244-271`（`makeRow` 图标/徽章）、`:502-513`（导出 `openModal`）
- Modify: `public/video/hall.css:446`（`.sfv-picker-badge-direct` 之后加一条磁力徽章规则）
- Test: `tests/huilian-magnet-registration.test.js`、`tests/source-picker-magnet-row.test.js`

**Interfaces:**
- Consumes: Task 2/3/4 的三个模块文件（本任务才把它们接进运行时）。
- Produces: `SFV.sourcePicker.openModal(build) -> close()`（Task 6 的版本选择器复用，spec §5.7；现 `openModal:372-385` 是私有函数，别名/手动检索在用但**没导出**，本任务补导出）；候选字段约定 `kind:'magnet'` → 图标 `🧲`、徽章「磁力」、分组名取 `sourceName`（站点名），**不落进 `CMS` 兜底分支**。

**裁决（注册时机）**：spec §3.1 说五个文件都插在 `"video/huilian-page.js"` 之前。但 `site-search`（Task 8）与 `rules-ui`（Task 9）此刻还不存在，提前注册会让 `SFV_SCRIPTS` 加载器 404。故拆成：**本任务注册三个数据层模块**（enrich → rules → source，紧跟 `huilian-queue.js`，满足 enrich 取 `extractBtih` 的顺序要求）；Task 8/9 各自注册自己的文件（都排在 `huilian-page.js` 之前）。依赖序不变，代价是注册分三次落。

- [ ] **Step 1: 写失败测试**

创建 `tests/huilian-magnet-registration.test.js`：

```js
'use strict';
/** 运行：node --test tests/huilian-magnet-registration.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

// 只取 SFV_SCRIPTS 数组字面量内部（从变量名到首个 `];`），避免匹配到页面其它 script 清单
const body = html.slice(html.indexOf('SFV_SCRIPTS'));
const list = (body.slice(0, body.indexOf('];')).match(/"video\/[^"]+\.js"/g) || [])
  .map((s) => s.slice(1, -1));
const at = (p) => list.indexOf('video/' + p);

test('三个磁力数据层模块已列入 SFV_SCRIPTS', () => {
  ['huilian-magnet-enrich.js', 'huilian-magnet-rules.js', 'huilian-magnet-source.js']
    .forEach((f) => assert.ok(at(f) >= 0, f + ' 未注册进 public/index.html 的 SFV_SCRIPTS'));
});

test('注册顺序 = 依赖序：queue → enrich → rules → source → …… → huilian-page', () => {
  assert.ok(at('huilian-queue.js') < at('huilian-magnet-enrich.js'),
    'enrich 必须排在 queue 之后（它运行期取 SFV.huilianQueue.extractBtih）');
  assert.ok(at('huilian-magnet-enrich.js') < at('huilian-magnet-rules.js'));
  assert.ok(at('huilian-magnet-rules.js') < at('huilian-magnet-source.js'));
  assert.ok(at('huilian-magnet-source.js') < at('huilian-page.js'),
    '必须在 huilian-page.js 之前（页面 mount 时运行期取这些模块）');
});

test('site-search / rules-ui 此刻尚未注册（各自任务落地时才注册，防 404）', () => {
  assert.strictEqual(at('huilian-site-search.js'), -1);
  assert.strictEqual(at('huilian-magnet-rules-ui.js'), -1);
});
```

创建 `tests/source-picker-magnet-row.test.js`：

```js
'use strict';
/** 运行：node --test tests/source-picker-magnet-row.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { after } = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const windows = [];
function loadPicker() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  windows.push(dom.window);
  const win = dom.window;
  // open() 末尾有入场动画的 rAF；测试不需要动画，置空避免多一层异步
  win.requestAnimationFrame = function () {};
  win.eval(read('public/video/source-picker.js'));
  return win.StellaflixVideo.sourcePicker;
}
// jsdom 窗口带活动句柄，不 close 会让 node --test 跑完不退出
after(() => { for (const w of windows) w.close(); });

const MAG_CAND = {
  id: 'magnet:pomo:%2Fwork%2F777', label: '给阿嬷的情书', sub: 'Dear Teena · 2026',
  kind: 'magnet', group: 'pomo.mom', sourceName: 'pomo.mom', isEmbed: false,
  _ref: { key: 'https://example.test/work/777' }, sourceKey: 'magnet:pomo',
};
const CMS_CAND = { id: 'cms:a:1', label: 'CMS 命中', kind: 'cms', sourceKey: 'cms:a', _ref: {}, isEmbed: true };

test('groupBySource：magnet 候选用站点名，不落进 CMS 兜底', () => {
  const P = loadPicker();
  const gs = P._test.groupBySource([MAG_CAND, CMS_CAND]);
  assert.strictEqual(gs.length, 2);
  assert.strictEqual(gs[0].sourceKey, 'magnet:pomo');
  assert.strictEqual(gs[0].sourceName, 'pomo.mom', 'spec §5.2：sourceName=规则展示名（站点名）');
  assert.strictEqual(gs[1].sourceName, 'CMS');
  // 三段分支的唯一可区分点：sourceName 与 group 同时缺位时，磁力落 '磁力站点'、CMS 才落 'CMS'
  // （MAG_CAND 带 sourceName，旧的两段式兜底也能取对名，故必须补这一例才能证明新分支）
  const bare = P._test.groupBySource([
    { id: 'magnet:x:1', kind: 'magnet', sourceKey: 'magnet:x' },
    { id: 'cms:x:1', kind: 'cms', sourceKey: 'cms:x' },
  ]);
  assert.strictEqual(bare[0].sourceName, '磁力站点', '磁力候选不得落进 CMS 兜底');
  assert.strictEqual(bare[1].sourceName, 'CMS', 'CMS 兜底原样保留');
});

test('open()：磁力行 = 🧲 图标 + 「磁力」徽章 + 独立 class；点击把原候选交回 onPick', () => {
  const P = loadPicker();
  const win = windows[windows.length - 1];
  let picked = null;
  P.open({ title: '给阿嬷的情书', candidates: [MAG_CAND, CMS_CAND], onPick: (c) => { picked = c; } });
  const rows = win.document.querySelectorAll('.sfv-picker-row');
  assert.strictEqual(rows.length, 2);
  const ic = rows[0].querySelector('.sfv-picker-row-ic').textContent;
  const badge = rows[0].querySelector('.sfv-picker-row-badge');
  assert.strictEqual(ic, '🧲');
  assert.strictEqual(badge.textContent, '磁力');
  assert.ok(badge.className.indexOf('sfv-picker-badge-magnet') >= 0, badge.className);
  assert.strictEqual(rows[1].querySelector('.sfv-picker-row-ic').textContent, '📡', 'CMS 行不受影响');
  rows[0].dispatchEvent(new win.Event('click', { bubbles: true }));
  assert.strictEqual(picked, MAG_CAND);
});

test('openModal 已导出（版本选择器复用既有模态，spec §5.7 不新造第三套）', () => {
  const P = loadPicker();
  assert.strictEqual(typeof P.openModal, 'function');
  const win = windows[windows.length - 1];
  let built = null;
  const close = P.openModal(function (card) { built = card; card.textContent = 'x'; });
  assert.ok(win.document.querySelector('.sfv-picker-modal'), 'openModal 应把卡片挂进 body');
  assert.strictEqual(built.textContent, 'x');
  close();
  assert.strictEqual(win.document.querySelector('.sfv-picker-modal'), null, 'close() 必须移除 backdrop');
});

test('磁力徽章配色写在 hall.css（渲染器产出的 class 不得无样式）', () => {
  assert.ok(read('public/video/hall.css').indexOf('.sfv-picker-badge-magnet') >= 0,
    'hall.css 缺 .sfv-picker-badge-magnet 规则');
});
```

- [ ] **Step 2: 跑两个测试确认失败**

Run: `node --test tests/huilian-magnet-registration.test.js tests/source-picker-magnet-row.test.js`
Expected: FAIL — 注册测报 `未注册进 public/index.html 的 SFV_SCRIPTS`；picker 测报 `bare[0].sourceName === 'CMS'`（两段式兜底把磁力并进 CMS 分支，即 `MAG_CAND`/`CMS_CAND` 都带 `sourceName` 或 `group` 时旧代码也能取对名，**只有 `bare` 这一例能证明新增的第三段分支**）、`badge.textContent === '内嵌'`、`typeof P.openModal === 'undefined'`。

- [ ] **Step 3: 注册三个模块**

`public/index.html` 现 2147 行处，把

```js
    "video/huilian-queue.js",
    "video/huilian-player-bar.js",
```

改成

```js
    "video/huilian-queue.js",
    "video/huilian-magnet-enrich.js",
    "video/huilian-magnet-rules.js",
    "video/huilian-magnet-source.js",
    "video/huilian-player-bar.js",
```

- [ ] **Step 4: `source-picker.js` 认磁力**

`groupBySource`（现 74-76 行）的展示名三元改成为三段：

```js
      var name = (c.kind === 'kazumi')
        ? (c.ruleName || c.group || 'Kazumi')
        : (c.kind === 'magnet')
          ? (c.sourceName || c.group || '磁力站点')
          : (c.sourceName || c.group || 'CMS');
```

`makeRow`（现 250-255 行）的图标与徽章：

```js
    var ic = doc.createElement('span');
    ic.className = 'sfv-picker-row-ic';
    var isMagnet = c.kind === 'magnet';
    ic.textContent = isMagnet ? '🧲' : (c.kind === 'kazumi' ? '🛰' : '📡');
    var badge = doc.createElement('span');
    // 磁力候选没有「内嵌/直链」概念（它是走 BT 队列入队，不是取播放地址）→ 第三态徽章
    badge.className = 'sfv-picker-row-badge ' + (isMagnet ? 'sfv-picker-badge-magnet'
      : (c.isEmbed ? 'sfv-picker-badge-embed' : 'sfv-picker-badge-direct'));
    badge.textContent = isMagnet ? '磁力' : (c.isEmbed ? '内嵌' : '直链');
```

导出面（现 502-505 行）加 `openModal`：

```js
  SFV.sourcePicker = {
    open: open, close: close, isOpen: isOpen, setStatus: setStatus,
    appendSource: appendSource, setSourceWaiting: setSourceWaiting,
    showAliasDialog: showAliasDialog, showManualDialog: showManualDialog,
    openModal: openModal,   // 通用模态工具：Task 6 的磁力版本选择器复用（spec §5.7）
```

- [ ] **Step 5: `hall.css` 磁力徽章配色**

现 446 行 `.sfv-picker-badge-direct { … }` 之后加一行（色值取站点主色 `#f5c518`，与 embed 的青色同饱和度层级）：

```css
.sfv-picker-badge-magnet { background: rgba(245,197,24,.14); color: #f5c518; }
```

- [ ] **Step 6: 跑测试确认全绿**

Run: `node --test tests/huilian-magnet-registration.test.js tests/source-picker-magnet-row.test.js tests/huilian-queue.test.js`
Expected: PASS，registration 3 项 + picker 4 项 + 既有 `huilian-queue` 12 项，0 fail。
既有 `source-picker` 无测试文件（`grep -rln sourcePicker tests/` 为空），所以本任务是它的第一条契约锁；改 `groupBySource`/`makeRow` 时**不得**动 CMS/Kazumi 两支的现有输出（注册测之外还要人工确认：CMS 行仍是 `📡` + 内嵌/直链）。

- [ ] **Step 7: 提交**

```bash
git add public/index.html public/video/source-picker.js public/video/hall.css tests/huilian-magnet-registration.test.js tests/source-picker-magnet-row.test.js
git commit -m "feat: 汇联 磁力源 Task5 — 注册三数据层模块 + 源选择弹窗磁力行"
```

### Task 6: `detail-source.js` — 详情页磁力分区（独立分区 + 版本选择 → 入队走完整播链路）

**Files:**
- Modify: `public/video/detail-source.js`（`collectSourceUnits:523-534`、`queryOneUnit:387-401` 与错误分支 `:426-434`、`normalizeUnitItems:556-567`、`playCandidate:577-580`、`onPick:358-361`、新增 `magnetSearch/openVersionPicker`、导出面 `:1008-1031`）
- Modify: `public/video/hall.css`（版本选择器 `.sfv-version-*` 四条规则；`source-picker` 的模态样式就在 hall.css，见现 `.sfv-picker-modal` 带）
- Test: `tests/detail-source-magnet-partition.test.js`

**Interfaces:**
- Consumes: `SFV.huilianMagnetRules.getEnabled()/get(id)`（Task 3）、`SFV.huilianMagnetSource.fetchWorks(rule, kw)/fetchVersions(rule, work)`（Task 4，返回 `{ok,value}|{ok:false,message}`）、`SFV.sourcePicker.openModal(build)`（Task 5 导出）、`SFV.huilianEnqueue.submit(magnet)`（Task 7，`Promise<{ok, error?, duplicated?, hash}>`）与 `SFV.huilianEnqueue.focusTask(hash)`、`SFV.detail.el(tag, cls, text)` / `SFV.detail.toast(msg)`（`detail.js:22,710` 既有门面）。
- Produces: 候选形态 `{ id:'magnet:<ruleId>:<encodeURIComponent(workKey)>', label, sub, title, kind:'magnet', group, sourceName, isEmbed:false, _ref:<作品对象>, sourceKey:'magnet:<ruleId>' }`；`SFV.detailSource` 多出 `collectSourceUnits / normalizeUnitItems / magnetSearch / openVersionPicker` 四个面（沿用本文件既有风格：内部函数一律直接挂导出面，无 `_test` 壳）。

**两条裁决**（写进代码注释，实现者不必再判）：
- **裁决②**：候选 `sub` 用搜索页已有的「`altTitle · year`」，不用 spec §5.3 字面的「N 个版本 · 体积区间」——分区候选来自 `searchWorks`，此刻**没有抓详情**（§6.4 首屏不预抓），版本数与体积区间未知；不为了凑文案预抓 20 个作品的详情页。版本数/区间在点开后的版本选择器里给。
- **裁决⑨**：磁力候选**不写 `playbackSession`**（`beginPlaybackSession`/`markPlaybackSource` 都跳过）。会话是给「同一部片跨源热切换」用的，磁力走的是 BT 队列入队，不是取播放地址；写进会话会让播放器「选源」面板列出一条根本切不了的源。

- [ ] **Step 1: 写失败测试**

创建 `tests/detail-source-magnet-partition.test.js`：

```js
'use strict';
/** 运行：node --test tests/detail-source-magnet-partition.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { after } = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const RULE = {
  id: 'pomo', name: 'pomo.mom', origin: 'https://example.test',
  searchURL: 'https://example.test/search.php?search={query}&pjax=1',
  workItemXPath: '//div', magnetItemXPath: '//a', magnetAttr: 'data-url',
  trackers: ['udp://tracker.example.test:2710/announce'], importedAt: 1, enabled: true,
};
const WORK = {
  key: 'https://example.test/work/777', ruleId: 'pomo', sourceName: 'pomo.mom',
  title: '给阿嬷的情书', altTitle: 'Dear Teena', year: '2026', poster: '', versions: null,
};
const MAG_CAND = {
  id: 'magnet:pomo:%2Fwork%2F777', label: '给阿嬷的情书', kind: 'magnet',
  group: 'pomo.mom', sourceName: 'pomo.mom', isEmbed: false, _ref: WORK, sourceKey: 'magnet:pomo',
};
const flush = () => new Promise((r) => setImmediate(r));

const windows = [];
/** 起一个只装 detail-source 所需门面的 jsdom  realm；stub 全走 opt。 */
function loadDs(opt) {
  const o = opt || {};
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>',
    { url: 'https://app.test/', runScripts: 'outside-only' });
  windows.push(dom.window);
  const win = dom.window;
  win.requestAnimationFrame = function () {};
  const toasts = [];
  const routes = [];
  const submits = [];
  const modalCards = [];
  win.StellaflixVideo = {
    detail: {
      el: function (tag, cls, text) {
        const n = win.document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = String(text);
        return n;
      },
      toast: function (m) { toasts.push(String(m)); },
      classifyCandidateEmbed: function () { return false; },
    },
    model: {}, sources: null, kazumi: null,
    router: { go: function (p) { routes.push(p); } },
    sourcePicker: {
      open: function () {}, close: function () {}, setStatus: function () {},
      setSourceWaiting: function () {}, appendSource: function () {},
      openModal: o.noModal ? undefined : function (build) {
        const card = win.document.createElement('div');
        card.className = 'sfv-picker-modal';
        win.document.getElementById('host').appendChild(card);
        modalCards.push(card);
        let closed = false;
        build(card, function () { closed = true; card.remove(); });
        return function () { if (!closed) card.remove(); };
      },
    },
    huilianMagnetRules: {
      getEnabled: function () { return o.rules === undefined ? [RULE] : o.rules; },
      get: function (id) { return (id === 'pomo' && o.ruleGone !== true) ? RULE : null; },
    },
    huilianMagnetSource: {
      fetchWorks: function () {
        return Promise.resolve(o.worksFail ? { ok: false, message: '站点无响应（404）。稍后再试或换一个规则。' } : { ok: true, value: [WORK] });
      },
      fetchVersions: function () {
        return Promise.resolve({ ok: true, value: o.versions === undefined ? [
          { name: 'A 2160P', magnet: 'magnet:?xt=urn:btih:' + '0'.repeat(40) + '&tr=t', size: { text: '26.76GB', bytes: 26760000000 } },
          { name: 'B 1080P', magnet: 'magnet:?xt=urn:btih:' + '1'.repeat(40), size: { text: '4.35GB', bytes: 4350000000 } },
        ] : o.versions });
      },
    },
    huilianEnqueue: {
      submit: function (m) {
        submits.push(m);
        if (typeof o.submitFn === 'function') return o.submitFn(m);
        return Promise.resolve(o.enqueueFail ? { ok: false, error: '磁盘已满' }
          : o.enqueueDup ? { ok: true, duplicated: true, hash: 'H1' } : { ok: true, hash: 'H1' });
      },
      focusTask: function (h) { routes.push('focus:' + h); },
    },
  };
  // 缺席降级路径的用例开关（§6.4 之外的另一条红线：依赖缺席时只 toast、不抛）
  if (o.noSource) delete win.StellaflixVideo.huilianMagnetSource;
  if (o.noEnqueue) delete win.StellaflixVideo.huilianEnqueue;
  win.eval(read('public/video/detail-source.js'));
  const DS = win.StellaflixVideo.detailSource;
  return { win, DS, toasts, routes, submits, modalCards };
}
after(() => { for (const w of windows) w.close(); });

test('collectSourceUnits：启用磁力规则 → magnet 单元，key=magnet:<id>、name=站点名', () => {
  const { DS } = loadDs();
  const units = DS.collectSourceUnits();
  const mag = units.filter((u) => u.kind === 'magnet');
  assert.strictEqual(mag.length, 1);
  assert.strictEqual(mag[0].key, 'magnet:pomo');
  assert.strictEqual(mag[0].sourceName, 'pomo.mom');
  assert.strictEqual(mag[0].ref, RULE);
});

test('§5.1 无启用规则 = 分区根本不存在（不是空 Tab）', () => {
  assert.strictEqual(loadDs({ rules: [] }).DS.collectSourceUnits().filter((u) => u.kind === 'magnet').length, 0);
  // 模块没注册（非桌面/未加载）同样不得抛
  const bare = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.test/', runScripts: 'outside-only' });
  windows.push(bare.window);
  bare.window.requestAnimationFrame = function () {};
  bare.window.StellaflixVideo = { detail: { el() {}, toast() {}, classifyCandidateEmbed() { return false; } }, model: {}, router: { go() {} } };
  bare.window.eval(read('public/video/detail-source.js'));
  assert.strictEqual(bare.window.StellaflixVideo.detailSource.collectSourceUnits().length, 0);
});

test('normalizeUnitItems：magnet 候选字段齐 + sub=英文名·年份（裁决②，非未抓就未知的版本数）', () => {
  const { DS } = loadDs();
  const out = DS.normalizeUnitItems({ kind: 'magnet', key: 'magnet:pomo', sourceName: 'pomo.mom', ref: RULE }, [WORK], { title: '给阿嬷的情书' });
  assert.strictEqual(out.length, 1);
  const c = out[0];
  assert.strictEqual(c.id, 'magnet:pomo:' + encodeURIComponent(WORK.key));
  assert.strictEqual(c.kind, 'magnet');
  assert.strictEqual(c.label, '给阿嬷的情书');
  assert.strictEqual(c.sub, 'Dear Teena · 2026');
  assert.strictEqual(c.group, 'pomo.mom');
  assert.strictEqual(c.sourceKey, 'magnet:pomo');
  assert.strictEqual(c.isEmbed, false);
  assert.strictEqual(c._ref, WORK);
});

test('magnetSearch：ok→items；{ok:false,message}→errors[0].userMessage 逐字上浮（§7 不静默）', async () => {
  const ok = loadDs();
  const r1 = await ok.DS.magnetSearch({ kind: 'magnet', key: 'magnet:pomo', ref: RULE }, '阿嬷');
  assert.deepStrictEqual(r1.items.map((w) => w.key), [WORK.key]);
  assert.strictEqual(r1.errors, undefined);
  const bad = loadDs({ worksFail: true });
  const r2 = await bad.DS.magnetSearch({ kind: 'magnet', key: 'magnet:pomo', ref: RULE }, '阿嬷');
  assert.strictEqual(r2.items.length, 0);
  assert.strictEqual(r2.errors[0].userMessage, '站点无响应（404）。稍后再试或换一个规则。');
});

test('playCandidate：magnet 走版本选择器，不写 playbackSession（裁决⑨）', async () => {
  const { DS, modalCards } = loadDs();
  DS.playCandidate(MAG_CAND, { title: '给阿嬷的情书', pic: '', year: '' }, []);
  await flush();
  assert.strictEqual(modalCards.length, 1, '应弹出版本选择器');
  assert.strictEqual(DS.getPlaybackSession(), null, '磁力不得进跨源热切换会话（playCandidate 必须早退）');
});

test('版本选择器：两条版本→两次点击分别入队；成功跳 discover，重复只提示不重复入队', async () => {
  const t = loadDs();
  t.DS.playCandidate(MAG_CAND, { title: 'x' }, []);
  await flush();
  const rows = t.modalCards[0].querySelectorAll('.sfv-version-row');
  assert.strictEqual(rows.length, 2, 'fetchVersions 出两条版本');
  assert.ok(t.modalCards[0].querySelector('.sfv-version-size').textContent === '26.76GB');
  rows[0].dispatchEvent(new t.win.Event('click', { bubbles: true }));
  await flush();
  assert.strictEqual(t.submits.length, 1);
  assert.ok(t.submits[0].indexOf('magnet:?xt=urn:btih:') === 0, t.submits[0]);
  assert.deepStrictEqual(t.routes, ['focus:H1', 'discover']);
  assert.strictEqual(t.toasts.length, 0, '成功路径不新造文案（§7 未给成功文案 → 靠跳转反馈）');
});

test('版本选择器文案（§7 逐字）：0 条 / 入队失败 / 重复 / 规则已删', async () => {
  const empty = loadDs({ versions: [] });
  empty.DS.playCandidate(MAG_CAND, { title: 'x' }, []);
  await flush();
  assert.strictEqual(empty.modalCards[0].querySelector('.sfv-version-hint').textContent, '这个条目里没有可用磁力链接。');

  const dup = loadDs({ enqueueDup: true });
  dup.DS.playCandidate(MAG_CAND, { title: 'x' }, []);
  await flush();
  dup.modalCards[0].querySelector('.sfv-version-row').dispatchEvent(new dup.win.Event('click', { bubbles: true }));
  await flush();
  assert.ok(dup.toasts.indexOf('已在队列中。') >= 0, dup.toasts.join('|'));

  const gone = loadDs({ ruleGone: true });
  gone.DS.playCandidate(MAG_CAND, { title: 'x' }, []);
  await flush();
  assert.strictEqual(gone.toasts[gone.toasts.length - 1], '规则格式不符：缺少 id。未导入任何内容。',
    '规则被删：复用 §7 校验文案位，不新造第四种句式');

  const failQ = loadDs({ enqueueFail: true });
  failQ.DS.playCandidate(MAG_CAND, { title: 'x' }, []);
  await flush();
  failQ.modalCards[0].querySelector('.sfv-version-row').dispatchEvent(new failQ.win.Event('click', { bubbles: true }));
  await flush();
  assert.ok(failQ.toasts.indexOf('加入下载队列失败：磁盘已满') >= 0, failQ.toasts.join('|'));
});

test('hall.css 有版本选择器的四条 class 规则（渲染器不得产出无样式节点）', () => {
  const css = read('public/video/hall.css');
  ['sfv-version-title', 'sfv-version-row', 'sfv-version-name', 'sfv-version-size']
    .forEach((c) => assert.ok(css.indexOf('.' + c) >= 0, 'hall.css 缺少 .' + c));
});

test('缺席降级（依赖缺席只 toast、不抛）：无 openModal / 无 source / 无 enqueue 三条路径', async () => {
  const a = loadDs({ noModal: true });
  a.DS.playCandidate(MAG_CAND, { title: 'x' }, []);
  assert.deepStrictEqual(a.toasts, ['选择器未就绪']);
  assert.strictEqual(a.modalCards.length, 0, '无 openModal 不得造卡');

  const b = loadDs({ noSource: true });
  b.DS.playCandidate(MAG_CAND, { title: 'x' }, []);
  assert.deepStrictEqual(b.toasts, ['本地服务未就绪，无法抓取站点。'], '§7 逐字，不新造第四种句式');

  const c = loadDs({ noEnqueue: true });
  c.DS.playCandidate(MAG_CAND, { title: 'x' }, []);
  await flush();
  assert.strictEqual(c.modalCards.length, 1, '缺的是入队口，抓取与弹窗照常');
  c.modalCards[0].querySelector('.sfv-version-row').dispatchEvent(new c.win.Event('click', { bubbles: true }));
  assert.deepStrictEqual(c.toasts, ['加入下载队列失败：入队口未就绪']);
  assert.deepStrictEqual(c.submits, [], '缺席时不得假装已提交');
  assert.deepStrictEqual(c.routes, [], '缺席时不得跳转');
});

test('§6.4 迟到回调：点行后立刻关弹窗，submit 迟到 resolve 不再跳路由（入队不回滚）', async () => {
  let settle;
  const t = loadDs({ submitFn: () => new Promise((r) => { settle = r; }) });
  t.DS.playCandidate(MAG_CAND, { title: 'x' }, []);
  await flush();
  const card = t.modalCards[0];
  card.querySelector('.sfv-version-row').dispatchEvent(new t.win.Event('click', { bubbles: true }));
  // 点完立刻关窗：× 会 bump versionGen 并摘掉 card（backdrop / 路由切换同理让 card 脱离文档）
  card.querySelector('.sfv-version-close').dispatchEvent(new t.win.Event('click', { bubbles: true }));
  settle({ ok: true, hash: 'H1' });
  await flush();
  assert.strictEqual(t.submits.length, 1, '入队已经发生，不回滚');
  assert.deepStrictEqual(t.routes, [], '迟到回调不得把用户从当前页拽到 discover');
  assert.strictEqual(t.toasts.length, 0, '迟到也不弹「已在队列中」');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/detail-source-magnet-partition.test.js`
Expected: FAIL — `DS.collectSourceUnits is not a function`（导出面还没有这四个面）。

- [ ] **Step 3: `collectSourceUnits` 加 magnet 单元**

把现 `:529-533` 的

```js
    var kzRules = (SFV.kazumi && SFV.kazumi.getEnabledSearchRules) ? SFV.kazumi.getEnabledSearchRules() : [];
    kzRules.forEach(function (r) {
      units.push({ kind: 'kazumi', key: 'kazumi:' + r.name, sourceName: r.name, ref: r });
    });
    return units;
```

改成

```js
    var kzRules = (SFV.kazumi && SFV.kazumi.getEnabledSearchRules) ? SFV.kazumi.getEnabledSearchRules() : [];
    kzRules.forEach(function (r) {
      units.push({ kind: 'kazumi', key: 'kazumi:' + r.name, sourceName: r.name, ref: r });
    });
    // 磁力站点规则 = 独立分区（§5.1）：一条都没启用时这个 for 循环不进，分区根本不存在。
    var magRules = (SFV.huilianMagnetRules && SFV.huilianMagnetRules.getEnabled)
      ? SFV.huilianMagnetRules.getEnabled() : [];
    magRules.forEach(function (r) {
      units.push({ kind: 'magnet', key: 'magnet:' + r.id, sourceName: r.name, ref: r });
    });
    return units;
```

- [ ] **Step 4: 新增 `magnetSearch`（放 `queryOneUnit` 之前）**

```js
  /*
   * 磁力分区的单源搜索适配器：把 Task 4 的 {ok,value}|{ok:false,message}
   * 翻译成 queryOneUnit 认得的 {items,errors} 形状。
   * errors[0].userMessage 是 §7 已成形文案，由下方错误分支直接 toast（不静默）。
   */
  function magnetSearch(u, kw) {
    var src = SFV.huilianMagnetSource;
    if (!src || typeof src.fetchWorks !== 'function') {
      return Promise.resolve({ items: [], errors: [{ userMessage: '本地服务未就绪，无法抓取站点。' }] });
    }
    return Promise.resolve(src.fetchWorks(u.ref, kw)).then(function (res) {
      if (res && res.ok) return { items: (res.value || []) };
      return { items: [], errors: [{ userMessage: (res && res.message) || '站点无响应（未知错误）。稍后再试或换一个规则。' }] };
    });
  }
```

- [ ] **Step 5: `queryOneUnit` 加 magnet 分支**

把现 `:387-401` 的 `} else {`（Kazumi 分支头）改成三段：

```js
    } else if (u.kind === 'magnet') {
      p = magnetSearch(u, kw);
    } else {
      p = (SFV.kazumi && SFV.kazumi.searchRule)
```

（其余 Kazumi 代码一字不动。）

- [ ] **Step 6: 错误分支上浮 `userMessage`**

把现 `:426-429` 的

```js
      if (res && res.errors && res.errors.length) {
        if (SFV.sourcePicker && SFV.sourcePicker.setStatus) {
          SFV.sourcePicker.setStatus(u.key, 'error');
        }
```

改成

```js
      if (res && res.errors && res.errors.length) {
        // §7：抓取类错误必须把成形文案送到提示条。只有磁力适配器带 userMessage，
        // CMS/Kazumi 的 errors[] 没这个字段 → 行为不变（不会给旧两支路凭空加 toast）。
        var em = res.errors[0] && res.errors[0].userMessage;
        if (em) toast(em);
        if (SFV.sourcePicker && SFV.sourcePicker.setStatus) {
          SFV.sourcePicker.setStatus(u.key, 'error');
        }
```

- [ ] **Step 7: `normalizeUnitItems` 加 magnet 归一**

把现 `:556-557` 的 `} else {` + `var c2 = {` 之前插 magnet 分支：

```js
      } else if (u.kind === 'magnet') {
        // 一行 = 一个**作品**（不是一个版本，§5.3）。此刻没抓详情，所以版本数/体积区间未知，
        // sub 只能用搜索页给的字段（裁决②）；点开后再给区间。
        var c3 = {
          id: 'magnet:' + (it.ruleId || '') + ':' + encodeURIComponent(it.key || ''),
          label: it.title || (view && view.title) || '',
          sub: [it.altTitle, it.year].filter(Boolean).join(' · '),
          title: it.title || (view && view.title) || '',
          kind: 'magnet', group: (it.sourceName || u.sourceName || '磁力站点'),
          sourceName: (it.sourceName || u.sourceName || ''),
          isEmbed: false, _ref: it, sourceKey: u.key
        };
        out.push(c3);
      } else {
        var c2 = {
```

- [ ] **Step 8: `playCandidate` magnet 早退 + `onPick` 跳过会话**

`playCandidate`（现 `:577-580`）开头改成：

```js
  function playCandidate(c, view, sections) {
    if (!c) return;
    // 裁决⑨：磁力候选不是「一条可播放的片源」，而是「一次入队动作」→
    // 既不能写 playbackSession（播放器选源面板会出现切不动的条目），也不走解析线路。
    if (c.kind === 'magnet') { openVersionPicker(c, view); return; }
    // 首次选源：建立会话。currentKey 用唯一 id，避免同源多命中一起高亮。
```

`onPick`（现 `:358-361`）改成：

```js
        onPick: function (c) {
          // magnet 不建会话（同 playCandidate 的裁决⑨）；其余分支行为不变
          if (!(c && c.kind === 'magnet')) beginPlaybackSession(view, candidates, candKeyOf(c));
          playCandidate(c, view, sections);
        }
```

- [ ] **Step 9: 新增 `openVersionPicker`（放 `playCandidate` 之前）**

```js
  /*
   * §5.4：点开磁力作品 = 弹版本选择 → 选定一条 = 选定一个 btih → 入队 → 跳汇联页 →
   * 由既有轮询认领并起播。不做 toast 占位、不跳站外。
   * 模态复用 source-picker 的 openModal（§5.7，Task 5 导出）；抓取复用 fetchVersions
   * （§5.8，与汇联页同缓存、同并发上限 2）。
   */
  var versionGen = 0;   // 在途作废：关弹窗/连点两次时旧回调不得再写新弹窗

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function goHuilian(hash) {
    // focusTask 是「一次性闩」：先落闩再跳路由，汇联页 mount 后首次渲染据此高亮定位该任务行
    if (SFV.huilianEnqueue && SFV.huilianEnqueue.focusTask) SFV.huilianEnqueue.focusTask(hash);
    if (SFV.router && SFV.router.go) SFV.router.go('discover');
  }

  function enqueueVersion(v, card) {
    var q = SFV.huilianEnqueue;
    if (!q || typeof q.submit !== 'function') { toast('加入下载队列失败：入队口未就绪'); return; }
    var myGen = versionGen;   // §6.4：点行后弹窗被关/被换 = 迟到回调不得再产生跳转副作用
    Promise.resolve(q.submit(v.magnet)).then(function (res) {
      if (!res || !res.ok) {
        toast('加入下载队列失败：' + ((res && res.error) || '未知原因'));   // §7：失败照报，与弹窗存活无关
        return;
      }
      // 入队已经发生（不回滚），但用户已离开这个弹窗 → 不跳路由、不弹「已在队列中」
      if (myGen !== versionGen || (card && !card.isConnected)) return;
      if (res.duplicated) toast('已在队列中。');                            // §7：不重复入队
      goHuilian(res.hash);
    }, function (e) {
      toast('加入下载队列失败：' + (e && e.message ? e.message : '未知原因'));
    });
  }

  function openVersionPicker(c, view) {
    var picker = SFV.sourcePicker;
    if (!picker || typeof picker.openModal !== 'function') { toast('选择器未就绪'); return; }
    var src = SFV.huilianMagnetSource;
    if (!src || typeof src.fetchVersions !== 'function') { toast('本地服务未就绪，无法抓取站点。'); return; }
    var work = c._ref || null;
    var rule = (SFV.huilianMagnetRules && SFV.huilianMagnetRules.get && work)
      ? SFV.huilianMagnetRules.get(work.ruleId) : null;
    // 规则被删/停用（弹窗还开着）→ 借用 §7 的校验文案位，不新造第四种句式
    if (!rule) { toast(ruleMissingCopy('id')); return; }
    var myGen = ++versionGen;
    picker.openModal(function (card, done) {
      card.appendChild(el('div', 'sfv-version-title', c.label || (view && view.title) || ''));
      var body = el('div', 'sfv-version-body');
      body.appendChild(el('div', 'sfv-version-hint', '读取版本…'));   // §7
      card.appendChild(body);
      var x = el('button', 'sfv-version-close', '×');
      x.setAttribute('type', 'button');
      x.addEventListener('click', function () { versionGen++; done(); });
      card.appendChild(x);
      src.fetchVersions(rule, work).then(function (res) {
        if (myGen !== versionGen) return;          // 陈旧回调整段丢弃
        clearNode(body);
        if (!res || !res.ok) {
          body.appendChild(el('div', 'sfv-version-hint', res && res.message ? res.message : '站点无响应（未知错误）。稍后再试或换一个规则。'));
          return;
        }
        var vs = res.value || [];
        if (!vs.length) {
          body.appendChild(el('div', 'sfv-version-hint', '这个条目里没有可用磁力链接。'));   // §7
          return;
        }
        // 卡头区间：这里已经拿到全部版本，才给得出「N 个版本 · 体积区间」（§5.3 的文案落在点开之后）
        card.insertBefore(
          el('div', 'sfv-version-sub', versionSummary(vs)),
          body
        );
        vs.forEach(function (v) {
          var row = el('button', 'sfv-version-row');
          row.setAttribute('type', 'button');
          row.appendChild(el('span', 'sfv-version-name', v.name || ''));
          row.appendChild(el('span', 'sfv-version-size', v.size ? v.size.text : ''));
          row.addEventListener('click', function () { enqueueVersion(v, card); });
          body.appendChild(row);
        });
      });
    });
  }
```

上面用到两个小助手（一并放在同一区块，都是纯格式化，不外泄到别的模块）：

```js
  // §7 缺字段文案位：与 rules.formatValidateError 同句式（{field} 由调用方给）
  function ruleMissingCopy(field) {
    var r = SFV.huilianMagnetRules;
    if (r && typeof r.formatValidateError === 'function') {
      return r.formatValidateError({ ok: false, field: field, kind: 'missing' });
    }
    return '规则格式不符：缺少 ' + field + '。未导入任何内容。';
  }

  // 卡头摘要：`N 个版本 · 最小–最大`；体积缺失的条目不参与区间
  function versionSummary(vs) {
    var en = SFV.huilianMagnetEnrich;
    var bytes = vs.map(function (v) { return v && v.size ? v.size.bytes : 0; }).filter(function (n) { return n > 0; });
    var n = vs.length + ' 个版本';
    if (!bytes.length || !en || typeof en.formatSize !== 'function') return n;
    var lo = Math.min.apply(null, bytes), hi = Math.max.apply(null, bytes);
    return n + ' · ' + (lo === hi ? en.formatSize(lo) : en.formatSize(lo) + '–' + en.formatSize(hi));
  }
```

- [ ] **Step 10: 导出面**

`:1030` 的 `candKeyOf: candKeyOf` 之后加四行（沿用本文件「内部函数直接挂面」的既有风格）：

```js
    candKeyOf: candKeyOf,
    collectSourceUnits: collectSourceUnits,
    normalizeUnitItems: normalizeUnitItems,
    magnetSearch: magnetSearch,
    openVersionPicker: openVersionPicker,
```

- [ ] **Step 11: `hall.css` 版本选择器样式**

在现 `.sfv-picker-modal` 带（`public/video/hall.css:400` 附近，搜 `.sfv-picker-modal-title`）之后加：

```css
.sfv-version-title { font-size: 14px; font-weight: 700; color: #fff; margin-bottom: 8px; padding-right: 26px; }
.sfv-version-sub { font-size: 12px; color: rgba(255,255,255,.58); margin: -4px 0 8px; }
.sfv-version-hint { font-size: 12px; color: rgba(255,255,255,.58); padding: 6px 0; }
.sfv-version-close { position: absolute; top: 8px; right: 8px; border: none; background: transparent; color: rgba(255,255,255,.6); font-size: 18px; line-height: 1; cursor: pointer; }
.sfv-version-row { display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 8px 10px; margin-bottom: 4px; border: none; border-radius: 10px; background: rgba(255,255,255,.06); color: #fff; text-align: left; cursor: pointer; }
.sfv-version-row:hover { background: rgba(255,255,255,.12); }
.sfv-version-name { flex: 1 1 auto; min-width: 0; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sfv-version-size { flex: 0 0 auto; font-size: 12px; font-variant-numeric: tabular-nums; color: rgba(255,255,255,.66); }
```

`.sfv-version-close` 用绝对定位，要求 `.sfv-picker-modal` 已是定位上下文——实现前先 `grep -n -A6 '^\.sfv-picker-modal ' public/video/hall.css` 确认它有 `position`；没有就在本条规则里给 `.sfv-picker-modal` 补 `position: relative`（不新增第三套模态容器）。

- [ ] **Step 12: 跑测试确认全绿 + 既有回归**

Run: `node --test tests/detail-source-magnet-partition.test.js tests/huilian-queue.test.js tests/source-picker-magnet-row.test.js`
Expected: PASS，本任务 8 项 + 既有 5 + 4 项，0 fail。
真易错点：`clearNode` 必须是 `removeChild` 循环，不许写 `body.innerHTML = ''`（红线：渲染只走 `el()`/`createElement`，禁 `innerHTML` 拼外部文本；发布名是站点给的不可信输入）。

- [ ] **Step 13: 提交**

```bash
git add public/video/detail-source.js public/video/hall.css tests/detail-source-magnet-partition.test.js
git commit -m "feat: 汇联 磁力源 Task6 — 详情页磁力独立分区 + 版本选择入队走完整播链路"
```

### Task 7: 单一入队口 `SFV.huilianEnqueue` + 测试 harness 扩容 + 站点搜索挂载点

**背景（spec §4 一句话）**：「单一入队口：两条入口最终都汇到 `submitParams`（`huilian-page.js:236`），**不复制第二套入队代码**。」本任务把那一个口子做成可被详情页（Task 6 已消费 `SFV.huilianEnqueue.submit/focusTask`）与汇联页搜索区（Task 8）共同调用的导出面，并把 Task 8 组件的挂载槽与销毁接上。

**Files:**
- Modify: `tests/helpers/huilian-harness.js`（沙箱补 `URL`/`localStorage`；模块清单与 index.html 对齐；新增 `opts.magnetRules` / `opts.sfv`；返回 `sfv`）
- Modify: `public/video/huilian-page.js`（`submitParams` 返回 `{ok,error?}`；磁力快照 `lastTorrents`；`SFV.huilianEnqueue` 三个面；`.huilian-site-search` 容器 + `createSiteSearch` + unmount 销毁）
- Modify: `public/video/player.css`（只补 `.huilian-site-search` 一条：CSS 契约测要求「渲染树里出现的 huilian class 必须有规则」，容器与样式不得跨任务分家）
- Test: `tests/huilian-enqueue-mouth.test.js`

**Interfaces:**
- Consumes：Task 1 的 `SFV.huilianQueue.extractBtih`（重复入队判定，§9.5 全仓唯一 btih 实现）；Task 3 的 `SFV.huilianMagnetRules`（harness 里真实加载，Task 8/9 的 §7 文案测靠它）；Task 4 的 `SFV.huilianMagnetSource`（同上，本任务只保证「加载不炸」）。
- Produces（Task 6 已在消费、Task 8 继续消费）：
  - `SFV.huilianEnqueue.submit(magnet) -> Promise<{ok:boolean, hash?:string, duplicated?:boolean, error?:string}>`——合法磁力 `{ok:true, hash:''}`；命中队列快照 `{ok:true, duplicated:true, hash:'<qbt hash>'}`（并顺带 `focusTask`）；拒绝 `{ok:false, error:'…'}`。
  - `SFV.huilianEnqueue.hasBtih(magnet) -> string|null`（命中返回该任务 hash，未命中 `null`）。
  - `SFV.huilianEnqueue.focusTask(hash)`——一次性定位意图，下一次 `render()` 给对应行加 `huilian-task--focus` 后清空。
  - 页面在 mount 时对 `SFV.huilianSiteSearch.create({container, enqueue, showError, isStale})` 取值并保存返回的 `{destroy()}`；模块缺席时只留空容器（Task 8 之前页面功能不受影响）。

- [ ] **Step 1: 写失败测试 `tests/huilian-enqueue-mouth.test.js`**

一个 vm 跨 realm 的真坑（写在前头，别靠改断言绕过）：`huilian-page.js` 在沙箱里 created 的对象，其 `Object.prototype` 是**沙箱 realm** 的，`assert.deepStrictEqual` 会比原型而失败 → 对本文件返回的对象一律**逐字段断言**。（`makeAddParams` 的返回值不受此限，它内部已把原型对齐宿主。）

```js
'use strict';
/**
 * 汇联 磁力源 Task7 契约：单一入队口 SFV.huilianEnqueue（spec §4）+ 站点搜索挂载点生命周期。
 *   a) 合法磁力 → addTorrent 收到 {url:原串不加工}，返回 {ok:true,hash:''}，pending 行上屏；
 *   b) 非法输入 / 缺 btih → 不调桥（§9.5 拒绝入队）；
 *   c) 队列快照里同 btih 不同 tracker 顺序 → duplicated:true、不再 addTorrent、行加高亮 class；
 *   c2/c3) 定位意图的时序：必须活过 mount（详情页跳转前设的），又不得跨 unmount 残留；
 *   d) 高亮一次性（下一次 render 不带 class）；
 *   e) 无桥 → 桌面版文案逐字（沿用页面既有 hint）；
 *   f) 桥失败 → submitParams 把 error 上浮到返回值 + .huilian-error（旧代码静默 resolve）；
 *   g) mount 建 .huilian-site-search 并 create()（每代一个），unmount 调 destroy()，代次跨重挂翻转；
 *   h) huilian-page.js 行数上限（spec §3.2 的 350 行/文件约束——上一计划只在注释里自律，本次落测，
 *      门限按「接线可长、渲染不得长」定）。
 * 运行：node --test tests/huilian-enqueue-mouth.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadPage } = require('./helpers/huilian-harness');

const BTIH_A = 'a'.repeat(40);
const BTIH_B = 'b'.repeat(40);
// 入队串：tracker t1 在前（我们拼出来的顺序）
const MAG_A = 'magnet:?xt=urn:btih:' + BTIH_A + '&tr=' + encodeURIComponent('udp://t1.example:2710') + '&dn=' + encodeURIComponent('某片');
// qbt 回吐串：只带 t2、且 dn 在后（§5.5：整串不等，只有 btih 稳）
const MAG_A_QBT = 'magnet:?xt=urn:btih:' + BTIH_A + '&tr=' + encodeURIComponent('udp://t2.example:2710') + '&dn=' + encodeURIComponent('某片');
const MAG_B = 'magnet:?xt=urn:btih:' + BTIH_B;
const HASH_A = 'HASHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const flush = () => new Promise((r) => setImmediate(r));

/** 建一页但**不**挂载：桥与手动定时器已就位，供「跳转前先设状态、再 mount」的时序测用。 */
function preMount(opt) {
  const o = opt || {};
  const addCalls = [];
  const bridge = o.noBridge ? null : {
    download: {
      addTorrent: (p) => { addCalls.push(p); return Promise.resolve(o.addRes || { ok: true, data: { hash: '' } }); },
      list: () => Promise.resolve({ ok: true, data: { torrents: o.torrents || [] } }),
      files: () => Promise.resolve({ ok: true, data: [] }),
      delete: () => Promise.resolve({ ok: true, data: true }),
    },
  };
  const t = loadPage({ bridge, magnetRules: o.magnetRules, sfv: o.sfv });
  const timers = [];
  t.sandbox.setInterval = (fn) => { timers.push(fn); return timers.length; };
  t.sandbox.clearInterval = () => {};
  t.timers = timers;
  t.addCalls = addCalls;
  return t;
}

function mounted(opt) {
  const t = preMount(opt);
  t.page.mount(t.host);
  return t;
}

/** 一次轮询 tick：把队列快照喂进页面（认领 + lastTorrents + render）。 */
async function tick(t) { await t.timers[0](); await flush(); }

test('b1) 非法输入（非 magnet: 前缀）→ 不调桥，返回输入无效文案', async () => {
  const t = mounted();
  const r = await t.sfv.huilianEnqueue.submit('http://example.com/a.mkv');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, '输入无效：请粘贴 magnet: 链接或选择 .torrent 文件');
  assert.strictEqual(t.addCalls.length, 0);
});

test('b2) 有 magnet: 前缀但 btih 非法长度 → 不调桥，拒绝入队（§9.5）', async () => {
  const t = mounted();
  const r = await t.sfv.huilianEnqueue.submit('magnet:?xt=urn:btih:abc123');
  assert.strictEqual(r.ok, false);
  assert.ok(/btih/.test(r.error), r.error);
  assert.strictEqual(t.addCalls.length, 0);
});

test('a) 合法磁力 → addTorrent 收到原串 {url}，返回 {ok:true,hash:""}，pending 行上屏', async () => {
  const t = mounted();
  const r = await t.sfv.huilianEnqueue.submit(MAG_A);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.hash, '');
  assert.strictEqual(r.duplicated, undefined);
  assert.strictEqual(t.addCalls.length, 1);
  assert.strictEqual(t.addCalls[0].url, MAG_A, '入队必须提交原串（tracker 已由 enrich 拼好，页面不得二次加工）');
  assert.strictEqual(t.addCalls[0].fileBase64, undefined);
  assert.ok(t.doc.querySelector('.huilian-task'), '加入后应出现 pending 行');
});

test('e) 无桥 → 桌面版文案逐字（与页面 hint 同一句，不另造）', async () => {
  const d = loadPage({ bridge: null });
  d.page.mount(d.host);
  const r = await d.sfv.huilianEnqueue.submit(MAG_A);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'BT 播放需在 Stellaflix 桌面版中使用');
});

test('f) 桥返回 {ok:false,error} → 上浮到返回值并写进 .huilian-error（旧代码静默 resolve）', async () => {
  const t = mounted({ addRes: { ok: false, error: '磁盘已满' } });
  const r = await t.sfv.huilianEnqueue.submit(MAG_A);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, '磁盘已满');
  assert.strictEqual(t.doc.querySelector('.huilian-error').textContent, '磁盘已满');
});

test('c) 队列快照里同 btih（tracker 不同条不同序）→ duplicated、不再 addTorrent、行高亮', async () => {
  const t = mounted({
    torrents: [{ hash: HASH_A, name: '某片', state: 'downloading', progress: 0.5, dlspeed: 1, upspeed: 1, magnet_uri: MAG_A_QBT }],
  });
  await tick(t);
  const row = t.doc.querySelector('.huilian-task[data-hash="' + HASH_A + '"]');
  assert.ok(row, '前置：快照应渲染出带 hash 的任务行');
  assert.strictEqual(t.sfv.huilianEnqueue.hasBtih(MAG_A), HASH_A, 'btih 归一必须认 qbt 重建串');
  const r = await t.sfv.huilianEnqueue.submit(MAG_A);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.duplicated, true);
  assert.strictEqual(r.hash, HASH_A);
  assert.strictEqual(t.addCalls.length, 0, '重复入队绝不能再提交一次');
  assert.ok(t.doc.querySelector('.huilian-task--focus'), '重复入队应定位高亮该任务行（§5.5）');
});

test('c2) 跳转前设的定位意图必须活过 mount（Task 6 的真实时序：详情页 focusTask → router.go）', async () => {
  const t = preMount({
    torrents: [{ hash: HASH_A, name: '某片', state: 'downloading', progress: 0.5, dlspeed: 1, upspeed: 1, magnet_uri: MAG_A_QBT }],
  });
  t.sfv.huilianEnqueue.focusTask(HASH_A);
  t.page.mount(t.host);
  await tick(t);
  const hit = t.doc.querySelector('.huilian-task--focus');
  assert.ok(hit, '定位意图必须活过 mount：Task 6 的真实时序是先 focusTask 再 router.go 进本页');
  assert.strictEqual(hit.getAttribute('data-hash'), HASH_A);
});

test('c3) 未消费的定位意图不跨访问残留（unmount 清 latch）', async () => {
  const t = preMount({
    torrents: [{ hash: HASH_A, name: '某片', state: 'downloading', progress: 0.5, dlspeed: 1, upspeed: 1, magnet_uri: MAG_A_QBT }],
  });
  t.sfv.huilianEnqueue.focusTask('NO_SUCH_HASH'); // 快照里根本没有：谁都消费不掉
  t.page.mount(t.host);
  t.page.unmount();
  t.page.mount(t.host);
  await tick(t);
  assert.strictEqual(t.doc.querySelector('.huilian-task--focus'), null,
    '上一轮没消费掉的定位意图必须随 unmount 作废，否则下次进页面会高亮错行');
});

test('d) 高亮是一次性的：下一次 render 不再带 .huilian-task--focus', async () => {
  const t = mounted({
    torrents: [{ hash: HASH_A, name: '某片', state: 'downloading', progress: 0.5, dlspeed: 1, upspeed: 1, magnet_uri: MAG_A_QBT }],
  });
  await tick(t);
  await t.sfv.huilianEnqueue.submit(MAG_A);
  assert.ok(t.doc.querySelector('.huilian-task--focus'), '前置：第一次应高亮');
  const r2 = await t.sfv.huilianEnqueue.submit(MAG_B);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(t.doc.querySelector('.huilian-task--focus'), null, '定位意图用完即弃，不得跨 render 残留');
});

test('g) mount 建 .huilian-site-search 并 create(挂载点)，unmount 调 destroy，isStale 跨挂载翻转', async () => {
  const created = [];
  let destroyed = 0;
  const t = mounted({
    sfv: {
      huilianSiteSearch: {
        create: (cfg) => {
          created.push(cfg);
          return { destroy: () => { destroyed += 1; }, _probe: true };
        },
      },
    },
  });
  assert.ok(t.doc.querySelector('.huilian-site-search'), '页面应给出站点搜索容器');
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].container.getAttribute('class'), 'huilian-site-search');
  assert.strictEqual(typeof created[0].enqueue, 'function');
  assert.strictEqual(typeof created[0].showError, 'function');
  assert.strictEqual(typeof created[0].isStale, 'function');
  assert.strictEqual(created[0].isStale(), false, '当次挂载内不该判陈旧');
  t.page.unmount();
  assert.strictEqual(destroyed, 1, 'unmount 必须销毁搜索区（生命周期红线）');
  assert.strictEqual(created[0].isStale(), false,
    'isStale 只看挂载代次，而 unmount 不递增代次（与播控条同一语义）→ 卸载靠的是 destroy，不是 isStale');
  t.page.mount(t.host);
  assert.strictEqual(created.length, 2, '重挂应再 create 一次：每代一个组件');
  assert.strictEqual(created[0].isStale(), true, '代次已翻转，旧组件的在途回调该被丢弃');
  assert.strictEqual(t.doc.querySelectorAll('.huilian-site-search').length, 1, '重挂不得叠加容器');
  t.page.unmount();
  assert.strictEqual(destroyed, 2, '第二次挂载的组件同样要销干净');
});

test('g2) 站点搜索模块缺席（Task 8 之前）→ 只留空容器，页面不炸、入队口仍可用', async () => {
  const t = mounted();
  assert.ok(t.doc.querySelector('.huilian-site-search'));
  const r = await t.sfv.huilianEnqueue.submit(MAG_A);
  assert.strictEqual(r.ok, true);
});

test('h) huilian-page.js 行数 ≤ 480（本文件只留接线，渲染一律放 site-search）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'video', 'huilian-page.js'), 'utf8');
  const lines = src.split('\n').length;
  // 480 = 既有 348 + 本任务的入队口（spec §4 明确要它落在这个文件，不能再往别处推）。
  // 真正的约束不是行数是「渲染不留在此」：Task 8 之后任何新增 DOM 构造都该进 huilian-site-search.js。
  assert.ok(lines <= 480, 'huilian-page.js 已 ' + lines + ' 行：新增渲染逻辑请放 huilian-site-search.js（spec §3.2）');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/huilian-enqueue-mouth.test.js`
Expected: FAIL — 前两例即红：`Cannot read properties of undefined (reading 'submit')`（`SFV.huilianEnqueue` 还不存在），且 harness 尚无 `magnetRules`/`sfv` 两个 option（若先炸在这里，属预期，Step 3 补）。

- [ ] **Step 3: 扩 `tests/helpers/huilian-harness.js`**

四处小改，全部加法，既有 `loadPage({bridge})` 调用方（Task2/3/7/8 的汇联测）零改动仍通过。

4a) 顶部文档注释里这两行

```js
 * 沙箱按 index.html 顺序先加载真实 huilian-queue.js + huilian-player-bar.js 再加载 huilian-page.js
 * （页面接线走真实现，非 mock）；
```

改成

```js
 * 沙箱按 index.html 的真实顺序加载：huilian-queue → huilian-magnet-enrich → huilian-magnet-rules
 *   → huilian-magnet-source → huilian-player-bar → huilian-page（页面接线走真实现，非 mock）；
 *   磁力三模块的加载本步只要求「不炸」，Task 8/9 的文案测靠 sfv/magnetRules 两个 option 驱动它们；
```

4b) 沙箱构造：`URL` 与 `localStorage` 都得手给。`URL` 是 Web API 不是 ECMAScript 内建，vm 裸上下文里没有 → `huilian-magnet-rules.js` 的 `hostOf` 会静默返回 `''`，校验永远「origin 不合法」，这是最难查的一类假失败；`localStorage` 同理。

把

```js
  const sandbox = {
    console, Math, Number, Array, Object, String, Boolean, Promise, Set, Map, JSON, Date,
    setTimeout, clearTimeout, setInterval, clearInterval, RegExp, Error,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
```

改成

```js
  const sandbox = {
    console, Math, Number, Array, Object, String, Boolean, Promise, Set, Map, JSON, Date,
    setTimeout, clearTimeout, setInterval, clearInterval, RegExp, Error,
    // URL 不是 ECMAScript 内建（vm 裸上下文没有），必须注入：规则的 hostOf 靠它校验 origin
    URL: require('url').URL,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  // localStorage 桩（真 DOM 语义：值一律字符串化，缺键返回 null 而非 undefined）
  const storage = new Map();
  sandbox.localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => { storage.set(String(k), String(v)); },
    removeItem: (k) => { storage.delete(String(k)); },
    clear: () => storage.clear(),
    key: (i) => Array.from(storage.keys())[i] === undefined ? null : Array.from(storage.keys())[i],
  };
  Object.defineProperty(sandbox.localStorage, 'length', { get: () => storage.size });
```

4c) 规则种子 + 组件桩：接在 `sandbox.StellaflixVideo = { ... };` 赋值块之后、`if (opts.bridge)` 之前

```js
  // 磁力规则直接写进存储（键与 huilian-magnet-rules.js 的 STORAGE_KEY 同值；两处若漂移 Task3 的测会先红）
  if (Array.isArray(opts.magnetRules) && opts.magnetRules.length) {
    storage.set('stellaflix-video-huilian-magnet-rules', JSON.stringify(opts.magnetRules));
  }
  // 组件桩（Task7：SFV.huilianSiteSearch 的 create/destroy 计数；Task8 起可不传，走真实现）
  if (opts.sfv && typeof opts.sfv === 'object') Object.assign(sandbox.StellaflixVideo, opts.sfv);
```

4d) 模块清单：把现文件里这五行（`// 浏览器中 index.html 的加载顺序…` 注释两行 + 三条 `vm.runInContext`，`huilian-page.js` 那条在后）

```js
  // 浏览器中 index.html 的加载顺序：huilian-queue.js → huilian-player-bar.js → huilian-page.js；
  // 测试同样先注入真实模块（非 mock），让页面接线走真实现。
  vm.runInContext(read('public/video/huilian-queue.js'), sandbox, { filename: 'huilian-queue.js' });
  vm.runInContext(read('public/video/huilian-player-bar.js'), sandbox, { filename: 'huilian-player-bar.js' });
  vm.runInContext(read('public/video/huilian-page.js'), sandbox, { filename: 'huilian-page.js' });
```

换成

```js
  // 与 index.html 的真实加载顺序一致（Task5 注册后）：数据层三件在前，播控条与页面在后
  [
    'public/video/huilian-queue.js',
    'public/video/huilian-magnet-enrich.js',
    'public/video/huilian-magnet-rules.js',
    'public/video/huilian-magnet-source.js',
    'public/video/huilian-player-bar.js',
    'public/video/huilian-page.js',
  ].forEach((p) => vm.runInContext(read(p), sandbox, { filename: path.basename(p) }));
```

并把 `loadPage` 末尾的返回块

```js
  return {
    page, registrations, uiCalls, host, doc: sandbox.document, sandbox, events,
    bridge: sandbox.stellaflixVideo || null,
  };
```

改成（`sfv` 供测试取 `huilianEnqueue`/`huilianSiteSearch`，`storage` 供 Task9 直接改规则存储而不用等 UI 写盘）

```js
  return {
    page, registrations, uiCalls, host, doc: sandbox.document, sandbox, events,
    bridge: sandbox.stellaflixVideo || null,
    sfv: sandbox.StellaflixVideo, storage,
  };
```

- [ ] **Step 4: `huilian-page.js` —— 状态位与快照**

在 `  var bar = null;           // 当前播控条实例（SFV.huilianPlayerBar.create 返回），至多一个 overlay` 之后加三行状态：

```js
  var lastTorrents = [];    // 最近一次 download.list 的裸快照（§5.5 重复入队判定按 btih 比它，不靠整串相等）
  var focusHash = null;     // 一次性定位意图：入队命中重复 → 下一次 render 高亮该行后清空
  var searchWidget = null;  // 站点搜索区组件句柄（SFV.huilianSiteSearch.create 返回），至多一个
```

**注意锚点重名**：`nodes = null; tasks = []; pending = null;` 这一行在 `mount` 与 `unmount` 里**逐字相同**，且两处的下一行 `pollInFlight = false; expanded = null;` 也相同 → 必须带上下文各取一处，两处的新内容不一样（mount 不清 `focusHash`，unmount 不清 `searchWidget`）。写错一处的症状很隐蔽：从详情页 `focusTask` 后跳过来，`mount` 把定位意图抹掉，任务行永远不高亮。

4a) `mount` 内（锚点含 `mountGen += 1;`）

```js
    mountGen += 1;
    nodes = null; tasks = []; pending = null;
    pollInFlight = false; expanded = null;
```

改成

```js
    mountGen += 1;
    // 重挂只清「上一轮的渲染态」：focusHash 不清——它是跳转前由详情页设下的定位意图，正等着本次 render 消费
    nodes = null; tasks = []; pending = null;
    lastTorrents = []; searchWidget = null;
    pollInFlight = false; expanded = null;
```

4b) `unmount` 内（锚点含 `destroyBar();` 与其上的红线注释）

```js
    // 生命周期红线：离开汇联页必先销毁 overlay（任务保留，仅杀画面；不删任务）
    destroyBar();
    nodes = null; tasks = []; pending = null;
    pollInFlight = false; expanded = null;
```

改成

```js
    // 生命周期红线：离开汇联页必先销毁 overlay（任务保留，仅杀画面；不删任务）
    destroyBar();
    // 站点搜索区随页面卸载：其抓取在途回调由 isStale(mountGen) 自行作废，这里只断 DOM 与订阅
    if (searchWidget) {
      var w = searchWidget;
      searchWidget = null;
      if (typeof w.destroy === 'function') w.destroy();
    }
    nodes = null; tasks = []; pending = null;
    lastTorrents = []; focusHash = null; // 未消费的定位意图到这儿就作废：跨访问残留会高亮错行
    pollInFlight = false; expanded = null;
```

- [ ] **Step 5: `pollOnce` 落地快照 + `render` 高亮**

`pollOnce` 里

```js
      tasks = q ? q.reduceTasks(torrents) : [];
```

改成

```js
      lastTorrents = torrents; // 先存裸快照：hasBtih 要看到原始 url/magnet_uri，reduceTasks 的视图行不带它们
      tasks = q ? q.reduceTasks(torrents) : [];
```

`render()` 末尾的

```js
    if (expanded && expanded.files) {
      openFiles(findRowNode(expanded.hash), expanded.files, expanded.hash);
    }
  }
```

改成

```js
    if (expanded && expanded.files) {
      openFiles(findRowNode(expanded.hash), expanded.files, expanded.hash);
    }
    // 重复入队定位：命中才消费掉 focusHash（未命中留着，等下一次轮询把该行进快照再高亮）
    if (focusHash) {
      var target = findRowNode(focusHash);
      if (target) {
        target.setAttribute('class', (target.getAttribute('class') || 'huilian-task') + ' huilian-task--focus');
        focusHash = null;
      }
    }
  }
```

- [ ] **Step 6: `submitParams` 返回值上浮 + 入队口**

整个替换 `submitParams`（旧版失败时 `return` 掉进 `Promise.resolve(undefined)`，调用方无从判断成败）：

```js
  // ---- 加入任务（单一入队口：直链粘贴、.torrent、磁力站点三条入口都汇到这里，spec §4） ----
  function submitParams(params) {
    var b = bridge();
    if (!b || !params) return Promise.resolve({ ok: false, error: '本地服务未就绪，无法加入任务。' });
    return b.download.addTorrent(params).then(function (res) {
      if (!res || !res.ok) {
        var msg = (res && res.error) || '加入任务失败';
        fail(res, msg);
        return { ok: false, error: msg };
      }
      showError('');
      // 磁力分支：add 无返回 hash，置 pending 等轮询认领；torrent 分支：交给 list 直接出现
      if (params.url) pending = { magnet: params.url };
      // 生命周期门禁：未挂载（详情页入口先入队、或请求在途时离开本页）不得起轮询 ——
      // 否则留下一个 2s 孤儿 interval，要等下次进出本页才自愈。mount() 有桥时本就调 ensurePolling()，
      // 且 focusHash 不在 mount 清掉，所以门禁不损失认领/高亮（Task7 评审实证）。
      if (nodes) { render(); ensurePolling(); }
      return { ok: true };
    }).catch(function (err) {
      var msg = (err && err.message) || String(err || '加入任务失败');
      showError(msg); // IPC reject 统一喂提示条（红线：不静默）
      return { ok: false, error: msg };
    });
  }
```

紧接其后加入队口（`onAdd` 与 `.torrent` 分支继续走 `submitParams`，零改动）：

```js
  /*
   * 重复入队判定（§5.5）：按归一 btih 比最近一次的 list 快照，不比对整条磁力串。
   * 症状防的是「入队成功但永不被认领」的反向问题——同一 btih 被提交两次。
   * 返回命中任务的 hash，未命中 null（快照里没有 = 允许提交；pending 行没有 hash 可比，不做假阳性）。
   */
  function hasBtih(magnet) {
    var q = queue();
    if (!q || typeof q.extractBtih !== 'function') return null;
    var key = q.extractBtih(magnet);
    if (!key) return null;
    for (var i = 0; i < lastTorrents.length; i++) {
      var t = lastTorrents[i];
      if (!t) continue;
      if (q.extractBtih(t.url) === key || q.extractBtih(t.magnet_uri) === key) return t.hash || null;
    }
    return null;
  }

  // 详情页/搜索区共用的定位入口（Task 6 在跳转前置它；本页面自己命中重复时也调）
  function focusTask(hash) {
    if (hash) focusHash = String(hash);
  }

  /*
   * SFV.huilianEnqueue.submit —— 全仓唯一入队通道（spec §4「不复制第二套入队代码」）。
   * 校验顺序即失败成本顺序：先看是不是能提交的形态（makeAddParams），再看有没有 btih（§9.5 硬闸），
   * 再看队列里是否已有同 btih（§5.5），最后才落桥。入队只提交磁力 URL 本身，
   * 不转发站点 Cookie/会话头/任何请求头（§9.3），tracker 已由 enrich 拼进 URL，这里一律不加工。
   */
  function submitMagnet(magnet) {
    var q = queue();
    var b = bridge();
    if (!b) return Promise.resolve({ ok: false, error: NON_DESKTOP_COPY });
    if (!q) return Promise.resolve({ ok: false, error: '队列模块未加载，请检查 video/huilian-queue.js' });
    var params = q.makeAddParams(magnet, null);
    if (!params || !params.url) return Promise.resolve({ ok: false, error: '输入无效：请粘贴 magnet: 链接或选择 .torrent 文件' });
    if (typeof q.extractBtih === 'function' && !q.extractBtih(params.url)) {
      return Promise.resolve({ ok: false, error: '磁力链接没有有效的 btih 哈希，已拒绝入队。' });
    }
    var dup = hasBtih(params.url);
    if (dup !== null) {
      focusTask(dup);
      if (nodes) render(); // 本页可见时立即高亮；从详情页跳转过来则由挂载后的首次 render 消费
      return Promise.resolve({ ok: true, duplicated: true, hash: dup });
    }
    return submitParams(params).then(function (res) {
      if (res && res.ok) return { ok: true, hash: '' };
      return { ok: false, error: (res && res.error) || '加入下载队列失败' };
    });
  }
```

`NON_DESKTOP_COPY` 顶部常量区加一行（与 `mount` 里 hint 的文案同一句，写两处就会漂）：

```js
  // 无桥（非桌面版）时页面 hint 与入队口共用同一句文案，避免两处各写一遍后走样
  var NON_DESKTOP_COPY = 'BT 播放需在 Stellaflix 桌面版中使用';
```

并把 `mount` 里的

```js
      hint.textContent = 'BT 播放需在 Stellaflix 桌面版中使用';
```

改成

```js
      hint.textContent = NON_DESKTOP_COPY;
```

- [ ] **Step 7: `huilian-page.js` —— 站点搜索挂载点**

`mount` 内 `var error = el('div', { cls: 'huilian-error' });` 之后加：

```js
    // §6.1 三层：搜索行/筛选条/结果区整体交给 huilian-site-search.js（本文件只管挂载与销毁，不掺渲染）
    var searchBox = el('div', { cls: 'huilian-site-search' });
```

`wrap.appendChild(row); wrap.appendChild(error); wrap.appendChild(playWrap); wrap.appendChild(list);` 改成

```js
    wrap.appendChild(row); wrap.appendChild(error); wrap.appendChild(searchBox);
    wrap.appendChild(playWrap); wrap.appendChild(list);
```

`createSiteSearch(searchBox);` 这一句**不要**放在 appendChild 段落里，放到 `mount` 末尾 `nodes = { … }` 赋值**之后**（Task7 评审 M-2）：`create()` 会把 `showError`/`enqueue` 交给组件，若此时 `nodes` 仍是 null，Task 8 在 create 期报的错会静默 no-op。

`mount` 之前加：

```js
  /*
   * 站点搜索区（Task 8 的 SFV.huilianSiteSearch）挂载点。模块缺席时只留空容器——
   * 本任务先落页面，Task 8 再落组件，中间状态下页面其余功能（粘贴入队/轮询/播放）不得受影响。
   */
  function createSiteSearch(container) {
    var mod = SFV.huilianSiteSearch;
    if (!mod || typeof mod.create !== 'function' || !container) return;
    var gen = mountGen;
    var widget = mod.create({
      container: container,
      bridge: bridge(),
      enqueue: function (magnet) { return submitMagnet(magnet); },
      showError: showError,
      // 与播控条同款红线（huilian-page.js 注释）：挂载代次失效 → 组件丢弃在途抓取回调
      isStale: function () { return gen !== mountGen; },
    });
    searchWidget = (widget && typeof widget.destroy === 'function') ? widget : null;
  }
```

- [ ] **Step 8: 在文件末尾导出面加 `SFV.huilianEnqueue`**

`var page = {` 之前加：

```js
  // 单一入队口对外暴露（Task 6 详情页版本选择、Task 8 汇联页搜索区都调它；不再另起 addTorrent 调用点）
  SFV.huilianEnqueue = {
    submit: submitMagnet,
    hasBtih: hasBtih,
    focusTask: focusTask,
  };
```

- [ ] **Step 9: `player.css` 补 `.huilian-site-search` 一条规则（容器与它的基础样式必须同批落）**

`tests/huilian-css-contract.test.js` 会遍历真实渲染树收集全部 `huilian-*` class，并逐个要求 `public/video/player.css` 里有对应规则。Step 7 一产出 `.huilian-site-search`，那条契约测当场红——实测在只改页面的情况下是 `101 tests / 1 fail`，唯一败因写着「player.css 缺少 .huilian-site-search 规则（渲染器会产出一个无样式的节点）」。所以**不要**把这条样式推给 Task 10：跨任务推样式会让 Task 7 的提交点上全量回归是红的。卡头/徽章/筛选条这些**卡片内部**的样式随 Task 8 的渲染器同批落（同一理由：渲染树一产出无样式节点，契约测当场败）；Task 10 只接手 <420px 的窄屏退化。

在 `public/video/player.css` 的

```css
.huilian-play-wrap { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
```

之前插入

```css
/* 磁力站点搜索区：Task 7 只给容器与段距；卡片内部样式随 Task 8 的渲染器落，窄屏退化在 Task 10 收口 */
.huilian-site-search { margin-top: 16px; display: flex; flex-direction: column; gap: 10px; }
```

同批再补**定位高亮**一条（Task 7 的 `render()` 在命中 `focusHash` 时给任务行挂 `.huilian-task--focus`；无规则则 §5.5 的重复入队/跳转高亮不可见。`tests/huilian-css-contract.test.js` 的驱动路径不覆盖该类名，所以这一步不会被契约测当场逼出来，必须手落）。注意**优先级**：`.huilian-task[data-hash]:hover`（0,3,0）会压过单类名（0,1,0），只写一条会让悬停时高亮消失，因此 `:hover` 态要一并给：

```css
/* 重复入队 / 详情页跳转的定位高亮：render 命中 focusHash 时挂上（一次性） */
.huilian-task--focus,
.huilian-task[data-hash].huilian-task--focus:hover {
  background: rgba(var(--fc-accent-rgb, 60,120,220), .18);
  border-color: rgba(var(--fc-accent-rgb, 60,120,220), .55);
  color: var(--fc-ink, #e8ecef);
}
```

Run: `node --test tests/huilian-css-contract.test.js`
Expected: PASS，4 tests，0 fail。这条断言的价值是把「渲染器产出无样式节点」变成当场失败，而不是等肉眼看见页面裸了。

- [ ] **Step 10: 跑新测确认全绿**

Run: `node --test tests/huilian-enqueue-mouth.test.js`
Expected: PASS，12 tests，0 fail。

两个真实易错点（别靠改断言绕过）：
1. `test('c')` 里 `hasBtih` 命中要求 `lastTorrents` 已被轮询填过——忘了 `await tick(t)` 会假绿在 `null !== HASH_A` 的分支上，所以断言写成 `assert.strictEqual(hasBtih(...), HASH_A)` 而不是 `!== null`。
2. `isStale` 与 `destroy` 是**两条独立的红线，不要混**：`mountGen` 只在 `mount` 递增，所以 `unmount` 之后 `isStale()` 仍是 `false`（`test('g')` 把这条钉死）。组件在途回调的真正护栏是「unmount 必调 destroy + 重挂代次翻转」两条一起；若把 `gen` 存成 `mountGen` 的活引用（`var gen = function(){return mountGen}`）而不是快照值，代次永不翻转，`test('g')` 的第三段会红。

- [ ] **Step 11: 回归既有汇联测（harness 改动不得咬到别人）**

Run: `node --test tests/huilian-queue.test.js tests/huilian-page.test.js tests/huilian-player-bar.test.js tests/huilian-css-contract.test.js`
Expected: 全绿（这四个文件是上一计划的汇联契约测，harness 扩容对它们是纯加法）。若某文件不在（名字以 `ls tests/huilian-*.test.js` 为准），照实跑存在的那些，逐个报数。

Run: `node --test tests/huilian-*.test.js`
Expected: 全绿，0 fail。（注意：`node --test` 传**目录**在本仓库会误收临时文件，一律显式列文件或用 `tests/run-all.js`。）

- [ ] **Step 12: 提交**

```bash
git add tests/helpers/huilian-harness.js public/video/huilian-page.js tests/huilian-enqueue-mouth.test.js
git commit -m "feat: 汇联 磁力源 Task7 — 单一入队口 huilianEnqueue + 站点搜索挂载点 + harness 扩容"
```

---

### Task 8: `huilian-site-search.js` — 搜索行 / 筛选条 / 作品横卡 / 就地展开

**Files:**
- Create: `public/video/huilian-site-search.js`
- Modify: `public/index.html`（`SFV_SCRIPTS`：`"video/huilian-magnet-source.js"` 与 `"video/huilian-player-bar.js"` 之间插一行）
- Modify: `tests/huilian-magnet-registration.test.js`（Task 5 写的「site-search 尚未注册」断言要翻面）
- Modify: `tests/helpers/huilian-harness.js`（模块清单加 `huilian-site-search.js`，让 CSS 契约测真走进组件渲染树）
- Modify: `public/video/player.css`（卡片内部样式整段落，与渲染器**同批提交**）
- Test: `tests/huilian-site-search.test.js`

**Interfaces:**
- Consumes：
  - Task 3 `SFV.huilianMagnetRules.getEnabled() -> rule[]`（组件每次搜索只读一次，并把规则按 `rule.id` 存进本次搜索的 `rulesById`，供 `fetchVersions(rule, work)` 回查）。
  - Task 4 `SFV.huilianMagnetSource.fetchWorks(rule, query)` / `fetchVersions(rule, work)`，**一律 resolve `{ok:true,value} | {ok:false,message}`，永不 reject**；`message` 已是 §7 逐字文案（`站点无响应（404）。稍后再试或换一个规则。` 等）→ 组件**原样上屏，不再拼第二套错误句**。
  - Task 2 `SFV.huilianMagnetEnrich.{applyFilter, sortVersions, splitConstantBadges, constantHeaderText, sizeRangeText, formatSize}`。`applyFilter(works, {subtitle,res,size,sort})` 的语义要求 `work.versions` **已是数组**才谈得上筛选（内部 `filterVersions(undefined)` 返回 `[]`，筛选态下作品会被整条筛掉）——这条决定了下面的自动展开必须先抓后筛，见 Step 3 的 `fetchAllVersions`。
  - Task 7 页面注入的 `cfg = {container, enqueue, showError, isStale}`。
- Produces：`SFV.huilianSiteSearch.create(cfg) -> {destroy(), search()}`；`SFV.huilianSiteSearch.PREVIEW_COUNT = 3`。

**裁决（`cfg.bridge` 本组件不读）**：抓取走渲染进程 → `/api/proxy` → node 侧（Task 4 的 `getText` 用 `KazumiHttpClient`），**不经 IPC 桥**；桥只决定「能不能入队」，而入队已经由 `cfg.enqueue` 承担（Task 7 的 `submitMagnet` 内部自判无桥并回 §7 桌面版文案）。所以页面照旧传 `bridge`，组件签名里有它但实现里不引用——不是漏接，是刻意不接，免得出现第二个「本地服务未就绪」判定口径。

**易错点（写在前头）**：
1. **先筛后抓会筛出空列表**。`applyFilter` 在筛选态丢弃 `versions` 为空的works，而未展开的作品 `versions === null`。所以「筛选生效 → 命中作品自动全展开」的实现必须是**先对所有作品抓版本、抓完再 render**，不能直接 `render()`。Step 3 的 `applyFilterChange` 就是为这条存在的。
2. **徽章行对齐**：`splitConstantBadges(versions)` 返回的 `rows[i]` 与入参数组**下标平行**。若先 `splitConstantBadges(work.versions)` 再 `sortVersions` 排序，行内徽章会串到别的版本上。正确顺序是**先排序后归约**（恒定值判定与顺序无关）。
3. **CSS 与渲染同批**（Task 7 Step 9 立的规矩）：harness 一加载本模块，`tests/huilian-css-contract.test.js` 的场景就会走 `create()` 并采到搜索行/筛选条/空态的全部 class。所以 Step 5 的 CSS 必须与 Step 3 的模块在**同一次提交**里，否则 Task 8 的提交点上全量回归当场红。
4. **禁用旧类名**：`tests/huilian-css-contract.test.js` 的 b) 段把 `huilian-card`、`huilian-card-title`、`huilian-empty`、`huilian-tab`、`huilian-title` 等列为**报废选择器**，命中即败。所以卡类一律 `huilian-work-*`，空态叫 `huilian-result-empty`，筛选钮叫 `huilian-filter-chip`。
5. **`applyFilter` 会把「还没抓过」伪造成「抓了是空」**（自查时真咬到，5 条测当场红）：`filterVersions(undefined)` 返回 `[]`，所以 `applyFilter` 出来的副本一律带数组 `versions`，`hasVersions()` 判真 → 点展开永不发起抓取，症状是「点开就是一条『这个条目里没有可用磁力链接。』」。修法见 Step 3 的 `visibleWorks()`：**未筛态走 `sortWorks`（只换数组不换对象，保留原对象身份与 `versions:null`），只有真在筛选时才走 `applyFilter`**——那条路径下所有 raw work 已经先抓过版本了（易错点 1），null 不再出现。

- [ ] **Step 1: 写失败测试 `tests/huilian-site-search.test.js`**

本测用**真 enrich + 真 rules + 假 source**：解析与筛选语义是 Task 2/3 的既有契约（那边已有测），本文件只管组件的渲染状态机、文案与时序。假 source 直接返回作品/版本对象，所以 `fetchVersions` 的调用次数就是「懒抓取 + 会话缓存」的可观测证据。

```js
'use strict';
/**
 * 汇联 磁力源 Task8 契约：SFV.huilianSiteSearch 组件（spec §6.1~§6.4、§7、§8 末行）。
 *   a) 无启用规则 → §7 逐字文案 + 搜索行置灰，但「规则」钮仍可点（那是导入入口）；
 *   b) 搜索出作品横卡：卡头 title/year/站点名 + 结果计数；展开前不预显版本行、不抓详情；
 *   c) 展开才抓版本，同 workKey 重复展开不再抓（组件侧 pending/versions 双缓存）；
 *   d) 折叠态只显前 PREVIEW_COUNT 条 + 「全部 N」，点后变「只看前 3」；
 *   e) 筛选（1080P）生效 → 先自动全展开再筛：无 1080P 版本的作品整条消失，命中作品直接是展开态；
 *   f) 详情解析 0 条磁力 → 「这个条目里没有可用磁力链接。」+ data-empty="1"；
 *   g) 入队三态：成功静默 / duplicated「已在队列中。」/ 失败「加入下载队列失败：{reason}」；
 *   h) isStale 翻转后落地 → 一律不渲染（挂载代次红线）；
 *   i) destroy() → 容器清空，之后的回调不复活 DOM；
 *   j) 多规则合并：一条 ok 一条 message → 仍渲染 ok 的作品；全败 → message 原样上屏（不拼第二套错误句）；
 *   k) 站点发布名是外部输入：含尖括号的名称不得变成元素（只走 textContent）。
 * 运行：node --test tests/huilian-site-search.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { after } = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const RULE = {
  id: 'fixture', name: '示例站', origin: 'https://example.test',
  searchURL: 'https://example.test/search.php?search={query}&pjax=1',
  workItemXPath: '//div[@class="work-card"]',
  workFields: {
    title: './/h2[@class="title"]',
    detailUrl: './/a[@class="detail-link"]',
  },
  magnetItemXPath: '//a[@class="magnet-link"]',
  magnetAttr: 'data-url',
  sizeXPath: 'following-sibling::span[@class="file-size"][1]/text()',
  trackers: ['udp://tracker.example.test:2710/announce'],
  importedAt: 1, enabled: true,
};

const gb = (n) => Math.round(n * 1024 * 1024 * 1024);
// 名字刻意带 2160p/1080p 与 中字，让真 enrich 产出可筛选的 res/subtitle 族
const VERSIONS_A = [
  ['阿嬷.2160p.WEB-DL.HDR.中字.x265-QuickIO', 26.76],
  ['阿嬷.2160p.WEB-DL.HDR.中字.x265-EDR-QuickIO', 18.3],
  ['阿嬷.2160p.WEB-DL.60帧率版本.中字.x265-QuickIO', 15.6],
  ['阿嬷.2160p.WEB-DL.HDR.国配.x265-QuickIO', 12.9],
  ['阿嬷.2160p.WEB-DL.HQ.中字.x265-QuickIO', 9.88],
];
const VERSIONS_B = [
  ['另一部.1080p.WEB-DL.中字.x264-QuickIO', 7.42],
  ['另一部.1080p.WEB-DL.60帧率版本.x264-EDR-QuickIO', 4.35],
];

const windows = [];

/**
 * 建一个 jsdom 环境：真 queue/enrich/rules/site-search + 假 source。
 * `runScripts:'outside-only'` 必须带——否则 win.eval 只是宿主 realm 的 eval，模块会挂到 Node 的
 * globalThis 上而不是 jsdom 的 window 上（Task4 实测静默失败）。
 * opt.rules：写进真实存储的规则数组（默认一条启用）；opt.source：替换假 source 的工厂。
 */
function buildEnv(opt) {
  const o = opt || {};
  const dom = new JSDOM('<!doctype html><html><body><div id="box"></div></body></html>',
    { url: RULE.origin + '/', runScripts: 'outside-only' });
  windows.push(dom.window);
  const win = dom.window;
  win.eval(read('public/video/huilian-queue.js'));
  win.eval(read('public/video/huilian-magnet-enrich.js'));
  win.eval(read('public/video/huilian-magnet-rules.js'));
  win.eval(read('public/video/huilian-site-search.js'));
  const SFV = win.StellaflixVideo;
  const en = SFV.huilianMagnetEnrich;

  (o.rules === undefined ? [RULE] : o.rules).forEach((r) => SFV.huilianMagnetRules.put(r));

  const made = { works: [], versionsCalls: [], worksCalls: [] };
  const mkWork = (id, title, altTitle, year) => ({
    key: 'https://example.test/work/' + id, ruleId: RULE.id, sourceName: RULE.name,
    title: title, altTitle: altTitle || '', year: year || '', poster: '', versions: null,
  });
  const mkVersions = (rows) => rows.map(([name, g], i) => ({
    rawMagnet: 'magnet:?xt=urn:btih:' + String(i).padStart(40, '0'),
    magnet: 'magnet:?xt=urn:btih:' + String(i).padStart(40, '0') + '&tr=' + encodeURIComponent('udp://tracker.example.test:2710/announce'),
    name: name, size: { text: g + 'GB', bytes: gb(g) }, allBadges: en.parseBadges(name),
  }));
  made.works = [mkWork('777', '给阿嬷的情书', 'Dear_Teena', '2026'), mkWork('778', '另一部片', 'Another', '2025')];
  const store = { 777: mkVersions(VERSIONS_A), 778: mkVersions(VERSIONS_B) };

  SFV.huilianMagnetSource = o.source
    ? o.source(made, store)
    : {
      MAX_CONCURRENCY: 2,
      fetchWorks: (rule, query) => { made.worksCalls.push(query); return Promise.resolve({ ok: true, value: made.works }); },
      fetchVersions: (rule, work) => {
        made.versionsCalls.push(work.key);
        const id = /work\/(\d+)$/.exec(work.key)[1];
        return Promise.resolve({ ok: true, value: store[id] || [] });
      },
    };

  const shown = [];
  const container = win.document.getElementById('box');
  let stale = false;
  const cfg = {
    container: container,
    bridge: null,
    enqueue: (magnet) => { shown.push(magnet); return o.enqueueRes ? Promise.resolve(o.enqueueRes) : Promise.resolve({ ok: true, hash: '' }); },
    showError: (msg) => { cfg._error = msg || ''; },
    isStale: () => stale,
    _error: '',
  };
  const widget = SFV.huilianSiteSearch.create(cfg);
  return {
    win, doc: win.document, container, cfg, widget, made, staleUp: () => { stale = true; },
    q: (sel) => container.querySelector(sel),
    all: (sel) => Array.from(container.querySelectorAll(sel)),
    text: (sel) => { const n = container.querySelector(sel); return n ? n.textContent : null; },
    flush: () => new Promise((r) => win.setTimeout(r, 0)),
  };
}
after(() => { for (const w of windows) w.close(); });

/** 搜索并等落地（fetchWorks → render）。 */
async function search(t, query) {
  if (query !== undefined) t.container.querySelector('.huilian-site-input').value = query;
  await t.widget.search();
  await t.flush();
}

test('a) 无启用规则：§7 逐字文案 + 搜索行置灰，「规则」钮不受影响', async () => {
  const t = buildEnv({ rules: [] });
  await search(t, '阿嬷');
  assert.strictEqual(t.text('.huilian-result-empty'),
    '未导入磁力站点规则。点搜索行的「规则」从远端一键导入。');
  assert.strictEqual(t.q('.huilian-site-input').disabled, true, '搜索行应置灰');
  assert.strictEqual(t.q('.huilian-site-go').disabled, true, '搜索行应置灰');
  assert.strictEqual(t.made.worksCalls.length, 0, '无规则不该发起抓取');
});

test('b) 搜索出作品横卡：卡头齐全、折叠态不预显版本行、结果计数上屏', async () => {
  const t = buildEnv();
  await search(t, '阿嬷');
  const cards = t.all('.huilian-work-card');
  assert.strictEqual(cards.length, 2);
  assert.strictEqual(t.text('.huilian-work-title'), '给阿嬷的情书 · 2026');
  assert.ok(t.text('.huilian-work-sub').indexOf('示例站') >= 0, '多规则合并后必须能看出作品来自哪个站点');
  assert.strictEqual(t.all('.huilian-version-row').length, 0, '折叠态不得预显版本行（§6.2）');
  assert.strictEqual(t.made.versionsCalls.length, 0, '搜索阶段不得抓详情（懒抓取，§6.4）');
  assert.strictEqual(t.text('.huilian-search-count'), '共 2 个作品');
});

test('c) 展开才抓版本；同 workKey 重复展开不再抓', async () => {
  const t = buildEnv();
  await search(t, '阿嬷');
  fire(t.q('.huilian-work-toggle'), 'click');
  await t.flush();
  assert.strictEqual(t.made.versionsCalls.length, 1);
  assert.ok(t.q('.huilian-version-row'), '展开后应出现版本行');
  // 收起再展开：versions 已在组件里，不再请求
  fire(t.q('.huilian-work-toggle'), 'click');
  await t.flush();
  fire(t.q('.huilian-work-toggle'), 'click');
  await t.flush();
  assert.strictEqual(t.made.versionsCalls.length, 1, '同 workKey 会话内只抓一次（§5.8）');
});

test('d) 折叠只显前 3 条 + 「全部 5」，点后变「只看前 3」', async () => {
  const t = buildEnv();
  await search(t, '阿嬷');
  fire(t.q('.huilian-work-toggle'), 'click');
  await t.flush();
  assert.strictEqual(t.all('.huilian-version-row').length, 3);
  assert.strictEqual(t.text('.huilian-version-more'), '全部 5');
  fire(t.q('.huilian-version-more'), 'click');
  assert.strictEqual(t.all('.huilian-version-row').length, 5);
  assert.strictEqual(t.text('.huilian-version-more'), '只看前 3');
});

test('e) 筛选生效 → 先自动全展开再筛：无 1080P 版本的作品整条消失，命中作品直接是展开态', async () => {
  const t = buildEnv();
  await search(t, '阿嬷');
  const chips = t.all('.huilian-filter-chip');
  const target = chips.filter((c) => c.textContent === '1080P')[0];
  assert.ok(target, '筛选条应给出 1080P 选项');
  fire(target, 'click');
  await t.flush();
  assert.strictEqual(t.made.versionsCalls.length, 2, '筛选生效即命中作品自动全展开（§6.4）');
  const cards = t.all('.huilian-work-card');
  assert.strictEqual(cards.length, 1, '作品 A 全是 2160P，应被整条筛掉');
  assert.strictEqual(cards[0].getAttribute('data-key'), 'https://example.test/work/778');
  assert.strictEqual(t.all('.huilian-version-row').length, 2, '命中作品应为展开态且只留 1080P 行');
  assert.strictEqual(target.getAttribute('data-on'), '1', '选中态用 data-on 表达，不靠 class 拼接');
});

test('f) 版本解析 0 条 → §7 逐字文案 + data-empty="1"', async () => {
  const t = buildEnv({
    source: (made) => ({
      MAX_CONCURRENCY: 2,
      fetchWorks: (r, q) => { made.worksCalls.push(q); return Promise.resolve({ ok: true, value: made.works }); },
      fetchVersions: (r, w) => { made.versionsCalls.push(w.key); return Promise.resolve({ ok: true, value: [] }); },
    }),
  });
  await search(t, '阿嬷');
  fire(t.q('.huilian-work-toggle'), 'click');
  await t.flush();
  const empty = t.q('.huilian-version-empty');
  assert.ok(empty, '应出现空磁力行');
  assert.strictEqual(empty.textContent, '这个条目里没有可用磁力链接。');
  assert.strictEqual(empty.getAttribute('data-empty'), '1');
});

test('g) 入队三态文案逐字：成功静默 / 重复「已在队列中。」/ 失败套 §7 模板', async () => {
  const ok = buildEnv();
  await search(ok, '阿嬷');
  fire(ok.q('.huilian-work-toggle'), 'click');
  await ok.flush();
  fire(ok.q('.huilian-version-row'), 'click');
  await ok.flush();
  assert.strictEqual(ok.cfg._error, '', '成功入队不得留下提示');
  assert.strictEqual(ok.made.worksCalls.length, 1);

  const dup = buildEnv({ enqueueRes: { ok: true, duplicated: true, hash: 'H' } });
  await search(dup, '阿嬷');
  fire(dup.q('.huilian-work-toggle'), 'click');
  await dup.flush();
  fire(dup.q('.huilian-version-row'), 'click');
  await dup.flush();
  assert.strictEqual(dup.cfg._error, '已在队列中。');

  const bad = buildEnv({ enqueueRes: { ok: false, error: 'qbt 拒绝：磁盘不足' } });
  await search(bad, '阿嬷');
  fire(bad.q('.huilian-work-toggle'), 'click');
  await bad.flush();
  fire(bad.q('.huilian-version-row'), 'click');
  await bad.flush();
  assert.strictEqual(bad.cfg._error, '加入下载队列失败：qbt 拒绝：磁盘不足');
});

test('h) isStale 翻转后落地 → 不渲染（挂载代次红线）', async () => {
  const t = buildEnv();
  await search(t, '阿嬷');
  fire(t.q('.huilian-work-toggle'), 'click');       // 抓取已在途，不 await
  t.staleUp();                                       // 页面重挂：代次翻转
  await t.flush();
  assert.strictEqual(t.all('.huilian-version-row').length, 0, '过期代次的回调不得画进本次 DOM');
});

test('i) destroy() 清空容器，之后的回调不复活', async () => {
  const t = buildEnv();
  await search(t, '阿嬷');
  fire(t.q('.huilian-work-toggle'), 'click');
  t.widget.destroy();
  assert.strictEqual(containerChildCount(t.container), 0, 'unmount 必须清空搜索区');
  await t.flush();
  assert.strictEqual(containerChildCount(t.container), 0, '销毁后的在途落地不得重建节点');
});

test('j) 多规则：一条 ok 一条 message → 仍渲染 ok；全败 → message 原样上屏', async () => {
  const partial = buildEnv({
    source: (made) => ({
      MAX_CONCURRENCY: 2,
      fetchWorks: (r, q) => Promise.resolve(r.id === RULE.id
        ? { ok: true, value: made.works }
        : { ok: false, message: '站点无响应（404）。稍后再试或换一个规则。' }),
      fetchVersions: (r, w) => Promise.resolve({ ok: true, value: [] }),
    }),
  });
  await search(partial, '阿嬷');
  assert.strictEqual(partial.all('.huilian-work-card').length, 2, '一条规则失败不该清空另一条的结果');

  const failed = buildEnv({
    source: () => ({
      fetchWorks: () => Promise.resolve({ ok: false, message: '站点无响应（超时）。稍后再试或换一个规则。' }),
      fetchVersions: () => Promise.resolve({ ok: true, value: [] }),
    }),
  });
  await search(failed, '阿嬷');
  assert.strictEqual(failed.text('.huilian-result-empty'),
    '站点无响应（超时）。稍后再试或换一个规则。', '§7 文案由 Task4 产出，组件不重拼错误句');
});
```

`fire` 与 `containerChildCount` 是本测自带的小工具（不依赖 harness 的 `fire`，因为本测在 jsdom 里跑，不是 vm 假 DOM），接在 `after(...)` 之前：

```js
function fire(node, type) {
  const ev = new node.ownerDocument.defaultView.Event(type, { bubbles: true });
  node.dispatchEvent(ev);
}
const containerChildCount = (node) => Array.from(node.children).length;
```

补测 k)（渲染红线）接在文件末尾：

```js
test('k) 站点发布名是外部输入：不得变成 DOM（只走 textContent）', async () => {
  const hostile = buildEnv({
    source: (made) => ({
      MAX_CONCURRENCY: 2,
      fetchWorks: () => Promise.resolve({ ok: true, value: made.works }),
      fetchVersions: () => Promise.resolve({
        ok: true,
        value: [{
          rawMagnet: 'magnet:?xt=urn:btih:' + 'f'.repeat(40),
          magnet: 'magnet:?xt=urn:btih:' + 'f'.repeat(40),
          name: '<img src=x onerror=alert(1)>中字.1080p.WEB-DL.x264-QuickIO',
          size: { text: '1GB', bytes: gb(1) },
          allBadges: [],
        }],
      }),
    }),
  });
  await search(hostile, '阿嬷');
  fire(hostile.q('.huilian-work-toggle'), 'click');
  await hostile.flush();
  const row = hostile.q('.huilian-version-row');
  assert.ok(row, '恶意名也要出行（不能静默丢版本）');
  assert.strictEqual(row.querySelector('img'), null, '名字里的 <img> 不得被解析成元素');
  assert.ok(row.textContent.indexOf('<img src=x onerror=alert(1)>') >= 0,
    '原文必须逐字可见，清洗只做在一侧');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/huilian-site-search.test.js`
Expected: FAIL —`Cannot read properties of undefined (reading 'create')`（`public/video/huilian-site-search.js` 还不存在，Step 3 才建）。

- [ ] **Step 3: 创建 `public/video/huilian-site-search.js`**

```js
/*
 * Stellaflix 影视模块 — 汇联页磁力站点搜索区（作品横卡 + 差异徽章 + 筛选条）
 * 依赖：SFV.huilianMagnetRules（启用规则）/ SFV.huilianMagnetSource（抓取与限流缓存）/
 *       SFV.huilianMagnetEnrich（筛选、排序、恒定值归约）；DOM 与入队/提示/代次由 cfg 注入。
 * 产出：SFV.huilianSiteSearch.create(cfg) -> {destroy(), search()}。
 * 红线：渲染只用 createElement + textContent（发布名是站点外部输入，禁止 innerHTML 拼接）；
 *       一切异步落地先过 isStale()；抓取只在「展开」与「筛选生效」时发生（§6.4 限流的前提）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var PREVIEW_COUNT = 3;                                     // §6.2 折叠态只显前 3 条
  var NO_RULE_COPY = '未导入磁力站点规则。点搜索行的「规则」从远端一键导入。';
  var DUPLICATED_COPY = '已在队列中。';
  var NO_MAGNET_COPY = '这个条目里没有可用磁力链接。';
  var LOADING_COPY = '读取版本…';
  var ADD_FAILED_PREFIX = '加入下载队列失败：';

  // §6.1 的取值一律写死，不留解释空间；v 是 enrich 认得的归一键，t 是按钮上的文案
  var FILTER_GROUPS = [
    { key: 'subtitle', label: '字幕', options: [
      { v: '中字', t: '中字' }, { v: '', t: '全部' }
    ] },
    { key: 'res', label: '分辨率', options: [
      { v: '2160P', t: '2160P' }, { v: '1080P', t: '1080P' }, { v: '', t: '全部' }
    ] },
    { key: 'size', label: '体积', options: [
      { v: 'lt5', t: '<5GB' }, { v: '5to15', t: '5–15GB' }, { v: 'gt15', t: '>15GB' }, { v: '', t: '全部' }
    ] },
    { key: 'sort', label: '排序', options: [
      { v: 'size-desc', t: '体积↓' }, { v: 'size-asc', t: '体积↑' }, { v: 'versions-desc', t: '版本数↓' }
    ] },
  ];
  var DEFAULT_SORT = 'size-desc';

  function enrich() { return SFV.huilianMagnetEnrich || null; }
  function rules() { return SFV.huilianMagnetRules || null; }
  function source() { return SFV.huilianMagnetSource || null; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.setAttribute('class', cls);
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function cleanInput(v) {
    return String(v === undefined || v === null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
  }

  function hasVersions(work) {
    return !!(work && Array.isArray(work.versions));
  }

  function badgeNode(b) {
    var n = el('span', 'huilian-badge huilian-badge--' + ((b && b.cls) || 'neutral'), b && b.label);
    return n;
  }

  function create(cfg) {
    cfg = cfg || {};
    var container = cfg.container;
    if (!container || typeof container.appendChild !== 'function') {
      return { destroy: function () {}, search: function () { return Promise.resolve(); } };
    }

    var destroyed = false;
    var works = [];                 // 本次搜索的原始作品数组（versions 就地填充，缓存靠它）
    var rulesById = {};             // 本次搜索用到的规则回查表：fetchVersions 要 rule 才能拼 URL
    var filter = { subtitle: '', res: '', size: '', sort: DEFAULT_SORT };
    var expanded = {};              // workKey -> true（§6.4 手风琴态）
    var shownAll = {};              // workKey -> true（「全部 N」二次展开态）
    var loading = {};               // workKey -> true（版本抓取在途）
    var inflight = {};              // workKey -> Promise（同 workKey 只抓一次）
    var lastQuery = '';
    var emptyCopy = '';             // 结果区空态文案的唯一来源（§7 三种空态互斥，不靠 render 反推）

    function isStale() {
      return destroyed || (typeof cfg.isStale === 'function' && cfg.isStale());
    }
    function say(msg) {
      if (typeof cfg.showError === 'function') cfg.showError(msg || '');
    }

    // ---- 静态骨架：搜索行 / 筛选条 / 结果区（§6.1 三层） ----
    var input = el('input', 'huilian-site-input');
    input.setAttribute('type', 'text');
    input.setAttribute('placeholder', '搜索磁力分享…');
    var goBtn = el('button', 'huilian-btn huilian-site-go', '搜索');
    var rulesBtn = el('button', 'huilian-btn huilian-rules-btn', '规则');
    // Task 9 才落规则面板；此刻没有承接方，置灰比「点了没反应」诚实
    rulesBtn.disabled = !SFV.huilianMagnetRulesUi;
    var count = el('div', 'huilian-search-count');
    var searchRow = el('div', 'huilian-search-row');
    searchRow.appendChild(input); searchRow.appendChild(goBtn);
    searchRow.appendChild(rulesBtn); searchRow.appendChild(count);

    var filterBar = el('div', 'huilian-filter-bar');
    var chipsByKey = {};
    for (var g = 0; g < FILTER_GROUPS.length; g++) {
      var group = FILTER_GROUPS[g];
      var groupBox = el('div', 'huilian-filter-group');
      groupBox.appendChild(el('span', 'huilian-filter-label', group.label));
      for (var oi = 0; oi < group.options.length; oi++) {
        (function (key, option) {
          var chip = el('button', 'huilian-filter-chip', option.t);
          chip.setAttribute('data-filter', key);
          chip.setAttribute('data-value', option.v);
          chip.addEventListener('click', function () { applyFilterChange(key, option.v); });
          (chipsByKey[key] = chipsByKey[key] || []).push(chip);
          groupBox.appendChild(chip);
        })(group.key, group.options[oi]);
      }
      filterBar.appendChild(groupBox);
    }

    var list = el('div', 'huilian-result-list');
    container.appendChild(searchRow);
    container.appendChild(filterBar);
    container.appendChild(list);

    goBtn.addEventListener('click', function () { search(); });
    input.addEventListener('keydown', function (ev) {
      if (ev && (ev.key === 'Enter' || ev.keyCode === 13)) search();
    });

    function enabledRules() {
      var r = rules();
      return (r && typeof r.getEnabled === 'function') ? (r.getEnabled() || []) : [];
    }
    function filtering() { return !!(filter.subtitle || filter.res || filter.size); }

    function syncChips() {
      for (var key in chipsByKey) {
        if (!Object.prototype.hasOwnProperty.call(chipsByKey, key)) continue;
        var arr = chipsByKey[key];
        for (var i = 0; i < arr.length; i++) {
          var on = String(arr[i].getAttribute('data-value')) === String(filter[key]);
          arr[i].setAttribute('data-on', on ? '1' : '0');
        }
      }
    }

    // ---- 搜索：遍历全部启用规则并合并（§5.1 分区出现条件 = 至少一条启用） ----
    // 返回值 = 「此刻有没有可用规则」，同时负责搜索行置灰（§7 无规则态）
    function gate() {
      var en = enabledRules();
      var on = en.length > 0;
      input.disabled = !on; goBtn.disabled = !on;
      return en;
    }

    function search() {
      if (isStale()) return Promise.resolve();
      var query = cleanInput(input.value);
      var en = gate();
      rulesById = {};
      for (var i = 0; i < en.length; i++) if (en[i]) rulesById[en[i].id] = en[i];
      works = []; lastQuery = query;
      resetOpenState();
      if (!en.length) {   // gate() 已把搜索行置灰落好，这里只定空态文案
        emptyCopy = NO_RULE_COPY;
        render();
        return Promise.resolve();
      }
      if (!query) { emptyCopy = ''; render(); return Promise.resolve(); }
      var src = source();
      if (!src || typeof src.fetchWorks !== 'function') {
        emptyCopy = '';
        say('磁力抓取模块未加载，请检查 video/huilian-magnet-source.js');
        return Promise.resolve();
      }
      emptyCopy = '';
      var jobs = [];
      for (var k = 0; k < en.length; k++) jobs.push(src.fetchWorks(en[k], query));
      return Promise.all(jobs).then(function (resList) {
        if (isStale()) return;
        var merged = [], firstError = '';
        for (var j = 0; j < resList.length; j++) {
          var res = resList[j];
          if (res && res.ok) merged = merged.concat(res.value || []);
          else if (!firstError) firstError = (res && res.message) || '';
        }
        // ⚠️ 必须逐个浅复制容器对象（Task8 评审 I-1）：source 层的 fetch* 把**同一个 array 引用**
        // 连同其中的 work 对象一起外泄（命中缓存也回同一对象）。`works = merged` 直接把缓存里的
        // 原对象接过来，随后 loadVersions 就地写 `work.versions` / `work.error` 就污染了 source 缓存 ——
        // 后果可证：抓版本失败留下的 error 会让「重新搜同一个词条」永久停在错误态
        // （下文 plan:4005 的「由下一轮搜索整批换新对象时才清」前提在缓存下不成立）。
        works = merged.map(function (w) {
          var copy = {};
          for (var k in w) if (hasOwnProperty.call(w, k)) copy[k] = w[k];
          return copy;
        });
        // 三种空态互斥（§7）：错误优先于「没找到」；有结果时错误也不能吞——交提示条
        if (merged.length) { emptyCopy = ''; say(firstError); }
        else emptyCopy = firstError || ('没找到与「' + query + '」匹配的分享。');
        render();
      }).catch(function (err) {
        if (isStale()) return;
        say(String((err && err.message) || err || '未知错误')); // 红线：reject 必须上浮，不静默
      });
    }

    function resetOpenState() {
      expanded = {}; shownAll = {}; loading = {}; inflight = {};
    }

    // ---- 版本抓取：展开或筛选生效时才发生（§6.4「首屏只抓搜索页」） ----
    function loadVersions(work) {
      if (!work || hasVersions(work) || work.error) return Promise.resolve();
      if (inflight[work.key]) return inflight[work.key];
      var src = source();
      var rule = rulesById[work.ruleId];
      if (!src || typeof src.fetchVersions !== 'function' || !rule) {
        work.versions = [];
        return Promise.resolve();
      }
      loading[work.key] = true;
      var p = Promise.resolve(src.fetchVersions(rule, work)).then(function (res) {
        delete loading[work.key];
        delete inflight[work.key];
        if (isStale()) return;
        if (res && res.ok) { work.versions = res.value || []; work.error = ''; }
        else { work.error = (res && res.message) || ''; } // 留 error 态：本组件不做隐式重试，重试入口是重新搜索（见下文「抓取失败不自动重试」）
      }).catch(function (err) {
        delete loading[work.key];
        delete inflight[work.key];
        if (isStale()) return;
        work.error = String((err && err.message) || err || '未知错误');
      });
      inflight[work.key] = p;
      return p;
    }

    function applyFilterChange(key, value) {
      var was = filtering();
      filter[key] = value;
      syncChips();
      if (filtering()) {
        // 先抓后筛（§6.4 + applyFilter 语义）：未展开的作品 versions 还是 null，直接筛会整条筛空
        var jobs = [];
        for (var i = 0; i < works.length; i++) {
          expanded[works[i].key] = true;   // 「筛选生效 → 命中作品自动全展开」
          jobs.push(loadVersions(works[i]));
        }
        Promise.all(jobs).then(function () { if (!isStale()) render(); });
        render();                          // 先出「读取版本…」骨架，不等全部落地
      } else if (was) {
        resetOpenState();                  // 清空筛选 → 回到手风琴态
        render();
      } else render();
    }

    // ---- 渲染 ----
    /*
     * 未筛只排序、有筛才走 applyFilter——这条不是省算力，是保身份：applyFilter 对每个作品做
     * `copyW.versions = filterVersions(w.versions, fl)`，而 `filterVersions(null)` 返回 `[]`，
     * 于是「还没抓过版本」的 null 被伪造成空数组，展开时 `hasVersions()` 判真 → 永不发起抓取，
     * 页面表现为「点开就是一条『这个条目里没有可用磁力链接。』」。sortWorks 只切数组不换对象，
     * 未筛态保留原对象身份，versions 的缓存才能落在真正活得久的那个对象上。
     */
    function visibleWorks() {
      var en = enrich();
      if (!en) return works.slice();
      if (!filtering()) return en.sortWorks(works, filter.sort);
      return en.applyFilter(works, filter);
    }

    function cardSub(work) {
      var en = enrich();
      var parts = [];
      if (work.altTitle) parts.push(work.altTitle);
      parts.push(work.sourceName || '磁力站点');
      if (hasVersions(work)) {
        parts.push(work.versions.length + ' 个版本');
        if (en && en.sizeRangeText) {
          var range = en.sizeRangeText(work.versions);
          if (range) parts.push(range);
        }
      }
      return parts.join(' · ');
    }

    function makeCard(work) {
      var en = enrich();
      var isOpen = !!expanded[work.key];
      var card = el('div', 'huilian-work-card');
      card.setAttribute('data-key', work.key);

      var head = el('div', 'huilian-work-head');
      if (work.poster) {
        var img = el('img', 'huilian-work-poster');
        img.setAttribute('src', work.poster);
        img.setAttribute('alt', '');
        // 海报直链在应用内可能被 CSP/混合内容拦（§10 待真机）：取不到就退回纯文字块，不重排
        img.addEventListener('error', function () {
          if (img.parentNode) img.parentNode.replaceChild(el('div', 'huilian-work-poster-none'), img);
        });
        head.appendChild(img);
      } else head.appendChild(el('div', 'huilian-work-poster-none'));

      var info = el('div', 'huilian-work-info');
      info.appendChild(el('div', 'huilian-work-title',
        (work.title || '未命名作品') + (work.year ? ' · ' + work.year : '')));
      info.appendChild(el('div', 'huilian-work-sub', cardSub(work)));
      if (isOpen && hasVersions(work) && work.versions.length && en && en.splitConstantBadges) {
        var split = en.splitConstantBadges(sortVersions(work.versions));
        var headerText = en.constantHeaderText ? en.constantHeaderText(split.constant) : '';
        if (headerText) info.appendChild(el('div', 'huilian-work-badges', headerText));
      }
      head.appendChild(info);

      var toggle = el('button', 'huilian-work-toggle', isOpen ? '收起 ▴' : '展开 ▾');
      toggle.setAttribute('data-expanded', isOpen ? '1' : '0');
      toggle.addEventListener('click', function () { toggleWork(work); });
      head.appendChild(toggle);
      card.appendChild(head);
      if (isOpen) card.appendChild(makeBody(work, en));
      return card;
    }

    function sortVersions(list) {
      var en = enrich();
      return en && en.sortVersions ? en.sortVersions(list, filter.sort) : (list || []).slice();
    }

    function toggleWork(work) {
      if (expanded[work.key]) {
        delete expanded[work.key];
        render();
        return;
      }
      expanded[work.key] = true;
      var p = loadVersions(work);
      render();                 // 骨架先上屏（§7「读取版本…」），不等网络
      p.then(function () { if (!isStale()) render(); });
    }

    function makeBody(work, en) {
      var body = el('div', 'huilian-work-body');
      if (loading[work.key] || (!hasVersions(work) && !work.error)) {
        body.appendChild(el('div', 'huilian-version-loading', LOADING_COPY));
        return body;
      }
      if (work.error) {
        var err = el('div', 'huilian-version-error', work.error);
        err.setAttribute('data-empty', '1');
        body.appendChild(err);
        return body;
      }
      var sorted = sortVersions(work.versions);
      if (!sorted.length) {
        body.appendChild(el('div', 'huilian-version-empty', NO_MAGNET_COPY)).setAttribute('data-empty', '1');
        return body;
      }
      // 先排序再归约：splitConstantBadges 的 rows 与入参下标平行，顺序换了徽章会串行（易错点 2）
      var split = en && en.splitConstantBadges ? en.splitConstantBadges(sorted) : { rows: [] };
      var showAll = !!shownAll[work.key] || filtering();
      var visible = showAll ? sorted : sorted.slice(0, PREVIEW_COUNT);
      for (var i = 0; i < visible.length; i++) {
        body.appendChild(makeVersionRow(work, visible[i], (split.rows && split.rows[i]) || []));
      }
      if (sorted.length > PREVIEW_COUNT) {
        var more = el('button', 'huilian-version-more', showAll ? '只看前 ' + PREVIEW_COUNT : '全部 ' + sorted.length);
        more.addEventListener('click', function () {
          shownAll[work.key] = !shownAll[work.key];
          render();
        });
        body.appendChild(more);
      }
      return body;
    }

    function makeVersionRow(work, v, badges) {
      var rowNode = el('div', 'huilian-version-row');
      rowNode.setAttribute('data-key', work.key);
      var name = el('span', 'huilian-version-name', v.name || v.rawMagnet || '');
      name.setAttribute('title', v.name || '');   // §6.3：未知 token 不进徽章，只留在原文 tooltip
      rowNode.appendChild(name);
      var bs = el('span', 'huilian-version-badges');
      for (var i = 0; i < badges.length; i++) bs.appendChild(badgeNode(badges[i]));
      rowNode.appendChild(bs);
      var en = enrich();
      var sizeText = (v.size && v.size.text) || (en && en.formatSize ? en.formatSize(v.size && v.size.bytes) : '');
      rowNode.appendChild(el('span', 'huilian-version-size', sizeText));
      rowNode.addEventListener('click', function () { enqueueVersion(v); });
      return rowNode;
    }

    function enqueueVersion(v) {
      if (isStale() || typeof cfg.enqueue !== 'function') return;
      Promise.resolve(cfg.enqueue(v.magnet)).then(function (res) {
        if (isStale()) return;
        if (!res) return;
        if (res.ok && res.duplicated) say(DUPLICATED_COPY);   // 高亮定位由 submitMagnet 内部 focusTask 做
        else if (!res.ok) say(ADD_FAILED_PREFIX + ((res && res.error) || '未知错误'));
        else say('');
      }).catch(function (err) {
        if (isStale()) return;
        say(ADD_FAILED_PREFIX + String((err && err.message) || err || '未知错误'));
      });
    }

    function render() {
      if (destroyed) return;
      list.innerHTML = '';
      var shown = visibleWorks();
      count.textContent = shown.length ? ('共 ' + shown.length + ' 个作品') : '';
      if (!shown.length) {
        // emptyCopy 为空 = 「还没搜过」，此时结果区就该是空的，不硬凑一条文案
        if (emptyCopy) list.appendChild(el('div', 'huilian-result-empty', emptyCopy));
        return;
      }
      for (var i = 0; i < shown.length; i++) list.appendChild(makeCard(shown[i]));
    }

    // 首屏即渲染：无规则时 §7 文案与搜索行置灰必须当场可见，不等用户点搜索
    emptyCopy = gate().length ? '' : NO_RULE_COPY;
    syncChips();
    render();

    function destroy() {
      destroyed = true;
      works = []; rulesById = {}; expanded = {}; shownAll = {}; loading = {}; inflight = {};
      lastQuery = ''; emptyCopy = '';
      container.innerHTML = '';
    }

    return { destroy: destroy, search: search };
  }

  SFV.huilianSiteSearch = { create: create, PREVIEW_COUNT: PREVIEW_COUNT };
})(typeof window !== 'undefined' ? window : this);
```

四处不是凭口味写的地方，留在这里备查：

- **`render()` 在 `loadVersions` 之前调用**（`toggleWork`）：§7 要求「展开后正在抓 → 行内骨架，不整页 loading」，所以骨架必须与网络解耦。若等 `p.then` 再渲染，展开点击会看起来没反应。
- **抓取失败不自动重试**（`loadVersions` 的守卫 `hasVersions(work) || work.error`）：留 error 态、由下一轮搜索整批换新对象时才清，展开钮不做隐式重试——§6.4 的限流前提就是「不做无界自动重试」，而 §7 的重试钮只规定在「本地代理不可用」「站点 4xx/5xx」的**分区状态点**上，本组件的重试入口就是搜索钮本身。
  ⚠️ 这条不变量的成立**依赖**上文 `works = merged.map(浅复制)`：不复制时「下一轮搜索」拿到的是 source 缓存里的同一对象，error 永不清。配套回归测（Task 8 修复轮新增，必须先红后绿）：同一 query 搜两次，第一次 `fetchVersions` 回 `{ok:false,message:'…'}`，第二次断言该作品**回到未抓态**（`versionsCalls` 增量 +1、error 不粘滞），并断言就地写回不污染 source 缓存（组件拿到的 works 与 source 返回的 works **不是同一对象引用**）。
- **`shownAll[work.key] = !shownAll[work.key]`** 而不是 `= true`：折叠钮与「全部 N」共用同一个 `render()`，用翻转才能「全部 → 只看前 3 → 全部」来回切。
- **有结果时也要把失败上浮**（`if (merged.length) say(firstError)`）：多规则合并后「一条成功一条 404」是真实可能，把 404 悄悄吞掉等于告诉用户「这站好好的」。页面那条 `.huilian-error` 就是提示条，成功搜索时会被下一次 `say('')` 清掉。

- [ ] **Step 4: 跑新测确认全绿**

Run: `node --test tests/huilian-site-search.test.js`
Expected: PASS，11 tests，0 fail。

若 `c)` 或 `d)` 红在 `versionsCalls.length`，先查是不是把抓取放进了 `search()`（易错点 1 的反向症状：搜索即全抓，既违反 §6.4 又让「懒抓取」断言失去意义）。若 `e)` 红在 `cards.length === 2`，多半是先 `applyFilter` 后抓版本——未展开作品的 `versions === null` 被筛空，回到 `applyFilterChange` 的 `Promise.all(jobs).then(render)`。

- [ ] **Step 5: `player.css` 补搜索区样式（与 Step 3 同批提交）**

在 `public/video/player.css` 的

```css
.huilian-site-search { margin-top: 16px; display: flex; flex-direction: column; gap: 10px; }
```

之后插入（§6.2 横卡、§6.3 两级色阶：字幕族强调、发布组弱灰，其余中性；不给 HDR/帧率上彩色，避免与站点主色抢焦点）：

```css
/* ---- 磁力站点搜索区（Task 8）：搜索行 / 筛选条 / 作品横卡 ---- */
.huilian-search-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.huilian-site-input { flex: 1 1 160px; min-width: 0; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, .14); background: rgba(255, 255, 255, .06); color: inherit; }
.huilian-site-input:disabled { opacity: .45; }
.huilian-site-go, .huilian-rules-btn { padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, .16); background: rgba(255, 255, 255, .1); color: inherit; cursor: pointer; }
.huilian-rules-btn:disabled { opacity: .4; cursor: not-allowed; }
.huilian-search-count { font-size: 12px; opacity: .7; margin-left: auto; }
.huilian-filter-bar { display: flex; flex-wrap: wrap; gap: 10px; }
.huilian-filter-group { display: flex; align-items: center; gap: 4px; }
.huilian-filter-label { font-size: 12px; opacity: .55; }
.huilian-filter-chip { padding: 3px 9px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, .16); background: transparent; color: inherit; font-size: 12px; cursor: pointer; }
.huilian-filter-chip[data-on="1"] { background: rgba(255, 255, 255, .82); color: #14161a; border-color: transparent; }
.huilian-result-list { display: flex; flex-direction: column; gap: 8px; }
.huilian-result-empty { padding: 14px 12px; border-radius: 10px; border: 1px dashed rgba(255, 255, 255, .18); font-size: 13px; opacity: .75; }
.huilian-work-card { border: 1px solid rgba(255, 255, 255, .12); border-radius: 12px; background: rgba(255, 255, 255, .04); overflow: hidden; }
.huilian-work-head { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; }
.huilian-work-poster { width: 26px; height: 36px; object-fit: cover; border-radius: 4px; flex: 0 0 auto; background: rgba(255, 255, 255, .08); }
.huilian-work-poster-none { width: 26px; height: 36px; border-radius: 4px; flex: 0 0 auto; background: rgba(255, 255, 255, .07); }
.huilian-work-info { flex: 1 1 auto; min-width: 0; }
.huilian-work-title { font-size: 14px; font-weight: 600; }
.huilian-work-sub { font-size: 12px; opacity: .68; margin-top: 2px; }
.huilian-work-badges { font-size: 11px; opacity: .55; margin-top: 3px; }
.huilian-work-toggle { flex: 0 0 auto; padding: 4px 8px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, .16); background: transparent; color: inherit; font-size: 12px; cursor: pointer; }
.huilian-work-body { display: flex; flex-direction: column; border-top: 1px solid rgba(255, 255, 255, .1); }
.huilian-version-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; }
.huilian-version-row + .huilian-version-row { border-top: 1px solid rgba(255, 255, 255, .06); }
.huilian-version-row:hover { background: rgba(255, 255, 255, .06); }
.huilian-version-name { flex: 1 1 auto; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.huilian-version-badges { flex: 0 0 auto; display: flex; gap: 4px; }
.huilian-version-size { flex: 0 0 auto; font-variant-numeric: tabular-nums; font-size: 12px; opacity: .8; }
.huilian-badge { padding: 2px 6px; border-radius: 6px; font-size: 11px; background: rgba(255, 255, 255, .1); color: rgba(255, 255, 255, .78); }
.huilian-badge--accent { background: rgba(245, 197, 24, .18); color: #f5c518; }
.huilian-badge--dim { background: transparent; color: rgba(255, 255, 255, .4); }
.huilian-badge--neutral { background: rgba(255, 255, 255, .1); }
.huilian-version-more { align-self: flex-start; margin: 4px 12px 10px; padding: 3px 9px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, .16); background: transparent; color: inherit; font-size: 12px; cursor: pointer; }
.huilian-version-loading { padding: 8px 12px; font-size: 12px; opacity: .6; }
.huilian-version-error { padding: 8px 12px; font-size: 12px; color: #ff8b8b; }
.huilian-version-empty { padding: 8px 12px; font-size: 12px; opacity: .45; }
```

- [ ] **Step 6: 注册 + harness 接线**

`public/index.html` 的

```js
    "video/huilian-magnet-source.js",
    "video/huilian-player-bar.js",
```

改成

```js
    "video/huilian-magnet-source.js",
    "video/huilian-site-search.js",
    "video/huilian-player-bar.js",
```

`tests/helpers/huilian-harness.js` 有**两处**改动，顺序不能反（6a 先把桩位拆下来，6b 再把它接到清单之后）：

6a) 整段删除（Task 7 Step 4c 落的位置）

```js
  // 组件桩（Task7：SFV.huilianSiteSearch 的 create/destroy 计数；Task8 起可不传，走真实现）
  if (opts.sfv && typeof opts.sfv === 'object') Object.assign(sandbox.StellaflixVideo, opts.sfv);

  if (opts.bridge) sandbox.stellaflixVideo = mergeBridge(opts.bridge === true ? null : opts.bridge, events);
```

改成

```js
  if (opts.bridge) sandbox.stellaflixVideo = mergeBridge(opts.bridge === true ? null : opts.bridge, events);
```

6b) 模块清单加本模块，并把桩合并挪到清单**之后**

```js
    'public/video/huilian-magnet-source.js',
    'public/video/huilian-player-bar.js',
```

改成

```js
    'public/video/huilian-magnet-source.js',
    'public/video/huilian-site-search.js',
    'public/video/huilian-player-bar.js',
```

同文件里

```js
  ].forEach((p) => vm.runInContext(read(p), sandbox, { filename: path.basename(p) }));
```

改成

```js
  ].forEach((p) => vm.runInContext(read(p), sandbox, { filename: path.basename(p) }));

  // 组件桩必须在模块清单之后合并：清单里此刻已有真的 huilian-site-search.js，
  // 「先注入桩、后加载真模块」会让真模块把桩覆盖掉——Task7 的 enqueue-mouth g) 当场失效。
  if (opts.sfv && typeof opts.sfv === 'object') Object.assign(sandbox.StellaflixVideo, opts.sfv);
```

`tests/huilian-magnet-registration.test.js` 的整条替换

```js
test('site-search / rules-ui 此刻尚未注册（各自任务落地时才注册，防 404）', () => {
  assert.strictEqual(at('huilian-site-search.js'), -1);
  assert.strictEqual(at('huilian-magnet-rules-ui.js'), -1);
});
```

改成

```js
test('site-search 已注册且排在数据层之后、页面之前；rules-ui 此刻仍未注册（Task 9 落地才注册，防 404）', () => {
  assert.ok(at('huilian-site-search.js') >= 0, 'huilian-site-search.js 未注册进 SFV_SCRIPTS');
  assert.ok(at('huilian-magnet-source.js') < at('huilian-site-search.js'),
    'site-search 运行期取 SFV.huilianMagnetSource，必须排在它之后');
  assert.ok(at('huilian-site-search.js') < at('huilian-page.js'),
    '页面 mount 时要 create()，组件必须在 huilian-page.js 之前');
  assert.strictEqual(at('huilian-magnet-rules-ui.js'), -1);
});
```

Run: `node --test tests/huilian-magnet-registration.test.js`
Expected: PASS，3 tests，0 fail。

- [ ] **Step 7: CSS 契约测确认渲染树全覆盖**

Run: `node --test tests/huilian-css-contract.test.js`
Expected: PASS，4 tests，0 fail。

这是 Step 3 与 Step 5 必须同批提交的兑现点：harness 一加载 site-search，`loadPage` 的 `mount` 就会真走进 `create()`，契约测当场采到 `.huilian-search-row / .huilian-site-input / .huilian-site-go / .huilian-rules-btn / .huilian-search-count / .huilian-filter-bar / .huilian-filter-group / .huilian-filter-label / .huilian-filter-chip / .huilian-result-list / .huilian-result-empty` 十一个 class（无规则态）。少写任意一条，败因即「player.css 缺少 .xxx 规则」。卡内类（`huilian-work-*` / `huilian-version-*` / `huilian-badge`）此刻契约测走不到（需要真抓取），但同批落，Task 10 的窄屏退化才有东西可退化。

- [ ] **Step 8: 回归既有汇联测**

Run: `node --test tests/huilian-queue.test.js tests/huilian-page.test.js tests/huilian-player-bar.test.js tests/huilian-css-contract.test.js tests/huilian-enqueue-mouth.test.js tests/huilian-magnet-enrich.test.js tests/huilian-magnet-rules.test.js tests/huilian-magnet-source.test.js tests/huilian-magnet-registration.test.js tests/source-picker-magnet-row.test.js tests/detail-source-magnet-partition.test.js tests/huilian-site-search.test.js`
Expected: 全绿，0 fail。名单以 `ls tests/huilian-*.test.js` 为准，逐个报数。

`tests/huilian-enqueue-mouth.test.js` 的 g) 用 `opts.sfv` 桩替换 `SFV.huilianSiteSearch`。Task 7 把桩合并写在模块清单**之前**，那时清单里没有真组件所以看不出来；Step 6b 把合并挪到清单之后，桩才真的压得住真模块。若这条红在 `created.length === 1`，先查 harness 里 `Object.assign(sandbox.StellaflixVideo, opts.sfv)` 的位置还在不在 `].forEach(...)` 之后。

- [ ] **Step 9: 提交**

```bash
git add public/video/huilian-site-search.js public/video/player.css public/index.html \
        tests/huilian-site-search.test.js tests/huilian-magnet-registration.test.js tests/helpers/huilian-harness.js
git commit -m "feat: 汇联 磁力源 Task8 — 站点搜索区组件（横卡/差异徽章/筛选条/懒抓取）+ 同批样式与注册"
```

---

### Task 9: `huilian-magnet-rules-ui.js` — 规则导入面板（§6.6）

**Files:**
- Create: `public/video/huilian-magnet-rules-ui.js`
- Modify: `public/video/huilian-site-search.js`（「规则」钮从「模块缺席置灰」升级为「缺席置灰 + 在场承接」）
- Modify: `public/index.html`（`SFV_SCRIPTS`：`"video/huilian-site-search.js"` 之后插一行）
- Modify: `tests/helpers/huilian-harness.js`（模块清单同步，保持「与 index.html 一致」这条注释为真）
- Modify: `tests/huilian-magnet-registration.test.js`（Task 8 翻面后剩下的那条 `rules-ui === -1` 再翻一次）
- Modify: `public/video/player.css`（面板类样式，与模块同批落）
- Test: `tests/huilian-magnet-rules-ui.test.js`

**Interfaces:**
- Consumes：Task 3 `SFV.huilianMagnetRules.{listAll, getEnabled, put, remove, setEnabled, isTrackerStale, formatDate, parseImport, formatValidateError, importFromJson, getText}`；Task 5 `SFV.sourcePicker.openModal(build(card, close) -> closeFn)`（§5.7「不新造第三层模态」）；Task 4 `SFV.huilianMagnetSource.mapFetchError(err) -> §7 文案`（**可选**，缺席时退回原样上屏）。
- Produces：`SFV.huilianMagnetRulesUi.open({onChanged?, showError?, now?}) -> close()`、`SFV.huilianMagnetRulesUi.close()`。`now()` 是**注入时钟**（§6.6.5 的 180 天阈值要能测），默认 `Date.now`。

**裁决 1（URL 导入不走 `importFromUrl`）**：`§6.6.2` 要求「拉取 → 校验 → 与同 `id` 的既有规则合并（**覆盖前显示差异并确认**）」，而 Task 3 的 `importFromUrl(url)` = `getText` + `importFromJson`，**中间没有确认停留点**，直接调它必然在确认前落盘。所以面板走 `getText(url)` 拿到文本后，与「粘贴 JSON」共用同一条 `importJsonWithConfirm(text)` 路径。`importFromUrl` 保持原样导出（Task 3 的测仍在守它），只是面板不用它——不是重复实现，是把「无确认的原子导入」和「有确认的面板导入」分成两件事。

**裁决 2（校验失败零落盘的可测形式）**：面板先 `parseImport(text)`，不 ok 就**只写提示，不碰存储**。断言写成「导入前后 `listAll()` 的 JSON 快照逐字相等」，而不是「钮没反应」——后者测不到落盘。

**裁决 3（不新增 §7 文案）**：抓取失败文案取 `mapFetchError`（§7 已定死），入队/表单类结果文案是面板私有的操作回执（§7 表只管抓取与入队的状态，面板回执不在其列）。空输入的防呆靠**钮置灰**，不靠新造一句「请先填写…」——`§9.1` 的红线是「无默认地址」，空串 + 不可用正好是它的最直白表达。

**易错点**：
1. **模块引用必须晚绑定**：面板里所有 `SFV.huilianMagnetRules.xxx` 都要在**调用时**取（走 `rules()` 函数），不能在文件头 `var R = SFV.huilianMagnetRules` 抓住引用——测里靠替换 `SFV.huilianMagnetRules.getText` 来桩网络，早绑定会桩不住。
2. **只挂一个面板**：`open()` 首行先 `close()`。重复点「规则」钮叠两层 backdrop，是模态组件最常见的漏法。
3. **`card.className` 不能覆写掉 `sfv-picker-modal`**：`openModal` 已经把 `card` 挂进 `.sfv-picker-modal-backdrop` 并写了 `className='sfv-picker-modal'`；面板要是用 `card.className = 'huilian-rules-panel'` 就会把模态自带的定位/遮罩样式踢掉（表现是弹窗贴在页面左上角）。正确写法是 `setAttribute('class', 'sfv-picker-modal huilian-rules-panel')`。
4. **旧类名禁用清单同样适用**：面板类一律 `huilian-rules-*`，别踩 `huilian-config-row`/`huilian-input-wrap`/`huilian-empty` 这些 §b) 段的报废名。
5. **`put` 的第二个参数是 `importedAt` 的唯一入口**：Task 3 定死「远端 JSON 里的同名 `importedAt` 在校验阶段被丢弃，写入时刻由代码补」。所以测 181 天时效**只能** `R.put(r, r.importedAt)` 播种；把 `importedAt` 写进规则对象再 `put(r, NOW)`，会被覆写回当下，b) 的「老规则该提示」永远等不到（本计划的测初版就是这么写的，跑出来 b) 红）。
6. **进确认态会整表重渲染，旧句柄即成孤儿**：`renderList()` 用 `listBox.innerHTML=''` 重建每一行，删除钮第一次点击后 `t.qa('.huilian-rules-del')[0]` 已是**新节点**，手里那个旧节点脱离了文档、`textContent` 永远停在「删除」。断言必须重新取节点，不能复用点击前拿到的引用。
7. **给 `.value` 赋值不触发 `input` 事件**：面板的钮解锁走 `urlInput.addEventListener('input', syncButtons)`，真人打字必然发 `input`；测试里 `el.value = '…'` 之后要 `fire(el, 'input')`，否则断言「填址后钮解锁」必红。（顺带：对 `disabled` 的钮直接 `dispatchEvent('click')` 在 jsdom 里仍会跑监听器，不补 `input` 的话 h) 会「假绿」——测的是一条现实中不存在的路径。）

- [ ] **Step 1: 写失败测试 `tests/huilian-magnet-rules-ui.test.js`**

```js
'use strict';
/**
 * 汇联 磁力源 Task9 契约：规则面板（spec §6.6 六条 + §9.1 零内置）。
 *   a) 列表渲染逐字：`名称 · origin`、`tracker {N} 条 · 导入于 {YYYY-MM-DD}`；
 *   b) 时效提示只在超 180 天时出现（注入假时钟；未超期不得出现，双向都钉）；
 *   c) 停用即时生效：setEnabled(false) → getEnabled() 空 → onChanged 被回调；
 *   d) 删除要二次确认：一次点击不删，再点才删；点别行不串确认态；
 *   e) 校验不通过整条不落盘（导入前后 listAll 快照逐字相等）+ §6.6.4 文案逐字；
 *   f) 同 id 覆盖前要求确认：第一次导入不落盘并出差异，确认后落盘；
 *   g) 「从 URL 导入」无默认地址（输入框空 → 钮置灰），填址后走 getText + 同一确认路径（裁决 1）；
 *   h) 抓取失败文案取 mapFetchError（§7 模板，面板不重拼）；
 *   i) 面板只挂一个：重复 open 不叠 backdrop；close 后 body 无残留；
 *   j) 与搜索区的接线：点「规则」钮开面板，面板里停用规则 → 搜索行当场置灰（§5.1 分区出现条件）。
 * 运行：node --test tests/huilian-magnet-rules-ui.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { after } = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 1);            // 假时钟：2026-10-01
const clock = () => NOW;

const ruleOf = (id, opt) => {
  const o = opt || {};
  return {
    id: id, name: '站点' + id, origin: 'https://example.test',
    searchURL: 'https://example.test/search.php?search={query}&pjax=1',
    workItemXPath: '//div', magnetItemXPath: '//a', magnetAttr: 'data-url',
    trackers: o.trackers === undefined ? ['udp://tracker.example.test:2710/announce'] : o.trackers,
    importedAt: o.importedAt === undefined ? NOW : o.importedAt,
    enabled: o.enabled === undefined ? true : o.enabled,
  };
};

const windows = [];
function buildEnv(opt) {
  const o = opt || {};
  const dom = new JSDOM('<!doctype html><html><body></body></html>',
    { url: 'https://example.test/', runScripts: 'outside-only' });
  windows.push(dom.window);
  const win = dom.window;
  win.requestAnimationFrame = function () {};        // 入场动画与断言无关
  [
    'public/video/huilian-queue.js',
    'public/video/huilian-magnet-enrich.js',
    'public/video/huilian-magnet-rules.js',
    'public/video/huilian-magnet-source.js',
    'public/video/source-picker.js',
    'public/video/huilian-site-search.js',
    'public/video/huilian-magnet-rules-ui.js',
  ].forEach((p) => win.eval(read(p)));
  const SFV = win.StellaflixVideo;
  const R = SFV.huilianMagnetRules;
  // put 的第二个参数是 importedAt 的唯一来源（Task3 定死：远端 JSON 的同名字段在校验时被丢弃），
  // 所以「181 天前导入的老规则」只能这样播种 —— 写进 ruleOf 的对象里会被覆写回 NOW。
  (o.rules || []).forEach((r) => R.put(r, r.importedAt));

  // 网络只从 getText 出：桩掉它就桩住了两条导入路径的共同上游
  const texts = [];
  R.getText = (url) => {
    texts.push(url);
    return o.getTextFail ? Promise.reject(new Error(o.getTextFail))
      : Promise.resolve(o.remoteText || '{"rules":[]}');
  };

  const changes = [];
  const box = win.document.createElement('div');
  box.setAttribute('class', 'huilian-site-search');
  win.document.body.appendChild(box);
  const searchWidget = SFV.huilianSiteSearch.create({
    container: box,
    enqueue: () => Promise.resolve({ ok: true, hash: '' }),
    showError: (m) => { env.error = m || ''; },
    isStale: () => false,
  });
  const env = {
    win, SFV, R, box, texts, changes, error: '', searchWidget,
    doc: win.document,
    q: (sel) => win.document.querySelector(sel),
    qa: (sel) => Array.from(win.document.querySelectorAll(sel)),
    open: () => SFV.huilianMagnetRulesUi.open({ now: clock, onChanged: (x) => env.changes.push(x) }),
  };
  return env;
}
after(() => { for (const w of windows) w.close(); });

const fire = (node, type) => node.dispatchEvent(new node.ownerDocument.defaultView.Event(type, { bubbles: true }));
const panelText = (t) => t.q('.huilian-rules-msg').textContent;

test('a) 列表逐字：名称 · origin，tracker {N} 条 · 导入于 {YYYY-MM-DD}', () => {
  const t = buildEnv({ rules: [ruleOf('pomo', { trackers: ['udp://a.test', 'udp://b.test'] })] });
  t.open();
  const rows = t.qa('.huilian-rules-row');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(t.q('.huilian-rules-name').textContent, '站点pomo · https://example.test');
  assert.strictEqual(t.q('.huilian-rules-meta').textContent,
    'tracker 2 条 · 导入于 ' + t.R.formatDate(Date.UTC(2026, 9, 1)));
  t.SFV.huilianMagnetRulesUi.close();
});

test('b) 时效提示只在超 180 天时出现（假时钟，双向都钉）', () => {
  const fresh = buildEnv({ rules: [ruleOf('fresh', { importedAt: NOW - 179 * DAY })] });
  fresh.open();
  assert.strictEqual(fresh.q('.huilian-rules-stale'), null, '未超期不得出现时效提示');
  fresh.SFV.huilianMagnetRulesUi.close();

  const old = buildEnv({ rules: [ruleOf('old', { importedAt: NOW - 181 * DAY })] });
  old.open();
  assert.strictEqual(old.q('.huilian-rules-stale').textContent,
    'tracker 清单可能已失效，重新导入以提升出种率。');
  old.SFV.huilianMagnetRulesUi.close();
});

test('c) 停用即时生效：存储翻位 → getEnabled 空 → onChanged 回调', () => {
  const t = buildEnv({ rules: [ruleOf('pomo')] });
  t.open();
  const cb = t.q('.huilian-rules-enabled');
  assert.strictEqual(cb.checked, true);
  cb.checked = false;
  fire(cb, 'change');
  assert.strictEqual(t.R.getEnabled().length, 0, '停用要立刻落到存储');
  assert.strictEqual(t.changes.length, 1, '面板必须把变更喊给宿主');
});

test('d) 删除二次确认：一次不删、再点才删；跨行不串确认态', () => {
  const t = buildEnv({ rules: [ruleOf('a'), ruleOf('b')] });
  t.open();
  fire(t.qa('.huilian-rules-del')[0], 'click');
  assert.strictEqual(t.R.listAll().length, 2, '第一次点击不得删除');
  // 进确认态走整表重渲染，旧句柄已脱离文档，断言必须重新取节点
  assert.strictEqual(t.qa('.huilian-rules-del')[0].textContent, '确认删除？');
  assert.strictEqual(t.qa('.huilian-rules-del')[1].textContent, '删除', '第二行不该跟着进确认态');
  fire(t.qa('.huilian-rules-del')[0], 'click');
  assert.strictEqual(t.R.listAll().length, 1);
  assert.strictEqual(t.R.listAll()[0].id, 'b');
});

test('e) 校验不通过：整条不落盘 + §6.6.4 文案逐字', () => {
  const t = buildEnv({ rules: [ruleOf('keep')] });
  const before = JSON.stringify(t.R.listAll());
  t.open();
  t.q('.huilian-rules-json').value = '{"id":"broken","name":"残缺站"}';
  fire(t.q('.huilian-rules-json-import'), 'click');
  assert.strictEqual(JSON.stringify(t.R.listAll()), before, '不通过必须整条不落盘');
  assert.ok(/^规则格式不符：(缺少|不合法)/.test(panelText(t)), '实际：' + panelText(t));
  assert.ok(/未导入任何内容。$/.test(panelText(t)), '实际：' + panelText(t));
});

test('f) 同 id 覆盖：先出差异确认，确认后才落盘', () => {
  const t = buildEnv({ rules: [ruleOf('pomo', { trackers: ['udp://old.test'] })] });
  t.open();
  t.q('.huilian-rules-json').value = JSON.stringify({ rules: [ruleOf('pomo', { trackers: ['udp://new.test'] })] });
  fire(t.q('.huilian-rules-json-import'), 'click');
  assert.strictEqual(t.R.get('pomo').trackers[0], 'udp://old.test', '确认之前不得覆盖');
  assert.ok(t.q('.huilian-rules-confirm').classList.contains('huilian-rules-confirm--on'),
    '差异确认块要处于「已亮」态（Task9 评审 F1：裸 exists 断言恒真——节点开面板就挂载，只靠 CSS 类隐藏，jsdom 无 layout）');
  assert.ok(t.q('.huilian-rules-confirm').textContent.indexOf('pomo') >= 0, '差异要指名冲突 id');
  fire(t.q('.huilian-rules-confirm-yes'), 'click');
  assert.strictEqual(t.R.get('pomo').trackers[0], 'udp://new.test');
  assert.strictEqual(t.changes.length, 1);
});

test('g) URL 导入无默认地址；填址后走 getText + 同一确认路径（裁决 1）', () => {
  const empty = buildEnv({ rules: [] });
  empty.open();
  assert.strictEqual(empty.q('.huilian-rules-url').value, '', '§9.1：不给默认地址');
  assert.strictEqual(empty.q('.huilian-rules-url-import').disabled, true, '空地址时钮不可用');

  const t = buildEnv({
    rules: [ruleOf('pomo')],
    remoteText: JSON.stringify({ rules: [ruleOf('pomo', { trackers: ['udp://new.test'] })] }),
  });
  t.open();
  t.q('.huilian-rules-url').value = 'https://remote.test/rules.json';
  fire(t.q('.huilian-rules-url'), 'input');   // 赋值不触发 input 事件，手动补一次才是真人路径
  assert.strictEqual(t.q('.huilian-rules-url-import').disabled, false, '填址后钮解锁');
  fire(t.q('.huilian-rules-url-import'), 'click');
  return new Promise((r) => t.win.setTimeout(r, 0)).then(() => {
    assert.strictEqual(t.texts[0], 'https://remote.test/rules.json');
    assert.ok(t.q('.huilian-rules-confirm').classList.contains('huilian-rules-confirm--on'),
      'URL 路径也要在覆盖前确认（不是直接落盘）；必须钉 --on 类——节点常驻 DOM，裸 exists 恒真（Task9 评审 F1）');
    fire(t.q('.huilian-rules-confirm-yes'), 'click');
    assert.strictEqual(t.R.get('pomo').trackers[0], 'udp://new.test');
  });
});

test('h) 抓取失败文案取 mapFetchError，面板不重拼 §7', async () => {
  const t = buildEnv({ rules: [], getTextFail: 'AbortError' });
  t.open();
  t.q('.huilian-rules-url').value = 'https://remote.test/rules.json';
  fire(t.q('.huilian-rules-url'), 'input');   // 赋值不触发 input 事件，手动补一次才是真人路径
  fire(t.q('.huilian-rules-url-import'), 'click');
  await new Promise((r) => t.win.setTimeout(r, 0));
  assert.strictEqual(panelText(t), '站点无响应（超时）。稍后再试或换一个规则。');
});

test('i) 面板只挂一个；close 后 body 无残留', () => {
  const t = buildEnv({ rules: [ruleOf('pomo')] });
  t.open(); t.open(); t.open();
  assert.strictEqual(t.qa('.sfv-picker-modal-backdrop').length, 1, '重复 open 不得叠层');
  t.SFV.huilianMagnetRulesUi.close();
  assert.strictEqual(t.qa('.sfv-picker-modal-backdrop').length, 0);
  t.SFV.huilianMagnetRulesUi.close();   // 幂等：没有面板时不能再删一次
});

test('j) 接线：点搜索区「规则」钮开面板，面板里停用 → 搜索行当场置灰', () => {
  const t = buildEnv({ rules: [ruleOf('pomo')] });
  const input = t.box.querySelector('.huilian-site-input');
  assert.strictEqual(input.disabled, false, '有启用规则时搜索行可用');
  fire(t.box.querySelector('.huilian-rules-btn'), 'click');
  assert.ok(t.q('.huilian-rules-panel'), '钮要真把面板开起来');
  const cb = t.q('.huilian-rules-enabled');
  cb.checked = false;
  fire(cb, 'change');
  assert.strictEqual(input.disabled, true, '停用后搜索行立即置灰（§5.1/§7 无规则态）');
  assert.strictEqual(t.box.querySelector('.huilian-result-empty').textContent,
    '未导入磁力站点规则。点搜索行的「规则」从远端一键导入。');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/huilian-magnet-rules-ui.test.js`
Expected: FAIL —`Cannot read properties of undefined (reading 'open')`（`huilian-magnet-rules-ui.js` 还不存在；j) 则败在 `.huilian-rules-btn` 没有 click 承接）。

- [ ] **Step 3: 创建 `public/video/huilian-magnet-rules-ui.js`**

```js
/*
 * Stellaflix 影视模块 — 汇联磁力规则面板（§6.6）
 * 依赖：SFV.huilianMagnetRules（校验/存储/时效）、SFV.sourcePicker.openModal（§5.7 模态复用）；
 *       SFV.huilianMagnetSource.mapFetchError 可选（缺席时抓取错误原样上屏）。
 * 产出：SFV.huilianMagnetRulesUi.open({onChanged, showError, now}) -> close()；.close()。
 * 红线：零内置——不给任何默认地址（§9.1）；校验不通过整条不落盘（§6.6.4）；
 *       同 id 覆盖必须先确认（§6.6.2）；渲染只用 createElement + textContent。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var STALE_COPY = 'tracker 清单可能已失效，重新导入以提升出种率。';
  var DELETE_COPY = '删除';
  var DELETE_ASK_COPY = '确认删除？';
  var OVERWRITE_HEAD = '已有同 id 规则，导入将整条覆盖：';
  var CONFIRM_YES_COPY = '确认覆盖';
  var CONFIRM_NO_COPY = '取消';

  // 模块一律晚绑定取（测里靠替换 SFV.huilianMagnetRules.getText 桩网络；文件头抓引用会桩不住）
  function rules() { return SFV.huilianMagnetRules || null; }
  function mapError(err) {
    var s = SFV.huilianMagnetSource;
    if (s && typeof s.mapFetchError === 'function') return s.mapFetchError(err);
    return String((err && err.message) || err || '未知错误');
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.setAttribute('class', cls);
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function metaText(rule, R) {
    var n = Array.isArray(rule.trackers) ? rule.trackers.length : 0;
    return 'tracker ' + n + ' 条 · 导入于 ' + (R && R.formatDate ? R.formatDate(rule.importedAt) : '');
  }

  var currentClose = null;

  function close() {
    if (!currentClose) return;
    var c = currentClose;
    currentClose = null;
    c();
  }

  function open(opt) {
    var o = opt || {};
    var P = SFV.sourcePicker;
    if (!P || typeof P.openModal !== 'function') {
      if (typeof o.showError === 'function') o.showError('规则面板需要选择器模块，请先加载 video/source-picker.js');
      return function () {};
    }
    close();   // 只挂一个面板（易错点 2）
    var now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
    var askDeleteId = '';
    var awaiting = null;          // { ids: [], run: Function } —— 覆盖前的待确认负载
    var closeSelf = function () {};

    var body = el('div', 'huilian-rules-body');
    var listBox = el('div', 'huilian-rules-list');
    var confirmBox = el('div', 'huilian-rules-confirm');
    var msg = el('div', 'huilian-rules-msg');

    var urlInput = el('input', 'huilian-rules-url');
    urlInput.setAttribute('type', 'text');
    urlInput.setAttribute('placeholder', '规则 JSON 地址（不预置，需自备）');
    var urlBtn = el('button', 'huilian-rules-url-import', '从 URL 导入');
    urlBtn.disabled = true;   // 空地址不可用 = §9.1「无默认地址」的最直白表达（裁决 3）
    var jsonInput = el('textarea', 'huilian-rules-json');
    jsonInput.setAttribute('placeholder', '或粘贴规则 JSON');
    var jsonBtn = el('button', 'huilian-rules-json-import', '导入 JSON');
    jsonBtn.disabled = true;

    function setMsg(text) { msg.textContent = text || ''; }
    function changed() { if (typeof o.onChanged === 'function') o.onChanged(); }

    function syncButtons() {
      urlBtn.disabled = !String(urlInput.value || '').trim();
      jsonBtn.disabled = !String(jsonInput.value || '').trim();
    }
    urlInput.addEventListener('input', syncButtons);
    jsonInput.addEventListener('input', syncButtons);

    function renderList() {
      var R = rules();
      listBox.innerHTML = '';
      var all = (R && typeof R.listAll === 'function') ? (R.listAll() || []) : [];
      if (!all.length) {
        listBox.appendChild(el('div', 'huilian-rules-none', '还没有导入任何规则。'));
        return;
      }
      for (var i = 0; i < all.length; i++) {
        (function (rule) {
          var row = el('div', 'huilian-rules-row');
          row.setAttribute('data-id', rule.id);
          var label = el('label', 'huilian-rules-enable-label');
          var cb = el('input', 'huilian-rules-enabled');
          cb.setAttribute('type', 'checkbox');
          cb.checked = rule.enabled !== false;
          cb.addEventListener('change', function () {
            var rr = rules();
            if (rr && rr.setEnabled) rr.setEnabled(rule.id, !!cb.checked);
            setMsg('');
            changed();          // §6.6.1：停用立即影响详情页分区与本页搜索行
          });
          label.appendChild(cb);
          label.appendChild(el('span', 'huilian-rules-name', rule.name + ' · ' + rule.origin));
          row.appendChild(label);
          var R2 = rules();
          row.appendChild(el('div', 'huilian-rules-meta', metaText(rule, R2)));
          if (R2 && R2.isTrackerStale && R2.isTrackerStale(rule, now())) {
            row.appendChild(el('div', 'huilian-rules-stale', STALE_COPY));
          }
          var del = el('button', 'huilian-rules-del', askDeleteId === rule.id ? DELETE_ASK_COPY : DELETE_COPY);
          if (askDeleteId === rule.id) del.setAttribute('data-ask', '1');
          del.addEventListener('click', function () {
            if (askDeleteId !== rule.id) { askDeleteId = rule.id; renderList(); return; }
            var rr = rules();
            if (rr && rr.remove) rr.remove(rule.id);
            askDeleteId = '';
            setMsg('');
            renderList();
            changed();
          });
          row.appendChild(del);
          listBox.appendChild(row);
        })(all[i]);
      }
    }

    function renderConfirm() {
      confirmBox.innerHTML = '';
      if (!awaiting) { confirmBox.setAttribute('class', 'huilian-rules-confirm'); return; }
      confirmBox.setAttribute('class', 'huilian-rules-confirm huilian-rules-confirm--on');
      confirmBox.appendChild(el('div', 'huilian-rules-confirm-text',
        OVERWRITE_HEAD + awaiting.ids.join('、')));
      var yes = el('button', 'huilian-rules-confirm-yes', CONFIRM_YES_COPY);
      var no = el('button', 'huilian-rules-confirm-no', CONFIRM_NO_COPY);
      yes.addEventListener('click', function () { var run = awaiting.run; awaiting = null; renderConfirm(); run(); });
      no.addEventListener('click', function () { awaiting = null; renderConfirm(); setMsg(''); });
      confirmBox.appendChild(yes); confirmBox.appendChild(no);
    }

    function conflictIds(list) {
      var R = rules();
      var ids = [];
      if (!R || typeof R.get !== 'function') return ids;
      for (var i = 0; i < list.length; i++) if (list[i] && R.get(list[i].id)) ids.push(String(list[i].id));
      return ids;
    }

    function finish(res) {
      if (!res || !res.ok) { setMsg((res && res.error) || '导入失败。'); return; }
      setMsg('已导入 ' + res.count + ' 条规则。');
      awaiting = null;
      renderConfirm();
      renderList();
      changed();
    }

    function importJsonWithConfirm(text) {
      var R = rules();
      if (!R) return;
      var parsed = R.parseImport(text);
      // 裁决 2：到此为止，一个字节都不落。陈旧 awaiting 要一起清（Task9 评审 F6），
      // 否则上一次「覆盖前确认」的差异块会滞留在校验失败的屏幕上，看起来像还能继续确认。
      if (!parsed.ok) { awaiting = null; renderConfirm(); setMsg(R.formatValidateError(parsed)); return; }
      var ids = conflictIds(parsed.rules);
      if (ids.length) {
        awaiting = { ids: ids, run: function () { finish(R.importFromJson(text, now())); } };
        renderConfirm();
        setMsg('');
        return;
      }
      finish(R.importFromJson(text, now()));
    }

    jsonBtn.addEventListener('click', function () { importJsonWithConfirm(jsonInput.value); });
    urlBtn.addEventListener('click', function () {
      var R = rules();
      var url = String(urlInput.value || '').trim();
      if (!R || !url) return;
      urlBtn.disabled = true;
      // 裁决 1：不走 importFromUrl（它没有确认停留点），取回文本后与粘贴路径共用确认
      // 会话门禁（Task9 评审 F2）：点过之后关面板/重开 = currentClose 变了，在途 getText 落地
      // 不得再往脱离文档的节点渲染、更不得静默落盘或触发旧 onChanged
      var session = currentClose;
      Promise.resolve(R.getText(url)).then(function (text) {
        if (currentClose !== session) return;
        syncButtons();
        importJsonWithConfirm(text);
      }, function (err) {
        if (currentClose !== session) return;
        syncButtons();
        setMsg(mapError(err));
      });
    });

    closeSelf = P.openModal(function (node) {
      // 保留 openModal 写的 sfv-picker-modal，只追加面板自己的类（易错点 3）
      node.setAttribute('class', 'sfv-picker-modal huilian-rules-panel');
      node.appendChild(el('div', 'huilian-rules-title', '磁力站点规则'));
      // 正文一律挂进 body（Task9 评审 F3：原先 `body` 建而不挂 = 死节点，而 Task10 要为它补
      // `.huilian-rules-body { display:flex; … }` —— 不挂上那条样式就是给幽灵节点写的）
      body.appendChild(listBox);
      body.appendChild(confirmBox);
      var importBox = el('div', 'huilian-rules-import');
      importBox.appendChild(urlInput); importBox.appendChild(urlBtn);
      importBox.appendChild(jsonInput); importBox.appendChild(jsonBtn);
      body.appendChild(importBox);
      body.appendChild(msg);
      body.appendChild(el('button', 'huilian-rules-close', '关闭'));
      node.appendChild(body);
      node.querySelector('.huilian-rules-close').addEventListener('click', close);
      renderList();
      renderConfirm();
      syncButtons();
    });
    currentClose = function () { closeSelf(); };
    return close;
  }

  SFV.huilianMagnetRulesUi = { open: open, close: close };
})(typeof window !== 'undefined' ? window : this);
```

- [ ] **Step 4: 「规则」钮接线（`huilian-site-search.js`）**

把

```js
    var rulesBtn = el('button', 'huilian-btn huilian-rules-btn', '规则');
    // Task 9 才落规则面板；此刻没有承接方，置灰比「点了没反应」诚实
    rulesBtn.disabled = !SFV.huilianMagnetRulesUi;
```

改成

```js
    var rulesBtn = el('button', 'huilian-btn huilian-rules-btn', '规则');
    // 模块缺席（未注册/加载失败）时置灰，比「点了没反应」诚实
    rulesBtn.disabled = !SFV.huilianMagnetRulesUi;
    rulesBtn.addEventListener('click', function () {
      var ui = SFV.huilianMagnetRulesUi;
      if (!ui || typeof ui.open !== 'function') return;
      ui.open({
        showError: say,
        // 规则增删改即时生效：搜索行的置灰态与 §7 空态文案要跟着翻（§5.1 + §6.6.1）
        onChanged: function () {
          if (isStale()) return;
          emptyCopy = gate().length ? '' : NO_RULE_COPY;
          render();
        },
      });
    });
```

- [ ] **Step 5: `player.css` 面板样式（与 Step 3 同批提交）**

在 `public/video/player.css` 的

```css
.huilian-version-empty { padding: 8px 12px; font-size: 12px; opacity: .45; }
```

之后插入：

```css
/* ---- 磁力规则面板（Task 9）：挂在 .sfv-picker-modal 里，只补自己的排布 ---- */
.huilian-rules-panel { display: flex; flex-direction: column; gap: 10px; }
.huilian-rules-title { font-size: 14px; font-weight: 600; }
.huilian-rules-list { display: flex; flex-direction: column; gap: 8px; }
.huilian-rules-none { font-size: 12px; opacity: .6; }
.huilian-rules-row { border: 1px solid rgba(255, 255, 255, .12); border-radius: 10px; padding: 8px 10px; }
.huilian-rules-enable-label { display: flex; align-items: center; gap: 6px; }
.huilian-rules-enabled { flex: 0 0 auto; }
.huilian-rules-name { font-size: 13px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.huilian-rules-meta { font-size: 11px; opacity: .6; margin-top: 3px; }
.huilian-rules-stale { font-size: 11px; color: rgba(255, 255, 255, .45); margin-top: 3px; }
.huilian-rules-del { margin-top: 6px; padding: 3px 9px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, .16); background: transparent; color: inherit; font-size: 12px; cursor: pointer; }
.huilian-rules-del[data-ask="1"] { border-color: #ff8b8b; color: #ff8b8b; }
.huilian-rules-confirm { display: none; }
.huilian-rules-confirm--on { display: flex; flex-direction: column; gap: 6px; border: 1px dashed rgba(245, 197, 24, .5); border-radius: 10px; padding: 8px 10px; }
.huilian-rules-confirm-text { font-size: 12px; }
.huilian-rules-confirm-yes, .huilian-rules-confirm-no, .huilian-rules-close { padding: 4px 10px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, .16); background: rgba(255, 255, 255, .08); color: inherit; font-size: 12px; cursor: pointer; }
.huilian-rules-import { display: flex; flex-direction: column; gap: 6px; }
.huilian-rules-url { padding: 7px 9px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, .14); background: rgba(255, 255, 255, .06); color: inherit; }
.huilian-rules-json { min-height: 72px; padding: 7px 9px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, .14); background: rgba(255, 255, 255, .06); color: inherit; font-family: inherit; font-size: 12px; }
.huilian-rules-url-import, .huilian-rules-json-import { align-self: flex-start; padding: 5px 10px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, .16); background: rgba(255, 255, 255, .1); color: inherit; font-size: 12px; cursor: pointer; }
.huilian-rules-url-import:disabled, .huilian-rules-json-import:disabled { opacity: .4; cursor: not-allowed; }
.huilian-rules-msg { font-size: 12px; color: #ff8b8b; min-height: 16px; }
```

Run: `node --test tests/huilian-magnet-rules-ui.test.js`
Expected: PASS，10 tests，0 fail。

若 `j)` 红在 `.huilian-result-empty` 取不到节点：那是 Step 4 的 `onChanged` 没落，或 `emptyCopy` 在回调里没重算。若 `g)` 红在 `disabled` 仍为 `true`：`syncButtons()` 绑的是 `input` 事件，测里直接改 `.value` 不会触发它——按 Step 4 之后 `renderList/renderConfirm/syncButtons` 的调用顺序查，别去改成 `change`（`input` 才是「边打边解锁」的那个）。

- [ ] **Step 6: 注册 + harness 同步**

`public/index.html` 的

```js
    "video/huilian-site-search.js",
    "video/huilian-player-bar.js",
```

改成

```js
    "video/huilian-site-search.js",
    "video/huilian-magnet-rules-ui.js",
    "video/huilian-player-bar.js",
```

`tests/helpers/huilian-harness.js` 的

```js
    'public/video/huilian-site-search.js',
    'public/video/huilian-player-bar.js',
```

改成

```js
    'public/video/huilian-site-search.js',
    'public/video/huilian-magnet-rules-ui.js',
    'public/video/huilian-player-bar.js',
```

`tests/huilian-magnet-registration.test.js` 的整条替换

```js
test('site-search 已注册且排在数据层之后、页面之前；rules-ui 此刻仍未注册（Task 9 落地才注册，防 404）', () => {
  assert.ok(at('huilian-site-search.js') >= 0, 'huilian-site-search.js 未注册进 SFV_SCRIPTS');
  assert.ok(at('huilian-magnet-source.js') < at('huilian-site-search.js'),
    'site-search 运行期取 SFV.huilianMagnetSource，必须排在它之后');
  assert.ok(at('huilian-site-search.js') < at('huilian-page.js'),
    '页面 mount 时要 create()，组件必须在 huilian-page.js 之前');
  assert.strictEqual(at('huilian-magnet-rules-ui.js'), -1);
});
```

改成

```js
test('site-search 与 rules-ui 均已注册，且都排在数据层之后、页面之前', () => {
  ['huilian-site-search.js', 'huilian-magnet-rules-ui.js'].forEach((f) => {
    assert.ok(at(f) >= 0, f + ' 未注册进 SFV_SCRIPTS');
    assert.ok(at('huilian-magnet-rules.js') < at(f), f + ' 运行期取规则模块，必须排在它之后');
    assert.ok(at(f) < at('huilian-page.js'), f + ' 要在页面 mount 前就位');
  });
  assert.ok(at('huilian-site-search.js') < at('huilian-magnet-rules-ui.js'),
    '站点搜索 create 时判 SFV.huilianMagnetRulesUi 在不在场——两个都注册后顺序无所谓，但面板不得先于组件加载');
  // Task9 评审 F7：Task 8 翻面时这条被替换掉了，必须留 pin —— site-search 运行期取 source 抓取层
  assert.ok(at('huilian-magnet-source.js') < at('huilian-site-search.js'),
    'site-search 必须排在 huilian-magnet-source.js 之后');
});
```

Run: `node --test tests/huilian-magnet-registration.test.js`
Expected: PASS，3 tests，0 fail。

- [ ] **Step 7: 回归既有汇联测**

Run: `node --test tests/huilian-queue.test.js tests/huilian-page.test.js tests/huilian-player-bar.test.js tests/huilian-css-contract.test.js tests/huilian-enqueue-mouth.test.js tests/huilian-magnet-registration.test.js tests/huilian-site-search.test.js tests/huilian-magnet-rules-ui.test.js`
Expected: 全绿，0 fail。名单以 `ls tests/huilian-*.test.js` 为准，逐个报数。

三条要特别盯的：
- `tests/huilian-site-search.test.js` 的 a) —— Task 9 给「规则」钮加了监听，若把监听写成了「立刻开面板」，a) 里 `rules: []` 场景会在 create 期就弹窗，断言当场乱。监听只在**点击时**才开面板，这条才成立。
- `tests/huilian-css-contract.test.js` —— 面板挂在 `document.body` 的 backdrop 里，契约测只走 `loadPage` 的 host 子树，采不到 `huilian-rules-*`；所以 Step 5 的样式不是被契约测逼出来的，是「渲染器与样式同批」这条规矩本身要求的（Task 7 Step 9 立的）。别因为「测不到」就省。
- `tests/huilian-enqueue-mouth.test.js` 的 g) —— harness 模块清单此刻**真有** site-search 与 rules-ui，桩靠 `opts.sfv` 覆盖，Step 6 之后合并位置仍在清单之后（Task 8 Step 6b 挪的），不该红。

- [ ] **Step 8: 提交**

```bash
git add public/video/huilian-magnet-rules-ui.js public/video/huilian-site-search.js \
        public/video/player.css public/index.html \
        tests/huilian-magnet-rules-ui.test.js tests/huilian-magnet-registration.test.js tests/helpers/huilian-harness.js
git commit -m "feat: 汇联 磁力源 Task9 — 规则导入面板（无默认地址/覆盖前确认/180 天时效）+ 搜索区接线"
```

### Task 10: 窄屏退化（§6.5 <420px）+ 样式↔DOM 契约扩到磁力渲染器

**Files:**
- Modify: `public/video/huilian-site-search.js`（`badgeNode` 把族名写进 `data-family`）
- Modify: `public/video/player.css`（补 `.huilian-rules-body` 基础规则 + 新增 `@media (max-width: 420px)` 退化带）
- Test: `tests/huilian-css-contract.test.js`（新增 d)/d2)/e) 三条，b) 报废名扩充）
- Test: `tests/huilian-site-search.test.js`（新增 l) 徽章 `data-family`）

**Interfaces:**
- Consumes：Task 2 `parseBadges` 产出的 `{family,label,cls}` 里的 **`family`**（取值固定为 `res`/`hdr`/`fps`/`codec`/`bitrate`/`audio`/`platform`/`subtitle`/`group`）；Task 8 `badgeNode`；Task 9 面板的 `.huilian-rules-body` 容器。
- Produces：DOM 面 `.huilian-badge[data-family="<family>"]`（窄屏带与 l) 都以此为准）；CSS 面 `@media (max-width: 420px)` 带（e) 以文本谓词解析它）。

**裁决 1（「超一行才裁」用 order，而不是媒体查询里再判溢出）**：CSS 量不到内容宽度，`@media` 只能按视口分档，「行放得下就全显、放不下才裁」在纯 CSS 里的可实现形式是**折行 + 固定行高 + 溢出隐藏**：徽章行给 `max-height` 和 `overflow:hidden`，低优先级族用 `order` 排到末尾，于是被挤到不可见第二行的必然是发布组，其次平台源。这满足 §6.5 的**裁剪顺序**，不保证「只在真溢出时裁」——窄屏下徽章本就少，可接受；若将来要严格「溢出才裁」，得换 `@container` + 容器查询，那是另一件事，本计划不做。

**裁决 2（`data-family` 是必需的，不是锦上添花）**：`cls` 只有三档色阶（`subtitle→accent`、`group→dim`、其余→`neutral`），平台源和分辨率/音轨全部落在 `neutral`，CSS 无法把「平台源」单独摘出来裁。族名只有 `family` 字段里有，所以必须上 DOM。l) 就是锁这一条的。

**裁决 3（静态类名清扫只做正向，且只覆盖两个新渲染器）**：证据在仓库里 —— `huilian-player-bar.js:33-38` 的 `el(tag, id, cls)` **第二个参数是 id**（`el('input','huilian-seek')` 出的是 `#huilian-seek`，样式也确按 id 写），`huilian-player-bar.js:155/184` 又用 `showPanel('huilian-degraded-panel', …)` 把类名当**第一个参数**。把它们纳入静态抽取必然要么假红要么漏采；而这两个文件的类/ id 面早已被本测 a) 的真实渲染树 + c) 的属性谓词覆盖。**正向清扫的范围因此限定为 `el(tag, cls, text)` / `setAttribute('class', …)` / `cls: …` 三种一等写法，且只扫 site-search 与 rules-ui**；反向只在窄屏带内做「带内类名必须宽屏已声明」（e) 末段），不做全站孤儿规则清扫——同一个原因。

**易错点**：
1. **`d)` 首跑必须是红的，且红得有名字**：Task 9 落地的样式带**确实漏了** `.huilian-rules-body`（本计划在树上做机器核验时抓到：渲染器输出该类名，`player.css` 全文没有 `.huilian-rules-body`）。所以 d) 不是重言式，它一上来就抓到了一处「渲染出一个无样式节点」。别为了让 d) 首跑绿而删掉这条断言。
2. **`'huilian-badge--' + cls` 是拼接前缀，抽取时必须丢掉**：它以 `--` 结尾，字面量本身不是类名，留在清扫集合里必然假红。modifier 面交给 d2) 用 `FAMILY_CLASS` 双向锁。
3. **`max-height` 必须是**带 px 的具体值**，不能写 `1lh`/`auto`：e) 断言的是「有一个可比较的行高上限」，`auto` 等于没裁。
4. **order 三段都要写在带内**：`.huilian-badge`（常规）< `[data-family="platform"]` < `[data-family="group"]`。只写后两条时常规徽章 order 默认 0，仍排在最前，结论不变，但 e) 要的是**显式三级**——少一级就意味着以后加族时会插队。
5. **窄屏带只补「退化」需要的声明**：别在带里重排整张卡（§6.5 只有三句话），也别顺手改宽屏规则；宽屏规则变了会连带 a) 的渲染树断言，那是 Task 8 的地盘。
6. **清扫类测必须自证「抽到了东西」**：`rendererClasses` 靠正则读源码，正则一旦对某文件失配就返回空集，`forEach` 空集 = 零断言 = 绿。d) 因此先钉总数下限（实测 56）与每文件下限（site-search 31 / rules-ui 24），再逐条查 CSS。写这类「扫文本比对」的测不带下限，等于没测。

- [ ] **Step 1: 先写失败测试**

在 `tests/huilian-css-contract.test.js` 末尾追加（改前锚点 = 该文件 c) 的最后三行）：

```js
  ['#huilian-toggle', '#huilian-seek', '#huilian-vol', '#huilian-close-del', '#huilian-keep']
    .forEach((sel) => assert.ok(t.doc.querySelector(sel), '播控条缺少 ' + sel));
});
```

改后 = 锚点原样保留 + 追加：

```js
  ['#huilian-toggle', '#huilian-seek', '#huilian-vol', '#huilian-close-del', '#huilian-keep']
    .forEach((sel) => assert.ok(t.doc.querySelector(sel), '播控条缺少 ' + sel));
});

/* ---- Task10：样式↔DOM 契约扩到磁力渲染器 + 窄屏带谓词 ---- */

/**
 * 渲染器一等类名抽取。只认 el(tag, cls, …) / setAttribute('class', …) / cls: … 三种写法，
 * 且只用于 site-search 与 rules-ui —— 裁决 3：player-bar 的 el(tag, id, cls) 与
 * showPanel('huilian-x', …) 会让静态抽取要么假红要么漏采，那两个文件交给 a)/c)。
 */
const CLASS_PATTERNS = [
  /\bel\(\s*'[a-z]+'\s*,\s*'([^']+)'/g,
  /\.setAttribute\(\s*'class'\s*,\s*'([^']+)'/g,
  /\bcls:\s*'([^']+)'/g,
];
function rendererClasses(rel) {
  const s = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const out = new Set();
  CLASS_PATTERNS.forEach((re) => {
    let m;
    while ((m = re.exec(s)) !== null) {
      m[1].split(/[\s,'"]+/).filter(Boolean).forEach((tok) => {
        // 拼接前缀（'huilian-badge--'）不是类名，modifier 面由 d2) 单独锁
        if (/^huilian-[a-z0-9_-]+$/.test(tok) && !/--$/.test(tok)) out.add(tok);
      });
    }
  });
  return out;
}

test('d) 站点搜索区与规则面板输出的每个 huilian 类名在 player.css 都有规则', () => {
  const css = cssRules();
  const files = ['public/video/huilian-site-search.js', 'public/video/huilian-magnet-rules-ui.js'];
  const per = files.map((f) => ({ f: f, cls: rendererClasses(f) }));
  // 先自证抽取式没空转：抽取式一旦失配，本条会「零输出即通过」，那是最坏的假绿
  const total = new Set();
  per.forEach((p) => p.cls.forEach((c) => total.add(c)));
  assert.ok(total.size >= 50, '两个渲染器合计只抽到 ' + total.size + ' 个类名，抽取式失效了');
  per.forEach((p) => assert.ok(p.cls.size >= 15, p.f + ' 只抽到 ' + p.cls.size + ' 个类名（抽取式对该文件失效）'));
  per.forEach((p) => p.cls.forEach((c) => assert.ok(css.indexOf('.' + c) >= 0,
    p.f + ' 会输出 .' + c + '，但 player.css 没有对应规则（渲染出一个无样式节点）')));
});

test('d2) 徽章 modifier 与 enrich 的 FAMILY_CLASS 双向锁死', () => {
  const css = cssRules();
  const enrichSrc = fs.readFileSync(path.join(__dirname, '..', 'public/video/huilian-magnet-enrich.js'), 'utf8');
  const map = /var FAMILY_CLASS = \{([^}]*)\}/.exec(enrichSrc);
  assert.ok(map, 'huilian-magnet-enrich.js 里找不到 FAMILY_CLASS（d2) 的前提）');
  const mods = new Set(['neutral']);                      // mkBadge 的兜底档
  for (const pair of map[1].matchAll(/:\s*'([a-z0-9_-]+)'/g)) mods.add(pair[1]);
  mods.forEach((v) => assert.ok(css.indexOf('.huilian-badge--' + v) >= 0,
    'enrich 会产出 .huilian-badge--' + v + '，player.css 没有该 modifier'));
  for (const dead of css.matchAll(/\.huilian-badge--([a-z0-9_-]+)/g)) {
    assert.ok(mods.has(dead[1]),
      'player.css 有 .huilian-badge--' + dead[1] + '，但 enrich 不再产出（死样式）');
  }
});

/** 取 @media (max-width: 420px) 的块体（大括号配对，块内允许嵌套一层）。 */
function narrowBand(css) {
  const at = css.indexOf('@media (max-width: 420px)');
  assert.ok(at >= 0, 'player.css 缺 @media (max-width: 420px) 窄屏带（§6.5 一条没落地）');
  const open = css.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) { end = i; break; }
  }
  assert.ok(end > open, '@media (max-width: 420px) 大括号不配对');
  return css.slice(open + 1, end);
}

/** 带内 选择器 → 声明文本（逗号组的选择器分别登记，同一选择器多块合并）。 */
function bandRules(band) {
  const map = {};
  let m;
  const re = /([^{}]+)\{([^{}]*)\}/g;
  while ((m = re.exec(band)) !== null) {
    m[1].split(',').map((s) => s.trim()).filter(Boolean)
      .forEach((sel) => { map[sel] = (map[sel] || '') + ';' + m[2]; });
  }
  return map;
}

test('e) 窄屏带（<420px）：摘要 ellipsis、展开钮不掉出视口、徽章按发布组→平台源顺序裁', () => {
  const css = cssRules();
  const band = narrowBand(css);
  const R = bandRules(band);
  const need = (sel, ...props) => {
    assert.ok(R[sel], '窄屏带缺选择器 ' + sel);
    props.forEach((p) => assert.ok(R[sel].indexOf(p) >= 0, sel + ' 需要声明「' + p + '」'));
  };
  // §6.5 第一句：卡头摘要行可截断
  need('.huilian-work-title', 'text-overflow: ellipsis', 'overflow: hidden', 'white-space: nowrap');
  need('.huilian-work-sub', 'text-overflow: ellipsis', 'overflow: hidden');
  need('.huilian-work-info', 'min-width: 0');   // 没有它 flex 子项不肯收缩，ellipsis 永远不触发
  // §6.5 第二句：展开钮不换行不掉出视口
  need('.huilian-work-head', 'flex-wrap: nowrap');
  need('.huilian-work-toggle', 'flex: 0 0 auto', 'white-space: nowrap');
  // §6.5 第三句：徽章超一行先裁发布组、再裁平台源（裁决 1 的 order 形式）
  need('.huilian-version-badges', 'flex-wrap: wrap', 'overflow: hidden', 'max-height:');
  const order = (sel) => {
    const m = /order:\s*(\d+)/.exec(R[sel] || '');
    assert.ok(m, '窄屏带缺 ' + sel + ' 的显式 order（§6.5 的裁剪优先级要靠它表达）');
    return Number(m[1]);
  };
  assert.ok(order('.huilian-badge[data-family="group"]') > order('.huilian-badge[data-family="platform"]'),
    '发布组必须比平台源更靠后（先被挤掉）');
  assert.ok(order('.huilian-badge[data-family="platform"]') > order('.huilian-badge'),
    '平台源必须比常规徽章更靠后');
  // 反向：带内类名必须宽屏已声明 —— 窄屏带打错类名不会报错，只会静默失效
  for (const m of band.matchAll(/\.huilian-[a-z0-9_-]+/g)) {
    const cls = m[0].slice(1);
    assert.ok(css.slice(0, css.indexOf(band)).indexOf('.' + cls) >= 0 ||
      css.slice(css.indexOf(band) + band.length).indexOf('.' + cls) >= 0,
      '窄屏带引用了 .' + cls + '，但宽屏没有任何规则声明它（打错名或漏了基础样式）');
  }
});
```

在 `tests/huilian-site-search.test.js` 末尾追加（改前锚点 = k) 的最后三行）：

```js
  assert.ok(row.textContent.indexOf('<img src=x onerror=alert(1)>') >= 0,
    '原文必须逐字可见，清洗只做在一侧');
});
```

改后 = 锚点保留 + 追加：

```js
  assert.ok(row.textContent.indexOf('<img src=x onerror=alert(1)>') >= 0,
    '原文必须逐字可见，清洗只做在一侧');
});

test('l) 版本徽章带 data-family（§6.5 按族裁剪的选择器前提，裁决 2）', async () => {
  const badge = (family, label, cls) => ({ family: family, label: label, cls: cls });
  const ver = (btih, name, badges) => ({
    rawMagnet: 'magnet:?xt=urn:btih:' + btih,
    magnet: 'magnet:?xt=urn:btih:' + btih,
    name: name, size: { text: '1GB', bytes: gb(1) }, allBadges: badges,
  });
  // 手写徽章：只锁「family 有没有上 DOM」，不依赖 enrich 的取值
  // res 两行同值 → 会被恒定值上提从行内移除，正好用来确认卡头不产徽章节点
  const res = badge('res', '1080P', 'neutral');
  const t = buildEnv({
    source: (made) => ({
      MAX_CONCURRENCY: 2,
      fetchWorks: () => Promise.resolve({ ok: true, value: made.works }),
      fetchVersions: () => Promise.resolve({ ok: true, value: [
        ver('1'.repeat(40), 'v1', [res, badge('platform', 'YK', 'neutral'), badge('group', 'QuickIO', 'dim')]),
        ver('2'.repeat(40), 'v2', [res, badge('group', 'NovaGRP', 'dim')]),
      ] }),
    }),
  });
  await search(t, '阿嬷');
  fire(t.q('.huilian-work-toggle'), 'click');
  await t.flush();
  const bs = t.all('.huilian-version-row .huilian-badge');
  assert.strictEqual(bs.length, 3, '前置：行内应显 platform+2×group（res 恒定已上提卡头）');
  bs.forEach((b) => assert.ok(b.getAttribute('data-family'),
    '徽章缺 data-family，窄屏带无法按族裁剪：' + b.textContent));
  assert.ok(bs.some((b) => b.getAttribute('data-family') === 'group'), '发布组要标 group');
  assert.ok(bs.some((b) => b.getAttribute('data-family') === 'platform'), '平台源要标 platform');
  assert.strictEqual(t.all('.huilian-work-badges .huilian-badge').length, 0,
    '卡头恒定值是纯文本，不该混进徽章节点');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/huilian-css-contract.test.js tests/huilian-site-search.test.js`
Expected: FAIL 三处，且理由各不相同 ——
  1. `d)` 红在 `public/video/huilian-magnet-rules-ui.js 会输出 .huilian-rules-body，但 player.css 没有对应规则`（易错点 1：这是 Task 9 的真漏，不是本测写坏了）；
  2. `e)` 红在 `player.css 缺 @media (max-width: 420px) 窄屏带`；
  3. `l)` 红在 `徽章缺 data-family…`。
`d2)` 此刻应当已经是绿的（Task 8 的样式带已含 `--accent/--dim/--neutral` 三档）——**它绿不代表测没作用**，它防的是以后往 `FAMILY_CLASS` 加档不改 CSS。若 `d2)` 也红，说明 Step 1 抄错了 modifier 名，先回去核对，别急着补 CSS。

- [ ] **Step 3: `badgeNode` 把族名写上 DOM（`public/video/huilian-site-search.js`）**

改前（锚点，全文唯一）：

```js
  function badgeNode(b) {
    var n = el('span', 'huilian-badge huilian-badge--' + ((b && b.cls) || 'neutral'), b && b.label);
    return n;
  }
```

改后：

```js
  function badgeNode(b) {
    var n = el('span', 'huilian-badge huilian-badge--' + ((b && b.cls) || 'neutral'), b && b.label);
    // 族名必须上 DOM：cls 只有三档色阶（subtitle→accent、group→dim、其余→neutral），
    // 平台源和分辨率/音轨全挤在 neutral，窄屏带无法只裁平台源（§6.5 / 裁决 2）
    n.setAttribute('data-family', (b && b.family) || 'other');
    return n;
  }
```

- [ ] **Step 4: `player.css` 补漏 + 窄屏带**

改前（锚点 = Task 9 样式带的最后一行，全文唯一）：

```css
.huilian-rules-msg { font-size: 12px; color: #ff8b8b; min-height: 16px; }
```

改后：

```css
.huilian-rules-msg { font-size: 12px; color: #ff8b8b; min-height: 16px; }
.huilian-rules-body { display: flex; flex-direction: column; gap: 8px; }   /* Task9 渲染器输出它，样式带到 Task10 才补齐 */

/* ---- 窄屏退化（§6.5，<420px）----
   摘要行截断；展开钮不换行不掉出视口；版本徽章「超一行才裁」用折行 + 固定行高 +
   overflow:hidden 实现，低优先级族靠 order 排到末尾，被挤进不可见第二行的必然是
   发布组 → 平台源 → 其余（裁决 1：CSS 量不到内容宽度，媒体查询只按视口分档）。 */
@media (max-width: 420px) {
  .huilian-work-head { flex-wrap: nowrap; gap: 8px; }
  .huilian-work-info { flex: 1 1 auto; min-width: 0; }
  .huilian-work-title, .huilian-work-sub, .huilian-work-badges {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .huilian-work-toggle { flex: 0 0 auto; white-space: nowrap; }
  .huilian-version-name { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .huilian-version-badges { flex-wrap: wrap; align-content: flex-start; max-height: 20px; overflow: hidden; }
  .huilian-badge { order: 10; }
  .huilian-badge[data-family="platform"] { order: 20; }
  .huilian-badge[data-family="group"] { order: 30; }
}
```

`flex: 0 0 auto` 在带内重申一次是有意的（易错点 5 的例外）：宽屏下按钮掉出来无所谓，窄屏下它必须既不缩也不折，写进带里才随带一起被 e) 检查到。

- [ ] **Step 5: 复核旧选择器清桩面（b) 段扩充三个防回流名）**

改前（锚点）：

```js
    'huilian-list-area', 'huilian-empty', 'huilian-grid', 'huilian-player-area',
  ];
```

改后：

```js
    'huilian-list-area', 'huilian-empty', 'huilian-grid', 'huilian-player-area',
    // 本计划起草期用过、随后改名的写法：防渲染器回退到旧名而 CSS 只剩新名
    'huilian-work-item', 'huilian-rule-row', 'huilian-badge-gold',
  ];
```

- [ ] **Step 6: 跑绿 + 全量回归**

Run: `node --test tests/huilian-css-contract.test.js tests/huilian-site-search.test.js`
Expected: PASS（css-contract 6 条、site-search 12 条）
Run: `node --test $(ls tests/huilian-*.test.js tests/source-picker-magnet-row.test.js tests/detail-source-magnet-partition.test.js | tr '\n' ' ')`
Expected: PASS。改动面只有 CSS 与 `badgeNode` 的一行属性，回归重点是 a) 的渲染树清扫（CSS 基础带被动过）与 Task 8/9 的文案测（`badgeNode` 加了属性）。

- [ ] **Step 7: 提交**

```bash
git add public/video/huilian-site-search.js public/video/player.css \
        tests/huilian-css-contract.test.js tests/huilian-site-search.test.js
git commit -m "feat: 汇联 磁力源 Task10 — 窄屏退化带（§6.5）+ 徽章 data-family 与样式↔DOM 契约扩展"
```

---

### Task 11: 全量回归 + §9 合规红线机器自查 + 真机冒烟清单

**Files:**
- Create: `docs/superpowers/plans/2026-10-01-huilian-magnet-site-smoke-checklist.md`
- Modify: **无**（本任务不碰任何代码/样式；若自查暴露问题，回到对应任务改，不在这里打补丁）

**Interfaces:**
- Consumes: Task 1–10 合并后的最终树（含 `tests/fixtures/` 两份脱敏件）
- Produces: ①`npm test` 全量结论；②§9 七条红线的可复查 grep 组（本计划落笔前已在「从计划正文抽出的模块文本」上预跑过，见各步「预验记录」）；③面向真机的冒烟清单，把 spec §10 的 8 条未知项逐条落成勾项

**裁决 1：全量测试的判据是相对不变量，不是绝对数字。**
`npm test` = `node tests/run-all.js`，它按字典序串行 spawn `tests/*.test.js` 下每个文件（单文件 90s 超时、`CI=1`），退出码即判据。仓库基线是 **148/149，唯一失败 = watch-history 的 D1 存量问题**（与磁力无关，见项目记忆「Pre-existing test failures」）。本计划新增 8 个测文件后，通过判据写成：
`fail 数 == 1` **且** 那条失败行里含 `watch-history`。除此之外的任何失败（包括「数字看着差不多」）都是回归。不修改 `tests/run-all.js`，也不为新测加白名单。

**裁决 2：`tests/fixtures/pomo-*.html` 的文件名保留站点名，内容零站点指纹。**
spec §8 逐字点名这两个文件名，故不擅自改名；同时：
- 真实选择器 `a.x-dbjs-download-link` 在 fixture 与规则样例里一律换成合成的 `a.magnet-link`；
- host 一律 `example.test`，图片域 `images.example`，tracker 只有 `udp://tracker.example.test:2710/announce`；
- btih 一律 `'0'×38 + 两位序号`，14 个全伪造、不可下载；
- `package.json` 的 `build.files` 是白名单（实测条目：`desktop/**/*`、`public/**/*`、`build/**/*`、`cuefield/**/*`、`server.js`、`*-api.js` …），**不含 `tests/**`** → fixture 只进仓库、不进安装包。
代价：仅凭文件名可知「参考过哪个站」，但拿不到任何可执行的解析规则。若日后要求连文件名也不留，改名只需同步 4 处：生成器的两行 `writeFileSync`、Task 4 测里的两处 `read('tests/fixtures/…')`、以及本任务清单文档里的引用。

**裁决 3：grep 自查跑在最终树上，且用「文件集合」而不是 `git diff`。**
`git diff` 的行号会随 Task 10 回改 `badgeNode` 而漂移；Task 10 之后 `huilian-site-search.js` 才是终态。因此红线 grep 一律按文件枚举，不按提交范围。唯一按范围跑的是「越界改动」检查（h 项），它天然需要 range，用 SDD 台账里记的开工 BASE。

**易错点**
1. **不要用管道吞退出码**：`npm test | head` 之后你看到的是 `head` 的 0。要么完整跑完看结尾摘要，要么 `npm test > /tmp/t.log 2>&1; echo $?`（本仓库历史上被这个坑过两次）。
2. **grep 的「预期为空」和「预期只有 N 条注释」要分清**：e 项（proxy 编码）不是空集检查——两处 `/api/proxy?url=` 是**应有**代码，检查的是它们都带 `encodeURIComponent`。把预期写成「空」会在实现正确时误报。
3. **fixture 要先生成再 grep**：`tests/fixtures/*.html` 是生成产物（Task 4 Step 1）。忘记跑生成器时 `grep -o … tests/fixtures/*.html` 会以「no such file」退出，看起来像「检查通过」。Step 3 把生成和检查写在同一条命令里，就是为了不让两者脱钩。
4. **凭据文件只读取、不打印**：Step 5 的取证命令把口令放在 shell 变量里，输出里只有 hash 前 8 位与 `url`/`magnet_uri`。磁力串含真实 btih，属于「本地看、不进仓库」的内容——把它贴进 issue/日志即撞 §9.4 的精神。
5. **`ls` 对不存在的显式路径只报警不中断**：`ls tests/a.test.js tests/typo.test.js` 仍会把 `a.test.js` 打进 `$(…)`，`node --test` 照样绿——拼错的测文件从此不在回归集合里，且没有任何一行输出提示你。本计划自查时就在 Task 10 Step 6 撞上这个形状（写成了 `detail-source-magnet.test.js`，真名 `detail-source-magnet-partition.test.js`），已改正。凡用 `ls` 组回归集合，跑完要 `| wc -l` 对数量（Step 1 的核对式即为此）。

- [ ] **Step 1: 跑全量回归**

```bash
npm test > /tmp/huilian-magnet-full.log 2>&1; echo "exit=$?"
tail -n 25 /tmp/huilian-magnet-full.log
grep -nE "^✖|not ok|FAIL" /tmp/huilian-magnet-full.log
```
Expected:
- `exit=0` **或** `exit=1` 且失败仅 watch-history 一条（裁决 1）；
- 本计划涉及 **11 个测文件 = 9 新建 + 2 扩既有**，必须全部出现在 pass 侧。
  新建：`huilian-magnet-enrich`、`huilian-magnet-rules`、`huilian-magnet-source`、`huilian-magnet-registration`、
  `source-picker-magnet-row`、`detail-source-magnet-partition`、`huilian-enqueue-mouth`、`huilian-site-search`、`huilian-magnet-rules-ui`（文件名均为 `tests/<名>.test.js`）；
  扩既有：`huilian-queue.test.js`（Task 1）、`huilian-css-contract.test.js`（Task 10）。
  核对式：`ls tests/huilian-magnet-*.test.js tests/huilian-site-search.test.js tests/huilian-enqueue-mouth.test.js tests/source-picker-magnet-row.test.js tests/detail-source-magnet-partition.test.js | wc -l` → **9**。
- 总耗时按 90+ 文件、单文件上限 90s 估，**3–6 分钟属正常**，不要中途判死。

- [ ] **Step 2: §9 七条红线的 grep 自查**

逐条跑，每条后面写明「预期」。所有命令在仓库根目录执行。
`FILES5` = 五个新模块：`public/video/huilian-magnet-enrich.js public/video/huilian-magnet-rules.js public/video/huilian-magnet-source.js public/video/huilian-site-search.js public/video/huilian-magnet-rules-ui.js`

```bash
FILES5="public/video/huilian-magnet-enrich.js public/video/huilian-magnet-rules.js public/video/huilian-magnet-source.js public/video/huilian-site-search.js public/video/huilian-magnet-rules-ui.js"
```

**a) 零内置规则（§9.1）— 预期：无输出**

```bash
grep -n "udp://\|x-dbjs\|pomo\|keyword=\|\.mom\b" $FILES5
```
> 预验记录（有来源）：把计划正文里这 5 个模块的实现块抽成临时文件后跑同一条命令，结果 **EMPTY**。
> 命中的任一形态都意味着规则/站点指纹写回了代码：`udp://` = tracker 清单、`x-dbjs` = 真实选择器、`pomo`/`.mom` = 真实域名、`keyword=` = 真实查询参数名。
> **范围声明（这条 grep 查不到的部分，需用户定夺）**：红线只管**代码与安装包**，本计划的 `FILES5` 即按此界定。但 spec 文档自身（`docs/superpowers/specs/…-design.md` §3.1 的 schema 示例）写着真实 `origin: https://pomo.mom`、`search.php?search={query}&pjax=1`、`magnetAttr: 'data-url'` —— 这是**一份可执行的规则**。它不进安装包（`build.files` 白名单里没有 `docs/`，实测只带 `docs/THIRD_PARTY_PORTS.md`），但**在仓库里**，而本仓库经网盘公开分发。是否要把 spec 的示例改成假 host，属用户对「零内置」口径的裁定，本计划不擅自动已过审阅的 spec（已记进文末修订清单第 26 条）。

**b) kazumi 目录与 desktop 零改动（决策台账 D1 / §0 范围）— 预期：无输出**

```bash
BASE=<SDD 台账第一行记的开工 BASE>   # 开工前 `git rev-parse HEAD`，不是 HEAD~1
git diff --name-only "$BASE"..HEAD | grep -E "^desktop/|^public/video/kazumi/|^package(-lock)?\.json$|^public/js/"
```
> 这是全计划唯一按 range 跑的检查（裁决 3）。BASE 必须是本计划第一个任务派发前记下的那个 commit；用 `HEAD~1` 会静默丢掉多 commit 任务的大部分改动。
> `^public/js/` 一并拦：碰了 `index-loader.js` 的 `modulePaths` 却不同步跑 `npm run bundle`，是本项目已知的静默劣化路径。

**c) 入队参数最小化（§9.3）— 预期：无输出**

```bash
grep -n "headers\|Cookie\|cookie\|X-Requested-With" $FILES5 public/video/huilian-page.js public/video/huilian-queue.js
grep -n "addTorrent(" public/video/*.js
```
> 预验记录（有来源）：5 个模块上跑第一条 **EMPTY**；`huilian-page.js` / `huilian-queue.js` 现状也 grep 不到 `headers`/`password`。
> 第二条是「定位唯一入队口」：`addTorrent(` 在 `public/video/` 下应当只出现在 `huilian-page.js` 的 `submitParams` 链路里（Task 7 的 `SFV.huilianEnqueue` 也走它）。多出任何一处调用点都是绕口。
> 注意别误伤：抓取侧的浏览器特征头在 `public/video/kazumi/http-client.js` 里，那是 b 项要求**不许改**的文件，不在本条检查范围（抓取带 UA/Origin 是代理侧既有行为；§9.3 禁的是把这些转给下载内核）。

**d) 凭据不外泄（§9.2）— 预期：无输出**

```bash
grep -n "password\|username\|huilian-qbt-cred" $FILES5
```
> 预验记录：**EMPTY**。磁力层根本不碰凭据；打印点若出现只可能在 desktop 侧，而 b 项已保证 desktop 零改动。

**e) 抓取 origin 白名单 + proxy 编码（§9.6）— 预期：第一条 2 行、第二条无输出**

```bash
grep -rn "api/proxy?url=" public/video/huilian-*.js
grep -rn "api/proxy?url=" public/video/huilian-*.js | grep -v encodeURIComponent
```
> 预验记录（有来源）：抽出模块文本跑，第一条命中恰 2 处——`huilian-magnet-source.js` 的 `proxySrc`、`huilian-magnet-rules.js` 的 `importFromUrl` 回退 `fetch`；两处都已 `encodeURIComponent`，第二条 **EMPTY**。
> 计数从 2 变成 3 以上时，先去看新那处是不是第三跳转发（海报、缩略图、二次代理），别直接放过。

**f) fixture 脱敏（§9.4）— 预期：Step 3 的脚本自证**
见下一条命令块（生成 + 校验不可分离）。

**g) 渲染红线：innerHTML 只许清空（§8）— 预期：无输出**

```bash
grep -nE "innerHTML" $FILES5 | grep -vF "innerHTML = ''" | grep -vE ":[[:space:]]*(\*|//)"
```
> 预验记录（有来源）：**EMPTY**（剥掉两条注释与两处 `= ''` 清空后不剩）。发布名是站点给的不可信文本，任何 `innerHTML = <变量>` 都是 DOM 注入面。

**h) magnet 注入防护（§9.5）— 人查 + 测锁，grep 只能查「重复实现」**

```bash
grep -rn "urn:btih:" public/video/*.js | grep -v "huilian-queue.js"
grep -rn "length === 40\|{40}" public/video/huilian-magnet-*.js public/video/huilian-site-search.js
```
> 预期：两条都**无输出**。全仓唯一 btih 解析/归一实现必须是 `huilian-queue.js` 的 `extractBtih`（Task 1）；第二条查的是「有人又写了一遍 40 位长度校验」——那正是 §9.5 要避免的重复解析点。
> 注：`huilian-magnet-enrich.js` 拼 tracker 时会出现字面量 `&tr=`，那是**构造**入队串不是**解析**，不在本条范围。

- [ ] **Step 3: 生成 fixture 并当场复核脱敏（f 项）**

```bash
node tests/fixtures/make-pomo-fixtures.js && \
grep -hoE "btih:[0-9a-fA-F]{40}" tests/fixtures/*.html | sed 's/^btih://' | sort -u | grep -vE "^0{38}[0-9]{2}$" ; \
echo "non-synthetic-btih-count=$(grep -hoE 'btih:[0-9a-fA-F]{40}' tests/fixtures/*.html | sed 's/^btih://' | sort -u | grep -vcE '^0{38}[0-9]{2}
)"
```
Expected:
- 生成器打印 `anchors=42 uniqueBtih=14 searchCards=3`；
- 中间那条过滤命令**无输出**；
- 末行 `non-synthetic-btih-count=0`。
> 预验记录（有来源）：已把计划里的生成器代码原样跑过一遍，输出正是上述三项，且产物中 `udp://` = false、`x-dbjs` = false、`pomo.mom` = false、任意 `.mom` 域 = false，唯一 btih 恰 14 个且全形如 `0…0NN`。

- [ ] **Step 4: 写真机冒烟清单**

创建 `docs/superpowers/plans/2026-10-01-huilian-magnet-site-smoke-checklist.md`，全文如下（照抄，勾项不得删减；§10 的每条未知项都在里面有对应勾项）：

> 下面四反引号整块是**要落盘的文档正文**：其中的 `- [ ]` 属于清单文档自身的内容，不是本计划的执行步骤（本计划的可跟踪步骤只有 Step 1–6）。用四反引号包裹是因为块内含三反引号代码块。

````markdown
# 汇联 磁力站点源 — 真机冒烟清单（本计划 Task11 交付）

> 适用：Windows 桌面版（`npm start` 或打包 exe）。浏览器 :3000 只用来验第 11 节的降级态。
> 前置：Task1–10 全部落点已合并；`npm test` 相对不变量已满足（Task11 Step1）；
> qBittorrent WebUI（默认 127.0.0.1:8080）与 mpv 就位；**远端规则 JSON 地址由用户自备**
> （§9.1 红线：应用内不预置任何默认地址，所以第 1 节没地址就无法继续——这是设计如此，不是缺陷）。
> 任何一条不符即视为回归：记现场截图 + `%APPDATA%\Stellaflix` 下相关日志。磁力串含真实 btih，
> 取证输出只在本机看，不得贴进仓库/issue/日志。

## 0. 零内置基线（先确认「什么都没带」）

- [ ] 0.1 全新 profile（改名或删除 `%APPDATA%\Stellaflix\Local Storage`，或直接换一台机器）首启，进汇联页 → 搜索行置灰、只显队列区，文案逐字 `未导入磁力站点规则。点搜索行的「规则」从远端一键导入。`
- [ ] 0.2 「规则」面板里 URL 输入框为**空**（无占位默认地址、无下拉建议项）。
- [ ] 0.3 详情页某条目 → **没有**磁力分区（§5.1 的分区出现与否严格跟随「有启用规则」）。

## 1. 规则导入（§6.6，唯一规则来源）

- [ ] 1.1 从 URL 导入用户自备 JSON → 列表出现规则行：`名称 · origin · 启用开关 · 删除`，行尾带 `tracker {N} 条 · 导入于 {YYYY-MM-DD}`（日期取**本机导入当天**，不是远端 JSON 里的字段）。
- [ ] 1.2 刚导入的规则**不得**显示时效提示 `tracker 清单可能已失效，重新导入以提升出种率。`（超 180 天才显；180 天阈值本身是拍的，见 §10，本项只锁「刚导入不显」）。
- [ ] 1.3 整条拒绝：导入一份缺 `magnetItemXPath` 的 JSON → 文案逐字 `规则格式不符：缺少 magnetItemXPath。未导入任何内容。`，且列表**行数不变**（不允许部分落盘）。
- [ ] 1.4 越界 host 拒绝：`searchURL` 或任一 `workFields.*` 的 host 与声明 `origin` 不符 → 同 1.3 的模板拒绝。
- [ ] 1.5 粘贴 JSON 路径与 URL 路径走同一校验：粘贴 1.3 的坏 JSON 得到同一文案。
- [ ] 1.6 同 `id` 再次导入 → 覆盖前显示差异并要求确认；确认后行数不增。
- [ ] 1.7 停用即时生效：关某条规则的开关 → 汇联页搜索立即报「无启用规则」态、详情页磁力分区消失（不需要重启/刷新）。重新开启即恢复。
- [ ] 1.8 删除二次确认：第一次点击变「确认删除？」，再点才真删；点面板其它区域后确认态取消。
- [ ] 1.9 tracker 条数上限：导入条数超限的清单 → 整条拒绝（不截断导入）。
- [ ] 1.10 全程控制台、错误条、`%APPDATA%\Stellaflix` 日志中不得出现 qbt 口令（§9.2）。

## 2. 搜索与作品卡（§6.1 / §6.2）

- [ ] 2.1 有关键词搜索 → 出作品横卡：海报（经 `/api/proxy`）、中文标题、英文原名、年份。
- [ ] 2.2 分页：本设计**只取首页**（§10 未破解分页）。结果多于首页时不得出现「看起来是全部」的误导文案；无「下一页」入口属预期。
- [ ] 2.3 0 结果 → 文案逐字 `没找到与「{关键词}」匹配的分享。`，空态卡而非整页 loading。
- [ ] 2.4 站点 4xx/5xx → `站点无响应（{status}）。稍后再试或换一个规则。` + 重试钮；拔网线/停代理 → `本地服务未就绪，无法抓取站点。`
- [ ] 2.5 超时 → 同模板、`{status}` 位置填字面量 `超时`。
- [ ] 2.6 并发上限 2：连点展开 5 个作品 → 同时进行的抓取不超过 2（Network 面板或日志计数），其余排队且不重复请求。
- [ ] 2.7 越界链接：卡片详情链指向非规则 origin → 该卡丢弃且**不发起**抓取（origin 白名单，§9.6）。

## 3. 就地展开、版本与徽章（§6.3 / §6.4）

- [ ] 3.1 点作品卡展开 → 行内 `读取版本…` 骨架，不整页 loading；完成后版本行出现（42 锚点去重为 14 条的唯一形态在真机上复现）。
- [ ] 3.2 恒定值归约：某作品全部版本都是 `2160p` → 分辨率徽章出现在**作品头**（`.huilian-work-badges`）而非每条版本行；掺进一条 `1080p` 后退回行内。
- [ ] 3.3 徽章族可辨：平台源（WEB-DL/BluRay…）与分辨率/音轨在窄屏下的裁剪次序为「先裁发布组，再裁平台源」（§6.5，见第 10 节）。
- [ ] 3.4 体积：`[26.76GB]` 方括号被剥掉并作为主排序键（降序），不是字符串序（`9.88GB` 应排在 `26.76GB` 之后）。
- [ ] 3.5 筛选生效 → 命中作品自动全展开；清空筛选 → 回到手风琴态。
- [ ] 3.6 `dn=`/文件名清洗：站点给的名称含换行或引号时不破坏 DOM 与入队串（§9.5）。

## 4. 入队（唯一口，§4 数据流 + §5 第 4/5 条 / §9.3）

- [ ] 4.1 点版本行「入队」→ 队列区出现该任务行（灰色虚化「新任务（等待元数据）」→ 元数据就绪 ≤2s 换成真实任务行）。
- [ ] 4.2 入队串形状：任务行的 magnet 里应有规则声明的 `&tr=`，且**没有**站点 Cookie/会话头字段（§9.3；DevTools 里看 IPC 参数，只有 `{url}` 通道）。
- [ ] 4.3 同 btih 重复入队（含「同一磁力、tracker 顺序不同」的变体）→ 文案逐字 `已在队列中。` 并跳转高亮定位，不重复入队。**这条是认领第二路的第一道证据。**
- [ ] 4.4 入队失败（停掉 qbt 再点）→ `加入下载队列失败：{reason}`，错误条红色占行，无静默。
- [ ] 4.5 无 btih 的伪磁力串（手改 DOM 或走旧直链入口）→ 被 `extractBtih` 判 null 拒入队，不产生幽灵任务行。

## 5. matchHash 第二路取证（§10 的核心未知项，必过）

> 第二路（btih 归一）目前是纸面推演。取证前**不得**删掉「整串相等」那一路——删了会把现有直链粘贴流程一起拖下水。

- [ ] 5.1 用第 4 节入队一条**带 3 个 `&tr=`** 的磁力，等它出现在 qbt 里。
- [ ] 5.2 读 qbt 侧的形状（口令只进 shell 变量，不打印；403 时按提示补 CSRF 头再试）：

```bash
CRED="$APPDATA/Stellaflix/huilian-qbt-cred.json"
U=$(node -e "console.log(require(process.env.APPDATA+'/Stellaflix/huilian-qbt-cred.json').username)")
P=$(node -e "const c=require(process.env.APPDATA+'/Stellaflix/huilian-qbt-cred.json');process.stdout.write(c.password)")
curl -s -c /tmp/qb.jar -X POST "http://127.0.0.1:8080/api/v2/auth/login" --data-urlencode "username=$U" --data-urlencode "password=$P"
curl -s -b /tmp/qb.jar "http://127.0.0.1:8080/api/v2/torrents/info" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);(Array.isArray(a)?a:[]).forEach(t=>console.log(t.hash.slice(0,8),'| url=',t.url,'\n         | magnet_uri=',t.magnet_uri))})"
```
  预期并把实际值记进本节末尾：`url` / `magnet_uri` 各自长什么样；我们拼进去的 `&tr=` 序列是否**逐字保留**（被 qbt 截断、去重、重排还是原样）。
- [ ] 5.3 若 `&tr=` 被 qbt 改写或只留 1 条 → 认领**必须**仍成功（第二路按 btih 命中）。成功即证明第二路有价值；失败即 §3.2 的归一假设有误，停下上报。
- [ ] 5.4 第二路在「qbt 回吐的 magnet 顺序与入队时不同」的场景下仍命中同一 hash（与 5.3 同一事实的两个方向）。
- [ ] 5.5 取证记录（本机填写）：qbt 版本 `______`；`url` 是否非空 `______`；`magnet_uri` 里 `&tr=` 条数 `______`；`&tr=` 顺序 `______`。

## 6. 详情页磁力分区与 picker（§5）

- [ ] 6.1 有启用规则时详情页出现磁力分区；无启用规则时整个分区不存在（不是空分区）。
- [ ] 6.2 分区内 `sourceKey` 稳定：反复进出详情页不产生新键、不重复抓取（会话缓存）。
- [ ] 6.3 picker 里磁力行：分组名取**站点名**，不落进 `CMS` 分支；徽章文案为「磁力」。
- [ ] 6.4 从详情页入队 → 跳到汇联页并高亮定位该任务；详情解析 0 条磁力时 → `这个条目里没有可用磁力链接。`，该行折叠标灰。
- [ ] 6.5 磁力候选**不写** playbackSession（避免污染「续播」语义）。

## 7. 边下边播与 mpv（不在本计划重复）

- [ ] 7.1 走 `2026-09-30-huilian-bt-smoke-checklist.md` 的第 4 / 5 / 6 节（overlay 跟位、DPI、播完面板、切页销毁）。
- [ ] 7.2 本计划只新增「磁力来源变了」这一维度：由站点入队的任务在可播阈值到达后，行内播放与直链粘贴任务表现一致。
- [ ] 7.3 裸 btih 注入 tracker 后的**实际可播性**（§10）：记录从入队到出现可播高亮的墙钟时间；若长期 0 种子，配合第 8 节的连通性取证一起上报。

## 8. qbt 入站连通性（只读，§10）

- [ ] 8.1 只读 `app/preferences` 的 `upnp` / `listen_port` / `proxy` / `proxy_type` 并记录；**不写、不改配置**：

```bash
curl -s -b /tmp/qb.jar "http://127.0.0.1:8080/api/v2/app/preferences" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log({upnp:o.upnp,listen_port:o.listen_port,proxy:o.proxy,proxy_type:o.proxy_type})})"
```
  预期：把四个值记进 5.5 的同一张表。便携版启动参数里既无端口也无 UPnP 设置（`collectAddFields` / `download-manager.js` 已核对），若这里读出 `upnp=false` 且 `listen_port` 为默认随机 → NAT 后只能主动连出，peer 发现慢，这是「注入 tracker 仍 0 种子」的另一半解释。
- [ ] 8.2 不因该结论而「顺手」加端口映射功能：qbt Web API 不提供映射操作（§12 判为不做）。

## 9. 海报直链 / CSP / 混合内容（§10）

- [ ] 9.1 作品卡海报在应用内正常显示（走 `/api/proxy`），控制台无 CSP 或 mixed-content 报错。
- [ ] 9.2 断网/代理 403 时海报位退化不报错刷屏（图裂不炸布局）。

## 10. 窄屏退化（§6.5，<420px）

- [ ] 10.1 窗口拖到 420px 以下：作品头摘要行 ellipsis 截断，展开钮不换行、不掉出视口。
- [ ] 10.2 版本徽章超一行时被裁的次序为：先发布组（`group`）→ 再平台源（`platform`）→ 其余（裁决靠 `order` + `max-height` + `overflow:hidden` 实现，CSS 量不到内容宽度）。
- [ ] 10.3 长版本名单行截断，不撑破卡片。

## 11. 生命周期与降级（红线）

- [ ] 11.1 抓取进行中切走 tab（首页/片库/世界）→ 无幽灵卡、无迟到的结果落地（`isStale(gen)` 门禁）；切回后重新拉取，不残留上一代展开态。
- [ ] 11.2 播放中切走 → 画面立即消失（沿用 09-30 清单 6.1）。
- [ ] 11.3 浏览器直开 :3000 → 金色提示条「BT 播放需在 Stellaflix 桌面版中使用」，输入/按钮置灰，无 JS 报错刷屏。
- [ ] 11.4 非桌面态**仍可**导入规则（规则是数据，不依赖桥），但入队钮置灰。

## 12. 词表保守项复核（§10，允许「维持现状」结论）

- [ ] 12.1 `EDR`：真机找一条含 `EDR` 的版本名，确认它是否 HDR10 的误写；未确认前徽章族保持现归类（§6.3 保守处理），确认后提 spec 修订。
- [ ] 12.2 `HQ` 与「高码版」：同理，未证实前不得把 `HQ` 折叠进码率族。

## 通过标准

- **必过项**：0（全部）、1.3 / 1.4（整条不落盘）、4.2（参数最小化）、4.3（重复入队不新建）、5（matchHash 第二路取证，含 5.5 记录填齐）、11.1（代次门禁）。
- 其余为高优先。5 号未完成前，**不得**删除 `huilian-queue.js` 里「整串相等」的第一路认领。
- 任一必过项失败 → 停下上报并附截图/日志，不进入后续合并；本清单与 `2026-09-30-huilian-bt-smoke-checklist.md` 一起构成磁力链路的真机门槛。
````

- [ ] **Step 5: 自查 spec §10 → 清单条目的映射（缺一即清单不完整）**

| spec §10 未知项 | 清单勾项 |
|---|---|
| 搜索分页机制未破解 | 2.2（显式声明「只取首页」） |
| `EDR` 是否 HDR10 误写 / `HQ` 是否等同高码版 | 12.1 / 12.2 |
| 海报直链是否被 CSP/混合内容拦 | 9.1 / 9.2 |
| 裸 btih 注入 tracker 后的实际可播性 | 7.3（+ 8.1 的另一半解释） |
| `matchHash` 第二路未经真机证明；不得删第一路 | **5.1–5.5**（必过） |
| 便携版 qbt 入站连通性未知；只读 `app/preferences` | 8.1 / 8.2 |
| tracker 180 天时效阈值是拍的 | 1.2（只锁「刚导入不显」） |
| 远端规则 JSON 地址需用户自备 | 前置说明 + 0.2（无默认地址） |

- [ ] **Step 6: 提交（仅在用户明确下达「提交」指令后）**

```bash
git add docs/superpowers/plans/2026-10-01-huilian-magnet-site-smoke-checklist.md \
        docs/superpowers/plans/2026-10-01-huilian-magnet-site-source.md
git commit -m "docs: 汇联 磁力源 Task11 — 全量回归 + §9 红线 grep 自查 + 真机冒烟清单"
```
> 只 stage 这两份文档。`tests/fixtures/*.html` 属 Task 4 的产物，若此时尚未提交，回到 Task 4 的 commit 清单里一起收，不要在这里混带。

---

## 附录：spec 修订清单（计划落笔期发现的 spec 自身不可实施/欠精确处）

> 均为「spec 说的话，代码层面做不到或说法会误导」。**不改 spec**（用户审阅已过），逐条留给下一轮 spec 迭代。标注：`[Tn]` = 在哪个任务落地时被证实。

1. `[T3]` §3.1 schema 注释给的存储键 `sfv-huilian-magnet-rules` 不合仓库现状：`public/video/*.js` 里现有 localStorage 键实测 8 个，前缀一律 `stellaflix-`（`stellaflix-grid-diy-prefs` 等），无一用 `sfv-`（`sfv-` 是 CSS 类前缀）。计划改用 `stellaflix-video-huilian-magnet-rules`，spec 应直接给终态键名。
2. `[T5]` §5 第 3 条给了候选行的 `sub` 语义（「N 个版本 · 体积区间」）但未定逐字文案（区间分隔符、单位、N=1 时单复数）→ 本项目文案一律逐字，spec 需补。
3. `[T5]` §6.6 要求「复用 `openModal`」，但 `source-picker.js` 未导出它 → 必须先加导出（本计划 Task 5 做了），spec 应把该前置写明。
4. `[T2]` §6.3 徽章族缺 `res` 族的独立归一（`2160p`/`4K` 混写）→ spec 词表需补映射条目并声明「种子非穷举」。
5. `[T2]` §6.3 音轨族未覆盖 `AAC2.0`/`2Audio` 组合 → 与实测 14 条全不匹配，spec 词表滞后于站点写法。
6. `[T2]` §6.4 恒定值归约没说清「归约后行内还显不显」→ 需要 `allBadges` 与 `badges` 两个字段才能既归约又复原（本计划引入，spec 无此概念）。
7. `[T3]` §9.7 要求 `searchURL` 与 `workFields.*` 的 host 等于 `origin`，但 `workFields.*` 是 XPath 不含 host → 实际可校的是「导入后运行期 `absolutize` 之后再校」。spec 的措辞会让人去 XPath 串里找 host。
8. `[T4]` §6.4 的「并发上限 2」在 spec 里是行为描述，没有可断言接口 → 需 spec 给出 `runningCount()/pendingCount()` 之类观测面（本计划 Task 4 自定义）。
9. `[T6]` §5 第 4 条（点击＝入队走完整播链路）未规定磁力候选是否写 `playbackSession` → 本计划裁定「不写」（`playbackSession` 的语义是「该源已能续播到某时刻」，而磁力在入队瞬间既无本地文件也无进度，写进去会让下次进入详情页去续播一个还没下完的源），spec 需补这一条。
10. `[T4]` §9.4 只说「替换哈希」，未说 fixture 的展示名/站点名怎么办 → 需 spec 明确「合成名 + 伪造哈希 + 假 host」三件套。
11. `[T3]` §7 文案表只有「校验失败」一行（缺字段），未覆盖「字段齐但值非法」→ 需要两种文案（本计划各给一条），否则错误信息必然不准。
12. `[T9]` §7 无「存储不可用（隐私模式/配额）」态文案 → 面板必须能退化显示，spec 缺项。
13. `[T4]` fixture 必须可复算，否则脱敏无法审计 → spec 应点名「生成器与产物同时入库」。
14. `[T8]` §7 是逐字文案表，但「未知错误」（既非 HTTP 状态也非超时）无模板 → 需套 §7 模板给出兜底句。
15. `[T5][T8][T9]` §4 的文件结构把注册写成一步，实际必须分三批（数据层 → 组件 → 面板），因为后批依赖前批的导出面。spec 的注册顺序约束缺失。
16. `[T8]` 测试策略一节未说「假 DOM 里怎么放真 XPath」→ 需 `jsdom` + `runScripts:'outside-only'` + 延迟注入 http-client，否则测的是桩不是码。
17. `[T7]` §6.1 的容器与基础样式被 spec 排在两个不同关注点里，导致「渲染器出了节点、CSS 还没有对应规则」的中间态无法通过 → 容器与其样式不得跨任务分家。
18. `[T7]` mount/unmount 里同名复位行多处重复，计划给的锚点必须自带上下文，否则「命中数≠1」使补丁不可机械套用。
19. `[T8]` `applyFilter` 在无命中时返回 `null` 还是 `[]` 语义不同（`null` 会让调用方伪造空数组并丢副本身份）→ spec 未定义，需明确「永远返回数组 + 保留原对象引用」。
20. `[T8]` harness 的组件桩合并必须发生在模块清单**之后**，否则桩被真模块覆盖（测不到桩路径）→ spec/计划均未写该装配次序约束。
21. `[T9]` §6.6.2 的 URL 导入若复用 `importFromUrl`，会缺少「停留确认点」（覆盖差异需人看）→ 面板须自己拉取 + 自己确认，spec 应说明导入有两条路径。
22. `[T9]` §3.1 定「`importedAt` 由导入路径写入、远端同名字段丢弃」→ 后果是**唯一入口**是 `put(raw, nowMs)` 的第二参；spec 未提示「测试想造 181 天前只能这样播种」，容易写出假绿测。
23. `[T10]` §9.1 的「零内置规则」与 §8 的 fixture 文件名（含站点名）存在张力 → spec 需明确：脱敏是否要求「连文件名也不留真实域名」。本计划按 §8 逐字保留文件名（见 Task 11 裁决 2）。
24. `[T10]` §6.5 的「超一行时先裁末位」CSS 量不到内容宽度 → 实际表达只能是 `order` + `max-height` + `overflow:hidden` 的次序约定，spec 措辞应改为「按族优先级折行裁切」。
25. `[T10]` Task 9 渲染器输出的 `.huilian-rules-body` 直到 Task 10 才补上样式 → 「渲染器与其样式同批落地」需要一把机器锁（本计划用 `huilian-css-contract` 的正向清扫近似）。spec 无此约束。
26. `[T11]` §9.1 的「零内置」口径没说要覆盖**文档自身**：spec §3.1 的 schema 示例里写着真实 `origin: https://pomo.mom`、`search.php?search={query}&pjax=1`、`magnetAttr: 'data-url'`，这已是一份可执行规则。安装包不含 `docs/`（`build.files` 白名单实测只带 `docs/THIRD_PARTY_PORTS.md`），但**仓库经网盘公开分发** → spec 需明确「示例是否也须脱敏」；若要，改成 `example.test` 系假 host 即可（本计划的代码与 fixture 侧已全是假 host）。

**self-review 结论（writing-plans 第 1–3 项）**
1. **spec 覆盖**：§3（Task 1/2/3/4）、§4 注册（Task 5）、§5（Task 6 + source-picker Task 5）、§6.1–6.4（Task 8）、§6.5（Task 10）、§6.6（Task 9）、§7 文案（分散在 3/4/6/8/9，逐字）、§8 测试（每任务 Step + Task 11）、§9（Task 11 Step 2/3 全条对号）、§10（Task 11 Step 4/5 全条映射）、§11/§12（无新增实现要求）。无未覆盖条目。
2. **占位符扫描**：全文无 TBD/TODO/「类似 Task N」；每个改代码的 Step 都给了改前锚点 + 改后整块。
3. **类型一致性**：`SFV.huilianMagnetEnrich/Rules/Source/SiteSearch/MagnetRulesUi/Enqueue` 键名在 Interfaces 块与被消费处逐一对齐；`extractBtih`、`proxySrc`、`runningCount`、`data-family` 等跨任务符号在定义任务先出现，后续任务引用一致。

---

<!-- APPEND -->
