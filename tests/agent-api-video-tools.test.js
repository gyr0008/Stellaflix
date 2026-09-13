/*
 * tests/agent-api-video-tools.test.js
 * 验证 P2：影视 Tool Schema 已注册且参数清洗可用。
 * 运行：node tests/agent-api-video-tools.test.js
 */
const assert = require('assert');
const api = require('../agent-api.js');

const t = api._test;
assert(t, 'agent-api 应导出 _test');

// Schema 注册
const names = t.MUSIC_TOOL_SCHEMAS.map((s) => s.name);
const required = [
  'search_and_play_movie',
  'search_movies',
  'play_movie_candidate',
  'control_video_playback',
  'seek_video',
  'select_episode',
  'toggle_video_fullscreen',
  'get_video_context',
  'open_video_interface'
];
for (const name of required) {
  assert(names.includes(name), 'MUSIC_TOOL_SCHEMAS 缺少 ' + name);
  assert(t.ALLOWED_TOOL_NAMES.has(name), 'ALLOWED_TOOL_NAMES 缺少 ' + name);
}

// System prompt 覆盖影视
assert(/search_and_play_movie/.test(t.SYSTEM_PROMPT), 'SYSTEM_PROMPT 应提及 search_and_play_movie');
assert(/电影解说|片源/.test(t.SYSTEM_PROMPT), 'SYSTEM_PROMPT 应约束片源/解说');

// parseToolArguments
assert.deepStrictEqual(
  t.parseToolArguments({ query: '你的名字', year: '2016' }, 'search_and_play_movie'),
  { query: '你的名字', year: '2016' }
);
assert.deepStrictEqual(
  t.parseToolArguments({ action: 'pause' }, 'control_video_playback'),
  { action: 'pause' }
);
assert.deepStrictEqual(
  t.parseToolArguments({ seconds: 720 }, 'seek_video'),
  { seconds: 720 }
);
assert.deepStrictEqual(
  t.parseToolArguments({ time: '01:20:00' }, 'seek_video'),
  { time: '01:20:00' }
);
assert.deepStrictEqual(
  t.parseToolArguments({ direction: 'next' }, 'select_episode'),
  { direction: 'next' }
);
assert.deepStrictEqual(
  t.parseToolArguments({ target: 'sources' }, 'open_video_interface'),
  { target: 'sources' }
);
assert.deepStrictEqual(t.parseToolArguments({}, 'toggle_video_fullscreen'), {});
assert.deepStrictEqual(
  t.parseToolArguments({ sourceId: 's1', vodId: '9', title: '盗梦空间' }, 'play_movie_candidate'),
  { sourceId: 's1', vodId: '9', title: '盗梦空间' }
);

// 非法值被剥掉
assert.deepStrictEqual(
  t.parseToolArguments({ action: 'explode' }, 'control_video_playback'),
  {}
);
assert.deepStrictEqual(
  t.parseToolArguments({ target: 'rm -rf' }, 'open_video_interface'),
  {}
);

// 命令层已接线
const fs = require('fs');
const path = require('path');
const cmd = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'music-agent-command.js'), 'utf8');
assert(/search_and_play_movie/.test(cmd), 'executeAgentToolCall 应分发 search_and_play_movie');
assert(/control_video_playback/.test(cmd), '应分发 control_video_playback');
assert(/play_movie_candidate/.test(cmd), '应分发 play_movie_candidate');

console.log('OK agent-api-video-tools: all assertions passed');
