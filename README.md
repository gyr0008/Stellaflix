# Stellaflix

![Stellaflix 暗场启动页](./docs/assets/readme/cinema-beat-smoke.png)

Stellaflix 是一款 Windows 桌面沉浸式音乐播放器，把搜索播放、歌词舞台、粒子视觉、3D 歌单架和完整桌面模式组合成一个更接近现场感的私人音乐空间。

## 立即下载 Windows 安装包

> 安装包可从夸克盘、百度云、蓝奏云或 GitHub Release 手动下载；软件内更新入口仍只打开网盘线路，不读取 Release 附件。

| 下载入口 | 推荐人群 | 链接 |
| --- | --- | --- |
| 夸克盘 | 夸克用户 | [下载 Stellaflix 0.1.0](https://pan.quark.cn/s/f40289e1c5d3) |
| 百度云 | 百度网盘用户（提取码 `sjhp`） | [下载 Stellaflix 0.1.0](https://pan.baidu.com/s/14fgTABgbfseOg9QuX0Um7Q?pwd=sjhp) |
| 蓝奏云 | 直接下载 | [下载 Stellaflix 0.1.0](https://xxhuber.lanzout.com/stellaflix2) |
| GitHub Release | GitHub 用户、版本说明与源码 | [下载 Stellaflix 0.1.0](https://github.com/gyr0008/Stellaflix/releases) |

安装时只需要下载并运行 `Stellaflix-0.1.0-Setup.exe`。不要把 `.blockmap`、`latest.yml` 或 `win-unpacked` 当成正式安装包。

## 下载或安装被拦截怎么办

小众 Electron 桌面软件、未签名安装包有时会被浏览器、Windows Defender 或 SmartScreen 提示风险。请先确认安装包来自上面的网盘入口或官方 GitHub Release，文件名是 `Stellaflix-0.1.0-Setup.exe`。

1. 浏览器下载栏提示风险时，打开下载列表，点这条下载右侧的 `...` 三个点，选择 `保留` / `仍要保留` / `显示更多` 后继续保留。
2. Windows SmartScreen 弹出蓝色拦截窗口时，点 `更多信息`，再点 `仍要运行`。
3. 如果杀毒软件明确显示木马、高危或已经隔离，不要强行运行；删除该文件后重新从上面的网盘入口下载，仍然异常请带截图反馈给作者。

## 作者支持

如果 Stellaflix 陪你多听了一首歌，也欢迎请作者一杯咖啡。

[查看完整支持页](./docs/SUPPORT.md)

![Stellaflix 作者支持渠道](./docs/assets/support/stellaflix-author-support-poster.png)

Stellaflix 0.1.0 进一步优化了壁纸与全屏体验，并提升了登录、账号、本地曲库和长时间运行的稳定性。

## 当前版本

当前版本：`0.1.0`

状态：Stellaflix 0.1.0 正式版。

> 安全提示：历史错误标注的 `2.1.0` 安装包请以本页 `0.1.0` 为准重新安装；`v1.0.10` 及更早包同样不再建议继续使用。

## 核心特性

- 首页包含每日推荐、平台推荐、继续听、听歌画像和我的歌单入口
- 完整桌面模式保留播放器、主页、歌单和桌面交互
- 支持本地 MP4 与 Wallpaper Engine 视觉内容
- 播放后切换到 Emily / 默认播放态视觉，歌词舞台与粒子舞台同步工作
- 基于节奏的电影镜头视觉系统
- 面向长播客和 DJ 曲目的专属视觉模式
- 歌词舞台、自定义歌词、歌词位置与视觉控制
- 自定义专辑封面上传与裁剪
- 右键唤起 3D 歌单架，支持歌单队列浏览
- 网易云音乐账号、搜索、歌单、播客等体验接入
- QQ 音乐搜索、登录态与音源补充接入
- GitHub Releases 更新检测与下载入口
- 首次启动内置「默认测试」视觉用户存档，软件内默认视觉参数与该存档一致

## 使用说明

Windows 用户可以从本页列出的夸克盘、百度云、蓝奏云或 GitHub Release 下载安装包。

正式分发以 `Stellaflix-0.1.0-Setup.exe` 为准，不建议直接使用 `win-unpacked` 目录。安装包会创建桌面快捷方式。

已经安装过其他版本的用户可直接运行 `Stellaflix-0.1.0-Setup.exe` 完成更新。打包版优先走应用内自动更新；失败时可在浏览器打开网盘/Release 手动下载。

## 开发运行

```bash
npm install
npm start
npm run build:win
```

桌面版入口由 Electron 主进程加载本地服务。`npm run build:win` 会生成 Windows NSIS 安装包，产物位于 `dist/`。

## 更新机制

Stellaflix 采用 **应用内自动更新为主、网盘/Release 外链为辅** 的双轨更新：

1. **应用内热更新（主路径）**  
   客户端通过 electron-updater 检查 GitHub Releases（失败时回退国内镜像 feed），下载对应版本的 NSIS 安装包（`latest.yml` 校验），用户确认后静默安装并重启。下载前会做磁盘空间预检；下载失败会自动切换线路重试。

2. **网盘 / GitHub Release 外链（降级）**  
   当应用内更新不可用（开发环境、未配置仓库、网络/校验失败、磁盘不足等）时，更新面板会展示夸克/百度/蓝奏等下载线路，由用户在浏览器中手动下载 `Stellaflix-x.y.z-Setup.exe` 安装。

### 发布要求（维护者）

若要让已安装客户端吃到应用内更新，Release 必须同时包含：

- `Stellaflix-<version>-Setup.exe`
- 同目录的 `latest.yml`（`electron-builder` 自动生成）
- 可选 `.blockmap`（用于差分更新，减小下载体积）

版本号必须严格高于本地版本（SemVer）。

本地验证时，可通过 `STELLAFLIX_UPDATE_MANIFEST` 指向本地 manifest JSON 或 HTTP 地址模拟线上 Release；应用内更新仅在打包安装版（`app.isPackaged`）中启用，开发模式会走外链降级。

## 第三方音乐平台说明

Stellaflix 不是网易云音乐、QQ 音乐或腾讯音乐娱乐集团的官方客户端，也不隶属于任何音乐平台。

项目中的第三方平台接入仅用于个人学习、本地客户端体验和用户自有账号的播放辅助。请遵守对应平台的用户协议、版权规则和会员权益规则。项目不会提供绕过付费、绕过会员、破解音质或重新分发音乐内容的能力。

## 用户数据与隐私

登录 Cookie、搜索历史、自定义封面、自定义歌词、节奏分析缓存等数据只应保存在本机用户数据目录或浏览器本地存储中，不应提交到仓库。

更多说明见 [PRIVACY.md](./PRIVACY.md)。

## 致谢

Stellaflix 由 gyr0008 主要设计与打造。emily 作为早期视觉底层想法与 `emily` 视觉预设改进方向的共创者和灵感来源之一，特此感谢。

同时感谢小天才e宝、应春日、锋将军、軌跡、林中、骊、风痕、花椰菜🥦在早期体验、测试反馈和发布准备中的帮助。

## 版权与授权

Copyright (C) 2026 gyr0008.

本项目采用 GPL-3.0 授权。详见 [LICENSE](./LICENSE)。

SF Logo、Stellaflix 名称、界面视觉设计与原创视觉表达归作者所有；第三方依赖和第三方服务分别遵循其各自授权与服务条款。
