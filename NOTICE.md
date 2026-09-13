# NOTICE

Stellaflix 使用了以下第三方项目或服务。各项目版权归其原作者所有。

## Third-party Libraries

- Electron
- Three.js
- GSAP
- music-tempo
- NeteaseCloudMusicApi
- mpg123-decoder
- hls.js 1.7.1 (Apache-2.0) — vendored at `public/vendor/hls.min.js`
- flv.js 1.6.2 (Apache-2.0) — vendored at `public/vendor/flv.min.js`
- Anime4K v4.0.1 (MIT) — 9 mpv hook shaders vendored at `public/vendor/sr/glsl/` (Clamp_Highlights / Restore_CNN_M / Upscale_CNN_x2_M / Upscale_Denoise_CNN_x2_S / AutoDownscalePre_x2 / AutoDownscalePre_x4 / Upscale_CNN_x2_S / Restore_CNN_VL / Upscale_CNN_x2_VL), from [bloc97/Anime4K](https://github.com/bloc97/Anime4K) tag `v4.0.1`; license text at `public/vendor/sr/LICENSE.Anime4K.txt`
- FSRCNNX_x2_8-0-4-1.glsl (GPL-3.0) — vendored at `public/vendor/sr/glsl/FSRCNNX_x2_8-0-4-1.glsl`, from [igv/FSRCNN-TensorFlow](https://github.com/igv/FSRCNN-TensorFlow) release `1.1`; license text at `public/vendor/sr/LICENSE.FSRCNNX.txt`
- FSRCNNX_x2_16-0-4-1.glsl (GPL-3.0) — vendored at `public/vendor/sr/glsl/FSRCNNX_x2_16-0-4-1.glsl`, same source/release/license as the 8-0-4-1 variant above; used by SR tier 2 (luma chain).
- Deband.glsl (self-written, Stellaflix original) — vendored at `public/vendor/sr/glsl/Deband.glsl`. A custom luma-chain debanding pass (`//!HOOK LUMA` + `//!BIND HOOKED`) authored for Stellaflix SR tier 2; not derived from a third-party project.

## Community Contributions

- Cuefield AutoMix planner/runtime: adapted for experimental local testing from [SLYysl/cuefield-stellaflix](https://github.com/SLYysl/cuefield-stellaflix) (GPL-3.0). The optional remote-feedback component from that repository is not included; Stellaflix stores Cuefield ratings locally in the current user's data directory.
- Wallpaper Engine local-library detection and import UX: independently adapted from the approach used by [ww085213/Stellaflix-LX-Music](https://github.com/ww085213/Stellaflix-LX-Music) at commit `a5ef80a219709080700be5b1d00f1ea71a5a2576` (GPL-3.0). Stellaflix only indexes local `project.json` metadata; it does not execute imported Web/Application projects or replace the user's existing background-media settings.
- Full-desktop main-window mode and home-dashboard information hierarchy: initially adapted from [ww085213/Stellaflix-LX-Music](https://github.com/ww085213/Stellaflix-LX-Music) at commit `82826df814c32853d99697c0ee60f749a2fcad79`, with the homepage refreshed against `812e2dc2e18bbc263e61dbd0206cb765e003d6e9` (GPL-3.0). Stellaflix keeps its own provider, queue, playlist, listening-history, WorkerW validation, DPI, lifecycle, and cleanup implementations; see `docs/THIRD_PARTY_PORTS.md` in the corresponding source distribution.
- Qishui Passport Web QR authentication bridge: focused port from [Wx2yZx/Stellaflix-Qishui-QR-Login](https://github.com/Wx2yZx/Stellaflix-Qishui-QR-Login) at commit `aaadaab7d011714f94fbe45b382ba8dcc7cf17b9` (declared `GPL-3.0-only`). Only the official QR create/poll, security-signing host, session persistence, and second-verification path are integrated; Stellaflix keeps its own catalogue, playlist, entitlement, and playback adapters. The bundled ByteDance/Qishui web security runtime resources remain the property of their respective rights holders and are used only to interoperate with the user's own official account session.

## Third-party Services

Stellaflix 可能与网易云音乐、QQ 音乐等第三方音乐服务进行用户自有账号相关的本地客户端交互。

Stellaflix 不是任何音乐平台的官方客户端，也不隶属于网易云音乐、QQ 音乐或腾讯音乐娱乐集团。请用户自行遵守对应平台的服务协议、版权规则和会员权益规则。

## Original Design

Stellaflix 名称、SF Logo、界面视觉设计、启动动画方向、粒子视觉体验和电影镜头系统的产品表达属于作者原创设计。

emily 作为 Stellaflix 早期视觉底层想法与 `emily` 视觉预设改进方向的共创者和灵感来源之一，特此致谢。

感谢小天才e宝、应春日、锋将军、軌跡、林中、骊、风痕、花椰菜🥦在早期体验、测试反馈和发布准备中的帮助。
