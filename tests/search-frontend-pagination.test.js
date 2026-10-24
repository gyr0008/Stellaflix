'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.resolve(__dirname, '..');
const searchPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '07-search.js');
const searchSource = fs.readFileSync(searchPath, 'utf8');

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(declaration, `missing ${name}()`);
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let regex = false;
  let regexClass = false;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && nextCharacter === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (regex) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '[') regexClass = true;
      else if (character === ']') regexClass = false;
      else if (character === '/' && !regexClass) regex = false;
      continue;
    }
    if (character === '/' && nextCharacter === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '/') {
      let previousIndex = index - 1;
      while (previousIndex >= bodyStart && /\s/.test(source[previousIndex])) previousIndex -= 1;
      const previous = source[previousIndex] || '';
      if (!previous || /[=(,:;!&|?{}\[]/.test(previous)) {
        regex = true;
        regexClass = false;
        continue;
      }
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.index, index + 1);
    }
  }
  throw new Error(`unterminated ${name}()`);
}

function functionBundle(names, prelude, expose) {
  return `${prelude || ''}\n${names.map((name) => namedFunctionSource(searchSource, name)).join('\n')}\n${expose || ''}`;
}

test('legacy search histories migrate into one list shared by every tab', () => {
  const values = new Map([
    ['stellaflix-search-history', JSON.stringify(['晴天', '晴天', '夜曲'])],
  ]);
  const sandbox = {
    searchMode: 'song',
    localStorage: {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
    },
  };
  vm.runInNewContext(functionBundle([
    'emptySearchHistoryState',
    'normalizeSearchHistoryItems',
    'readSearchHistoryState',
    'writeSearchHistoryState',
    'readSearchHistory',
    'writeSearchHistory',
    'rememberSearchQuery',
  ], `
    var SEARCH_HISTORY_STORE_KEY = 'stellaflix-search-history';
    var SEARCH_HISTORY_STORE_VERSION = 3;
    var SEARCH_HISTORY_MODES = ['song', 'netease', 'qq', 'kugou', 'qishui', 'spotify', 'podcast'];
  `, `
    this.readSearchHistory = readSearchHistory;
    this.writeSearchHistory = writeSearchHistory;
    this.rememberSearchQuery = rememberSearchQuery;
  `), sandbox);

  assert.deepEqual(Array.from(sandbox.readSearchHistory('song')), ['晴天', '夜曲']);
  assert.deepEqual(Array.from(sandbox.readSearchHistory('qq')), ['晴天', '夜曲']);
  sandbox.rememberSearchQuery('稻香', 'qq');
  let stored = JSON.parse(values.get('stellaflix-search-history'));
  assert.equal(stored.version, 3);
  assert.deepEqual(stored.items, ['稻香', '晴天', '夜曲']);
  assert.deepEqual(Array.from(sandbox.readSearchHistory('podcast')), stored.items);

  values.set('stellaflix-search-history', JSON.stringify({
    version: 2,
    modes: {
      song: ['晴天', '夜曲'],
      netease: ['海阔天空'],
      qq: ['夜曲', '稻香'],
      podcast: ['故事 FM'],
    },
  }));
  assert.deepEqual(Array.from(sandbox.readSearchHistory('spotify')), ['晴天', '夜曲', '海阔天空', '稻香', '故事 FM']);
  sandbox.rememberSearchQuery('一路向北', 'podcast');
  stored = JSON.parse(values.get('stellaflix-search-history'));
  assert.deepEqual(stored.items, ['一路向北', '晴天', '夜曲', '海阔天空', '稻香', '故事 FM']);

  sandbox.writeSearchHistory([], 'qq');
  assert.deepEqual(JSON.parse(values.get('stellaflix-search-history')).items, []);
  assert.deepEqual(Array.from(sandbox.readSearchHistory('song')), []);
});

test('history rendering and replay keep the currently selected tab', () => {
  const renderSource = namedFunctionSource(searchSource, 'renderSearchHistory');
  const replaySource = namedFunctionSource(searchSource, 'runSearchHistory');
  const modeSource = namedFunctionSource(searchSource, 'setSearchMode');
  const podcastSource = namedFunctionSource(searchSource, 'doPodcastSearch');

  assert.doesNotMatch(renderSource, /isMusicSearchMode/);
  assert.doesNotMatch(renderSource, /data-history-mode/);
  assert.doesNotMatch(replaySource, /searchMode\s*=/);
  assert.match(modeSource, /else if \(!renderSearchHistory\(\)\) loadPodcastHot\(\)/);
  assert.match(podcastSource, /rememberSearchQuery\(q\)/);
});

