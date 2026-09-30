'use strict';

/**
 * 小M面板「导入歌单」直接动作按钮测试
 * 运行：node --test tests/agent-playlist-import-chip.test.js
 *
 * 覆盖：
 * 1) examples 行含第三个按钮：data-agent-action="playlist-import"，文案「导入歌单」
 * 2) openPlaylistImportEntry() 抽出：先关小M面板再开导入弹窗（z 31990 > 31500，防遮挡）
 * 3) 聊天路径 openEntry 分支复用同一函数
 * 4) click handler 分支带 !busy 守卫
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'music-agent-command.js'), 'utf8');

test('examples 行含「导入歌单」直接动作按钮', () => {
  const start = src.indexOf('class="music-agent-examples"');
  assert.ok(start >= 0, 'examples row template must exist');
  const row = src.slice(start, src.indexOf("'</div>' +", start));
  assert.match(row, /data-agent-action="playlist-import"/, '按钮须带 playlist-import 动作标记');
  assert.match(row, /导入歌单/, '按钮文案为「导入歌单」');
  assert.match(row, /type="button"/, '按钮须 type=button，防表单提交');
});

test('openPlaylistImportEntry：关小M面板 → 延迟开导入弹窗，两路径共用', () => {
  const start = src.indexOf('function openPlaylistImportEntry');
  assert.ok(start >= 0, 'openPlaylistImportEntry 须存在');
  const body = src.slice(start, src.indexOf('\n  }', start));
  assert.match(body, /panel\.classList\.remove\('show'\)/, '必须先关闭小M面板（其 z-index 高于导入弹窗）');
  assert.match(body, /setAttribute\('aria-hidden', 'true'\)/, '关面板须同步 aria-hidden');
  assert.match(body, /window\.openPlatformPlaylistImport/, '须调用导入弹窗入口');
  assert.match(body, /pendingSharedPlaylistImport = false/, '须清理待导入链接状态');
  // 聊天路径复用
  const chat = src.slice(src.indexOf('async function importSharedPlaylistFromCommand'), src.indexOf('var parsed = tools.parse_shared_playlist_import_command'));
  assert.match(chat, /openPlaylistImportEntry\(\)/, 'openEntry 分支应复用共用函数');
  assert.doesNotMatch(chat, /panel\.classList\.remove/, '聊天分支不再内联关面板逻辑');
});

test('click handler 对动作按钮分支且有 busy 守卫', () => {
  const start = src.indexOf("closest('[data-agent-action=\"playlist-import\"]')");
  assert.ok(start >= 0, 'panel click handler 须识别动作按钮');
  const branch = src.slice(start, start + 200);
  assert.match(branch, /!busy/, 'busy 期间不得触发');
  assert.match(branch, /openPlaylistImportEntry\(\)/, '分支应调用共用入口');
});
