# 批D：音乐资料库详情层改回参照库真实形态（专辑/歌单＝1080 居中主题弹窗，艺人＝全屏 hero 页）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把本地音乐资料库的二级详情按参照库实态分成两种形态——专辑/歌单走 1080 宽居中主题弹窗（封面取色渐变、遮罩、底栏关闭、整单播放/随机），艺人保留全屏二级页 + hero。

**Architecture:** 复用项目既有弹窗基座（`public/css/index.css:7746` 的 `.modal-mask`/`.modal` 与 `08-account/01-login-modal-utils.js` 的 `openGsapModal`/`closeGsapModal`），新增一个「详情弹窗视图层」模块承担取色 + 弹窗渲染 + 显隐；`08-mlib-page.js` 的 `openDetail/closeDetail` 状态机（`body.mlib-detail-open` 真相源、在途作废、滚动记录）保持不变，只在渲染出口按轴分流。绑定仍归 `09-mlib-bindings.js` 那枚唯一的 document click 委托。

**Tech Stack:** 原生 IIFE 模块（`public/js/modules/NN-name/`）+ `public/js/index-loader.js` 注册表 + `npm run bundle`；测试 `node:test` + `node:vm` + `tests/helpers/mlib-fake-dom.js`；布局取证用无头 Edge 离屏探针。

**Spec:** `docs/superpowers/specs/2026-10-18-local-music-library-design.md`（§2 布局、§3 缝契约、§4 详情形态）。本批推翻该 spec 10-18 那轮「三轴统一全屏二级页」的形态结论，Task 6 里同步改写 §2/§4。

---

## Global Constraints

- 执行期**不逐任务 commit**：主人只在明确「提交」指令后才 commit（本仓多会话并发，`git stash -u` 严禁）。
- **不碰** `public/css/index.css`（弹窗基座 `.modal-mask`/`.modal`/`.modal-btn` 已在那儿，只复用、只在我自己的 CSS 里加 id 限定覆盖）。
- **:3000 桌面服务不许重启/杀**，不许启动新 server 占 3000；验证用 `PORT=3999` 或离屏探针（夹具走 `file://`）。
- 改 `public/js/modules/**` 之后**必须** `npm run bundle`，并同步 `tests/bundle-modules.test.js` 的模块计数。
- 命名一律 `.stella-mlib-*` 命名空间、CSS 变量 `--stella-mlib-theme-*`（参照库的 `--am-theme-*` 不带走）；类名映射表见「File Structure」。
- **页面绝不合成播放地址**：播放只认缝给的 `localUrl`（`14-mlib-seam.js:6-7` 硬契约）。
- 禁用桌面自动化（Computer Use）；视觉/布局结论必须来自离屏探针实测数字。
- 所有否定式断言（「仓里没有 X」）必须附 `grep` 实跑证据。

## 参照库事实基线（10-26 实测，逐字移植的依据）

**参照库源码绝对路径（实施时直接 Read 这两个文件对照，不要凭本表回忆）**

- `C:\Users\Administrator\Desktop\MineRadio-Apple-Music-Specially-Customized-Edition-2.1.0\public\js\modules\10-shell\07-album-detail.js`（取色 63-212、渲染 423-530、生命周期 742-853、歌单侧 1049-1143）
- `C:\Users\Administrator\Desktop\MineRadio-Apple-Music-Specially-Customized-Edition-2.1.0\public\css\index.css`（2090-2578）

| 对象 | 参照库落点 | 值 |
|---|---|---|
| 专辑弹窗窗口 | `index.css:2116-2135` | `width/min-width: min(1080px, calc(100vw - 56px)) !important`、`max-height: min(88vh, 900px) !important`、`border-radius: 26px`、`padding: 0`、`border: 1px solid rgba(255,255,255,.14)`、`linear-gradient(168deg, light 0%, a 46%, dark 100%)`、`box-shadow: 0 34px 100px rgba(0,0,0,.52), inset 0 1px 0 rgba(255,255,255,.12)` |
| 主题色层 | `index.css:2137-2165` | `::before` 两团 radial 柔光 + `blur(44px) saturate(1.3)`；`::after` 上轻下重压暗 `.10/.26/.40` + `backdrop-filter: blur(26px) saturate(1.15)` |
| 深色降级默认值 | `index.css:2095-2109` | `--theme-a: 30,42,52` / `light: 46,62,74` / `dark: 16,23,29` / `glow: 64,104,120` |
| 滚动容器 | `index.css:2166-2180` | `flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; padding:26px 26px 8px; scrollbar-width:none` |
| 信息区 | `index.css:2181-2187` | `grid-template-columns: minmax(200px,268px) minmax(0,1fr); gap:26px; align-items:start` |
| 封面 | `index.css:2192-2210` | `aspect-ratio:1/1; border-radius:18px; overflow:hidden; background:rgba(255,255,255,.05); box-shadow:0 22px 60px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.10)`；`img{object-fit:cover}` |
| 文案列 | `index.css:2221-2227` | `min-width:0; display:flex; flex-direction:column; align-items:flex-start; gap:8px` |
| kicker / artist / desc / facts | `index.css:2229-2299` | kicker `10.5px/800/.16em/uppercase/.66`；artist `14px/.86`；desc `13px/1.62/.66` + 三行 clamp（`.expanded` 解 clamp）；desc-toggle `0 245,245,212 色 600 12px`；facts `12px/.70` + `span+span::before '·'` |
| 操作区 | `index.css:2306-2345` | `.actions{flex; gap:10px; margin-top:14px}`；播放钮 `height:44px; padding:0 22px 0 18px; radius 999px; background rgba(255,255,255,.94); color #14161a; font 700 14px; box-shadow 0 10px 30px rgba(0,0,0,.3)`，`:disabled{opacity:.55}` |
| 随机钮 | `index.css:2347-2394` | `44×44` 浅色玻璃圆钮（**只在歌单出现**，专辑详情不放——`index.html:2068` 注释写明） |
| 状态行 | `index.css:2395-2409` | `12px/1.5/.6`；`[data-tone=warn]` `rgba(255,209,138,.92)`、`[data-tone=ok]` `rgba(0,245,212,.92)` |
| 曲目列表 | `index.css:2411-2415` | `margin-top:26px`（行本体规格我们批C 已逐字移植，本批零改动） |
| 空态/错误/骨架 | `index.css:2531-2555`、`2569-2578` | 空态盒 `radius16/border .14/bg rgba(0,0,0,.16)/13px`；error 红相；retry 胶囊 `32px/0 14px`；骨架 3 条 `62%/78%/54%` shimmer |
| 底栏 | `index.css:2560-2577` | `flex:0 0 auto; flex; justify-content:flex-end; padding:12px 22px 16px; border-top:1px solid rgba(255,255,255,.12)`；`.modal-btn` 在弹窗内改 `border-color .26 / background rgba(0,0,0,.18)`，hover `rgba(0,0,0,.30)` |
| 生命周期 | `07-album-detail.js:795-808 / 783-794 / 837-853` | open：重置 desc/playingKey/songs → `scroll.scrollTop=0` → `openGsapModal(mask)` → 取数；close：`closeGsapModal(mask, 清主题变量 + status=idle)`；遮罩点击＝`event.target === mask` |
| 取色链 | `07-album-detail.js:63-212` | `rgbToHsl`/`hslToRgbStr`/`rgbVars`（同色相派生 light/dark/glow）→ 32×32 canvas 直方图选「面积×饱和度」最优桶，全灰时退回平均色；`crossOrigin=anonymous` + `referrerPolicy=no-referrer`；`onerror` 清主题；需代理的域名白名单走 `/api/cover?url=` |

**本项目实态（已取证，直接采信）**

- 基座齐全：`.modal-mask{z-index:50}`（`index.css:7746`）、`openGsapModal/closeGsapModal`（`08-account/01-login-modal-utils.js:2/26`）、`vendor/gsap.min.js`（`index.html:25`）。
- 层级无冲突：`#music-library{position:fixed;z-index:1}`（`music-library.css:29-31`）、`#bottom-bar` z=6 → 弹窗 50 压得住。
- 封面代理端点签名一致：`server.js:8137` `pn === '/api/cover'` 收 `?url=`，且只放 http(s)（非 http(s) 直接 400）。
- 本地曲库封面是 **data: URL**：`14-mlib-seam.js:36` `cover: String(song.localCoverDataUrl || '')`，由 `13-local-library-engine.js:198-201` 把内嵌封面转 data URL。⇒ canvas 取色不被 CORS 污染；`coverThemeSource` 的域名白名单只对未来的远程封面生效。
- 行播放零新绑定：`09-mlib-bindings.js:208` 用 `t.closest(TRACK_ROW_SELECTOR)`，弹窗里的 `.stella-mlib-track[data-mlib-track-id]` 天然命中同一条分支。
- 艺人轴详情已有全屏 hero（批C-3）；专辑/歌单轴详情目前也走同一全屏视图——本批把后两者改成弹窗。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `public/index.html` | 详情弹窗静态壳（`.modal-mask > .modal > .stella-mlib-modal-scroll/.stella-mlib-modal-foot`） | Modify（`#music-library` 之后插入） |
| `public/css/music-library.css` | 弹窗度量 + 主题变量声明 + 按轴分流后 `#mlib-view-detail` 的显示闸 | Modify |
| `public/js/modules/04-shelf/15-mlib-detail-modal.js` | 新模块：封面取色（纯函数 + 应用）+ 弹窗窗口（show/hide 生命周期）+ 信息区（kicker/标题/艺人/简介+折叠/facts/整单钮/状态行/骨架）。**不构建曲目行**（行归 08） | Create |
| `public/js/modules/04-shelf/08-mlib-page.js` | `openDetail/refreshDetail/closeDetail` 按轴分流渲染出口；弹窗轴不动网格滚动 | Modify |
| `public/js/modules/04-shelf/09-mlib-bindings.js` | 唯一委托里加：关闭钮 / 遮罩 / 整单播放 / 随机；ESC 与切轴/关页时收窗 | Modify |
| `public/js/index-loader.js` | 注册新模块 | Modify |
| `tests/mlib-detail-modal-css.test.js`、`tests/mlib-cover-theme.test.js`、`tests/mlib-detail-modal-render.test.js`、`tests/mlib-detail-modal-bindings.test.js` | 四份新测试 | Create |
| `tests/helpers/mlib-detail-boot.js` | Task 3/4/5 共用的 `bootDetail`（从 `mlib-page-detail.test.js` 抽出 + spy 弹窗层 + 09/播放桩） | Create |
| `tests/mlib-page-detail.test.js`、`tests/mlib-page-playback.test.js`、`tests/helpers/mlib-fake-dom.js`、`tests/bundle-modules.test.js` | 详情分流回归（改指共用 boot，不留两份）/ 壳层夹具补弹窗节点 / 模块计数（随 Task 2 的注册一起改） | Modify |
| `tests/fixtures/mlib-detail-probe-ours.html` | 弹窗形态离屏探针（改指弹窗） | Modify |

**类名映射（参照库 → 本项目；移植时逐字照此改名，几何不动）**

`.am-album-modal`→`.stella-mlib-modal`、`.am-album-scroll`→`.stella-mlib-modal-scroll`、`.am-album-info`→`.stella-mlib-modal-info`、`.am-album-cover-wrap`→`.stella-mlib-modal-cover-wrap`、`.am-album-cover`→`.stella-mlib-modal-cover`、`.am-album-meta`→`.stella-mlib-modal-meta`、`.am-album-kicker`→`.stella-mlib-modal-kicker`、`.am-album-title`→（复用既有 `.stella-mlib-detail-title`）、`.am-album-artist`→`.stella-mlib-modal-artist`、`.am-album-desc(+.expanded)`→`.stella-mlib-modal-desc`、`.am-album-desc-toggle`→`.stella-mlib-modal-desc-toggle`、`.am-album-facts`→`.stella-mlib-modal-facts`、`.am-album-actions`→`.stella-mlib-modal-actions`、`.am-album-play`→`.stella-mlib-modal-play`、`.am-shuffle-btn`→`.stella-mlib-shuffle-btn`、`.am-album-status`→`.stella-mlib-modal-status`、`.am-album-tracks`→`.stella-mlib-modal-tracks`、`.am-album-track*`→（复用既有 `.stella-mlib-track*`）、`.am-album-empty/error/retry/skeleton`→**空态/错误/重试三件套不搬**（本项目两种形态共用既有 `fillStateBox`/`.stella-mlib-state-box`，另造一套皮肤＝死 CSS），只有 `.am-album-skeleton`→`.stella-mlib-modal-skeleton`、`.am-album-foot`→`.stella-mlib-modal-foot`、`--am-theme-*`→`--stella-mlib-theme-*`。

**弹窗 id（单弹窗承载专辑+歌单）**：`#mlib-detail-modal`（mask）、`#mlib-detail-modal-scroll`、`#mlib-detail-modal-cover`、`#mlib-detail-modal-kicker`、`#mlib-detail-modal-heading`、`#mlib-detail-modal-artist`、`#mlib-detail-modal-desc`、`#mlib-detail-modal-desc-toggle`、`#mlib-detail-modal-facts`、`#mlib-detail-modal-play`、`#mlib-detail-modal-play-label`、`#mlib-detail-modal-shuffle`、`#mlib-detail-modal-status`、`#mlib-detail-modal-tracks`。
> 参照库给专辑/歌单各造一个弹窗，理由写在 `index.css:2102-2104`：变量分节点，取色才不互相覆盖。本项目一次只开一个详情，改为**单弹窗 + show() 里先 clearTheme**；这条偏离连同理由一起写进模块头注释，供主人复核。

---

## Task 1: 弹窗壳 DOM + CSS 度量移植

**Files:**
- Modify: `public/index.html`（`</section>` of `#music-library` 之后，约 352 行处）
- Modify: `public/css/music-library.css`（在批C hero 段之后追加「详情弹窗」段）
- Test: `tests/mlib-detail-modal-css.test.js`（Create）

**Interfaces:**
- Consumes: `public/css/index.css:7746` 既有 `.modal-mask`/`.modal`/`.modal-btn` 基座（不改）
- Produces: 静态 id 面（见 File Structure），Task 2/4 用 `document.getElementById` 取；`#mlib-detail-modal.show` 由 `openGsapModal` 负责

- [ ] **Step 1: 写失败测试**

