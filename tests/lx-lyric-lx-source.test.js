'use strict';

/**
 * tests/lx-lyric-lx-source.test.js — 批 T15.5b（改道批）：歌词统一走 /api/lx-source/lyric
 *
 * 契约（T15.5a §6 + 本分支 server.js POST /api/lx-source/lyric）：
 *   POST body {source, musicInfo} → {ok:true, source, lyric, tlyric, rlyric, lxlyric}；
 *   失败 502 LX_SOURCE_LYRIC_FAILED。前端不得再消费官方歌词路由
 *   （/api/lyric、/api/qq/lyric、/api/kugou/lyric、/api/qishui/lyric、/api/spotify/lyric），
 *   网易云翻译兜底链（/api/search + /api/lyric）随上游一并删除；
 *   无 lx 源映射（汽水/Spotify/本地/播客/lx-custom-source）不发网络，优雅降级「暂无歌词」标题兜底。
 * 手法：vm 顶层加载 00-lyrics-fetch-parse.js（函数全部落全局），apiJson 走沙箱记录桩。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const P_LYRIC = 'public/js/modules/06-lyrics/00-lyrics-fetch-parse.js';
const lyricSource = fs.readFileSync(path.join(ROOT, P_LYRIC), 'utf8');

function makeEl() {
  return {
    textContent: '',
    innerHTML: '',
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  };
}

function makeSandbox(overrides) {
  const calls = { api: [], lyricStates: [], preferred: [] };
  const sandbox = Object.assign({
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Promise, RegExp, Error,
    setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, AbortController,
    calls,
    trackSwitchToken: 1,
    playQueue: [],
    currentIdx: 0,
    audio: null,
    document: {
      getElementById: () => makeEl(),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    // 生产环境里 05-playback 束的函数经 Annex B 泄漏为全局；此处复刻语义（07-search.js:434-448）。
    songProviderKey: (song) => {
      if (song && (song.provider === 'qq' || song.source === 'qq')) return 'qq';
      if (song && (song.provider === 'kugou' || song.source === 'kugou' || song.hash || song.audioHash)) return 'kugou';
      if (song && (song.provider === 'qishui' || song.source === 'qishui')) return 'qishui';
      if (song && (song.provider === 'spotify' || song.source === 'spotify' || song.spotifyId)) return 'spotify';
      return 'netease';
    },
    playbackDurationFromSong: () => 206,
    normalizeStageLyricText: (v) => String(v == null ? '' : v).trim(),
    // 同上：cloneLyricLine(s) 定义于 05-playback/06-track-detail-lyrics-actions.js:795-804，
    // attachLyricTranslations/parseLyricResponseToOriginalState 依赖它，沙箱按生产语义复刻。
    cloneLyricLine: (line) => (line && typeof line === 'object'
      ? Object.assign({}, line, Array.isArray(line.words) ? { words: line.words.map((w) => Object.assign({}, w)) } : {})
      : line),
    cloneLyricLines: (lines) => (Array.isArray(lines) ? lines : []).map((line) => sandbox.cloneLyricLine(line)),
    setOriginalLyricsState: (lines, karaoke, timing, trans, transSource) => {
      calls.lyricStates.push({ lines, karaoke, timing, trans, transSource });
    },
    applyPreferredLyricsForCurrent: () => { calls.preferred.push(1); },
    updateCustomLyricControls: () => {},
    currentLyricSong: () => sandbox.__song || null,
    originalLyricsState: null,
    lyricsLines: [],
    lyricsHasNativeKaraoke: false,
    lyricsTimingSource: 'pending',
    lyricsTranslationLines: [],
    lyricsTranslationSource: 'none',
    startupAutoplayPreference: false,
    restoredLastPlaybackSnapshot: false,
    pendingPlaybackResumeAt: 0,
    apiJson: async (url, opts) => {
      calls.api.push({ url, opts });
      if (sandbox.__apiImpl) return sandbox.__apiImpl(url, opts);
      return { ok: true, source: 'tx', lyric: '[00:01.00]第一行\n[00:05.00]第二行', tlyric: '', rlyric: '', lxlyric: '' };
    },
  }, overrides || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(lyricSource, sandbox, { filename: P_LYRIC });
  return sandbox;
}

function parseBody(sb, i) {
  const call = sb.calls.api[i || 0];
  assert.ok(call, 'apiJson 必须被调用');
  return JSON.parse(call.opts.body);
}

test('T15.5b歌词①：QQ 歌走 POST /api/lx-source/lyric（source=tx + musicInfo.mid），不再有官方 /api/qq/lyric', async () => {
  const sb = makeSandbox();
  await sb.fetchLyric({ source: 'qq', provider: 'qq', name: '夜空中最亮的星', artist: 'xyz', mid: 'ABC123', id: '004' }, 1, 0);
  assert.equal(sb.calls.api.length, 1, '只应命中一次歌词请求: ' + JSON.stringify(sb.calls.api.map((c) => c.url)));
  assert.equal(sb.calls.api[0].url, '/api/lx-source/lyric');
  assert.equal(sb.calls.api[0].opts.method, 'POST');
  const body = parseBody(sb);
  assert.equal(body.source, 'tx');
  assert.equal(body.musicInfo.mid, 'ABC123');
  assert.equal(body.musicInfo.name, '夜空中最亮的星');
  assert.equal(body.musicInfo.singer, 'xyz');
  const state = sb.calls.lyricStates[sb.calls.lyricStates.length - 1];
  assert.ok(state && state.lines && state.lines.length >= 2, '响应必须被映射为歌词行');
  assert.equal(state.lines[0].text, '第一行');
});

test('T15.5b歌词②：酷狗→kg（hash 透传）、网易云→wy、lx 源名直通（kw/mg）', async () => {
  const sb = makeSandbox();
  await sb.fetchLyric({ source: 'kugou', name: '海阔天空', artist: 'Beyond', hash: 'H123456' }, 1, 0);
  assert.equal(parseBody(sb).source, 'kg');
  assert.equal(parseBody(sb).musicInfo.hash, 'H123456');
  const sb2 = makeSandbox();
  await sb2.fetchLyric({ source: 'netease', name: 'n', artist: 'a', id: 123 }, 1, 0);
  assert.equal(parseBody(sb2).source, 'wy');
  const sb3 = makeSandbox();
  await sb3.fetchLyric({ source: 'kw', name: 'n', artist: 'a', songmid: 'k1' }, 1, 0);
  assert.equal(parseBody(sb3).source, 'kw');
  const sb4 = makeSandbox();
  await sb4.fetchLyric({ source: 'mg', name: 'n', artist: 'a', id: 'm1' }, 1, 0);
  assert.equal(parseBody(sb4).source, 'mg');
  [sb, sb2, sb3, sb4].forEach((s) => {
    assert.equal(s.calls.api[0].url, '/api/lx-source/lyric');
  });
});

test('T15.5b歌词③：汽水/Spotify/本地/播客无 lx 映射——零网络、优雅降级标题兜底', async () => {
  const songs = [
    { source: 'qishui', provider: 'qishui', name: '汽水曲', artist: 'a', id: 'q1' },
    { source: 'spotify', provider: 'spotify', name: 'SP曲', artist: 'a', spotifyId: 's1' },
    { type: 'local', source: 'local', name: '本地曲', artist: 'a', localUrl: 'file:///x.mp3' },
    { type: 'podcast', source: 'netease', name: '播客', artist: 'a', id: 5 },
  ];
  for (const song of songs) {
    const sb = makeSandbox();
    await sb.fetchLyric(song, 1, 0);
    assert.equal(sb.calls.api.length, 0, '不得发起歌词请求（无 lx 源映射）: ' + song.name + ' -> ' + JSON.stringify(sb.calls.api.map((c) => c.url)));
    const state = sb.calls.lyricStates[sb.calls.lyricStates.length - 1];
    assert.ok(state, '必须落一个降级状态: ' + song.name);
    assert.equal(state.timing, 'fallback');
    assert.ok(state.lines.length === 1 && state.lines[0].fallback === true, '标题兜底行（暂无歌词形态）: ' + song.name);
  }
});

test('T15.5b歌词④：lxlyric 逐字歌词解析（上游 parseLxWordLyricText 形态，source=lx-karaoke）', async () => {
  const sb = makeSandbox({
    __apiImpl: async () => ({
      ok: true,
      source: 'tx',
      lyric: '[00:01.00]第一行',
      tlyric: '',
      lxlyric: '[00:02.00]<200,400>He[00:02.60]<0,600>llo\n[00:04.00]<200,500>世[00:04.50]<0,500>界',
    }),
  });
  await sb.fetchLyric({ source: 'tx', name: 'n', singer: 'a', mid: 'm' }, 1, 0);
  const state = sb.calls.lyricStates[sb.calls.lyricStates.length - 1];
  const karaoke = (state.lines || []).filter((line) => line.words && line.words.length);
  assert.ok(karaoke.length >= 2, 'lxlyric 逐字行必须生效: ' + JSON.stringify(state.lines));
  assert.equal(karaoke[0].text, 'Hello');
  assert.equal(karaoke[0].words[0].text, 'He');
  assert.ok(karaoke[0].words[0].t >= 2.1 && karaoke[0].words[0].t <= 2.6, '词首字相对时间=行时+start/1000: ' + karaoke[0].words[0].t);
  assert.equal(karaoke[0].words[0].source || 'lx-karaoke', 'lx-karaoke');
});

test('T15.5b歌词⑤：队列预取/缓存刷新同样改道 lx，且不再有网易云翻译兜底链', () => {
  const text = lyricSource;
  assert.ok(!/\/api\/qq\/lyric/.test(text), '官方 QQ 歌词路由不得回潮');
  assert.ok(!/\/api\/kugou\/lyric/.test(text), '官方酷狗歌词路由不得回潮');
  assert.ok(!/\/api\/qishui\/lyric/.test(text), '官方汽水歌词路由不得回潮');
  assert.ok(!/\/api\/spotify\/lyric/.test(text), '官方 Spotify 歌词路由不得回潮');
  assert.ok(!/'\/api\/lyric\?id='/.test(text), '官方网易云歌词路由不得回潮');
  assert.ok(!/\/api\/search\?keywords=/.test(text), '翻译兜底链（官方搜索）必须随上游删除');
  assert.ok(!/scheduleNeteaseLyricTranslationFallback/.test(text), '网易云翻译兜底调度链必须退役');
  assert.ok(!/findNeteaseLyricFallbackCandidate/.test(text), '网易云兜底候选查找必须退役');
});

test('T15.5b歌词⑥：裸 id 调用（旧 /api/lyric?id= 语义）映射 wy 且带 id', async () => {
  const sb = makeSandbox();
  await sb.fetchLyric(95237, 1, 0);
  assert.equal(sb.calls.api.length, 1);
  assert.equal(sb.calls.api[0].url, '/api/lx-source/lyric');
  assert.equal(parseBody(sb).source, 'wy');
  assert.equal(String(parseBody(sb).musicInfo.id), '95237');
});
