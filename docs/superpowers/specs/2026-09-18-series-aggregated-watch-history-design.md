# 观看历史改为番剧聚合模型（方案 A）设计文档

日期：2026-09-18
状态：已与用户逐节确认
范围：仅"番剧聚合模型"。不含 WebDAV 同步、不改写入节流频率、不采用"看完进度归零"、不补"清空全部/未看完筛选"UI（单独立项）。

## 1. 背景与目标

现状：`public/video/watch-history.js` 以"一次播放一条流水"记录历史（key = `源:vodId:集数`，同日同键去重，跨天堆新条目）。
目标：对齐 Kazumi 的聚合语义 —— 一部番剧在历史页只有一条记录，记录指向最近观看的那一集，点击卡片直接续播该集。

关键既有事实（决定设计边界）：

- 各集播放进度已有独立存储：`stellaflix-video-progress`（`model.js:11、137-147`，集级 key → `{position,duration,updatedAt}`）。聚合记录不重复存各集进度，避免双真相。
- 下游按**集级 key** 消费历史记录：`home-continue-watching.js:98-103`（遍历 `watchHistory.getAll()` 匹配 `rec.key === 集级key`）、`detail-source.js:701-713`（`SFV.model.getProgress(rec.key)` + `watchHistory.update(rec.key, …)`）。故聚合记录必须保留"最近一集的集级 key"于 `key` 字段。
- sourceId 可能含 `:`（kazumi 源，`detail-source.js:717`）。聚合键拆分只能用 `lastIndexOf(':')` 剥尾段，禁止 `split(':')`。
- `player.js` 的进度回写走 `watchHistory.update(currentId, patch)`（`player.js:862-883`），currentId 是集级 key；`play-orchestrator.js:91-107` 的 `add()` 同理。因此聚合逻辑全部收敛在 watch-history.js 存储层内部，调用方零改动。

## 2. 数据模型

新 localStorage 键：`stellaflix-watch-history-v2`，值为聚合记录数组。

```js
{
  seriesKey: '<sourceId>:<vodId>',      // 主键：聚合/去重/删除用
  key:       '<seriesKey>:<episodeIndex>', // 最近观看集的集级 key（进度键、续播、兼容旧查询）
  episodeIndex: 3,                      // 第 N 话（0 基，与播放器 ep.index 一致）
  episodeName: '第4话 …',                // 集名（可空）
  title, sub, img, pic,                 // 沿用 v1
  progress, cur, total, finished,       // 均指"最近那一集"
  ts,                                   // 最近观看时间（分组/排序按它）
  sourceId, vodId,
  lastSourceId, lastVodId, lastSourceName,
  lastPlayFromIndex, lastPlayEpisodeIndex,  // 沿用 v1，供 smartResumePlay
  watchedDay: 'YYYY-MM-DD',             // 今日观看秒数记账日
  daySec: 0                             // 当日累计观看秒数（getTodayInsight 用，见 §4）
}
```

- `normalize()` 输出即上述 schema；缺字段补默认，容忍旧数据。
- 各集细进度仍以 `stellaflix-video-progress` 为唯一真相。
- 上限 `CAP = 500` 语义改为 500 **部**。

## 3. 写入端行为（watch-history.js 内部）

### add(rec)（入参集级 key）
1. `seriesKey = rec.key.slice(0, rec.key.lastIndexOf(':'))`；无 `:` 的 key（异常入参）拒绝写入。
2. 按 `seriesKey` 查找现有记录：
   - 命中且 `rec.key !== existing.key`（换集）：原位覆盖 `key/episodeIndex/episodeName/sub/img/pic/title/sourceId/vodId/ts`，进度字段重置（`progress:0, cur:'00:00', total:'', finished:false`），`daySec` 记账基线按 §4 处理；移动到数组头部。
   - 命中且同集：仅刷新 `ts` 与元信息（title/img 等），不重置进度（重开同一集续看场景）。
   - 未命中：新建记录 unshift（进度按入参，通常 0）。
3. 超出 CAP 从尾部截断。

### update(key, patch)（入参集级 key，调用方 player.js / detail-source.js 不改）
1. 折成 `seriesKey` 定位记录；找不到返回 null。
2. **stale 防串写**：若 `rec.key !== 传入 key`，跳过（该记录已被更新的一集接管，或播放器还在给旧集回写），返回记录本身不作修改。
3. 其余 patch 语义沿用现状（progress/cur/total/finished/ts/lastSourceId…），`daySec` 按 §4 增量记账；不再使用旧的"watchedSec 取 max"。

