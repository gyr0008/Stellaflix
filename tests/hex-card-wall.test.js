'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VIEWPORT_PATH = path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '16-hex-grid-viewport.js');
const TRANSFORM_PATH = path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '17-hex-card-transform.js');

function loadModules() {
  const context = { console, Math, Number, Object, Array, String, Boolean };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(VIEWPORT_PATH, 'utf8'), context, { filename: VIEWPORT_PATH });
  vm.runInContext(fs.readFileSync(TRANSFORM_PATH, 'utf8'), context, { filename: TRANSFORM_PATH });
  return { grid: context.StellaflixHexGrid, card: context.StellaflixHexCard };
}

// vm 沙箱里创建的对象带独立 realm 的原型，deepEqual(strict) 会因原型不同而失败；
// 用 JSON round-trip 把结果拉回测试 realm 再比较。
const plain = (value) => JSON.parse(JSON.stringify(value));

const hexDistance = (cube) =>
  (Math.abs(cube.x) + Math.abs(cube.y) + Math.abs(cube.z)) / 2;

// ---------- hexViewport ----------

test('getHexCubicAtIndex enumerates a center-out spiral with ring capacities 1/6/12/18', () => {
  const { grid } = loadModules();
  assert.deepEqual(plain(grid.getHexCubicAtIndex(0)), { x: 0, y: 0, z: 0 });
  for (let radius = 1; radius <= 4; radius += 1) {
    const ringStart = 1 + 3 * (radius - 1) * radius;
    const ringEnd = 1 + 3 * radius * (radius + 1); // exclusive
    for (let i = ringStart; i < ringEnd; i += 1) {
      assert.equal(hexDistance(grid.getHexCubicAtIndex(i)), radius, `index ${i} should sit on ring ${radius}`);
    }
  }
});

test('every spiral cell satisfies the cube invariant x + y + z = 0', () => {
  const { grid } = loadModules();
  for (let i = 0; i < 200; i += 1) {
    const cube = grid.getHexCubicAtIndex(i);
    assert.equal(cube.x + cube.y + cube.z, 0, `index ${i} breaks invariant`);
  }
});

test('getHexCubicAtIndex is a prefix-consistent single-cell view of getHexCubicSpiral', () => {
  const { grid } = loadModules();
  const spiral = grid.getHexCubicSpiral(120);
  assert.equal(spiral.length, 120);
  for (let i = 0; i < 120; i += 1) {
    assert.deepEqual(grid.getHexCubicAtIndex(i), spiral[i], `mismatch at index ${i}`);
  }
});

test('roundCube projects fractional coordinates back onto the x+y+z=0 plane', () => {
  const { grid } = loadModules();
  assert.deepEqual(plain(grid.roundCube({ x: 0, y: 0, z: 0 })), { x: 0, y: 0, z: 0 });
  assert.deepEqual(plain(grid.roundCube({ x: 0.4, y: -0.6, z: 0.2 })), { x: 0, y: 0, z: 0 });
  assert.deepEqual(plain(grid.roundCube({ x: 1.6, y: -1.2, z: -0.9 })), { x: 2, y: -1, z: -1 });
  const rounded = grid.roundCube({ x: 0.5, y: 0.5, z: -0.5 });
  assert.equal(rounded.x + rounded.y + rounded.z, 0);
});

test('pixelToCubeCenter inverts the baseX/baseY seat mapping for every built cell', () => {
  const { grid } = loadModules();
  const spacingX = 240;
  const spacingY = 210;
  const coords = grid.buildHexGridCoords(91, spacingX, spacingY);
  for (const coord of coords) {
    assert.deepEqual(
      grid.pixelToCubeCenter(coord.baseX, coord.baseY, spacingX, spacingY),
      coord.cube,
      `seat (${coord.baseX}, ${coord.baseY}) should map back to cube of index ${coord.index}`
    );
  }
});

test('buildHexGridCoords lays cells out with the half-row offset on x', () => {
  const { grid } = loadModules();
  const coords = grid.buildHexGridCoords(8, 100, 80);
  assert.equal(coords.length, 8);
  assert.deepEqual(plain(coords[0]), { index: 0, cube: { x: 0, y: 0, z: 0 }, baseX: 0, baseY: 0 });
  for (const coord of coords) {
    assert.equal(coord.baseX, coord.cube.x * 100 + (coord.cube.z * 100) / 2);
    assert.equal(coord.baseY, coord.cube.z * 80);
  }
});

