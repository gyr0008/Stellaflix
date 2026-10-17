# 顶部导航三页行为独立化 — 设计规格

- 日期：2026-10-06
- 状态：待主人审阅
- 目标：世界 / 首页 / 汇联三个顶部导航 tab 成为**行为独立**的页面——对等 mount/unmount 生命周期、状态零串扰。容器（`#sfv-browse` bodyEl）继续共享，不引入 URL/历史路由。

## 0. 背景与问题（审查结论摘要）

现状三页机制不对等（均经 2026-10-06 只读审查核实）：

1. 首页从未注册 router 页：`page-home.js` 是 no-op 占位，注释自证「已弃用」；`handleNavAction('home')` 走 `goHome()` = **关闭** `#sfv-browse` 覆盖层 + `SFV.home.render()` 改写底层音乐首页（online-nav.js L293–306）。
2. 影视首页寄生音乐态 DOM：`home.js` 双态同构改写 `#empty-home` 的 5 卡与海报轨，切回需 `restoreMusic()` 基线还原（T118 铁律）。
3. 跨页串扰靠补丁维持：`resetHomeVisibilityState()`（L423–433）、`setHost` 自愈（L28–31）、close 必走 `router.leave()`（L375–379）等。
4. 世界页直改公共 DOM：`applyHostChrome` 改宿主 inline 样式（page-world.js L334–347）、`sfv-world-page` body 类藏首页星空（L293–303）、`liftTitlebar` reparent 标题栏（L313–332）。
5. 应用无内部历史路由（online.js L233–251 pushState 钉死地址）——本次**维持该裁决不变**。

## 1. 裁决记录（主人已批）

| # | 裁决 | 内容 |
|---|---|---|
| R1 | 目标层 = A 行为独立 | 对等生命周期、零串扰；容器可共享；不做 URL 可寻址 |
| R2 | 首页 DOM = B | 影视首页自有 DOM，`#empty-home` 彻底归还音乐态 |
| R3 | 内容 = 1:1 迁移 | 海报区/5卡/海报轨/继续看/FOR YOU/URL输入条 原样迁移，只换宿主不改功能 |
| R4 | chrome = 三页同一套 | 首页标题「首页」、保留本地/地址/片源、X 维持 T158 退窗；← 返回钮隐藏 |
| R5 | 实施路线 = 方案一 | 薄壳收编 + home.js 宿主化改造；不做整体重写（方案二否决）、不做两步走（方案三否决） |
| R6 | 行为差认可 | 点首页 tab 连带关闭搜索页；spacechange→video 自动开首页页；← 在世界/汇联语义由关层改为回首页 |
| R7 | 启动体验不变 | 第一页仍是开屏 splash（非两态选择页）；启动空间仍由「启动默认空间」偏好决定；两态启动时序不改 |

## 2. 总体架构与页面契约

### 2.1 统一入口

- 三 tab 同链路：`handleNavAction(key) → goToNav(key) → router.go(key)`，首页不再有"关层"特判。
- `page-home.js` 重写为真 router 页，注册 id `'home'`。
- `goHome()` **签名保留、内部改为** `goToNav('home')`。7 个既有消费方零改动：bootstrap 轮询、`04-home-empty-wallpaper.js` 音乐态委托（L339–340）、index.html `home-btn`、快捷键 Home 键（01-viewport-resize-shortcuts.js L33）、online.js 导出（L85/L220）、online-nav 内部播放器返回。

### 2.2 chrome 声明化（串扰病根收编）

页面注册时声明宿主需求，由 router 统一应用/回收；页面代码**禁止**再直接改 body 类、宿主 inline 样式、标题栏归属：

```
router.register({ id:'world', title:'世界',
  chrome: { fill:true, bodyClass:'sfv-world-page',
            titlebarToBody:true, hostStyle:{ background:'#05060a', padding:'0' } },
  mount, unmount })
```

