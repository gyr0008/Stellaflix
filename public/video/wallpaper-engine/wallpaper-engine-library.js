function wallpaperEngineFilteredProjects() {
  var search = document.getElementById('wallpaper-engine-search');
  var query = String(search && search.value || '').trim().toLowerCase();
  return wallpaperEngineProjects.filter(function (item) {
    if (hiddenWallpaperEngineIds.has(item.id)) return false;
    if (!query) return true;
    return (item.title + ' ' + item.projectType + ' ' + item.sourceLabel + ' ' + item.workshopId).toLowerCase().indexOf(query) >= 0;
  }).sort(function (a, b) {
    var activeA = wallpaperEngineSelection.active && wallpaperEngineSelection.id === a.id ? 1 : 0;
    var activeB = wallpaperEngineSelection.active && wallpaperEngineSelection.id === b.id ? 1 : 0;
    var favA = favoriteWallpaperEngineIds.has(a.id) ? 1 : 0;
    var favB = favoriteWallpaperEngineIds.has(b.id) ? 1 : 0;
    return activeB - activeA || favB - favA || Number(b.playable) - Number(a.playable) || Number(b.enginePlayable) - Number(a.enginePlayable) || a.title.localeCompare(b.title, 'zh-CN');
  });
}

function disconnectWallpaperEnginePreviewObserver() {
  if (wallpaperEnginePreviewObserver) wallpaperEnginePreviewObserver.disconnect();
  wallpaperEnginePreviewObserver = null;
}

function loadWallpaperEnginePreviewsNearViewport() {
  var grid = document.getElementById('wallpaper-engine-grid');
  var modal = document.getElementById('wallpaper-engine-modal');
  if (!grid || (modal && !modal.classList.contains('show'))) return;
  var viewport = grid.getBoundingClientRect();
  grid.querySelectorAll('img[data-src]').forEach(function (image) {
    var rect = image.getBoundingClientRect();
    var nearby = rect.bottom >= viewport.top - 220 && rect.top <= viewport.bottom + 220;
    if (nearby) {
      if (!image.getAttribute('src')) image.src = image.dataset.src || '';
    } else if (image.dataset.animated === '1') {
      image.removeAttribute('src');
      image.classList.remove('loaded');
    }
  });
}

function extendWallpaperEngineLibraryNearEnd() {
  var grid = document.getElementById('wallpaper-engine-grid');
  if (!grid || !grid.querySelector('[data-wallpaper-action="load-more"]')) return;
  var remaining = grid.scrollHeight - grid.scrollTop - grid.clientHeight;
  if (remaining > Math.max(280, grid.clientHeight * 0.7)) return;
  wallpaperEngineRenderLimit += WALLPAPER_ENGINE_RENDER_BATCH;
  renderWallpaperEngineLibrary(true);
}

function scheduleWallpaperEnginePreviewViewportUpdate() {
  if (wallpaperEnginePreviewObserver) {
    extendWallpaperEngineLibraryNearEnd();
    return;
  }
  if (wallpaperEnginePreviewScrollTimer) return;
  wallpaperEnginePreviewScrollTimer = setTimeout(function () {
    wallpaperEnginePreviewScrollTimer = 0;
    loadWallpaperEnginePreviewsNearViewport();
    extendWallpaperEngineLibraryNearEnd();
  }, 60);
}

function observeWallpaperEnginePreviews() {
  disconnectWallpaperEnginePreviewObserver();
  var grid = document.getElementById('wallpaper-engine-grid');
  if (!grid || typeof IntersectionObserver === 'undefined') {
    if (grid) {
      grid.querySelectorAll('img[data-src]').forEach(function (img) {
        img.onload = function () { img.classList.add('loaded'); };
      });
      loadWallpaperEnginePreviewsNearViewport();
    }
    return;
  }
  wallpaperEnginePreviewObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var img = entry.target;
      if (entry.isIntersecting) {
        if (!img.getAttribute('src')) img.src = img.dataset.src || '';
      } else if (img.dataset.animated === '1') {
        img.removeAttribute('src');
        img.classList.remove('loaded');
      }
    });
  }, { root: grid, rootMargin: '220px 0px', threshold: 0.01 });
  grid.querySelectorAll('img[data-src]').forEach(function (img) {
    img.onload = function () { img.classList.add('loaded'); };
    wallpaperEnginePreviewObserver.observe(img);
  });
  loadWallpaperEnginePreviewsNearViewport();
}

