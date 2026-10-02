/**
 * 守卫测试：555dy 系（555k31 / 5k12 / 5k20 同源镜像）Kazumi 规则。
 *
 * 背景（均为实机缺陷背书）：
 *  1. 该系采集口 /api.php/provide/vod 返「域名未授权」，走不了 CMS10 通道，只能通道 B（Kazumi 规则）。
 *  2. 播放块是**明文**且斜杠被转义成 "https:\/\/host\/a\/index.m3u8"，
 *     只认字面 https:// 的旧策略会落空，被后面的 iframe-src 命中播放器壳（假流）——
 *     故新增 maccms-play-plain 策略并压在 iframe-src 之前。
 *  3. 该系把分集写进 URL 时用的是 JS 转义（第08集 -> \u7b2c08\u96c6），
 *     不还原时请求 nginx 404，还原后同一个地址 200 + 47KB m3u8。
 *  4. searchList 必须命中「条目」而不是「网格行」：行容器下每条只取首个链接，
 *     119 条结果会被压成 15 条（实测缺陷）。
 */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const RULE_FILE = path.join(ROOT, 'outputs', 'video-source-import', 'stellaflix-kazumi-rules-555dy.json');
const FIX = path.join(__dirname, 'fixtures', '555dy');
const EXPECT_HOSTS = ['www.555k31.com', '5k12.top', 'www.5k20.top'];

/** 在 vm 沙箱里加载 xpath-engine + rule-schema，返回 {XE, Schema} */
function loadEngine() {
  const dom = new JSDOM('<html><body></body></html>', { runScripts: 'outside-only' });
  const sb = dom.window;
  sb.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  sb.setTimeout = setTimeout; sb.clearTimeout = clearTimeout; sb.Buffer = Buffer;
  // vm 上下文里没有自动 global / Node / DOMParser / XPathResult，引擎全走 global.*
  sb.global = sb; sb.Node = dom.window.Node;
  sb.DOMParser = dom.window.DOMParser; sb.XPathResult = dom.window.XPathResult;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'video', 'kazumi', 'rule-schema.js'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'video', 'kazumi', 'xpath-engine.js'), 'utf8'), sb);
  return { XE: sb.KazumiXPathEngine, Schema: sb.KazumiRuleSchema };
}

function loadCore() {
  const sb = { console, setTimeout, clearTimeout, Buffer, atob: globalThis.atob };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'video', 'kazumi-bridge-core.js'), 'utf8'), sb);
  return sb.StellaflixVideo.kazumiCore;
}

