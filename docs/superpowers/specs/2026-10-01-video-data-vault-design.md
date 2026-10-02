# 影视数据 vault 化设计（镜像 + 空桶恢复）

日期：2026-10-01
状态：已获主人批准（方案 A）
范围：影视模块用户数据持久化，新增 userData 文件镜像层，永久免疫端口/origin 跳变。

## 1. 背景与根因（当日取证）

- 影视用户数据（心动/片库/追片/历史/进度/元信息）全部存渲染进程 localStorage，按 origin（协议+主机+端口）隔离。
- 桌面壳 `findOpenPort(3000)` 在 3000 被占时退避到 3001（本次为一条残留的 `node server.js` PID 4360 占用）。origin 变为 `http://127.0.0.1:3001` 后 localStorage 换桶，首页显示 0 分钟/等待记录。
- 取证：真实数据完好存于 sessionData 重定向目录
  `D:\StellaflixCache\chromium\Stellaflix\Local Storage\leveldb`，
  挂在 `http://127.0.0.1:3000` 下（`stellaflix-watch-history-v2`、`stellaflix-video-library` 等键均有值）。
- 海报未丢：`poster-cache.json` / `video-poster.json` 存 userData 文件、按视频 key 索引，与 origin 无关。`poster-cache.js` 头注释本已声明此设计动机——本次把同一机制推广到全部影视用户数据。

## 2. 目标与非目标

目标
- 任意 origin 变化（端口跳变、host 差异）后，重启应用数据自动回填，用户无感知。
- 正常运行零改动：所有同步 localStorage 读写路径保持不变。
- 非桌面壳（浏览器直开）自动降级为 no-op，行为与现状完全一致。

非目标
- 不做全量异步化重构（方案 B 已否）。
- 不改端口退避策略、不锁 3000（方案 C 已否）。
- 不迁音乐态/登录分区数据；只覆盖影视模块键（清单见 §3）。
- 不处理多窗口并发写 vault 的仲裁（当前应用单主窗口，出现需求再议）。

## 3. vault 键清单

| 键 | 来源模块 |
|---|---|
| `stellaflix-video-progress` | model.js |
| `stellaflix-video-library` | model.js |
| `stellaflix-video-history` | model.js |
| `stellaflix-video-flag` | model.js |
| `stellaflix-video-meta` | model.js |
| `stellaflix-video-track` | model.js |
| `stellaflix-video-failure-log` | model.js |
| `stellaflix-watch-history-v2` | watch-history.js |
| `stellaflix:library:lastPoster` | poster-wall/hex-wall.js |

不纳入：`stellaflix-video-schema-version`（迁移标记，origin 本地语义）、`stellaflix-video-poster-cache`（已有文件层）、`stellaflix-video-poster`（已文件化）。

## 4. 架构

### 4.1 主进程（desktop/main.js）

新 IPC handler `stellaflix-video-vault`，仿 `stellaflix-poster-cache`（main.js:5303 模式）：

- `get` → 读 `path.join(app.getPath('userData'), 'video-vault.json')`，返回 `{ ok, data }`；文件不存在/损坏返回 `{ ok:true, data:null }`。
- `set` → payload 为整包快照 `{ [lsKey]: string|null }`；原子写：先写 `video-vault.json.tmp` 再 `rename` 覆盖；值为 `null` 的键不落盘。
- 错误一律 `{ ok:false, error }` 返回，不 throw。

### 4.2 preload（desktop/preload.js）

紧邻 `posterCache`（L151-152）新增：

```js
videoVault: (action, payload) => ipcRenderer.invoke('stellaflix-video-vault', action, payload || null),
```

### 4.3 渲染层新模块 `public/video/data-vault.js`

挂载 `SFV.vault`；在 index.html `SFV_SCRIPTS` 中插于 `video/poster-cache.js` 之后、`video/model.js` 之前。

状态机与 API：

- 脚本加载即调用 `init()`：
  1. 桥不可用（无 `desktopWindow.videoVault`）→ `ready` 立即 resolve，后续全 no-op。
  2. `videoVault('get')` → 对 §3 每个键：**仅当 `localStorage.getItem(key) === null` 且 vault 有该键字符串值**时 `setItem` 回填（=新 origin 场景）。两桶都有值 → 本地为准，不覆盖。
  3. 若发生了任何回填，广播 `window.dispatchEvent(new Event('sfv:vault-restored'))`。
  4. init 结束时（无论是否发生回填）无条件 flush 一次全量镜像——同时覆盖"首次建档"（本地有数据、vault 为空）与"换桶收敛"两种场景。
  5. `ready = Promise`，整体 1500ms 超时兜底（超时不 reject，resolve）。
