# B1 实施记录 — 前端模块连续段 bundle（109 次串行 XHR → 16 次请求）

> 来源：手机端 `00-实施指南.md`（基线 `7a22d84`，2026-09-29 Linux 云机验证）。
> 本仓库落地基线：`9f54265`（2026-09-30），审查后按三处修订实现，指南原文中不适用的地方已在本文纠正。

## 0. 改动总览

| # | 文件 | 类型 | 作用 |
|---|---|---|---|
| 1 | `scripts/bundle-modules.js` | 新文件 | 构建脚本：从 index-loader 的 modulePaths 提取顺序，按「连续段」原样拼接 bundle；带 `--check` 只读校验 |
| 2 | `package.json` | 改 4 行 | `npm run bundle` / `npm run bundle:check`；`build:win`、`build:win:dir` 前置 `--check` 门禁 |
| 3 | `public/js/index-loader.js` | 双模式 | 默认读 bundle manifest，缺失/损坏/过期自动回退逐文件；`?dev=1` 强制逐文件 |
| 4 | `public/js/bundles/` | 生成产物（**本批暂不入库**，见 §3.1） | 15 段 + manifest，`npm run bundle` 生成 |
| 5 | `public/index.html` | 换 1 块 | Google Fonts 渲染阻塞 → `media="print"` 异步 + preconnect |
| 6 | `tests/bundle-modules.test.js` | 新文件（9 用例） | 顺序守恒 / 孤儿降噪 / 失败不落地 / `--check` 过期检测 / loader 守卫契约 |

## 1. 相对手机端指南的三处修订（审查结论）

### 修订 1 · 构建原子性（原脚本会先落地产物再判失败）

原 `bundle-modules.js` 把语法校验失败只记成 `allOk=false`，仍然写 manifest、仍然打印「校验通过」，最后才 `exit(1)`；而旧 `.bundle.js` 在校验前就被删除。后果：仓库停在「新产物已就位」的中间态。

这不是「慢一点」的问题：loader 的自动回退只覆盖**读取失败**（404 / JSON 损坏），**不覆盖 bundle 内容报错**。半写入的坏 bundle 会被直接注入外层 `try`，抛出后**整条模块链中止**，只剩 2.5s splash 兜底 —— 与指南承诺的「绝不半途硬崩」相反。

现实现：先在 `os.tmpdir()` 的 staging 目录渲染 + 逐段 `node --check` + 字节级比对，**全部通过才动 `public/js/bundles/`**；任一失败直接抛出，旧 bundle 与 manifest 分毫不动。`tests/bundle-modules.test.js` 第 ③ 用例用假 public 树注入语法错误断言这一点。

### 修订 2 · 缓存：URL 版本化已做，但收益被服务端 no-store 挡住（已定性，未动服务端）

指南 §1 把「浏览器缓存有了意义」列为 B1 核心价值之一，实测不成立，两层原因：

1. `readModule` 无条件追加 `?v=Date.now()`，bundle 也走它 → 每次冷启动 16 个 URL 全新，缓存必然落空。（**已修**：bundle 段改用 `manifest.builtAt` 作版本，重建产物才换 URL；manifest 本身仍每次取最新，所以不会读到旧段。）
2. 更硬的天花板：`server.js:919` 的 `serveStatic()` 对**所有**静态文件下发 `Cache-Control: no-store, no-cache, must-revalidate`（实测 `curl -I http://127.0.0.1:3000/js/bundles/00-state.bundle.js` 可见）。URL 稳定了也存不住。

本批**没有**改服务端缓存策略（全局头，影响面超出本批）。若要兑现缓存收益，需要的是窄口径例外 —— 只对 `js/bundles/*.bundle.js` 下发 `public, max-age=31536000, immutable`（builtAt 版本化让它可以安全长存），等圈定后再做。

因此 B1 的实际价值收敛为三条：① 消灭「手工数组 ↔ 磁盘文件」一致性炸弹；② 每请求的 NTFS + 杀软开销 ×109 → ×16；③ 请求数 164~168 → 68~73（网络段 0.45~2.8s）。**启动慢的主力仍是 ~5.5s JS 主线程长任务，B1 不解决它。**

### 修订 3 · 孤儿警告降噪（否则在本仓库刷屏 100+ 行）

原脚本 `walk()` 把 `public/js/modules/` 下所有 `.js` 与 modulePaths 对比。本仓库 `.gitignore:67` 有 `*_1.*`，磁盘上实打实存在 100+ 个 `*_1.js` 历史副本（与 `build.files` 的 `!**/*_1.js` 规约同源），全部会被列成孤儿，真正的死文件 `00-login-easter-egg.js` 反而被淹。现 `collectOrphans()` 跳过 `_1.js`，输出回到指南预期的一条。