const nz = (base, u) => (/^https?:\/\//i.test(u) ? u : base.replace(/\/$/, '') + (u.charAt(0) === '/' ? u : '/' + u));
const readRule = () => JSON.parse(fs.readFileSync(RULE_FILE, 'utf8'));
const rules = readRule();

test('交付规则文件是 3 条规则的数组，域名覆盖三个镜像', t => {
  assert.ok(Array.isArray(rules), '规则文件应是数组（importRules 支持数组）');
  assert.equal(rules.length, 3, '应有 3 条（555k31 / 5k12 / 5k20）');
  const hosts = rules.map(r => new URL(r.baseURL).host);
  EXPECT_HOSTS.forEach(h => assert.ok(hosts.indexOf(h) > -1, '缺少 ' + h + '，实际: ' + hosts.join(',')));
});

test('每条规则都过 Schema 校验（baseURL/searchURL 必须绝对 http(s)）', t => {
  const { Schema } = loadEngine();
  rules.forEach(r => {
    const norm = Schema.fromJson(r); // 归一后字段是 baseUrl 而非 JSON 的 baseURL
    const v = Schema.validate(norm);
    assert.ok(v.valid, r.name + ' 校验失败: ' + JSON.stringify(v.errors));
    assert.ok(/^https:\/\//i.test(norm.baseUrl), r.name + ' baseUrl 必须绝对 https');
    assert.ok(/^https:\/\//i.test(norm.searchURL), r.name + ' searchURL 必须绝对 https');
  });
});

test('xpath 字段齐全且不得用全等 @class= 写法（contains(@class,\'x\') 才是包含匹配）', t => {
  rules.forEach(r => {
    ['searchList', 'searchName', 'searchResult', 'chapterRoads', 'chapterResult'].forEach(f => {
      assert.ok(r[f] && String(r[f]).length > 4, r.name + ' 的 ' + f + ' 为空');
      assert.ok(!/@class\s*=\s*['"]/.test(r[f]), r.name + ' 的 ' + f + ' 用了 @class= 全等匹配，必须改 contains(@class,\'...\')');
    });
    assert.equal(r.searchMode, 'xpath', r.name + ' 必须 xpath 模式');
    assert.equal(r.chapterMode, 'xpath', r.name + ' 必须 xpath 模式');
  });
});

test('searchList 命中的是「条目」而不是「网格行」：解析出 119 条影片', t => {
  const { XE, Schema } = loadEngine();
  const r = Schema.fromJson(rules[0]);
  const html = fs.readFileSync(path.join(FIX, 'search.html'), 'utf8');
  const out = XE.parseSearch(html, r, nz);
  assert.equal(out.diagnostics.length, 0, '解析不该有诊断: ' + out.diagnostics.slice(0, 2).join(';'));
  assert.equal(out.items.length, 119, '应解析出 119 条，实际 ' + out.items.length + '（若变 15 条说明又退回「行容器」写法）');
  out.items.forEach(it => {
    assert.ok(/^\/voddetail\/\d+\.html$/.test(it.src), '非影片链接: ' + it.src);
    assert.ok(it.name && it.name.length > 0, '空标题');
  });
  assert.equal(new Set(out.items.map(i => i.src)).size, out.items.length, '链接必须唯一');
});

test('searchResult 必须能取到条目自身的 href（用 self::a 而非后代选择器）', t => {
  const { Schema } = loadEngine();
  rules.forEach(r => {
    assert.equal(Schema.fromJson(r).searchResult, 'self::a',
      r.name + ' 的 searchResult 必须是 self::a：条目本身就是 <a>，后代选择器取不到 href');
  });
});

test('详情页解析出 13 条线路（12 条真实 + 1 条转义样本），集链接绝对化', t => {
  const { XE, Schema } = loadEngine();
  const r = Schema.fromJson(rules[0]);
  const html = fs.readFileSync(path.join(FIX, 'detail.html'), 'utf8');
  const out = XE.parseChapters(html, r, nz);
  assert.equal(out.diagnostics.length, 0, '诊断: ' + out.diagnostics.slice(0, 2).join(';'));
  assert.equal(out.roads.length, 13, '线路数 13，实际 ' + out.roads.length);
  out.roads.forEach(road => {
    assert.ok(road.data.length >= 3, '线路集数过少: ' + road.data.length);
    assert.equal(road.data.length, road.identifier.length, 'data/identifier 必须等长');
    road.data.forEach(u => assert.ok(/^https:\/\/www\.555k31\.com\/vodplay\/\d+-\d+-\d+\.html$/.test(u), '集链接形态异常: ' + u));
  });
});

test('maccms-play-plain 排在 iframe-src / js-variable 之前（改造前被播放器壳抢命中）', t => {
  const core = loadCore();
  const names = core.PLAY_URL_PATTERNS.map(s => s.name);
  const iPlain = names.indexOf('maccms-play-plain');
  const iIframe = names.indexOf('iframe-src');
  const iJsVar = names.indexOf('js-variable');
  assert.ok(iPlain > -1, '必须存在 maccms-play-plain 策略');
  assert.ok(iPlain < iIframe, `maccms-play-plain(索引${iPlain}) 必须早于 iframe-src(索引${iIframe})`);
  assert.ok(iPlain < iJsVar, `maccms-play-plain(索引${iPlain}) 必须早于 js-variable(索引${iJsVar})`);
});

test('播放页嗅探到明文真流，而不是播放器壳', t => {
  const core = loadCore();
  const html = fs.readFileSync(path.join(FIX, 'play.html'), 'utf8');
  const hit = core.PLAY_URL_PATTERNS.map(s => ({ name: s.name, url: s.test(html) })).find(x => x.url);
  assert.ok(hit, '必须有策略命中');
  assert.equal(hit.name, 'maccms-play-plain', '应由 maccms-play-plain 命中，实际: ' + hit.name);
  assert.ok(/^https?:\/\//i.test(hit.url), '必须是绝对 URL: ' + hit.url);
  assert.ok(!/\/static\/player\//i.test(hit.url), '不得返回播放器壳: ' + hit.url);
  assert.ok(/\.m3u8$/i.test(hit.url), '必须是 m3u8: ' + hit.url);
});

test('URL 里的 \\uXXXX 转义必须还原（不还原会 nginx 404）', t => {
  const core = loadCore();
  const html = fs.readFileSync(path.join(FIX, 'play.html'), 'utf8');
  const hit = core.PLAY_URL_PATTERNS.map(s => s.test(html)).find(Boolean);
  assert.ok(hit, '必须命中');
  assert.ok(!/\\u[0-9a-fA-F]{4}/.test(hit), '仍残留 \\u 转义: ' + hit);
  assert.ok(hit.indexOf('第08集') > -1 || hit.indexOf('\\u') === -1, '含中文的转义应还原成汉字: ' + hit);
  assert.ok(!/\\\//.test(hit), '斜杠转义未还原: ' + hit);
});

test('只有转义 URL 的播放页：必须还原成汉字「第08集」（不还原请求会 nginx 404）', t => {
  const core = loadCore();
  // 该 fixture 是实抓的 /vodplay/738752-4-8.html，页面里只有这一条 url 且带 \uXXXX 转义
  const html = fs.readFileSync(path.join(FIX, 'play-escaped.html'), 'utf8');
  const hit = core.PLAY_URL_PATTERNS.map(s => ({ name: s.name, url: s.test(html) })).find(x => x.url);
  assert.ok(hit, '必须有策略命中');
  assert.equal(hit.name, 'maccms-play-plain', '应由 maccms-play-plain 命中，实际: ' + hit.name);
  assert.ok(!/\\u[0-9a-fA-F]{4}/.test(hit.url), '仍残留 \\u 转义（请求会 404）: ' + hit.url);
  assert.ok(hit.url.indexOf('第08集') > -1, '第08集 未还原成汉字: ' + hit.url);
  assert.ok(/^https:\/\/v\.fengbao8\.com\/video\/taifengshangshe\//.test(hit.url), 'CDN 前缀异常: ' + hit.url);
});

test('站点自配置 {"url":"www.example.net"} 不得被当成播放地址', t => {
  const core = loadCore();
  const html = '<script>var maccms={"path2":"/","url":"www.555k31.com"};</script>';
  const hit = core.PLAY_URL_PATTERNS.map(s => s.test(html)).find(Boolean);
  assert.ok(!hit, '站点配置不得命中，实际: ' + hit);
});
