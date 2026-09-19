# Stellaflix 0.1.3 发布流程

## 发布边界

- 正式版本：`0.1.3`
- Git tag：`v0.1.3`
- Release 标题：`Stellaflix 0.1.3`
- 安装包：`Stellaflix-0.1.3-Setup.exe`
- 仅从当前可信源码完整构建，不复用旧安装包或旧 `dist/`。
- **打包目录必须包含 gitignore 的本机运行时**（`qishui-auth-v6/`、`qishui-audio-decryptor/`），以及完整生产依赖 `node_modules`（不要用 junction）。
- 构建前后必须运行：`node scripts/verify-pack-requirements.js <resources/app路径>`
- 正式 Release 不混入 Stellaflix_Beat 产物。
- **应用内热更新资产**：必须同 Release 上传 `Stellaflix-0.1.3-Setup.exe` + `latest.yml`（可选 `.blockmap`）。

## 网盘分发

- 夸克盘：<https://pan.quark.cn/s/f40289e1c5d3>
- 百度云：<https://pan.baidu.com/s/14fgTABgbfseOg9QuX0Um7Q?pwd=sjhp>（提取码 `sjhp`）
- 蓝奏云：<https://xxhuber.lanzout.com/stellaflix2>

## 公开更新说明

- 观看历史番剧聚合模型，卡片显示「第 N 话」。
- 新增 Subsonic/Navidrome 远程音乐库。
- 新增片库海报墙与首页收藏浮层。
- 新增 HLS 广告过滤与播放稳定性修复。
- 播放器支持跨源续播与剧集线路导航。

## 发布资产

- `dist/Stellaflix-0.1.3-Setup.exe`
- `dist/Stellaflix-0.1.3-Setup.exe.blockmap`
- `dist/latest.yml`
- `dist/Stellaflix-0.1.3-SHA256SUMS.txt`
