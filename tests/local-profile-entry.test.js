'use strict';

/**
 * tests/local-profile-entry.test.js — 任务16a：个人中心入口改本地档案页
 *
 * 契约（主人 10-25 定稿，见 .superpowers/sdd/2026-10-18-lx-source-alignment/task-16a-brief.md）：
 *  ① 存储：localStorage['stellaflix-local-profile-v1'] = { nickname, avatar }；
 *     昵称 ≤16 字符（码点计），展示前 HTML 转义；头像 = canvas 256px 方形 cover 裁切
 *     → JPEG dataURL；仅接受 data:image 前缀，脏值回退默认。
 *  ② 入口：右上角常驻单胶囊（始终头像+昵称，未设置时默认头像+「未设置昵称」），
 *     点开即本地档案页；不再有登录/退出概念。
 *  ③ 保留：收听统计卡（usage-total-time / usage-today-time，06-usage-tracker 那套）。
 *  ④ 删除（DOM/绑定层面）：#login-modal 整套（五平台行、node-graph、二维码、Cookie 粘贴、
 *     退出登录）与 #user-modal 里的五平台 tab、补登按钮、VIP 行、退出行。
 *     （08-account 旧 JS 文件的物理删除属 16b/16c，本测只钉 DOM 与入口行为。）
 *
 * 手法：vm + 模块整文件装载（新模块设计为自含 + typeof 守卫外部依赖），
 * index.html / index-loader.js 静态断言；不起服务器、不触网。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const P_PROFILE = 'public/js/modules/08-account/07-local-profile.js';
const P_LOADER = 'public/js/index-loader.js';
const P_HTML = 'public/index.html';

const BASE_GLOBALS = {
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  Date, Math, JSON, String, Number, Array, Object, Boolean, Promise, RegExp, Error,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
  Set, Map, Symbol, TypeError, RangeError,
  setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
  clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: (fn) => { if (typeof fn === 'function') fn(); return 0; },
  cancelAnimationFrame() {},
  addEventListener() {}, removeEventListener() {},
};

function makeEl(id) {
  const el = {
    id,
    innerHTML: '', textContent: '', value: '', src: '', title: '', alt: '',
    disabled: false, className: '', files: null, dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    _classes: new Set(),
  };
  el.classList = {
    add(...names) { names.forEach((c) => el._classes.add(c)); },
    remove(...names) { names.forEach((c) => el._classes.delete(c)); },
    toggle(name, force) {
      const on = force === undefined ? !el._classes.has(name) : !!force;
      if (on) el._classes.add(name); else el._classes.delete(name);
      return on;
    },
    contains(name) { return el._classes.has(name); },
  };
  el.setAttribute = (k, v) => { el[k] = v; };
  el.getAttribute = (k) => (el[k] == null ? null : String(el[k]));
  el.removeAttribute = () => {};
  el.addEventListener = () => {};
  el.removeEventListener = () => {};
  el.appendChild = (c) => c;
  el.querySelector = () => null;
  el.querySelectorAll = () => [];
  el.closest = () => null;
  el.contains = () => false;
  el.focus = () => {};
  el.blur = () => {};
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
  return el;
}

function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    _map: map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function makeCanvasStub(recorder) {
  return () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      clearRect() {},
      // 生产侧先铺白底再 drawImage（JPEG 无 alpha）；桩要能接住这一步并留下证据。
      fillRect(x, y, w, h) { recorder.fillRectCalls.push({ x, y, w, h }); },
      set fillStyle(v) { recorder.fillStyle = v; },
      drawImage(img, dx, dy, dw, dh) { recorder.drawCalls.push({ img, dx, dy, dw, dh }); },
    }),
    toDataURL(mime, quality) {
      recorder.toDataURLCalls.push({ mime, quality });
      return 'data:image/jpeg;base64,FAKEJPEG';
    },
  });
}

/**
 * 装载 07-local-profile.js 全模块。
 * options: { storageSeed, elements（id→makeEl 覆盖）, readerResult, imageSpec }
 */