```js
// tests/mlib-detail-modal-css.test.js —— 批D Task 1：弹窗壳与度量移植（纯静态断言，不跑 JS）
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'music-library.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// 取某选择器块体（花括号配对，忽略注释里的括号）
function blockBody(source, selector) {
  const at = source.indexOf(selector + ' {');
  assert.notEqual(at, -1, '找不到选择器 ' + selector);
  let i = source.indexOf('{', at), depth = 0, start = i + 1;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i); }
  }
  throw new Error('括号不平衡：' + selector);
}

test('弹窗壳：mask/modal/scroll/foot 与全部 id 在 index.html 就位', () => {
  ['#mlib-detail-modal', '#mlib-detail-modal-scroll', '#mlib-detail-modal-cover',
   '#mlib-detail-modal-kicker', '#mlib-detail-modal-heading', '#mlib-detail-modal-artist',
   '#mlib-detail-modal-desc', '#mlib-detail-modal-desc-toggle', '#mlib-detail-modal-facts',
   '#mlib-detail-modal-play', '#mlib-detail-modal-play-label', '#mlib-detail-modal-shuffle',
   '#mlib-detail-modal-status', '#mlib-detail-modal-tracks'].forEach((id) => {
    assert.ok(html.includes(id), 'index.html 缺 ' + id);
  });
  assert.match(html, /id="mlib-detail-modal" class="modal-mask"/, 'mask 必须复用既有 .modal-mask 基座');
  assert.match(html, /class="modal stella-mlib-modal"/, '窗口必须带 .modal 基类（GSAP 找它做面板）');
  assert.match(html, /aria-modal="true"[^>]*>\s*<div class="modal stella-mlib-modal"/, 'role=dialog 的 aria-modal 要挂在 mask 上');
});

test('窗口度量＝参照库 2116-2135 逐字（1080/88vh/900/26px/168deg）', () => {
  const b = blockBody(css, '#mlib-detail-modal .modal.stella-mlib-modal');
  ['width: min(1080px, calc(100vw - 56px)) !important',
   'max-width: min(1080px, calc(100vw - 56px)) !important',
   'max-height: min(88vh, 900px) !important',
   'border-radius: 26px !important',
   'padding: 0 !important',
   'linear-gradient(168deg'].forEach((f) => assert.ok(b.includes(f), '窗口缺 ' + f));
});

test('主题变量深色降级默认值写在 mask 节点（关窗即消失）', () => {
  const b = blockBody(css, '#mlib-detail-modal');
  ['--stella-mlib-theme-a: 30, 42, 52', '--stella-mlib-theme-light: 46, 62, 74',
   '--stella-mlib-theme-dark: 16, 23, 29', '--stella-mlib-theme-glow: 64, 104, 120'].forEach((f) =>
    assert.ok(b.includes(f), '降级色缺 ' + f));
  assert.ok(!css.includes('--am-theme-'), '参照库的 --am-theme-* 不得带进本仓');
});

test('信息区/滚动/底栏/操作区度量逐字（268 封面列 / 26 内衬 / 44 播放钮）', () => {
  assert.match(blockBody(css, '.stella-mlib-modal-info'), /grid-template-columns: minmax\(200px, 268px\) minmax\(0, 1fr\)/);
  assert.match(blockBody(css, '.stella-mlib-modal-scroll'), /padding: 26px 26px 8px/);
  assert.match(blockBody(css, '.stella-mlib-modal-cover'), /aspect-ratio: 1 \/ 1/);
  assert.match(blockBody(css, '.stella-mlib-modal-foot'), /padding: 12px 22px 16px/);
  assert.match(blockBody(css, '.stella-mlib-modal-play'), /height: 44px/);
  assert.match(blockBody(css, '.stella-mlib-shuffle-btn'), /width: 44px/);
  assert.match(blockBody(css, '.stella-mlib-modal-tracks'), /margin-top: 26px/);
});

test('随机钮只在歌单：CSS 用轴类闸（参照库 index.html:2068 注释口径）', () => {
  assert.match(css, /body\.mlib-axis-albums #mlib-detail-modal \.stella-mlib-shuffle-btn\s*\{\s*display: none/,
    '专辑轴必须隐藏随机钮');
});

test('按轴分流：全屏详情视图只剩艺人轴（专辑/歌单走弹窗）', () => {
  assert.match(css, /body\.mlib-detail-open\.mlib-axis-artists #mlib-view-detail/, '艺人轴才铺全屏详情');
  assert.doesNotMatch(css, /body\.mlib-detail-open #mlib-view-detail\s*\{/,
    '旧的「任何轴都铺全屏详情」闸必须收掉（否则专辑点开是双份）');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/mlib-detail-modal-css.test.js`
Expected: FAIL —「找不到选择器 #mlib-detail-modal .modal.stella-mlib-modal」/「index.html 缺 #mlib-detail-modal」

- [ ] **Step 3: 写 index.html 壳**（插在 `#music-library` 的 `</section>` 之后、下一个区块之前，保持与既有资料库壳注释相邻）

```html
    <!-- 本地音乐资料库·专辑/歌单详情弹窗（批D）。形态与度量 1:1 参照库 index.html:2008-2085。
         复用全站弹窗基座 .modal-mask/.modal（css/index.css:7746）：GSAP 生命周期按 .modal 找面板。
         单弹窗承载两轴：一次只开一个详情，取色变量在 show() 里先清，不存在参照库那种互相覆盖。 -->
    <div id="mlib-detail-modal" class="modal-mask" role="dialog" aria-modal="true"
      aria-labelledby="mlib-detail-modal-heading">
      <div class="modal stella-mlib-modal">
        <div class="stella-mlib-modal-scroll" id="mlib-detail-modal-scroll">
          <div class="stella-mlib-modal-info">
            <div class="stella-mlib-modal-cover-wrap">
              <div class="stella-mlib-modal-cover" id="mlib-detail-modal-cover" aria-hidden="true"></div>
            </div>
            <div class="stella-mlib-modal-meta">
              <div class="stella-mlib-modal-kicker" id="mlib-detail-modal-kicker"></div>
              <h2 class="stella-mlib-detail-title" id="mlib-detail-modal-heading">详情</h2>
              <div class="stella-mlib-modal-artist" id="mlib-detail-modal-artist"></div>
              <p class="stella-mlib-modal-desc" id="mlib-detail-modal-desc" hidden></p>
              <button class="stella-mlib-modal-desc-toggle" id="mlib-detail-modal-desc-toggle" type="button" hidden
                data-mlib-modal-desc-toggle>展开简介</button>
              <div class="stella-mlib-modal-facts" id="mlib-detail-modal-facts"></div>
              <div class="stella-mlib-modal-actions">
                <button class="stella-mlib-modal-play" id="mlib-detail-modal-play" type="button" data-mlib-modal-play>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5v13l10.5-6.5z" /></svg>
                  <span id="mlib-detail-modal-play-label">播放</span>
                </button>
                <!-- 随机钮只在歌单出现（参照库不放进展窗）；专辑轴由 CSS 隐藏。 -->
                <button class="stella-mlib-shuffle-btn" id="mlib-detail-modal-shuffle" type="button"
                  data-mlib-modal-shuffle title="随机播放" aria-label="随机播放">
                  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 7h3.5c2 0 3.5 1.2 5 3s3 5 5 5H20" />
                    <path d="M17.5 12.5 20 15l-2.5 2.5" />
                    <path d="M3 17h3.5c2 0 3.5-1.2 5-3s3-5 5-5H20" />
                    <path d="M17.5 9.5 20 7l-2.5-2.5" />
                  </svg>
                </button>
              </div>
              <div class="stella-mlib-modal-status" id="mlib-detail-modal-status" role="status" aria-live="polite" hidden></div>
            </div>
          </div>
          <div class="stella-mlib-modal-tracks" id="mlib-detail-modal-tracks" aria-busy="false"></div>
        </div>
        <div class="stella-mlib-modal-foot">
          <button class="modal-btn" type="button" data-mlib-modal-close>关闭</button>
        </div>
      </div>
    </div>
```

- [ ] **Step 4: 写 CSS**（追加到 `music-library.css` 批C hero 段之后；数值照「参照库事实基线」表逐字，选择器按映射表改名）

```css
/* ---------- 详情弹窗（批D，10-26）：专辑/歌单轴的二级形态 ----------
   形态依据＝参照库实态：专辑/歌单＝居中主题弹窗（index.css:2090-2578），艺人＝全屏 hero 页。
   窗口/信息区/操作区/底栏的每一个数值都是那边逐字搬来的；.modal 基类（css/index.css:7746）
   自带 380px/max-width/padding:32px/深色渐变，必须用 id 提升到更高特异度 + !important 才压得住
   ——参照库 index.css:2112-2115 注释记录的正是这个坑（只写 .am-album-modal 时窗口被压成 380px 竖条）。 */
#mlib-detail-modal {
  --stella-mlib-theme-a: 30, 42, 52;
  --stella-mlib-theme-light: 46, 62, 74;
  --stella-mlib-theme-dark: 16, 23, 29;
  --stella-mlib-theme-glow: 64, 104, 120
}

#mlib-detail-modal .modal.stella-mlib-modal {
  position: relative;
  width: min(1080px, calc(100vw - 56px)) !important;
  max-width: min(1080px, calc(100vw - 56px)) !important;
  max-height: min(88vh, 900px) !important;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0 !important;
  border-radius: 26px !important;
  border: 1px solid rgba(255, 255, 255, .14);
  background: linear-gradient(168deg,
      rgb(var(--stella-mlib-theme-light, 46, 62, 74)) 0%,
      rgb(var(--stella-mlib-theme-a, 30, 42, 52)) 46%,
      rgb(var(--stella-mlib-theme-dark, 16, 23, 29)) 100%) !important;
  box-shadow: 0 34px 100px rgba(0, 0, 0, .52), inset 0 1px 0 rgba(255, 255, 255, .12);
  text-align: left
}

#mlib-detail-modal .modal.stella-mlib-modal::before { /* 大面积铺色：两团高饱和柔光 */
  content: '';
  position: absolute;
  inset: -12%;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(78% 62% at 18% 6%, rgb(var(--stella-mlib-theme-glow, 64, 104, 120) / 95%), transparent 72%),
    radial-gradient(70% 58% at 86% 92%, rgb(var(--stella-mlib-theme-a, 30, 42, 52) / 85%), transparent 74%);
  filter: blur(44px) saturate(1.3);
  opacity: 1
}

#mlib-detail-modal .modal.stella-mlib-modal::after { /* 只做可读性压暗：上轻下重 */
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(0, 0, 0, .10) 0%, rgba(0, 0, 0, .26) 55%, rgba(0, 0, 0, .40) 100%);
  backdrop-filter: blur(26px) saturate(1.15)
}

.stella-mlib-modal-scroll { /* 唯一滚动容器：底栏不随内容滚 */
  position: relative;
  z-index: 1;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 26px 26px 8px;
  scrollbar-width: none
}

.stella-mlib-modal-scroll::-webkit-scrollbar { width: 0 }

.stella-mlib-modal-info { display: grid; grid-template-columns: minmax(200px, 268px) minmax(0, 1fr); gap: 26px; align-items: start }
.stella-mlib-modal-cover-wrap { position: relative }

.stella-mlib-modal-cover {
  position: relative;
  aspect-ratio: 1 / 1;
  border-radius: 18px;
  overflow: hidden;
  background: rgba(255, 255, 255, .05);
  box-shadow: 0 22px 60px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .10)
}

.stella-mlib-modal-cover img { display: block; width: 100%; height: 100%; object-fit: cover }
.stella-mlib-modal-meta { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 8px }
.stella-mlib-modal-kicker { font-size: 10.5px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: rgba(255, 255, 255, .66) }
.stella-mlib-modal-artist { font-size: 14px; color: rgba(255, 255, 255, .86) }

.stella-mlib-modal-desc {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.62;
  color: rgba(255, 255, 255, .66);
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical
}

.stella-mlib-modal-desc.expanded { -webkit-line-clamp: unset; display: block; overflow: visible }
.stella-mlib-modal-desc-toggle { margin-top: 2px; padding: 0; border: 0; background: none; color: color-mix(in srgb, var(--home-accent) 92%, transparent); font: 600 12px inherit; cursor: pointer }   /* 10-31 校正＝本行原写 rgba(0, 245, 212, .92)，是参照库的硬编码青色；tests/mlib-page-contract.test.js:23 红线禁该字面量，故换全站 --home-accent，透明度 .92 不变（有意差异第 5 处，见台账 R13） */
.stella-mlib-modal-facts { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px 10px; font-size: 12px; color: rgba(255, 255, 255, .70) }
.stella-mlib-modal-facts span { display: inline-flex; align-items: center; gap: 6px }
.stella-mlib-modal-facts span + span::before { content: '·'; margin-right: 10px; color: rgba(255, 255, 255, .28) }
.stella-mlib-modal-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px }

.stella-mlib-modal-play {
  margin-top: 0;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  height: 44px;
  padding: 0 22px 0 18px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, .22);
  background: rgba(255, 255, 255, .94);
  color: #14161a;
  font: 700 14px inherit;
  cursor: pointer;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .3);
  transition: background .18s, border-color .18s, transform .16s
}

.stella-mlib-modal-play svg { width: 18px; height: 18px; fill: currentColor }
.stella-mlib-modal-play:hover:not(:disabled) { background: #fff; transform: translateY(-1px) }
.stella-mlib-modal-play:disabled { opacity: .55; cursor: default }

.stella-mlib-shuffle-btn { /* 浅色玻璃圆钮：主题色底上深色玻璃对比太弱，反相 */
  flex: none;
  width: 44px;
  height: 44px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, .62);
  border-radius: 50%;
  background: rgba(255, 255, 255, .82);
  color: #14161a;
  cursor: pointer;
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  box-shadow: 0 10px 28px rgba(0, 0, 0, .26), inset 0 1px 0 rgba(255, 255, 255, .9);
  transition: background .18s, border-color .18s, box-shadow .18s, transform .16s
}

.stella-mlib-shuffle-btn svg { width: 19px; height: 19px }
.stella-mlib-shuffle-btn:hover { background: rgba(255, 255, 255, .96); border-color: rgba(255, 255, 255, .85); transform: translateY(-1px) }
.stella-mlib-shuffle-btn:active { transform: translateY(0) scale(.96) }
.stella-mlib-shuffle-btn:focus-visible { outline: 2px solid rgba(20, 22, 26, .55); outline-offset: 2px }
.stella-mlib-shuffle-btn:disabled { opacity: .55; cursor: default; transform: none }
body.mlib-axis-albums #mlib-detail-modal .stella-mlib-shuffle-btn { display: none } /* 参照库：随机只在歌单 */
.stella-mlib-modal-status { margin-top: 8px; font-size: 12px; line-height: 1.5; color: rgba(255, 255, 255, .6) }
.stella-mlib-modal-status[data-tone="warn"] { color: rgba(255, 209, 138, .92) }
.stella-mlib-modal-status[data-tone="ok"] { color: color-mix(in srgb, var(--home-accent) 92%, transparent) }   /* 同上：青色字面量被 mlib-page-contract 红线禁掉，走 --home-accent */
.stella-mlib-modal-tracks { margin-top: 26px }

.stella-mlib-modal-skeleton {
  height: 14px;
  margin: 10px 0;
  border-radius: 7px;
  background: linear-gradient(100deg, rgba(255, 255, 255, .05) 20%, rgba(255, 255, 255, .10) 50%, rgba(255, 255, 255, .05) 80%);
  background-size: 220% 100%;
  animation: stella-mlib-shimmer 1.6s linear infinite
}

.stella-mlib-modal-foot {
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  padding: 12px 22px 16px;
  border-top: 1px solid rgba(255, 255, 255, .12);
  background: transparent
}

#mlib-detail-modal .modal-btn { border-color: rgba(255, 255, 255, .26); background: rgba(0, 0, 0, .18) }
#mlib-detail-modal .modal-btn:hover { background: rgba(0, 0, 0, .30) }

/* 弹窗轴：全屏详情视图不参与（只剩艺人轴铺） */
body.mlib-detail-open.mlib-axis-artists #mlib-view-detail { display: block }
body.mlib-detail-open.mlib-axis-albums #mlib-view-detail,
body.mlib-detail-open.mlib-axis-playlists #mlib-view-detail { display: none }
body.mlib-detail-open.mlib-axis-albums #mlib-view-grid,
body.mlib-detail-open.mlib-axis-playlists #mlib-view-grid { display: block }
```

