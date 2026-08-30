/*
 * Stellaflix 影视模块 — 灯塔模式 · 运行配置 (Phase 4 对照 hearthere.live 重建)
 *
 * 集中管理灯塔模式的全局开关与地图密钥，供 globe.js 与 view.js 读取。
 *  - LH.config.online  ：是否接入真实边缘（Cloudflare Worker + WebRTC）。默认 false（离线演示）。
 *  - LH.MAP_CONFIG.mapTilerKey ：MapTiler API Key。
 *      留空 → 世界页 3D 地球不显示地表地理，仅渲染「近黑太空 + 发光信标 + 大气辉光」
 *      （与 hearthere.live 的离线观感一致，但不含大陆/海洋贴图）。
 *      填入有效 Key → deck.gl GlobeView 经 MVTLayer 拉取 MapTiler v3 矢量瓦片，
 *      在真 3D 球体上渲染陆地/海洋/国界几何（矢量暗色地球，与参考站 hearthere.live 一致）。
 *
 *  填 Key 方式：把本文件 LH.MAP_CONFIG.mapTilerKey 改为你的 MapTiler Key，
 *  或在 index.html 加载前由宿主注入 window.StellaflixVideo.lighthouse.MAP_CONFIG.mapTilerKey。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});

  // 全局开关（webrtc.js / security.js 也会确保 LH.config 存在，这里补默认）
  LH.config = LH.config || {};
  if (typeof LH.config.online === 'undefined') LH.config.online = false;

  // 地图密钥与底图偏好
  LH.MAP_CONFIG = LH.MAP_CONFIG || {};
  // MapTiler Key：https://www.maptiler.com/ 注册后获取。留空则无地表贴图。
  LH.MAP_CONFIG.mapTilerKey = LH.MAP_CONFIG.mapTilerKey || 'nMcdjIXAW4OMjZZnckds';
  // 地表风格：'vector'（MapTiler 矢量暗色，默认，与参考站 hearthere.live 一致）。
  //   deck.gl GlobeView 经 MVTLayer 拉取 MapTiler v3 矢量瓦片，渲染陆地/海洋/国界几何。
  LH.MAP_CONFIG.basemap = LH.MAP_CONFIG.basemap || 'vector';

  // 地球初始视角（经度/纬度/缩放）。zoom 0~1 看到完整球体
  LH.MAP_CONFIG.initialView = LH.MAP_CONFIG.initialView || {
    longitude: 10, latitude: 20, zoom: 0.6,
    minZoom: 0, maxZoom: 6
  };
  // 自转（度/秒）；0 关闭。参考站地球缓慢自转
  LH.MAP_CONFIG.autoRotate = LH.MAP_CONFIG.autoRotate != null ? LH.MAP_CONFIG.autoRotate : 4;

  LH.config.MAP_CONFIG = LH.MAP_CONFIG; // 兼容旧读取路径 LH.config.MAP_CONFIG
})(typeof window !== 'undefined' ? window : this);
