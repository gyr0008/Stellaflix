'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WallpaperEngineRuntime } = require('../desktop/wallpaper-engine-runtime');

// Plain-Node instantiation works thanks to the B4 sentinel guard in
// defaultDesktopCapturer() (pure Node must never require('electron')).
function makeRuntime(tempRoot, extra = {}) {
  return new WallpaperEngineRuntime({
    nativeTempPath: tempRoot,
    desktopCapturer: null,
    useDesktopShellBroker: false,
    nativeSleep: async () => {},
    ...extra,
  });
}

function withTempRoot(fn) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-we-v211-port-'));
  const cleanup = () => fs.rmSync(tempRoot, { recursive: true, force: true });
  return Promise.resolve()
    .then(() => fn(tempRoot))
    .finally(cleanup);
}

test('_powerShellScriptArgs keeps short scripts on -EncodedCommand', async () => {
  await withTempRoot((tempRoot) => {
    const runtime = makeRuntime(tempRoot);
    const short = Buffer.from('Write-Output 1', 'utf16le').toString('base64');
    const args = runtime._powerShellScriptArgs(short, 'window-control');
    assert.deepEqual(args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', short]);
  });
});

test('_powerShellScriptArgs spills oversized scripts to a temp .ps1 with -File', async () => {
  await withTempRoot((tempRoot) => {
    const runtime = makeRuntime(tempRoot);
    // 32672 chars + 96 exceeds the 32767-char Windows cmdline limit.
    const long = 'A'.repeat(32672);
    const args = runtime._powerShellScriptArgs(long, 'window-control');
    assert.deepEqual(args.slice(0, 3), ['-NoLogo', '-NoProfile', '-NonInteractive']);
    assert.equal(args[3], '-ExecutionPolicy');
    assert.equal(args[4], 'Bypass');
    assert.equal(args[5], '-File');
    assert.equal(args.length, 7);
    const scriptFile = args[6];
    assert.ok(scriptFile.startsWith(path.join(tempRoot, 'wallpaper-engine-window-control-')));
    assert.ok(scriptFile.endsWith('.ps1'));
    assert.equal(fs.existsSync(scriptFile), true);
    const expected = `\uFEFF${Buffer.from(long, 'base64').toString('utf16le')}`;
    assert.equal(fs.readFileSync(scriptFile, 'utf8'), expected);
    // Second call reuses the existing file (same digest) without throwing.
    const again = runtime._powerShellScriptArgs(long, 'window-control');
    assert.deepEqual(again, args);
  });
});

function makeStopFixture(tempRoot) {
  const runtime = makeRuntime(tempRoot);
  const sessionId = 'a'.repeat(24);
  const session = {
    id: 'scene-id',
    sessionId,
    locationTitle: `Stellaflix Wallpaper ${sessionId}`,
    sourceId: '',
    executable: 'C:\\SteamLibrary\\wallpaper64.exe',
    launched: true,
    initialOpenIssued: true,
    initialOpenPromise: null,
    windowEmbedding: null,
    windowParking: null,
    dwmSurfaceReady: false,
    dwmSurfaceProcess: null,
    dwmSurfaceActive: false,
    pointerRelayProcess: null,
    stopping: false,
  };
  runtime.active = session;
  const calls = [];
  runtime._closeSession = async () => false;
  runtime._stopSessionPointerRelay = () => calls.push('stop-pointer-relay');
  runtime._stopSessionDwmSurface = () => calls.push('stop-dwm-surface');
  runtime._waitForSessionDwmSurfaceStop = async () => { calls.push('wait-dwm-stop'); };
  runtime._clearSessionMuteReassertions = () => calls.push('clear-mute');
  runtime._scheduleSessionMuteReassertions = () => calls.push('schedule-mute');
  runtime._scheduleSessionDwmSurfaceRetry = () => calls.push('schedule-dwm-retry');
  return { runtime, session, calls };
}

test('stop({forceHelperCleanup:true}) tears helpers down even when the WE close fails', async () => {
  await withTempRoot((tempRoot) => {
    const { runtime, session, calls } = makeStopFixture(tempRoot);
    return runtime.stop(session.sessionId, { forceHelperCleanup: true }).then((result) => {
      assert.deepEqual(result, {
        ok: true,
        stopped: false,
        active: true,
        sessionId: session.sessionId,
        reason: 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED',
      });
      assert.deepEqual(calls, ['stop-pointer-relay', 'stop-dwm-surface', 'wait-dwm-stop', 'clear-mute']);
      // Helper was removed, so the session must not stay marked as stopping.
      assert.equal(session.stopping, false);
      assert.equal(runtime.active, session);
    });
  });
});

test('plain stop() keeps the pre-port failure behavior (no forced teardown)', async () => {
  await withTempRoot((tempRoot) => {
    const { runtime, session, calls } = makeStopFixture(tempRoot);
    return runtime.stop(session.sessionId).then((result) => {
      assert.equal(result.ok, true);
      assert.equal(result.stopped, false);
      assert.equal(result.reason, 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED');
      assert.equal(calls.includes('stop-pointer-relay'), false);
      assert.equal(calls.includes('stop-dwm-surface'), false);
      assert.equal(calls.includes('wait-dwm-stop'), false);
      assert.equal(calls.includes('clear-mute'), false);
      assert.deepEqual(calls, ['schedule-mute']);
      assert.equal(session.stopping, false);
    });
  });
});

test('stop() accepts an options object as the first argument (back-compat overload)', async () => {
  await withTempRoot((tempRoot) => {
    const fixture = makeStopFixture(tempRoot);
    const mismatch = makeStopFixture(tempRoot);
    return Promise.all([
      mismatch.runtime.stop({ sessionId: 'f'.repeat(24) }),
      fixture.runtime.stop({ sessionId: fixture.session.sessionId, forceHelperCleanup: true }),
    ]).then(([missed, forced]) => {
      assert.deepEqual(missed, { ok: true, stopped: false, reason: 'WALLPAPER_ENGINE_SESSION_MISMATCH' });
      assert.equal(forced.stopped, false);
      assert.deepEqual(fixture.calls, ['stop-pointer-relay', 'stop-dwm-surface', 'wait-dwm-stop', 'clear-mute']);
    });
  });
});

test('nudgeDwmSurfaceFollow exists and is a fire-and-forget stdin write', async () => {
  await withTempRoot((tempRoot) => {
    const runtime = makeRuntime(tempRoot);
    assert.equal(typeof runtime.nudgeDwmSurfaceFollow, 'function');
    // No active session: silent no-op, never throws.
    assert.equal(runtime.nudgeDwmSurfaceFollow(), false);
    assert.equal(runtime.nudgeDwmSurfaceFollow('nonexistent'), false);

    const sessionId = 'b'.repeat(24);
    const writes = [];
    runtime.active = {
      sessionId,
      dwmSurfaceReady: true,
      dwmSurfaceProcess: {
        stdin: {
          destroyed: false,
          writableEnded: false,
          write(chunk, encoding) { writes.push([chunk, encoding]); return true; },
        },
      },
    };
    assert.equal(runtime.nudgeDwmSurfaceFollow('c'.repeat(24)), false);
    assert.equal(writes.length, 0);
    assert.equal(runtime.nudgeDwmSurfaceFollow(sessionId), true);
    assert.deepEqual(writes, [['F\n', 'ascii']]);
  });
});

test('_closeStaleWallpaperWindows reaps only orphan Stellaflix WE windows', async () => {
  await withTempRoot((tempRoot) => {
    const orphanA = 'Stellaflix Wallpaper ' + '1234567890abcdef12345678';
    const orphanB = 'Stellaflix Wallpaper ' + 'deadbeefdeadbeefdeadbeef';
    const keepTitle = 'Stellaflix Wallpaper ' + 'aabbccaabbccaabbccaabbcc';
    // Same shape but the other product identity must never be reaped.
    const foreign = 'Mineradio Wallpaper ' + 'ffffffffffffffffffffffff';
    const sources = [
      { id: 'window:1:1', name: orphanA },
      { id: 'window:2:2', name: keepTitle },
      { id: 'window:3:3', name: foreign },
      { id: 'window:4:4', name: 'Some Other Window' },
      { id: 'window:5:5', name: orphanA }, // duplicate: closed once
      { id: 'window:6:6', name: orphanB },
    ];
    const runtime = makeRuntime(tempRoot, {
      desktopCapturer: {
        getSources: async (options) => {
          assert.deepEqual(options.types, ['window']);
          return sources;
        },
      },
    });
    const controlCalls = [];
    runtime._spawnControl = async (executable, args) => { controlCalls.push({ executable, args }); };
    const executable = 'C:\\SteamLibrary\\wallpaper64.exe';
    return runtime._closeStaleWallpaperWindows(executable, keepTitle).then((closed) => {
      assert.equal(closed, 2);
      assert.deepEqual(controlCalls, [
        { executable, args: ['-control', 'closeWallpaper', '-location', orphanA] },
        { executable, args: ['-control', 'closeWallpaper', '-location', orphanB] },
      ]);
      const titles = controlCalls.map((call) => call.args[3]);
      assert.equal(titles.includes(keepTitle), false);
      assert.equal(titles.includes(foreign), false);
    });
  });
});

test('_closeStaleWallpaperWindows is wired as the close-stale-windows start stage', async () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../desktop/wallpaper-engine-runtime.js'),
    'utf8'
  );
  assert.match(source, /startStage = 'close-stale-windows';/);
  assert.match(source, /await this\._closeStaleWallpaperWindows\(session\.executable, session\.locationTitle\)/);
});