> **实读校正（10-26/10-31 已查证，照此改，不要另起机制）**
> 1. 现状 `music-library.css:468` 是 `body.mlib-detail-open #mlib-view-detail { display: block }`、`:472` 是 `body.mlib-detail-open #mlib-view-grid { display: none }`。这两条**都要改成按轴版**（上面最后三段就是替换品）：`#mlib-view-detail` 只在艺人轴铺、`#mlib-view-grid` 只在艺人轴隐藏。特异度已核：`.mlib-detail-open.mlib-axis-albums #mlib-view-grid`（1,2,0）压得住 `.mlib-detail-open #mlib-view-grid`（1,1,0）。
> 2. `@keyframes stella-mlib-shimmer` 已在本文件 `:264`（`.stella-mlib-art::after` 封面载入微光在用，`:250-266`），弹窗骨架**直接复用同名关键帧**，不要重复定义。
> 3. 空态/错误盒**不新建弹窗专用样式**：详情两种形态共用既有 `fillStateBox`/`.stella-mlib-state-box` 一套（参照库的 `.am-album-empty/.am-album-error` 不搬，否则仓里出现两套空态皮肤 = 死 CSS）。
> 4. **面板描边/阴影/关闭钮皮肤三条不写**（10-31 Task 1 终审定）：本仓公共面「分层配色」在 `index.css:14806-14823`（`.modal-btn` 的 background/border-color/box-shadow/backdrop-filter）与 `index.css:15222-15238`（`.modal` 的 border-color/box-shadow）全是 `!important`。我们写的非 `!important` 值一条都落不了地：`border: 1px solid rgba(255,255,255,.14)` 的色会被 `.075` 顶掉，`box-shadow: 0 34px 100px …` 整体作废，`.modal-btn` 两行（含 hover）整体作废。处置口径＝**保留 `border: 1px solid transparent`（宽度/线型是我们需要的，颜色交公共玻璃层），删掉自造 `box-shadow` 与 `.modal-btn` 两条**，并在原位留一行说明「面板深度与按钮皮肤归 index.css 玻璃层令」。不去加 `!important` 硬顶：那是拿本功能的私有权重压主人全局换肤，属于跨会话面越权。
> 5. **标题字号就按参照库的“撞车结果”走**（10-31 查证）：参照库 `index.css:9124` 的 `.modal h2`（`18px/500/.5px/margin-bottom 18px`，特异度 0,1,1）压过它自己 `.am-album-title`（2237 行，`clamp(24px,2.6vw,36px)/720`，0,1,0）——参照库弹窗标题**实际渲染就是 18px**，`clamp` 那三行在参照库里也是死值。本项目复用 `.modal` 基类＝同一套 `.modal h2`（自家 `index.css:7781`，逐字同值），因此同样落 18px。1:1 口径＝照这个实测结果，不加 id 级 override 把标题抬回 24-36px。若主人要更大标题，那是**推翻参照库形态的新决定**，走单独指令，别在批D 里顺手改。
> 6. `tests/mlib-detail-modal-css.test.js` 的 `blockBody` 辅助函数注释要说实话：它做花括号配对，**不**跳注释。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/mlib-detail-modal-css.test.js` → 6/6 PASS（本段测试块共 6 枚；先前写的 5/5 是数错了）

- [ ] **Step 6: 不要 commit**（等主人「提交」指令）

---

## Task 2: 封面取色链（15-mlib-detail-modal.js 上半）

**Files:**
- Create: `public/js/modules/04-shelf/15-mlib-detail-modal.js`
- Modify: `public/js/index-loader.js`（`04-shelf` 段 `14-mlib-seam.js` 之后追加）
- Test: `tests/mlib-cover-theme.test.js`（Create）

**Interfaces:**
- Consumes: `document.createElement('canvas')`、`new Image()`、既有 `/api/cover?url=`（`server.js:8137`）
- Produces: `window.stellaMlibCoverTheme = { rgbToHsl, hslToRgb, rgbVars, applyThemeVars, clearTheme, coverThemeSource, applyCoverTheme }`（`applyCoverTheme(coverUrl, targetNode)` 把五个 `--stella-mlib-theme-*` 写进 mask 节点；Task 4 的弹窗渲染调它）

- [ ] **Step 1: 写失败测试**

```js
// tests/mlib-cover-theme.test.js —— 批D Task 2：封面取色（逐字移植参照库 07-album-detail.js:63-212）
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '15-mlib-detail-modal.js'), 'utf8');

// 假 canvas：按像素函数吐 RGBA，好让「面积×饱和度」的胜出桶可被断言
function boot(pixels) {
  const styleWrites = {};
  const target = {
    style: {
      setProperty(k, v) { styleWrites[k] = v; },
      removeProperty(k) { delete styleWrites[k]; }
    }
  };
  const doc = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return {
        width: 0, height: 0,
        getContext(type) {
          assert.equal(type, '2d');
          return {
            drawImage() {},
            getImageData(x, y, w, h) {
              const data = new Uint8ClampedArray(w * h * 4);
              for (let i = 0; i < w * h; i++) {
                const p = pixels(i);
                data[i * 4] = p[0]; data[i * 4 + 1] = p[1]; data[i * 4 + 2] = p[2]; data[i * 4 + 3] = p[3] === undefined ? 255 : p[3];
              }
              return { data };
            }
          };
        }
      };
    }
  };
  const loaded = [];
  const ImageCtor = function () { this.onload = null; this.onerror = null; };
  Object.defineProperty(ImageCtor.prototype, 'src', {
    set(v) { loaded.push(v); if (this.onload) setImmediate(() => this.onload()); }
  });
  const sandbox = { document: doc, Image: ImageCtor, location: { href: 'http://localhost:3000/' }, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: '15-mlib-detail-modal.js' });
  return { t: sandbox.window.stellaMlibCoverTheme, target, styleWrites, loaded, tick: () => new Promise((r) => setImmediate(r)) };
}

test('hsl 往返：主色派生亮/暗/辉光三端且同色相', () => {
  const { t } = boot(() => [0, 0, 0]);
  const v = t.rgbVars(200, 40, 60); // 鲜红
  assert.equal(v.a, '200, 40, 60');
  const toHue = (s) => { const [r, g, b] = s.split(',').map(Number); return Math.round(t.rgbToHsl(r, g, b).h * 360); };
  [v.light, v.dark, v.glow].forEach((s) => assert.equal(toHue(s), 355, '色相必须守住'));
  const [, , dl] = t.rgbToHsl(...v.dark.split(',').map(Number));
  const [, , ll] = t.rgbToHsl(...v.light.split(',').map(Number));
  assert.ok(dl < 0.4 && ll > 0.5, '暗端要够暗、亮端要够亮');
});

test('取色胜出「够饱和且面积大」的桶，不是全图平均', async () => {
  // 70% 灰蓝（低饱和、量大）+ 30% 鲜黄（量小但鲜艳）：全图平均会得到浑浊色，直方图应选鲜黄
  const { t, target, tick } = boot((i) => (i % 10 < 3 ? [250, 210, 20] : [70, 80, 90]));
  await t.applyCoverTheme('data:image/png;base64,AAAA', target).then(() => tick());
  const rgb = t ? target.styleWrites['--stella-mlib-theme-a'].split(',').map(Number) : [];
  assert.ok(rgb[0] > 200 && rgb[1] > 150 && rgb[2] < 90, '主色应落在鲜黄：' + rgb);
});

test('全灰封面退回平均色；透明像素一律跳过', async () => {
  const { t, target, tick } = boot((i) => (i % 4 === 0 ? [10, 10, 10, 0] : [120, 120, 120]));
  await t.applyCoverTheme('data:image/png;base64,AAAA', target).then(() => tick());
  const rgb = target.styleWrites['--stella-mlib-theme-a'].split(',').map(Number);
  assert.ok(rgb[0] > 100 && rgb[0] < 140, '平均色应≈120：' + rgb);
});

test('无封面＝不取色，深色降级交给 CSS；加载失败清主题', async () => {
  const { t, target } = boot(() => [0, 0, 0]);
  await t.applyCoverTheme('', target);
  assert.equal(Object.keys(target.styleWrites).length, 0, '空封面不得写任何变量');
});

