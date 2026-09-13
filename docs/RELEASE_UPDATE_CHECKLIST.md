# Stellaflix 应用内热更新 — 发布检查清单

目标：已安装客户端（打包版）能通过 **应用内 electron-updater** 下载并静默安装新版本；网盘 / Release 外链仅作降级。

---

## 0. 发布前必读

| 项 | 值 |
|---|---|
| 更新仓库 | `github.com/gyr0008/Stellaflix` |
| 安装包命名 | `Stellaflix-<version>-Setup.exe` |
| 元数据 | 同目录必须有 `latest.yml`（可选 `.blockmap`） |
| 版本规则 | 新版本必须 **严格大于** 已装版本（SemVer） |
| 生效范围 | 仅 **打包安装版**；`npm start` 开发模式会走外链降级 |

---

## 1. 打包前

- [ ] 更新 `package.json` → `"version": "x.y.z"`（递增，勿用已发布过的号）
- [ ] 确认 `build.publish` 仍指向 `gyr0008/Stellaflix`
- [ ] 确认 `stellaflix.update.mirrors` 仍为可用国内加速前缀：
  - [ ] `https://gh.llkk.cc/`
  - [ ] `https://ghfast.top/`
  - [ ] `https://gh-proxy.com/`
- [ ] 本地冒烟：启动 / 播放 / 登录不回归
- [ ] （可选）`npm run build:win:dir` 快速验包，再正式出 NSIS

```bash
npm run build:win
```

产物默认在 `dist/`。

---

## 2. 构建产物核对

在 `dist/` 确认至少存在：

- [ ] `Stellaflix-<version>-Setup.exe`  
      （`artifactName` 为 `Stellaflix-${version}-Setup.${ext}`）
- [ ] `latest.yml`  
      内容中的 `version` 必须与安装包版本一致
- [ ] （推荐）`Stellaflix-<version>-Setup.exe.blockmap`  
      用于差分，减小已装用户下载量
- [ ] 不要把 `win-unpacked/`、`*.blockmap` 之外的中间目录当安装包传播

**快速检查 `latest.yml`：**

```powershell
Get-Content dist\latest.yml
# 期望看到 version、path、sha512、size 等字段
# path 应等于 Stellaflix-<version>-Setup.exe
```

---

## 3. 创建 GitHub Release

- [ ] Tag：`v<version>`（例如 `v2.1.1`）
- [ ] Release 标题建议与版本一致
- [ ] 上传资产（同一次 Release，同一目录语义）：
  - [ ] `Stellaflix-<version>-Setup.exe`
  - [ ] `latest.yml`
  - [ ] `Stellaflix-<version>-Setup.exe.blockmap`（若有）
- [ ] 不要改名 `latest.yml` / Setup.exe（electron-updater 按约定解析）
- [ ] 尽量使用 **Latest** release（非 pre-release），除非显式要测 preview
- [ ] 发布说明写清变更，便于用户在面板里看到

---

## 4. 镜像 / CDN 实测（国内）

electron-updater 镜像 feed 形态（客户端已实现）：

| 镜像前缀示例 | 实际请求 |
|---|---|
| `https://gh-proxy.com` | `https://gh-proxy.com/https://github.com/gyr0008/Stellaflix/releases/latest/download/...` |
| `https://gh-proxy.com/https://github.com` | 同上（兼容已含 github.com 的前缀） |

发布后在可访问 GitHub 受限的网络下抽查：

- [ ] GitHub 直连能否拉到 `latest.yml`
- [ ] 镜像 1/2/3 能否拉到 `latest.yml` 与 Setup.exe
- [ ] 若某镜像失效，更新 `package.json` → `stellaflix.update.mirrors` 后 **再发一版**（老客户端只有发版才能吃到新镜像列表）

手动探测示例：

```powershell
# 任选一条镜像
Invoke-WebRequest -Uri "https://gh-proxy.com/https://github.com/gyr0008/Stellaflix/releases/latest/download/latest.yml" -UseBasicParsing | Select-Object -Expand Content
```

期望返回 YAML，且 `version` 为刚发的版本。

---

## 5. 应用内更新冒烟（必做）

准备：本机已安装 **旧一档版本**（如当前 2.1.0，发布 2.1.1）。

- [ ] 启动旧版 → 出现更新入口
- [ ] 打开更新面板，主按钮为 **「应用内下载更新」**（非仅「打开网盘」）
- [ ] 点下载 → 出现进度；日志/面板显示线路（GitHub 直连或国内加速）
- [ ] 下载完成 → 按钮变为 **「立即安装并重启」**
- [ ] 安装 → 应用退出 → NSIS 静默装完 → **自动启动新版**
- [ ] 新版关于页/版本号正确
- [ ] 播放、登录态、本地曲库未损坏

失败路径：

- [ ] 断网点更新 → 提示失败，可手动点网盘线路
- [ ] 故意只上传 Setup 不传 `latest.yml`（测试库）→ 应用内检查失败并降级外链
- [ ] 磁盘紧张（可选）→ 提示空间不足并降级

---

## 6. 网盘同步（降级路径）

应用内更新失败时用户仍依赖网盘：

- [ ] 夸克盘 / 百度云 / 蓝奏云 上传同一 `Stellaflix-<version>-Setup.exe`
- [ ] 更新 `README` 下载表中的版本号与链接
- [ ] 软件内「下载线路」里的网盘地址若写在 Release notes / 接口配置，保持与 README 一致

---

## 7. 发布后自检（5 分钟）

- [ ] `https://github.com/gyr0008/Stellaflix/releases/latest` 可打开且为 Latest
- [ ] `.../releases/latest/download/latest.yml` 直连可下载
- [ ] 从旧版点一次「检查更新」，确认 `available` 且不是永远卡在 opening 网盘
- [ ] 观察是否有用户反馈「下载失败」——优先查镜像与 `latest.yml` 是否上传

---

## 8. 常见故障对照

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 主按钮一直打开网盘 | 非打包版 / 无 feeds / check 失败 | 看主进程 `[AutoUpdate]` 日志；确认 packaged |
| 检查成功但下载失败 | 镜像 404、GitHub 超时 | 换镜像；核对 Release 资产名 |
| 下载完成但没装上 | 旧逻辑 before-quit 拦截（已修）/ 杀软拦截 Setup | 用含本次修复的客户端；加白名单 |
| 版本回退不提示 | allowDowngrade=false | 正常；发更高版本 |
| `latest.yml` 404 | 忘了上传或改名 | 重新挂到 **同一** Release |

---

## 9. 一键发版流程摘要

```text
改版本号 → build:win → 核对 dist（Setup.exe + latest.yml + blockmap）
  → GitHub Release 上传三者（Latest）
  → 实测 latest.yml 直连/镜像
  → 旧版安装包冒烟应用内更新
  → 同步网盘 + README
```

---

## 附录：本地模拟更新（可选）

- `STELLAFLIX_UPDATE_MANIFEST` 可指向本地 JSON 或 HTTP 地址模拟 Release 信息（用于 UI/版本检测）。
- 完整「下载 + 静默安装」仍需要真实 NSIS + `latest.yml`，开发模式默认跳过 electron-updater。
