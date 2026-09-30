'use strict';

/**
 * 影视态控制条「命中制唤醒」契约 —— 窗口态与全屏态统一（2026-09-27 用户拍板）
 * 契约：
 *   ① 无论窗口/全屏，鼠标在屏幕上方（非控制条区、非底部 120px 唤醒带）移动，
 *      不得解除 body.video-player-idle（控制条保持隐藏）。
 *   ② 鼠标进入底部 120px 唤醒带 → 解除 idle（控制条显示）。
 * 背景：09-26「全屏唤醒」曾让全屏态任意移动点亮，与 ① 冲突，用户今日明确否决，
 * 恢复两态一致的命中制。
 * 运行：node --test tests/player-hit-wake-fullscreen-parity.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const playerCoreSrc = read('public/video/player-core.js');
const playerSrc = read('public/video/player.js');

function buildEnv(fullscreen) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost:3000/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  win.eval(playerCoreSrc);
  win.StellaflixVideo.state = {
    _space: 'video',
    getSpace() { return this._space; },
    setSpace(s) { this._space = s; },
  };
  win.StellaflixVideo.model = { getProgress: () => null, addToLibrary: () => {} };
  win.eval(playerSrc);
  win.controlsAutoHide = true;

  const bar = win.document.createElement('div');
  bar.id = 'bottom-bar';
  win.document.body.appendChild(bar);
  win.document.body.classList.add('video-player-active', 'video-player-idle');
  if (fullscreen) win.document.body.classList.add('desktop-fullscreen');

  win.StellaflixVideo.player.prepareForPlay('test-title', '测试片');

  const move = (x, y) => {
    win.document.dispatchEvent(new win.MouseEvent('mousemove', { clientX: x, clientY: y }));
  };
  const isIdle = () => win.document.body.classList.contains('video-player-idle');
  return { win, move, isIdle, height: win.innerHeight };
}

test('全屏态：屏幕上方移动不解除 idle（命中制与窗口态一致）', () => {
  const env = buildEnv(true);
  try {
    env.move(env.height > 300 ? 400 : 0, 100);
    assert.ok(env.isIdle(), '全屏下非唤醒区移动后控制条不应点亮');
  } finally { env.win.close(); }
});

test('全屏态：进入底部 120px 唤醒带解除 idle', () => {
  const env = buildEnv(true);
  try {
    env.move(400, env.height - 40);
    assert.ok(!env.isIdle(), '底部唤醒带内移动应点亮控制条');
  } finally { env.win.close(); }
});

test('窗口态：屏幕上方移动不解除 idle', () => {
  const env = buildEnv(false);
  try {
    env.move(400, 100);
    assert.ok(env.isIdle(), '窗口下非唤醒区移动后控制条不应点亮');
  } finally { env.win.close(); }
});

test('窗口态：进入底部 120px 唤醒带解除 idle', () => {
  const env = buildEnv(false);
  try {
    env.move(400, env.height - 40);
    assert.ok(!env.isIdle(), '底部唤醒带内移动应点亮控制条');
  } finally { env.win.close(); }
});
