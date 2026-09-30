'use strict';

/**
 * 世界页 M0 — Electron 主进程探测（由 tests/world-m0-webgl-probe.js 拉起）
 *
 * 两阶段：
 *   阶段1 探测页单次挂载 Cesium，Electron capturePage 截合成画面，判定是否全黑
 *   阶段2 探测页连切 20 次，校验建毁配对与 WebGL 上下文是否泄漏
 */

const electron = require('electron');
const appRef = electron && electron.app;
const BrowserWindowRef = electron && electron.BrowserWindow;

const URL = process.env.WORLD_M0_URL;
if (!appRef || !BrowserWindowRef) {
  console.error('electron API 异常', typeof electron);
  process.exit(2);
}
if (!URL) {
  console.error('WORLD_M0_URL 未设置');
  process.exit(2);
}

let win = null;
let finished = false;
const contextWarnings = [];

function finish(code, extra) {
  if (finished) return;
  finished = true;
  if (extra) console.log('##WORLD_M0_EXTRA##', JSON.stringify(extra));
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
  try { appRef.exit(code); } catch (e) { process.exit(code); }
}

function exec(js) {
  return win.webContents.executeJavaScript(js);
}

// 对 NativeImage 做亮度统计：BGRA 位图，判断合成画面是否全黑
function analyzeImage(nativeImage) {
  const img = nativeImage.resize({ width: 64, height: 64, quality: 'good' });
  const bitmap = img.toBitmap(); // BGRA
  const total = 64 * 64;
  let sum = 0;
  let nonBlack = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const b = bitmap[o];
    const g = bitmap[o + 1];
    const r = bitmap[o + 2];
    const v = r + g + b;
    sum += v;
    if (v > 12) nonBlack++;
  }
  return {
    avg: Math.round((sum / total) * 100) / 100,
    nonBlackPx: nonBlack,
    totalPx: total,
    size: nativeImage.getSize()
  };
}

appRef.whenReady().then(async () => {
  win = new BrowserWindowRef({
    width: 900,
    height: 700,
    // 必须真实绘制：隐藏窗口不 paint，WebGL 合成画面取不到。
    // 放到屏幕外既不打扰用户，又保证 Chromium 走完整合成管线。
    show: true,
    x: -2000,
    y: -2000,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      backgroundThrottling: false
    }
  });

  win.webContents.on('console-message', (_e, _level, msg) => {
    const s = String(msg);
    if (/Too many active WebGL contexts/i.test(s)) contextWarnings.push(s);
    if (/world-cesium|world-m0|error|Error/i.test(s)) console.log('[page]', s);
  });

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('did-fail-load', code, desc);
    finish(1, { contextWarnings });
  });

  const started = Date.now();
  let phase1Done = false;
  let phase2Done = false;
  let captureStats = null;

  const poll = setInterval(async () => {
    if (finished) { clearInterval(poll); return; }
    try {
      if (!phase1Done) {
        const p1 = await exec('window.__PHASE1__ || null');
        if (p1) {
          phase1Done = true;
          console.log('[probe] phase1', JSON.stringify(p1));
          const shot = await win.webContents.capturePage();
          captureStats = analyzeImage(shot);
          console.log('[probe] capture', JSON.stringify(captureStats));
          // 落盘截图供人工核对（世界页地球是否居中）
          try {
            const fs = require('fs');
            const path = require('path');
            const outDir = path.join(__dirname, '..', 'outputs');
            fs.mkdirSync(outDir, { recursive: true });
            const outPath = path.join(outDir, 'world-m0-frame.png');
            fs.writeFileSync(outPath, shot.toPNG());
            fs.writeFileSync(path.join(outDir, 'world-m2-globe.png'), shot.toPNG());
            console.log('[probe] screenshot ->', outPath);
          } catch (e) {
            console.log('[probe] screenshot save failed', e && e.message);
          }
          await exec('window.__CONTINUE__ = true');
        }
      } else if (!phase2Done) {
        const p2 = await exec('window.__PHASE2__ || null');
        if (p2) {
          phase2Done = true;
          console.log('[probe] phase2(detail)', JSON.stringify(p2));
          try {
            const shot2 = await win.webContents.capturePage();
            const fs = require('fs');
            const path = require('path');
            const outDir = path.join(__dirname, '..', 'outputs');
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(outDir, 'world-m2-detail.png'), shot2.toPNG());
            console.log('[probe] detail screenshot ->', path.join(outDir, 'world-m2-detail.png'));
          } catch (e) {
            console.log('[probe] detail screenshot failed', e && e.message);
          }
          await exec('window.__CONTINUE2__ = true');
        } else if (Date.now() - started > 180000) {
          clearInterval(poll);
          console.error('probe timeout at phase2');
          finish(1, { contextWarnings, captureStats });
        }
      } else {
        const r = await exec('window.__RESULT__ || null');
        if (r) {
          clearInterval(poll);
          console.log('##WORLD_M0_RESULT##');
          console.log(JSON.stringify(r));
          console.log('##END##');
          const okLifecycle = !!r.ok && !r.error;
          const okContext = contextWarnings.length === 0;
          const okVisual = !!(captureStats && captureStats.nonBlackPx > 200);
          const dragInfo = (r.phase1 && r.phase1.drag) || null;
          const okInteract = !!(dragInfo && dragInfo.ok);
          const lhInfo = (r.phase1 && r.phase1.lighthouse) || null;
          const okLighthouse = !!(lhInfo && lhInfo.ok);
          const detailInfo = r.phase2 || null;
          const okDetail = !!(detailInfo && detailInfo.ok);
          console.log('[probe] lifecycle=', okLifecycle,
            '| contextLeak=', !okContext,
            '| visualNonBlack=', okVisual,
            '| interactive=', okInteract,
            '| lighthouse=', okLighthouse,
            '| detailTier=', okDetail,
            '| drag=', JSON.stringify(dragInfo),
            '| lh=', JSON.stringify(lhInfo),
            '| detail=', JSON.stringify(detailInfo),
            '| warnings=', contextWarnings.length);
          if (!okLifecycle || !okContext || !okVisual || !okInteract || !okLighthouse || !okDetail) {
            finish(1, { contextWarnings, phase1: r.phase1, phase2: r.phase2, captureStats });
          } else {
            finish(0, { contextWarnings: 0, captureStats, phase1: r.phase1, phase2: r.phase2 });
          }
        } else if (Date.now() - started > 180000) {
          clearInterval(poll);
          console.error('probe timeout');
          finish(1, { contextWarnings, captureStats });
        }
      }
    } catch (e) {
      if (Date.now() - started > 180000) {
        clearInterval(poll);
        console.error('probe error/timeout', e);
        finish(1, { contextWarnings, captureStats });
      }
    }
  }, 300);

  win.loadURL(URL).catch((e) => {
    console.error('loadURL failed', e);
    finish(1, { contextWarnings });
  });
});

setTimeout(() => {
  console.error('global timeout');
  finish(1, { contextWarnings });
}, 200000);
