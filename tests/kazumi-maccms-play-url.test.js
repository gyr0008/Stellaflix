/**
 * 守卫测试：苹果 CMS（maccms）系播放页嗅探。
 *
 * 覆盖三条红线（均有实机缺陷背书）：
 *  1. 真实流藏在 base64 里时，PLAY_URL_PATTERNS 必须能解出直链（netflixgc.org 实测）。
 *  2. maccms 策略必须排在 js-variable 之前：后者正则过宽，会先命中页面里的
 *     报错按钮 data-url="编号【xxx】名称【xxx】不能观看请检查修复，页面地址"，
 *     把提示文案当播放地址返回——比不解析更糟。
 *  3. js-variable 必须只收「看起来像 URL」的取值。旧版 player.*?url 的 .*? 会
 *     越过 {"flag":"play",...,"link":"..."} 跨段匹配到 data-url，同样产出错误结果。
 */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_CORE = path.join(ROOT, 'public', 'video', 'kazumi-bridge-core.js');

/** 在 vm 沙箱里加载桥接内核，取出 PLAY_URL_PATTERNS / decodeMaccmsPlayUrl */
function loadCore() {
  const sandbox = { console, atob: globalThis.atob };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BRIDGE_CORE, 'utf8'), sandbox);
  const SFV = sandbox.StellaflixVideo || {};
  return SFV.kazumiCore || null;
}

// 线上真实流地址（(netflixgc.org《金特务：本色回归》第1集嗅探所得）
const REAL_M3U8 = 'https://v14.wsyzym3u8.com/202606/26/cqERF0rRUd27/video/index.m3u8';

// 样例 1：netflixgc.org《金特务：本色回归》播放页真实片段（截取自线上 HTML）
// 注意：base64 用运行时生成而非手抄——手抄极易漏字符且解码会静默失败。
const SAMPLE_MACCMS = [
  '<script>',
  'var maccms={"path2":"/","url":"netflixgc.com"};',
  // 线上该字段是 260 字符的 base64，运行时生成以免手抄漏字符（漏字符会静默解码失败）
  '{"epid":"118604","url":"' + Buffer.from(encodeURIComponent(REAL_M3U8), 'utf8').toString('base64') + '"',
  ',"from":"wsym3u8","server":"no","note":"","id":"118604","sid":1,"nid":1}',
  '<a class="ec-report item cor5" href="javascript:" data-url="编号【118604】名称【金特务】不能观看请检查修复，页面地址"></a>',
  '</script>',
].join('\n');

// 样例 2：同一站另一部影片，首条 url 是签名 token，报错按钮文案同样存在
const SAMPLE_TOKEN = [
  '<script>',
  '{"epid":"80498","url":"JTRFJTQyJTU5JTJEJTU4JTREJTU5JTQxJTQ1JTUzJTM4JTY1JTM5JTYyJTY0JTYyJTM0JTMxJTM0JTM3JTMzJTYyJTM5JTMxJTM0JTM2JTM0JTM0JTM5JTMzJTM4JTMxJTY0JTYyJTMxJTM0JTMxJTYyJTYxJTM5JTMwJTM1JTMzJTM1JTYzJTM3JTMzJTM5JTYyJTY1JTM3JTM5JTMyJTM5JTMyJTM2JTY2JTY0JTM2JTM2JTM1JTYxJTM2JTMz","from":"NBY","server":"","note":"","id":"80498","sid":4,"nid":1}',
  '<a class="ec-report item cor5" href="javascript:" data-url="编号【80498】名称【弗兰肯斯坦】不能观看请检查修复，页面地址"></a>',
  '</script>',
].join('\n');

test('decodeMaccmsPlayUrl 能解 base64(urlencode(url)) 与 base64(url) 两种编码', t => {
  const core = loadCore();
  assert.ok(core && typeof core.decodeMaccmsPlayUrl === 'function', 'decodeMaccmsPlayUrl 必须导出');

  // 编码：base64(encodeURIComponent('https://v14.wsyzym3u8.com/a/index.m3u8'))
  const b64Pct = Buffer.from(encodeURIComponent('https://v14.wsyzym3u8.com/a/index.m3u8'), 'utf8').toString('base64');
  assert.equal(core.decodeMaccmsPlayUrl(b64Pct), 'https://v14.wsyzym3u8.com/a/index.m3u8');

  // 编码：base64('https://cdn.example.com/b.m3u8')
  const b64Plain = Buffer.from('https://cdn.example.com/b.m3u8', 'utf8').toString('base64');
  assert.equal(core.decodeMaccmsPlayUrl(b64Plain), 'https://cdn.example.com/b.m3u8');
});

test(' decodeMaccmsPlayUrl 对非法输入安全返回 null', t => {
  const core = loadCore();
  ['', 'not-base64!!!', 'netflixgc.com', 'a'.repeat(40)].forEach(v => {
    assert.equal(core.decodeMaccmsPlayUrl(v), null, JSON.stringify(v.slice(0, 16)) + ' 应为 null');
  });
});

test('maccms 策略排在 js-variable 之前，避免提示文案抢先命中', t => {
  const core = loadCore();
  const names = core.PLAY_URL_PATTERNS.map(s => s.name);
  const iMaccms = names.indexOf('maccms-play-b64');
  const iJsVar = names.indexOf('js-variable');
  assert.ok(iMaccms > -1, '必须存在 maccms-play-b64 策略');
  assert.ok(iMaccms < iJsVar, `maccms-play-b64(索引${iMaccms}) 必须早于 js-variable(索引${iJsVar})`);
});

test('真实流藏在 base64 里时，嗅探命中 m3u8 直链（改造前全部落空）', t => {
  const core = loadCore();
  const found = core.PLAY_URL_PATTERNS
    .map(s => ({ name: s.name, url: s.test(SAMPLE_MACCMS) }))
    .find(x => x.url);
  assert.ok(found, '必须至少一条策略命中');
  assert.equal(found.name, 'maccms-play-b64', '应由 maccms-play-b64 命中，实际: ' + found.name);
  assert.equal(found.url, 'https://v14.wsyzym3u8.com/202606/26/cqERF0rRUd27/video/index.m3u8');
});

test('js-variable 不得把报错按钮的中文提示文案当成播放地址', t => {
  const core = loadCore();
  const jsVar = core.PLAY_URL_PATTERNS.find(s => s.name === 'js-variable');
  const hit = jsVar.test(SAMPLE_MACCMS);
  if (hit) {
    assert.ok(/^https?:/i.test(hit), '命中值必须是 URL，实际: ' + hit);
    assert.ok(!/编号|不能观看|检查修复/.test(hit), '不得返回提示文案，实际: ' + hit);
  }
});

test('仅签名 token 的播放页应安全返回空，而不是错误文案', t => {
  const core = loadCore();
  const hit = core.PLAY_URL_PATTERNS
    .map(s => s.test(SAMPLE_TOKEN))
    .find(Boolean);
  if (hit) {
    assert.ok(/^https?:/i.test(hit), 'token 页面若命中必须是 URL，实际: ' + hit);
  }
});
