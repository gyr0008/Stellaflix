/*
 * Stellaflix 影视模块 — online 协调器 · 集群 C：分类列表 / 入口动作 / 规则面板
 *
 * 从 online.js 拆出（#6-b 可维护性债拆分）。持有四类分类列表渲染、本地/地址/片源入口动作、
 * Kazumi 规则管理面板与播放编排薄委托。跨集群调用统一经共享状态 S（SFV.onlineShared）路由；
 * online.js 保留薄别名委托，调用点零改动。
 *
 * 合规红线：不内置任何站点地址；api_site 由用户手动导入。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var S = SFV.onlineShared;
  if (!S) { throw new Error('[SFV online-actions] onlineShared 未加载，请检查 index.html 加载顺序'); }
  var OC = SFV.onlineCore;
  if (!OC) { throw new Error('[SFV online-actions] onlineCore 未加载，请检查 index.html 加载顺序'); }

  // 重建 online.js 中的局部别名（来自 S / OC，运行时已就绪）
  function d() { return S.d(); }
  var el = S.el, toast = S.toast;
  var doc = S.d();
  var esc = OC.esc, trackLabel = OC.trackLabel, TRACK_META = OC.TRACK_META;

  // ---------------------------------------------------------------- 四类列表
  function renderCategory(v) {
    // 追片：5 状态互斥分区页，独立渲染
    if (v.field === 'track') { S.renderTrackPage(); return; }
    if (v.field === 'liked' || v.field === 'inList' || v.field === 'history') {
      var cmeta = S.CATEGORY_META[v.field] || S.CATEGORY_META.history;
      S.titleEl.textContent = cmeta.label;
      S.bodyEl.innerHTML = '';
      var cwrap = el('div', 'sfv-placeholder');
      cwrap.appendChild(el('div', 'sfv-placeholder-icon', '📂'));
      cwrap.appendChild(el('div', 'sfv-placeholder-title', cmeta.label + '板块建设中'));
      cwrap.appendChild(el('div', 'sfv-placeholder-sub', '该板块正在打磨，敬请期待。'));
      S.bodyEl.appendChild(cwrap);
      if (SFV.pageBgDiy) SFV.pageBgDiy.sync();   // 历史/liked/inList 占位页也激活背景 DIY（与追片页对称）
      return;
    }
    var meta = S.CATEGORY_META[v.field] || S.CATEGORY_META.history;
    S.titleEl.textContent = meta.label;
    var keys = SFV.model ? SFV.model.getKeysByFlag(meta.field) : [];
    var list = SFV.model ? SFV.model.resolveList(keys) : [];
    S.bodyEl.innerHTML = '';
    if (!list.length) { S.setNote(meta.empty); return; }
    S.setNote('');
    var grid = el('div', 'sfv-grid');
    list.forEach(function (it) {
      var card = el('button', 'sfv-card');
      card.type = 'button';
      var cover = el('div', 'sfv-card-cover');
      if (it.pic) {
        var img = el('img', 'sfv-card-img'); img.src = it.pic; img.alt = it.title || ''; img.loading = 'lazy';
        img.addEventListener('error', function () { img.style.display = 'none'; cover.classList.add('sfv-cover--broken'); });
        cover.appendChild(img);
      } else cover.textContent = '🎬';
      var name = el('div', 'sfv-card-name', it.title || '未命名');
      var sub = el('div', 'sfv-card-sub', it.year || '');
      card.appendChild(cover); card.appendChild(name); card.appendChild(sub);
      card.addEventListener('click', function () { S.openDetailFromMeta(Object.assign({}, it, { _origin: 'history' })); });
      grid.appendChild(card);
      S.enrichTmdb(card, it);
    });
    S.bodyEl.appendChild(grid);
  }

  // ---------------------------------------------------------------- 记录
  function recordMeta(rec) { if (SFV.model && SFV.model.setMeta) SFV.model.setMeta(rec); }
  function recordHistory(rec) { if (SFV.model && SFV.model.addHistory) SFV.model.addHistory(rec); }

  // ---------------------------------------------------------------- 入口动作
  function openLocal() { if (SFV.player) SFV.player.openFilePicker(); }
  function openUrlPrompt() {
    if (S.overlay.urlBar && S.overlay.urlBar.parentNode) {
      S.overlay.urlBar.parentNode.removeChild(S.overlay.urlBar);
      S.overlay.urlBar = null;
      return;
    }
    var bar = el('div', 'sfv-urlbar sfv-browse-urlbar');
    var input = el('input', 'sfv-urlbar-input');
    input.type = 'text';
    input.placeholder = '粘贴视频直链（mp4 / m3u8 …），回车打开';
    var ok = el('button', 'sfv-urlbar-btn', '打开');
    var cancel = el('button', 'sfv-urlbar-btn', '取消');
    var submit = function () {
      var v = (input.value || '').trim();
      if (!v) return;
      var r = SFV.source ? SFV.source.resolve(v) : null;
      if (r && !r.ok) { toast('无法识别的地址：' + r.reason); return; }
      if (r && r.kind === 'hls' && r.requiresHlsLib) toast('该环境不原生支持 HLS，可能无法播放');
      if (SFV.source) SFV.source.open(v);
      closeUrlBar();
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', closeUrlBar);
    input.addEventListener('keydown', function (ev) {
      if (ev && (ev.key === 'Enter' || ev.keyCode === 13)) submit();
      if (ev && (ev.key === 'Escape' || ev.keyCode === 27)) closeUrlBar();
    });
    bar.appendChild(input); bar.appendChild(ok); bar.appendChild(cancel);
    S.overlay.appendChild(bar);
    S.overlay.urlBar = bar;
    if (input.focus) { try { input.focus(); } catch (e) {} }
    function closeUrlBar() { if (bar.parentNode) bar.parentNode.removeChild(bar); S.overlay.urlBar = null; }
  }
  function openSources() {
    var opened = false;
    // 跳转「系统 › CMS10 片源」折叠面板（替代历史的独立片源 tab）
    if (SFV.fxSources && typeof SFV.fxSources.openSources === 'function') {
      try { SFV.fxSources.openSources(); opened = true; return; } catch (e) {}
    }
    // 兜底：toggleFxPanel + setFxPanelTab('system') + 让用户手动展开折叠面板
    if (typeof global.toggleFxPanel === 'function') {
      try { global.toggleFxPanel(true); opened = true; } catch (e) {}
    }
    if (typeof global.setFxPanelTab === 'function') {
      try { global.setFxPanelTab('system'); opened = true; } catch (e) {}
    }
    if (!opened) toast('未找到视觉控制台「CMS10」入口，请确认 fx-sources.js 已加载。');
  }

  // ---------------------------------------------------------------- 规则管理面板（Kazumi）
  function openRules() {
    S.ensure();
    S.pushView({ mode: 'rules' });
  }

  function renderRules(v) {
    S.titleEl.textContent = '规则管理 · Kazumi';
    S.bodyEl.innerHTML = '';
    S.setNote('');
    if (!SFV.kazumi) {
      S.bodyEl.appendChild(el('div', 'sfv-browse-sub', 'Kazumi 引擎未就绪（video/kazumi/*.js 未引入）。'));
      return;
    }

    var box = el('div', 'sfv-rules-import');
    box.appendChild(el('div', 'sfv-rules-import-title', '导入规则（粘贴 Kazumi 规则 JSON，支持单条或数组）'));
    var ta = el('textarea', 'sfv-rules-textarea');
    ta.placeholder = '{\n  "name": "示例",\n  "baseURL": "https://example.com",\n  "searchURL": "/search?wd=@keyword",\n  "searchList": "//div[@class=\'item\']",\n  "searchName": ".//a/text()",\n  "searchResult": ".//a"\n}';
    box.appendChild(ta);
    var row = el('div', 'sfv-rules-import-row');
    var bImport = el('button', 'sfv-rules-btn', '导入');
    bImport.type = 'button';
    bImport.addEventListener('click', function () {
      var txt = (ta.value || '').trim();
      if (!txt) { toast('请先粘贴规则 JSON'); return; }
      try {
        var added = SFV.kazumi.importRule(txt);
        toast('已导入 ' + (added && added.length ? added.length : 0) + ' 条规则');
        renderRules(v);
      } catch (e) {
        toast('导入失败：' + (e && e.message ? e.message : '格式错误'));
      }
    });
    var bFile = el('button', 'sfv-rules-btn', '从文件导入');
    bFile.type = 'button';
    var fileInput = el('input', 'sfv-rules-file');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';
    bFile.addEventListener('click', function () { try { fileInput.click(); } catch (e) {} });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var added = SFV.kazumi.importRule(String(reader.result));
          toast('已导入 ' + (added && added.length ? added.length : 0) + ' 条');
          renderRules(v);
        } catch (e) { toast('导入失败：' + (e && e.message ? e.message : '格式错误')); }
      };
      reader.readAsText(f);
    });
    row.appendChild(bImport); row.appendChild(bFile); row.appendChild(fileInput);
    box.appendChild(row);
    S.bodyEl.appendChild(box);

    var rules = SFV.kazumi.listRules();
    if (!rules.length) {
      S.bodyEl.appendChild(el('div', 'sfv-browse-sub', '尚未导入任何规则。导入后，搜索会并行查询这些站点（与 CMS10 片源互补）。'));
      return;
    }
    var list = el('div', 'sfv-rules-list');
    rules.forEach(function (r) {
      var item = el('div', 'sfv-rules-item');
      var info = el('div', 'sfv-rules-item-info');
      info.appendChild(el('div', 'sfv-rules-item-name', r.name));
      info.appendChild(el('div', 'sfv-rules-item-meta', r.searchMode + ' · ' + (r.baseUrl || '') + (r.valid ? '' : ' · 不完整')));
      item.appendChild(info);
      var acts = el('div', 'sfv-rules-item-acts');
      var bToggle = el('button', 'sfv-rules-btn' + (r.enabled ? ' on' : ''), r.enabled ? '已启用' : '已禁用');
      bToggle.type = 'button';
      bToggle.addEventListener('click', function () {
        SFV.kazumi.setEnabled(r.name, !r.enabled);
        renderRules(v);
      });
      var bDel = el('button', 'sfv-rules-btn sfv-rules-btn--danger', '删除');
      bDel.type = 'button';
      bDel.addEventListener('click', function () {
        SFV.kazumi.removeRule(r.name);
        renderRules(v);
      });
      acts.appendChild(bToggle); acts.appendChild(bDel);
      item.appendChild(acts);
      list.appendChild(item);
    });
    S.bodyEl.appendChild(list);
  }

  // P4：逻辑已迁至 play-orchestrator.js，此处退化为薄委托（保持对外 API 不变）。
  function registerNextEpisode(view, ep, play) {
    if (SFV.playOrchestrator) SFV.playOrchestrator.registerNextEpisode(view, ep, play);
  }
  function playEpisode(view, ep, play, opt) {
    if (SFV.playOrchestrator) SFV.playOrchestrator.play(view, ep, play, opt);
  }

  // ---------------------------------------------------------------- 注册到共享状态 S + 命名空间
  S.renderCategory = renderCategory;
  S.recordMeta = recordMeta;
  S.recordHistory = recordHistory;
  S.openLocal = openLocal;
  S.openUrlPrompt = openUrlPrompt;
  S.openSources = openSources;
  S.openRules = openRules;
  S.renderRules = renderRules;
  S.registerNextEpisode = registerNextEpisode;
  S.playEpisode = playEpisode;

  SFV.onlineActions = {
    renderCategory: renderCategory, recordMeta: recordMeta, recordHistory: recordHistory,
    openLocal: openLocal, openUrlPrompt: openUrlPrompt, openSources: openSources,
    openRules: openRules, renderRules: renderRules,
    registerNextEpisode: registerNextEpisode, playEpisode: playEpisode,
  };

  console.log('[SFV-DIAG] online-actions.js 集群已加载（分类列表/入口动作/规则面板）');
})(typeof window !== 'undefined' ? window : this);
