/**
 * N1（2026-10-04 奈飞工厂解析失败事故）：隐藏窗口嗅探 BUSY 必须排队，不得当成「未命中」。
 *
 * 背景（均有实锤）：
 *  - desktop/main.js 的 stellaflix-resolve-media-sniff 是单飞设计：并发第二请求
 *    立即返回 {ok:false, error:'BUSY'}（main.js:5686）。
 *  - 旧桥接层把 BUSY 视为「嗅探未命中」→ 降级 HTML 正则 → 对「超级播放器」系站点
 *    （player_aaaa encrypt:2 解出的是签名令牌，页面无字面 m3u8）必然落空 →
 *    解析失败，mpv 被喂 HTML 页面地址报 DEMUXER_ERROR。
 * 契约：
 *  1. 渲染层同一时刻只允许一个 sniff 在途（串行队列），后到请求排队等待而非拿到 BUSY。
 *  2. 队列外的 BUSY（跨窗口竞争）仍要有限重试，而不是立即判负。
 */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadBridge(desktopWindow) {
  const sandbox = { console, atob: globalThis.atob, setTimeout, clearTimeout, Promise };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.localStorage = { getItem: () => null, setItem: () => {} };
  if (desktopWindow) sandbox.desktopWindow = desktopWindow;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/video/kazumi-bridge-core.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/video/kazumi-bridge.js'), 'utf8'), sandbox);
  return sandbox;
}

/** 模拟主进程单飞语义：在途时再来请求立即 BUSY；正常请求 30ms 后命中 m3u8。 */
function makeSniffStub(opt) {
  opt = opt || {};
  const stub = { concurrent: 0, maxConcurrent: 0, calls: 0, busyResponses: 0 };
  stub.api = {
    resolveMediaSniff: function (url, o) {
      stub.calls++;
      if (stub.concurrent > 0 && !opt.allowConcurrent) {
        stub.busyResponses++;
        return Promise.resolve({ ok: false, error: 'BUSY' });
      }
      stub.concurrent++;
      stub.maxConcurrent = Math.max(stub.maxConcurrent, stub.concurrent);
      return new Promise((resolve) => {
        setTimeout(() => {
          stub.concurrent--;
          if (opt.alwaysBusy) resolve({ ok: false, error: 'BUSY' });
          else resolve({ ok: true, best: { url: 'https://cdn.example.com/a/index.m3u8', score: 120 } });
        }, 30);
      });
    }
  };
  return stub;
}

test('并发两次嗅探：第二次必须排队成功，不得因 BUSY 判负（N1 核心契约）', async () => {
  const stub = makeSniffStub();
  const sandbox = loadBridge(stub.api);
  const kz = sandbox.StellaflixVideo.kazumi;

  const p1 = kz.resolvePlayUrlWebview('https://netflixgc.org/vodplay/1-1-1.html', '奈飞工厂', 5000);
  const p2 = kz.resolvePlayUrlWebview('https://netflixgc.org/vodplay/1-1-2.html', '奈飞工厂', 5000);
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.ok(r1 && r1.url, '第一次应命中，实际: ' + JSON.stringify(r1));
  assert.ok(r2 && r2.url, '第二次排队后应命中（旧实现返回 null —— BUSY 被当成未命中）',
    '实际: ' + JSON.stringify(r2));
  assert.ok(/proxy/.test(r2.url), '命中地址应已按既有契约走 /api/proxy 包装');
  assert.equal(stub.maxConcurrent, 1, '主进程同一时刻只应有 1 个嗅探在途（串行化生效）');
  assert.ok(stub.busyResponses === 0 || stub.calls >= 3,
    '要么从未并发（无 BUSY），要么 BUSY 后确有重试');
});

test('队列外 BUSY（跨窗口竞争）：应有限重试而非立即判负', async () => {
  // 首次恒 BUSY，第二次成功：模拟另一窗口刚释放槽位
  let n = 0;
  const sandbox = loadBridge({
    resolveMediaSniff: function () {
      n++;
      if (n === 1) return Promise.resolve({ ok: false, error: 'BUSY' });
      return Promise.resolve({ ok: true, best: { url: 'https://cdn.example.com/b/index.m3u8', score: 120 } });
    }
  });
  const r = await sandbox.StellaflixVideo.kazumi
    .resolvePlayUrlWebview('https://netflixgc.org/vodplay/2-2-1.html', '奈飞工厂', 5000);
  assert.ok(r && r.url, 'BUSY 一次后应重试并命中，实际: ' + JSON.stringify(r));
  assert.equal(n, 2, '应恰好重试一次');
});

test('恒 BUSY 时不得无限重试（有上限，最终返回 null 交降级链）', async () => {
  let n = 0;
  const sandbox = loadBridge({
    resolveMediaSniff: function () {
      n++;
      return Promise.resolve({ ok: false, error: 'BUSY' });
    }
  });
  const r = await sandbox.StellaflixVideo.kazumi
    .resolvePlayUrlWebview('https://netflixgc.org/vodplay/3-3-1.html', '奈飞工厂', 5000);
  assert.equal(r, null, '恒 BUSY 最终应返回 null（维持既有降级语义）');
  assert.ok(n <= 8, '重试必须有上限，实际调用次数: ' + n);
});
