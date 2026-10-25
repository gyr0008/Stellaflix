'use strict';
// 排行榜前端切片源钉（Task 3）：逐字性 + 跨端目录一致 + 壳层适配，全用静态源码断言（SF 家规）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'public/js/modules/05-playback/04b-daily-hot.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const loaderSrc = fs.readFileSync(path.join(ROOT, 'public/js/index-loader.js'), 'utf8');
const serverApi = require('../daily-hot-api');

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!declaration) return '';
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  if (bodyStart < 0) return '';
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}') { depth -= 1; if (depth === 0) return source.slice(declaration.index, index + 1); }
  }
  return '';
}

// 取出前端目录字面量（纯对象字面量，可脱离 DOM 求值）
function evalFrontCatalog(source, name) {
  const at = source.indexOf('var ' + name);
  assert.ok(at > -1, `源里缺 var ${name}`);
  const brace = source.indexOf('{', at);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        // vm 新 realm 的对象原型不同源，deepStrictEqual 会误判 → 用 JSON 归一回本 realm
        return JSON.parse(JSON.stringify(vm.runInNewContext('(' + source.slice(brace, i + 1) + ')')));
      }
    }
  }
  throw new Error(`${name} 字面量未闭合`);
}

test('前端子榜目录与后端 PLATFORM_CHART_CATALOG 逐字段相等（源料 §4.9 双端同内容）', () => {
  const front = evalFrontCatalog(moduleSrc, 'PLATFORM_RANKING_CATALOG');
  assert.deepEqual(Object.keys(front).sort(), Object.keys(serverApi.PLATFORM_CHART_CATALOG).sort());
  assert.deepEqual(front, serverApi.PLATFORM_CHART_CATALOG, '双端目录必须完全一致（id/name/顺序）');
  assert.equal(front.tx.length, 8);
  assert.equal(front.wy.length, 4);
  assert.equal(front.kw.length, 3);
  assert.equal(front.kg.length, 3);
  assert.equal(front.mg.length, 1);
});

test('状态机初值 = LX index.html:25789：renderLimit 40、cache 独立、requestToken 递增', () => {
  const at = moduleSrc.indexOf('var platformRankingState');
  assert.ok(at > -1, '缺 platformRankingState');
  const line = moduleSrc.slice(at, moduleSrc.indexOf('\n', at));
  assert.match(line, /source:'all'/);
  assert.match(line, /chartId:''/);
  assert.match(line, /cache:Object\.create\(null\)/);
  assert.match(line, /requestToken:0/);
  assert.match(line, /renderLimit:40/);
});

test('平台白名单与六平台文案逐字（all/tx/wy/kw/kg/mg = 综合/小秋/小芸/小蜗/小狗/小菇）', () => {
  assert.match(moduleSrc, /\^\(all\|tx\|wy\|kw\|kg\|mg\)\$/);
  const label = namedFunctionSource(moduleSrc, 'platformRankingSourceLabel');
  assert.ok(label.length > 0, '缺 platformRankingSourceLabel');
  for (const pair of [['all', '综合'], ['tx', '小秋'], ['wy', '小芸'], ['kw', '小蜗'], ['kg', '小狗'], ['mg', '小菇']]) {
    assert.match(label, new RegExp(pair[0] + ":'" + pair[1] + "'"));
  }
});

