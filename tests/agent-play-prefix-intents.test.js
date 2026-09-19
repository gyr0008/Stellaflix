'use strict';

// 「播看X」=影视专属前缀（无需书名号），「播听X」=音乐专属前缀。
// 前缀即裁决：两侧解析链必须互不吞并对方的指令。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC_PATH = path.join(__dirname, '..', 'public', 'js', 'music-agent-command.js');

function loadParsers() {
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  function extractFn(name) {
    const marker = '  function ' + name + '(';
    const start = src.indexOf(marker);
    assert.notEqual(start, -1, `${name} missing from music-agent-command.js`);
    const body = src.slice(start);
    const next = body.indexOf('\n  function ', 1);
    assert.notEqual(next, -1, `no function follows ${name}`);
    return body.slice(0, next);
  }
  const code = [
    'function videoPlayerIsActive(){return false;}',
    extractFn('cleanPart'),
    extractFn('parseMusicCommand'),
    extractFn('isVideoStrongIntent'),
    extractFn('parseVideoCommand'),
    extractFn('cnNumToInt'),
    extractFn('isMusicIntent'),
    '({ parseMusicCommand: parseMusicCommand, parseVideoCommand: parseVideoCommand, isVideoStrongIntent: isVideoStrongIntent, isMusicIntent: isMusicIntent })',
  ].join('\n');
  const context = { console, Date, Math, JSON, String, Number, Array, Object, Boolean };
  vm.createContext(context);
  return vm.runInContext(code, context);
}

test('播看X parses as a local video search-and-play without book-title marks', () => {
  const p = loadParsers();
  assert.equal(p.isVideoStrongIntent('播看The Fix'), true, '播看 must be a strong video intent');
  const parsed = p.parseVideoCommand('播看The Fix');
  assert.ok(parsed, '播看The Fix must parse locally without AI');
  assert.equal(parsed.action, 'search_and_play_movie');
  assert.equal(parsed.query, 'The Fix');
});

test('播看 strips a trailing year into the year field', () => {
  const p = loadParsers();
  const parsed = p.parseVideoCommand('播看奥本海默 2023');
  assert.ok(parsed);
  assert.equal(parsed.action, 'search_and_play_movie');
  assert.equal(parsed.query, '奥本海默');
  assert.equal(parsed.year, '2023');
});

test('播看《X》 still parses with book-title marks', () => {
  const p = loadParsers();
  const parsed = p.parseVideoCommand('播看《长月烬明》');
  assert.ok(parsed);
  assert.equal(parsed.action, 'search_and_play_movie');
  assert.equal(parsed.query, '长月烬明');
});

test('播听X parses as a local music search-and-play', () => {
  const p = loadParsers();
  assert.equal(p.isMusicIntent('播听暗恋'), true);
  const bare = p.parseMusicCommand('播听暗恋');
  assert.equal(bare.action, 'search_and_play_music');
  assert.equal(bare.query, '暗恋');
  const withArtist = p.parseMusicCommand('播听陶喆的暗恋');
  assert.equal(withArtist.action, 'search_and_play_music');
  assert.equal(withArtist.artist, '陶喆');
  assert.equal(withArtist.title, '暗恋');
});

test('播看 and 播听 never cross into the other chain', () => {
  const p = loadParsers();
  assert.equal(p.isMusicIntent('播看The Fix'), false, '播看 must not read as music');
  assert.equal(p.parseVideoCommand('播听暗恋'), null, '播听 must not read as video');
});
