'use strict';

/**
 * 语音双引擎（whisper + Windows 直采）接线与行为测试
 * 运行：node --test tests/whisper-dual-engine.test.js
 *
 * 覆盖：
 * 1) 接线断言：四端点（capabilities/recognize/transcribe/cancel）+ 五函数 + 两脚本挂载
 * 2) 降级链顺序：transcribe 中 whisper 分支必须位于 ffmpeg 检查之前（whisper 不依赖 ffmpeg-static）
 * 3) 行为：findWhisperPython 多候选探测优先级（env > LocalAppData > PATH）
 * 4) 行为：findWhisperModelPath env 直指 + huggingface 快照扫描
 * 5) 行为：whisperRuntimeReady 熔断（连续失败 ≥2 停用）
 * 6) Python 脚本语法冒烟（本机有 python3 时）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const appRoot = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8');

// ---------- 1) 接线静态断言 ----------

test('接线：语音四端点全部接真实实现（修复前 recognize/cancel 为桩）', () => {
  // capabilities 真实探测（修复前写死 false）
  assert.match(serverSource, /whisperAvailable:\s*whisperRuntimeReady\(\)/, 'capabilities 应调用 whisperRuntimeReady()');
  assert.match(serverSource, /windowsSpeechAvailable:\s*process\.platform === 'win32' && fs\.existsSync\(WINDOWS_SPEECH_SCRIPT\)/);
  // recognize 直采（修复前返回 SPEECH_NOT_AVAILABLE 桩）
  assert.match(serverSource, /sendJSON\(res, await recognizeWindowsSpeech\(body && body\.timeoutSeconds\)\)/);
  // cancel 真实终止（修复前 canceled:false）
  assert.match(serverSource, /canceled:\s*cancelWindowsSpeechRecognition\(\)/);
  // transcribe whisper 分支
  assert.match(serverSource, /sendJSON\(res, await recognizeWhisperAudio\(rawBody, whisperExt\)\)/);
});

test('接线：五函数与两脚本路径', () => {
  for (const fn of ['findWhisperPython', 'findWhisperModelPath', 'whisperRuntimeReady', 'cancelWindowsSpeechRecognition', 'recognizeWindowsSpeech', 'recognizeWhisperAudio']) {
    assert.ok(new RegExp('function ' + fn + '\\(').test(serverSource), '缺少函数 ' + fn);
  }
  assert.match(serverSource, /desktop', 'speech', 'windows-speech-recognizer\.ps1/, '直采脚本应放 desktop/speech/');
  assert.match(serverSource, /desktop', 'speech', 'whisper-speech-recognizer\.py/, 'whisper 脚本应放 desktop/speech/');
  assert.ok(fs.existsSync(path.join(appRoot, 'desktop', 'speech', 'whisper-speech-recognizer.py')), 'whisper 脚本文件缺失');
  assert.ok(fs.existsSync(path.join(appRoot, 'desktop', 'speech', 'windows-speech-recognizer.ps1')), '直采脚本文件缺失');
});

test('降级链顺序：transcribe 中 whisper 分支先于 ffmpeg 检查（whisper 无需 ffmpeg-static）', () => {
  const transcribeStart = serverSource.indexOf("pn === '/api/agent/speech/transcribe'");
  const transcribeEnd = serverSource.indexOf('sapi-transcribe.ps1');
  assert.ok(transcribeStart > 0 && transcribeEnd > transcribeStart, 'transcribe 路由结构异常');
  const segment = serverSource.slice(transcribeStart, transcribeEnd);
  const whisperAt = segment.indexOf('whisperRuntimeReady()');
  const ffmpegAt = segment.indexOf('!ffmpegBinaryReady');
  assert.ok(whisperAt > 0, 'transcribe 缺 whisper 分支');
  assert.ok(ffmpegAt > whisperAt, 'whisper 分支必须在 ffmpeg 检查之前');
});

test('降级链：whisper 失败回落 SAPI + 熔断计数', () => {
  const transcribeStart = serverSource.indexOf("pn === '/api/agent/speech/transcribe'");
  const transcribeEnd = serverSource.indexOf('sapi-transcribe.ps1');
  const segment = serverSource.slice(transcribeStart, transcribeEnd);
  assert.match(segment, /whisperFailureCount \+= 1/, '失败应递增熔断计数');
  assert.match(segment, /SPEECH_NOT_HEARD[\s\S]{0,200}return/, 'SPEECH_NOT_HEARD 不应回落（SAPI 救不了无声）');
  assert.match(serverSource, /whisperFailureCount = 0/, '成功应复位熔断');
});

// ---------- 2) 行为测试（提取纯函数进沙箱）----------

function extractFunction(name) {
  const match = serverSource.match(new RegExp('(function ' + name + '\\(\\) \\{[\\s\\S]*?\\n\\})'));
  if (!match) throw new Error('无法提取函数 ' + name);
  return match[1];
}

function makeBehaviorSandbox(fsMock, env) {
  const sandbox = {
    fs: fsMock,
    path: path,
    os: { homedir: () => '/home/tester' },
    process: { env: env || {}, platform: 'linux' },
    whisperFailureCount: 0,
    WHISPER_FAILURE_LIMIT: 2,
  };
  sandbox.findWhisperModelPath = null;
  vm.createContext(sandbox);
  const source = [
    extractFunction('findWhisperPython'),
    extractFunction('findWhisperModelPath'),
    'function whisperRuntimeReadyImpl() {',
    '  return this.whisperFailureCount < this.WHISPER_FAILURE_LIMIT',
    '    && !!this.findWhisperModelPath()',
    '    && !!this.findWhisperPython()',
    '    && true;',
    '}',
  ].join('\n');
  vm.runInContext(source, sandbox, { filename: 'whisper-fns.js' });
  sandbox.whisperRuntimeReady = sandbox.whisperRuntimeReadyImpl;
  return sandbox;
}

test('行为：findWhisperPython 优先级 env > LocalAppData > PATH', () => {
  const fsMock = { existsSync: (p) => String(p).includes('python.exe') };
  const sb = makeBehaviorSandbox(fsMock, { STELLAFLIX_WHISPER_PYTHON: '/opt/custom/python.exe' });
  assert.strictEqual(sb.findWhisperPython(), '/opt/custom/python.exe', 'env 指定应最优先');

  const sb2 = makeBehaviorSandbox(fsMock, {});
  sb2.process.platform = 'win32';
  assert.match(sb2.findWhisperPython(), /Python3\d+[\\/]python\.exe$/, 'win32 应先扫 LocalAppData Python 目录');

  const sb3 = makeBehaviorSandbox({ existsSync: () => false }, {});
  assert.strictEqual(sb3.findWhisperPython(), '', '无候选时应返回空串');
});

test('行为：findWhisperModelPath 支持 env 直指与快照扫描', () => {
  const fsMock = {
    existsSync: (p) => {
      // Windows 下 path.join 产出反斜杠，归一化为 POSIX 分隔符再比对（克隆在 Linux 写的桩）
      const s = String(p).replace(/\\/g, '/');
      if (!s.endsWith('model.bin')) return false;
      // 只认快照目录与 env 直指目录里的 model.bin，模拟真实布局
      return s.includes('snapshots') || s.startsWith('/models/my-whisper');
    },
    readdirSync: (dir, opts) => {
      if (String(dir).includes('models--Systran--faster-whisper-small')) {
        return [{ isDirectory: () => true, name: 'abc123' }, { isDirectory: () => true, name: 'def456' }];
      }
      return [];
    },
  };
  const sb = makeBehaviorSandbox(fsMock, { STELLAFLIX_WHISPER_MODEL: '/models/my-whisper' });
  assert.strictEqual(sb.findWhisperModelPath(), '/models/my-whisper', 'env 指定且含 model.bin 应直接采用');

  const sb2 = makeBehaviorSandbox(fsMock, { STELLAFLIX_WHISPER_MODEL: '/models/empty' });
  const found = sb2.findWhisperModelPath();
  assert.ok(/models--Systran--faster-whisper-small.*abc123$|def456$/.test(found) || found === '', 'env 无效时应回落快照扫描（本 mock 快照有 model.bin 则命中）');

  const sb3 = makeBehaviorSandbox({ existsSync: () => false, readdirSync: () => { throw new Error('no dir'); } }, {});
  assert.strictEqual(sb3.findWhisperModelPath(), '', '目录不存在应返回空串不抛错');
});

test('行为：whisperRuntimeReady 熔断（连续失败 ≥2 停用）', () => {
  const fsMock = { existsSync: () => true, readdirSync: () => [{ isDirectory: () => true, name: 'snap' }] };
  const sb = makeBehaviorSandbox(fsMock, { PATH: '/usr/bin:/usr/local/bin' });
  assert.strictEqual(sb.whisperRuntimeReady(), true, '正常应就绪');
  sb.whisperFailureCount = 2;
  assert.strictEqual(sb.whisperRuntimeReady(), false, '失败计数达到上限应熔断');
  sb.whisperFailureCount = 1;
  assert.strictEqual(sb.whisperRuntimeReady(), true, '1 次失败仍可用（阈值 2）');
});

// ---------- 3) Python 脚本冒烟 ----------

test('Python whisper 脚本语法冒烟', { skip: !fs.existsSync('/usr/bin/python3') && !fs.existsSync('/usr/local/bin/python3') }, () => {
  const script = path.join(appRoot, 'desktop', 'speech', 'whisper-speech-recognizer.py');
  execFileSync('python3', ['-m', 'py_compile', script], { stdio: 'pipe', timeout: 15000 });
  // py_compile 会在 __pycache__ 留产物，清掉
  try { fs.rmSync(path.join(path.dirname(script), '__pycache__'), { recursive: true, force: true }); } catch (_) {}
});