test('resizeHexGridCoords keeps the stable prefix when growing and rebuilds on spacing change', () => {
  const { grid } = loadModules();
  const small = grid.buildHexGridCoords(10, 100, 80);
  const grown = grid.resizeHexGridCoords(small, 20, 100, 80);
  assert.equal(grown.length, 20);
  for (let i = 0; i < 10; i += 1) {
    assert.deepEqual(grown[i], small[i]);
  }
  const shrunk = grid.resizeHexGridCoords(grown, 5, 100, 80);
  assert.deepEqual(shrunk, small.slice(0, 5));

  const respaced = grid.resizeHexGridCoords(small, 10, 120, 90);
  assert.equal(respaced.length, 10);
  assert.equal(respaced[9].baseX, small[9].cube.x * 120 + (small[9].cube.z * 120) / 2);
});

test('resolveVisibleHexIndexes returns sorted in-radius cells and skips unknown keys', () => {
  const { grid } = loadModules();
  const spacingX = 100;
  const spacingY = 80;
  const coords = grid.buildHexGridCoords(37, spacingX, spacingY);
  const coordByKey = new Map();
  coords.forEach((coord) => coordByKey.set(grid.toCubeKey(coord.cube), coord.index));

  const center = { x: 0, y: 0, z: 0 };
  const all = grid.resolveVisibleHexIndexes(center, 3, coordByKey, coords, 0, 0, 100000);
  assert.deepEqual(Array.from(all), Array.from(coords.map((coord) => coord.index)));

  const near = grid.resolveVisibleHexIndexes(center, 3, coordByKey, coords, 0, 0, spacingX * 1.1);
  assert.ok(near.includes(0));
  assert.ok(near.every((index) => index < 19));
  for (let i = 1; i < near.length; i += 1) {
    assert.ok(near[i] > near[i - 1], 'indexes must be sorted ascending');
  }
  const empty = grid.resolveVisibleHexIndexes(center, 3, new Map(), coords, 0, 0, 100000);
  assert.deepEqual(Array.from(empty), []);
});

test('areIndexListsEqual compares element-wise', () => {
  const { grid } = loadModules();
  assert.equal(grid.areIndexListsEqual([1, 2, 3], [1, 2, 3]), true);
  assert.equal(grid.areIndexListsEqual([1, 2], [1, 2, 3]), false);
  assert.equal(grid.areIndexListsEqual([1, 3, 2], [1, 2, 3]), false);
  assert.equal(grid.areIndexListsEqual([], []), true);
});

test('forEachCubeInRadius visits exactly the hex-diamond cell count', () => {
  const { grid } = loadModules();
  const visited = [];
  grid.forEachCubeInRadius({ x: 0, y: 0, z: 0 }, 2, (cube) => visited.push(cube));
  assert.equal(visited.length, 1 + 3 * 2 * 3); // ring formula: 1 + 3r(r+1)
  assert.ok(visited.every((cube) => hexDistance(cube) <= 2));
  assert.ok(visited.every((cube) => cube.x + cube.y + cube.z === 0));
});

// ---------- hexCardTransform ----------

const CENTER = { index: 0, cube: { x: 0, y: 0, z: 0 }, baseX: 0, baseY: 0 };
const BASE_OPTIONS = {
  clipRadius: 5000,
  maxDistance: 1000,
  lodStart: 300,
  lodEnd: 600,
};

test('the card under the viewport centre gets full scale, opacity and top zIndex', () => {
  const { card } = loadModules();
  const frame = card.computeHexCardFrame(CENTER, 0, 0, BASE_OPTIONS);
  assert.equal(frame.visible, true);
  assert.equal(frame.display, '');
  assert.equal(frame.distance, 0);
  assert.equal(frame.transform, 'translate3d(0px, 0px, 0) scale(1.1)');
  assert.equal(frame.opacity, '1');
  assert.equal(frame.zIndex, '50');
  assert.equal(card.HEX_CARD_CENTER_SCALE, 1.1);
});

test('scale and opacity fall off linearly with distance and clamp at maxDistance', () => {
  const { card } = loadModules();
  const half = card.computeHexCardFrame(
    { ...CENTER, baseX: 500, baseY: 0 },
    0, 0,
    { ...BASE_OPTIONS, minScale: 0.45, minOpacity: 0.4 }
  );
  assert.equal(half.transform, 'translate3d(500px, 0px, 0) scale(0.775)');
  assert.equal(half.opacity, '0.7');
  assert.equal(half.zIndex, '26'); // round(50 - 49 * 0.5)

  const beyond = card.computeHexCardFrame(
    { ...CENTER, baseX: 4000, baseY: 0 },
    0, 0,
    { ...BASE_OPTIONS, minScale: 0.45, minOpacity: 0.4 }
  );
  assert.equal(beyond.transform, 'translate3d(4000px, 0px, 0) scale(0.45)');
  assert.equal(beyond.opacity, '0.4');
  assert.equal(beyond.zIndex, '1');
});