test('T15: 官方五平台 fan-out 死代码簇必须已整删', () => {
  for (const dead of ['MUSIC_SEARCH_PROVIDER_ORDER', 'searchProviderStatus', 'searchProviderIsLoggedIn',
    'searchProviderCanSearch', 'searchModeProvider', 'activeSearchProvidersForMode',
    'searchProviderLoginNotice', 'searchProviderUrl', 'mergeSongSearchResults',
    'searchProviderPagesHaveMore', 'searchIntentPrefersQQ', 'LX_SEARCH_SOURCE_ORDER']) {
    assert.doesNotMatch(searchSource, new RegExp(dead), `T15：07-search.js 不得再残留 ${dead}`);
  }
  const fallbackSource = fs.readFileSync(
    path.join(appRoot, 'public', 'js', 'modules', '05-playback', '11-provider-fallback.js'), 'utf8');
  assert.doesNotMatch(fallbackSource, /SOURCE_FALLBACK_SEARCH_TIMEOUT_MS/,
    'T15：11-provider-fallback 不得再残留 SOURCE_FALLBACK_SEARCH_TIMEOUT_MS');
});

test('ranking favors exact originals while preserving explicitly requested versions', () => {
  const names = [
    'simpleSearchNorm',
    'searchQueryTokens',
    'searchVersionSignature',
    'searchTokenCoverage',
    'searchMentionsKnownArtist',
    'searchLooksLikeDerivative',
    'sourceSwitchArtistParts',
    'searchPopularityScore',
    'searchCanonicalSongKey',
    'scoreSongSearchResult',
  ];
  const sandbox = {};
  vm.runInNewContext(functionBundle(names, '', `
    this.score = scoreSongSearchResult;
    this.key = searchCanonicalSongKey;
  `), sandbox);

  const original = { name: '晴天', artist: '周杰伦', album: '叶惠美', popularity: 80 };
  const live = { name: '晴天 (Live)', artist: '周杰伦', album: '演唱会', popularity: 95 };
  const cover = { name: '晴天（翻唱）', artist: '其他歌手', album: '翻唱集', popularity: 100 };
  const unrelated = { name: '雨天', artist: '其他歌手', album: '合集', popularity: 100 };
  assert.ok(sandbox.score(original, '晴天 周杰伦', 0) > sandbox.score(cover, '晴天 周杰伦', 0));
  assert.ok(sandbox.score(original, '晴天', 0) > sandbox.score(unrelated, '晴天', 0));
  assert.ok(sandbox.score(live, '晴天 live', 0) > sandbox.score(original, '晴天 live', 0));
  assert.notEqual(sandbox.key(original), sandbox.key(live), 'studio and live editions must not collapse');
});

test('search pagination is lx-aggregate only and ignores stale sessions', () => {
  // T15（拆除批）：provider offset 分页（逐源 URL 构造 + 五路并池）随官方 fan-out 整删，
  // 原 vm 单测删除；previousPages 形参一并摘除（T11 起被忽略的死参数）。
  assert.doesNotMatch(searchSource, /previousPages/, 'fetchMusicSearchResults 不得再收 previousPages');
  assert.match(searchSource, /fetchMusicSearchResults\(q, mode\)/);
  assert.match(searchSource, /\/api\/lx-source\/search/);
  assert.match(searchSource, /hasMore:\s*false/);
  assert.match(searchSource, /new IntersectionObserver/);
  assert.match(searchSource, /MUSIC_SEARCH_INITIAL_VISIBLE\s*=\s*18/);
  assert.match(searchSource, /loadNextMusicSearchPage\(expectedKey\)/);
  assert.match(searchSource, /requestSeq\s*!==\s*searchRequestSeq/);
  assert.match(searchSource, /searchMode\s*!==\s*mode/);

  const scoreSource = namedFunctionSource(searchSource, 'scoreSongSearchResult');
  assert.doesNotMatch(scoreSource, /provider\s*===|searchIntentPrefersQQ/,
    'ordinary relevance must not contain platform-specific score boosts');
});