function renderWallpaperEngineManualRoots() {
  var host = document.getElementById('wallpaper-engine-manual-roots');
  if (!host) return;
  var roots = wallpaperEngineLibrarySnapshot && Array.isArray(wallpaperEngineLibrarySnapshot.manualRoots)
    ? wallpaperEngineLibrarySnapshot.manualRoots : [];
  host.innerHTML = roots.map(function (root) {
    return '<span class="wallpaper-engine-root-chip"><span title="手动导入目录">' + escHtml(root.name || '导入目录') + '</span>' +
      '<button type="button" data-wallpaper-action="remove-root" data-root-id="' + escHtml(root.id || '') + '" title="移除此索引目录">×</button></span>';
  }).join('');
}

function renderWallpaperEngineLibrary(preserveRenderLimit) {
  var grid = document.getElementById('wallpaper-engine-grid');
  if (!grid) return;
  var modal = document.getElementById('wallpaper-engine-modal');
  if (modal && !modal.classList.contains('show')) {
    disconnectWallpaperEnginePreviewObserver();
    return;
  }
  if (!preserveRenderLimit) wallpaperEngineRenderLimit = WALLPAPER_ENGINE_RENDER_BATCH;
  disconnectWallpaperEnginePreviewObserver();
  if (wallpaperEngineLibraryBusy) {
    grid.innerHTML = '<div class="wallpaper-engine-empty">正在读取 project.json 元数据，不扫描 94GB 素材文件…</div>';
    return;
  }
  var items = wallpaperEngineFilteredProjects();
  if (!items.length) {
    grid.innerHTML = '<div class="wallpaper-engine-empty">' + (wallpaperEngineProjects.length ? '没有符合筛选条件的壁纸' : '没有识别到 Wallpaper Engine 项目<br>可以点击“导入目录”手动选择项目或素材库') + '</div>';
    return;
  }
  var visibleItems = items.slice(0, wallpaperEngineRenderLimit);
  grid.innerHTML = visibleItems.map(function (item) {
    var favorite = favoriteWallpaperEngineIds.has(item.id);
    var active = wallpaperEngineSelection.active && wallpaperEngineSelection.id === item.id;
    var preview = item.hasPreview ? wallpaperEngineMediaUrl(item, 'preview') : '';
    return '<article class="wallpaper-engine-card' + (favorite ? ' favorite' : '') + (active ? ' active' : '') + '" tabindex="0" role="button" data-wallpaper-id="' + item.id + '">' +
      (preview ? '<img class="wallpaper-engine-card-preview" data-src="' + escHtml(preview) + '" data-animated="' + (item.previewAnimated ? '1' : '0') + '" alt="" loading="lazy" decoding="async">' : '<div class="wallpaper-engine-card-placeholder"></div>') +
      '<button class="wallpaper-engine-card-star' + (favorite ? ' active' : '') + '" type="button" data-wallpaper-action="favorite" data-wallpaper-id="' + item.id + '" title="' + (favorite ? '取消星标' : '星标并置顶') + '">' + (favorite ? '★' : '☆') + '</button>' +
      '<button class="wallpaper-engine-card-settings" type="button" data-wallpaper-action="details" data-wallpaper-id="' + item.id + '" title="读取项目设置">⚙</button>' +
      '<button class="wallpaper-engine-card-hide" type="button" data-wallpaper-action="hide" data-wallpaper-id="' + item.id + '" title="从列表隐藏">×</button>' +
      '<div class="wallpaper-engine-card-meta">' + escHtml(item.title) + '<small>' + escHtml(wallpaperEngineProjectLabel(item)) + '</small></div>' +
      '</article>';
  }).join('') + (visibleItems.length < items.length
    ? '<button type="button" class="wallpaper-engine-load-more" data-wallpaper-action="load-more">继续加载 ' + visibleItems.length + ' / ' + items.length + '</button>'
    : '');
  observeWallpaperEnginePreviews();
}