function loadProfileModule(options) {
  options = options || {};
  const recorder = { drawCalls: [], toDataURLCalls: [], fillRectCalls: [], fillStyle: '' };
  const loginModalOpens = [];
  const gsapOpens = [];
  const toasts = [];
  const els = new Map();
  const register = (id) => {
    const el = options.elements && options.elements[id] ? options.elements[id] : makeEl(id);
    els.set(id, el);
    return el;
  };
  ['user-btn', 'user-modal', 'user-modal-avatar', 'user-modal-name',
    'local-profile-nickname', 'local-profile-avatar-file'].forEach(register);

  const documentStub = {
    readyState: 'complete',
    hidden: false,
    getElementById: (id) => (els.has(id) ? els.get(id) : null),
    createElement: (tag) => (tag === 'canvas' ? makeCanvasStub(recorder)() : makeEl(tag)),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: makeEl('body'),
  };
  function FileReaderStub() {
    const self = this;
    this.readAsDataURL = (file) => {
      // 同步触发：vm 切片测试要求头像读取链可确定性执行。
      if (typeof self.onload === 'function') self.onload({ target: { result: options.readerResult || 'data:image/png;base64,FAKESRC' } });
    };
  }
  function ImageStub() {
    const self = this;
    Object.defineProperty(this, 'src', {
      set() {
        self.width = (options.imageSpec && options.imageSpec.width) || 400;
        self.height = (options.imageSpec && options.imageSpec.height) || 200;
        if (typeof self.onload === 'function') self.onload();
      },
      get() { return ''; },
    });
  }
  const sandbox = Object.assign({}, BASE_GLOBALS, {
    document: documentStub,
    localStorage: makeStorage(options.storageSeed),
    FileReader: FileReaderStub,
    Image: ImageStub,
    // 旧登录链桩：新入口绝不允许再触碰它们。
    showLoginModal: (opts) => { loginModalOpens.push(opts || {}); },
    hasAnyPlatformLogin: () => !!options.anyPlatformLogin,
    openGsapModal: (mask) => { gsapOpens.push(mask); },
    showToast: (msg) => { toasts.push(String(msg)); },
  });
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  assert.ok(fs.existsSync(path.join(ROOT, P_PROFILE)), '本地档案模块必须存在: ' + P_PROFILE);
  const source = read(P_PROFILE);
  vm.runInContext(
    'try {\n' + source + '\n; window.__exports = {' +
    'LOCAL_PROFILE_STORE_KEY, LOCAL_PROFILE_NICKNAME_MAX, LOCAL_PROFILE_AVATAR_SIZE,' +
    'localProfileEscapeHtml, normalizeLocalProfileNickname, readLocalProfile, writeLocalProfile,' +
    'localProfileAvatarSrc, processLocalProfileAvatarImage, readLocalProfileAvatarFile,' +
    'renderUserBtn, updateUserModalUi, showUserModal, onUserBtnClick, saveLocalProfileForm,' +
    'onLocalProfileAvatarFile };\n} catch (e) { window.__loadError = e; }\n',
    sandbox,
    { filename: 'local-profile-entry.07-local-profile.js' },
  );
  if (sandbox.__loadError) {
    throw new Error('07-local-profile.js 装载失败: ' + (sandbox.__loadError.stack || String(sandbox.__loadError)));
  }
  return {
    exports: sandbox.__exports,
    sandbox,
    els,
    recorder,
    calls: { loginModalOpens, gsapOpens, toasts },
  };
}

function htmlRegion(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.notEqual(start, -1, 'index.html 应包含 ' + startMarker);
  const end = html.indexOf(endMarker, start);
  assert.notEqual(end, -1, 'index.html 应在 ' + startMarker + ' 之后包含 ' + endMarker);
  return html.slice(start, end);
}

// ---------- ① 存储读写与键名 ----------

