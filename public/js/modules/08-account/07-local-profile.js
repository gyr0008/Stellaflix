// ============================================================
// 07-local-profile.js — 任务16a：右上角入口改「本地档案」（不登录任何平台）
//
// 主人 10-25 定稿（.superpowers/sdd/2026-10-18-lx-source-alignment/task-16a-brief.md）：
//   · 存储 localStorage['stellaflix-local-profile-v1'] = { nickname, avatar }；
//     昵称 ≤16 码点、展示前 HTML 转义；头像 = canvas 256px 方形（cover 裁切）→ JPEG dataURL。
//   · 入口常驻单胶囊（始终头像+昵称，未设置时默认头像+「未设置昵称」），点开即本地档案页。
//   · 收听统计卡（06-usage-tracker 的 usage-total-time/usage-today-time）保留在档案页内。
//
// 装载位置说明：本文件登记在 modulePaths 的 08-account 连续段内、04/06 之后。
// 启动脚本是单一 <script>（index-loader 拼接 + 外层 try），同名「function 声明」按
// Annex B.3.3 全局泄漏且最后声明生效 —— 因此这里重新声明 renderUserBtn /
// onUserBtnClick / showUserModal / updateUserModalUi 即完成入口替换；01-05 旧平台登录
// 文件本身不动（物理删除与官方 API 退役是 16b/16c）。本模块对外部全局一律 typeof 守卫，
// 单独装载（tests/local-profile-entry.test.js 的 vm 切片）也成立。
// ============================================================

var LOCAL_PROFILE_STORE_KEY = 'stellaflix-local-profile-v1';
var LOCAL_PROFILE_NICKNAME_MAX = 16;
var LOCAL_PROFILE_AVATAR_SIZE = 256;
var LOCAL_PROFILE_AVATAR_JPEG_QUALITY = 0.88;
var LOCAL_PROFILE_AVATAR_BACKGROUND = '#ffffff';
var LOCAL_PROFILE_DEFAULT_NAME = '未设置昵称';

function localProfileEscapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function normalizeLocalProfileNickname(value) {
  var text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, LOCAL_PROFILE_NICKNAME_MAX).join('');
}
function isLocalProfileAvatarDataUrl(value) {
  return typeof value === 'string' && /^data:image\//i.test(value);
}
function readLocalProfile() {
  var out = { nickname: '', avatar: '' };
  try {
    var parsed = JSON.parse(localStorage.getItem(LOCAL_PROFILE_STORE_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      out.nickname = normalizeLocalProfileNickname(parsed.nickname);
      out.avatar = isLocalProfileAvatarDataUrl(parsed.avatar) ? parsed.avatar : '';
    }
  } catch (e) { }
  return out;
}
function writeLocalProfile(profile) {
  profile = profile || {};
  var out = {
    nickname: normalizeLocalProfileNickname(profile.nickname),
    avatar: isLocalProfileAvatarDataUrl(profile.avatar) ? profile.avatar : '',
  };
  // 落盘可能因配额满/隐私模式抛错；调用方按 ok 决定文案，不得弹假成功。
  try {
    localStorage.setItem(LOCAL_PROFILE_STORE_KEY, JSON.stringify(out));
    out.ok = true;
  } catch (e) {
    out.ok = false;
  }
  return out;
}
function localProfileDefaultAvatarSrc() {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
    '<rect width="96" height="96" rx="48" fill="#181f2c"/>' +
    '<circle cx="48" cy="38" r="15" fill="#8296b8" opacity=".9"/>' +
    '<path d="M18 84c4-19 16-27 30-27s26 8 30 27z" fill="#8296b8" opacity=".9"/></svg>';
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}
function localProfileAvatarSrc(profile) {
  profile = profile || readLocalProfile();
  return profile.avatar || localProfileDefaultAvatarSrc();
}

// 头像处理：任意尺寸图 → canvas 256px 方形，cover 裁切（短边贴满、长边居中溢出）→ JPEG dataURL。
function processLocalProfileAvatarImage(image, size) {
  size = Number(size) > 0 ? Number(size) : LOCAL_PROFILE_AVATAR_SIZE;
  var iw = Math.max(1, Number(image && image.width) || 1);
  var ih = Math.max(1, Number(image && image.height) || 1);
  var canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  var ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx || typeof canvas.toDataURL !== 'function') return '';
  var scale = Math.max(size / iw, size / ih);
  var dw = iw * scale;
  var dh = ih * scale;
  // JPEG 没有 alpha 通道：透明底图直接编码会得到黑底，先铺白底再绘制。
  ctx.fillStyle = LOCAL_PROFILE_AVATAR_BACKGROUND;
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(image, (size - dw) / 2, (size - dh) / 2, dw, dh);
  return canvas.toDataURL('image/jpeg', LOCAL_PROFILE_AVATAR_JPEG_QUALITY);
}
function readLocalProfileAvatarFile(file, done) {
  if (!file) { done(new Error('AVATAR_FILE_MISSING')); return; }
  var reader = new FileReader();
  reader.onload = function (ev) {
    var src = String((ev && ev.target && ev.target.result) || reader.result || '');
    var img = new Image();
    img.onload = function () {
      try { done(null, processLocalProfileAvatarImage(img)); } catch (e) { done(e); }
    };
    img.onerror = function () { done(new Error('AVATAR_DECODE_FAILED')); };
    img.src = src;
  };
  reader.onerror = function () { done(new Error('AVATAR_READ_FAILED')); };
  reader.readAsDataURL(file);
}