test('请求串 = LX 原样：limit=100 + source + chart + refresh=1 + 破缓存 t + 100s 预算', () => {
  const load = namedFunctionSource(moduleSrc, 'loadPlatformRanking');
  assert.ok(load.length > 0, '缺 loadPlatformRanking');
  assert.match(load, /\/api\/daily-hot\?limit=100&source=' \+ encodeURIComponent\(source\)/);
  assert.match(load, /'&chart=' \+ encodeURIComponent\(platformRankingState\.chartId\)/);
  assert.match(load, /'&refresh=1'/);
  assert.match(load, /'&t=' \+ Date\.now\(\)/);
  assert.match(load, /timeoutMs:100000/);
  assert.match(load, /token !== platformRankingState\.requestToken/, '迟到响应须按 token 丢弃');
  assert.match(load, /source !== platformRankingState\.source/);
  assert.match(load, /没有获取到榜单歌曲/);
  assert.match(load, /cacheKey = source \+ '\|' \+ \(platformRankingState\.chartId \|\| 'default'\)/, '前端缓存键与后端同构');
});

test('行模板五列结构与三枚行内钮逐字（序号/封面 50×50/曲名行/平台/▶＋♡）', () => {
  const row = namedFunctionSource(moduleSrc, 'platformRankingRowHtml');
  assert.ok(row.length > 0, '缺 platformRankingRowHtml（LX 行模板须提取为可测具名函数）');
  assert.match(row, /class="ranking-row" role="button" tabindex="0"/);
  assert.match(row, /data-ranking-index="' \+ index \+ '"/);
  assert.match(row, /String\(index \+ 1\)\.padStart\(2, '0'\)/);
  assert.match(row, /class="ranking-number"/);
  assert.match(row, /class="ranking-cover"[^>]*width="50" height="50"/);
  assert.match(row, /songCoverSrc\(song, 110\)/, '封面走 SF 自家 songCoverSrc（含自定义封面图）');
  assert.match(row, /class="ranking-copy"><span class="ranking-song-title"/);
  assert.match(row, /class="ranking-song-sub"/);
  assert.match(row, /class="ranking-source"/);
  assert.match(row, /class="ranking-row-actions"/);
  assert.match(row, />▶<\/button>/);
  assert.match(row, />＋<\/button>/);
  assert.match(row, />♡<\/button>/);
  assert.match(row, /event\.stopPropagation\(\)/);
  assert.match(row, /onkeydown="if\(event\.key===\\'Enter\\'\|\|event\.key===\\' \\'\)\{event\.preventDefault\(\);playPlatformRankingSong\(/, '键盘 Enter/空格 触发播放（源码里是转义单引号）');
  assert.match(row, /onclick="if\(!event\.target\.closest\(\\'button\\'\)\)playPlatformRankingSong\(/, '整行点击避开行内钮');
  assert.match(row, /未知歌曲/);
  // 列序（在 return 段的字符串拼接里）：序号 → 封面变量 → 文案 → 平台 → 行内钮
  const returnSeg = row.slice(row.indexOf('return '));
  const order = ['ranking-number', 'coverHtml', 'ranking-copy', 'ranking-source', 'ranking-row-actions']
    .map(cls => returnSeg.indexOf(cls === 'coverHtml' ? cls : 'class="' + cls + '"'));
  assert.ok(order.every(i => i > -1), '五列缺列：' + JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '五列顺序被打乱');
});

test('渲染阈值：首屏 40、「加载更多」每次 +40 且不越过总行数', () => {
  const render = namedFunctionSource(moduleSrc, 'renderPlatformRanking');
  assert.match(render, /Math\.min\(songs\.length, Math\.max\(40, Number\(platformRankingState\.renderLimit\) \|\| 40\)\)/);
  assert.match(render, /加载更多 · 已显示 '/);
  const grow = namedFunctionSource(moduleSrc, 'growPlatformRankingRenderLimit');
  assert.match(grow, /Number\(platformRankingState\.renderLimit\) \|\| 40\) \+ 40/);
  for (const name of ['selectPlatformRanking', 'selectPlatformChart', 'refreshPlatformRanking']) {
    assert.match(namedFunctionSource(moduleSrc, name), /renderLimit = 40/, `${name} 切榜须回到 40 首`);
  }
});

test('四种文案态逐字（加载中/出错/空榜/成功摘要「每 6 小时更新」）', () => {
  const render = namedFunctionSource(moduleSrc, 'renderPlatformRanking');
  assert.match(render, /正在加载/);
  assert.match(render, /榜单暂时没有加载成功/);
  assert.match(render, /这个平台暂时没有榜单歌曲/);
  assert.match(render, /' 首 · ' \+ chartLabel \+ ' · 保留平台原始名次 · 每 6 小时更新'/);
  assert.match(render, /各平台榜单相互独立，首次切换可能需要一些时间/);
  assert.match(render, /当前平台音源暂不可用，可以切换其他平台/);
  assert.match(render, /未找到可播放的榜单歌曲/);
  assert.match(render, /ranking-state/);
});

test('四个动作接 SF 自家播放链，且 SF 无的 LX 壳层函数零引用', () => {
  const play = namedFunctionSource(moduleSrc, 'playPlatformRankingSong');
  assert.match(play, /playQueue\.push\(queuedSong\)/);
  assert.match(play, /currentIdx = playQueue\.length - 1/);
  assert.match(play, /safeRenderQueuePanel\('platform-ranking-play', \{ scrollCurrent:true \}\)/);
  assert.match(play, /type:'platform-ranking'/);
  const playAll = namedFunctionSource(moduleSrc, 'playAllPlatformRanking');
  assert.match(playAll, /playQueue = platformRankingState\.songs\.map\(platformRankingQueueSong\)/);
  assert.match(playAll, /榜单还没有加载完成/);
  assert.match(namedFunctionSource(moduleSrc, 'queuePlatformRankingSong'), /queueDetailSongNext\(/);
  assert.match(namedFunctionSource(moduleSrc, 'collectPlatformRankingSong'), /openCollectModal\(/);
  // SF 不存在的 LX 壳层/快照链一律不得引用（引了就是运行时 ReferenceError）。
  // 文件头注释里要写明「LX 用的是这套体系」=偏离留痕，故先剥掉注释再判代码引用。
  const codeOnly = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const absent of ['closeSecondaryView', 'setSecondaryPage', 'setPrimaryNavActive', 'openPrimaryView',
    'closePlaylistPanelForSecondaryView', 'setPeek', 'snapshotQueueForUndo', 'songDisplaySubtitle', 'songArtistText']) {
    assert.doesNotMatch(codeOnly, new RegExp('\\b' + absent + '\\b'), `SF 无 ${absent}，不得引用`);
  }
  assert.match(moduleSrc, /closeDailyHotRanking\(\)/, '播放后关弹窗=SF 弹窗壳替代 LX secondary-view');
  assert.match(moduleSrc, /openHomeLibrary/, '「打开音乐库」接 SF 等价物');
});

test('复用 SF 全局，不重复造轮子', () => {
  const codeOnly = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const reused of ['apiJson', 'escHtml', 'songCoverSrc', 'cloneSong', 'openCollectModal',
    'queueDetailSongNext', 'playQueueAt', 'safeRenderQueuePanel', 'showToast', 'forcePlaybackControlsInteractive', 'openHomeLibrary', 'songSourceLabel']) {
    assert.doesNotMatch(codeOnly, new RegExp('function\\s+' + reused + '\\s*\\('), `${reused} 须复用 SF 现有实现，不得在本模块重定义`);
    assert.match(codeOnly, new RegExp(reused + '\\('), `${reused} 应在代码里被调用（不是只在注释里提一句）`);
  }
});

test('index.html 新弹窗骨架：玻璃壳 + 六平台 tab + 子榜容器 + 摘要条 + 列表根', () => {
  const at = indexHtml.indexOf('id="daily-hot-ranking-mask"');
  assert.ok(at > -1, '缺 #daily-hot-ranking-mask');
  const head = indexHtml.slice(at - 60, at + 120);
  assert.match(head, /modal-mask sfv-glass-modal/, '排行榜弹窗须挂 premium 玻璃壳类');
  const block = indexHtml.slice(at, indexHtml.indexOf('id="home-video-collections-mask"', at) > at
    ? indexHtml.indexOf('id="home-video-collections-mask"', at) : at + 4000);
  for (const source of ['all', 'tx', 'wy', 'kw', 'kg', 'mg']) {
    assert.match(block, new RegExp('data-ranking-source="' + source + '"'));
    assert.match(block, new RegExp("selectPlatformRanking\\('" + source + "'\\)"));
  }
  assert.match(block, /id="ranking-chart-tabs"/);
  assert.match(block, /class="[^"]*ranking-summary[^"]*"/);
  assert.match(block, /id="ranking-summary-title" class="ranking-summary-title">综合热榜<\/div>/);
  assert.match(block, /只展示各平台真实原榜，不使用搜索歌曲补足名次/);
  assert.match(block, /id="platform-ranking-list" class="ranking-list" aria-live="polite"/);
  assert.match(block, /正在准备排行榜/);
  assert.match(block, /playAllPlatformRanking\(\)/);
  assert.match(block, /refreshPlatformRanking\(\)/);
  assert.match(block, /排行榜说明/);
});

test('入口共存：首页卡仍走「平台热歌与个人偏好」，热榜入口在推荐弹窗内新增', () => {
  // 既有守卫（T118）不许动
  assert.match(indexHtml, /onclick="openHomeDashboardCharts\(\)"/);
  assert.match(indexHtml, /<span class="home-ranking-entry-title">平台热歌与个人偏好<\/span>/);
  const at = indexHtml.indexOf('id="home-platform-recommend-mask"');
  const recommendBlock = indexHtml.slice(at, indexHtml.indexOf('id="daily-hot-ranking-mask"', at));
  assert.match(recommendBlock, /onclick="openDailyHotRanking\('all'\)"/, '推荐弹窗内须有平台热榜入口');
  assert.match(recommendBlock, /平台热榜/);
});

test('loader 注册在 04a-radio-modes 之后（04 系列依赖 order），bundle 计数已同步', () => {
  const idx = loaderSrc.indexOf("'js/modules/05-playback/04b-daily-hot.js'");
  assert.ok(idx > -1, '04b-daily-hot.js 未登记进 index-loader.js');
  const radio = loaderSrc.indexOf("'js/modules/05-playback/04a-radio-modes.js'");
  assert.ok(idx > radio, '04b 必须晚于 04a 注册');
  assert.ok(idx < loaderSrc.indexOf("'js/modules/05-playback/04-home-empty-wallpaper.js'"), '04b 须在 04 之前');
  assert.match(loaderSrc, /'js\/modules\/05-playback\/04a-radio-modes\.js',\n\s*'js\/modules\/05-playback\/04b-daily-hot\.js',/, '注册位置须紧贴 04a');
});

test('文件头偏离留痕：壳层/subtitle 链/撤销快照/音乐库入口四处适配写明', () => {
  const head = moduleSrc.slice(0, 1600);
  assert.match(head, /偏离/);
  assert.match(head, /secondary-view|04a-radio-modes/, '偏离1：壳层按 04a 先例适配');
  assert.match(head, /songArtistText|本地元数据/, '偏离2：subtitle 不走 SF 不存在的本地元数据链');
  assert.match(head, /snapshotQueueForUndo/, '偏离3：撤销快照 SF 无');
  assert.match(head, /openHomeLibrary/, '偏离4：音乐库入口');
});

test('导出面挂 window，AI agent 与 onclick 同路', () => {
  for (const name of ['openDailyHotRanking', 'closeDailyHotRanking', 'selectPlatformRanking', 'selectPlatformChart',
    'refreshPlatformRanking', 'playAllPlatformRanking', 'playPlatformRankingSong', 'queuePlatformRankingSong',
    'collectPlatformRankingSong', 'growPlatformRankingRenderLimit']) {
    assert.match(moduleSrc, new RegExp('window\\.' + name + ' = ' + name + ';'));
  }
  assert.match(moduleSrc, /window\.__platformRankingRowHtml = platformRankingRowHtml;/, '行模板须可被 node 侧取用');
});