test('source pins: v2.1.1 port landed with Stellaflix identity', async () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../desktop/wallpaper-engine-runtime.js'),
    'utf8'
  );
  // Item 1: engine-ready cache 60s.
  assert.match(source, /const ENGINE_READY_CACHE_MS = 60000;/);
  // Item 2: taskbar residue fix on the real WE Scene window.
  assert.match(source, /if \(sourceWindow != IntPtr\.Zero\) taskbar\.DeleteTab\(sourceWindow\);/);
  // Item 3: reflink staging copy with plain-copy fallback.
  assert.match(source, /copyFile\(stagedScenePackage, stagedPackageFile, fs\.constants\.COPYFILE_FICLONE\)/);
  // Item 4: ENAMETOOLONG fix — helper plus both use-sites.
  assert.equal((source.match(/_powerShellScriptArgs\(/g) || []).length, 3);
  assert.match(source, /this\._powerShellScriptArgs\(nativeWindowControlScript\(\), 'window-control'\)/);
  assert.match(source, /this\._powerShellScriptArgs\(controlBrokerScript\(\), 'control-broker'\)/);
  // Item 5: orphan reaping regex keyed on the Stellaflix locationTitle shape.
  assert.match(source, /const STALE_WALLPAPER_WINDOW_TITLE = \/[\^]Stellaflix Wallpaper \[a-f0-9\]\{24\}\$\/i;/);
  assert.match(source, /async _closeStaleWallpaperWindows\(executable, keepTitle = ''\)/);
  // Item 6: black-flash fixes.
  assert.match(source, /SetWindowPos\(hWnd, hostHWnd, 0, 0, 0, 0,\s*\n\s*SWP_NOSIZE \| SWP_NOMOVE \| SWP_NOACTIVATE_EMBED \| SWP_NOOWNERZORDER_EMBED\);/);
  assert.match(source, /Location = new Point\(-32000, -32000\);/);
  assert.match(source, /Size = new Size\(1, 1\);/);
  // Item 7: drag-follow suite.
  assert.match(source, /const uint SWP_ASYNCWINDOWPOS = 0x4000;/);
  assert.match(source, /System\.Threading\.Timer dragFollowTimer;/);
  assert.match(source, /const int IDLE_FOLLOW_INTERVAL_MS = 60;/);
  assert.match(source, /const int DRAG_FOLLOW_RECENT_MS = 200;/);
  assert.match(source, /void SafeFollow\(\)/);
  assert.match(source, /followTimer\.Tick \+= delegate \{ SafeFollow\(\); \};/);
  assert.match(source, /dragFollowTimer = new System\.Threading\.Timer\(delegate \{[\s\S]*?\}, null, 8, 4\);/);
  assert.match(source, /if \(String\.Equals\(command, "F", StringComparison\.Ordinal\)\)/);
  assert.match(source, /dragFollowTimer != null\) dragFollowTimer\.Dispose\(\)/);
  // Corner region now applied before the move; all four FollowHost SetWindowPos
  // calls carry the async flag.
  assert.equal((source.match(/SWP_NOACTIVATE \| SWP_SHOWWINDOW \| SWP_ASYNCWINDOWPOS/g) || []).length, 4);
  assert.match(source, /IntPtr surfaceInsertAfter = [^\n]*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*bool hostPositionChanged = hostRect\.Left != lastHostLeft \|\| hostRect\.Top != lastHostTop;/);
  assert.match(source, /ApplyCornerRegion\(sourceWindow, width, height, radius\);\s*\n\s*lastWidth = width;\s*\n\s*lastHeight = height;\s*\n\s*lastRadius = radius;\s*\n\s*\}\s*\n\s*if \(hostPositionChanged \|\| hostSizeChanged\)/);
  assert.match(source, /lastMoveTickAt = Environment\.TickCount;/);
  // Item 8: stop() upgrade.
  assert.match(source, /async stop\(expectedSessionId = '', options = \{\}\)/);
  assert.match(source, /const forceHelperCleanup = options\.forceHelperCleanup === true;/);
  // C-list: identity contract preserved — no Mineradio spellings leaked in.
  assert.equal(/Mineradio/.test(source), false);
  assert.equal(/MINERADIO/.test(source), false);
  // B4 sentinel guard survives the port.
  assert.match(source, /if \(!process\.versions \|\| !process\.versions\.electron\) return null;/);
  // Item 9 (diag logging) is explicitly out of scope for this batch.
  assert.equal(/weDiag/.test(source), false);
  assert.equal(/noteWeDiagEvent/.test(source), false);
});
