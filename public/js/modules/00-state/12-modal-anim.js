// ============================================================
// 通用弹窗动画 + 遮罩点击关闭
//
// 来源：原样搬自 public/js/modules/08-account/01-login-modal-utils.js（L2–L75）。
// 背景：T16d「平台登录族与五平台官方 API 整批退役」(95e3e35) 把这个文件整份删了，
// 但该文件里混着两类东西：① 平台登录/账号服务商逻辑（随退役合理消失）
// ② 与登录完全无关的通用弹窗工具（曲目详情/音频输出/本地节拍/封面裁剪/音效背景/更新预览
//    共 19 处无守卫直调，另有 06-lyrics/01-playlist-panel-shell.js:440 顶层直调遮罩绑定）。
// 本模块只承载 ②，保证退役后音乐侧弹窗仍能开合并能点遮罩关闭。
//
// 注意：login-modal 一项已随退役消失（对应关闭函数不存在，保留会立刻 ReferenceError）；
// user-modal 保留，它现在是 16a「本地档案」弹窗，关闭函数见下方 closeUserModal。
// ============================================================
function closeUserModal() { closeGsapModal(document.getElementById('user-modal')); }
function openGsapModal(mask) {
  if (!mask) return;
  var panel = mask.querySelector('.modal');
  mask.classList.add('show');
  if (window.gsap) {
    window.gsap.killTweensOf(mask);
    if (panel) window.gsap.killTweensOf(panel);
    window.gsap.set(mask, { display: 'flex', visibility: 'visible' });
    window.gsap.fromTo(mask,
      { autoAlpha: 0 },
      { autoAlpha: 1, duration: 0.38, ease: 'power2.out', overwrite: true }
    );
    if (panel) {
      window.gsap.fromTo(panel,
        { autoAlpha: 0, y: 26, scale: 0.965, filter: 'blur(12px)' },
        { autoAlpha: 1, y: 0, scale: 1, filter: 'blur(0px)', duration: 0.68, ease: 'expo.out', overwrite: true }
      );
    }
  } else {
    mask.style.display = 'flex';
    mask.style.visibility = 'visible';
    mask.style.opacity = '1';
  }
}
function closeGsapModal(mask, afterClose) {
  if (!mask || !mask.classList.contains('show')) {
    if (afterClose) afterClose();
    return;
  }
  var panel = mask.querySelector('.modal');
  function finish() {
    mask.classList.remove('show');
    if (window.gsap) {
      window.gsap.set(mask, { clearProps: 'display,visibility,opacity' });
      if (panel) window.gsap.set(panel, { clearProps: 'opacity,visibility,transform,filter' });
    } else {
      mask.style.display = '';
      mask.style.visibility = '';
      mask.style.opacity = '';
    }
    if (afterClose) afterClose();
  }
  if (window.gsap) {
    window.gsap.killTweensOf(mask);
    if (panel) {
      window.gsap.killTweensOf(panel);
      window.gsap.to(panel, { autoAlpha: 0, y: 18, scale: 0.976, filter: 'blur(8px)', duration: 0.28, ease: 'power2.in', overwrite: true });
    }
    window.gsap.to(mask, { autoAlpha: 0, duration: 0.34, ease: 'power2.inOut', overwrite: true, onComplete: finish });
  } else {
    finish();
  }
}
function bindModalBackdropClose() {
  [
    ['track-detail-modal', closeTrackDetailModal],
    ['audio-output-workflow-modal', closeAudioOutputWorkflowPanel],
    ['custom-lyric-modal', closeCustomLyricModal],
    ['update-modal', closeUpdatePanel],
    ['user-modal', closeUserModal]   // 16a「本地档案」弹窗（沿用原 id）
  ].forEach(function (pair) {
    var mask = document.getElementById(pair[0]);
    var close = pair[1];
    if (!mask || mask.__backdropCloseBound) return;
    mask.__backdropCloseBound = true;
    mask.addEventListener('click', function (e) {
      if (e.target !== mask) return;
      // 与每周新番/多源/筛选/音源面板对齐：拦住文档级捕获，避免点遮罩穿透到背后 Home
      e.stopPropagation();
      close();
    });
  });
}