test('minScale and minOpacity overrides move the falloff floor', () => {
  const { card } = loadModules();
  const frame = card.computeHexCardFrame(
    { ...CENTER, baseX: 2000, baseY: 0 },
    0, 0,
    { ...BASE_OPTIONS, minScale: 0.8, minOpacity: 0 }
  );
  assert.equal(frame.transform, 'translate3d(2000px, 0px, 0) scale(0.8)');
  assert.equal(frame.opacity, '0');
});

test('cards outside clipRadius or the viewport box are hidden with display none', () => {
  const { card } = loadModules();
  const outsideRadius = card.computeHexCardFrame(
    { ...CENTER, baseX: 6000, baseY: 0 },
    0, 0,
    BASE_OPTIONS
  );
  assert.equal(outsideRadius.visible, false);
  assert.equal(outsideRadius.display, 'none');
  assert.equal(outsideRadius.opacity, '0');

  const outsideViewport = card.computeHexCardFrame(
    { ...CENTER, baseX: 3000, baseY: 0 },
    0, 0,
    { ...BASE_OPTIONS, viewportWidth: 800, viewportHeight: 600, cardWidth: 200, cardHeight: 260 }
  );
  assert.equal(outsideViewport.visible, false);

  const insideViewport = card.computeHexCardFrame(
    { ...CENTER, baseX: 300, baseY: 0 },
    0, 0,
    { ...BASE_OPTIONS, viewportWidth: 800, viewportHeight: 600, cardWidth: 200, cardHeight: 260 }
  );
  assert.equal(insideViewport.visible, true);
});

test('queue and play affordances fade per LOD band', () => {
  const { card } = loadModules();
  const close = card.computeHexCardFrame({ ...CENTER, baseX: 100, baseY: 0 }, 0, 0, BASE_OPTIONS);
  assert.equal(close.queueOpacity, '1');
  assert.equal(close.queuePointerEvents, 'auto');

  const mid = card.computeHexCardFrame({ ...CENTER, baseX: 450, baseY: 0 }, 0, 0, BASE_OPTIONS);
  assert.equal(mid.queueOpacity, '0.5');
  assert.equal(mid.queuePointerEvents, 'auto');

  const far = card.computeHexCardFrame({ ...CENTER, baseX: 700, baseY: 0 }, 0, 0, BASE_OPTIONS);
  assert.equal(far.queueOpacity, '0');
  assert.equal(far.queuePointerEvents, 'none');

  const onCenter = card.computeHexCardFrame(CENTER, 0, 0, BASE_OPTIONS);
  assert.equal(onCenter.playOpacity, '1');
  assert.equal(onCenter.playScale, '1');
  assert.equal(onCenter.playPointerEvents, 'auto');

  const pastPlay = card.computeHexCardFrame({ ...CENTER, baseX: 100, baseY: 0 }, 0, 0, BASE_OPTIONS);
  assert.equal(pastPlay.playOpacity, '0');
  assert.equal(pastPlay.playPointerEvents, 'none');
});

test('transform string drops negative zero and sub-pixel noise', () => {
  const { card } = loadModules();
  const frame = card.computeHexCardFrame({ ...CENTER, baseX: -0.000001, baseY: -0 }, 0, 0, BASE_OPTIONS);
  assert.equal(frame.transform, 'translate3d(0px, 0px, 0) scale(1.1)');
});

test('applyHexCardFrameStyles writes only changed values and short-circuits hidden cards', () => {
  const { card } = loadModules();
  const writes = [];
  const store = {};
  const style = {
    setProperty(property, value) { writes.push(`${property}=${value}`); },
  };
  ['display', 'transform', 'opacity', 'zIndex'].forEach((prop) => {
    Object.defineProperty(style, prop, {
      get() { return store[prop] === undefined ? '' : store[prop]; },
      set(value) { writes.push(`${prop}=${value}`); store[prop] = value; },
    });
  });
  const target = { style };

  const frame = card.computeHexCardFrame(CENTER, 0, 0, BASE_OPTIONS);
  const cache = {};

  assert.equal(card.applyHexCardFrameStyles(target, frame, cache), true);
  assert.ok(writes.some((entry) => entry.startsWith('transform=')));
  assert.ok(writes.some((entry) => entry.startsWith('--queue-opacity=')));

  writes.length = 0;
  assert.equal(card.applyHexCardFrameStyles(target, frame, cache), false);
  assert.deepEqual(writes, []);

  const hidden = { ...frame, visible: false, display: 'none' };
  writes.length = 0;
  assert.equal(card.applyHexCardFrameStyles(target, hidden, cache), true);
  assert.deepEqual(writes, ['display=none']);
});
