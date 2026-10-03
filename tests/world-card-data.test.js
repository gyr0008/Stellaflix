'use strict';

/**
 * 轮⑲：卡片数据保真 —— 国旗数据集（Yl/Gf/Qf 等价位）+ world-data 十站字段 + 面板接线
 * 运行：node --test tests/world-card-data.test.js
 *
 * 事实源 _scratch/hearthere/main.pretty.js（panel-spec.md §0）：
 *   Yl 国旗内联库（缺位→本模块等价位） · Gf :7245-7250 flat data-uri
 *   Qf :7251-7262 128×128 装框（内层 <svg x="10" y="28" width="108" height="72"）+ Map memoise
 * 裁决（主人 2026-10-02，方案 A1）：coverUrl=TMDB backdrop、descriptionZh=TMDB zh-CN overview，
 *   ID/路径/简介全部来自 themoviedb.org 页面实测（_scratch/tmdb-scrape-out.json，禁臆测）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const NEED_CODES = ['AU', 'BR', 'CN', 'FR', 'GB', 'IN', 'JP', 'RU', 'US', 'ZA'];

// ---------------- world-flags 沙箱（纯数据模块，无 DOM） ----------------

function loadFlags() {
  const p = path.join(root, 'public', 'video', 'world-flags.js');
  assert.ok(fs.existsSync(p), 'public/video/world-flags.js 应存在（轮⑲ 待实现）');
  const sandbox = { console, Promise, Map, encodeURIComponent };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox);
  assert.ok(sandbox.StellaflixVideo && sandbox.StellaflixVideo.worldFlags, '应挂 SFV.worldFlags');
  return sandbox.StellaflixVideo.worldFlags;
}

test('world-flags 导出面 + 十国齐备（AU/BR/CN/FR/GB/IN/JP/RU/US/ZA）', () => {
  const F = loadFlags();
  for (const code of NEED_CODES) {
    const svg = F.flagSvgFor(code);
    assert.ok(typeof svg === 'string' && svg.startsWith('<svg ') && svg.endsWith('</svg>'),
      code + ' 应为 <svg …</svg> 字符串（Qf 的 replace("<svg ") 依赖首现 <svg ）');
    assert.ok(!svg.includes('undefined') && !svg.includes('NaN'), code + ' 不应含 undefined/NaN');
  }
});

test('Gf 逐字（:7245-7250）：data:image/svg+xml, + encodeURIComponent(svg)；未知码空串', () => {
  const F = loadFlags();
  assert.equal(F.flagDataUrl('JP'), 'data:image/svg+xml,' + encodeURIComponent(F.flagSvgFor('JP')));
  assert.equal(F.flagDataUrl('XX'), '');
});

test('Qf 逐字（:7251-7262）：128×128 装框 + 内层 x=10 y=28 w=108 h=72；未知码 null（面板回落 avatar）', () => {
  const F = loadFlags();
  const framed = F.flagFramedUrl('CN');
  assert.ok(framed.startsWith('data:image/svg+xml,'), 'Qf 输出为 data-uri');
  const decoded = decodeURIComponent(framed.slice('data:image/svg+xml,'.length));
  assert.match(decoded, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="128" height="128" viewBox="0 0 128 128">/);
  assert.ok(decoded.includes('<svg x="10" y="28" width="108" height="72" '), '内层替换逐字（replace("<svg ")）');
  assert.equal((decoded.match(/x="10"/g) || []).length, 1, '只替换首个 <svg 开标签');
  assert.equal(F.flagFramedUrl('XX'), null, '未知码 → null → 面板 M 空串走 avatar（:7357 三元）');
  assert.equal(F.flagFramedUrl('CN'), framed, 'memoise 二次调用同值');
});

// ---------------- 面板集成（fake DOM + deck + panel + flags 同 realm） ----------------

function makeClassList(el) {
  const set = new Set();
  const sync = () => { el._className = Array.from(set).join(' '); };
  return {
    add() { for (const n of arguments) if (n) set.add(n); sync(); },
    remove() { for (const n of arguments) set.delete(n); sync(); },
    toggle(n, force) {
      const want = force === undefined ? !set.has(n) : !!force;
      if (want) set.add(n); else set.delete(n);
      sync();
      return want;
    },
    contains(n) { return set.has(n); },
    _replace(str) { set.clear(); String(str).split(/\s+/).filter(Boolean).forEach((n) => set.add(n)); sync(); }
  };
}

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], parentNode: null,
    style: { setProperty(k, v) { this[k] = v; } }, attributes: {}, listeners: {},
    textContent: '', offsetWidth: 0, scrollWidth: 0, offsetHeight: 0, disabled: false
  };
  el.classList = makeClassList(el);
  Object.defineProperty(el, 'className', {
    get() { return el._className || ''; },
    set(v) { el.classList._replace(v); }
  });
  el.appendChild = function (c) { c.parentNode = el; el.children.push(c); return c; };
  el.removeChild = function (c) {
    const i = el.children.indexOf(c);
    if (i >= 0) { el.children.splice(i, 1); c.parentNode = null; }
    return c;
  };
  el.setAttribute = function (k, v) { el.attributes[k] = String(v); if (k === 'class') el.className = v; };
  el.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : null; };
  el.addEventListener = function (t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); };
  el.removeEventListener = function () {};
  el.getBoundingClientRect = function () { return { top: 0, left: 0, bottom: 0, right: 0 }; };
  return el;
}

function loadPanelRealm() {
  const doc = {
    createElement: makeEl,
    createElementNS: function (ns, tag) { return makeEl(tag); }
  };
  const sandbox = { console, Promise, document: doc, Map, encodeURIComponent };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.innerWidth = 1440;
  sandbox.innerHeight = 900;
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/world-lighthouse-deck.js'), sandbox);
  vm.runInContext(read('public/video/world-ht-panel.js'), sandbox);
  vm.runInContext(read('public/video/world-flags.js'), sandbox);
  const SFV = sandbox.StellaflixVideo;
  assert.ok(SFV.worldHtPanel && SFV.worldLighthouseDeck && SFV.worldFlags, '三模块应同 realm 挂载');
  return SFV;
}

function findAll(el, cls, out) {
  out = out || [];
  for (const c of el.children || []) {
    if (c.classList && c.classList.contains(cls)) out.push(c);
    findAll(c, cls, out);
  }
  return out;
}
function first(el, cls) { return findAll(el, cls)[0] || null; }

test('面板集成：system+countryCode+flagUrlFor 注入 → 真国旗 img；未知码回落 avatar', () => {
  const SFV = loadPanelRealm();
  const st = { id: 'r-tk', name: '东京', position: [139.69, 35.69], status: 'playing',
    ownerType: 'system', countryCode: 'JP', city: '东京', country: '日本' };
  const p = SFV.worldHtPanel.buildPanel(st, { flagUrlFor: SFV.worldFlags.flagFramedUrl });
  const flag = first(first(p, 'station-panel__avatar-box'), 'station-panel__flag');
  assert.ok(flag && flag.tagName === 'IMG', '应出国旗 img');
  assert.equal(flag.getAttribute('src'), SFV.worldFlags.flagFramedUrl('JP'));
  assert.ok(!first(p, 'station-panel__avatar'), '出旗时不出 avatar div');

  const unknown = Object.assign({}, st, { countryCode: 'XX' });
  const p2 = SFV.worldHtPanel.buildPanel(unknown, { flagUrlFor: SFV.worldFlags.flagFramedUrl });
  assert.ok(first(p2, 'station-panel__avatar'), '未知码 flagFramedUrl=null → M 空串 → avatar 支路');
  assert.ok(!first(p2, 'station-panel__flag'), '未知码不得造旗');
});

// ---------------- world-data 十站字段（TMDB 实测值） ----------------

const EXPECT = [
  { id: 'r-sh', cc: 'CN', city: '上海', country: '中国', hash: '8sNiAPPYU14PUepFNeSNGUTiHW.jpg', ov: '近未来，地球环境持续恶化' },
  { id: 'r-tk', cc: 'JP', city: '东京', country: '日本', hash: '6oaL4DP75yABrd5EbC4H2zq5ghc.jpg', ov: '属于神灵的奇异世界' },
  { id: 'r-ny', cc: 'US', city: '纽约', country: '美国', hash: 'neeNHeXjMF5fXoCJRsOmkNGC7q.jpg', ov: '随着战争阴云笼罩世界' },
  { id: 'r-ld', cc: 'GB', city: '伦敦', country: '英国', hash: '8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg', ov: '道姆·柯布与同事阿瑟和纳什' },
  { id: 'r-pr', cc: 'FR', city: '巴黎', country: '法国', hash: '6n53UI4mX9QMfe2S0Pgt8mGebY1.jpg', ov: '艾米莉（奥黛丽·塔图' },
  { id: 'r-sy', cc: 'AU', city: '悉尼', country: '澳大利亚', hash: 'mWQg2INejtX1PCWRAN4vseadA6H.jpg', ov: '公路骑士们在道路上肆虐' },
  { id: 'r-ri', cc: 'BR', city: '里约', country: '巴西', hash: 'uvitbjFU4JqvMwIkMWHp69bmUzG.jpg', ov: '巴西里约热内卢的贫民窟' },
  { id: 'r-ct', cc: 'ZA', city: '开普敦', country: '南非', hash: 'jhM3wgWUrrOkz9r4xwV5cV5RhI4.jpg', ov: '1990 年，一艘巨大的飞船出现在地球上空' },
  { id: 'r-mb', cc: 'IN', city: '孟买', country: '印度', hash: 'u7kuUaySqXBVAtqEl9vkTkAzHV9.jpg', ov: '法兰、拉杜与兰乔' },
  { id: 'r-ms', cc: 'RU', city: '莫斯科', country: '俄罗斯', hash: '6yrbWzzrPp7pwz6zHdifspJk8t3.jpg', ov: '安德烈·塔可夫斯基' }
];

test('world-data 十站补 hearthere 槽位：system+countryCode+city/country+coverUrl(TMDB backdrop)+descriptionZh(TMDB zh-CN)', () => {
  const src = read('public/video/world-data.js');
  for (const e of EXPECT) {
    const m = src.match(new RegExp("\\{\\s*id: '" + e.id + "'[^\\n]*\\}"));
    assert.ok(m, e.id + ' 演示站应存在（单行对象）');
    const line = m[0];
    assert.ok(line.includes("ownerType: 'system'"), e.id + ' ownerType 应为 system（Qf 支路谓词）');
    assert.ok(line.includes("countryCode: '" + e.cc + "'"), e.id + ' countryCode=' + e.cc);
    assert.ok(line.includes("city: '" + e.city + "'"), e.id + ' city=' + e.city);
    assert.ok(line.includes("country: '" + e.country + "'"), e.id + ' country=' + e.country);
    assert.match(line, new RegExp("coverUrl: 'https://image\\.tmdb\\.org/t/p/[a-z0-9]+/" + e.hash.replace(/\./g, '\\.') + "'"),
      e.id + ' coverUrl 应为 TMDB 实测 backdrop');
    assert.ok(line.includes(e.ov), e.id + ' descriptionZh 应含实测 overview 特征句：' + e.ov);
  }
});

test('page-world 接线 flagUrlFor → worldFlags.flagFramedUrl；index.html 装载 world-flags.js', () => {
  const src = read('public/video/page-world.js');
  assert.match(src, /flagUrlFor: *function[\s\S]{0,120}flagFramedUrl/, 'panelOpen 应注入 flagUrlFor');
  const html = read('public/index.html');
  assert.ok(html.includes('"video/world-flags.js"'), 'index.html 装载清单应含 world-flags.js');
});

test('deck roomToStation 透传卡片槽位字段（city/region/country/coverUrl/descriptionZh；缺省不凭空造值）', () => {
  const SFV = loadPanelRealm();
  const deck = SFV.worldLighthouseDeck;
  const raw = { id: 'r-x', roomId: 'room-x', name: '测试', lon: 1, lat: 2, status: 'online',
    city: '测试城', region: '测试区', country: '测试国',
    coverUrl: 'https://image.tmdb.org/t/p/w780/abc.jpg', descriptionZh: '中文简介' };
  const st = deck.roomToStation(raw);
  assert.equal(st.city, '测试城');
  assert.equal(st.region, '测试区');
  assert.equal(st.country, '测试国');
  assert.equal(st.coverUrl, raw.coverUrl);
  assert.equal(st.descriptionZh, '中文简介');
  const st2 = deck.roomToStation(Object.assign({ position: [1, 2] }, raw));
  assert.equal(st2.city, '测试城', 'station 形状 passthrough 分支同透传');
  assert.equal(st2.coverUrl, raw.coverUrl);
  const bare = deck.roomToStation({ id: 'r-y', roomId: 'room-y', name: '无槽', lon: 3, lat: 4 });
  assert.ok(!('city' in bare) && !('coverUrl' in bare) && !('descriptionZh' in bare),
    '缺省字段不得凭空造值（:111-119 谓词风格）');
});

// ---------------- 轮⑳：地球头顶悬浮国旗（Ur :7266 Qf 支路） ----------------

test('轮⑳ stationAvatarUrl：system+countryCode → Qf 装框旗（Ur :7266 逐字支路）', () => {
  const SFV = loadPanelRealm();
  const st = { id: 'r-tk', name: '东京', position: [139.69, 35.69], status: 'playing',
    ownerType: 'system', countryCode: 'JP' };
  assert.equal(SFV.worldLighthouseDeck.stationAvatarUrl(st),
    SFV.worldFlags.flagFramedUrl('JP'),
    'system 站头顶"头像"应为带框国旗（hearthere :13506 avatar-layer 消费 Ur → Qf）');
});

test('轮⑳ stationAvatarUrl：未知国家码 → cs 首字母兜底（Qf miss→cs 语义等价）', () => {
  const SFV = loadPanelRealm();
  const st = { id: 'r-zz', name: '无名', position: [0, 0], status: 'online',
    ownerType: 'system', countryCode: 'XX' };
  const url = SFV.worldLighthouseDeck.stationAvatarUrl(st);
  assert.match(url, /^data:image\/svg\+xml,/);
  assert.ok(decodeURIComponent(url).includes('viewBox="0 0 128 128"'), '应为 cs 首字母圆');
  assert.ok(!decodeURIComponent(url).includes('x="10" y="28"'), '未知码不得造旗');
});

test('轮⑳ stationAvatarUrl：avatarUrl 存在时优先链不动（user→cs，其余→avatarUrl 直喂）', () => {
  const SFV = loadPanelRealm();
  const user = { id: 'r-u', name: '用户站', position: [0, 0], ownerType: 'user',
    avatarUrl: 'https://cdn.example/a.png', countryCode: 'JP' };
  assert.ok(SFV.worldLighthouseDeck.stationAvatarUrl(user).startsWith('data:image/svg+xml,'),
    'user+avatarUrl → 首字母（ks/Nr 归一链属 Supabase 面，裁决不用）');
  const other = { id: 'r-o', name: '其他站', position: [0, 0], ownerType: 'other',
    avatarUrl: 'https://cdn.example/o.png', countryCode: 'JP' };
  assert.equal(SFV.worldLighthouseDeck.stationAvatarUrl(other), 'https://cdn.example/o.png',
    '非 user+avatarUrl 直喂，Qf 支路不改其优先序');
});

test('轮⑳ 装配期 photoIds=头像就绪集（轮㉑ 起：非全量，未预热 SVG 不入集）', () => {
  const src = read('public/video/world-lighthouse-deck.js');
  const m = src.match(/avatarPrepareSet\(\{[\s\S]{0,800}?\n *\}\);/);
  assert.ok(m, 'refresh 内 avatarPrepareSet 调用应存在');
  const call = m[0];
  assert.match(call, /photoIds: *stationAvatarIdSet\(\)|photoIds: *new Set\(/,
    'photoIds 应为头像就绪集（现 EMPTY_ID_SET 使 Hh 子层恒空 → 头顶无旗）');
  assert.ok(!/photoIds: *EMPTY_ID_SET/.test(call), '装配期不得再传恒空集');
});

// ---------------- 轮㉑ 地球头像 SVG→PNG 光栅预热（deck IconManager 走 createImageBitmap，Chrome 拒 SVG）----------------

test('轮㉑ globeAvatarUrl：http 头像直喂（deck 自解 PNG/JPG，无需光栅）', () => {
  const SFV = loadPanelRealm();
  const st = { id: 'r-h', name: 'H', position: [0, 0], ownerType: 'system',
    avatarUrl: 'https://cdn.example.com/a.png' };
  assert.equal(SFV.worldLighthouseDeck.globeAvatarUrl(st), 'https://cdn.example.com/a.png');
});

test('轮㉑ globeAvatarUrl：SVG 头像未预热→null、光栅就绪后→PNG；in-flight 去重 + 缓存命中不重复', async () => {
  const SFV = loadPanelRealm();
  const deck = SFV.worldLighthouseDeck;
  let calls = 0;
  deck.__setAvatarRasterizer(function () { calls++; return Promise.resolve('data:image/png;base64,PNGBLOB'); });
  const st = { id: 'r-tk', name: '东京', position: [139.69, 35.69], ownerType: 'system', countryCode: 'JP' };
  assert.equal(deck.globeAvatarUrl(st), null, '首次未预热 → null（hasPhoto=false 跳过，光晕仍画）');
  assert.equal(calls, 1, '触发一次光栅化');
  deck.globeAvatarUrl(st); deck.globeAvatarUrl(st);
  assert.equal(calls, 1, 'in-flight 去重，不重复排队');
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(deck.globeAvatarUrl(st), 'data:image/png;base64,PNGBLOB', '就绪后返回 PNG data-uri');
  assert.equal(calls, 1, '缓存命中不再光栅');
});

test('轮㉑ globeAvatarUrl：无 DOM（Node/vm）默认光栅器安全降级为 null，不抛', () => {
  const SFV = loadPanelRealm();
  const st = { id: 'r-tk', name: '东京', position: [139.69, 35.69], ownerType: 'system', countryCode: 'JP' };
  assert.equal(SFV.worldLighthouseDeck.globeAvatarUrl(st), null, '默认 rasterizer 无 Image → reject 被吞 → null');
});

test('轮㉑ lmAvatarData 地球头像走 globeAvatarUrl（http 直喂；SVG 未预热 avatarUrl=null）', () => {
  const SFV = loadPanelRealm();
  const deck = SFV.worldLighthouseDeck;
  const httpSt = { id: 'r-h', name: 'H', position: [1, 2], ownerType: 'system', avatarUrl: 'https://x/y.png' };
  const d = deck.lmAvatarData(httpSt, function () { return 1; }, function () { return 50; });
  assert.equal(d.avatarUrl, 'https://x/y.png', 'http 头像 lmAvatarData 直喂');
  const svgSt = { id: 'r-tk', name: '东京', position: [1, 2], ownerType: 'system', countryCode: 'JP' };
  const d2 = deck.lmAvatarData(svgSt, function () { return 1; }, function () { return 50; });
  assert.equal(d2.avatarUrl, null, 'SVG 头像未预热 → null（旧实现返回 SVG，deck 画不出=本轮真机根因）');
});

test('轮㉑ 源码接线：photoIds 取就绪集 + avatar slot 键含预热代际 + lmAvatarData 用 globeAvatarUrl', () => {
  const src = read('public/video/world-lighthouse-deck.js');
  assert.match(src, /function stationAvatarIdSet\(\)[\s\S]{0,400}globeAvatarUrl\(/,
    'stationAvatarIdSet 应按 globeAvatarUrl 就绪过滤（非恒全量）');
  assert.match(src, /slotBase\('avatar',[^)]*_avatarWarmGen/,
    'avatar slot 键须含 _avatarWarmGen，令预热完成后重建浮现国旗');
  assert.match(src, /avatarUrl: *globeAvatarUrl\(st\)/, 'lmAvatarData 地球头像用 globeAvatarUrl');
});

// ---------------- 轮㉓ hearthere 真机截图裁决：国旗=矩形装框旗（Qf 108×72 圆角矩形即正确形态），轮㉒圆形方案作废回退 ----------------

test('轮㉓ globeAvatarUrl：国旗站光栅输入须为 Qf 装框旗（矩形同款，铺满 quad 的圆形方案作废）', async () => {
  const SFV = loadPanelRealm();
  const deck = SFV.worldLighthouseDeck;
  let fed = null;
  deck.__setAvatarRasterizer(function (svgUrl) {
    fed = svgUrl;
    return Promise.resolve('data:image/png;base64,PNGBLOB');
  });
  const st = { id: 'r-tk', name: '东京', position: [139.69, 35.69], ownerType: 'system', countryCode: 'JP' };
  assert.equal(deck.globeAvatarUrl(st), null, '首次触发光栅');
  const decoded = decodeURIComponent(fed || '');
  assert.ok(decoded.includes('x="10" y="28"'), '地球光栅输入须为 Qf 装框旗（hearthere 真机=矩形国旗）');
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(deck.globeAvatarUrl(st), 'data:image/png;base64,PNGBLOB');
  const panel = decodeURIComponent(deck.stationAvatarUrl(st));
  assert.ok(panel.includes('x="10" y="28"'), '面板/卡片路径同为 Qf 装框旗');
});

// ---------------- 轮㉓-B 国旗光晕真源：Kh 光晕子层 = rc 基类无 compact（xh 柔光、无 zoom 淡出），移植笔误修正 ----------------

test('轮㉓-B xh 柔光 shader 逐字（:10836-10857）：coreSize 0.4 / inner 0.6^2.5 / outer 0.85^5 / combined 0.08', () => {
  const SFV = loadPanelRealm();
  const xh = SFV.worldLighthouseDeck.SHADER_INJECT_GLOW_FS_SOFT || '';
  assert.ok(xh.length > 0, '必须导出 SHADER_INJECT_GLOW_FS_SOFT（xh）');
  assert.match(xh, /float coreSize = 0\.4;/);
  assert.match(xh, /core = pow\(core, 1\.2\);/);
  assert.match(xh, /float innerGlow = 1\.0 - smoothstep\(0\.0, 0\.6, dist\);/);
  assert.match(xh, /innerGlow = pow\(innerGlow, 2\.5\);/);
  assert.match(xh, /float outerGlow = 1\.0 - smoothstep\(0\.0, 0\.85, dist\);/);
  assert.match(xh, /outerGlow = pow\(outerGlow, 5\.0\);/);
  assert.match(xh, /float combinedGlow = core \* 0\.8 \+ innerGlow \* 0\.15 \+ outerGlow \* 0\.08;/);
  assert.match(xh, /fragColor\.a \*= combinedGlow;/);
  assert.ok(!/presenceGlow\.zoom/.test(xh), 'xh 本体不含 zoom 淡出（Ph 属 Ah 子类）');
});

test('轮㉓-B 类层级对照 rc/Ah（:10858-10949）：rc 基类按 compact 选 Sh/xh 且无淡出，Ah 子类才拼 ZOOM_FADE+presenceGlow', () => {
  const src = read('public/video/world-lighthouse-deck.js');
  assert.match(src, /class GlowScatterplotLayer extends deckGlobal\.ScatterplotLayer/,
    '须有 rc 等价位基类 GlowScatterplotLayer');
  assert.match(src, /class PresenceGlowScatterplotLayer extends GlowScatterplotLayer/,
    'Ah 等价位须为基类子类（hearthere :10925 class Ah extends rc）');
  assert.match(src, /compact === true \? GLOW_FS_COMPACT : GLOW_FS_SOFT/,
    'rc.getShaders 须逐字 compact ? Sh : xh（:10890-10896）');
  assert.match(src, /GLOW_FS_ZOOM_FADE/, '淡出仅由 Ah 子类注入');
  const ahIdx = src.indexOf('class PresenceGlowScatterplotLayer');
  const rcIdx = src.indexOf('class GlowScatterplotLayer extends');
  assert.ok(ahIdx > rcIdx && rcIdx > 0, 'PresenceGlow 定义须在基类之后（extends 顺序）');
  const ahBody = src.slice(ahIdx, src.indexOf('if (!CircleAvatarLayer)'));
  assert.match(ahBody, /GLOW_FS_ZOOM_FADE/, 'Ah 子类 getShaders 拼 Ph');
  assert.match(ahBody, /presenceGlow/, 'Ah 子类挂 presenceGlow UBO + draw 推 zoom');
  const rcBody = src.slice(rcIdx, ahIdx);
  assert.ok(!/GLOW_FS_ZOOM_FADE/.test(rcBody), 'rc 基类不得含 zoom 淡出');
});

test('轮㉓-B Kh 光晕子层（:11251-11278）：new rc 无 compact → xh 柔光常亮，高 zoom 不被淡出乘没', () => {
  const src = read('public/video/world-lighthouse-deck.js');
  const start = src.indexOf("id: e.id + '-glow'");
  assert.ok(start > 0, "Kh 光晕子层构造应存在");
  const block = src.slice(Math.max(src.lastIndexOf('new ', start), start - 200), src.indexOf('var y = u * 2 * d', start));
  assert.match(block, /new GlowScatterplotLayer\(/,
    'Kh 位须用 rc 基类（现用 Ah 等价位 GlowLayer = 淡出误挂根因）');
  assert.ok(!/compact/.test(block),
    'hearthere :11251 new rc 无 compact 键 → 走 xh 柔光；compact:true 属 Dh（:10991）');
  assert.match(block, /blendFunc: \[770, 1\]/, 'additive ONE/ONE 保持（:11268）');
  assert.match(block, /depthWriteEnabled: false/, 'depthWrite 关保持（:11269）');
});