test('coverThemeSource：QQ/汽水类无 CORS 头域名走 /api/cover，data URL 与 Apple/网易云直连', () => {
  const { t } = boot(() => [0, 0, 0]);
  assert.equal(t.coverThemeSource('https://y.qq.com/n/a.jpg'), '/api/cover?url=' + encodeURIComponent('https://y.qq.com/n/a.jpg'));
  assert.equal(t.coverThemeSource('https://img.douyinpic.com/x/a.jpg'), '/api/cover?url=' + encodeURIComponent('https://img.douyinpic.com/x/a.jpg'));
  assert.equal(t.coverThemeSource('https://is1-ssl.mzstatic.com/x.jpg'), 'https://is1-ssl.mzstatic.com/x.jpg');
  assert.equal(t.coverThemeSource('https://p1.music.126.net/x.jpg'), 'https://p1.music.126.net/x.jpg');
  assert.equal(t.coverThemeSource('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA', '本地曲库内嵌封面就是 data URL，绝不能被塞进代理');
  assert.equal(t.coverThemeSource(''), '');
});

test('五个变量一次写齐；clearTheme 一次摘净（关窗不污染资料库页）', () => {
  const { t, target, styleWrites } = boot(() => [0, 0, 0]);
  t.applyThemeVars(10, 20, 30, target);
  assert.deepEqual(Object.keys(styleWrites).sort(), [
    '--stella-mlib-theme-a', '--stella-mlib-theme-b', '--stella-mlib-theme-dark',
    '--stella-mlib-theme-glow', '--stella-mlib-theme-light']);
  t.clearTheme(target);
  assert.equal(Object.keys(styleWrites).length, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/mlib-cover-theme.test.js` → FAIL（模块不存在 / `stellaMlibCoverTheme` 未定义）

- [ ] **Step 3: 写模块上半**（`15-mlib-detail-modal.js` 文件头 + 取色；逐字移植 `07-album-detail.js:59-212`，仅改名与 `--stella-mlib-theme-*`，代理域名白名单原样保留）

```js
// ============================================================================
// 04-shelf/15-mlib-detail-modal.js
// 批D（10-26）：专辑/歌单详情弹窗视图层。形态 1:1 参照库
//   js/modules/10-shell/07-album-detail.js（取色链 63-212、信息区渲染 423-471、生命周期 742-853）。
// 与参照库的四处架构差（都因本项目「三卡三轴 + 单详情 + 读层供数」的壳不同，非自创设计）：
//   1) 单弹窗承载专辑+歌单，show() 先 clearTheme——参照库分两个节点的理由是取色变量互不覆盖
//      （index.css:2102-2104），本项目一次只开一个详情，开窗清一次即可；
//   2) 数据一律走读层 getDetail(axis,id)，本层不拼接口 URL、不碰 provider 分支
//      （参照库 570-620 那串 ne/kg/qq/qs/sp 前缀分流在本项目无对应物）；
//   3) 事件面归 09-mlib-bindings.js 唯一的 document click 委托（参照库的 inline onclick +
//      wrap addEventListener（809-853）不照搬，改 data-mlib-modal-* 由绑定层解析）；
//   4) 曲目行**不在本层构建**：08-mlib-page.js 的 buildTrackRow/detailPayload 是行的唯一属主
//      （一份行模板两处实现＝本批最大回归风险），本层只提供行的落地容器与开窗/信息区。
// 播放地址仍只可能来自缝给的 localUrl（硬契约见 14-mlib-seam.js 头注释）。
// ============================================================================

var STELLA_MLIB_THEME_VARS = ['--stella-mlib-theme-a', '--stella-mlib-theme-b',
  '--stella-mlib-theme-light', '--stella-mlib-theme-dark', '--stella-mlib-theme-glow'];

// 逐字照 07-album-detail.js:74-89（参照库无纯函数导出面，这里挂 window 只为可测）
function stellaMlibRgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var l = (max + min) / 2, h = 0, s = 0;
  if (max !== min) {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h, s: s, l: l };
}

// 逐字照 07-album-detail.js:91-112（返回 "r, g, b" 字符串，与参照库同名同形）
function stellaMlibHslToRgbStr(h, s, l) {
  h = ((h % 1) + 1) % 1;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  var r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    var f = function (t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    r = f(h + 1 / 3); g = f(h); b = f(h - 1 / 3);
  }
  return Math.round(r * 255) + ', ' + Math.round(g * 255) + ', ' + Math.round(b * 255);
}

// 逐字照 07-album-detail.js:63-73：由主色派生同色相的亮/暗/辉光三端，避免渐变里出现黑色色块
function stellaMlibRgbVars(r, g, b) {
  var h = stellaMlibRgbToHsl(r, g, b);
  return {
    a: r + ', ' + g + ', ' + b,
    light: stellaMlibHslToRgbStr(h.h, Math.min(1, h.s * 0.92), Math.min(0.62, h.l + 0.16)),
    dark: stellaMlibHslToRgbStr(h.h, Math.min(1, h.s * 1.04), Math.max(0.14, h.l - 0.20)),
    glow: stellaMlibHslToRgbStr(h.h, Math.min(1, h.s * 1.15), Math.min(0.60, h.l + 0.10))
  };
}

// 逐字照 07-album-detail.js:114-120 / 122-133（--b 与 --a 同值，参照库留这个变量是给别的皮肤用）
function stellaMlibClearTheme(target) {
  var modal = target || stellaMlibModalMask();
  if (!modal) return;
  STELLA_MLIB_THEME_VARS.forEach(function (k) { modal.style.removeProperty(k); });
}

function stellaMlibApplyThemeVars(r, g, b, target) {
  var modal = target || stellaMlibModalMask();
  if (!modal) return;
  var v = stellaMlibRgbVars(r, g, b);
  modal.style.setProperty('--stella-mlib-theme-a', v.a);
  modal.style.setProperty('--stella-mlib-theme-b', v.a);
  modal.style.setProperty('--stella-mlib-theme-light', v.light);
  modal.style.setProperty('--stella-mlib-theme-dark', v.dark);
  modal.style.setProperty('--stella-mlib-theme-glow', v.glow);
}

// 逐字照 07-album-detail.js:144-158。这些域不返回 Access-Control-Allow-Origin，直连会污染 canvas
// → getImageData 抛 → 主题静默退化成深色降级；本项目本地曲库是 data URL，绝不会被塞进代理。
var STELLA_MLIB_COVER_PROXY_HOSTS = [
  'y.qq.com', 'y.gtimg.cn', 'qpic.cn', 'qq.com',
  'douyinpic.com', 'douyin.com', 'bytedance.com', 'byteimg.com',
];

function stellaMlibCoverThemeSource(coverUrl) {
  var u = String(coverUrl || '').trim();
  if (!u) return u;
  var host = '';
  try { host = new URL(u, location.href).hostname.toLowerCase(); } catch (_) { return u; }
  var needsProxy = STELLA_MLIB_COVER_PROXY_HOSTS.some(function (h) {
    return host === h || host.slice(-(h.length + 1)) === '.' + h;
  });
  return needsProxy ? ('/api/cover?url=' + encodeURIComponent(u)) : u;
}

// 逐字照 07-album-detail.js:159-212 的算法，只多两件事：返回 Promise（让渲染链能等它落地）、
// 以及 onload/onerror 两条出口都要 resolve。32×32 采样 + 「面积×饱和度」直方图胜出桶原样保留。
function stellaMlibApplyCoverTheme(coverUrl, target) {
  var modal = target || stellaMlibModalMask();
  stellaMlibClearTheme(modal);
  if (!coverUrl || !modal) return Promise.resolve();   // CSS 里的深色降级默认值接管
  return new Promise(function (resolve) {
    var done = function () { resolve(); };
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = function () {
      try {
        var n = 32;
        var c = document.createElement('canvas');
        c.width = n; c.height = n;
        var ctx = c.getContext('2d');
        if (!ctx) return done();
        ctx.drawImage(img, 0, 0, n, n);
        var data = ctx.getImageData(0, 0, n, n).data;
        var buckets = {};
        var fallbackR = 0, fallbackG = 0, fallbackB = 0, fallbackN = 0;
        for (var i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 200) continue;
          var r = data[i], g = data[i + 1], b = data[i + 2];
          fallbackR += r; fallbackG += g; fallbackB += b; fallbackN += 1;
          var hsl = stellaMlibRgbToHsl(r, g, b);
          if (hsl.l < 0.10 || hsl.l > 0.94) continue;
          var key = Math.round(hsl.h * 18) + ':' + Math.round(hsl.s * 3) + ':' + Math.round(hsl.l * 3);
          if (!buckets[key]) buckets[key] = { n: 0, r: 0, g: 0, b: 0, s: hsl.s };
          var bk = buckets[key];
          bk.n += 1; bk.r += r; bk.g += g; bk.b += b;
        }
        var best = null;
        Object.keys(buckets).forEach(function (k) {
          var b0 = buckets[k];
          var score = b0.n * (0.45 + b0.s * 1.55);   // 权重＝像素占比 × 饱和加成
          if (!best || score > best.score) best = { score: score, r: b0.r / b0.n, g: b0.g / b0.n, b: b0.b / b0.n };
        });
        if (best) stellaMlibApplyThemeVars(Math.round(best.r), Math.round(best.g), Math.round(best.b), modal);
        else if (fallbackN) stellaMlibApplyThemeVars(
          Math.round(fallbackR / fallbackN), Math.round(fallbackG / fallbackN), Math.round(fallbackB / fallbackN), modal);
      } catch (_) { /* 取色失败 → CSS 深色默认值 */ }
      done();
    };
    img.onerror = function () { stellaMlibClearTheme(modal); done(); };
    img.src = stellaMlibCoverThemeSource(coverUrl);
  });
}

// 取色面挂全局＝测试面（参照库这些函数是模块私有的；本项目要单独跑 mlib 测试，且 08/15 下半都复用）
window.stellaMlibCoverTheme = {
  rgbToHsl: stellaMlibRgbToHsl, hslToRgb: stellaMlibHslToRgbStr, rgbVars: stellaMlibRgbVars,
  clearTheme: stellaMlibClearTheme, applyThemeVars: stellaMlibApplyThemeVars,
  coverThemeSource: stellaMlibCoverThemeSource, applyCoverTheme: stellaMlibApplyCoverTheme,
};
```

> 三条实现约束，别在移植时顺手改掉：
> **a)** `stellaMlibApplyCoverTheme` 返回 Promise 是本项目为「测试能 await 到落地 + 渲染链不并写出两份主题」加的，参照库是 fire-and-forget；算法一字未动。
> **b)** 空封面/取色失败**不得**写任何变量——深色降级由 CSS 里 `#mlib-detail-modal { --stella-mlib-theme-*: ... }` 的默认值兜（参照库 2095-2109 同一做法）。
> **c)** `stellaMlibModalMask()` 在 Task 4 定义；Task 2 单独跑测试时它返回 `document.getElementById(...)`（假 DOM 里没有该节点＝返回 null，`|| target` 的兜底就生效），所以 Task 2 的测试全部显式传 `target`。

- [ ] **Step 4: 注册模块 + 同步模块计数**（两处一起改，缺一处当天就红）

`public/js/index-loader.js`，`04-shelf` 段紧随 `'04-shelf/14-mlib-seam.js'` 之后：

```js
  '04-shelf/15-mlib-detail-modal.js',
```

`tests/bundle-modules.test.js:60-68` 把「现场」那条钉死：10-31 实测 `modulePaths` 当前 **126** 条、`buildRuns` **15** 段（`node .scratch/count-modules.js` 可复跑）。本 Task 加一条＝**126→127**，段数不变（同属 `04-shelf` 段）。测试标题里的 `15 段/126 模块` 一并改成 `15 段/127 模块`，`assert.strictEqual(paths.length, 126)` 改 127。
> 为什么不能推到 Task 6：Task 2 之后每次跑 `npm test` 都会红这一条，后续 Task 的实现者无法区分「我改坏了」和「批处理还没收尾」。计数跟着注册走，每个 Task 结束时套件都是绿的。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/mlib-cover-theme.test.js tests/bundle-modules.test.js` → 6/6 + 4/4 PASS

- [ ] **Step 6: 不要 commit**

---

## Task 3: 详情形态按轴分流（08-mlib-page.js）

**Files:**
- Modify: `public/js/modules/04-shelf/08-mlib-page.js:553-648`（`renderDetail`/`openDetail`/`refreshDetail`/`closeDetail`/`clearDetail`）
- Modify: `tests/helpers/mlib-fake-dom.js`（SHELL 节点表补弹窗子树——本 Task 的 `tracksEl()` 落地容器就要它，不能推到 Task 4）
- Create: `tests/helpers/mlib-detail-boot.js`（从既有 `tests/mlib-page-detail.test.js` 的 `bootDetail` 抽出来共用）
- Test: `tests/mlib-detail-modal-render.test.js`（Create，本 Task 先测分流闸）+ 回归 `tests/mlib-page-detail.test.js`（Modify）

**Interfaces:**
- Consumes: `window.stellaMlibDetailModal`（Task 4 提供，形状＝`{ isModalAxis(axis), show(axis), hide(), skeleton(), renderInfo(axis, res), tracksEl(), setStatus(text,tone), setBusy(bool), isBusy(), toggleDesc() }`）
- Produces: `window.stellaMlibPage.openDetail/closeDetail` 语义不变（09 的调用面零改动）；新增 `window.stellaMlibPage.detailForm(axis)` → `'modal' | 'page'`、`window.stellaMlibPage.currentDetail()` → `{axis,id,form} | null`
- **属主划分（本批最重要的一条，写死在这里免得两位实施者各造一份）**：曲目行的构建与 payload 登记**永远只有 `08-mlib-page.js` 的 `buildTrackRow`/`detailPayload` 一处**（`:520`、`:742-750`）；`15` 只提供行的落地容器 `tracksEl()`。状态盒同理走既有 `fillStateBox`。`15` 负责的是窗口本身：开合、信息区、取色、整单钮文案/禁用、骨架。

- [ ] **Step 1: 假 DOM 夹具补弹窗子树**

在 `tests/helpers/mlib-fake-dom.js` 的 SHELL 描述里（与 `#mlib-view-detail` **同级**、仍在 `#music-library` 之外那一层）追加与 Task 1 的 index.html 逐字对应的子树。节点清单（id 全列，少一个 Task 4 就无处落断言）：`#mlib-detail-modal`（class `modal-mask`）→ 内层 class `modal stella-mlib-modal` → `#mlib-detail-modal-scroll` → `.stella-mlib-modal-info` → `#mlib-detail-modal-cover` / `#mlib-detail-modal-kicker` / `#mlib-detail-modal-heading` / `#mlib-detail-modal-artist` / `#mlib-detail-modal-desc` / `#mlib-detail-modal-desc-toggle` / `#mlib-detail-modal-facts` / `#mlib-detail-modal-play` / `#mlib-detail-modal-play-label` / `#mlib-detail-modal-shuffle` / `#mlib-detail-modal-status`，以及 `#mlib-detail-modal-tracks`。属性面也要照 index.html 挂上（`data-mlib-modal-play` / `-shuffle` / `-desc-toggle` / `-close`、`aria-busy`、`hidden`），Task 5 的选择器判据全读这些。

三条既有口径，写夹具时别打架：
- `innerHTML` setter **只记字符串、不解析**（`helpers/mlib-fake-dom.js:14-15`）⇒ 凡要被断言的结构一律 `createElement` + `appendChild`，夹具里用 `html:` 挂的静态片段查不到子节点。
- `el.querySelector` **不含自身命中**（`:19-20`）⇒ 判 mask 自身命中用 `el.matches`，夹具已实现。
- 假 DOM 的 `el.style` 是普通对象、只有 `setProperty`（`:75`）⇒ 要给 `#mlib-detail-modal` 补 `removeProperty`，并维护一张「当前还活着的主题变量」表：`setProperty` 写进 `f.themeWrites[name]`、`removeProperty` 删掉它（Task 4 的「空封面不写变量」与「关窗不残留」两条断言都读它）。

同时把 `document` 的监听宿主写清楚：产品代码 `document.addEventListener('click', …)` 在本 harness 里存进 **body.listeners**（`:257`，既有 `mlib-bindings-contract.test.js:92` 同口径），所以委托点击要 `fire(f.body, 'click', { target: node })`，fire 到 window 打不到。

- [ ] **Step 2: 写失败测试**

```js
// tests/mlib-detail-modal-render.test.js —— 批D Task 3：详情按轴分流
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { bootDetail } = require('./helpers/mlib-detail-boot');   // 见 Step 4：从既有 mlib-page-detail.test.js 抽出的共用 boot

test('分流判据：专辑/歌单＝弹窗，艺人＝全屏页', () => {
  const f = bootDetail({ axis: 'albums' });
  assert.equal(f.win.stellaMlibPage.detailForm('albums'), 'modal');
  assert.equal(f.win.stellaMlibPage.detailForm('playlists'), 'modal');
  assert.equal(f.win.stellaMlibPage.detailForm('artists'), 'page');
});

test('弹窗轴：openDetail 开窗→铺骨架→铺信息区，body.mlib-detail-open 仍真相源，网格滚动一律不动', async () => {
  const f = bootDetail({ axis: 'albums', scrollTop: 240 });
  await f.win.stellaMlibPage.openDetail('albums', 'local-album:x');
  assert.equal(f.modal.calls.join(','), 'show,skeleton,renderInfo', '弹窗轴必须先开窗、等数据时铺骨架、到位后铺信息区');
  assert.equal(f.modal.lastAxis, 'albums');
  assert.ok(f.body.classList.contains('mlib-detail-open'), '真相源不得换');
  assert.equal(f.sc.scrollTop, 240, '参照库开弹窗不滚动底下的库页（钉顶只属于全屏详情）');
});

test('艺人轴：保持批C 全屏 hero 视图，不碰弹窗', async () => {
  const f = bootDetail({ axis: 'artists', scrollTop: 240 });
  await f.win.stellaMlibPage.openDetail('artists', 'local-artist:y');
  assert.equal(f.modal.calls.length, 0, '艺人轴不得开弹窗');
  assert.equal(f.sc.scrollTop, 0, '全屏详情照旧钉顶');
  assert.ok(f.doc.getElementById('mlib-detail-head').children.length > 0, '全屏 hero 照旧铺');
});

test('弹窗轴：行铺进弹窗容器，#mlib-detail-tracks 留空，且行仍由 08 的 buildTrackRow 造（不出第二份模板）', async () => {
  const f = bootDetail({ axis: 'albums' });
  await f.win.stellaMlibPage.openDetail('albums', 'local-album:x');
  assert.equal(f.doc.getElementById('mlib-detail-tracks').children.length, 0,
    '全屏详情必须留空，否则同一次点击出现两份曲目表');
  const rows = f.modal.tracksEl().children;
  assert.ok(rows.length >= 1, '弹窗里要有行或状态盒');
  assert.equal(rows[0].classList.contains('stella-mlib-track'), true, '行类名由 08 的既有构建器给');
  assert.ok(rows[0].getAttribute('data-mlib-track-id'), '行必须带轨 id，09 的 playTrack 分支才认');
});

test('closeDetail：弹窗轴收窗（hide），全屏轴照旧恢复滚动', async () => {
  const f = bootDetail({ axis: 'albums', scrollTop: 300 });
  await f.win.stellaMlibPage.openDetail('albums', 'local-album:x');
  f.win.stellaMlibPage.closeDetail();
  assert.ok(f.modal.calls.includes('hide'), '关详情必须收窗（参照库 783-794）');
  assert.equal(f.sc.scrollTop, 300, '弹窗轴返回后网格回到原处（从没动过滚动，也谈不上恢复）');
  assert.ok(!f.body.classList.contains('mlib-detail-open'), '真相源必须摘掉');
});

test('currentDetail：详情开着时回 {axis,id,form}，关掉后回 null（09 的整单播放只认这个，不读 DOM 属性）', async () => {
  const f = bootDetail({ axis: 'playlists' });
  assert.equal(f.win.stellaMlibPage.currentDetail(), null);
  await f.win.stellaMlibPage.openDetail('playlists', 'pl:1');
  assert.deepEqual(f.win.stellaMlibPage.currentDetail(), { axis: 'playlists', id: 'pl:1', form: 'modal' });
  f.win.stellaMlibPage.closeDetail();
  assert.equal(f.win.stellaMlibPage.currentDetail(), null);
});

test('在途弹窗渲染不得复活：open→close→晚到的响应一份都不铺（沿用 requestSeq 口径）', async () => {
  const f = bootDetail({ axis: 'albums', delayMs: 10 });
  const p = f.win.stellaMlibPage.openDetail('albums', 'local-album:x');
  f.win.stellaMlibPage.closeDetail();
  await p;
  assert.ok(!f.modal.calls.includes('renderInfo'), '晚到响应不得铺弹窗');
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test tests/mlib-detail-modal-render.test.js` → FAIL（`detailForm` 不是函数）

- [ ] **Step 4: 抽出共用 boot（`tests/helpers/mlib-detail-boot.js`，形状一次定死）**

起点＝`tests/mlib-page-detail.test.js:21-45` 那个 `bootDetail`（真读层 + 真页面，只把 `getDetail` 换成固定返回）。搬到 helper 时**逻辑不动，只补下面四件事**；Task 3/4/5 都从这里取 boot，**不得再各造别名**（`bootModal` / `bootModalBindings` 这类名字一律不许出现）。

```js
// bootDetail(opts) → f（在 createFakeDom 的返回值上叠加下列字段）
//   f.win / f.doc / f.body / f.html      沙箱与文档（sandbox.window 即 win）
//   f.sc                                 #music-library-scroll（网格与全屏详情共用的滚动容器）
//   f.modal                              弹窗层 spy：{ calls:[], lastAxis, info:[], tracksEl() }
//                                          calls 记 'show' | 'skeleton' | 'renderInfo' | 'hide' |
//                                          'toggleDesc' | 'setBusy' | 'setStatus'（Task 5 的 chrome 断言读它）
//   f.pageCalls                          页面层被调流水：[{ name, args }, …]（Task 5 断言意图解析读它）
//   f.ids(sel)                           **函数**：'#id' 走 getElementById，其它走 querySelector
//   f.click(node)                        fire(f.body, 'click', { target: node }) —— 委托监听宿主是 body（见 Step 1）
//   f.key(k)                             fire(f.body, 'keydown', { key:k, code:k, target:f.body, preventDefault(){f.prevented=true} })
//   f.prevented                          上一次 f.key 有没有被 preventDefault（Task 5 的 ESC 闸断言）
//   f.openAxis(axis) / f.closeLibrary()  调 window.mlibOpenAxis / window.mlibClose
//   f.themeWrites                        mask 上「当前还活着」的主题变量表：setProperty 写入、removeProperty 删除
//                                          （Task 4 用它同时验「空封面不写变量」与「关窗不残留」）
//   f.detailCalls                        既有那份：读层 getDetail 被调流水
//
// opts：{ axis, scrollTop, delayMs, detail, axisData, realModal, withBindings, playback, detailId, detailOpen, active, busy }
//   axis           → body 挂 mlib-active + mlib-axis-<axis>（09 的 currentAxis() 唯一真相源）
//   active:false   → 只摘 mlib-active（Task 5 验「库没开时 ESC 完全不消费」）
//   detailOpen     → 再挂 mlib-detail-open，并把页面层 currentDetail() 桩成 { axis, id: detailId, form:'modal' }
//   scrollTop      → f.sc.scrollTop 预置（弹窗轴「不许动网格滚动」的反证）
//   delayMs        → getDetail 延迟返回（测在途作废）
//   realModal:true → 不装 spy；加载真模块两段——08-account/01-login-modal-utils.js（开合窗真逻辑，沙箱无 gsap 走 style 兜底）
//                    + 04-shelf/15-mlib-detail-modal.js（Task 2 上半与本 Task 下半同文件，一次 loadScript 全覆盖）
//   withBindings:true → 额外加载 09 源码（Task 5 用）
```

补的五件事（其余逻辑不动）：

1. `mount` 用 Step 1 扩展后的 SHELL（弹窗子树已经在里面）。
2. 默认装 spy 弹窗层覆盖真模块（Task 3 只验分流，不验渲染；`realModal:true` 时**不装**）：

```js
  const modal = { calls: [], lastAxis: null, info: [], status: [], tracksEl: () => doc.getElementById('mlib-detail-modal-tracks') };
  win.stellaMlibDetailModal = {
    isModalAxis: (axis) => axis === 'albums' || axis === 'playlists',
    show(axis) { modal.calls.push('show'); modal.lastAxis = axis; },
    skeleton() { modal.calls.push('skeleton'); },
    renderInfo(axis, res) { modal.calls.push('renderInfo'); modal.info.push({ axis, res }); },
    hide() { modal.calls.push('hide'); },
    tracksEl: modal.tracksEl,          // 08 的 tracksHost('modal') 走它——Task 3 实现者补上的正是这一处：
                                       // 本段先前漏挂，桩面与 Interfaces 形状不一致（08 要能拿到容器）。
    setStatus(text, tone) { modal.calls.push('setStatus'); modal.status.push({ text, tone }); },
    setBusy(busy) { modal.calls.push('setBusy'); },
    isBusy: () => !!opts.busy,                             // Task 5 的「进行中不重复入队」闸用桩打开
    toggleDesc() { modal.calls.push('toggleDesc'); },
    kickerLabel: (axis) => '本地曲库 · ' + axis,
  };
```

3. `withBindings:true` 时把 `window.stellaMlibPage` 整面换成记账桩（`openAxis/close/openDetail/closeDetail/playEntity/playTrack/playEntityShuffled/detailForm/currentDetail` 各推一条 `{name,args}`），再 `win.loadScript(BIND_SRC, '09-mlib-bindings.js')`；**桩必须含 `currentDetail`**——Task 5 的整单播放拿实体 id 只认它。桩里的 `closeDetail` 要顺手摘 `mlib-detail-open`（与既有 `mlib-bindings-contract.test.js:79` 同一口径：真相源复位归页面层）。
4. `playback:true` 时挂 `win.queueSong/queueSongNext/playQueueAt` 桩并暴露 `f.state`（**逐字照搬 `tests/mlib-page-playback.test.js:50-70`**，含 `withoutQueueSong` 那条逃生门），Task 5 的 08 接线用例要数入队次数。
5. `f.sc.scrollTop = opts.scrollTop ?? 0` 预置网格滚动；`opts.delayMs` 让 `getDetail` 延迟返回（测在途作废）；`opts.busy` 打开 `isBusy()` 桩（Task 5 的进行中闸）。

抽完后把 `tests/mlib-page-detail.test.js` 改成 `require('./helpers/mlib-detail-boot')` 同一个 boot（不留第二份），既有断言一条不许放宽。

- [ ] **Step 5: 改 08 分流**

```js
  // 批D（10-26）：详情形态按轴分流（参照库实态＝专辑/歌单弹窗、艺人全屏页）。
  // 判据只有这一处；09 的调用面（openDetail/closeDetail）与 body.mlib-detail-open 真相源都不动。
  // 属主划分：行与状态盒永远由本层的 buildTrackRow/renderTracks/fillStateBox 产出（弹窗也一样），
  // 15 只管窗口本体——一份行模板两处实现是本批最大回归风险，故禁止。
  var MODAL_AXES = { albums: true, playlists: true };
  function detailModalLayer() {
    var m = window.stellaMlibDetailModal;
    return (m && typeof m.renderInfo === 'function' && typeof m.tracksEl === 'function') ? m : null;
  }
  function detailForm(axis) { return (MODAL_AXES[axis] && detailModalLayer()) ? 'modal' : 'page'; }

  // 行的落地容器：弹窗轴＝#mlib-detail-modal-tracks，全屏轴＝#mlib-detail-tracks
  function tracksHost(form) {
    if (form === 'modal') { var m = detailModalLayer(); return m ? m.tracksEl() : null; }
    return byId('mlib-detail-tracks');
  }
```

`openDetail` 里「记录滚动 + 钉顶」整段只在 `form === 'page'` 时执行（弹窗轴连 `savedScrollTop` 都不写）；`detailEntity` 多带一个 `form`；分派如下：

```js
    var form = detailForm(axis);
    var modal = form === 'modal' ? detailModalLayer() : null;
    detailEntity = { axis: axis, id: id, form: form };
    var body = document.body;
    if (body && body.classList) body.classList.add('mlib-detail-open');
    setGridViewAria(form !== 'modal');   // 弹窗轴底下网格仍可见（遮罩半透），aria-hidden 不能压
    if (form === 'modal') {
      modal.show(axis);
      clearDetail('modal');     // 只清弹窗那份 payload（上一张实体的行对象不得留着能被点）
      modal.skeleton();         // 参照库 553-557：等数据时铺 3 条骨架（顺序不能倒，clearDetail 会连骨架一起抹）
    } else {
      var sc = scrollEl();
      savedScrollTop = sc && typeof sc.scrollTop === 'number' ? sc.scrollTop : 0;
      if (sc) { sc.scrollTop = 0; if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { sc.scrollTop = 0; }); }
      clearDetail('page');
    }
    var read = readLayer();
    if (!read || typeof read.getDetail !== 'function') return;
    var res;
    try { res = await read.getDetail(axis, id); }
    catch (e) { res = { entity: null, tracks: [], status: 'error', message: (e && e.message) || '' }; }
    if (seq !== requestSeq) return;                 // 晚到的旧详情/已被返回：不铺行、不复活 payload
    if (form === 'modal') { modal.renderInfo(axis, res); renderDetailBody(axis, res, 'modal'); }
    else { renderDetailHead(axis, res.entity); renderDetailBody(axis, res, 'page'); }
```

把现有 `renderDetail(axis,res)` 拆成「铺内容」的 `renderDetailBody(axis, res, form)`：内部 `var host = tracksHost(form); if (!host) return;`，其余（`getStateCopy` 判空、`renderTracks(res.tracks, hint, host)`、状态盒 `fillStateBox(box, axis, copy, res.status)` 落进 host）与现在逐字一致。`renderTracks`/`clearDetail` 增加容器参数（现在它们内部写死 `byId('mlib-detail-tracks')`，见 `:536-551`、`:567`）：

```js
  function clearDetail(form) {
    var hosts = form === 'modal' ? [tracksHost('modal')] : [byId('mlib-detail-tracks'), byId('mlib-detail-head')];
    hosts.forEach(function (h) { if (h) h.innerHTML = ''; });
    detailPayload.clear();     // 现有那行清 Map 的逻辑照旧（08:447），两类容器共用同一份 payload 面
  }
```

`refreshDetail` 走 `detailEntity.form` 的同一条分派（不记录滚动、不钉顶的既有约束不变）；`closeDetail`：

```js
  function closeDetail() {
    requestSeq += 1;
    var form = (detailEntity && detailEntity.form) || detailForm((detailEntity && detailEntity.axis) || '');
    detailEntity = null;
    clearDetail(form);
    if (form === 'modal') { var m = detailModalLayer(); if (m) m.hide(); }
    var body = document.body;
    if (body && body.classList) body.classList.remove('mlib-detail-open');
    setGridViewAria(false);
    var sc = scrollEl();
    if (sc && form !== 'modal') sc.scrollTop = savedScrollTop;   // 弹窗轴从没动过滚动，谈不上恢复
    repaintDirtyGrid();
  }

  function currentDetail() {
    return detailEntity ? { axis: detailEntity.axis, id: detailEntity.id, form: detailEntity.form } : null;
  }
```

导出面补两项：`detailForm: detailForm, currentDetail: currentDetail`。

- [ ] **Step 6: 跑测试**

Run: `node --test tests/mlib-detail-modal-render.test.js tests/mlib-page-detail.test.js`
Expected: 新测 7/7 PASS；`mlib-page-detail.test.js` 里「专辑轴 openDetail 铺 #mlib-detail-tracks / 钉顶 / 恢复滚动」那几条**必须改成艺人轴驱动**（`axis: 'artists'`），因为形态变了——改完应保持全绿，且**不许**顺手放宽断言（钉顶与滚动恢复这两条对弹窗轴就是「不该发生」，另立新断言）。

- [ ] **Step 7: 不要 commit**

---

## Task 4: 弹窗窗口与信息区（15-mlib-detail-modal.js 下半）

**Files:**
- Modify: `public/js/modules/04-shelf/15-mlib-detail-modal.js`（Task 2 的取色上半之后接下半）
- Test: `tests/mlib-detail-modal-render.test.js`（追加窗口/信息区用例，boot 用 Task 3 Step 4 的共用面）

**Interfaces:**
- Consumes: Task 2 的 `window.stellaMlibCoverTheme`（**一律经 `window.stellaMlibCoverTheme.xxx()` 调用，不直接摸模块私有名**——假 DOM 测试要能替换它）、既有 `openGsapModal/closeGsapModal`（`08-account/01-login-modal-utils.js:2/26`）、`document.getElementById` 取 Task 1 的静态 id 面、Task 3 Step 1 的假 DOM 弹窗子树
- Produces: `window.stellaMlibDetailModal = { isModalAxis, show, hide, skeleton, renderInfo, tracksEl, setStatus, setBusy, isBusy, toggleDesc, kickerLabel }`（Task 3 的 spy 与 Task 5 的调用面都按这个形状，三处必须逐字一致）
- 本层**不**产出曲目行、**不**产出状态盒文案（都归 08 + 07 读层）；`renderInfo(axis,res)` 只消费 `res.entity`/`res.tracks`/`res.status`

- [ ] **Step 1: 写失败测试（追加到同一文件；用 `bootDetail({ realModal: true })` 跑真 15 模块）**

```js
const M = (f) => f.win.stellaMlibDetailModal;   // 真弹窗层（realModal:true）

test('renderInfo：kicker 按轴、标题走 textContent、封面走 img.src（不拼 HTML）', async () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  M(f).renderInfo('albums', { entity: { title: '六九<A>', sub: '陶喆', cover: 'data:image/png;base64,AA', count: 2, meta: { releaseYear: 1969 } }, tracks: [{ id: 't1' }, { id: 't2' }], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-kicker').textContent, '本地曲库 · 资料库专辑');
  assert.equal(f.ids('#mlib-detail-modal-heading').textContent, '六九<A>');
  assert.equal(f.ids('#mlib-detail-modal-artist').textContent, '陶喆');
  assert.ok(!f.ids('#mlib-detail-modal-heading').innerHTML.includes('<'), '标题必须走 textContent');
  assert.equal(f.ids('#mlib-detail-modal-cover').children[0].src, 'data:image/png;base64,AA');
});

test('取色打在 mask 节点上；无封面不写变量（深色降级交给 CSS）', async () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  const seen = [];
  f.win.stellaMlibCoverTheme.applyCoverTheme = (url, target) => { seen.push({ url, target }); return Promise.resolve(); };
  M(f).renderInfo('albums', { entity: { title: 'A', cover: 'https://y.qq.com/x.jpg' }, tracks: [], status: 'ok' });
  assert.equal(seen.length, 1, '必须调 applyCoverTheme');
  assert.equal(seen[0].url, 'https://y.qq.com/x.jpg', '15 传原始封面，代理归一在 Task 2 的 coverThemeSource 里做');
  assert.equal(seen[0].target, f.ids('#mlib-detail-modal'), '变量写在 mask 节点');
  M(f).renderInfo('albums', { entity: { title: 'A', cover: '' }, tracks: [], status: 'ok' });
  assert.equal(seen.length, 1, '空封面不得取色');
  assert.equal(f.themeWrites.length, 0, '空封面不得写任何主题变量');
});

test('facts：年份缺失就整块不出现；条数＝实际渲染行数；总时长有则加', () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  M(f).renderInfo('albums', { entity: { title: 'A', count: 3, meta: { releaseYear: 0 } }, tracks: [{ id: '1', duration: 200 }, { id: '2', duration: 0 }], status: 'ok' });
  assert.deepEqual(f.ids('#mlib-detail-modal-facts').children.map((n) => n.textContent), ['2 首', '3 分 20 秒'],
    '年份为 0 不进 facts；条数取实渲行数（参照库 458-466 的 trackCount 陷阱）；时长 0 不计入总和；总时长格式是参照库 fmtTotalDuration 的「M 分 SS 秒」原样（28-53），不是 mm:ss');
});

test('简介：缝不产出 description ⇒ 整块 hidden；产出则默认折叠三行，toggleDesc 展开并改文案', () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  M(f).renderInfo('albums', { entity: { title: 'A' }, tracks: [{ id: '1' }], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-desc').hidden, true);
  assert.equal(f.ids('#mlib-detail-modal-desc-toggle').hidden, true);
  M(f).renderInfo('albums', { entity: { title: 'A', description: '一段需要折叠的简介文本'.repeat(6) }, tracks: [{ id: '1' }], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-desc').hidden, false);
  assert.equal(f.ids('#mlib-detail-modal-desc').classList.contains('expanded'), false);
  M(f).toggleDesc();
  assert.equal(f.ids('#mlib-detail-modal-desc').classList.contains('expanded'), true);
  assert.equal(f.ids('#mlib-detail-modal-desc-toggle').textContent, '收起简介');
});

test('本层不造曲目行：renderInfo/skeleton 都不往行容器塞 .stella-mlib-track', () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  M(f).renderInfo('albums', { entity: { title: 'A' }, tracks: [{ id: '1' }, { id: '2' }], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-tracks').children.filter((n) => n.classList.contains('stella-mlib-track')).length, 0,
    '行的唯一属主是 08 的 buildTrackRow（Task 3 已定），这里出现行＝两份模板');
});

test('骨架：等数据时铺 3 条（62%/78%/54%）并置 aria-busy；渲染完由 08 铺行时自然替换', () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  M(f).skeleton();
  const kids = f.ids('#mlib-detail-modal-tracks').children;
  assert.deepEqual(kids.map((n) => n.classList.contains('stella-mlib-modal-skeleton')), [true, true, true]);
  assert.deepEqual(kids.map((n) => n.style.width), ['62%', '78%', '54%'], '宽度照参照库 556-558 走内联 style（CSS 里 .stella-mlib-modal-skeleton 不放宽度）');
  assert.equal(f.ids('#mlib-detail-modal-tracks').getAttribute('aria-busy'), 'true');
  M(f).renderInfo('albums', { entity: { title: 'A' }, tracks: [], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-tracks').getAttribute('aria-busy'), 'false');
});

test('整单钮：文案按轴、error/无轨一律 disabled（参照库 222-231 + 743 的进行中闸）', () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  M(f).renderInfo('albums', { entity: { title: 'A' }, tracks: [{ id: '1', matched: true }], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-play-label').textContent, '播放专辑');
  assert.equal(f.ids('#mlib-detail-modal-play').disabled, false);
  M(f).renderInfo('albums', { entity: { title: 'A' }, tracks: [], status: 'error', message: 'DB 锁' });
  assert.equal(f.ids('#mlib-detail-modal-play').disabled, true, 'error 态不得给一个点不响的播放钮');
  M(f).renderInfo('playlists', { entity: { title: 'P' }, tracks: [{ id: '1', matched: true }], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-play-label').textContent, '播放歌单');
  M(f).setBusy(true);
  assert.equal(M(f).isBusy(), true);
  assert.equal(f.ids('#mlib-detail-modal-play-label').textContent, '正在播放…');
  M(f).setBusy(false);
  assert.equal(f.ids('#mlib-detail-modal-play-label').textContent, '播放歌单', '忙态解除后文案要回到轴口径');
});

test('show/hide 生命周期：show 先清主题再开窗、滚动置顶；hide 经 closeGsapModal 的 afterClose 清主题', () => {
  const f = bootDetail({ axis: 'albums', realModal: true });   // realModal 会连 01-login-modal-utils.js 一起加载（沙箱无 gsap → style 兜底分支）
  const mask = f.ids('#mlib-detail-modal');
  M(f).show('albums');
  assert.equal(mask.classList.contains('show'), true, 'openGsapModal 的产物就是 .show');
  assert.equal(f.ids('#mlib-detail-modal-scroll').scrollTop, 0, '参照库 799-800：开窗即置顶');
  f.win.stellaMlibCoverTheme.applyThemeVars(200, 60, 90, mask);          // 先让主色真的落上去
  assert.equal(Object.keys(f.themeWrites).length, 5, 'applyThemeVars 要在 mask 上写满 5 个主题变量');
  M(f).show('playlists');                                                // 换轴重开（单弹窗承载两轴）
  assert.equal(Object.keys(f.themeWrites).length, 0, 'show 必须先清上一份主色，否则歌单顶着专辑的配色');
  f.win.stellaMlibCoverTheme.applyThemeVars(20, 180, 120, mask);
  M(f).hide();
  assert.equal(mask.classList.contains('show'), false, 'closeGsapModal 无 gsap 时同步收尾');
  assert.equal(Object.keys(f.themeWrites).length, 0, '关窗后主题变量不得残留（参照库 786-792）');
  assert.equal(M(f).isModalAxis('artists'), false, '艺人轴不进弹窗（与 08 的 MODAL_AXES 同一判据）');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/mlib-detail-modal-render.test.js` → FAIL（真 15 模块里没有 `stellaMlibDetailModal`，Task 2 只导出 `stellaMlibCoverTheme`）

- [ ] **Step 3: 写模块下半**（逐字移植 `07-album-detail.js`：`setStatus` 213-220、专辑档 `setPlayBusy` 222-231 与歌单档 `plSetBusy` 869-878、`fmtTotalDuration` 28-53、`renderInfo` 423-471、`toggleAmAlbumDescription` 770-782、`closeAmAlbumDetail` 783-794、`openAmAlbumDetail` 795-808；改名 + 数据源换成读层结果）

```js
// ============================================================================
// 弹窗窗口与信息区（下半）：08 拥有曲目行与状态盒，本层只拥有窗口、信息区、整单钮、骨架。
// 一份行模板两处实现是本批最大回归风险 ⇒ 本模块**禁止**出现 .stella-mlib-track 的构建代码。
// ============================================================================
var STELLA_MLIB_MODAL_ID = 'mlib-detail-modal';
var STELLA_MLIB_AXIS_LABELS = { albums: '资料库专辑', playlists: '资料库歌单', artists: '资料库艺人' };
var stellaMlibModalState = { axis: '', descFull: '', descExpanded: false, busy: false };

function stellaMlibModalEl(id) { return document.getElementById(id); }
function stellaMlibModalMask() { return stellaMlibModalEl(STELLA_MLIB_MODAL_ID); }
function stellaMlibModalTracksEl() { return stellaMlibModalEl('mlib-detail-modal-tracks'); }
function stellaMlibModalIsModalAxis(axis) { return axis === 'albums' || axis === 'playlists'; }
// kicker：参照库按 provider 标源（SOURCE_KICKER_LABELS 232-239），本项目只有「本地曲库」一种源
function stellaMlibModalKickerLabel(axis) { return '本地曲库 · ' + (STELLA_MLIB_AXIS_LABELS[axis] || '详情'); }
// 整单钮文案：参照库专辑档写死「播放专辑」(222-231)、歌单档写死「播放歌单」(1049+)
function stellaMlibModalPlayLabel(axis) { return axis === 'playlists' ? '播放歌单' : '播放专辑'; }

function stellaMlibModalText(id, value) {
  var n = stellaMlibModalEl(id);
  if (!n) return null;
  n.textContent = String(value == null ? '' : value);   // 一律 textContent：标题/艺人名可能带尖括号
  return n;
}

// 参照库 fmtTotalDuration（28-53）逐字：整分钟取整在短专辑上会显示成「0 分钟」，所以精确到秒
function stellaMlibModalTotalDuration(tracks) {
  var total = 0, known = 0;
  (tracks || []).forEach(function (t) {
    var d = Number(t && t.duration);
    if (isFinite(d) && d > 0) { total += d; known += 1; }
  });
  if (!known) return '';
  var m = Math.floor(total / 60);
  var r = Math.round(total % 60);
  if (r === 60) { m += 1; r = 0; }                      // 参照库同款进位修正
  return m + ' 分 ' + (r < 10 ? '0' : '') + r + ' 秒';
}

function stellaMlibModalSetStatus(text, tone) {         // 参照库 213-220 逐字
  var s = stellaMlibModalEl('mlib-detail-modal-status');
  if (!s) return;
  if (!text) { s.hidden = true; s.textContent = ''; s.removeAttribute('data-tone'); return; }
  s.hidden = false;
  s.textContent = text;
  if (tone) s.setAttribute('data-tone', tone); else s.removeAttribute('data-tone');
}

// 参照库 plSetBusy（869-878）那份：本窗口同时装播放钮与随机钮，两颗整单钮一起收
//（专辑档 222-231 只管一颗，是因为参照库专辑窗里根本没有随机钮）
function stellaMlibModalSetBusy(busy) {
  stellaMlibModalState.busy = !!busy;
  var btn = stellaMlibModalEl('mlib-detail-modal-play');
  var shuffle = stellaMlibModalEl('mlib-detail-modal-shuffle');
  var label = stellaMlibModalEl('mlib-detail-modal-play-label');
  if (btn) { btn.disabled = !!busy; btn.setAttribute('aria-busy', busy ? 'true' : 'false'); }
  if (shuffle) { shuffle.disabled = !!busy; shuffle.setAttribute('aria-busy', busy ? 'true' : 'false'); }
  if (label) label.textContent = busy ? '正在播放…' : stellaMlibModalPlayLabel(stellaMlibModalState.axis);
}

function stellaMlibModalIsBusy() { return !!stellaMlibModalState.busy; }

function stellaMlibModalSkeleton() {                    // 参照库 553-557
  var wrap = stellaMlibModalTracksEl();
  if (!wrap) return;
  wrap.setAttribute('aria-busy', 'true');
  wrap.innerHTML = '';
  // 三条 62%/78%/54% 逐字照参照库；宽度走内联 style（CSS 不管宽度）。
  // 一律 createElement：假 DOM 的 innerHTML 不解析，真 DOM 里拼串等于把结构交给字符串。
  ['62%', '78%', '54%'].forEach(function (w) {
    var bar = document.createElement('div');
    bar.classList.add('stella-mlib-modal-skeleton');
    bar.style.width = w;
    wrap.appendChild(bar);
  });
}

function stellaMlibModalToggleDesc() {                  // 参照库 770-782 逐字
  if (!stellaMlibModalState.descFull) return;           // 没有简介就没得展开
  stellaMlibModalState.descExpanded = !stellaMlibModalState.descExpanded;
  var desc = stellaMlibModalEl('mlib-detail-modal-desc');
  var toggle = stellaMlibModalEl('mlib-detail-modal-desc-toggle');
  if (desc) desc.classList.toggle('expanded', stellaMlibModalState.descExpanded);
  if (toggle) toggle.textContent = stellaMlibModalState.descExpanded ? '收起简介' : '展开简介';
}

function stellaMlibModalShow(axis) {                    // 参照库 openAmAlbumDetail 795-808
  var mask = stellaMlibModalMask();
  if (!mask) return;
  var theme = window.stellaMlibCoverTheme;
  if (theme && typeof theme.clearTheme === 'function') theme.clearTheme(mask);
  // 单弹窗承载两轴：开窗先摘上一份主色，否则歌单会顶着专辑的配色
  //（参照库用两个窗避开这个问题，本项目一个窗就得显式清）。
  stellaMlibModalState.axis = axis;
  stellaMlibModalState.descExpanded = false;
  stellaMlibModalState.descFull = '';
  stellaMlibModalSetStatus('');
  stellaMlibModalSetBusy(false);
  var play = stellaMlibModalEl('mlib-detail-modal-play');
  var shuffle = stellaMlibModalEl('mlib-detail-modal-shuffle');
  if (play) play.disabled = true;                       // 与参照库的一处收紧：等数据期间不给点，
  if (shuffle) shuffle.disabled = true;                 // 免得 loading 窗里连点两下入队两份
  var sc = stellaMlibModalEl('mlib-detail-modal-scroll');
  if (sc) sc.scrollTop = 0;                             // 参照库 799-800：开窗即置顶
  if (mask) mask.setAttribute('aria-hidden', 'false');  // 本仓每个静置弹窗都带 aria-hidden="true"
  if (typeof openGsapModal === 'function') openGsapModal(mask);   // 08-account/01-login-modal-utils.js:2
}

function stellaMlibModalHide() {                        // 参照库 closeAmAlbumDetail 783-794
  var mask = stellaMlibModalMask();
  if (!mask) return;
  function finish() {
    var theme = window.stellaMlibCoverTheme;
    if (theme && typeof theme.clearTheme === 'function') theme.clearTheme(mask);
    // 变量随窗口消失，不污染底下的资料库页（参照库 786-792 同一收口）
    stellaMlibModalState.axis = '';
    stellaMlibModalState.busy = false;
    stellaMlibModalState.descFull = '';
    stellaMlibModalState.descExpanded = false;
  }
  if (typeof closeGsapModal === 'function') closeGsapModal(mask, finish);   // 无 gsap 时它同步跑 finish
  else finish();
  mask.setAttribute('aria-hidden', 'true');   // 与 show() 成对：藏起来的窗口不得留在读屏树里（Task 1 终审 Minor ③）
}

// 只铺信息区（窗口上半），行与状态盒归 08。res＝读层 getDetail 的原样 { entity, tracks, status, message }
function stellaMlibModalRenderInfo(axis, res) {
  var r = res || {};
  var e = r.entity || {};
  var tracks = Array.isArray(r.tracks) ? r.tracks.filter(Boolean) : [];
  stellaMlibModalState.axis = axis;                     // setBusy(false) 的文案要回到轴口径

  stellaMlibModalText('mlib-detail-modal-kicker', stellaMlibModalKickerLabel(axis));
  // 参照库 435：标题空时给「未命名专辑」/「未命名歌单」，h2 同时补 title（长名截断时能看全）
  var name = String(e.title == null ? '' : e.title) || (axis === 'playlists' ? '未命名歌单' : '未命名专辑');
  var h = stellaMlibModalText('mlib-detail-modal-heading', name);
  if (h) h.setAttribute('title', name);
  stellaMlibModalText('mlib-detail-modal-artist', String(e.sub == null ? '' : e.sub));  // 读层副标题＝艺人/创建者

  // 简介：本项目缝暂不产 description（引擎侧欠账，见 spec §3）⇒ 常态整块 hidden；有则默认折叠三行（参照库 438-457）
  stellaMlibModalState.descFull = String(e.description || '').trim();
  var desc = stellaMlibModalEl('mlib-detail-modal-desc');
  var toggle = stellaMlibModalEl('mlib-detail-modal-desc-toggle');
  if (!stellaMlibModalState.descFull) {
    if (desc) { desc.hidden = true; desc.textContent = ''; desc.classList.remove('expanded'); }
    if (toggle) { toggle.hidden = true; toggle.textContent = '展开简介'; }
    stellaMlibModalState.descExpanded = false;
  } else {
    if (desc) {
      desc.hidden = false;
      desc.textContent = stellaMlibModalState.descFull;
      desc.classList.toggle('expanded', stellaMlibModalState.descExpanded);
    }
    if (toggle) { toggle.hidden = false; toggle.textContent = stellaMlibModalState.descExpanded ? '收起简介' : '展开简介'; }
  }

  // facts（参照库 458-471）：年份 → 条数 → 总时长。genreNames 本项目缝不产 ⇒ 不渲染。
  // 条数一律取**实际行数**，不信 entity.count（参照库 458-466 的 trackCount 陷阱同一口径）。
  var facts = [];
  var year = Number((e.meta && e.meta.releaseYear) || 0);        // 缝给的是数字年份，不是参照库的 releaseDate 串
  if (year > 0) facts.push(String(year));
  if (tracks.length > 0) facts.push(tracks.length + ' 首');
  var total = stellaMlibModalTotalDuration(tracks);
  if (total) facts.push(total);
  var factsEl = stellaMlibModalEl('mlib-detail-modal-facts');
  if (factsEl) {
    factsEl.innerHTML = '';                                      // createElement 而非拼串（假 DOM 不解析 + 不交给字符串）
    facts.forEach(function (text) {
      var span = document.createElement('span');
      span.textContent = text;
      factsEl.appendChild(span);
    });
  }

  // 整单钮：error／空轨／无可播轨一律 disabled（参照库 743 的「没名字就别给按钮」同一判据）
  var playable = tracks.some(function (t) { return !!t.matched; });
  var dead = r.status !== 'ok' || !playable;
  var play = stellaMlibModalEl('mlib-detail-modal-play');
  var shuffle = stellaMlibModalEl('mlib-detail-modal-shuffle');
  if (play && !stellaMlibModalState.busy) play.disabled = dead;
  if (shuffle && !stellaMlibModalState.busy) shuffle.disabled = dead;
  var label = stellaMlibModalEl('mlib-detail-modal-play-label');
  if (label && !stellaMlibModalState.busy) label.textContent = stellaMlibModalPlayLabel(axis);

  var wrap = stellaMlibModalTracksEl();
  if (wrap) wrap.setAttribute('aria-busy', 'false');    // 骨架的 busy 态在这里收口；随后 08 往同一容器铺行

  var mask = stellaMlibModalMask();
  var theme = window.stellaMlibCoverTheme;
  var cover = String(e.cover == null ? '' : e.cover);
  if (!mask || !theme) return;
  if (cover && typeof theme.applyCoverTheme === 'function') {
    var p = theme.applyCoverTheme(cover, mask);          // 传原始封面：代理归一在 coverThemeSource 里做
    if (p && typeof p.catch === 'function') p.catch(function () { /* 取色失败＝CSS 深色兜底 */ });
  } else if (!cover && typeof theme.clearTheme === 'function') {
    theme.clearTheme(mask);                              // 无封面＝不写任何变量，交给 CSS 默认色
  }
}

window.stellaMlibDetailModal = {
  isModalAxis: stellaMlibModalIsModalAxis,
  show: stellaMlibModalShow,
  hide: stellaMlibModalHide,
  skeleton: stellaMlibModalSkeleton,
  renderInfo: stellaMlibModalRenderInfo,
  tracksEl: stellaMlibModalTracksEl,
  setStatus: stellaMlibModalSetStatus,
  setBusy: stellaMlibModalSetBusy,
  isBusy: stellaMlibModalIsBusy,
  toggleDesc: stellaMlibModalToggleDesc,
  kickerLabel: stellaMlibModalKickerLabel,
};
```

> **与参照库的四处有意差异（终审时须逐条向主人复述，不得静默采纳）**
> 1. **一个窗装两轴**：参照库专辑/歌单各一个 mask（`index.html:2008-2085`），主题变量天然不互覆；本项目共用一个，所以 `show()` 显式 `clearTheme`。
> 2. **不写 inline `onclick`**：参照库把 `onclick="closeAmAlbumDetail()"` 与各自的 `wrap.addEventListener` 散在 809-853；本项目事件面唯一属主是 09 那枚 document 委托（Task 5），本模块只导出方法。
> 3. **不搬视频动态封面**（`applyAlbumMotionArtwork` 400-422）：Apple 的 `artwork` 视频接口本地库没有对应物，搬过来就是死代码。
> 4. **`entity.count` 不参与 facts**：条数一律实渲行数；缝当前给的 `count` 与轨数同源，但判据按参照库的陷阱写死，防引擎侧改动后再次不一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/mlib-detail-modal-render.test.js` → 15/15 PASS（Task 3 的 7 条 + 本 Task 的 8 条）

- [ ] **Step 5: 不要 commit**

---

## Task 5: 绑定与生命周期收口（09-mlib-bindings.js）

**Files:**
- Modify: `public/js/modules/04-shelf/09-mlib-bindings.js`（唯一委托 `:204-272` 的分支序列、`window.mlibClose` `:101-119`）
- Modify: `public/js/modules/04-shelf/08-mlib-page.js`（`playEntity` `:756-772` 的 busy/status 接线 + 新增 `playEntityShuffled`）
- Test: `tests/mlib-detail-modal-bindings.test.js`（Create）

**Interfaces:**
- Consumes: `window.stellaMlibPage.{detailForm, openDetail, closeDetail, playEntity, playTrack, playEntityShuffled, currentDetail}`（后两条本 Task 新增）、`window.stellaMlibDetailModal.{toggleDesc, isBusy, setBusy, setStatus, hide}`、`document.body` 上的 `mlib-active` / `mlib-axis-*` / `mlib-detail-open`
- Produces: 事件面词汇 `data-mlib-modal-close`、`data-mlib-modal-play`、`data-mlib-modal-shuffle`、`data-mlib-modal-desc-toggle`；遮罩自身命中靠 `event.target.matches('#mlib-detail-modal')` 判定（无属性）
- boot 一律用 Task 3 Step 4 的 `bootDetail`：`withBindings: true` 挂 09，`playback: true` 挂 `queueSong/playQueueAt` 桩（照搬 `tests/mlib-page-playback.test.js:50-70` 那份，含 `f.state.queued/playCalls`）。**不得再造 `bootModalBindings`。**

- [ ] **Step 1: 写失败测试**

```js
// tests/mlib-detail-modal-bindings.test.js —— 批D Task 5：弹窗事件仍走 09 那唯一一枚 document click 委托
'use strict';
const test = require('node:test');
const assert = require('node:assert');            // 宽松断言：vm 跨 realm，deepStrictEqual 会误报（仓内约定）
const { bootDetail } = require('./helpers/mlib-detail-boot');

const B = (o) => bootDetail(Object.assign({ withBindings: true, axis: 'albums', detailOpen: true }, o || {}));
const names = (f) => f.pageCalls.map((c) => c.name);

test('关闭钮 → closeDetail（一次点击只出一个意图）', () => {
  const f = B();
  f.click(f.ids('[data-mlib-modal-close]'));
  assert.deepEqual(names(f), ['closeDetail']);
});

test('遮罩空白处点击＝关闭；窗口内点击不算遮罩（参照库 849-851 event.target===mask 口径）', () => {
  const f = B();
  f.click(f.ids('#mlib-detail-modal'));
  assert.equal(f.pageCalls.filter((c) => c.name === 'closeDetail').length, 1);
  f.pageCalls.length = 0;
  f.click(f.ids('.stella-mlib-modal'));        // 目标落在窗口本体：closest 链一路向上但 mask 是**父级**，不算自身命中
  assert.deepEqual(names(f), [], '窗口内点击不得当成遮罩');
});

test('播放全部＝playEntity(当前轴, 当前详情实体 id)：轴名与 id 都取真相源，不读按钮属性', () => {
  const f = B({ detailId: 'local-album:x' });
  f.click(f.ids('[data-mlib-modal-play]'));
  assert.deepEqual(f.pageCalls[0], { name: 'playEntity', args: ['albums', 'local-album:x'] });
});

test('随机播放＝playEntityShuffled；专辑轴不放随机入口（参照库 index.html:2068 只有歌单窗有随机钮）', () => {
  const f = B({ axis: 'playlists', detailId: 'pl:1' });
  f.click(f.ids('[data-mlib-modal-shuffle]'));
  assert.deepEqual(f.pageCalls[0], { name: 'playEntityShuffled', args: ['playlists', 'pl:1'] });
  const a = B({ detailId: 'local-album:x' });    // 轴＝albums
  a.click(a.ids('[data-mlib-modal-shuffle]'));
  assert.deepEqual(names(a), [], '专辑轴命中随机钮也不发意图（CSS 已隐藏，这里是代码闸）');
});

test('展开简介钮走 toggleDesc，不发播放意图', () => {
  const f = B();
  f.click(f.ids('[data-mlib-modal-desc-toggle]'));
  assert.deepEqual(f.modal.calls, ['toggleDesc']);
  assert.deepEqual(names(f), []);
});

test('弹窗里的曲目行仍走既有 playTrack 分支（同一委托，不新增监听；点行内格子靠 closest 回行）', () => {
  const f = B();
  const row = f.doc.createElement('div');
  row.classList.add('stella-mlib-track');
  row.setAttribute('data-mlib-track-id', 't7');
  const nameCell = f.doc.createElement('div');            // 曲名格子（真库里点的是它，不是行本体）
  row.appendChild(nameCell);
  f.ids('#mlib-detail-modal-tracks').appendChild(row);
  f.click(nameCell);
  assert.deepEqual(f.pageCalls[0], { name: 'playTrack', args: ['t7'] });
});

test('整单播放进行中：重复点击不再入队（isBusy 闸，参照库 742-743 同口径）', () => {
  const f = B({ busy: true });
  f.click(f.ids('[data-mlib-modal-play]'));
  f.click(f.ids('[data-mlib-modal-shuffle]'));
  assert.deepEqual(names(f), [], 'busy 期间两颗整单钮都当已识别、不发意图');
});

test('ESC：弹窗开着 → closeDetail（详情→网格→关库三级顺序不变）；库没开时完全不消费', () => {
  const f = B();
  f.key('Escape');
  assert.equal(f.pageCalls[0].name, 'closeDetail');
  assert.equal(f.prevented, true);
  const g = B({ detailOpen: false, active: false });
  g.key('Escape');
  assert.equal(g.prevented, false, '资料库没开时不得拦 ESC（既有 ESC 链原样运行）');
});

test('切轴收窗：开另一轴前先回网格（详情弹窗不得浮在别的轴上）', () => {
  const f = B();
  f.openAxis('artists');                       // forceOpenAxis 里那句 ensureDetailClosed（:49-57）就是收口
  assert.ok(names(f).includes('closeDetail'), '切轴必须走 closeDetail，由 08 负责 hide()');
});

test('关库收窗：mlibClose 必须先经 closeDetail（切轴那条已由 ensureDetailClosed 覆盖，关库是唯一漏点）', () => {
  const f = B();
  f.closeLibrary();
  assert.ok(names(f).includes('closeDetail'), '关库不先复位详情＝弹窗 .show 浮在首页上（hide 本身已由 Task 3「closeDetail：弹窗轴收窗」那条盖住，这里只验调用链）');
});

test('08 接线：弹窗轴整单播放前后打 busy，零入队时把读层文案写进状态行（不静默、不发明）', async () => {
  const f = bootDetail({ axis: 'albums', playback: true, detailOpen: true,
    axisData: { axis: 'albums', cards: [{ id: 'AL1', title: 'A', sub: 'x', cover: '', count: 1, playable: true, meta: {} }], status: 'ok' },
    detail: { entity: { id: 'AL1', title: 'A', sub: 'x', cover: '', count: 1, playable: true, meta: {} }, tracks: [{ id: 't1', name: 'n', matched: false, duration: 100 }], status: 'ok' } });
  await f.win.stellaMlibPage.openAxis('albums');
  await f.win.stellaMlibPage.openDetail('albums', 'AL1');
  f.modal.calls.length = 0;
  const n = await f.win.stellaMlibPage.playEntity('albums', 'AL1');
  assert.equal(n, 0, '唯一一条 unmatched ⇒ 零入队');
  assert.equal(f.state.queued.length, 0);
  assert.deepEqual(f.modal.calls, ['setBusy', 'setStatus', 'setBusy'], '进 await 前收钮、finally 放钮；零入队必须给话说');
  assert.equal(f.modal.status[0].text, f.read.unplayableHint(), '状态行文案＝读层既有 hint，本批不发明新串');
  assert.equal(f.modal.status[0].tone, 'warn');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/mlib-detail-modal-bindings.test.js`
Expected: FAIL —chrome 分支不存在（关闭钮/遮罩/整单钮点击落到 `runPlayIntent` 后静默）、`playEntityShuffled` 未定义、`mlibClose` 没收窗、`playEntity` 不打 busy。

- [ ] **Step 3: 改绑定（09）+ 播放接线（08）**

09 里加一段「弹窗 chrome」判定，排在 `runPlayIntent` **之后**、`runDetailBack` **之前**（弹窗里的行已被 `TRACK_ROW_SELECTOR` 那条分支吃掉，chrome 钮不能和行/卡抢顺序）：

```js
  // ---------- 弹窗 chrome（批D）：关闭 / 遮罩 / 整单播放 / 随机 / 展开简介 ----------
  // 仍是同一条 document click 委托：本模块从 04-shelf 起就是资料库事件面的唯一属主，
  // 参照库那侧 inline onclick + 各自 wrap addEventListener（07-album-detail.js:809-853）不照搬。
  var MODAL_MASK_SELECTOR = '#mlib-detail-modal';
  var MODAL_CLOSE_SELECTOR = '[data-mlib-modal-close]';
  var MODAL_PLAY_SELECTOR = '[data-mlib-modal-play]';
  var MODAL_SHUFFLE_SELECTOR = '[data-mlib-modal-shuffle]';
  var MODAL_DESC_SELECTOR = '[data-mlib-modal-desc-toggle]';

  function detailModal() {
    var m = window.stellaMlibDetailModal;
    return (m && typeof m.toggleDesc === 'function' && typeof m.isBusy === 'function') ? m : null;
  }

  // 整单播放拿的是「当前详情实体」，不是卡上的 data-mlib-id：弹窗底下的网格虽仍在（遮罩半透），
  // 但实体真相源只有页面层的 detailEntity（currentDetail()），属性面再塞一份就是第二个真相源。
  function currentDetailId() {
    var p = page();
    if (!p || typeof p.currentDetail !== 'function') return '';
    var d = p.currentDetail();
    return d && d.id != null ? String(d.id) : '';
  }

  function runModalChrome(t) {
    if (!hasBodyClass('mlib-detail-open')) return false;   // 真相源闸：详情没开一律静默
    var m = detailModal();
    if (t.closest(MODAL_DESC_SELECTOR)) { if (m) m.toggleDesc(); return true; }
    // 遮罩自身命中才算「点空白关闭」；窗口内任何子孙都走 closest 找不到 mask（el.matches 才判自身）
    if (t.closest(MODAL_CLOSE_SELECTOR) || (typeof t.matches === 'function' && t.matches(MODAL_MASK_SELECTOR))) {
      callPageAction('closeDetail', []);
      return true;
    }
    if (t.closest(MODAL_PLAY_SELECTOR)) {
      if (m && m.isBusy()) return true;                    // 参照库 743：进行中不重复入队
      var id = currentDetailId();
      if (id) callPageAction('playEntity', [currentAxis(), id]);
      return true;
    }
    if (t.closest(MODAL_SHUFFLE_SELECTOR)) {
      if (currentAxis() === 'albums') return true;         // 专辑轴不放随机：命中也算已识别，但不发意图
      if (m && m.isBusy()) return true;
      var pid = currentDetailId();
      if (pid) callPageAction('playEntityShuffled', [currentAxis(), pid]);
      return true;
    }
    return false;
  }
```

`onCardClick` 里插在 `runPlayIntent` 之后：

```js
    if (runPlayIntent(t)) return;
    if (runModalChrome(t)) return;      // 批D：弹窗 chrome（关闭/遮罩/整单/随机/简介）
    if (runDetailBack(t)) return;
```

`window.mlibClose` 在 `seq += 1` 之后补一行收窗（切轴早已由 `forceOpenAxis` 里的 `ensureDetailClosed()` 覆盖，关库是唯一的漏点）：

```js
  window.mlibClose = function () {
    seq += 1;
    ensureDetailClosed();   // 批D：关库前先把详情（含弹窗）复位，否则 mask 的 .show 浮在首页上
    ...原样...
  };
```

> 注意这行的位置：必须**先于** `p.close()`。`close()` 会 `clearGrid()` 清掉网格 payload，而 `closeDetail()` 里的 `detailPayload.clear()` 与 `repaintDirtyGrid()` 还要读现挂的轴类；顺序倒了就是「详情清理读到空网格」。ESC 那一级本来就调 `closeDetail`，不重复挂。

08 配套两处（`playEntity` 与新增的 `playEntityShuffled`）：

```js
  // 弹窗轴的整单播放把「进行中」显式打在窗口上（参照库 742-743 同一收口）。
  // 全屏详情没有这两枚节点，modal 层缺席时 setBusy 分支整个跳过——所以判据用 detailForm，不看 DOM 存在性。
  async function playEntity(axis, id) {
    var modal = detailForm(axis) === 'modal' ? detailModalLayer() : null;
    if (modal) modal.setBusy(true);                 // 进 await 前收钮：读层是异步的，连点会入队两份
    try {
      var card = gridCardById(id);
      if (!card || !card.playable) return 0;
      var read = readLayer();
      if (!read || typeof read.getDetail !== 'function') return 0;
      var seqNow = playSeq;
      var res;
      try { res = await read.getDetail(axis, id); } catch (e) { return 0; }
      if (seqNow !== playSeq) return 0;             // 原口径一字不动：在途切轴/关闭 ⇒ 一份都不入队
      var enq = enqueueMatched(res && res.tracks);
      if (enq.n > 0) startPlaybackAt(enq.firstIdx);
      else if (modal) modal.setStatus(unplayableHintOf(read), 'warn'); // 零入队必须给话说，文案取读层既有 hint
      return enq.n;
    } finally {
      if (modal) modal.setBusy(false);              // 成功/失败/作废三条路都要放钮
    }
  }

  // 随机整单：只有「入队前打乱」这一步与 playEntity 不同。
  // spec §4「本层绝不 sort」约束的是**渲染**顺序；随机钮本来就是来改顺序的，不冲突。
  // 打乱用参照库 1078-1084 的 Fisher-Yates 逐字；入队/起播仍走 enqueueMatched + startPlaybackAt 同一条链。
  async function playEntityShuffled(axis, id) {
    var modal = detailForm(axis) === 'modal' ? detailModalLayer() : null;
    if (modal) modal.setBusy(true);
    try {
      var card = gridCardById(id);
      if (!card || !card.playable) return 0;
      var read = readLayer();
      if (!read || typeof read.getDetail !== 'function') return 0;
      var seqNow = playSeq;
      var res;
      try { res = await read.getDetail(axis, id); } catch (e) { return 0; }
      if (seqNow !== playSeq) return 0;
      var arr = (res && Array.isArray(res.tracks)) ? res.tracks.filter(Boolean) : [];   // 本地副本：不覆写读层那份共享数组
      for (var i = arr.length - 1; i > 0; i -= 1) {                                      // 参照库 1078-1084 逐字
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      }
      var enq = enqueueMatched(arr);                                                     // unmatched 仍在这一步被过滤
      if (enq.n > 0) startPlaybackAt(enq.firstIdx);
      else if (modal) modal.setStatus(unplayableHintOf(read), 'warn');
      return enq.n;
    } finally {
      if (modal) modal.setBusy(false);
    }
  }
```

导出面补两项：`playEntityShuffled: playEntityShuffled`（`currentDetail` 已在 Task 3 加过）。

- [ ] **Step 4: 跑测试**

Run: `node --test tests/mlib-detail-modal-bindings.test.js tests/mlib-detail-modal-render.test.js tests/mlib-page-detail.test.js tests/mlib-page-playback.test.js tests/mlib-bindings-contract.test.js`
Expected: 全绿。`mlib-bindings-contract.test.js` 里有「委托分支顺序」「keydown 恰一处注册」这类源码级守卫，chrome 分支插进去会惊动它们——**同步更新断言里的计数，不许顺手放宽**。

- [ ] **Step 5: 不要 commit**

---

## Task 6: 回归、取证与文档收口

**Files:**
- Modify: `tests/mlib-grid-layout.test.js`（仅当列数赋值计数受新增 CSS 影响时才同步；不受影响就别动）
- Modify: `tests/fixtures/mlib-detail-probe-ours.html`（探针改指弹窗）
- Modify: `docs/superpowers/specs/2026-10-18-local-music-library-design.md`（§2 形态、§4 详情契约）
- Modify: `.superpowers/sdd/2026-10-18-local-music-library/progress.md`（追加批D 台账）
- Modify: `docs/superpowers/plans/2026-10-18-local-music-library-smoke.md`（冒烟项按两形态重写）

- [ ] **Step 1: 重打 bundle**

Run: `npm run bundle`
Expected: 无报错；新模块进 `public/js/bundles/04-shelf.bundle.js`

- [ ] **Step 2: 跑 mlib 全批 + 复核模块计数**

Run: `node --test tests/bundle-modules.test.js tests/mlib-*.test.js tests/home-quick-cards-library-entries.test.js`
Expected: 全绿（计数已在 Task 2 Step 4 同步为 127；10-31 实跑 `node .scratch/count-modules.js` = 126，其中并发会话的 `05-playback/22-replay-gain.js` 已注册进 `index-loader.js:128` 并被算进这 126，本批再加 1 条即 127）。若这一条仍红，先重跑 `node .scratch/count-modules.js` 取实数——**只改断言里的数字，别去动别人家的模块列表**；改完仍红就单跑复核一次（39867/39879 端口类抖动）。

- [ ] **Step 3: 全量回归**

Run: `npm test`
Expected: 除已登记的并发会话抖动外全绿；任何新增红必须在台账里写明归因。

- [ ] **Step 4: 离屏探针取证（必做，不许靠读 CSS）**

把 `tests/fixtures/mlib-detail-probe-ours.html` 改成弹窗结构（`body class="mlib-active mlib-axis-albums mlib-detail-open"` + `#mlib-detail-modal.modal-mask.show > .modal.stella-mlib-modal` 全子树 + 3 行曲目），量 `modal/scroll/cover/meta/tracks/track/name/foot/play`，与 `.scratch/mlib-detail-probe-ref.html` 同宽对照：

```bash
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
for w in 1920 1200 900; do
  "$EDGE" --headless=new --disable-gpu --no-sandbox --window-size=$w,1000 --virtual-time-budget=2500 \
    --user-data-dir=/c/Users/Administrator/Desktop/Stellaflix/.scratch/edge-p-$w \
    --dump-dom "file:///C:/Users/Administrator/Desktop/Stellaflix/tests/fixtures/mlib-detail-probe-ours.html" 2>/dev/null | grep -o "OURS vw=[0-9]*.*"
done
```

验收数字（与 10-26 实测的参照库对齐）：`modal=1080x* @L` 居中、`cover=268x268`、`track=1026x52`、`name=587x20`；vw=900 时 `modal=844`（`100vw-56`）。任一项对不上就是移植漏了数，回到 Task 1 改 CSS，不许放宽验收。
注意两条既有坑：`#mlib-view-detail` 的显隐闸依赖 `mlib-detail-open`（Task 1 改成分轴后，弹窗轴那一档必须确认它仍 `display:none`）；探针脚本里每次按轴改写 `body.className` 时**要把 `mlib-detail-open` 一起写进去**，漏了就量到 0×0 假阳性。
> **落地更正（R14，终审复评 New-Issue）**：探针夹具原先写在 `.scratch/`（该目录未跟踪、也没进 `.gitignore`），而 `tests/mlib-detail-modal-css.test.js` 末条要在运行期读它做 id 同构核对——被跟踪的测试依赖未跟踪文件 ⇒ 新克隆/CI 会以 ENOENT 红，把「夹具不在」冒充成「副本漂移」。故夹具已移入 **`tests/fixtures/mlib-detail-probe-ours.html`**（随包入库，两条 `<link>` 已改相对路径 `../../public/css/*`，同档复量数字逐字段不变：`vw=1896 modal=1080x552@L408 / cover 268x268 / track 1026x52 / name 587x20`）。参照库侧 `-ref.html` 仍留 `.scratch/`（无测试依赖）。同条断言的射程同时收窄为「只钉 id 集合」，class/嵌套/夹具手写文案不在射程。

- [ ] **Step 5: 改 spec §2/§4**

§2「详情形态」改写为两形态并附实测数字（弹窗 1080/268/1026，艺人全屏 hero 148）；§4 详情实体契约补一行：`entity` 可选带 `description`，缝不给就整块不渲染（不合成）。原 10-18「三轴统一全屏二级页」那句要显式标注被本批推翻，别留两套口径。

- [ ] **Step 6: 更新冒烟清单与台账**

`docs/superpowers/plans/2026-10-18-local-music-library-smoke.md` 里详情相关项按两形态拆：专辑点开＝弹窗（取色渐变可见/底栏关闭可见/遮罩点能关/ESC 能关/切轴不残留/关库不残留/随机钮不出现）；歌单点开＝弹窗带随机；艺人点开＝全屏 hero + 返回钮 + 滚动恢复。台账 `.superpowers/sdd/.../progress.md` 追加「追加批D」块（证据、改动文件、探针数字、测试计数、未 commit 清单）。

- [ ] **Step 7: 汇报并等「提交」**

按主人格式：已完成记录 / 剩余待办（真机冒烟、批C+批D 未提交、引擎侧 `getPlaylists` 恒空 ⇒ 歌单轴弹窗只能空态验证）分开列，每条带 有来源/AI推理 标签。
