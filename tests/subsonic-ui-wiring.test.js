const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const read = (p) => fs.readFileSync(p, 'utf8');

test('index-loader 注册了 07-subsonic-library.js', () => {
  assert.ok(read('public/js/index-loader.js').includes("'js/modules/06-lyrics/07-subsonic-library.js'"));
});

test('index.html 有 tab-subsonic 按钮和 subsonic-pane 容器', () => {
  const html = read('public/index.html');
  assert.ok(html.includes('id="tab-subsonic"'));
  assert.ok(html.includes('id="subsonic-pane"'));
  assert.ok(html.includes('id="subsonic-list"'));
});

test('normalizePlaylistPanelTab 认 subsonic', () => {
  const src = read('public/js/modules/00-state/02-preferences-ui-modes.js');
  assert.ok(src.includes("tab === 'subsonic' ? 'subsonic'"));
});

test('shell 的 switchPlaylistTab 处理 subsonic 面板', () => {
  const src = read('public/js/modules/06-lyrics/01-playlist-panel-shell.js');
  assert.ok(src.includes("getElementById('subsonic-pane')"));
  assert.ok(src.includes('refreshSubsonicPane'));
});

test('模块文件存在且暴露播放入口', () => {
  const src = read('public/js/modules/06-lyrics/07-subsonic-library.js');
  assert.ok(src.includes('function playSubsonicSongs'));
  assert.ok(src.includes('function refreshSubsonicPane'));
  assert.ok(src.includes('window.refreshSubsonicPane'));
  assert.ok(src.includes('localUrl'));
});

// ---------- 审查修复轮 1 的回归锁（属性注入 / 错误态 / 封面 / 删除提示 / 空栈返回按钮） ----------

const MODULE = 'public/js/modules/06-lyrics/07-subsonic-library.js';

test('远程值插入 HTML 属性必须经 subAttr 转义双引号', () => {
  const src = read(MODULE);
  assert.ok(/function subAttr\(s\)/.test(src), '缺少模块级 subAttr 属性转义助手');
  assert.ok(/&quot;/.test(src), 'subAttr 必须把双引号替换为 &quot;');
  assert.ok(!/function escHtml/.test(src), '不得在本模块重定义共享的 escHtml');
  assert.ok(!/data-sub-[a-z-]+="' \+ escHtml/.test(src), 'data-sub-* 属性仍在直插 escHtml 结果');
  assert.ok(!/src="' \+ escHtml/.test(src), '远程封面地址插入 src 属性时也要用 subAttr');
  assert.ok((src.match(/data-sub-[a-z-]+="' \+ subAttr/g) || []).length >= 5,
    '所有 data-sub-* 插值点都应改用 subAttr');
  // 标签之间的文本仍走 escHtml（勿被一刀切替换）
  assert.ok(/<div class="pl-name">' \+ escHtml/.test(src), '文本内容仍应使用 escHtml');
});

test('上游返回 {error:...} 时走加载失败分支而非空态', () => {
  const src = read(MODULE);
  const checks = src.match(/if \((\w+) && \1\.error\) throw new Error\(\1\.error\);/g) || [];
  assert.ok(checks.length >= 4, '每个 browse await 后都要显式检查 .error，实际 ' + checks.length + ' 处');
  const serversSlice = src.slice(src.indexOf("apiJson('/api/subsonic/config')"), src.indexOf('r.servers'));
  assert.ok(/throw new Error\(r\.error\)/.test(serversSlice), 'servers 视图在 || [] 兜底前未检查 r.error');
  const songsSlice = src.slice(src.indexOf('apiJson(view.endpoint)'), src.indexOf('r3.songs'));
  assert.ok(/throw new Error\(r3\.error\)/.test(songsSlice), 'songs 视图在 || [] 兜底前未检查 r3.error');
});

test('曲目行带封面', () => {
  const src = read(MODULE);
  assert.ok(/act: 'play'[^}]*cover: sg\.cover/.test(src), '歌曲行缺少 per-track 封面');
});

test('删除服务器失败有 toast 提示', () => {
  const src = read(MODULE);
  assert.ok(/showToast\('删除失败/.test(src), '删除服务器失败路径没有给用户反馈');
});

test('视图栈为空时错误态不渲染返回按钮', () => {
  const src = read(MODULE);
  const catchStart = src.indexOf('} catch (e) {');
  const catchBlock = catchStart === -1 ? '' : src.slice(catchStart, src.indexOf('} finally {', catchStart));
  assert.ok(catchBlock, '模块缺少 renderSubsonicPane 的 catch 分支');
  assert.ok(/subsonicHead\([\s\S]*?, subsonicNav\.length > 0\)/.test(catchBlock),
    '错误态的 canBack 应取决于 subsonicNav.length > 0');
  assert.ok(!/subsonicHead\([\s\S]*?, true\)/.test(catchBlock), '错误态不该硬编码 canBack=true');
});

// ---------- 最终修复轮回归锁（渲染竞态 seq / act 属性转义 / 密码占位文案） ----------

test('renderSubsonicPane 用 seq 令牌拦截过期异步写入', () => {
  const src = read(MODULE);
  assert.ok(/var subsonicRenderSeq = 0;/.test(src), '缺少模块级 subsonicRenderSeq 计数器');
  assert.ok(/var seq = \+\+subsonicRenderSeq;/.test(src), 'renderSubsonicPane 入口应领取 seq 令牌');
  assert.ok((src.match(/if \(seq !== subsonicRenderSeq\) return;/g) || []).length >= 6,
    '4 个视图分支 + 空态 + catch 兜底共 6 处 innerHTML 写入前都要比对 seq');
});

test('data-sub-act 插值必须经 subAttr', () => {
  const src = read(MODULE);
  assert.ok(!/data-sub-act="' \+ attrs\.act/.test(src), 'attrs.act 仍在裸插值');
});

test('密码占位不再承诺保留已存密码（表单只用于新增）', () => {
  const src = read(MODULE);
  assert.ok(!src.includes('留空=保留已存密码'), '占位文案仍暗示可留空改编辑');
  assert.ok(src.includes('placeholder="密码"'), '占位应为单纯的「密码」');
});