- `go()` 进入页面前应用新页 chrome；`leave()`/切页时按**应用栈逆序**严格回收（见 §5.2）。
- page-world 的 `applyHostChrome` / `setWorldPageClass` / `liftTitlebar` 三段私有机制删除，行为改由声明驱动；player.css `sfv-world-page` 三条规则**本体保留**。
- ← 返回钮显隐由 `chrome.back` 声明驱动（缺省 = 显示）：仅 `home` 声明 `back:false`（首页无上游）；world/discover 保留 ←，动作为 `goToNav('home')`（§4.3）。

## 3. 首页页（page-home）设计

- `page-home.mount(host)` 搭建 `#sfv-home` 骨架（大海报区、5 卡网格、海报轨、继续看、FOR YOU、URL 输入条），调用 `SFV.home.renderInto(host)` 填内容；`unmount` 作废在途请求（seq token，同世界页模式）。
- 内容大脑迁移：`home-cards.js` 的 `cardDefs / latestProgress / setCardArt` 复用；`setCardText` 目标改新 DOM 节点。
- 删除的寄生手脚：`#empty-home` 改写、`home-quick-grid` 类补丁（L163–166）、`bindGridCapture/bindRailCapture` 内联 onclick 捕获拦截、`#sfv-urlbar` 寄生、hero 改写（L237）。
- 第 5 卡「音乐空间」：入口行为不变（切音乐态）；封面**单向只读**订阅跨态海报快照（§6.2）。
- 样式独立文件（拟名 `video/_video-home.css`，实施时对齐仓库 CSS 惯例）。
- 首页页进入动画：启动首屏与 spacechange 自动进入 = instant 无动画铺满（`goToNav` 增加 instant 通道）；tab 手动点击 = 与其它两页相同的正常切换。

## 4. 启动链、空间切换与返回栈

### 4.1 启动链（消费方零改动）

- `bootstrap.js` 继续轮询 `SFV.online.goHome`、成功后派发 `sfv:home-boot-ready`；`03-splash.js` 黑屏 gate（事件 + 800ms 兜底）语义不变。
- bootstrap 兜底分支 (C) `tryEnsureHomeRenderOnly`（L63–75）**删除**：首页内容只能经 router mount 进宿主，脱离宿主渲染不成立。

### 4.2 空间切换

- `spacechange` → 非影视态：盖层 `close()`（不变），连带 leave 卸载首页页，音乐首页以原貌露出（从未被改写）。
- `spacechange` → 影视态且盖层未开：自动 `goHome()`（新增一支，落 online-nav L116–150 现有监听内）。
- `state.js` 状态机、`video-space-active` 类：原样保留。

### 4.3 播放器返回与返回栈统一

- `returnFromPlayer()` 无返回目标支：`restoreHomeAfterPlayer()` 改为直接 `goHome()`；有返回目标两支（历史页/详情页）不动。
- D5 `_returnPageId` 机制：`'home'` 成为合法发起页——「首页卡→详情→←」走 `goToNav('home')`。
- `goBack()` 三处 close 特判统一（fullscreen L500–509、page 模式 D1 L511–518、栈底 D9 L520–533 非 search/collections 落点）→ 一律回首页页。
- 世界/汇联的 ← 语义：关层 → 回首页；顶栏 X 维持 T158 退窗。
- 独立搜索页：`goToNav` 既有 `closeSearchPage()` 使点首页 tab 连带收搜索页（R6 已批）。

## 5. 错误处理契约

1. `router.go()` mount 包 try/catch：失败渲染错误占位（对齐世界页 `showError` 形态）、回收该页 chrome、`currentPageId` 不半挂。
2. unmount 异常吞而告警（现状），但 chrome 回收放 finally；回收按应用栈逆序，杜绝半还原态。
3. 首页异步内容失败：骨架先行 + 空态文案兜底，不整页白；seq 代次 token 作废在途闭包，防旧请求回写新页。

## 6. 音乐态还原与补丁退役

### 6.1 整条退役（寄生机制）

