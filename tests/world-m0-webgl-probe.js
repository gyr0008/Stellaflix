'use strict';

/**
 * 世界页 M0 — WebGL 连切探测（真实 Electron/Chromium）
 * 运行：node tests/world-m0-webgl-probe.js
 *
 * 用途：在真实渲染进程里把世界页 Cesium 底座 mount/unmount 连切 20 次，
 *        校验每次都产出非黑 canvas、unmount 后 canvas 归零、WebGL 上下文未泄漏。
 *        上限约 16 个上下文，泄漏会在第 17 次左右表现为黑屏。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const probeMain = path.join(__dirname, 'world-m0-webgl-probe-main.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml'
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        let rel = decodeURIComponent(url.pathname);

        // 瓦片代理（与 server.js /api/map-tile 一致）
        if (rel.startsWith('/api/map-tile/')) {
          const parts = rel.split('/').filter(Boolean);
          const z = parseInt(parts[2], 10);
          const y = parseInt(parts[3], 10);
          const x = parseInt(parts[4], 10);
          if (!Number.isInteger(z) || !Number.isInteger(y) || !Number.isInteger(x)) {
            res.writeHead(400); res.end('bad tile'); return;
          }
          const tileUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + y + '/' + x;
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const resp = await fetch(tileUrl, { signal: controller.signal });
            clearTimeout(timer);
            if (!resp.ok) { res.writeHead(502); res.end('tile http ' + resp.status); return; }
            const buf = Buffer.from(await resp.arrayBuffer());
            res.writeHead(200, {
              'content-type': 'image/jpeg',
              'cache-control': 'public, max-age=86400',
              'access-control-allow-origin': '*'
            });
            res.end(buf);
          } catch (e) {
            res.writeHead(502); res.end('tile fetch fail');
          }
          return;
        }

        if (rel === '/') rel = '/world-m0-webgl-harness.html';
        const file = path.join(publicDir, path.normalize(rel).replace(/^([/\\])+/, ''));
        if (!file.startsWith(publicDir)) {
          res.writeHead(403); res.end('forbidden'); return;
        }
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-store'
        });
        fs.createReadStream(file).pipe(res);
      } catch (e) {
        res.writeHead(500); res.end(String(e));
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function runElectron(port) {
  return new Promise((resolve) => {
    // 关键：ELECTRON_RUN_AS_NODE 会让 electron 退化成普通 node，
    // require('electron') 只返回可执行文件路径字符串，拿不到 app/BrowserWindow。
    const env = { ...process.env, WORLD_M0_URL: `http://127.0.0.1:${port}/world-m0-webgl-harness.html` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBin, [probeMain], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { err += d; process.stderr.write(d); });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function main() {
  if (!fs.existsSync(electronBin)) {
    console.error('electron 不可见：' + electronBin);
    process.exit(2);
  }
  const server = await startServer();
  const port = server.address().port;
  console.log(`[world-m0-webgl-probe] static server on 127.0.0.1:${port}`);
  let r;
  try {
    r = await runElectron(port);
  } finally {
    server.close();
  }

  // 从 stdout 中截取 RESULT JSON
  const m = r.out.match(/##WORLD_M0_RESULT##\n([\s\S]*?)\n##END##/);
  if (!m) {
    console.error('[world-m0-webgl-probe] 未拿到 RESULT');
    process.exit(1);
  }
  let result;
  try {
    result = JSON.parse(m[1]);
  } catch (e) {
    console.error('[world-m0-webgl-probe] RESULT 解析失败', e);
    process.exit(1);
  }

  const bad = result.steps.filter((s) => !s.hasCanvas || !s.hostEmptyAfterUnmount);
  const extras = (r.out.match(/##WORLD_M0_EXTRA##\s*(\{[\s\S]*?\})\n/) || [])[1];
  const dragInfo = (result.phase1 && result.phase1.drag) || null;
  console.log('[world-m0-webgl-probe] basemap =', result.basemap, '| glCount =', result.finalGlCount);
  console.log('[world-m0-webgl-probe] steps =', result.steps.length, '| lifecycle-bad =', bad.length);
  console.log('[world-m0-webgl-probe] drag =', JSON.stringify(dragInfo));
  if (extras) console.log('[world-m0-webgl-probe] extra =', extras);
  if (bad.length) {
    console.error(JSON.stringify(bad, null, 2));
  }
  const okInteract = !!(dragInfo && dragInfo.ok);
  const lhInfo = (result.phase1 && result.phase1.lighthouse) || null;
  const okLighthouse = !!(lhInfo && lhInfo.ok);
  const detailInfo = result.phase2 || null;
  const okDetail = !!(detailInfo && detailInfo.ok);
  const rotInfo = result.__autoRotateCheck || null;
  const okRotate = !!(rotInfo && rotInfo.moved);
  const uiCard = result.__uiHasCard;
  console.log('[world-m0-webgl-probe] lighthouse =', JSON.stringify(lhInfo));
  console.log('[world-m0-webgl-probe] detail     =', JSON.stringify(detailInfo));
  console.log('[world-m0-webgl-probe] autorotate =', JSON.stringify(rotInfo), '| uiCard =', uiCard);
  if (!result.ok || bad.length || result.error || !okInteract || !okLighthouse || !okDetail || !okRotate) {
    console.error('[world-m0-webgl-probe] FAIL',
      result.error || (!okInteract ? '拖拽未驱动相机' : '') ||
      (!okLighthouse ? '灯塔层未挂上' : '') || (!okDetail ? '近景档未出现灯塔实体' : '') ||
      (!okRotate ? '自转未生效' : ''));
    process.exit(1);
  }
  console.log('[world-m0-webgl-probe] PASS — 20 次连切建毁配对、无上下文告警、画面非黑、可拖拽、自转生效、远景光晕/近景实体正确');
  process.exit(0);
}

main().catch((e) => {
  console.error('[world-m0-webgl-probe] crashed', e);
  process.exit(1);
});