// ---------- 入口替换（覆盖 01/02/04 的同名声明） ----------

function renderUserBtn() {
  var btn = document.getElementById('user-btn');
  if (!btn) return;
  var profile = readLocalProfile();
  var displayName = profile.nickname || LOCAL_PROFILE_DEFAULT_NAME;
  btn.classList.remove('logged-out');
  btn.classList.remove('logged-in');
  btn.classList.remove('login-eye-avatar');
  btn.classList.remove('multi-account');
  btn.classList.remove('external-account-pills');
  btn.classList.add('local-profile-pill');
  btn.title = '本地档案';
  btn.innerHTML = '<span class="top-account-pill online local-profile" data-account-provider="local">' +
    '<img src="' + localProfileEscapeHtml(localProfileAvatarSrc(profile)) + '" alt="" id="user-btn-avatar">' +
    '<span class="top-account-name">' + localProfileEscapeHtml(displayName) + '</span>' +
    '</span>';
  if (typeof updateAccountPillGlassDisplacementMap === 'function') {
    requestAnimationFrame(updateAccountPillGlassDisplacementMap);
  }
  // 原 renderUserBtn 顺带刷音质 UI；平台 VIP 门槛已在 T12 恒通过，这里保持触发即可。
  if (typeof updatePlaybackQualityUi === 'function') {
    try { updatePlaybackQualityUi(); } catch (e) { }
  }
}

function updateUserModalUi() {
  var profile = readLocalProfile();
  var avatar = document.getElementById('user-modal-avatar');
  var name = document.getElementById('user-modal-name');
  var input = document.getElementById('local-profile-nickname');
  if (avatar) avatar.src = localProfileAvatarSrc(profile);
  if (name) name.textContent = profile.nickname || LOCAL_PROFILE_DEFAULT_NAME;
  if (input) input.value = profile.nickname || '';
  // 收听统计卡（06-usage-tracker）随档案页展示。
  if (typeof window !== 'undefined' && window.StellaflixUsage && typeof window.StellaflixUsage.bindDisplay === 'function') {
    try { window.StellaflixUsage.bindDisplay('usage-total-time', 'usage-today-time'); } catch (e) { }
  }
}

function showUserModal() {
  updateUserModalUi();
  var mask = document.getElementById('user-modal');
  if (!mask) return;
  if (typeof openGsapModal === 'function') openGsapModal(mask);
  else mask.classList.add('show');
}

function onUserBtnClick() {
  showUserModal();
}

function saveLocalProfileForm() {
  var input = document.getElementById('local-profile-nickname');
  var profile = readLocalProfile();
  profile.nickname = normalizeLocalProfileNickname(input && input.value);
  var saved = writeLocalProfile(profile);
  if (!saved.ok) {
    if (typeof showToast === 'function') showToast('本地档案保存失败：浏览器存储不可写（配额已满或隐私模式）');
    return;
  }
  updateUserModalUi();
  renderUserBtn();
  if (typeof showToast === 'function') showToast('已保存本地档案');
}

function pickLocalProfileAvatar() {
  var input = document.getElementById('local-profile-avatar-file');
  if (input && typeof input.click === 'function') input.click();
}

function onLocalProfileAvatarFile(inputEl) {
  inputEl = inputEl || document.getElementById('local-profile-avatar-file');
  var file = inputEl && inputEl.files && inputEl.files[0];
  if (!file) return;
  // 先释放 input 的值：否则同一张图再选一次不会触发 change（浏览器认为值未变）。
  try { inputEl.value = ''; } catch (e) { }
  readLocalProfileAvatarFile(file, function (err, dataUrl) {
    if (err || !dataUrl) {
      if (typeof showToast === 'function') showToast('头像处理失败，换一张图片试试');
      return;
    }
    var profile = readLocalProfile();
    var nicknameInput = document.getElementById('local-profile-nickname');
    if (nicknameInput && nicknameInput.value) profile.nickname = nicknameInput.value;
    profile.avatar = dataUrl;
    var saved = writeLocalProfile(profile);
    if (!saved.ok) {
      if (typeof showToast === 'function') showToast('头像保存失败：浏览器存储不可写（配额已满或隐私模式）');
      return;
    }
    updateUserModalUi();
    renderUserBtn();
    if (typeof showToast === 'function') showToast('已更新档案头像');
  });
}

function initLocalProfileEntry() {
  renderUserBtn();
  updateUserModalUi();
}

if (typeof document !== 'undefined' && document.getElementById) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLocalProfileEntry, { once: true });
  } else {
    initLocalProfileEntry();
  }
}
