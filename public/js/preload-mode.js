try {
  if (localStorage.getItem('stellaflix-startup-fast-skip-v1') === '1') {
    document.documentElement.classList.add('startup-fast-skip-preload');
  }
  document.documentElement.classList.add(localStorage.getItem('stellaflix-diy-player-mode-v1') === '1' ? 'diy-mode-preload' : 'simple-mode-preload');
  // 启动默认空间=影视：head 阶段就打上影视外壳 class。
  // 音乐 3D / 粒子 / 登录 / 看板仍全量初始化；此处只做「首屏不露音乐 home」的 CSS 隔离前置。
  try {
    if (localStorage.getItem('stellaflix-start-space') === 'video') {
      document.documentElement.classList.add('video-space-active');
    }
  } catch (e2) { }
} catch (e) {
  document.documentElement.classList.add('simple-mode-preload');
}