- `mirror()`：数据变更后防抖 1000ms 触发 `flush()`；`flush()` 采集 §3 各键当前值（含 `null`）整包 `videoVault('set')`。`pagehide` 事件强制 flush 未决镜像。
- `mirror/flush` 失败静默（console.warn），绝不影响业务流程。

一致性规则（关键决策）
- 恢复条件用"本地键完全不存在"而非"内容为空数组"，因此**用户主动清空会先被 mirror 写入 vault，不会被旧数据复活**；唯一复活窗口是"清空后、1s 防抖内崩溃"，接受该窗口（有 1500ms ready 与重启再镜像自愈）。
- vault 与 localStorage 双写，vault 永远是"最近一次已知状态"的镜像；真源仍是 localStorage。

### 4.4 挂钩点（每处一行）

| 文件 | 位置 | 动作 |
|---|---|---|
| public/video/model.js | 写原语 `set()`（L71 所在函数）末尾 | `SFV.vault && SFV.vault.mirror()` |
| public/video/watch-history.js | `save()`（L162）末尾 | 同上 |
| public/video/poster-wall/hex-wall.js | `publishFocusedPoster()` 末尾 | 同上 |
| public/video/home.js | `boot()` 的 `loadPosterStore().then` 链 | 并行等待 `SFV.vault.ready`（Promise.all + 自身超时兜底），resolve 后再 install；失败不阻塞 |
| public/video/home-cards.js | 模块安装处 | 监听 `sfv:vault-restored` → 重绘一次卡片 |

### 4.5 构建

- index.html `SFV_SCRIPTS` 增条目（见 4.3）。
- 改完必须 `npm run bundle`（B1 模块打包规则）。

## 5. 错误处理

- IPC 任一环节失败：init 视为"无 vault"，正常走现状逻辑；mirror 静默重试至下次变更。
- vault 文件损坏（JSON parse 失败）：`get` 返回 null，等同无 vault；下次 flush 整体覆盖自愈。
- 回填后 localStorage 写失败（配额）：与现状同——现有 try/catch 吞掉，不新增路径。终审加固（338731e）：init 末尾 flush 前，若磁盘 vault 非空而本地快照为空则跳过该次 flush，防止配额失败放大为抹空归档。

## 6. 测试

新增 `tests/video-vault.test.js`（仿 watch-history-v2.test.js 的 stub 法：内存 localStorage + 假 desktopWindow 桥，vm 加载 data-vault.js）：

1. 空桶回填：本地无键、vault 有值 → init 后 localStorage 出现全部值，并派发 `sfv:vault-restored`。
2. 本地为准：两桶同键不同值 → init 后本地值不变，vault 被 mirror 覆盖为本地值。
3. 清空不复活：本地键存在且为 `[]` → 不回填。
4. 防抖镜像：连续 mirror 仅产生一次 set；pagehide 强制 flush。
5. 无桥降级：无 `desktopWindow` → ready 立即 resolve，零 IPC 调用。
6. vault 文件损坏 → get 返回 null 不抛错（主进程 handler 以单元级读测或逻辑走查覆盖）。

回归：`npm test` 基线 148/149（唯一已知败=watch-history D1 存量）。

## 7. 真机验收（主人执行）

1. 杀残留 `node server.js`（PID 4360）→ 重开应用 → 应回到 3000 且数据在，`userData/video-vault.json` 生成。
2. 故意占用 3000（如再起一条 server）→ 重启应用落在 3001 → 首页数据应在 1.5s 内自动回填完整。
3. （单向收养，终审修订 2026-10-01）在 3001 桶新增一条追片 → 重启落回 3000：3000 桶本地键存在 → 本地为准，3001 期间的新追片**不**回潮，属预期行为（见 §8）。真正的收养验收以第 2 步为准：空桶 1.5s 内回填完整。
4. 清空历史 → 重启 → 保持为空（不复活）。
5. 浏览器直开 `localhost:3000`：无 vault 桥，功能与现状一致。

## 8. 风险与代价

- 换桶首帧最多晚一次本地文件 IPC 读（毫秒级），有 1500ms 超时兜底不阻塞启动。
- userData 磁盘增量 = 键快照体积（`lastPoster` 可能含 dataURL，MB 级上限，与 localStorage 现值同量）。
- 单主窗口假设；若未来开多窗口并发写，需要 vault 写仲裁（本期不做）。
- A→B→A 端口往返：B 桶期间的新改动会在回到 A 时被"本地为准"的 flush 覆盖（vault 快照收敛为 A 现状）。裁决（2026-10-01 主人批准）：本期仅保证**单向收养**——数据落到新桶时不丢；不做逐键时效合并。若日后确需追回往返期间的改动，另立项。