test('16a-1 存储：键名 = stellaflix-local-profile-v1，读写往返 {nickname, avatar}', () => {
  const ctx = loadProfileModule({});
  const key = ctx.exports.LOCAL_PROFILE_STORE_KEY;
  assert.equal(key, 'stellaflix-local-profile-v1');
  ctx.exports.writeLocalProfile({ nickname: '小星', avatar: 'data:image/jpeg;base64,AAA' });
  const raw = ctx.sandbox.localStorage.getItem(key);
  assert.equal(JSON.parse(raw).nickname, '小星');
  assert.equal(JSON.parse(raw).avatar, 'data:image/jpeg;base64,AAA');
  const back = ctx.exports.readLocalProfile();
  assert.equal(back.nickname, '小星');
  assert.equal(back.avatar, 'data:image/jpeg;base64,AAA');
});

test('16a-2 存储：空/损坏 JSON/非 dataURL 头像一律回退默认空档案', () => {
  // 注：vm 沙箱回传的对象带沙箱 realm 原型，只断字段值、不做跨 realm deepEqual。
  const empty = loadProfileModule({});
  const emptyProfile = empty.exports.readLocalProfile();
  assert.equal(emptyProfile.nickname, '');
  assert.equal(emptyProfile.avatar, '');

  const corrupt = loadProfileModule({ storageSeed: { 'stellaflix-local-profile-v1': '{坏档' } });
  const corruptProfile = corrupt.exports.readLocalProfile();
  assert.equal(corruptProfile.nickname, '');
  assert.equal(corruptProfile.avatar, '');

  const badAvatar = loadProfileModule({
    storageSeed: { 'stellaflix-local-profile-v1': JSON.stringify({ nickname: '甲', avatar: 'https://evil.example/a.jpg' }) },
  });
  assert.equal(badAvatar.exports.readLocalProfile().avatar, '');
  assert.equal(badAvatar.exports.readLocalProfile().nickname, '甲');
});

// ---------- 昵称钳制与转义 ----------

test('16a-3 昵称：≤16 码点钳制（按 Array.from 计，emoji 也按码点）', () => {
  const ctx = loadProfileModule({});
  assert.equal(ctx.exports.LOCAL_PROFILE_NICKNAME_MAX, 16);
  assert.equal(ctx.exports.normalizeLocalProfileNickname('一二三四五六七八九十甲乙丙丁戊己庚'), '一二三四五六七八九十甲乙丙丁戊己');
  assert.equal(ctx.exports.normalizeLocalProfileNickname('😀'.repeat(17)), '😀'.repeat(16));
  assert.equal(ctx.exports.normalizeLocalProfileNickname(null), '');
});

test('16a-4 昵称展示 HTML 转义：胶囊 innerHTML 注入 <script> 必须被转义', () => {
  const ctx = loadProfileModule({
    storageSeed: { 'stellaflix-local-profile-v1': JSON.stringify({ nickname: '<script>alert(1)</script>&"x', avatar: '' }) },
  });
  assert.equal(ctx.exports.localProfileEscapeHtml('<a & "b\' c>'), '&lt;a &amp; &quot;b&#39; c&gt;');
  ctx.exports.renderUserBtn();
  const html = ctx.els.get('user-btn').innerHTML;
  assert.ok(html.includes('&lt;script&gt;'), '胶囊须转义昵称: ' + html);
  assert.ok(!html.includes('<script>'), '胶囊不得留原始 <script>');
});

// ---------- 胶囊常驻渲染（覆盖 renderUserBtn） ----------

test('16a-5 胶囊常驻：未登录任何平台也显示头像+「未设置昵称」', () => {
  const ctx = loadProfileModule({ anyPlatformLogin: false });
  ctx.exports.renderUserBtn();
  const btn = ctx.els.get('user-btn');
  assert.ok(btn.innerHTML.includes('top-account-pill'), '胶囊应复用 top-account-pill 结构: ' + btn.innerHTML);
  assert.ok(btn.innerHTML.includes('未设置昵称'), '未设置昵称时给中性文案');
  assert.ok(btn.innerHTML.includes('<img'), '常驻结构必须含头像 img');
  assert.ok(!btn.classList.contains('logged-out'), '不再有 logged-out 登录态');
  assert.ok(!btn.classList.contains('login-eye-avatar'), '不再有登录眼睛态');
  assert.equal(ctx.calls.loginModalOpens.length, 0, '胶囊渲染不得触发平台登录链');
});

