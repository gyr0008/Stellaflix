/*
 * Stellaflix 影视模块 — page-browse-3d 的墙体释放集群（#6-b 抽取）
 * disposeWall：释放大画布/纹理/网格，状态回写 SFV.browse3dBridge。
 * 经 SFV.browse3dDispose 暴露，page-browse-3d.js 原位置改委托别名，调用点零改动。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.browse3dDispose) return; // 幂等守卫

  var B = SFV.browse3dBridge;
  if (!B) throw new Error('[SFV browse3d-dispose] browse3dBridge 未加载，请检查加载顺序');

  function disposeWall() {
    var wallMesh = B.wallMesh; var wallTexture = B.wallTexture;
    if (wallMesh) {
      if (wallMesh.parent) wallMesh.parent.remove(wallMesh);
      if (wallMesh.geometry && wallMesh.geometry.dispose) wallMesh.geometry.dispose();
      if (wallMesh.material) wallMesh.material.dispose();
      B.wallMesh = null;
    }
    if (wallTexture && wallTexture.dispose) {
      try { wallTexture.dispose(); B.textureDisposed = B.textureDisposed + 1; } catch (e) {}
    }
    B.wallTexture = null;
    B.wallCanvas = null;
  }

  SFV.browse3dDispose = { disposeWall: disposeWall };
})(typeof window !== 'undefined' ? window : this);
