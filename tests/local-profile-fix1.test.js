'use strict';

/**
 * tests/local-profile-fix1.test.js — 16a scoped 复审回批（I-1 / I-2 / I-3）
 *
 *  I-1 「扫码登录」仍留在 DOM：#trial-login-btn + 13-playback 运行期重绑 openProviderLogin，
 *      点进去是被 16a 摘掉的 #login-modal ⇒ 静默空转。主人定稿「二维码登录离开 DOM」，属违约。
 *  I-2 writeLocalProfile 吞掉 setItem 异常后仍弹「已保存本地档案」并按 storage 重绘
 *      ⇒ 配额满/隐私模式下输入内容静默回退 + 假成功。
 *  I-3 maybeRunStartupLoginGuide 每次未登录启动都放登录粒子，回调 showLoginModal({guided:true})
 *      指向已摘除的弹窗 ⇒ 承诺一个不存在的界面。
 *
 * 手法：源码/静态面断言（I-1）+ vm 片段执行并覆写同名全局以观察真实调用链（I-2/I-3），
 * 沿用 tests/local-profile-entry.test.js 与 tests/lx-source-align-fix1.test.js 惯例。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function namedFunctionSource(text, name) {
  const marker = 'function ' + name;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error('未找到函数 ' + name);
  const open = text.indexOf('{', text.indexOf(')', start));
  if (open < 0) throw new Error('函数 ' + name + ' 没有函数体');
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('函数 ' + name + ' 括号未闭合');
}

function el(id, extra) {
  return Object.assign({ id, style: {}, classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} }, textContent: '', innerHTML: '' }, extra || {});
}

// ---------------------------------------------------------------- I-1

test('I-1 试听条「扫码登录」钮与运行期重绑整套离场（平台登录 DOM 已摘，不留空转入口）', () => {
  const html = read('public', 'index.html');
  assert.equal(html.includes('trial-login-btn'), false, 'index.html 仍含 #trial-login-btn');
  assert.equal(/扫码登录/.test(html), false, 'index.html 仍出现「扫码登录」文案');

  const playback = read('public', 'js', 'modules', '05-playback', '13-playback-start-audio.js');
  assert.equal(playback.includes('trial-login-btn'), false, '13-playback 仍引用 #trial-login-btn');
  assert.equal(/trialLoginBtn/.test(playback), false, '13-playback 仍有 trialLoginBtn 重绑块');
});

test('I-1 试听条本体仍在：仅摘登录 CTA，试听文案与 banner 展示不受波及', () => {
  const html = read('public', 'index.html');
  assert.ok(html.includes('id="trial-text"'), '试听文案位 #trial-text 必须保留');
  assert.ok(html.includes("id=\"trial-banner\""), '试听条容器 #trial-banner 必须保留');
});

// ---------------------------------------------------------------- I-2

function loadProfileSandbox(options) {
  const store = options.store || {};
  const throwOnSet = !!options.throwOnSet;
  const storage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => {
      if (throwOnSet) throw new Error('QuotaExceededError');
      store[k] = String(v);
      storage.setItemCalls.push([k, String(v)]);
    },
    removeItem: (k) => { delete store[k]; },
    setItemCalls: [],
  };
  const toasts = [];
  const elements = options.elements || {};
  const document = {
    readyState: 'complete',
    getElementById: (id) => (Object.prototype.hasOwnProperty.call(elements, id) ? elements[id] : null),
    addEventListener() {},
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
    body: { classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} } },
  };
  const sandbox = {
    document,
    localStorage: storage,
    window: { localStorage: storage, addEventListener() {}, devicePixelRatio: 1 },
    navigator: { userAgent: 'node' },
    location: { href: 'http://127.0.0.1:3000/' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    encodeURIComponent,
    Image: function () {},
    FileReader: function () {},
    console,
    showToast: (msg) => toasts.push(String(msg)),
  };
  sandbox.globalThis = sandbox;
  const text = read('public', 'js', 'modules', '08-account', '07-local-profile.js');
  vm.createContext(sandbox);
  vm.runInContext(text, sandbox, { filename: '07-local-profile.js' });
  return { sandbox, storage, store, toasts };
}

test('I-2 writeLocalProfile 落盘失败要如实回报（不再静默吞异常）', () => {
  const { sandbox } = loadProfileSandbox({ throwOnSet: true, store: {} });
  const result = sandbox.writeLocalProfile({ nickname: '小星' });
  assert.equal(result.ok, false, 'setItem 抛错时 writeLocalProfile 必须回报 ok:false');
  assert.equal(result.nickname, '小星', '仍回传归一化后的入参，供调用方决定是否回滚');

  const good = loadProfileSandbox({ store: {} }).sandbox;
  assert.equal(good.writeLocalProfile({ nickname: '小星' }).ok, true, '正常写入要回报 ok:true');
});

test('I-2 保存失败不再弹「已保存本地档案」，要给用户可读的失败提示', () => {
  const nicknameInput = el('local-profile-nickname', { value: '小星' });
  const { sandbox, toasts, store } = loadProfileSandbox({
    throwOnSet: true,
    store: { 'stellaflix-local-profile-v1': '{"nickname":"旧名","avatar":""}' },
    elements: { 'local-profile-nickname': nicknameInput },
  });
  // 覆写渲染副作用，聚焦在「成功假象」本身
  sandbox.updateUserModalUi = function () {};
  sandbox.renderUserBtn = function () {};
  sandbox.saveLocalProfileForm();
  assert.equal(/已保存/.test(toasts.join('|')), false, '失败路径不得出现成功文案：' + toasts.join('|'));
  assert.ok(toasts.length >= 1, '失败必须给用户一条提示');
  assert.notEqual(store['stellaflix-local-profile-v1'], undefined, '存储里的旧档案不得被写坏');
});

test('I-2 头像写入同样按 writeLocalProfile 的回报决定成功文案', () => {
  const source = read('public', 'js', 'modules', '08-account', '07-local-profile.js');
  const body = namedFunctionSource(source, 'onLocalProfileAvatarFile');
  assert.ok(/writeLocalProfile\(/.test(body), '头像链路要走统一落盘函数');
  assert.match(body, /ok|saved/, '头像成功文案须由落盘回报决定');
});

// ---------------------------------------------------------------- I-3

function loadGuideSandbox(overrides) {
  const text = read('public', 'js', 'modules', '08-account', '05-startup-login-guide.js');
  const markerIndex = text.indexOf('// ============================================================\n//  空场待机引导');
  assert.ok(markerIndex > 0, '切片标记「空场待机引导」必须存在，否则本工装会把整份文件当登录引导段加载');
  const head = text.slice(0, markerIndex);
  assert.ok(/function maybeRunStartupLoginGuide/.test(head) && markerIndex < text.length - 1, '登录引导段切片边界不正确');
  const timers = [];
  const sandbox = {
    document: {
      readyState: 'complete',
      getElementById: () => null,
      addEventListener() {},
      querySelector: () => null,
      body: { classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} } },
    },
    window: { devicePixelRatio: 1, addEventListener() {}, gsap: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    Math,
    console,
    immersiveMode: false,
    playing: false,
    loginStatusChecked: true,
    loginStatusCheckFailed: false,
    loginStatus: { loggedIn: false },
    reduceSplashMotion: false,
    showLoginModal: function () { sandbox.showLoginModalCalls++; },
    showLoginModalCalls: 0,
  };
  Object.assign(sandbox, overrides || {});
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(head, sandbox, { filename: '05-startup-login-guide.js' });
  return { sandbox, timers };
}

test('I-3 启动登录引导不再启动（弹窗已摘，粒子不得再放给不存在的界面）', () => {
  const particles = [];
  const { sandbox, timers } = loadGuideSandbox();
  sandbox.runLoginGuideParticles = function (done) { particles.push(done); if (done) done(); };
  sandbox.maybeRunStartupLoginGuide('status');
  assert.equal(particles.length, 0, '不得再请求登录粒子动画');
  assert.equal(timers.length, 0, '不得再排定「稍后弹登录框」的定时器');
  assert.equal(sandbox.showLoginModalCalls, 0, '不得再唤起已摘除的登录弹窗');
  assert.equal(sandbox.startupLoginGuideShown, false, '不得占用「已引导过」状态位');
});

test('I-3 空场待机引导不受影响：它不属于登录链路', () => {
  const text = read('public', 'js', 'modules', '08-account', '05-startup-login-guide.js');
  assert.ok(/空场待机引导/.test(text), '空场待机引导段落必须仍在（本回批只停登录引导）');
});

// ---------------------------------------------------------------- Minor 回批

function loadProfileWithCanvas(record) {
  const nicknameInput = el('local-profile-nickname', { value: '' });
  const avatarInput = el('local-profile-avatar-file', { value: 'C:\\fakepath\\a.png', files: [{ name: 'a.png' }] });
  const { sandbox, toasts } = loadProfileSandbox({
    store: { 'stellaflix-local-profile-v1': '{"nickname":"旧名","avatar":""}' },
    elements: { 'local-profile-nickname': nicknameInput, 'local-profile-avatar-file': avatarInput },
  });
  sandbox.document.createElement = () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      fillRect() { record.ops.push('fillRect'); },
      drawImage() { record.ops.push('drawImage'); },
      set fillStyle(v) { record.fillStyle = v; },
    }),
    toDataURL: (mime, quality) => { record.mime = mime; record.quality = quality; return 'data:image/jpeg;base64,STUB'; },
  });
  sandbox.updateUserModalUi = function () {};
  sandbox.renderUserBtn = function () {};
  return { sandbox, toasts, nicknameInput, avatarInput, record };
}

test('M-1 透明底图片要铺白底再压 JPEG（JPEG 无 alpha，否则头像发黑）', () => {
  const record = { ops: [] };
  const { sandbox } = loadProfileWithCanvas(record);
  const dataUrl = sandbox.processLocalProfileAvatarImage({ width: 200, height: 100 });
  assert.equal(dataUrl, 'data:image/jpeg;base64,STUB');
  assert.deepEqual(record.ops, ['fillRect', 'drawImage'], '必须先铺底再绘制：' + record.ops.join(','));
  assert.ok(record.fillStyle, '铺底必须指定不透明底色');
});

test('M-2 JPEG 压缩质量按常量下发（不只断言 mime）', () => {
  const record = { ops: [] };
  const { sandbox } = loadProfileWithCanvas(record);
  sandbox.processLocalProfileAvatarImage({ width: 100, height: 100 });
  assert.equal(record.mime, 'image/jpeg');
  assert.equal(record.quality, sandbox.LOCAL_PROFILE_AVATAR_JPEG_QUALITY);
  assert.equal(sandbox.LOCAL_PROFILE_AVATAR_JPEG_QUALITY, 0.88);
});

test('M-3 换头像不得抹掉尚未保存的昵称输入', () => {
  const record = { ops: [] };
  const { sandbox } = loadProfileWithCanvas(record);
  sandbox.readLocalProfileAvatarFile = function (file, done) { done(null, 'data:image/jpeg;base64,AVATAR'); };
  const saved = [];
  sandbox.writeLocalProfile = function (profile) { saved.push(profile); return Object.assign({ ok: true }, profile); };
  const nicknameInput = sandbox.document.getElementById('local-profile-nickname');
  nicknameInput.value = '新昵称';
  const avatarInput = sandbox.document.getElementById('local-profile-avatar-file');
  sandbox.onLocalProfileAvatarFile(avatarInput);
  assert.equal(saved.length, 1, '头像链路必须走落盘函数');
  assert.equal(saved[0].nickname, '新昵称', '未保存的昵称输入必须随头像一起落盘，不得回退成存储旧值');
});

test('M-4 选图后清空 file input，同一张图可再选一次', () => {
  const record = { ops: [] };
  const { sandbox } = loadProfileWithCanvas(record);
  sandbox.readLocalProfileAvatarFile = function (file, done) { done(null, 'data:image/jpeg;base64,AVATAR'); };
  sandbox.writeLocalProfile = function (profile) { return Object.assign({ ok: true }, profile); };
  const avatarInput = sandbox.document.getElementById('local-profile-avatar-file');
  sandbox.onLocalProfileAvatarFile(avatarInput);
  assert.equal(avatarInput.value, '', '未清空 value 时，浏览器不会再触发同一文件的 change 事件');
});
