/*
 * Stellaflix 影视模块 — page-browse-3d 的 computeGrid 集群（#6-b 抽取，第 8 集群）
 * 计算网格几何（cell 尺寸 / 行数 / 画布尺寸），随 items 与窗口宽度自适应。
 * 共享状态经 SFV.browse3dBridge getter/setter；metricsForWidth 经 SFV.browse3dCore。
 * 经 SFV.browse3dGrid 暴露，page-browse-3d.js 原位置改委托别名，调用点零改动。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.browse3dGrid) return; // 幂等守卫
  var B = SFV.browse3dBridge;
  if (!B) throw new Error('[SFV browse3d-grid] browse3dBridge 未加载，请检查加载顺序');

  // —— 模块本地常量（与核心一致） ——
  // T141: 用户要求 3D 墙固定为 1216×1158，5 列 × 3 排（与 .sfv-grid 对齐），
  //       不再随窗口宽度响应式变化。
  var WINDOW_ROWS = 3;           // 画布窗口行数（可见窗口）
  var WALL_CANVAS_W = 1216;      // 大画布逻辑宽（固定态画布宽度）
  var WALL_CANVAS_H = 1158;      // 大画布逻辑高（固定态画布高度）
  var LONG_EDGE = 4096;          // 大画布长边封顶，防显存爆炸

  function computeGrid() {
    // T141: 固定 5 列 3 排，24px 内边距与间隙，填满 1216×1158 画布。
    B.gridCols = 5; B.gap = 24; B.PAD = 24;
    B.cellW = (WALL_CANVAS_W - 2 * B.PAD - (B.gridCols - 1) * B.gap) / B.gridCols;
    B.cellH = (WALL_CANVAS_H - 2 * B.PAD - (WINDOW_ROWS - 1) * B.gap) / WINDOW_ROWS;
    var total = B.items.length || B.gridCols * WINDOW_ROWS;
    var gridRows = Math.ceil(total / B.gridCols);
    B.canvasW = WALL_CANVAS_W;
    B.canvasH = WALL_CANVAS_H; // 固定画布高度，超出 3 行的内容通过滑动窗口浏览
    // 长边封顶：等比压缩所有尺寸，防显存爆炸（极端 item 数时兜底）
    var longEdge = Math.max(B.canvasW, B.canvasH);
    if (longEdge > LONG_EDGE) {
      var f = LONG_EDGE / longEdge;
      B.cellW *= f; B.cellH *= f; B.gap *= f; B.PAD *= f;
      B.canvasW *= f; B.canvasH *= f;
    }
    B.wallAspect = B.canvasW / B.canvasH;
    B.totalRows = gridRows;            // 供 raycast 命中坐标换算（onClick/onPointerMove）
    return { cellW: B.cellW, cellH: B.cellH, gap: B.gap };
  }
  SFV.browse3dGrid = { computeGrid: computeGrid };
})(typeof window !== 'undefined' ? window : this);
