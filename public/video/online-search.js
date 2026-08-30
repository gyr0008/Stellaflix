/*
 * Stellaflix 影视模块 — 全页搜索（Kazumi 风格）(拆债 #1 / 搜索页)
 *
 * 本文件从 online.js 抽出的「搜索页」全部逻辑：开关、历史下拉、内联结果网格、
 * 核心搜索编排、筛选面板桥接，以及加载期搜索栏事件绑定（focus/blur/click/keydown/input）。
 *
 * 共享状态与协调器函数统一经 SFV.onlineShared(S) 访问：
 *   - 共享状态：S.pageEl / S.searchInput / S.historyDrop / S.historyListEl / S.resultArea /
 *     S.uiMode / S.activePageId / S.stack / S._detailOrigin / S._currentSearchView 等；
 *   - 协调器函数（online.js 加载后填充）：S.ensure / S.closeOverlayAnimated / S.unlockBodyScroll /
 *     S.openDetail / S.openKazumiDetail / S.enrichIdentity / S.enrichTmdb / S.doInlineSearch 等。
 *
 * 加载顺序：须位于 online-shared.js 之后、online.js 之前。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var S = SFV.onlineShared;
  if (!S) { throw new Error('[SFV online-search] onlineShared 未加载，请检查 index.html 加载顺序'); }
  var doc = S.d();

  // ---- 开关 ----
  function toggleSearchPage() {
    console.log('[SFV-Search] toggleSearchPage called, 当前状态=' + (S.isSearchPageOpen() ? '已打开' : '已关闭'));
    if (S.isSearchPageOpen()) closeSearchPage();
    else openSearchPage();
  }

  function openSearchPage() {
    var elp = S.getSearchPage();
    if (!elp) {
      console.error('[SFV-Search] openSearchPage 失败：#sfv-search-page 未找到');
      return;
    }
    console.log('[SFV-Search] openSearchPage: 元素找到, 当前class=' + elp.className +
      ', body.video-space-active=' + (doc.body && doc.body.classList.contains('video-space-active')));
    try {
      S.ensure(); // 确保浏览层已初始化（doSearch 依赖 SFV.sources 等）
      // T156：打开搜索页前，先关闭浏览覆盖层（.sfv-browse），使搜索页与浏览层互斥，
      // 避免两者全屏层叠加（如片单页打开时右下角残留筛选 FAB）。
      if (S.closeOverlayAnimated) S.closeOverlayAnimated();
      // T157：离开浏览分页（搜索页为独立全屏层，z-index 高于 #top-right 覆盖其上），
      // 撤销 sfv-browse-active 作用域（closeOverlayAnimated 的 done 也会清，这里兜底）
      if (doc.body) doc.body.classList.remove('sfv-browse-active');
      elp.classList.add('sfv-search-open');
      console.log('[SFV-Search] openSearchPage: 添加 sfv-search-open 后 class=' + elp.className +
        ', isOpen=' + S.isSearchPageOpen());
      S.renderHistoryDrop();
      S.clearResultArea();
      S._currentSearchView = null;
      S.ensureFilterUi(); // 挂载筛选 FAB + 渲染已应用筛选条
      if (S.searchInput) {
        S.searchInput.value = '';
        updateClearBtn();
        setTimeout(function () { if (S.searchInput) S.searchInput.focus(); }, 350);
      }
      // 同步玻璃背景 DIY（与追片/历史/片单页对齐）
      if (SFV.pageBgDiy && SFV.pageBgDiy.sync) SFV.pageBgDiy.sync();
    } catch (openErr) {
      console.error('[SFV-Search] openSearchPage 抛错:', openErr);
    }
  }

  function closeSearchPage() {
    var elp = S.getSearchPage();
    if (!elp) return;
    elp.classList.remove('sfv-search-open');
    S.hideHistoryDrop();
    S._currentSearchView = null;
    // T158：关闭搜索页后彻底移除筛选 FAB（从 body 移除 + 清空引用），
    // 不再仅隐藏，避免退出后残留到首页等其它页。
    if (S.cleanupOrphanFloaters) S.cleanupOrphanFloaters();
    // 关闭搜索页后隐藏背景 DIY FAB，切回其他页时由对应页面 sync 接管
    if (SFV.pageBgDiy && SFV.pageBgDiy.sync) SFV.pageBgDiy.sync();
  }

  // 逐级返回专用（方案 A）：从搜索结果进入的详情返回时，隐藏浏览层并复原搜索页，
  // 保留 resultArea 中已渲染的结果网格（不复用 openSearchPage，后者会 clearResultArea 清空结果）。
  function restoreSearchPage() {
    S.destroyDetail();        // 详情→搜索逐级返回也必须清 sfv-plex-immersive（非圆形返回路径）
    S.closeOverlayAnimated(); // 覆盖层向下滑出（与进入上滑入镜像）
    var sp = S.getSearchPage();
    if (sp) sp.classList.add('sfv-search-open'); // 仅复原可见性，不重建、不清空结果
    // 复位浏览层栈态（与 close() 对齐，但目的地是搜索页而非首页）
    S.stack.length = 0;
    S.current = null;
    S.uiMode = 'view';
    S.activePageId = null;
    S._detailOrigin = null;
    S.unlockBodyScroll(); // 浏览层退出，恢复底层滚动（搜索页自行管理内部滚动）
  }

  // ---- 核心搜索：结果直接渲染在全页内（不跳转浏览层）----
  function doInlineSearch(kw) {
    if (!kw) return;
    // T123：搜索时关闭历史面板（不挤压结果区域）
    S.hideHistoryDrop();
    S.saveSearchHistory(kw);
    S.ensure();

    S.showSearchStatus('正在搜索「' + S.esc(kw) + '」…');

    var canCms = S.hasSources();
    var canKz = !!(SFV.kazumi && SFV.kazumi.hasRules && SFV.kazumi.hasRules());
    console.log('[SFV-DEBUG] doInlineSearch: keyword=' + kw + ', canCms=' + canCms + ', canKz=' + canKz);
    if (!canCms && !canKz) {
      S.showSearchStatus('请先添加片源或导入规则名再搜索。', 'warn');
      return;
    }

    var viewToken = { mode: 'inline-search', query: kw, _ts: Date.now() };
    S._currentSearchView = viewToken;

    var kzFilters = S.getFilterState() || {}; // SearchFilterState 实例，fromFilterState 仅序列化正向意图

    var cmsP = canCms ? SFV.sources.search(kw, { timeout: 12000 })
                      : Promise.resolve({ items: [], errors: [], noSource: true });
    var kzP  = canKz  ? SFV.kazumi.search(kw, { filters: kzFilters })
                      : Promise.resolve({ items: [], errors: [] });

    Promise.all([cmsP, kzP]).then(function (arr) {
      if (S._currentSearchView !== viewToken) return; // 已过时丢弃
      console.log('[SFV-DEBUG] raw cms items=' + (arr[0].items ? arr[0].items.length : 'n/a') +
        ', errors=' + (arr[0].errors ? arr[0].errors.length : 0) + (arr[0].noSource ? ', noSource' : '') +
        '; raw kazumi items=' + (arr[1].items ? arr[1].items.length : 'n/a') +
        ', errors=' + (arr[1].errors ? arr[1].errors.length : 0));
      var merged = (arr[0].items || []).concat(arr[1].items || []);
      if (!merged.length) {
        console.log('[SFV-DEBUG] merged empty, showing not-found status');
        S.showSearchStatus('没有找到「' + S.esc(kw) + '」的相关结果。');
        return;
      }
      var aggregated = (SFV.SearchFilterCore && SFV.SearchFilterCore.aggregateByLocalKey)
        ? SFV.SearchFilterCore.aggregateByLocalKey(merged)
        : merged;
      console.log('[SFV-DEBUG] aggregated count=' + aggregated.length);
      var tmdbEnabled = !!(SFV.tmdb && typeof SFV.tmdb.hasKey === 'function' && SFV.tmdb.hasKey() &&
                           typeof SFV.tmdb.bestMatch === 'function');
      S.showSearchStatus('正在聚合结果…');
      var pId = tmdbEnabled ? S.enrichIdentity(aggregated) : Promise.resolve(aggregated);
      pId.then(function (afterId) {
        if (S._currentSearchView !== viewToken) return;
        var fsNow = S.getFilterState();
        var needScore = fsNow && fsNow.minScore != null && tmdbEnabled;
        if (needScore) S.showSearchStatus('正在补全评分…');
        var chain = needScore
          ? S.enrichScores(afterId).then(function (enriched) {
              if (S._currentSearchView !== viewToken) return null;
              return S.applyResultFilters(enriched);
            })
          : Promise.resolve(S.applyResultFilters(afterId));
        chain.then(function (filtered) {
          if (S._currentSearchView !== viewToken || filtered == null) return;
          console.log('[SFV-DEBUG] filtered count=' + filtered.length);
          var ranked = (SFV.SearchFilterCore && SFV.SearchFilterCore.rankSearchResults)
            ? SFV.SearchFilterCore.rankSearchResults(filtered, kw) : filtered;
          console.log('[SFV-DEBUG] ranked count=' + ranked.length);
          if (ranked.length) {
            S.renderInlineResults(ranked, kw);
          } else {
            S.showSearchStatus('没有找到「' + S.esc(kw) + '」的相关结果。');
          }
        });
      }).catch(function (err) {
        if (S._currentSearchView !== viewToken) return;
        S.showSearchStatus('搜索出错：' + (err && err.message ? err.message : '未知错误'), 'error');
      });
    }).catch(function (err) {
      if (S._currentSearchView !== viewToken) return;
      S.showSearchStatus('搜索出错：' + (err && err.message ? err.message : '未知错误'), 'error');
    });
  }

  // ---- 结果区域操作 ----
  function clearResultArea() { if (S.resultArea) S.resultArea.innerHTML = ''; }

  // T166：搜索栏右侧「X」清空按钮的可见性（输入有内容才显示）
  function getClearBtn() { return doc.getElementById ? doc.getElementById('sfv-search-clear') : null; }
  function updateClearBtn() {
    var btn = getClearBtn();
    if (!btn) return;
    var has = !!(S.searchInput && S.searchInput.value.trim().length > 0);
    if (has) btn.classList.add('is-visible'); else btn.classList.remove('is-visible');
  }

  function showSearchStatus(msg, type) {
    if (!S.resultArea) return;
    var icons = { info: '🔍', warn: '⚠️', error: '❌' };
    S.resultArea.innerHTML = '<div class="sfv-search-status"><div class="sfv-status-icon">' +
      (icons[type] || icons.info) + '</div><div>' + msg + '</div></div>';
  }


  // ==== T120 关键修复：把 helper 函数定义在 IIFE 顶层，避免 bindCapsuleSearchBtn() 内
  // handler 引用 _getSearchInput 时报 ReferenceError（之前 helper 定义在 `{ ... }` 块内）。

  function bindCapsuleSearchBtn() {
    if (S._searchBound) return;
    S._searchBound = true;

    // (1) 胶囊按钮点击 -> 打开/关闭全页搜索
    doc.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('#sfv-capsule-search-btn') : null;
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      console.log('[SFV-Search] 胶囊搜索按钮被点击');
      if (global._sfvTryToggleSearch) global._sfvTryToggleSearch(); else toggleSearchPage();
    }, true);

    // (1b) 直接绑定 fallback（防止 capture 阶段被拦截）
    var capsuleBtn = doc.getElementById ? doc.getElementById('sfv-capsule-search-btn') : null;
    if (capsuleBtn) {
      capsuleBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        console.log('[SFV-Search] 胶囊按钮直接 click 触发');
        if (global._sfvTryToggleSearch) global._sfvTryToggleSearch(); else toggleSearchPage();
      });

      var pointerTap = null;
      capsuleBtn.addEventListener('pointerdown', function (ev) {
        pointerTap = { x: ev.clientX || 0, y: ev.clientY || 0, t: Date.now() };
      }, { passive: true });
      capsuleBtn.addEventListener('pointerup', function (ev) {
        if (!pointerTap) return;
        var dx = (ev.clientX || 0) - pointerTap.x;
        var dy = (ev.clientY || 0) - pointerTap.y;
        var dt = Date.now() - pointerTap.t;
        pointerTap = null;
        if (Math.sqrt(dx * dx + dy * dy) > 10 || dt > 700) return;
        ev.preventDefault();
        ev.stopPropagation();
        console.log('[SFV-Search] 胶囊按钮 pointerup 兜底触发');
        if (global._sfvTryToggleSearch) global._sfvTryToggleSearch(); else toggleSearchPage();
      });
    }

    // (1d) 坐标兜底
    function isOverSearchBtn(x, y) {
      var btn = doc.getElementById ? doc.getElementById('sfv-capsule-search-btn') : null;
      if (!btn) return false;
      // 隐藏按钮/不在布局中的按钮（display:none / 0x0）就不参与坐标命中，
      // 否则 getBoundingClientRect 返回全 0，会把程序化 input.click() 的 clientX/Y=0 误判成点了胶囊按钮。
      // 这会让文件选择器 / 上传面板的隐藏 input 全部触发 toggleSearchPage，表现为"按钮点了没反应"。
      var style = btn.ownerDocument && btn.ownerDocument.defaultView
        ? btn.ownerDocument.defaultView.getComputedStyle(btn) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      var r = btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
      if (!r) return false;
      if (r.width <= 0 || r.height <= 0) return false;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }
    // 真实指针事件 vs. 脚本合成事件（dispatchEvent / el.click()）。
    // 合成事件（例如文件 input.click()）没有真实坐标、也不是 isTrusted，不应该走"坐标兜底"。
    function isSuspiciousSyntheticEvent(ev) {
      if (typeof ev.isTrusted === 'boolean' && !ev.isTrusted) return true;
      // 坐标全 0 对窗口级兜底来说几乎不可能是真实点击（用户不会去点浏览器 chrome 外的 (0,0)）。
      if ((!ev.clientX && !ev.clientY) || (ev.clientX === 0 && ev.clientY === 0)) return true;
      return false;
    }
    if (global.addEventListener) {
      global.addEventListener('click', function (ev) {
        if (isSuspiciousSyntheticEvent(ev)) return;
        if (!isOverSearchBtn(ev.clientX || 0, ev.clientY || 0)) return;
        console.log('[SFV-Search] 窗口级 click 坐标兜底触发');
        ev.preventDefault();
        ev.stopPropagation();
        if (global._sfvTryToggleSearch) global._sfvTryToggleSearch(); else toggleSearchPage();
      }, true);
      global.addEventListener('pointerup', function (ev) {
        if (isSuspiciousSyntheticEvent(ev)) return;
        if (!isOverSearchBtn(ev.clientX || 0, ev.clientY || 0)) return;
        console.log('[SFV-Search] 窗口级 pointerup 坐标兜底触发');
        ev.preventDefault();
        ev.stopPropagation();
        if (global._sfvTryToggleSearch) global._sfvTryToggleSearch(); else toggleSearchPage();
      }, true);
    }

    // T118 直接绑定 fallback：AppBar ← 返回 + × 关闭按钮 在元素自身绑 click
    var appbarBack = doc.querySelector ? doc.querySelector('.sfv-search-appbar-back') : null;
    if (appbarBack) {
      appbarBack.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        console.log('[SFV-Search] AppBar ← 返回按钮直接 click 触发');
        closeSearchPage();
      });
    }
    var appbarClose = doc.querySelector ? doc.querySelector('.sfv-search-appbar-close') : null;
    if (appbarClose) {
      appbarClose.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        console.log('[SFV-Search] AppBar × 关闭按钮直接 click 触发');
        // T158（最终裁定·用户 2026-08-19）：搜索页 X 直接关闭整个 Electron 窗口——
        // 与详情胶囊 × / 片单追片页内 X 行为一致，用户要求三页页内 X 也退窗口。
        // 仅当 desktopWindow 桥可用时调用，缺失则回退 closeSearchPage() 防按钮卡死。
        if (global.desktopWindow && global.desktopWindow.close) global.desktopWindow.close();
        else closeSearchPage();
      });
    }
    var sfvInput = doc.getElementById ? doc.getElementById('sfv-search-input') : null;
    if (sfvInput) {
      sfvInput.addEventListener('click', function (ev) {
        try { sfvInput.focus(); } catch (e) {}
      });
    }

    // (2) 关闭/返回按钮 -> 关闭搜索页（D4 原为 page-close；T158 最终裁定改为退整个窗口，与详情胶囊 × 一致）
    doc.addEventListener('click', function (ev) {
      if (!S.isSearchPageOpen()) return;
      var quitBtn = ev.target.closest ? ev.target.closest('[data-sfv-search-quit]') : null;
      if (quitBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        console.log('[SFV-Search] × 关闭按钮触发, 调用 desktopWindow.close()');
        if (global.desktopWindow && global.desktopWindow.close) global.desktopWindow.close();
        else closeSearchPage();
        return;
      }
      var backBtn = ev.target.closest ? ev.target.closest('[data-sfv-search-back]') : null;
      if (backBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        console.log('[SFV-Search] ← 返回按钮点击触发, 调用 closeSearchPage()');
        closeSearchPage();
        console.log('[SFV-Search] closeSearchPage 执行后, 当前状态=' + (S.isSearchPageOpen() ? '已打开' : '已关闭'));
        return;
      }
      // 图片搜索（T116 已删除对应 DOM 按钮；其 click handler 随之移除，避免死代码）
      var closeBtn = ev.target.closest ? ev.target.closest('.sfv-search-close') : null;
      var leading = ev.target.closest ? ev.target.closest('.sfv-search-bar-leading') : null;
      if (closeBtn) { closeSearchPage(); return; }
      if (leading) {
        var icon = leading.querySelector ? leading.querySelector('.sfv-search-bar-icon') : null;
        if (icon && icon.getAttribute('data-sfv-mode') === 'back') {
          closeSearchPage();
        } else {
          var si = S._getSearchInput ? S._getSearchInput() : doc.getElementById('sfv-search-input');
          if (si) si.focus();
        }
      }
    }, true);

  } // <-- bindCapsuleSearchBtn 闭合

  // ==== T109f 关键修复：搜索栏交互事件必须在加载期注册（确保页面加载即生效）====
  {
    doc.addEventListener('focus', function (ev) {
      var si = S._getSearchInput();
      if (!S.isSearchPageOpen() || !si) return;
      if (ev.target === si) S.showHistoryDrop();
    }, true);

    doc.addEventListener('blur', function (ev) {
      var si = S._getSearchInput();
      if (!S.isSearchPageOpen() || !si) return;
      if (ev.target === si) { setTimeout(function () { S.hideHistoryDrop(); }, 150); }
    }, true);

    doc.addEventListener('click', function (ev) {
      if (!S.isSearchPageOpen()) return;
      var si = S._getSearchInput();
      if (!si) return;
      if (ev.target === si) return;
      var lead = ev.target.closest ? ev.target.closest('.sfv-search-bar-leading, .sfv-search-bar-trailing, .sfv-search-bar-act, .sfv-search-appbar') : null;
      if (lead) return;
      var bar = ev.target.closest ? ev.target.closest('.sfv-search-bar') : null;
      if (bar) {
        ev.preventDefault();
        try { si.focus(); } catch (e) {}
        if (typeof global.requestAnimationFrame === 'function') {
          global.requestAnimationFrame(function () {
            if (doc.activeElement !== si && typeof si.focus === 'function') {
              try { si.focus(); } catch (e) {}
            }
          });
        }
      }
    }, true);

    doc.addEventListener('click', function (ev) {
      if (!S.isSearchPageOpen()) return;
      var icon = ev.target.closest ? ev.target.closest('.sfv-search-bar-icon') : null;
      if (icon && icon.getAttribute && icon.getAttribute('data-sfv-mode') === 'back') {
        ev.preventDefault();
        ev.stopPropagation();
        console.log('[SFV-Search] ← 返回图标 click -> hideHistoryDrop');
        S.hideHistoryDrop();
        var si = S._getSearchInput();
        if (si) si.blur();
      }
    }, true);
  }

  {
    doc.addEventListener('click', function (ev) {
      if (!S.isSearchPageOpen()) return;
      var leading = ev.target.closest ? ev.target.closest('.sfv-search-bar-leading') : null;
      if (!leading) return;
      var icon = leading.querySelector ? leading.querySelector('.sfv-search-bar-icon') : null;
      if (icon && icon.getAttribute && icon.getAttribute('data-sfv-mode') === 'back') {
        S.hideHistoryDrop();
        var si = S._getSearchInput ? S._getSearchInput() : doc.getElementById('sfv-search-input');
        if (si) si.focus();
      }
    }, true);

    doc.addEventListener('click', function (ev) {
      if (!S.isSearchPageOpen()) return;

      var delBtn = ev.target.closest ? ev.target.closest('.sfv-history-item-del') : null;
      if (delBtn) {
        var item = delBtn.closest ? delBtn.closest('.sfv-history-item') : null;
        if (item) {
          var kw = item.getAttribute('data-sfv-kw');
          if (kw) S.removeSearchHistoryItem(kw);
        }
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }

      var item = ev.target.closest ? ev.target.closest('.sfv-history-item') : null;
      if (!item || !S.searchInput) return;
      var kw = item.getAttribute('data-sfv-kw');
      if (kw) { S.searchInput.value = kw; S.hideHistoryDrop(); doInlineSearch(kw); }
    }, true);

    doc.addEventListener('keydown', function (ev) {
      if (!S.isSearchPageOpen()) return;
      var si = S._getSearchInput();
      if (!si) return;
      if ((ev.key === 'Enter' || ev.keyCode === 13) && ev.target === si) {
        ev.preventDefault();
        ev.stopPropagation();
        var kw = (si.value || '').trim();
        if (kw) { doInlineSearch(kw); }
        return;
      }
      if (ev.key === 'Escape' || ev.keyCode === 27) {
        if (SFV.SearchFilter && SFV.SearchFilter.isOpen && SFV.SearchFilter.isOpen()) return;
        var hd = S._getHistoryDrop();
        if (hd && hd.classList.contains('sfv-history-visible')) {
          S.hideHistoryDrop();
          ev.preventDefault();
          ev.stopPropagation();
        } else {
          closeSearchPage();
          ev.preventDefault();
          ev.stopPropagation();
        }
        return;
      }
    }, true);

    doc.addEventListener('input', function (ev) {
      if (!S.isSearchPageOpen() || !S.searchInput || ev.target !== S.searchInput) return;
      updateClearBtn();
      if (S.historyDrop && S.historyDrop.classList.contains('sfv-history-visible')) {
        S.renderHistoryDrop((S.searchInput.value || '').trim());
      }
    }, true);
  }

  // T166：搜索栏右侧「X」清空按钮 —— 连线点击删除栏内信息
  {
    // mousedown 阶段阻止默认，避免点击 X 时输入框失焦（否则会触发 blur 隐藏历史面板、丢失焦点）
    doc.addEventListener('mousedown', function (ev) {
      if (!S.isSearchPageOpen()) return;
      var clearBtn = ev.target.closest ? ev.target.closest('#sfv-search-clear') : null;
      if (!clearBtn) return;
      ev.preventDefault();
    }, true);

    doc.addEventListener('click', function (ev) {
      if (!S.isSearchPageOpen()) return;
      var clearBtn = ev.target.closest ? ev.target.closest('#sfv-search-clear') : null;
      if (!clearBtn) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (S.searchInput) S.searchInput.value = '';
      if (typeof clearResultArea === 'function') clearResultArea();
      S.renderHistoryDrop();   // 清空后刷新历史面板（空输入 => 展示完整历史）
      S.showHistoryDrop();     // 重新展开历史面板
      updateClearBtn();        // 输入已空，隐藏 X
      try { if (S.searchInput) S.searchInput.focus(); } catch (e) {}
    }, true);
  }

  console.log('[SFV-DIAG] 搜索栏 focus/click/keydown/input 事件已在 IIFE 顶层注册（online-search.js）');

  // 注册到共享状态，供 online.js 协调器与门面调用
  S.toggleSearchPage = toggleSearchPage;
  S.openSearchPage = openSearchPage;
  S.closeSearchPage = closeSearchPage;
  S.restoreSearchPage = restoreSearchPage;
  S.doInlineSearch = doInlineSearch;
  S.clearResultArea = clearResultArea;
  S.showSearchStatus = showSearchStatus;
  S.bindCapsuleSearchBtn = bindCapsuleSearchBtn;
})(typeof window !== 'undefined' ? window : this);
