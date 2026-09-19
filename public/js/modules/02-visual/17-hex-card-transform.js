/*
 * Stellaflix — 蜂窝卡片径向衰减与 DOM 直写（移植自 folia-major-0.7.7 src/components/folia-grid/hexCardTransform.ts）
 * computeHexCardFrame 为纯函数；applyHexCardFrameStyles 只写发生变化的样式，
 * 供拖拽 rAF 循环绕开 React/重排使用。仅剥离 TypeScript 类型。
 */
(function (global) {
  'use strict';

  var formatNumber = function (value, precision) {
    if (precision === undefined) precision = 4;
    if (Object.is(value, -0) || Math.abs(value) < 0.00001) return '0';
    var rounded = Number(value.toFixed(precision));
    return String(rounded);
  };

  var formatOpacity = function (value) {
    return formatNumber(Math.max(0, Math.min(1, value)), 3);
  };

  // Scale of the card sitting under the viewport centre; the falloff interpolates from here down to
  // `minScale`. Both thresholds are user-tunable, so the defaults below are the shipped falloff.
  var HEX_CARD_CENTER_SCALE = 1.1;
  var HEX_CARD_MIN_SCALE_DEFAULT = 0.45;
  var HEX_CARD_MIN_OPACITY_DEFAULT = 0.4;
  var HEX_CARD_MIN_SCALE_BOUNDS = { min: 0.2, max: 1.1 };
  var HEX_CARD_MIN_OPACITY_BOUNDS = { min: 0, max: 1 };

  var buildTransform = function (coord, scale) {
    return 'translate3d(' + formatNumber(coord.baseX, 3) + 'px, ' + formatNumber(coord.baseY, 3) + 'px, 0) scale(' + formatNumber(scale) + ')';
  };

  // Resolves visual state for one card without touching the DOM.
  // coord: { index, cube, baseX, baseY } from StellaflixHexGrid; dx/dy: world drag offset.
  var computeHexCardFrame = function (coord, dx, dy, options) {
    var clipRadius = options.clipRadius;
    var maxDistance = options.maxDistance;
    var lodStart = options.lodStart;
    var lodEnd = options.lodEnd;
    var viewportWidth = options.viewportWidth;
    var viewportHeight = options.viewportHeight;
    var cardWidth = options.cardWidth === undefined ? 0 : options.cardWidth;
    var cardHeight = options.cardHeight === undefined ? 0 : options.cardHeight;
    var visibilityBuffer = options.visibilityBuffer === undefined ? 0 : options.visibilityBuffer;
    var minScale = options.minScale === undefined ? HEX_CARD_MIN_SCALE_DEFAULT : options.minScale;
    var minOpacity = options.minOpacity === undefined ? HEX_CARD_MIN_OPACITY_DEFAULT : options.minOpacity;

    var centerX = coord.baseX + dx;
    var centerY = coord.baseY + dy;
    var distanceSq = centerX * centerX + centerY * centerY;
    var distance = Math.sqrt(distanceSq);
    var visibleInRadius = distance <= clipRadius;
    var visibleInViewport = viewportWidth === undefined || viewportHeight === undefined
      ? true
      : Math.abs(centerX) <= viewportWidth / 2 + cardWidth / 2 + visibilityBuffer
        && Math.abs(centerY) <= viewportHeight / 2 + cardHeight / 2 + visibilityBuffer;
    var visible = visibleInRadius && visibleInViewport;
    var progress = Math.min(distance / Math.max(maxDistance, 1), 1);
    var scale = HEX_CARD_CENTER_SCALE - (HEX_CARD_CENTER_SCALE - minScale) * progress;
    var opacity = visible ? 1.0 - (1.0 - minOpacity) * progress : 0;
    var zIndex = Math.round(50 - 49 * progress);

    var queueOpacity = '0';
    var queuePointerEvents = 'none';
    if (distance < lodStart || lodEnd <= lodStart) {
      queueOpacity = '1';
      queuePointerEvents = 'auto';
    } else if (distance <= lodEnd) {
      var queueProgress = (distance - lodStart) / (lodEnd - lodStart);
      queueOpacity = formatOpacity(1 - queueProgress);
      queuePointerEvents = 'auto';
    }

    var playOpacity = '0';
    var playScale = '0.8';
    var playPointerEvents = 'none';
    if (distance < 40) {
      var playProgress = distance / 40;
      playOpacity = formatOpacity(1 - playProgress);
      playScale = formatNumber(1 - 0.2 * playProgress);
      playPointerEvents = 'auto';
    }

    return {
      visible: visible,
      display: visible ? '' : 'none',
      distance: distance,
      distanceSq: distanceSq,
      transform: buildTransform(coord, scale),
      opacity: formatOpacity(opacity),
      zIndex: String(zIndex),
      queueOpacity: queueOpacity,
      queuePointerEvents: queuePointerEvents,
      playOpacity: playOpacity,
      playScale: playScale,
      playPointerEvents: playPointerEvents
    };
  };

  var createHexCardFrameStyleCache = function (frame) {
    return {
      display: frame.display,
      transform: frame.transform,
      opacity: frame.opacity,
      zIndex: frame.zIndex,
      queueOpacity: frame.queueOpacity,
      queuePointerEvents: frame.queuePointerEvents,
      playOpacity: frame.playOpacity,
      playScale: frame.playScale,
      playPointerEvents: frame.playPointerEvents
    };
  };

  // Applies only changed style values so the drag rAF loop avoids redundant DOM writes.
  // target: element (or mock) with a `.style` supporting display/transform/opacity/zIndex/setProperty.
  var applyHexCardFrameStyles = function (target, frame, cache) {
    var didWrite = false;
    var style = target.style;

    if (cache.display !== frame.display) {
      style.display = frame.display;
      cache.display = frame.display;
      didWrite = true;
    }

    if (!frame.visible) {
      return didWrite;
    }

    if (cache.transform !== frame.transform) {
      style.transform = frame.transform;
      cache.transform = frame.transform;
      didWrite = true;
    }

    if (cache.opacity !== frame.opacity) {
      style.opacity = frame.opacity;
      cache.opacity = frame.opacity;
      didWrite = true;
    }

    if (cache.zIndex !== frame.zIndex) {
      style.zIndex = frame.zIndex;
      cache.zIndex = frame.zIndex;
      didWrite = true;
    }

    var setCustomProperty = function (property, cacheKey, value) {
      if (cache[cacheKey] === value) return;
      style.setProperty(property, value);
      cache[cacheKey] = value;
      didWrite = true;
    };

    setCustomProperty('--queue-opacity', 'queueOpacity', frame.queueOpacity);
    setCustomProperty('--queue-pe', 'queuePointerEvents', frame.queuePointerEvents);
    setCustomProperty('--play-opacity', 'playOpacity', frame.playOpacity);
    setCustomProperty('--play-scale', 'playScale', frame.playScale);
    setCustomProperty('--play-pe', 'playPointerEvents', frame.playPointerEvents);

    return didWrite;
  };

  global.StellaflixHexCard = {
    HEX_CARD_CENTER_SCALE: HEX_CARD_CENTER_SCALE,
    HEX_CARD_MIN_SCALE_DEFAULT: HEX_CARD_MIN_SCALE_DEFAULT,
    HEX_CARD_MIN_OPACITY_DEFAULT: HEX_CARD_MIN_OPACITY_DEFAULT,
    HEX_CARD_MIN_SCALE_BOUNDS: HEX_CARD_MIN_SCALE_BOUNDS,
    HEX_CARD_MIN_OPACITY_BOUNDS: HEX_CARD_MIN_OPACITY_BOUNDS,
    computeHexCardFrame: computeHexCardFrame,
    createHexCardFrameStyleCache: createHexCardFrameStyleCache,
    applyHexCardFrameStyles: applyHexCardFrameStyles
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
