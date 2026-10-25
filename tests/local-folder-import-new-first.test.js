'use strict';

// 批4-C2：导入入口「新优先、旧兜底」逻辑测试。
// 从 05-upload-dragdrop.js 切出 importLocalMusicFolderViaEngine + triggerLocalFolderImport，
// 注入假 desktopWindow.chooseLocalMusicFolder / stellaMlibSeam.hydrateFolder / triggerUploadInput，验证分支。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '05-upload-dragdrop.js'), 'utf8');

function slice(startMarker, endMarker) {
  const s = SRC.indexOf(startMarker);
  assert.ok(s >= 0, '接缝缺失: ' + startMarker);
  const e = SRC.indexOf(endMarker, s);
  assert.ok(e > s, '接缝结尾缺失: ' + endMarker);
  return SRC.slice(s, e);
}
const CODE = slice('async function importLocalMusicFolderViaEngine()', 'function isLocalPlaybackSnapshot(');

function boot(opts) {
  const env = opts || {};
  const calls = { toasts: [], refreshes: 0, fallback: 0 };
  const context = {
    Array, Promise, String, Number, Object, Math, console: { warn: () => {}, log: () => {} },
    showToast: (m) => calls.toasts.push(m),
    refreshHomeDashboardLocalMusic: () => { calls.refreshes += 1; },
    safeShelfRebuild: () => {},
    triggerUploadInput: () => { calls.fallback += 1; },
    window: {
      desktopWindow: env.choose ? { isDesktop: true, chooseLocalMusicFolder: env.choose } : { isDesktop: true },
      stellaMlibSeam: env.seam ? { hydrateFolder: env.seam } : undefined,
    },
  };
  vm.runInNewContext(CODE + '\nthis.viaEngine = importLocalMusicFolderViaEngine; this.trigger = triggerLocalFolderImport;', context);
  context.calls = calls;
  return context;
}

test('新路径成功：choose→hydrate 有曲目 → ok:true + 刷新首页', async () => {
  const ctx = boot({
    choose: async () => ({ ok: true, folderPath: 'C:\\Music' }),
    seam: async (p) => ({ ok: true, count: 3, folderPath: p }),
  });
  const res = await ctx.viaEngine();
  assert.equal(res.ok, true);
  assert.equal(res.count, 3);
  assert.equal(ctx.calls.refreshes, 1, '应刷新首页');
  assert.ok(ctx.calls.toasts.some((t) => /导入 3 首/.test(t)));
});

test('用户取消：不回退旧路径', async () => {
  const ctx = boot({ choose: async () => ({ ok: false, canceled: true }), seam: async () => ({ ok: true, count: 0 }) });
  const res = await ctx.viaEngine();
  assert.equal(res.canceled, true);
  assert.equal(res.fallback, undefined, '取消不应标记 fallback');
});

test('引擎不可用（无 chooseLocalMusicFolder）→ fallback:true', async () => {
  const ctx = boot({});
  const res = await ctx.viaEngine();
  assert.equal(res.fallback, true);
  assert.equal(res.error, 'ENGINE_UNAVAILABLE');
});

test('水合 0 曲目 → fallback:true', async () => {
  const ctx = boot({ choose: async () => ({ ok: true, folderPath: 'C:\\Empty' }), seam: async () => ({ ok: true, count: 0 }) });
  const res = await ctx.viaEngine();
  assert.equal(res.fallback, true);
  assert.equal(res.error, 'ENGINE_EMPTY');
});

test('trigger：“旧兜底”——新路径失败时调旧 triggerUploadInput(folder)', async () => {
  const ctx = boot({ choose: async () => ({ ok: true, folderPath: 'C:\\Empty' }), seam: async () => ({ ok: true, count: 0 }) });
  await ctx.trigger();
  assert.equal(ctx.calls.fallback, 1, '失败应回退旧拖入');
});

test('trigger：新路径成功时不回退旧', async () => {
  const ctx = boot({ choose: async () => ({ ok: true, folderPath: 'C:\\Music' }), seam: async () => ({ ok: true, count: 2 }) });
  const res = await ctx.trigger();
  assert.equal(res.ok, true);
  assert.equal(ctx.calls.fallback, 0, '成功不应回退旧');
});