### remove / 删除语义
- UI"移除"= 删除整部番聚合记录，并调用 `model.clearProgressByPrefix(seriesKey + ':')` 清掉该剧所有集的进度条目。
- `model.js` 新增约 5 行：遍历 `stellaflix-video-progress` 键对象，删除以该前缀开头的项并落盘。
- 保留 `remove(key, ts)` 旧签名兼容：第二个参数忽略（聚合后无同日多条目）。

## 4. 今日观看秒数（getTodayInsight 适配）

问题：v1 靠"每天一条新记录 + watchedSec 取 max"自然分隔日期；聚合后一部番一条记录，需显式按日记账。

规则（在 update() 内实现）：
- `todayKey = 'YYYY-MM-DD'`（本地时区）。若 `rec.watchedDay !== todayKey`：`rec.daySec = 0; rec.watchedDay = todayKey; rec.epSec = 0`（epSec 为本集已计秒基线，属内部字段，normalize 容忍缺失）。
- 集切换（add() 换集）时 `rec.epSec = 0`。
- 每次回写：`delta = max(0, incomingWatchedSec - (rec.epSec || 0)); rec.epSec = incomingWatchedSec; rec.daySec += delta`。
  （incoming 是播放器当前会话累计观看秒，单调递增；跨会话/跨集/跨天均被上述基线正确切分。）

`getTodayInsight()` 改读 `daySec`（旧字段兜底：`daySec` 缺失时退回 `watchedSec` 现逻辑），streak/分组口径不变。

## 5. 读取端 / UI / 迁移

- 历史页渲染、`groupByDay`、rail、卡片结构全部照旧；仅卡片状态行文案改为「第 N 话 · 看到 HH:MM:SS」（`episodeIndex != null` 时），`sub` 显示集名。
- 迁移（幂等，仅 v2 键为空时触发，readAll() 入口执行）：
  1. v1 有数据 → 按 `seriesKey` 分组，每组取 `ts` 最大的一条升级成 v2 记录（补齐 `episodeIndex`：从 v1 key 尾段解析；`daySec` 初始化：记录属于今天则取 `watchedSec`，否则 0），按 `ts` 降序写入 v2。
  2. v1 也为空 → 沿用现有 `migrateFromModelIfEmpty()`（model 粗粒度键），产出先落成 v1 格式再走同一聚合，或直接聚合成 v2（实现取后者，少一跳）。
  3. v1 与 model 旧键**都不删除**，保留回滚能力；写路径从此只写 v2。
- 首页「接着看」：`resumeFromHistory` 按集级 key 命中 v2 的 `key` 字段即直用；未命中走现有 `model.getHistory()` 兜底，行为不劣化。
- 本次不动：`stellaflix-video-history`（model 粗粒度，play-orchestrator 双写保留）、`stellaflix-video-search-history`、音乐收听统计。

## 6. 错误处理

- 全部存储操作维持现有 try/catch 静默降级风格（localStorage 满/JSON 损坏时读回 []，不抛出阻塞播放）。
- 迁移异常不阻断读取（与 v1 迁移一致的 catch 包裹）。
- `key` 无 `:`、非法入参：`add/update` 直接 return，不产生脏记录。

## 7. 测试

新增 `tests/watch-history-v2.test.js`（沿用现有 `node --test` + localStorage 假件 + vm/sandbox 加载浏览器文件的模式，参考 `tests/local-playlist-store-crud.test.js`）。用例：

1. v1→v2 迁移：同片多条跨天流水合并为一条，取最大 ts；v1 键保留。
2. add 聚合：同片换集只产生一条记录且进度字段重置；同片同集重开不重置进度。
3. update stale 防串写：记录被新集接管后，旧集 key 的回写被忽略。
4. 删除：remove 后聚合记录消失，且 model 进度前缀条目被清除（假件验证 clearProgressByPrefix）。
5. daySec：跨集累计、跨天清零、同集多次回写不重复计数。
6. 键拆分：`kazumi:abc:123:4` → seriesKey `kazumi:abc:123`。
7. 回归：groupByDay 排序、getTodayInsight 出数、CAP=500 按部截断。

手动验证：起播→历史页出现单卡片显示"第 N 话"；换集后仍单卡；点卡片直起播续到正确集与进度；移除后详情页无幽灵进度。

## 8. 改动文件清单

| 文件 | 改动 |
|---|---|
| `public/video/watch-history.js` | 主体：v2 键、normalize、add/update/remove 聚合逻辑、迁移、daySec 记账、卡片文案 |
| `public/video/model.js` | 新增 `clearProgressByPrefix(prefix)` |
| `tests/watch-history-v2.test.js` | 新增 |

`player.js`、`play-orchestrator.js`、`detail-source.js`、`home-continue-watching.js` 零改动（契约兼容）。
