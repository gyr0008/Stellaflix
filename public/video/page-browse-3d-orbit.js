/*
 * Stellaflix 影视模块 — page-browse-3d 的相机 orbit 复用/还原集群（#6-b 抽取）
 * saveOrbit / setOrbitGrid / restoreOrbit。
 * 共享状态 orbit / gridCameraMode / GRID_RADIUS 经 SFV.browse3dBridge getter 获取；
 * savedOrbit 为本集群独占（saveOrbit 写入、restoreOrbit 读取并置空），自拥于模块内。
 * 经 SFV.browse3dOrbit 暴露，page-browse-3d.js 原位置改委托别名，调用点零改动。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.browse3dOrbit) return; // 幂等守卫

  var B = SFV.browse3dBridge;
  if (!B) throw new Error('[SFV browse3d-orbit] browse3dBridge 未加载，请检查加载顺序');

  var savedOrbit = null; // 独占状态

  function saveOrbit() {
    var orbit = B.orbit;
    if (!orbit) return;
    savedOrbit = {
      userRadius: orbit.userRadius, baselineRadius: orbit.baselineRadius,
      userTheta: orbit.userTheta, baselineTheta: orbit.baselineTheta,
      userPhi: orbit.userPhi, baselinePhi: orbit.baselinePhi,
      recentering: !!orbit.recentering,
      centerLocked: !!orbit.centerLocked
    };
  }

  function setOrbitGrid() {
    var orbit = B.orbit; var gridCameraMode = B.gridCameraMode; var GRID_RADIUS = B.GRID_RADIUS;
    if (!orbit) return;
    orbit.userRadius = GRID_RADIUS; orbit.baselineRadius = GRID_RADIUS;
    orbit.userTheta = 0; orbit.baselineTheta = 0;
    orbit.userPhi = 0.04; orbit.baselinePhi = 0.04;
    // 相机对齐歌单架（轻量路线，单 Mesh 不变）：gridCameraMode 控制
    //  - dynamic（默认）：recentering 开启 → 相机空闲时平滑回正 home(GRID_RADIUS,0,0.04)，自由环绕；
    //  - static：centerLocked 锁定 home，受限交互（呼应 shouldUseShelfDynamicCamera 限制）。
    // 注：side/stage/detail 为歌单架层叠/电影感布局，需多 Mesh 分层，扁平网格面板不适用。
    orbit.recentering = (gridCameraMode === 'dynamic');
    orbit.centerLocked = (gridCameraMode === 'static');
  }

  function restoreOrbit() {
    var orbit = B.orbit;
    if (!orbit || !savedOrbit) return;
    orbit.userRadius = savedOrbit.userRadius; orbit.baselineRadius = savedOrbit.baselineRadius;
    orbit.userTheta = savedOrbit.userTheta; orbit.baselineTheta = savedOrbit.baselineTheta;
    orbit.userPhi = savedOrbit.userPhi; orbit.baselinePhi = savedOrbit.baselinePhi;
    orbit.recentering = !!savedOrbit.recentering;
    orbit.centerLocked = !!savedOrbit.centerLocked;
    savedOrbit = null;
  }

  SFV.browse3dOrbit = { saveOrbit: saveOrbit, setOrbitGrid: setOrbitGrid, restoreOrbit: restoreOrbit };
})(typeof window !== 'undefined' ? window : this);