1. `home-snapshot.js` 整体退役（基线快照+回滚，T118 前提消失）：摘 index.html 脚本清单，文件归档 `video/_archive/`。
2. `restoreMusic()` 链（home.js L1114–1227）与 dispatch 槽位 `registerSlot(SLOT, {music:restoreMusic, video:render})` 删除。
3. home.js 对 `#empty-home` 的全部改写（§3 所列）。
4. `resetHomeVisibilityState()`（online-nav L423–433）+ home.js「进入即隔离」块（L146–159）：`homeSuppressed / homeForcedOpen / emptyHomeActive` 三全局从此**只属于音乐态**，影视态代码零读写。
5. spacechange 中直改 `home-video-title/home-video-sub` 的第 5 卡文案同步（L140–145）删除。

### 6.2 保留但降级/改造

1. `renderHomeDiscover()` 影视态早退守卫（13 调用点 + 03a L2468–2470 包装）保留——性质降级为"不渲染不可见 DOM"的性能守卫。
2. 跨态海报：`_preCapturePosterSnapshot + getMusicLeftPoster` 改单向只读（音乐写、影视读），删影视→音乐方向。
3. `home-cards.js` 内容大脑迁入 `renderInto`。
4. `state.js` / `video-space-active` / player.css `sfv-world-page` 三规则保留（§2.2）。
5. player.css 中 `#empty-home` 影视改写类规则（`home-quick-grid` 等）摘除。

## 7. 测试与验收

### 7.1 现有测试

断言需更新（事件名不改）：`world-page-independent`（挂摘机制→声明驱动，player.css 规则断言保留）、`sfv-boot-home-ready-event`、`splash-fast-skip-video-boot`、`continue-watching-return-home`、`online-nav-router-host-reinject`、`startup-navigation-readiness`、`home-blank-dismiss-browse-guard`、`home-boot-shell-video-cards`，及所有 grep 命中 `#empty-home` 影视改写断言的用例（逐文件审计，不盲改）。

### 7.2 新增测试（TDD 先红后绿）

1. 三页注册对等：`router.currentId()` 恒与顶栏高亮 tab 一致。
2. `router.go('home')` 全程零 `#empty-home` 写入（jsdom MutationObserver 记账）。
3. `goHome()` 适配器行为（7 消费方签名不变）。
4. spacechange→video 自动开首页页；→music 关层且 leave。
5. chrome 应用-回收矩阵（三页 × 宿主/body/标题栏），含 mount 抛错支。
6. **T118 替代断言**：音乐↔影视来回切后 `#empty-home` 全节点与基线逐字节相等（"没碰过"取代"还原对"）。

### 7.3 回归与验证工装红线

- 全量 `npm test` 必须全绿；基线数字以当次运行为准（记忆在案 183/183 与 176/176 两说，spec 不落死数）。
- 起服一律 `PORT=3999`，同命令内起→测→杀（:3000 残留=换桶数据丢失根因）。
- 视觉验证走离屏 Electron 截图工装；不用 Computer Use。
- index.html 脚本清单增删必须同步 `npm run bundle`（B1 产物），并核对 build:win files 白名单防漏新文件。

### 7.4 完成定义（DoD）

1. 三 tab 同链路 `handleNavAction→goToNav→router.go`，无首页特判。
2. 影视态代码对 `#empty-home` 与三粘性全局零写入（grep + 运行时双证）。
3. 页面代码不直接改 body/宿主/标题栏，仅经 chrome 声明。
4. `npm test` 全绿。
5. 主人真机冒烟六项：① 启动首屏（影视态/音乐态各一次）与今日观感一致；② 三 tab 三角互切；③ 切音乐态后首页原貌；④ 播放器退出回首页；⑤ 搜索/详情返回栈；⑥ 世界页星空隐藏与恢复。

## 8. 明确不做

- 不做 URL/hash 历史路由（维持 D8 钉死裁决）。
- 不做"开屏后影视/音乐选择页"（如需要另立任务）。
- 不重设计首页布局（R3；布局重设计另立任务）。
- 不动 `state.js` 双态状态机与 `video-space-active` 判定。
