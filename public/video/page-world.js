/*
 * Stellaflix 影视模块 — 世界页面（占位页）
 *
 * 占位页：3D地球功能开发中，暂时显示占位内容。
 * 原始灯塔模式代码已保留在 video/lighthouse/ 目录，待新实现完成后恢复。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  SFV.router.register({
    id: 'world',
    title: '世界',
    mount: function (host, ctx) {
      // 设置标题
      if (SFV.ui && SFV.ui.setTitle) SFV.ui.setTitle('世界');

      // 清空宿主容器
      host.innerHTML = '';

      // 创建占位容器
      var placeholder = document.createElement('div');
      placeholder.className = 'world-placeholder';
      placeholder.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        min-height: 400px;
        color: rgba(255, 255, 255, 0.7);
        font-family: 'Inter', 'Noto Sans SC', sans-serif;
        text-align: center;
        padding: 40px;
        box-sizing: border-box;
        pointer-events: none;
        user-select: none;
      `;

      // 图标
      var icon = document.createElement('div');
      icon.textContent = '🌍';
      icon.style.cssText = `
        font-size: 64px;
        margin-bottom: 24px;
        opacity: 0.6;
        filter: grayscale(0.3);
      `;

      // 标题
      var title = document.createElement('div');
      title.textContent = '3D 地球';
      title.style.cssText = `
        font-size: 24px;
        font-weight: 300;
        letter-spacing: 4px;
        margin-bottom: 12px;
        color: rgba(255, 255, 255, 0.85);
      `;

      // 副标题
      var subtitle = document.createElement('div');
      subtitle.textContent = '功能开发中，敬请期待';
      subtitle.style.cssText = `
        font-size: 14px;
        opacity: 0.5;
        letter-spacing: 2px;
      `;

      // 组装
      placeholder.appendChild(icon);
      placeholder.appendChild(title);
      placeholder.appendChild(subtitle);
      host.appendChild(placeholder);
    },
    unmount: function () {
      // 占位页无需清理
    },
    back: function () { return false; }
  });
})(typeof window !== 'undefined' ? window : this);
