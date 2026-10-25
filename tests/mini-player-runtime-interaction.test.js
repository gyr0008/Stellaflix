'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Task 5：交互面通道（move-by / window-move-by / 穿透 sync+async / prepare-transition 契约）。
// 断言 runtime 源码含 5 个通道名且无禁串；prepare-transition 通道 Task 4 已注册，
// Task 5 换成真实 prewarm/origin 逻辑后通道字符串必须仍在。
test('runtime 源码含 5 个交互通道且无 mineradio 残留', () => {
  const src = read('desktop/mini-player-runtime.js');
  for (const ch of [
    'stellaflix-mini-player-move-by',
    'stellaflix-mini-player-window-move-by',
    'stellaflix-mini-player-set-pointer-passthrough-sync',
    'stellaflix-mini-player-set-pointer-passthrough',
    'stellaflix-mini-player-prepare-transition',
  ]) assert.ok(src.includes(ch), 'missing ' + ch);
  assert.ok(!/mineradio/i.test(src));
  // 封面拖动核心模块：逐字移植件同样不得含禁串
  const drag = read('desktop/mini-player-cover-drag.js');
  assert.ok(!/mineradio/i.test(drag));
  assert.match(src, /require\('\.\/mini-player-cover-drag'\)/);
});

// normalizeMiniPlayerCoverDragMeta —— 源 :3547-3573 的实际行为是「非法即抛 TypeError/RangeError」，
// IPC 处理器外层 try/catch 把抛出转成 {ok:false,error}；测试按源行为断言，不按梗概措辞。
const runtimeModule = require('../desktop/mini-player-runtime');
const { normalizeMiniPlayerCoverDragMeta, miniPlayerBoundsSignature } = runtimeModule;

test('normalizeMiniPlayerCoverDragMeta 拒绝非整数代际、透传锚点', () => {
  assert.equal(normalizeMiniPlayerCoverDragMeta(null), null, '缺元数据=旧的无锚点调用');
  assert.equal(normalizeMiniPlayerCoverDragMeta(undefined), null);
  assert.throws(() => normalizeMiniPlayerCoverDragMeta({ generation: 1.5 }), TypeError);
  assert.throws(() => normalizeMiniPlayerCoverDragMeta({ generation: 0 }), TypeError);
  assert.throws(() => normalizeMiniPlayerCoverDragMeta({ generation: '3' }), TypeError);
  assert.throws(() => normalizeMiniPlayerCoverDragMeta([]), TypeError);
  const meta = normalizeMiniPlayerCoverDragMeta({
    generation: 3,
    anchor: { x: 10.5, y: -20 },
    layout: 'expanded',
  });
  assert.deepEqual(meta, { generation: 3, anchor: { x: 10.5, y: -20 }, layout: 'expanded' });
  assert.throws(() => normalizeMiniPlayerCoverDragMeta({ generation: 2, anchor: { x: NaN, y: 1 } }), TypeError);
  assert.throws(() => normalizeMiniPlayerCoverDragMeta({ generation: 2, layout: 'wide' }), RangeError);
});

test('miniPlayerBoundsSignature 同坐标稳定、改坐标或方向即变', () => {
  const a = { x: 100.4, y: 200.6 };
  const b = { x: 100.2, y: 200.7 };
  assert.equal(miniPlayerBoundsSignature(a), miniPlayerBoundsSignature(b), '取整后同点位签名一致');
  assert.notEqual(miniPlayerBoundsSignature(a), miniPlayerBoundsSignature({ x: 101, y: 200.6 }));
  assert.notEqual(
    miniPlayerBoundsSignature({ x: 100, y: 200, expandDirection: 'left' }),
    miniPlayerBoundsSignature({ x: 100, y: 200, expandDirection: 'right' }),
  );
  assert.equal(miniPlayerBoundsSignature(null), '');
  assert.equal(miniPlayerBoundsSignature({ x: 5, y: 5, expandDirection: 'left' }), '5|5|left');
});

// 封面拖动核心（逐字移植 desktop/mini-player-cover-drag.js）：
// 会话累加逻辑封面坐标（边缘夹紧不丢位移），方向按宽侧展开，窗口边界夹在虚拟工作区。
const {
  beginMiniPlayerCoverDrag,
  miniPlayerCoverBounds,
  updateMiniPlayerCoverDrag,
} = require('../desktop/mini-player-cover-drag');

test('封面拖动会话跨边缘累加位移不被旧屏夹紧吞掉', () => {
  const WORK = { x: 0, y: 0, width: 1000, height: 800 };
  const start = { x: 600, y: 300, width: 360, height: 84 };
  const session = beginMiniPlayerCoverDrag({ bounds: start, direction: 'right' });
  const cover = miniPlayerCoverBounds(start, 'right', 'collapsed');
  assert.deepEqual(
    { x: session.coverX, y: session.coverY },
    { x: cover.x, y: cover.y },
    '无锚点时从逻辑封面边界起算',
  );
  const result = updateMiniPlayerCoverDrag(session, 320, 0, WORK, WORK);
  assert.equal(session.coverX, cover.x + 320, '逻辑封面坐标按增量累加');
  assert.equal(result.direction, 'left', '封面逼近右缘后面板改朝左展开');
  assert.equal(result.bounds.x + result.bounds.width <= WORK.x + WORK.width, true, '窗口夹回工作区');
});
