'use strict';

/**
 * 聚合解析防重复守卫测试（14-custom-source-integration.js resolveOnlinePlaybackData）
 * AI 助手/委托路径会把已解析的 ticket URL 作为 officialResult 传入 preResolve 调用；
 * 此时不得再发起 24s 的 /api/custom-source/resolve-aggregate 重复解析。
 * 运行：node --test tests/custom-source-aggregate-preresolve-guard.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.join(__dirname, '..');
const csiPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-custom-source-integration.js');
const source = fs.readFileSync(csiPath, 'utf8');

function sliceBetween(startMarker, endMarker) {
  const s = source.indexOf(startMarker);
  assert.notStrictEqual(s, -1, 'start marker missing: ' + startMarker);
  const e = source.indexOf(endMarker, s);
  assert.notStrictEqual(e, -1, 'end marker missing: ' + endMarker);
  return source.slice(s, e);
}

const SEGMENT = sliceBetween('async function resolveOnlinePlaybackData', 'async function resolveViaBridge');

const PRE_RESOLVED_URL = 'http://127.0.0.1:3000/api/custom-source/audio?ticket=abc123';

function makeSandbox(extra) {
  const calls = { aggregateHttp: 0, bridge: 0 };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    JSON, Math, Date, String, Number, Array, Object, Boolean, Promise, setTimeout,
    calls,
    prefs: Object.assign({ enabled: true, mode: 'aggregate' }, (extra && extra.prefs) || {}),
    getBridge: () => ((extra && extra.bridgeMissing) ? null : { isSupported: true }),
    isOfficialResultUsable: (officialResult, mode) => {
      if (mode === 'custom-first') return false;
      return !!(officialResult && officialResult.url && !officialResult.trial && !officialResult.vipRequired);
    },
    resolveAggregateViaHttp: async () => {
      calls.aggregateHttp++;
      return { override: true, via: 'aggregate', data: { url: 'http://127.0.0.1:3000/api/custom-source/audio?ticket=fresh' } };
    },
    resolveViaBridge: async () => { calls.bridge++; return { override: false, reason: 'bridge-noop' }; },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SEGMENT, sandbox, { filename: 'csi-segment.js' });
  return sandbox;
}

const song = { name: 'Yellow', artist: 'Coldplay', id: 1 };

test('aggregate preResolve with an already-resolved url must not re-run the 24s aggregate http resolve', async () => {
  const sb = makeSandbox();
  const result = await sb.resolveOnlinePlaybackData(song, {
    mode: 'aggregate',
    preResolve: true,
    officialResult: { url: PRE_RESOLVED_URL, level: 'flac' },
  });
  assert.strictEqual(sb.calls.aggregateHttp, 0, 'duplicate aggregate http resolve re-stalls playback for 24s');
  assert.strictEqual(result.override, false);
  assert.strictEqual(result.reason, 'fallback-to-official');
});

test('aggregate preResolve without a usable url still runs the http aggregate resolve', async () => {
  const sb = makeSandbox();
  const result = await sb.resolveOnlinePlaybackData(song, { mode: 'aggregate', preResolve: true, officialResult: {} });
  assert.strictEqual(sb.calls.aggregateHttp, 1);
  assert.strictEqual(result.override, true);
});

test('aggregate preResolve does not short-circuit on a trial-only pre-resolved result', async () => {
  const sb = makeSandbox();
  await sb.resolveOnlinePlaybackData(song, {
    mode: 'aggregate',
    preResolve: true,
    officialResult: { url: PRE_RESOLVED_URL, trial: true },
  });
  assert.strictEqual(sb.calls.aggregateHttp, 1, 'trial url must not block a real aggregate resolve');
});

test('aggregate without preResolve keeps the existing fallback-to-official behavior', async () => {
  const sb = makeSandbox();
  const result = await sb.resolveOnlinePlaybackData(song, {
    officialResult: { url: PRE_RESOLVED_URL },
  });
  assert.strictEqual(sb.calls.aggregateHttp, 0);
  assert.strictEqual(result.reason, 'fallback-to-official');
});