## 2. 新增：新鲜度守卫（一致性炸弹的另一半）

bundle 是 2.9MB 源文件的副本，「改了模块忘跑 `npm run bundle`」= 用户静默跑旧代码，比原方案更隐蔽。两层堵：

- **运行时**：loader 把 manifest 的 `groups[].modules` 展平，与自身 `modulePaths` 逐位比对；不一致（过期 / 手工改过数组）→ `console.warn` 并回退逐文件。功能永远跟最新源码走，只是失去加速。
- **构建时**：`npm run bundle:check` 只读校验产物与源码逐字节一致，已挂进 `build:win` / `build:win:dir` 前置 —— 打包是过期 bundle 真正伤害用户的地方。

## 3. 落地记录（2026-09-30，本机 Windows）

- `npm run bundle` → 15 段 / 112 模块，孤儿警告 1 条（`00-login-easter-egg.js`，已知死文件，不处理）
- `npm run bundle:check` → 通过，`builtAt=2026-09-30T13:15:54.718Z`
- `node --check public/js/index-loader.js && node --check scripts/bundle-modules.js` → 通过
- `tests/bundle-modules.test.js` → 9/9
- `npm test`（tests/run-all.js，按文件计数）→ **通过 140 / 总 141**，唯一失败 `continue-watching-return-home.test.js` D1 = 存量（watch-history 未提交 WIP），与本批零交集
- 真机（:3000 桌面 app + browser-use）：
  - `/` → `__stellaflixBundleMode=true`，`js/bundles/` 请求 16，`js/modules/` 请求 **0**，无 `[Startup FATAL]`
  - `/?dev=1` → `__stellaflixBundleMode=false`，`js/modules/` 请求 109（另 3 个在 modules/ 之外），无 fatal
  - 两模式全局探针一致：`goHome`/`openCustomSourceModal`/`finishSplashReveal` = function，`fx`/`shelfManager` = object，`posterStore` 两模式同为 undefined（存量，非本批引入）
  - 守卫实验：临时把 manifest 里一个模块名改坏 → 刷新后 `bundleMode=false`、回退逐文件、`goHome` 仍为 function；随后恢复并复验 `bundle:check` 通过

## 3.1 产物暂不入库（本批决定）

`npm run bundle` 读的是**工作树**，而工作树里有并行会话未提交的模块改动（`00-state/00-core-stores.js`、`05-playback/04-home-empty-wallpaper.js`、`10-shell/03-splash.js`）。现在提交 `public/js/bundles/` 等于把别人未落库的代码内嵌进产物，历史里这段 commit 会出现「bundle ≠ 同 commit 的源码」。

因此本批只提交 脚本 / loader / package.json / 测试 / 文档 / index.html 字体块，产物留工作树本地。代价=**加速不随本批生效**：运行时 loader 读不到 manifest 就回退逐文件（112 次 XHR），功能零变化。

后续圈定方式：等那 3 个模块落库后，在干净状态跑 `npm run bundle` 再单独提交 `public/js/bundles/`。`build:win` 的 `--check` 前置会强制这条顺序（无产物 → 打包直接失败，提示先跑 `npm run bundle`）。

## 4. 维护规约

- 改模块内容 / 增删模块 → 只改 `public/js/modules/` 与 index-loader 的 `modulePaths`，然后**必跑 `npm run bundle`**；忘了跑不会坏功能（运行时守卫回退），但会白改性能，且 `build:win` 会被 `--check` 拦下。
- 开发调试可用 `?dev=1` 绕过 bundle。
- `public/js/bundles/` 冲突时的仲裁规则：**源文件永远赢** —— 删掉该目录重跑 `npm run bundle` 即重建。
- 线上疑似 bundle 引起的怪病：先 `?dev=1` 复现对比，快速判定是否 bundle 链路。

## 5. 指南数据的解读（勿照抄）

指南自述 `npm test 104/104`。本机 `npm test` 是 `tests/run-all.js` 全量串行，基线量级在千级（HEAD `9f54265` 记录为 1040/1042），两套数不同源 —— 验收锚用「与本机现场基线持平」，不用文档数字。本批另加 `tests/bundle-modules.test.js`（+9 用例）。

手机端来件目录（`D:\xwechat_files\...\msg\file\**`）对本机只读，写回原指南会得到 `EPERM` —— 本文即纠错的唯一落点，指南原件保持原样。

## 6. 未做 / 待定

- 服务端对 `js/bundles/*.bundle.js` 的缓存头例外（见修订 2），需单独圈定。
- Google Fonts 自托管：桌面分发场景离线时永远拿不到外网字体，异步化只是止血。
- `00-login-easter-egg.js` 死文件仍在磁盘（不进 bundle，dev 模式同样不加载）。
