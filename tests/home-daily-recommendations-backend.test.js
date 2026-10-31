'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');

function namedFunctionSource(text, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  if (!declaration) return '';
  const bodyStart = text.indexOf('{', declaration.index + declaration[0].length);
  if (bodyStart < 0) return '';
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(declaration.index, index + 1);
    }
  }
  return '';
}

// 批 T16d：登录态退役后首页发现只回 starter 空壳，日推 mapper 与平台请求一并清零。
test('discover home 登录态退役后只回 starter 空壳，不再做日推映射或平台请求', () => {
  const discoverSource = namedFunctionSource(source, 'handleDiscoverHome');
  assert.ok(discoverSource, 'expected handleDiscoverHome()');
  assert.match(discoverSource, /loggedIn:\s*false/);
  assert.match(discoverSource, /dailySongs:\s*\[\]/);
  assert.match(discoverSource, /mode:\s*'starter'/);
  assert.doesNotMatch(discoverSource, /mapDailyRecommendationSongs|daily_songs|recommend\/songs|cookie/i);
  assert.equal(namedFunctionSource(source, 'mapDailyRecommendationSongs'), '', '日推 mapper 应随登录态退役删除');
});

test('discover home does not request or return recommended podcasts', () => {
  const discoverSource = namedFunctionSource(source, 'handleDiscoverHome');
  assert.doesNotMatch(discoverSource, /\bdj_hot\s*\(/);
  // 批 T16c：播客整条下线——payload 连 podcasts 字段一并摘除（此前只钉「恒为空数组」）。
  assert.doesNotMatch(discoverSource, /podcasts/);
});
