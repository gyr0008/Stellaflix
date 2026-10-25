// tests/mlib-readlayer-copy.test.js —— Task 3 读层状态文案表（spec §5 诚实空态）
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..',
  'public', 'js', 'modules', '04-shelf', '07-mlib-readlayer.js'), 'utf8');

function loadWithReadlayer() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: '07-mlib-readlayer.js' });
  return sandbox.window.stellaMlibRead;
}

test('文案表逐字锁定 spec §5', () => {
  const read = loadWithReadlayer();
  assert.deepEqual(read.getStateCopy('albums', { status: 'engine-missing' }), {
    heading: '曲库引擎尚未就绪', hint: '导入歌单或本地音乐后这里会自动出现', action: null });
  assert.deepEqual(read.getStateCopy('albums', { status: 'empty' }), {
    heading: '曲库还是空的', hint: '从首页「导入」卡片开始', action: 'import' });
  assert.equal(read.getStateCopy('albums', { status: 'ok', cards: [] }).heading, '这个板块还没有内容');
  assert.equal(read.getStateCopy('albums', { status: 'error', message: '索引重建中' }).heading, '索引重建中');
  assert.equal(read.getStateCopy('albums', { status: 'error', message: '索引重建中' }).action, 'retry');
});

test('不可播提示', () => {
  assert.equal(loadWithReadlayer().unplayableHint(), '未匹配到可播来源');
});

test('engine-missing / empty 全字段锁定（含 hint 与 action）', () => {
  const read = loadWithReadlayer();
  assert.deepEqual(read.getStateCopy('artists', { status: 'engine-missing', cards: [] }), {
    heading: '曲库引擎尚未就绪', hint: '导入歌单或本地音乐后这里会自动出现', action: null });
  assert.deepEqual(read.getStateCopy('playlists', { status: 'empty', cards: [] }), {
    heading: '曲库还是空的', hint: '从首页「导入」卡片开始', action: 'import' });
});

test('ok + cards 空：heading 固定，hint 按轴措辞，action=null（无按钮）', () => {
  const read = loadWithReadlayer();
  assert.deepEqual(read.getStateCopy('albums', { status: 'ok', cards: [] }), {
    heading: '这个板块还没有内容',
    hint: '专辑按曲库里的专辑信息归组，导入匹配后自动出现',
    action: null });
  assert.deepEqual(read.getStateCopy('artists', { status: 'ok', cards: [] }), {
    heading: '这个板块还没有内容',
    hint: '艺人按曲库里的艺人信息归组，导入匹配后自动出现',
    action: null });
  assert.deepEqual(read.getStateCopy('playlists', { status: 'ok', cards: [] }), {
    heading: '这个板块还没有内容',
    hint: '导入歌单后自动出现',
    action: null });
});

test('error：heading = 传入 result.message 原样（不改写、不加前缀），hint 空串，action=retry', () => {
  const read = loadWithReadlayer();
  const msg = '索引重建中，请稍后再试：ENGINE_BOOT(503)';
  const copy = read.getStateCopy('artists', { status: 'error', message: msg });
  assert.equal(copy.heading, msg, 'message 原样透传，绝不改写或加前缀');
  assert.equal(copy.heading.indexOf('读取失败') === -1, true);
  assert.deepEqual(copy, { heading: msg, hint: '', action: 'retry' });
});

test('error：message 缺失/空串 → heading 兜底「读取失败」，仍保留 retry', () => {
  const read = loadWithReadlayer();
  assert.deepEqual(read.getStateCopy('playlists', { status: 'error' }),
    { heading: '读取失败', hint: '', action: 'retry' });
  assert.deepEqual(read.getStateCopy('albums', { status: 'error', message: '' }),
    { heading: '读取失败', hint: '', action: 'retry' });
});

test('未知 status：走 error 同形但 action=null（防漂移，不得白送重试钮）', () => {
  const read = loadWithReadlayer();
  assert.deepEqual(read.getStateCopy('albums', { status: 'stale-refresh' }),
    { heading: 'stale-refresh', hint: '', action: null });
  assert.deepEqual(read.getStateCopy('albums', {}),
    { heading: '读取失败', hint: '', action: null });
  assert.deepEqual(read.getStateCopy('albums', undefined),
    { heading: '读取失败', hint: '', action: null });
});

test('ok + 有卡＝正常渲染：不进 state-box 分支（artists 轴为空场景的对照）', () => {
  const read = loadWithReadlayer();
  const two = [{ id: 'A1', title: '张三' }, { id: 'A2', title: '李四' }];
  assert.equal(read.getStateCopy('artists', { status: 'ok', cards: two }), null);
  assert.equal(read.getStateCopy('albums', { status: 'ok', cards: [two[0]] }), null);
  assert.equal(read.getStateCopy('playlists', { status: 'ok', cards: [two[0]] }), null);
});

test('纯映射：入参不参与返回对象，改写返回值不污染后续调用', () => {
  const read = loadWithReadlayer();
  const a = read.getStateCopy('albums', { status: 'empty' });
  const b = read.getStateCopy('albums', { status: 'empty' });
  assert.deepEqual(a, b);
  assert.notEqual(a, b, '每次返回新对象');
  a.heading = '页面侧改写';
  assert.equal(read.getStateCopy('albums', { status: 'empty' }).heading, '曲库还是空的');
});
