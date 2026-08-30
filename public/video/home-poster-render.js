/*
 * Stellaflix 影视模块 — 影视态海报「渲染 / 动作」子系统 (T119 / T120 / T-双态独立海报)
 *
 * 从 home.js 抽出（home.js 影视态首页 Step 3 的可维护性拆债）。
 *
 * 设计边界（铁律）：
 *   - 存储与内存缓存（posterStore）保留在 home.js，本文件只负责「渲染 + 动作」。
 *   - 运行时经 SFV.home 门面存取：
 *       getUserVideoPoster / setUserVideoPoster / clearUserVideoPoster /
 *       loadPosterSavedMedia / savePosterMediaFromPicker / releasePosterObjectUrl
 *   - 「改文案」经 SFV.home.editVideoPosterQuote 回 home.js（避免本文件反向依赖）。
 *   - 加载顺序：须晚于 home-core.js（escAttr）和 home.js（SFV.home 门面）。
 *
 * T-双态独立海报新增特性：
 *   - 外层海报支持 kind='image'（dataUrl / blobDB 大图）和 kind='video'（MP4 Blob）
 *   - home-poster-actions 下新增「换视频」chip（与「换图片」并列）
 *   - pick / pickVideo 统一走 desktopWindow.pickMedia + savePosterMediaFromPicker（含 canvas 压缩 / IndexedDB 大媒体写入）
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var HC = SFV.homeCore;
  if (!HC) { throw new Error('[SFV home-poster-render] homeCore 未加载，请检查 index.html 加载顺序'); }
  var escAttr = HC.escAttr;

  function d() { return global.document; }

  // ── 存储门面（posterStore 在 home.js，此处只做薄封装） ──
  function getUserVideoPoster() {
    if (SFV.home && typeof SFV.home.getUserVideoPoster === 'function') return SFV.home.getUserVideoPoster();
    return null;
  }
  function setUserVideoPoster(rec) {
    if (SFV.home && typeof SFV.home.setUserVideoPoster === 'function') return SFV.home.setUserVideoPoster(rec);
    return false;
  }
  function clearUserVideoPoster() {
    if (SFV.home && typeof SFV.home.clearUserVideoPoster === 'function') return SFV.home.clearUserVideoPoster();
    return false;
  }
  function loadPosterSavedMedia() {
    if (SFV.home && typeof SFV.home.loadPosterSavedMedia === 'function') return SFV.home.loadPosterSavedMedia();
    return Promise.resolve({ kind: 'empty' });
  }
  function savePosterMediaFromPicker(res) {
    if (SFV.home && typeof SFV.home.savePosterMediaFromPicker === 'function') {
      return SFV.home.savePosterMediaFromPicker(res);
    }
    return Promise.resolve(false);
  }

  // 海报来源策略（仅允许用户上传，不自动回退任何历史/TMDB/收藏数据）
  //   保留此函数作为来源决策的轻量 SYNC 探针（供非 render 链路读 URL/title），
  //   真正渲染前一律走 loadPosterSavedMedia()。
  function pickVideoPoster() {
    var user = getUserVideoPoster();
    if (user && (user.url || user.blobKey)) return { kind: 'user', url: user.url || '', blobKey: user.blobKey || '', title: user.title || '', mediaKind: user.kind };
    return { kind: 'default', url: '', title: '' };
  }

  // 清理 #home-poster-media 下之前注入的影视态内嵌媒体（VIDEO / IMG + 默认 emoji 卡片）
  // 不触碰 .home-poster-frame / .home-poster-reflection 装饰
  function cleanupMediaChildren(media) {
    if (!media) return;
    try {
      var olds = media.querySelectorAll('video.sfv-poster-video-bg, img.sfv-poster-image-bg-blob, .sfv-poster-default-inner');
      for (var i = 0; i < olds.length; i++) {
        try {
          if (olds[i].tagName === 'VIDEO') {
            olds[i].pause();
            olds[i].removeAttribute('src');
            if (olds[i].load) olds[i].load();
          } else {
            olds[i].removeAttribute('src');
          }
        } catch (_e1) { /* ignore */ }
        if (olds[i].parentNode) olds[i].parentNode.removeChild(olds[i]);
      }
    } catch (_e2) { /* ignore */ }
  }

  // 渲染影视态左侧海报
  // 流程：
  //   1) 清理旧的内嵌子元素（不删 frame/reflection 装饰）
  //   2) 异步 loadPosterSavedMedia() → 返回 { kind:'empty'|'image'|'video', url|blobUrl, name, size, useBlobForImage }
  //   3) 按 kind：
  //     empty → 默认封面（🎬+文字）
  //     image + dataUrl → CSS var --home-poster-image 背景（原逻辑）
  //     image + blobUrl（useBlobForImage）→ <img class="sfv-poster-image-bg-blob" object-fit:cover>
  //     video + blobUrl → <video class="sfv-poster-video-bg" muted loop playsinline autoplay>
  function renderVideoPoster() {
    var doc = d();
    if (!doc || !doc.body) return;
    // T-双态独立海报：SYNC 段硬守卫，禁止误跑到音乐态
    if (!doc.body.classList.contains('video-space-active')) return;
    var media = doc.getElementById('home-poster-media');
    if (!media) return;

    cleanupMediaChildren(media);

    loadPosterSavedMedia().then(function (loaded) {
      if (!loaded) loaded = { kind: 'empty' };

      // 切态保护：renderVideoPoster 完成异步后再检查当前是否还在影视态，防止切回音乐态后把媒体元素挂回去
      if (doc && doc.body && !doc.body.classList.contains('video-space-active')) return;

      // 若 #home-poster-media 再次被外部清理，重取（避免 stale ref）
      var m2 = doc.getElementById('home-poster-media');
      if (!m2) return;
      cleanupMediaChildren(m2);

      if (loaded.kind === 'empty') {
        // 默认封面：暗色玻璃 + 🎬 emoji + "影视空间" 文字
        m2.classList.add('sfv-poster-default');
        m2.classList.remove('sfv-poster-movie', 'has-image', 'sfv-poster-has-video');
        m2.style.removeProperty('--home-poster-image');

        var inner = doc.createElement('div');
        inner.className = 'sfv-poster-default-inner';
        inner.setAttribute('aria-hidden', 'true');
        var emoji = doc.createElement('div');
        emoji.className = 'sfv-poster-default-emoji';
        emoji.textContent = '\uD83C\uDFAC'; // 🎬
        var text = doc.createElement('div');
        text.className = 'sfv-poster-default-text';
        text.textContent = '影视空间';
        inner.appendChild(emoji);
        inner.appendChild(text);
        m2.appendChild(inner);
        return;
      }

      if (loaded.kind === 'image') {
        if (loaded.useBlobForImage && loaded.blobUrl) {
          // 大图（blobDB 存储）：内嵌 IMG，object-fit:cover 覆盖
          m2.classList.add('sfv-poster-movie', 'has-image');
          m2.classList.remove('sfv-poster-default', 'sfv-poster-has-video');
          m2.style.removeProperty('--home-poster-image');
          var img = doc.createElement('img');
          img.className = 'sfv-poster-image-bg-blob';
          img.setAttribute('aria-hidden', 'true');
          img.alt = '';
          img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;pointer-events:none;display:block;z-index:0;';
          img.src = loaded.blobUrl;
          m2.insertBefore(img, m2.firstChild);
        } else if (loaded.url) {
          // 普通压缩图：CSS var 背景（原逻辑，与音乐态一致）
          m2.classList.add('sfv-poster-movie', 'has-image');
          m2.classList.remove('sfv-poster-default', 'sfv-poster-has-video');
          var safe = escAttr(loaded.url);
          m2.style.setProperty('--home-poster-image', 'url("' + safe + '")');
        }
        return;
      }

      if (loaded.kind === 'video' && loaded.blobUrl) {
        // 视频：内嵌 VIDEO，muted+loop+playsinline+autoplay，object-fit:cover
        m2.classList.add('sfv-poster-movie', 'sfv-poster-has-video');
        m2.classList.remove('sfv-poster-default', 'has-image');
        m2.style.removeProperty('--home-poster-image');
        var video = doc.createElement('video');
        video.className = 'sfv-poster-video-bg';
        video.setAttribute('aria-hidden', 'true');
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.preload = 'auto';
        video.autoplay = true;
        video.setAttribute('autoplay', '');
        video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;pointer-events:none;display:block;z-index:0;background:#000;';
        video.src = loaded.blobUrl;
        m2.insertBefore(video, m2.firstChild);
        try {
          var p = video.play && video.play();
          if (p && typeof p.catch === 'function') {
            p.catch(function () {
              // 浏览器自动播放策略拒绝 → 退化为静音 poster（首帧仍显示）
            });
          }
        } catch (_ep) { /* ignore */ }
        return;
      }
    });
  }

  // ── home-poster-actions 改造（5 chips → 影视态语义 + 新增换视频 chip） ──
  // C2 影视态顺序：用当前封面(hidden) → 换图片 → 换视频(新增) → 改文案 → 重置 → 工具箱
  function restructurePosterActionsForVideo() {
    var doc = d();
    if (!doc || !doc.body) return;
    // T-双态独立海报：硬守卫，切到音乐态时绝不篡改 chips
    if (!doc.body.classList.contains('video-space-active')) return;
    var actions = doc.querySelector('#home-poster .home-poster-actions') || doc.querySelector('.home-poster-actions');
    if (!actions) { console.warn('[SFV-HOME] restructurePosterActionsForVideo: .home-poster-actions not found'); return; }

    var btns = actions.querySelectorAll('.home-poster-chip');
    var replaceImgBtn = null;
    btns.forEach(function (b) {
      var txt = (b.textContent || '').trim();
      if (txt === '用当前封面') {
        if (b.style.display !== 'none') b.style.display = 'none';
      } else if (txt === '换图片') {
        replaceImgBtn = b;
        // 用 data 标记 + 一次性 listener 绑定，避免切态时覆盖 vendor 原 onclick
        if (!b._sfvBound) {
          b.addEventListener('click', function (ev) {
            if (!(doc.body && doc.body.classList.contains('video-space-active'))) return;
            ev.preventDefault();
            ev.stopPropagation();
            pickLocalVideoPoster();
          });
          b._sfvBound = true;
        }
      } else if (txt === '重置') {
        if (!b._sfvResetBound) {
          b.addEventListener('click', function (ev) {
            if (!(doc.body && doc.body.classList.contains('video-space-active'))) return;
            ev.preventDefault();
            ev.stopPropagation();
            resetVideoPoster();
          });
          b._sfvResetBound = true;
        }
      } else if (txt === '改文案') {
        if (!b._sfvQuoteBound) {
          b.addEventListener('click', function (ev) {
            if (!(doc.body && doc.body.classList.contains('video-space-active'))) return;
            ev.preventDefault();
            ev.stopPropagation();
            if (SFV.home && typeof SFV.home.editVideoPosterQuote === 'function') SFV.home.editVideoPosterQuote();
          });
          b._sfvQuoteBound = true;
        }
      }
    });

    // ── 注入「换视频」chip（仅注入一次，防重复） ──
    if (!actions.querySelector('.home-poster-chip[data-sfv-chip="replace-video"]')) {
      var newChip = doc.createElement('button');
      newChip.type = 'button';
      newChip.className = replaceImgBtn ? replaceImgBtn.className : 'home-poster-chip';
      newChip.setAttribute('data-sfv-chip', 'replace-video');
      newChip.textContent = '换视频';
      newChip.onclick = function () { pickLocalVideoPosterVideo(); };
      if (replaceImgBtn && replaceImgBtn.parentNode) {
        // 插在「换图片」后面，保证顺序：换图片 → 换视频 → 改文案
        if (replaceImgBtn.nextSibling) {
          replaceImgBtn.parentNode.insertBefore(newChip, replaceImgBtn.nextSibling);
        } else {
          replaceImgBtn.parentNode.appendChild(newChip);
        }
      } else {
        actions.appendChild(newChip);
      }
    }
  }

  // 重置：清掉存储 + 回默认海报
  function resetVideoPoster() {
    clearUserVideoPoster();
    renderVideoPoster();
    if (typeof global.showToast === 'function') {
      try { global.showToast('影视海报已重置'); } catch (e) {}
    }
  }

  // ── 图片本地上传（走新的 pickMedia + savePosterMediaFromPicker 统一链路） ──
  function pickLocalVideoPoster() {
    if (!(global.desktopWindow && typeof global.desktopWindow.pickMedia === 'function')) {
      if (typeof global.showToast === 'function') global.showToast('图片选择功能不可用');
      return;
    }
    global.desktopWindow.pickMedia('image').then(function (result) {
      if (!result || !result.ok) {
        if (result && !result.canceled) {
          if (typeof global.showToast === 'function') global.showToast('图片选择失败: ' + (result.error || '未知错误'));
        }
        return;
      }
      if (result.canceled) return;
      if (!result.dataUrl || !/^data:image\//i.test(result.dataUrl)) {
        if (typeof global.showToast === 'function') global.showToast('图片数据无效');
        return;
      }
      savePosterMediaFromPicker(result).then(function (ok) {
        if (!ok) {
          if (typeof global.showToast === 'function') global.showToast('海报保存失败');
          return;
        }
        renderVideoPoster();
        if (typeof global.showToast === 'function') global.showToast('影视海报已替换为本地图片');
      });
    }).catch(function (err) {
      console.warn('[SFV-HOME] pickMedia(image) IPC error:', err ? err.message : '');
      if (typeof global.showToast === 'function') global.showToast('图片选择失败');
    });
  }

  // ── 视频本地上传（T-双态独立海报：外层海报视频支持） ──
  function pickLocalVideoPosterVideo() {
    if (!(global.desktopWindow && typeof global.desktopWindow.pickMedia === 'function')) {
      if (typeof global.showToast === 'function') global.showToast('视频选择功能不可用');
      return;
    }
    global.desktopWindow.pickMedia('video').then(function (result) {
      if (!result || !result.ok) {
        if (result && !result.canceled) {
          var err = (result && result.error) || '未知错误';
          if (err === 'VIDEO_TOO_LARGE') err = '视频太大（上限 300MB）';
          if (typeof global.showToast === 'function') global.showToast('视频选择失败: ' + err);
        }
        return;
      }
      if (result.canceled) return;
      if (!result.isVideo || !result.filePath) {
        if (typeof global.showToast === 'function') global.showToast('视频数据无效');
        return;
      }
      savePosterMediaFromPicker(result).then(function (ok) {
        if (!ok) {
          if (typeof global.showToast === 'function') global.showToast('视频海报保存失败');
          return;
        }
        renderVideoPoster();
        if (typeof global.showToast === 'function') global.showToast('影视海报已替换为本地视频');
      });
    }).catch(function (err) {
      console.warn('[SFV-HOME] pickMedia(video) IPC error:', err ? err.message : '');
      if (typeof global.showToast === 'function') global.showToast('视频选择失败');
    });
  }

  SFV.homePosterRender = {
    pick: pickVideoPoster,
    render: renderVideoPoster,
    restructure: restructurePosterActionsForVideo,
    reset: resetVideoPoster,
    pickLocal: pickLocalVideoPoster,
    pickLocalVideo: pickLocalVideoPosterVideo, // 暴露给 bridge / 外部调用
  };
})(typeof window !== 'undefined' ? window : this);
