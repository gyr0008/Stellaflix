/*
 * Stellaflix 影视模块 — page-browse-3d 的 group 旋转锁步集群（#6-b 拆债）
 * 复用 3D 歌单架 side 模式旋转公式（src/music/04b-shelf-3d.js L1114-1122），
 * 使网格墙 group 与歌单架 group 作为同一刚体旋转、保持平行，消除歌单架卡穿模。
 * 依赖 window 全局：pointerParallax / particles / shelfAlwaysVisible。
 * 加载序：须在 page-browse-3d.js 的 browse3dBridge 定义之后、本文件被 wallTick 调用前加载。
 */
(function (global) {
  'use strict';
  var SFV = global.StellaflixVideo = global.StellaflixVideo || {};
  if (SFV.browse3dTick) return; // 幂等守卫

  /**
   * 按歌单架 side 模式更新目标 group 的 rotation，与歌单架保持锁步平行。
   * @param {THREE.Group} group
   */
  function updateGroupRotation(group) {
    if (!group) return;
    var pp = global.pointerParallax || { x: 0, y: 0 };
    var px = pp.x || 0, py = pp.y || 0;
    var part = global.particles;
    var bindToCover = (typeof global.shelfAlwaysVisible === 'function' &&
                       global.shelfAlwaysVisible() && part && part.rotation);
    if (bindToCover) {
      group.rotation.x += ((part.rotation.x - py * 0.010) - group.rotation.x) * 0.075;
      group.rotation.y += ((part.rotation.y + px * 0.018) - group.rotation.y) * 0.075;
      group.rotation.z += (part.rotation.z - group.rotation.z) * 0.075;
    } else {
      group.rotation.y += ((px * 0.018) - group.rotation.y) * 0.045;
      group.rotation.x += ((-py * 0.010) - group.rotation.x) * 0.045;
      group.rotation.z += (0 - group.rotation.z) * 0.045;
    }
  }

  SFV.browse3dTick = { updateGroupRotation: updateGroupRotation };
})(typeof window !== 'undefined' ? window : this);
