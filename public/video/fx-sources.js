/*
 * Stellaflix 影视模块 — 视觉控制台「系统」tab 内的「CMS10 片源」与「规则」折叠面板
 *
 * 历史：本文件早期是「视觉控制台」的第 6 个独立 tab（key=sfvsource），动态注入
 * `#fx-panel-tabs` 按钮与 `#fx-panel .fx-tab-page` 内容，并用 setFxPanelTab 包装覆盖白名单。
 *
 * 现在（2026-08-30）：按用户要求，将该独立 tab 折叠为「系统」tab 内的两个 fx-fold 面板：
 *   - CMS10 片源：原「片源」分区（表单 + 已添加列表）
 *   - 规则：原「规则」分区（导入按钮 + 已导入列表）
 *
 * 实现要点：
 *   1. 等待 `#fx-console-page-system` 出现后，向其末尾追加两个 fx-fold fx-console-group；
 *      DOM 结构与 console-workspace 中的 fxConsoleMakeGroup 完全一致，确保视觉对齐。
 *   2. fxConsoleMakeGroup / fxConsoleGroups 是 console-workspace 的文件私有，
 *      故在此手工复刻相同 DOM 与折叠交互（不写入 fxConsoleRegistry，搜索功能
 *      因此不会自动定位到本面板——次要特性，按需后续再桥接）。
 *   3. SFV.fxSources 暴露 openSources()/openRules() 供其他模块跳转使用，取代旧 setFxPanelTab('sfvsource')。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var CMS10_GROUP = 'cms10';
  var RULES_GROUP = 'rules';
  var SYSTEM_TAB_KEY = 'system';

  var rootEl = null;        // 包裹两个折叠面板的容器
  var cms10Fold = null;     // CMS10 折叠面板 section
  var rulesFold = null;     // 规则折叠面板 section
  var listEl = null;        // CMS10 已添加列表
  var rulesListEl = null;   // 规则已导入列表
  var injected = false;
  var pollTimer = null;
  var pollCount = 0;

  function d() { return global.document; }
  function byId(id) { var doc = d(); return doc && doc.getElementById ? doc.getElementById(id) : null; }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------- 折叠面板构造

  /**
   * 复刻 fxConsoleMakeGroup 的 DOM 结构（与 console-workspace 同名构造对齐），
   * 不依赖 fxConsoleMakeGroup 是否暴露到全局。
   */
  function makeFold(tabKey, groupKey, title, hint) {
    var fold = document.createElement('section');
    fold.className = 'fx-fold fx-console-group';
    fold.setAttribute('data-fx-console-group', groupKey);
    fold.setAttribute('data-fx-console-tab', tabKey);

    var groupId = 'fx-console-' + tabKey + '-' + groupKey;
    var head = document.createElement('button');
    head.type = 'button';
    head.id = groupId + '-head';
    head.className = 'fx-fold-head fx-console-group-head';
    head.setAttribute('aria-expanded', 'false');
    head.setAttribute('aria-controls', groupId + '-body');

    var titleEl = document.createElement('span');
    titleEl.className = 'fx-fold-title';
    var strong = document.createElement('strong');
    strong.textContent = title;
    var small = document.createElement('small');
    small.textContent = hint || '';
    titleEl.appendChild(strong);
    titleEl.appendChild(small);

    var arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '▶';
    head.appendChild(titleEl);
    head.appendChild(arrow);

    var body = document.createElement('div');
    body.id = groupId + '-body';
    body.className = 'fx-fold-body fx-console-group-body';

    fold.setAttribute('aria-labelledby', head.id);
    head.addEventListener('click', function () {
      var open = !fold.classList.contains('open');
      fold.classList.toggle('open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) onFoldOpen(groupKey);
      if (typeof global.repositionFxFloatingPanels === 'function') {
        try { global.repositionFxFloatingPanels(); } catch (e) {}
      }
    });

    fold.appendChild(head);
    fold.appendChild(body);
    return { fold: fold, body: body };
  }

  // ---------------------------------------------------------------- 内容构建

  function buildCms10BodyHtml() {
    return '' +
      '<div class="sfv-src-notice">' +
        'Stellaflix <strong>不提供、不存储</strong>任何影视资源，出厂不预置任何片源。' +
        '此处的站点由你自行添加，请自行确认其合法性与安全性，并遵守当地法律法规。' +
      '</div>' +
      '<div class="sfv-section-label">片源</div>' +
      '<div class="sfv-src-form">' +
        '<div class="sfv-input-row"><label>名称</label><input class="sfv-src-name" type="text" placeholder="可留空，默认取域名"></div>' +
        '<div class="sfv-input-row"><label>接口地址</label><input class="sfv-src-api" type="text" placeholder="如 https://.../api.php/provide/vod"></div>' +
        '<div class="sfv-form-actions"><button type="button" class="sfv-btn-primary sfv-src-add"><span>＋</span> 添加片源</button><span class="sfv-src-hint"></span></div>' +
      '</div>' +
      '<div class="sfv-section-label">已添加片源</div>' +
      '<div class="sfv-src-list"></div>';
  }

  function buildRulesBodyHtml() {
    return '' +
      '<div class="sfv-section-label">规则</div>' +
      '<div class="sfv-rules-notice">' +
        '导入搜索规则后，搜索会并行查询这些站点（与 CMS10 片源互补）。' +
        '规则文件为 .json 格式，可从规则库获取或手动编写。' +
      '</div>' +
      '<div class="sfv-rules-form">' +
        '<div class="sfv-form-actions">' +
          '<button type="button" class="sfv-btn-secondary sfv-rule-import">导入规则文件</button>' +
          '<input type="file" id="sfv-rule-file" accept=".json,application/json" hidden>' +
          '<span class="sfv-src-hint sfv-rule-hint"></span>' +
        '</div>' +
      '</div>' +
      '<div class="sfv-section-label">已导入规则</div>' +
      '<div class="sfv-rules-list"></div>';
  }

  // ---------------------------------------------------------------- 注入

  function injectFolds() {
    if (injected) return true;
    var systemPage = byId('fx-console-page-' + SYSTEM_TAB_KEY);
    if (!systemPage) return false;

    var cms10 = makeFold(
      SYSTEM_TAB_KEY, CMS10_GROUP,
      'CMS10 片源', '添加 / 管理 CMS10（苹果 V10 协议）站点'
    );
    var rules = makeFold(
      SYSTEM_TAB_KEY, RULES_GROUP,
      '规则', '导入 / 管理自定义搜索规则（与 CMS10 并行查询）'
    );

    cms10.body.innerHTML = buildCms10BodyHtml();
    rules.body.innerHTML = buildRulesBodyHtml();

    // 容器包裹两个面板，便于事件冒泡与对外引用
    rootEl = document.createElement('div');
    rootEl.className = 'sfv-source-folds';
    rootEl.setAttribute('data-sfv-source-folds', '1');
    rootEl.appendChild(cms10.fold);
    rootEl.appendChild(rules.fold);
    systemPage.appendChild(rootEl);

    cms10Fold = cms10.fold;
    rulesFold = rules.fold;
    listEl = rootEl.querySelector('.sfv-src-list');
    rulesListEl = rootEl.querySelector('.sfv-rules-list');

    bindEvents();
    renderList();
    renderRulesList();
    injected = true;
    return true;
  }

  function ensureInjected() {
    if (injectFolds()) return true;
    if (pollTimer) return false;
    // #fx-console-page-system 由 organizeFxConsoleWorkspace 在主脚本尾部创建，晚于本文件加载
    pollTimer = global.setInterval(function () {
      pollCount++;
      if (injectFolds() || pollCount > 80) {
        if (pollTimer) { global.clearInterval(pollTimer); pollTimer = null; }
      }
    }, 250);
    return false;
  }

  // ---------------------------------------------------------------- 列表渲染

  function renderList() {
    if (!listEl) return;
    var list = (SFV.sources && SFV.sources.getSources()) || [];
    if (!list.length) {
      listEl.innerHTML = '<div class="sfv-src-empty">还没有片源。添加后即可在影视空间中搜索与播放。</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var dotCls = '';
      html += '<div class="sfv-src-item' + (s.enabled ? ' enabled' : '') + '" data-sid="' + esc(s.id) + '" data-enabled="' + (s.enabled ? '1' : '0') + '">' +
        '<span class="sfv-src-dot' + dotCls + '"></span>' +
        '<div class="sfv-src-item-main">' +
          '<div class="sfv-src-item-name">' + esc(s.name) + '</div>' +
          '<div class="sfv-src-item-api">' + esc(s.api) + '</div>' +
          '<div class="sfv-src-item-state"></div>' +
        '</div>' +
        '<div class="sfv-src-item-ops">' +
          '<button type="button" class="fx-mini-btn sfv-src-toggle">' + (s.enabled ? '已启用' : '已停用') + '</button>' +
          '<button type="button" class="fx-mini-btn ghost sfv-src-test">测试</button>' +
          '<button type="button" class="fx-mini-btn ghost sfv-src-del">删除</button>' +
        '</div>' +
      '</div>';
    }
    listEl.innerHTML = html;
  }

  function renderRulesList() {
    if (!rulesListEl) return;
    var kz = SFV.kazumi;
    if (!kz || !kz.listRules) {
      rulesListEl.innerHTML = '<div class="sfv-src-empty">规则模块未加载。</div>';
      return;
    }
    var rules = kz.listRules();
    if (!rules.length) {
      rulesListEl.innerHTML = '<div class="sfv-src-empty">尚未导入任何规则。导入后，搜索会并行查询这些站点（与 CMS10 片源互补）。</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      var rDotCls = '';
      if (r.enabled) { rDotCls = (r.valid !== false) ? ' status-ok' : ' status-bad'; }
      html += '<div class="sfv-src-item sfv-rule-item' + (r.enabled ? ' enabled' : '') + '" data-rid="' + esc(r.name || r.id || i) + '">' +
        '<span class="sfv-src-dot' + rDotCls + '"></span>' +
        '<div class="sfv-src-item-main">' +
          '<div class="sfv-src-item-name">' + esc(r.name) + '</div>' +
          '<div class="sfv-src-item-api">' + (r.searchMode || 'xpath') + ' · ' + (r.baseUrl || '—') + (r.valid ? '' : ' · <span class="sfv-rule-warn">不完整</span>') + '</div>' +
        '</div>' +
        '<div class="sfv-src-item-ops">' +
          '<button type="button" class="fx-mini-btn sfv-rule-toggle">' + (r.enabled ? '停用' : '启用') + '</button>' +
          '<button type="button" class="fx-mini-btn ghost sfv-rule-del">删除</button>' +
        '</div>' +
      '</div>';
    }
    rulesListEl.innerHTML = html;
  }

  // ---------------------------------------------------------------- 提示文案

  function hint(msg, bad) {
    var target = null;
    if (rootEl) target = rootEl.querySelector('.sfv-src-hint') || rootEl.querySelector('.sfv-rule-hint');
    if (!target) return;
    target.textContent = msg || '';
    target.className = (target.className.indexOf('sfv-rule-hint') !== -1 ? 'sfv-rule-hint' : 'sfv-src-hint') + (bad ? ' bad' : '');
  }

  var REASON_TEXT = {
    'empty-api': '接口地址不能为空',
    'invalid-api-url': '接口地址格式不正确',
    'duplicate-api': '该接口已存在',
    'empty-list': '接口可达，但没有返回数据',
    'invalid-json': '返回内容不是合法 JSON',
    'fetch-unavailable': '当前环境不支持网络请求',
  };
  function reasonText(r) {
    if (!r) return '未知原因';
    if (REASON_TEXT[r]) return REASON_TEXT[r];
    if (r.indexOf('unsupported-scheme') === 0) return '仅支持 http / https';
    if (r.indexOf('http-') === 0) return '服务端返回 ' + r.slice(5);
    if (r === 'AbortError' || /abort/i.test(r)) return '请求超时';
    return r;
  }

  // ---------------------------------------------------------------- 事件

  function bindEvents() {
    if (!rootEl) return;

    rootEl.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.classList) return;

      // 添加片源
      if (t.classList.contains('sfv-src-add')) {
        var nameEl = rootEl.querySelector('.sfv-src-name');
        var apiEl = rootEl.querySelector('.sfv-src-api');
        var res = SFV.sources.addSource({ name: nameEl.value, api: apiEl.value });
        if (!res.ok) { hint(reasonText(res.reason), true); return; }
        nameEl.value = ''; apiEl.value = '';
        hint('已添加：' + res.source.name, false);
        renderList();
        return;
      }

      // 导入规则按钮
      if (t.classList.contains('sfv-rule-import')) {
        var fileInput = rootEl.querySelector('#sfv-rule-file');
        if (fileInput) fileInput.click();
        return;
      }

      // 规则项操作（在 .sfv-rule-item 内）
      var ruleItem = t.closest ? t.closest('.sfv-rule-item') : null;
      if (ruleItem) {
        var rid = ruleItem.getAttribute('data-rid');
        var kz = SFV.kazumi;
        if (t.classList.contains('sfv-rule-del') && kz && kz.removeRule) {
          kz.removeRule(rid);
          renderRulesList();
          return;
        }
        if (t.classList.contains('sfv-rule-toggle') && kz && kz.listRules) {
          var allRules = kz.listRules();
          var targetRule = null;
          for (var ri = 0; ri < allRules.length; ri++) {
            if (String(allRules[ri].name || allRules[ri].id || ri) === String(rid)) { targetRule = allRules[ri]; break; }
          }
          if (targetRule && kz.setEnabled) {
            kz.setEnabled(targetRule.name, !targetRule.enabled);
          }
          renderRulesList();
          return;
        }
      }

      // 片源项操作（在 .sfv-src-item 内）
      var item = t.closest ? t.closest('.sfv-src-item') : null;
      if (!item) return;
      var sid = item.getAttribute('data-sid');
      var stateEl = item.querySelector('.sfv-src-item-state');

      if (t.classList.contains('sfv-src-del')) {
        SFV.sources.removeSource(sid);
        renderList();
        return;
      }
      if (t.classList.contains('sfv-src-toggle')) {
        var all = SFV.sources.getSources();
        var cur = null;
        for (var i = 0; i < all.length; i++) if (all[i].id === sid) cur = all[i];
        if (!cur) return;
        SFV.sources.setEnabled(sid, !cur.enabled);
        renderList();
        return;
      }
      if (t.classList.contains('sfv-src-test')) {
        var all2 = SFV.sources.getSources();
        var src = null;
        for (var j = 0; j < all2.length; j++) if (all2[j].id === sid) src = all2[j];
        if (!src) return;
        var dotEl = item.querySelector('.sfv-src-dot');
        t.disabled = true;
        if (stateEl) { stateEl.textContent = '测试中…'; stateEl.className = 'sfv-src-item-state'; }
        SFV.sources.testSource(src).then(function (testResult) {
          t.disabled = false;
          item.classList.remove('ok', 'bad');
          if (testResult.ok) {
            setDotStatus(dotEl, 'ok');
            item.classList.add('ok');
            if (stateEl) { stateEl.textContent = '可用 · 返回 ' + testResult.count + ' 条 · ' + testResult.ms + 'ms'; stateEl.className = 'sfv-src-item-state ok'; }
          } else {
            setDotStatus(dotEl, 'bad');
            item.classList.add('bad');
            if (stateEl) { stateEl.textContent = '不可用：' + reasonText(testResult.reason); stateEl.className = 'sfv-src-item-state bad'; }
          }
        });
      }
    });

    rootEl.addEventListener('keydown', function (ev) {
      if (ev && (ev.key === 'Enter' || ev.keyCode === 13)) {
        var t = ev.target;
        if (t && t.classList && (t.classList.contains('sfv-src-api') || t.classList.contains('sfv-src-name'))) {
          var btn = rootEl.querySelector('.sfv-src-add');
          if (btn) btn.click();
        }
      }
    });

    // 规则文件选择后读取导入
    var ruleFileInput = rootEl.querySelector('#sfv-rule-file');
    if (ruleFileInput) {
      ruleFileInput.addEventListener('change', function () {
        var files = ruleFileInput.files;
        if (!files || !files.length) return;
        var f = files[0];
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var data = JSON.parse(reader.result);
            var kz = SFV.kazumi;
            if (!kz || !kz.importRule) { hint('规则模块未加载，无法导入。', true); return; }
            var res = kz.importRule(data);
            if (Array.isArray(res)) {
              hint('已导入 ' + res.length + ' 条规则', false);
            } else if (res && res.ok) {
              hint('已导入 ' + (res.count || res.names ? res.count || res.names.length : '?') + ' 条规则' + (res.names && res.names.length ? '：' + res.names.join(', ') : ''), false);
            } else if (res) {
              hint('已导入规则（请检查「已导入规则」列表确认）', false);
            } else {
              hint('导入失败：未返回有效结果', true);
            }
            renderRulesList();
          } catch (e) {
            hint('导入失败：' + (e && e.message ? e.message : '文件格式不合法的 JSON'), true);
          }
          ruleFileInput.value = '';
        };
        reader.readAsText(f);
      });
    }
  }

  // ---------------------------------------------------------------- 自动状态检查

  function setDotStatus(dotEl, status) {
    if (!dotEl) return;
    dotEl.classList.remove('status-ok', 'status-bad');
    if (status === 'ok') dotEl.classList.add('status-ok');
    else if (status === 'bad') dotEl.classList.add('status-bad');
  }

  /**
   * 对所有已启用片源轻量探测，串行发起。结果驱动圆点着色（绿=通 / 红=断）。
   * 与原实现保持一致行为：仅探测 enabled 源；disabled 保持灰。
   */
  function autoCheckStatus() {
    if (!listEl) return;
    var items = listEl.querySelectorAll('.sfv-src-item[data-enabled="1"]');
    if (!items.length) return;
    for (var k = 0; k < items.length; k++) {
      var dot = items[k].querySelector('.sfv-src-dot');
      setDotStatus(dot, '');
    }
    var idx = 0;
    function next() {
      if (idx >= items.length) return;
      var item = items[idx++];
      var sid = item.getAttribute('data-sid');
      var dot = item.querySelector('.sfv-src-dot');
      var stateEl = item.querySelector('.sfv-src-item-state');
      var all = SFV.sources.getSources();
      var src = null;
      for (var j = 0; j < all.length; j++) { if (all[j].id === sid) { src = all[j]; break; } }
      if (!src) { next(); return; }
      if (stateEl) { stateEl.textContent = '检测中…'; stateEl.className = 'sfv-src-item-state'; }
      SFV.sources.testSource(src).then(function (testResult) {
        if (!dot) return;
        item.classList.remove('ok', 'bad');
        if (testResult.ok) {
          setDotStatus(dot, 'ok');
          item.classList.add('ok');
          if (stateEl) { stateEl.textContent = '可用 · ' + testResult.count + ' 条 · ' + testResult.ms + 'ms'; stateEl.className = 'sfv-src-item-state ok'; }
        } else {
          setDotStatus(dot, 'bad');
          item.classList.add('bad');
          if (stateEl) { stateEl.textContent = '不可用：' + reasonText(testResult.reason); stateEl.className = 'sfv-src-item-state bad'; }
        }
        next();
      }).catch(function () {
        if (dot) setDotStatus(dot, 'bad');
        if (stateEl) { stateEl.textContent = '检测失败'; stateEl.className = 'sfv-src-item-state bad'; }
        next();
      });
    }
    next();
  }

  /**
   * 折叠面板展开时的副作用：刷新列表；CMS10 展开时延迟触发自动探测。
   */
  function onFoldOpen(groupKey) {
    renderList();
    renderRulesList();
    if (groupKey === CMS10_GROUP) {
      setTimeout(function () { autoCheckStatus(); }, 300);
    }
  }

  // ---------------------------------------------------------------- 公开 API

  /**
   * 打开「系统」tab 并展开指定折叠面板。
   * @param {string} [groupKey='cms10']
   */
  function openGroup(groupKey) {
    if (typeof global.toggleFxPanel === 'function') {
      try { global.toggleFxPanel(true); } catch (e) {}
    }
    if (typeof global.setFxPanelTab === 'function') {
      try { global.setFxPanelTab(SYSTEM_TAB_KEY); } catch (e) {}
    }
    if (!ensureInjected()) return false;
    var fold = groupKey === RULES_GROUP ? rulesFold : cms10Fold;
    if (!fold) return false;
    fold.classList.add('open');
    var head = fold.querySelector('.fx-console-group-head');
    if (head) head.setAttribute('aria-expanded', 'true');
    if (typeof global.repositionFxFloatingPanels === 'function') {
      try { global.repositionFxFloatingPanels(); } catch (e) {}
    }
    if (fold.scrollIntoView) {
      try { fold.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    }
    onFoldOpen(groupKey === RULES_GROUP ? RULES_GROUP : CMS10_GROUP);
    return true;
  }

  function openSources() { return openGroup(CMS10_GROUP); }
  function openRules()   { return openGroup(RULES_GROUP); }
  function refresh() {
    renderList();
    renderRulesList();
  }

  // ---------------------------------------------------------------- 启动

  SFV.fxSources = {
    openSources: openSources,
    openRules: openRules,
    openGroup: openGroup,
    refresh: refresh,
    isInjected: function () { return injected; },
    reasonText: reasonText,
    SYSTEM_TAB_KEY: SYSTEM_TAB_KEY,
    CMS10_GROUP: CMS10_GROUP,
    RULES_GROUP: RULES_GROUP,
  };

  function boot() {
    var doc = d();
    if (doc && doc.readyState === 'loading' && doc.addEventListener) {
      doc.addEventListener('DOMContentLoaded', ensureInjected);
    } else {
      ensureInjected();
    }
  }
  boot();
})(typeof window !== 'undefined' ? window : this);