function normalizeWallpaperEngineProjectDetails(details) {
  details = details && typeof details === 'object' ? details : {};
  var id = String(details.id || '').replace(/[^a-f0-9]/gi, '').slice(0, 24);
  if (id.length !== 24) return null;
  var properties = Array.isArray(details.properties) ? details.properties.slice(0, 256).map(function (property) {
    property = property && typeof property === 'object' ? property : {};
    var key = String(property.key || '').replace(/[^a-z0-9_.-]/gi, '').slice(0, 128);
    if (!key) return null;
    var value = property.value;
    if (typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string') value = null;
    if (typeof value === 'string') value = value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512);
    var options = Array.isArray(property.options) ? property.options.slice(0, 64).map(function (option) {
      option = option && typeof option === 'object' ? option : {};
      var optionValue = option.value;
      if (typeof optionValue !== 'boolean' && typeof optionValue !== 'number' && typeof optionValue !== 'string') return null;
      return {
        label: String(option.label || '选项').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160),
        value: optionValue
      };
    }).filter(Boolean) : [];
    return {
      key: key,
      label: String(property.label || key).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || key,
      type: String(property.type || 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'unknown',
      value: value,
      options: options,
      audio: property.audio === true,
      autoMuted: property.autoMuted === true
    };
  }).filter(Boolean) : [];
  return {
    id: id,
    title: String(details.title || 'Wallpaper Engine').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Wallpaper Engine',
    projectType: String(details.projectType || 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'unknown',
    workshopId: String(details.workshopId || '').replace(/\D/g, '').slice(0, 32),
    propertyCount: Math.max(0, Math.min(256, Number(details.propertyCount) || properties.length)),
    audioPropertyCount: Math.max(0, Math.min(256, Number(details.audioPropertyCount) || 0)),
    mutedAudioPropertyCount: Math.max(0, Math.min(256, Number(details.mutedAudioPropertyCount) || 0)),
    properties: properties
  };
}

function wallpaperEnginePropertyValueLabel(property) {
  if (property.options && property.options.length) {
    var selected = property.options.find(function (option) { return String(option.value) === String(property.value); });
    if (selected) return selected.label;
  }
  if (typeof property.value === 'boolean') return property.value ? '开启' : '关闭';
  if (typeof property.value === 'number') return String(Math.round(property.value * 1000) / 1000);
  if (typeof property.value === 'string' && property.value) return property.value;
  return '未设置';
}

function renderWallpaperEngineProjectDetails(details, error) {
  var drawer = document.getElementById('wallpaper-engine-details-drawer');
  var title = document.getElementById('wallpaper-engine-details-title');
  var summary = document.getElementById('wallpaper-engine-details-summary');
  var properties = document.getElementById('wallpaper-engine-details-properties');
  var weButton = document.getElementById('wallpaper-engine-details-we');
  var workshopButton = document.getElementById('wallpaper-engine-details-workshop');
  if (!drawer || !title || !summary || !properties) return;
  drawer.classList.add('show');
  drawer.setAttribute('aria-hidden', 'false');
  if (error) {
    title.textContent = '项目设置';
    summary.textContent = error;
    properties.innerHTML = '<div class="wallpaper-engine-details-empty">无法读取此项目的 project.json 设置。</div>';
    if (weButton) weButton.disabled = true;
    if (workshopButton) workshopButton.disabled = true;
    return;
  }
  if (!details) {
    title.textContent = '正在读取项目设置…';
    summary.textContent = '只读取 project.json 元数据，不解包大型 Scene 文件。';
    properties.innerHTML = '<div class="wallpaper-engine-details-empty">读取中…</div>';
    if (weButton) weButton.disabled = true;
    if (workshopButton) workshopButton.disabled = true;
    return;
  }
  title.textContent = details.title;
  summary.textContent = '已读取 ' + details.propertyCount + ' 项设置 · 检测到 ' + details.audioPropertyCount +
    ' 项音频控制 · 每次加载自动静音 ' + details.mutedAudioPropertyCount + ' 项';
  properties.innerHTML = details.properties.length ? details.properties.map(function (property) {
    var badge = property.audio
      ? '<span class="wallpaper-engine-property-badge' + (property.autoMuted ? '' : ' warning') + '">' + (property.autoMuted ? '加载时静音' : '音频相关') + '</span>'
      : '';
    return '<div class="wallpaper-engine-property-row">' +
      '<div class="wallpaper-engine-property-copy"><strong>' + escHtml(property.label) + '</strong><small>' +
      escHtml(property.key + ' · ' + property.type) + '</small></div>' +
      badge + '<span class="wallpaper-engine-property-value">' + escHtml(wallpaperEnginePropertyValueLabel(property)) + '</span></div>';
  }).join('') : '<div class="wallpaper-engine-details-empty">这个项目没有声明可调整的用户属性。</div>';
  var canOpen = /^\d{5,32}$/.test(details.workshopId);
  if (weButton) weButton.disabled = !canOpen;
  if (workshopButton) workshopButton.disabled = !canOpen;
}

async function showWallpaperEngineProjectDetails(id) {
  id = String(id || '');
  var api = wallpaperEngineDesktopApi();
  wallpaperEngineProjectDetailsId = id;
  renderWallpaperEngineProjectDetails(null, '');
  if (!api || typeof api.getWallpaperEngineProjectDetails !== 'function') {
    renderWallpaperEngineProjectDetails(null, '当前环境不支持读取 Wallpaper Engine 项目设置');
    return;
  }
  try {
    var response = await api.getWallpaperEngineProjectDetails(id);
    if (wallpaperEngineProjectDetailsId !== id) return;
    if (!response || response.ok === false) throw new Error(response && response.error || '读取失败');
    var details = normalizeWallpaperEngineProjectDetails(response);
    if (!details) throw new Error('项目设置格式无效');
    renderWallpaperEngineProjectDetails(details, '');
  } catch (error) {
    if (wallpaperEngineProjectDetailsId === id) renderWallpaperEngineProjectDetails(null, error.message || '读取失败');
  }
}

function closeWallpaperEngineProjectDetails() {
  wallpaperEngineProjectDetailsId = '';
  var drawer = document.getElementById('wallpaper-engine-details-drawer');
  if (drawer) {
    drawer.classList.remove('show');
    drawer.setAttribute('aria-hidden', 'true');
  }
}

async function launchWallpaperEngineProjectDetails(target) {
  var id = wallpaperEngineProjectDetailsId;
  var api = wallpaperEngineDesktopApi();
  if (!id || !api || typeof api.openWallpaperEngineProjectDetails !== 'function') return;
  try {
    var response = await api.openWallpaperEngineProjectDetails(id, target === 'workshop' ? 'workshop' : 'we');
    if (!response || response.ok === false) throw new Error(response && response.error || '打开失败');
    if (response.opened === 'wallpaper-engine') showToast('已在 Wallpaper Engine 中定位此壁纸；可打开项目设置栏调整');
    else if (response.fallback) showToast('当前 WE 版本无法直接定位，已打开创意工坊详情');
    else showToast('已打开创意工坊详情');
  } catch (error) {
    showToast(error.message === 'WALLPAPER_ENGINE_WORKSHOP_DETAILS_UNAVAILABLE'
      ? '手动导入项目没有 Workshop ID，暂时无法在 WE 中定位'
      : (error.message || '无法打开 Wallpaper Engine 项目详情'));
  }
}

function scheduleWallpaperEngineLibraryRender() {
  clearTimeout(wallpaperEngineSearchRenderTimer);
  wallpaperEngineSearchRenderTimer = setTimeout(function () {
    wallpaperEngineSearchRenderTimer = 0;
    renderWallpaperEngineLibrary();
  }, 90);
}

function updateWallpaperEngineLibraryStatus(snapshot, error) {
  var status = document.getElementById('wallpaper-engine-library-status');
  if (!status) return;
  status.classList.toggle('loading', wallpaperEngineLibraryBusy);
  if (wallpaperEngineLibraryBusy) {
    status.textContent = '正在识别 Steam 创意工坊与本地项目…';
  } else if (error) {
    status.textContent = '识别失败：' + error;
  } else if (snapshot) {
    var runtimeText = snapshot.runtime && snapshot.runtime.available === false ? ' · 未找到可用的 Wallpaper Engine 本体' : '';
    status.textContent = '已识别 ' + (snapshot.count || 0) + ' 个项目 · ' + (snapshot.dynamicCount || 0) + ' 个媒体动态 · ' +
      (snapshot.enginePlayableCount || 0) + ' 个 Scene 原生运行 · ' + (snapshot.previewOnlyCount || 0) + ' 个安全预览 · 用时 ' + (snapshot.elapsedMs || 0) + 'ms' + runtimeText;
  } else {
    status.textContent = '等待识别本机 Wallpaper Engine 库';
  }
}

function consumeWallpaperEngineSnapshot(snapshot) {
  wallpaperEngineLibrarySnapshot = snapshot || null;
  if (snapshot && snapshot.transcoder) {
    console.info('[Wallpaper Engine] transcoder capabilities:', snapshot.transcoder);
  }
  wallpaperEngineMediaToken = /^[a-f0-9]{48}$/i.test(String(snapshot && snapshot.mediaToken || ''))
    ? String(snapshot.mediaToken).toLowerCase() : '';
  wallpaperEngineProjects = snapshot && Array.isArray(snapshot.projects)
    ? snapshot.projects.map(normalizeWallpaperEngineProject).filter(Boolean)
    : [];
  renderWallpaperEngineManualRoots();
  updateWallpaperEngineLibraryStatus(snapshot, '');
  renderWallpaperEngineLibrary();
  if (wallpaperEngineSelection.active) {
    var selected = wallpaperEngineProjectById(wallpaperEngineSelection.id);
    if (selected) {
      wallpaperEngineSelection = normalizeWallpaperEngineSelection(Object.assign({}, wallpaperEngineSelection, {
        title: selected.title,
        kind: wallpaperEngineSelection.kind === 'engine' && !selected.enginePlayable ? (selected.playable ? 'media' : 'preview') : wallpaperEngineSelection.kind,
        mediaType: wallpaperEngineSelection.kind === 'engine' && selected.enginePlayable ? 'video' : (wallpaperEngineSelection.kind === 'media' ? selected.mediaType : 'image'),
        mediaAnimated: selected.mediaAnimated,
        projectType: selected.projectType,
        hasPreview: selected.hasPreview,
        previewAnimated: selected.previewAnimated,
        updatedAt: selected.updatedAt
      }));
      saveWallpaperEngineSelection();
    }
  }
}

async function loadWallpaperEngineLibrary(force, showNotice) {
  var api = wallpaperEngineDesktopApi();
  if (!api || typeof api.listWallpaperEngineProjects !== 'function') {
    updateWallpaperEngineLibraryStatus(null, '仅桌面版支持本地壁纸识别');
    if (showNotice) showToast('当前环境不支持 Wallpaper Engine 本地识别');
    return [];
  }
  if (wallpaperEngineLibraryBusy) return wallpaperEngineProjects;
  wallpaperEngineLibraryBusy = true;
  var failure = '';
  updateWallpaperEngineLibraryStatus(null, '');
  renderWallpaperEngineLibrary();
  try {
    var snapshot = await api.listWallpaperEngineProjects({ force: force === true });
    if (!snapshot || snapshot.ok === false) throw new Error(snapshot && snapshot.error || '扫描失败');
    consumeWallpaperEngineSnapshot(snapshot);
    if (showNotice) showToast(snapshot.count ? ('已识别 ' + snapshot.count + ' 个 Wallpaper Engine 项目') : '没有识别到 Wallpaper Engine 项目');
    return wallpaperEngineProjects;
  } catch (e) {
    failure = e.message || '扫描失败';
    wallpaperEngineProjects = [];
    wallpaperEngineLibrarySnapshot = null;
    wallpaperEngineMediaToken = '';
    if (showNotice) showToast('Wallpaper Engine 识别失败');
    return [];
  } finally {
    wallpaperEngineLibraryBusy = false;
    updateWallpaperEngineLibraryStatus(wallpaperEngineLibrarySnapshot, failure);
    renderWallpaperEngineLibrary();
  }
}

async function openWallpaperEngineLibrary() {
  var modal = document.getElementById('wallpaper-engine-modal');
  if (modal) modal.classList.add('show');
  if (!wallpaperEngineLibrarySnapshot) await loadWallpaperEngineLibrary(false, false);
  else renderWallpaperEngineLibrary();
}

