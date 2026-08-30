/*
 * Stellaflix 影视模块 — page-browse-3d 的 spacechange 集群（#6-b 抽取）
 * onSpaceChange：离开影视态 → 反激活（还原 orbit）。
 * active 经 SFV.browse3dBridge getter；deactivate 经函数桥。
 * 经 SFV.browse3dSpacechange 暴露，page-browse-3d.js 原位置改委托别名，调用点零改动。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.browse3dSpacechange) return; // 幂等守卫

  var B = SFV.browse3dBridge;
  if (!B) throw new Error('[SFV browse3d-spacechange] browse3dBridge 未加载，请检查加载顺序');

  function onSpaceChange() {
    var doc = global.document;
    var inVideo = doc && doc.body && doc.body.classList.contains('video-space-active');
    if (!inVideo && B.active) B.deactivate();
  }

  SFV.browse3dSpacechange = { onSpaceChange: onSpaceChange };
})(typeof window !== 'undefined' ? window : this);