test('16a-6 胶囊：已设置档案时显示档案头像与昵称；平台登录态不改变输出', () => {
  const seed = { 'stellaflix-local-profile-v1': JSON.stringify({ nickname: '小星', avatar: 'data:image/jpeg;base64,AAA' }) };
  const loggedOut = loadProfileModule({ storageSeed: seed, anyPlatformLogin: false });
  loggedOut.exports.renderUserBtn();
  const loggedIn = loadProfileModule({ storageSeed: seed, anyPlatformLogin: true });
  loggedIn.exports.renderUserBtn();
  const html = loggedOut.els.get('user-btn').innerHTML;
  assert.ok(html.includes('data:image/jpeg;base64,AAA'));
  assert.ok(html.includes('小星'));
  assert.equal(html, loggedIn.els.get('user-btn').innerHTML, '胶囊与五平台登录态解耦');
});

test('16a-7 默认头像：未设置档案时头像是内联 data:image 占位，不是空 src', () => {
  const ctx = loadProfileModule({});
  const src = ctx.exports.localProfileAvatarSrc(ctx.exports.readLocalProfile());
  assert.match(src, /^data:image\//);
});

// ---------- 入口：点开即本地档案页 ----------

test('16a-8 onUserBtnClick/showUserModal 打开本地档案页，绝不拉起平台登录弹窗', () => {
  const ctx = loadProfileModule({ anyPlatformLogin: false });
  ctx.exports.onUserBtnClick();
  assert.equal(ctx.calls.gsapOpens.length, 1, '应经 openGsapModal 打开 user-modal');
  assert.equal(ctx.calls.gsapOpens[0], ctx.els.get('user-modal'));
  assert.equal(ctx.calls.loginModalOpens.length, 0, '不得再调用 showLoginModal');
});

test('16a-9 弹窗填充：头像/昵称行/输入框来自本地档案，昵称经 textContent 原样写入', () => {
  const seed = { 'stellaflix-local-profile-v1': JSON.stringify({ nickname: '<b>小星</b>', avatar: 'data:image/jpeg;base64,AAA' }) };
  const ctx = loadProfileModule({ storageSeed: seed });
  ctx.exports.updateUserModalUi();
  assert.equal(ctx.els.get('user-modal-avatar').src, 'data:image/jpeg;base64,AAA');
  assert.equal(ctx.els.get('user-modal-name').textContent, '<b>小星</b>');
  assert.equal(ctx.els.get('local-profile-nickname').value, '<b>小星</b>');
});

test('16a-10 保存表单：昵称钳制 16 码点后落盘并重渲染胶囊', () => {
  const ctx = loadProfileModule({});
  ctx.els.get('local-profile-nickname').value = '一二三四五六七八九十甲乙丙丁戊己庚辛壬';
  ctx.exports.saveLocalProfileForm();
  const saved = JSON.parse(ctx.sandbox.localStorage.getItem('stellaflix-local-profile-v1'));
  assert.equal(saved.nickname, '一二三四五六七八九十甲乙丙丁戊己');
  assert.ok(ctx.els.get('user-btn').innerHTML.includes('一二三四五六七八九十甲乙丙丁戊己'));
});

// ---------- 头像 canvas 256 方形 cover 裁切 → JPEG dataURL ----------

test('16a-11 头像：canvas 恒 256×256，cover 裁切（横图压高、竖图压宽），导出 JPEG dataURL', () => {
  const ctx = loadProfileModule({});
  assert.equal(ctx.exports.LOCAL_PROFILE_AVATAR_SIZE, 256);

  const wide = ctx.exports.processLocalProfileAvatarImage({ width: 400, height: 200 });
  assert.equal(wide, 'data:image/jpeg;base64,FAKEJPEG');
  let draw = ctx.recorder.drawCalls[0];
  // 400×200 → scale = 256/200 = 1.28 → 512×256，横向溢出居中裁掉
  assert.equal(draw.dw, 512);
  assert.equal(draw.dh, 256);
  assert.equal(draw.dx, -128);
  assert.equal(draw.dy, 0);

  ctx.exports.processLocalProfileAvatarImage({ width: 200, height: 400 });
  draw = ctx.recorder.drawCalls[1];
  // 200×400 → scale = 256/200 = 1.28 → 256×512，纵向居中裁切
  assert.equal(draw.dw, 256);
  assert.equal(draw.dh, 512);
  assert.equal(draw.dx, 0);
  assert.equal(draw.dy, -128);

  ctx.recorder.toDataURLCalls.forEach((call) => assert.equal(call.mime, 'image/jpeg'));
  assert.ok(ctx.recorder.toDataURLCalls.length >= 2);
});

test('16a-12 头像文件链：FileReader→Image→canvas 裁切→落盘档案并刷新 UI', () => {
  const ctx = loadProfileModule({ imageSpec: { width: 300, height: 100 } });
  const file = { name: 'a.png', type: 'image/png' };
  let doneWith = null;
  ctx.exports.readLocalProfileAvatarFile(file, (err, dataUrl) => { doneWith = { err, dataUrl }; });
  assert.equal(doneWith && doneWith.err, null);
  assert.equal(doneWith.dataUrl, 'data:image/jpeg;base64,FAKEJPEG');

  const input = ctx.els.get('local-profile-avatar-file');
  input.files = [file];
  ctx.exports.onLocalProfileAvatarFile(input);
  const saved = JSON.parse(ctx.sandbox.localStorage.getItem('stellaflix-local-profile-v1'));
  assert.equal(saved.avatar, 'data:image/jpeg;base64,FAKEJPEG');
  assert.equal(ctx.els.get('user-modal-avatar').src, 'data:image/jpeg;base64,FAKEJPEG');
});

// ---------- index.html DOM 收口 ----------

test('16a-13 index.html：#login-modal 整套（五平台行/node-graph/二维码/Cookie/退出登录）已不在 DOM', () => {
  const html = read(P_HTML);
  for (const marker of [
    'id="login-modal"', 'id="login-node-graph"', 'id="login-platform-tabs"',
    'id="login-provider-qq"', 'id="qr-img"', 'id="qq-cookie-input"',
    'id="login-reset-all-btn"', 'logoutAllAccountsAndResetEasterEgg()',
  ]) {
    assert.ok(!html.includes(marker), '登录弹窗残留: ' + marker);
  }
});

test('16a-14 index.html：#user-modal 改本地档案页——五平台 tab/补登/VIP 行/退出行已不在 DOM', () => {
  const html = read(P_HTML);
  const region = htmlRegion(html, 'id="user-modal"', 'id="cover-crop-modal"');
  for (const marker of [
    'openProviderLogin', 'logoutActiveAccount', 'setActiveAccountProvider',
    'enableDualAccountView', 'account-add-', 'user-provider-',
    'account-provider-chip', 'user-modal-vip', 'account-logout-btn',
  ]) {
    assert.ok(!region.includes(marker), 'user-modal 残留平台登录内容: ' + marker);
  }
  assert.ok(region.includes('local-profile-nickname'), '档案页应有昵称输入');
  assert.ok(region.includes('local-profile-avatar-file') || region.includes('pickLocalProfileAvatar'), '档案页应有头像选择入口');
});

test('16a-15 index.html：收听统计卡保留在档案页内（usage-total-time/usage-today-time）', () => {
  const html = read(P_HTML);
  const region = htmlRegion(html, 'id="user-modal"', 'id="cover-crop-modal"');
  assert.ok(region.includes('id="usage-total-time"'), '统计卡总时长须在 user-modal 内');
  assert.ok(region.includes('id="usage-today-time"'), '统计卡今日时长须在 user-modal 内');
});

test('16a-16 index.html：右上角胶囊入口常驻——#user-btn 静态 markup 即含头像+昵称结构', () => {
  const html = read(P_HTML);
  const region = htmlRegion(html, 'id="user-btn"', 'id="sfv-search-page"');
  assert.ok(region.includes('onUserBtnClick()'), '入口仍绑 onUserBtnClick');
  assert.ok(region.includes('top-account-pill'), '静态 markup 即为胶囊结构（常驻，不再空壳「登录」）');
  assert.ok(region.includes('<img'), '静态 markup 含头像 img');
  assert.ok(!region.includes('>登录<'), '不再有裸「登录」文字入口');
});

// ---------- loader 注册 ----------

test('16a-17 index-loader：07-local-profile.js 登记在 08-account 连续段内（06-usage-tracker 之后）', () => {
  const loader = read(P_LOADER);
  const paths = [...loader.matchAll(/'(js\/modules\/08-account\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.includes('js/modules/08-account/07-local-profile.js'), '新模块必须进 modulePaths');
  const idx = paths.indexOf('js/modules/08-account/07-local-profile.js');
  assert.ok(idx > paths.indexOf('js/modules/08-account/04-user-modal-logout.js'), '覆盖声明必须排在被覆盖的旧入口之后');
  assert.ok(idx > paths.indexOf('js/modules/08-account/06-usage-tracker.js'), '06 统计卡之后');
});

// ---------- ⑱ 拼接序集成：真·bundle 语义（单脚本内同名 function 声明最后一条生效） ----------

test('16a-18 拼接 01+02+04+07（08-account 段真实顺序）后，入口全局必须解析到本地档案版本', () => {
  // bundle 把 08-account 连续段拼进同一启动 <script>：function 声明整体提升、
  // 后声明覆盖前声明。这里按 manifest 真实顺序拼接装载，钉死覆盖语义。
  const ctx = loadProfileModule({ anyPlatformLogin: true });
  const oldSources = [
    'public/js/modules/08-account/01-login-modal-utils.js',
    'public/js/modules/08-account/02-login-status.js',
    'public/js/modules/08-account/04-user-modal-logout.js',
  ].map(read).join('\n');
  const sandbox = ctx.sandbox;
  // 旧 02/04 顶层引用的运行时全局最小桩（只为可拼接装载，不代表旧入口生效）。
  vm.runInContext('var loginStatus={},qqLoginStatus={},kugouLoginStatus={},qishuiLoginStatus={},spotifyLoginStatus={};' +
    'var PROVIDER_VIP_AUDIT_STORE_KEY="audit",QQ_PLAYBACK_VIP_EVIDENCE_STORE_KEY="evv";' +
    'window.updatePlaybackQualityUi=function(){};window.avatarSrc=function(u){return String(u||"");};', sandbox);
  vm.runInContext(
    'try {\n' + oldSources + '\n' + read(P_PROFILE) +
    '\n; window.__wiring = { renderUserBtn: renderUserBtn, onUserBtnClick: onUserBtnClick };\n' +
    '} catch (e) { window.__loadError = e; }\n',
    sandbox,
    { filename: 'local-profile-entry.08-account-concat.js' },
  );
  assert.ok(!sandbox.__loadError, '拼接装载不得报错: ' + (sandbox.__loadError && sandbox.__loadError.stack));
  sandbox.__wiring.renderUserBtn();
  const html = ctx.els.get('user-btn').innerHTML;
  assert.ok(html.includes('data-account-provider="local"'), '胶囊必须来自 07 本地档案实现: ' + html);
  assert.ok(!/data-account-provider="(netease|qq|kugou|qishui|spotify)"/.test(html), '不得再渲染五平台胶囊');
  // 拼接后 01 的真 openGsapModal 接管沙箱全局，断 DOM 态而非桩调用数。
  sandbox.__wiring.onUserBtnClick();
  assert.ok(ctx.els.get('user-modal').classList.contains('show'), '入口点击直达本地档案页（mask 进入 show 态）');
  assert.equal(ctx.calls.loginModalOpens.length, 0, '拼接后 onUserBtnClick 仍不得拉起平台登录');
});
