/*
 * Stellaflix — 六边形蜂窝网格几何（移植自 folia-major-0.7.7 src/components/folia-grid/hexViewport.ts）
 * 纯函数，零依赖。卡片序号 → 由内向外的立方坐标螺旋 → 像素座位。
 * 保留上游算法与函数名以便对照 diff；仅剥离 TypeScript 类型。
 */
(function (global) {
  'use strict';

  var toCubeKey = function (cube) { return cube.x + ':' + cube.y + ':' + cube.z; };

  var normalizeZero = function (value) { return Object.is(value, -0) ? 0 : value; };

  // Rounds fractional cube coordinates back onto the x + y + z = 0 hex grid.
  var roundCube = function (cube) {
    var rx = Math.round(cube.x);
    var ry = Math.round(cube.y);
    var rz = Math.round(cube.z);

    var xDiff = Math.abs(rx - cube.x);
    var yDiff = Math.abs(ry - cube.y);
    var zDiff = Math.abs(rz - cube.z);

    if (xDiff > yDiff && xDiff > zDiff) {
      rx = -ry - rz;
    } else if (yDiff > zDiff) {
      ry = -rx - rz;
    } else {
      rz = -rx - ry;
    }

    return { x: normalizeZero(rx), y: normalizeZero(ry), z: normalizeZero(rz) };
  };

  var pixelToCubeCenter = function (worldX, worldY, spacingX, spacingY) {
    var z = worldY / spacingY;
    var x = (worldX - (z * spacingX) / 2) / spacingX;
    var y = -x - z;
    return roundCube({ x: x, y: y, z: z });
  };

  // Enumerates all cube cells within a hex-distance radius around the center.
  var forEachCubeInRadius = function (center, radius, callback) {
    var safeRadius = Math.max(0, Math.floor(radius));
    for (var dx = -safeRadius; dx <= safeRadius; dx++) {
      var minDy = Math.max(-safeRadius, -dx - safeRadius);
      var maxDy = Math.min(safeRadius, -dx + safeRadius);
      for (var dy = minDy; dy <= maxDy; dy++) {
        var dz = -dx - dy;
        callback({
          x: center.x + dx,
          y: center.y + dy,
          z: center.z + dz
        });
      }
    }
  };

  var HEX_DIRS = [
    { x: 0, y: 1, z: -1 },
    { x: -1, y: 1, z: 0 },
    { x: -1, y: 0, z: 1 },
    { x: 0, y: -1, z: 1 },
    { x: 1, y: -1, z: 0 },
    { x: 1, y: 0, z: -1 }
  ];

  var getHexCubicSpiral = function (count) {
    var results = [{ x: 0, y: 0, z: 0 }];
    if (count <= 1) return results.slice(0, count);

    var radius = 1;
    while (results.length < count) {
      var currX = radius;
      var currY = -radius;
      var currZ = 0;

      for (var side = 0; side < 6; side++) {
        for (var step = 0; step < radius; step++) {
          if (results.length >= count) break;
          currX += HEX_DIRS[side].x;
          currY += HEX_DIRS[side].y;
          currZ += HEX_DIRS[side].z;
          results.push({ x: currX, y: currY, z: currZ });
        }
      }
      radius++;
    }

    return results;
  };

  // Returns one stable cell from the same center-out spiral without rebuilding its prefix.
  // Ring r holds 6r cells; cells 0..(1 + 3r(r+1)) cover rings 0..r.
  var getHexCubicAtIndex = function (index) {
    if (index <= 0) return { x: 0, y: 0, z: 0 };

    var radius = 1;
    while (index >= 1 + 3 * radius * (radius + 1)) radius++;

    var ringStart = 1 + 3 * (radius - 1) * radius;
    var ringOffset = index - ringStart;
    var side = Math.floor(ringOffset / radius);
    var stepsOnSide = ringOffset % radius + 1;
    var cube = { x: radius, y: -radius, z: 0 };

    for (var completedSide = 0; completedSide < side; completedSide++) {
      cube.x += HEX_DIRS[completedSide].x * radius;
      cube.y += HEX_DIRS[completedSide].y * radius;
      cube.z += HEX_DIRS[completedSide].z * radius;
    }
    cube.x += HEX_DIRS[side].x * stepsOnSide;
    cube.y += HEX_DIRS[side].y * stepsOnSide;
    cube.z += HEX_DIRS[side].z * stepsOnSide;
    return cube;
  };

  // Extends or trims a stable coordinate prefix; spacing changes intentionally rebuild it.
  var resizeHexGridCoords = function (previous, count, spacingX, spacingY) {
    var safeCount = Math.max(0, count);
    var spacingMatches = previous.length === 0 || previous.every(function (coord) {
      return coord.baseX === coord.cube.x * spacingX + (coord.cube.z * spacingX) / 2
        && coord.baseY === coord.cube.z * spacingY;
    });
    var prefix = spacingMatches ? previous.slice(0, safeCount) : [];

    for (var index = prefix.length; index < safeCount; index++) {
      var cube = getHexCubicAtIndex(index);
      prefix.push({
        index: index,
        cube: cube,
        baseX: cube.x * spacingX + (cube.z * spacingX) / 2,
        baseY: cube.z * spacingY
      });
    }
    return prefix;
  };

  var buildHexGridCoords = function (count, spacingX, spacingY) {
    return resizeHexGridCoords([], count, spacingX, spacingY);
  };

  // Resolves mounted card indexes by combining hex-ring lookup with pixel-radius filtering.
  var resolveVisibleHexIndexes = function (center, ringRadius, coordByKey, coords, worldX, worldY, pixelRadius) {
    var radiusSq = pixelRadius * pixelRadius;
    var indexes = [];

    forEachCubeInRadius(center, ringRadius, function (cube) {
      var index = coordByKey.get(toCubeKey(cube));
      if (index === undefined) return;

      var coord = coords[index];
      if (!coord) return;

      var dx = coord.baseX - worldX;
      var dy = coord.baseY - worldY;
      if (dx * dx + dy * dy <= radiusSq) {
        indexes.push(index);
      }
    });

    indexes.sort(function (a, b) { return a - b; });
    return indexes;
  };

  var areIndexListsEqual = function (left, right) {
    if (left.length !== right.length) return false;
    for (var i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  };

  global.StellaflixHexGrid = {
    toCubeKey: toCubeKey,
    roundCube: roundCube,
    pixelToCubeCenter: pixelToCubeCenter,
    forEachCubeInRadius: forEachCubeInRadius,
    getHexCubicSpiral: getHexCubicSpiral,
    getHexCubicAtIndex: getHexCubicAtIndex,
    resizeHexGridCoords: resizeHexGridCoords,
    buildHexGridCoords: buildHexGridCoords,
    resolveVisibleHexIndexes: resolveVisibleHexIndexes,
    areIndexListsEqual: areIndexListsEqual
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
