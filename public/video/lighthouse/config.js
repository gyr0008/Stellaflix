/*
 * Stellaflix 影视模块 — 灯塔模式 · 运行配置
 *
 * 集中管理灯塔模式的全局开关与地球底座参数。
 *  - LH.config.online ：是否接入真实边缘（Cloudflare Worker + WebRTC）。默认 false（离线演示）。
 *  - LH.MAP_CONFIG    ：地球底座参数，供 view.js / 世界页渲染层读取。
 *
 * 底座说明（路线 A · Cesium + 免 key 底图）：
 *  - 第一版走 Esri 卫星影像，无需任何 API Key；Esri 不可达时由渲染层自动降级到 OSM。
 *  - 不再使用 MapTiler，故本文件不持有任何地图厂商密钥。
 *  - 若将来启用 Cesium ion / Google Photorealistic 3D，密钥由用户在设置里自行填写并写入
 *    LH.MAP_CONFIG.cesiumToken / LH.MAP_CONFIG.googleKey，严禁把真实密钥提交进源码。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});

  // 全局开关（webrtc.js / security.js 也会确保 LH.config 存在，这里补默认）
  LH.config = LH.config || {};
  if (typeof LH.config.online === 'undefined') LH.config.online = false;

  // 地球底座偏好
  LH.MAP_CONFIG = LH.MAP_CONFIG || {};

  // 底图档位：'esri'（默认，免 key）/ 'osm'（降级）/ 'photoreal'（需用户自备 token）
  LH.MAP_CONFIG.basemap = LH.MAP_CONFIG.basemap || 'esri';

  // 可选的高阶底图凭证（默认留空；运行时由用户设置注入，不硬编码）
  if (LH.MAP_CONFIG.cesiumToken == null) LH.MAP_CONFIG.cesiumToken = '';
  if (LH.MAP_CONFIG.googleKey == null) LH.MAP_CONFIG.googleKey = '';

  // 地球初始视角（WGS84 经纬度 + 高度米，对齐 Cesium camera.setView）
  LH.MAP_CONFIG.initialView = LH.MAP_CONFIG.initialView || {
    longitude: 10,
    latitude: 20,
    height: 18000000
  };

  // 自转（度/秒）；0 关闭。参考站地球缓慢自转
  LH.MAP_CONFIG.autoRotate = LH.MAP_CONFIG.autoRotate != null ? LH.MAP_CONFIG.autoRotate : 4;

  LH.config.MAP_CONFIG = LH.MAP_CONFIG; // 兼容旧读取路径 LH.config.MAP_CONFIG
})(typeof window !== 'undefined' ? window : this);
