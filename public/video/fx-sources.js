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
  var repoPanelEl = null;   // 内置规则仓库 glass 面板
  var repoPanelLoading = false;
  var repoPanelLoaded = false;

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
      '<div class="sfv-section-label">批量添加</div>' +
      '<div class="sfv-src-form">' +
        '<textarea class="sfv-bulk-text" rows="5" placeholder="每行一个片源：名称,接口地址（名称可留空，自动取域名）&#10;例：&#10;我的片源,https://example.com/api.php/provide/vod&#10;https://another.com/api.php/provide/vod"></textarea>' +
        '<div class="sfv-form-actions">' +
          '<button type="button" class="sfv-btn-primary sfv-bulk-add"><span>＋</span> 批量导入</button>' +
          '<button type="button" class="sfv-btn-secondary sfv-bulk-file-btn">导入片源列表</button>' +
          '<input type="file" id="sfv-bulk-file" accept=".json,.txt,application/json,text/plain" multiple hidden>' +
          '<span class="sfv-src-hint"></span>' +
        '</div>' +
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
          '<button type="button" class="sfv-btn-secondary sfv-rule-repo-btn">内置规则仓库</button>' +
          '<input type="file" id="sfv-rule-file" accept=".json,application/json" multiple hidden>' +
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
      'CMS10', '添加 / 管理 CMS10 站点'
    );
    var rules = makeFold(
      SYSTEM_TAB_KEY, RULES_GROUP,
      '规则', '导入 / 管理自定义搜索规则'
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
      rulesListEl.innerHTML = '<div class="sfv-src-empty">尚未导入任何规则。</div>';
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

  // ---------------------------------------------------------------- 批量导入解析

  /**
   * 解析多行文本为片源条目数组。
   * 行首为 http(s):// 视为纯接口（名称留空）；否则按首个逗号拆 名称,接口地址；空行跳过。
   */
  function parseSourceLines(text) {
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var name = '';
      var api = '';
      if (/^https?:\/\//i.test(line)) {
        api = line;
      } else {
        var c = line.indexOf(',');
        if (c < 0) {
          api = line;
        } else {
          name = line.slice(0, c).trim();
          api = line.slice(c + 1).trim();
        }
      }
      out.push({ name: name, api: api });
    }
    return out;
  }

  /**
   * 把单条记录归一化为 {name, api}（兼容 {name,api} 与 {name,url}）。
   */
  function normEntry(e) {
    if (!e || typeof e !== 'object') return { name: '', api: '' };
    return {
      name: String(e.name == null ? '' : e.name).trim(),
      api: String(e.api != null ? e.api : (e.url != null ? e.url : '')).trim(),
    };
  }

  /**
   * 解析单个片源文件内容（.json / .txt）。
   * .json：数组逐条、对象单条；.txt / 其它：按行解析。
   * @returns {Array<{name:string, api:string}>}
   */
  function parseSourceFileContent(filename, text) {
    var lower = String(filename || '').toLowerCase();
    if (lower.indexOf('.json') !== -1) {
      var data = JSON.parse(text);
      var list = [];
      if (Array.isArray(data)) {
        for (var a = 0; a < data.length; a++) list.push(normEntry(data[a]));
      } else if (data && typeof data === 'object') {
        list.push(normEntry(data));
      }
      return list;
    }
    return parseSourceLines(text);
  }

  /**
   * 批量写入片源：循环 addSource，累计 成功 / 重复 / 错误，结束给出汇总提示。
   * 冲突策略：跳过并汇总（不中断）。
   */
  function bulkAddSources(entries) {
    if (!entries || !entries.length) { hint('没有可导入的片源。', true); return; }
    var added = 0, dup = 0, bad = 0;
    for (var i = 0; i < entries.length; i++) {
      var res = SFV.sources.addSource(entries[i]);
      if (res && res.ok) added++;
      else if (res && res.reason === 'duplicate-api') dup++;
      else bad++;
    }
    hint('批量导入完成：成功 ' + added + ' / 重复跳过 ' + dup + ' / 格式错误 ' + bad, bad > 0);
    renderList();
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

      // 批量导入（文本粘贴）
      if (t.classList.contains('sfv-bulk-add')) {
        var ta = rootEl.querySelector('.sfv-bulk-text');
        if (ta) bulkAddSources(parseSourceLines(ta.value));
        return;
      }

      // 触发批量文件选择
      if (t.classList.contains('sfv-bulk-file-btn')) {
        var bulkFile = rootEl.querySelector('#sfv-bulk-file');
        if (bulkFile) bulkFile.click();
        return;
      }

      // 导入规则按钮
      if (t.classList.contains('sfv-rule-import')) {
        var fileInput = rootEl.querySelector('#sfv-rule-file');
        if (fileInput) fileInput.click();
        return;
      }

      // 内置规则仓库按钮
      if (t.classList.contains('sfv-rule-repo-btn')) {
        openRulesRepoPanel();
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

    // 片源批量文件选择后读取导入（支持 .json 数组 / .txt 每行一条，可多选）
    var bulkFileInput = rootEl.querySelector('#sfv-bulk-file');
    if (bulkFileInput) {
      bulkFileInput.addEventListener('change', function () {
        var files = bulkFileInput.files;
        if (!files || !files.length) return;
        if (!SFV.sources || !SFV.sources.addSource) { hint('片源模块未加载，无法导入。', true); return; }
        var aggregate = [];
        var pending = files.length;
        var parseErr = 0;
        function finishBulk() {
          if (aggregate.length) {
            bulkAddSources(aggregate);
          } else {
            hint('未从文件中解析出任何片源' + (parseErr ? ('（' + parseErr + ' 个文件读取/解析失败）') : ''), true);
          }
          bulkFileInput.value = '';
        }
        for (var bi = 0; bi < files.length; bi++) {
          (function (file) {
            var reader = new FileReader();
            reader.onload = function () {
              try {
                var entries = parseSourceFileContent(file.name, reader.result);
                if (entries && entries.length) {
                  for (var k = 0; k < entries.length; k++) aggregate.push(entries[k]);
                }
              } catch (e) { parseErr++; }
              pending--;
              if (pending === 0) finishBulk();
            };
            reader.onerror = function () { parseErr++; pending--; if (pending === 0) finishBulk(); };
            reader.readAsText(file);
          })(files[bi]);
        }
      });
    }

    // 规则文件选择后读取导入（支持多选 + 单个数组文件）
    var ruleFileInput = rootEl.querySelector('#sfv-rule-file');
    if (ruleFileInput) {
      ruleFileInput.addEventListener('change', function () {
        var files = ruleFileInput.files;
        if (!files || !files.length) return;
        var kz = SFV.kazumi;
        if (!kz || !kz.importRule) { hint('规则模块未加载，无法导入。', true); return; }
        var collected = [];
        var pending = files.length;
        var parseErr = 0;
        function finishRules() {
          if (!collected.length) {
            hint('未从文件中解析出任何规则' + (parseErr ? ('（' + parseErr + ' 个文件读取/解析失败）') : ''), true);
            ruleFileInput.value = '';
            return;
          }
          try {
            var res = kz.importRule(collected);
            if (Array.isArray(res)) {
              hint('已导入 ' + res.length + ' 条规则', false);
            } else if (res && res.ok) {
              hint('已导入 ' + (res.count || res.names ? res.count || res.names.length : '?') + ' 条规则' + (res.names && res.names.length ? '：' + res.names.join(', ') : ''), false);
            } else if (res) {
              hint('已导入规则（请检查「已导入规则」列表确认）', false);
            } else {
              hint('导入失败：未返回有效结果', true);
            }
          } catch (e) {
            hint('导入失败：' + (e && e.message ? e.message : '未知错误'), true);
          }
          renderRulesList();
          ruleFileInput.value = '';
        }
        for (var ri = 0; ri < files.length; ri++) {
          (function (file) {
            var reader = new FileReader();
            reader.onload = function () {
              try {
                var data = JSON.parse(reader.result);
                if (Array.isArray(data)) {
                  for (var a = 0; a < data.length; a++) collected.push(data[a]);
                } else if (data && typeof data === 'object') {
                  collected.push(data);
                } else {
                  parseErr++;
                }
              } catch (e) { parseErr++; }
              pending--;
              if (pending === 0) finishRules();
            };
            reader.onerror = function () { parseErr++; pending--; if (pending === 0) finishRules(); };
            reader.readAsText(file);
          })(files[ri]);
        }
      });
    }
  }

  // ---------------------------------------------------------------- 规则仓库 Glass 面板

  function buildRepoPanel() {
    var doc = d();
    if (!doc) return null;
    var panel = doc.createElement('div');
    panel.id = 'sfv-repo-panel';
    panel.className = 'sfv-glass-overlay';
    panel.setAttribute('aria-hidden', 'true');

    panel.innerHTML =
      '<div class="sfv-glass-backdrop"></div>' +
      '<div class="sfv-glass-panel" role="dialog" aria-modal="true" aria-label="Kazumi 规则仓库">' +
        '<div class="sfv-glass-head">' +
          '<div class="sfv-glass-title">' +
            '<strong>Kazumi 规则仓库</strong>' +
            '<small class="sfv-glass-title-hint">Predidit/KazumiRules</small>' +
          '</div>' +
          '<button type="button" class="sfv-glass-close" aria-label="关闭">&times;</button>' +
        '</div>' +
        '<div class="sfv-glass-search">' +
          '<input type="text" class="sfv-glass-search-input glass-input" placeholder="🔍 搜索规则名 / 作者…" autocomplete="off">' +
          '<div class="sfv-glass-toolbar">' +
            '<button type="button" class="sfv-glass-btn sfv-glass-refresh">刷新</button>' +
            '<button type="button" class="sfv-btn-secondary sfv-glass-mirror">切换直连</button>' +
          '</div>' +
        '</div>' +
        '<div class="sfv-glass-body">' +
          '<div class="sfv-glass-status">加载中…</div>' +
          '<div class="sfv-glass-list"></div>' +
        '</div>' +
        '<div class="sfv-glass-foot">' +
          '<span class="sfv-glass-footer-hint"></span>' +
        '</div>' +
      '</div>';
    return panel;
  }

  function openRulesRepoPanel() {
    var doc = d();
    if (!doc) return;
    if (!repoPanelEl) {
      repoPanelEl = buildRepoPanel();
      if (!repoPanelEl) return;
      doc.body.appendChild(repoPanelEl);
      bindRepoPanelEvents(repoPanelEl);
    }
    repoPanelEl.setAttribute('aria-hidden', 'false');
    repoPanelEl.classList.add('open');
    if (!repoPanelLoaded && !repoPanelLoading) {
      loadRepoCatalog();
    }
  }

  function closeRulesRepoPanel() {
    if (!repoPanelEl) return;
    repoPanelEl.setAttribute('aria-hidden', 'true');
    repoPanelEl.classList.remove('open');
  }

  function bindRepoPanelEvents(panel) {
    panel.querySelector('.sfv-glass-close').addEventListener('click', closeRulesRepoPanel);
    panel.querySelector('.sfv-glass-backdrop').addEventListener('click', closeRulesRepoPanel);
    panel.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' || ev.keyCode === 27) { closeRulesRepoPanel(); }
    });
    panel.querySelector('.sfv-glass-refresh').addEventListener('click', function () {
      repoPanelLoaded = false;
      loadRepoCatalog();
    });
    var mirrorBtn = panel.querySelector('.sfv-glass-mirror');
    function updateMirrorLabel() {
      var kz = (global.Kazumi && global.Kazumi.rulesRepo) ? global.Kazumi.rulesRepo : global.KazumiRulesRepo;
      if (!kz || !mirrorBtn) return;
      var onMirror = (kz.getBaseUrl() || '').indexOf('gitcode') !== -1;
      mirrorBtn.textContent = onMirror ? '切换直连' : '切换镜像';
    }
    updateMirrorLabel();
    mirrorBtn.addEventListener('click', function () {
      var kz = (global.Kazumi && global.Kazumi.rulesRepo) ? global.Kazumi.rulesRepo : global.KazumiRulesRepo;
      if (!kz) return;
      var onMirror = (kz.getBaseUrl() || '').indexOf('gitcode') !== -1;
      kz.configure({ useMirror: !onMirror });
      repoPanelLoaded = false;
      loadRepoCatalog();
      global.setTimeout(updateMirrorLabel, 100);
    });
    var searchInput = panel.querySelector('.sfv-glass-search-input');
    var searchTimer = null;
    searchInput.addEventListener('input', function () {
      var v = searchInput.value.trim();
      if (searchTimer) global.clearTimeout(searchTimer);
      searchTimer = global.setTimeout(function () {
        renderRepoList(v.toLowerCase());
      }, 300);
    });
  }

  function getInstalledRuleNames() {
    var installed = {};
    try {
      var kzBridge = SFV.kazumi;
      if (kzBridge && kzBridge.listRules) {
        kzBridge.listRules().forEach(function (r) { if (r.name) installed[r.name.toLowerCase()] = true; });
      }
    } catch (e) {}
    return installed;
  }

  async function loadRepoCatalog() {
    if (repoPanelLoading) return;
    repoPanelLoading = true;
    var panel = repoPanelEl;
    if (!panel) { repoPanelLoading = false; return; }
    var statusEl = panel.querySelector('.sfv-glass-status');
    var listEl = panel.querySelector('.sfv-glass-list');
    var footerEl = panel.querySelector('.sfv-glass-footer-hint');
    if (statusEl) { statusEl.className = 'sfv-glass-status'; statusEl.textContent = '正在连接 Kazumi 规则仓库…'; }
    if (listEl) listEl.innerHTML = '';

    var kz = (global.Kazumi && global.Kazumi.rulesRepo) ? global.Kazumi.rulesRepo : global.KazumiRulesRepo;
    if (!kz || typeof kz.getPluginList !== 'function') {
      if (statusEl) { statusEl.className = 'sfv-glass-status error'; statusEl.textContent = '规则仓库客户端未加载，请刷新页面后重试。'; }
      repoPanelLoading = false;
      return;
    }

    try {
      var items = await kz.getPluginList();
      repoPanelLoaded = true;
      panel._repoItems = items;
      renderRepoList('', items);
      if (statusEl) { statusEl.className = 'sfv-glass-status hidden'; }
      if (footerEl) {
        var base = kz.getBaseUrl();
        var mirrorHint = (base || '').indexOf('gitcode') !== -1 ? 'GitCode 镜像' : 'GitHub 原件';
        footerEl.textContent = '共 ' + items.length + ' 条规则 · 数据源: ' + mirrorHint;
      }
    } catch (e) {
      if (statusEl) {
        statusEl.className = 'sfv-glass-status error';
        statusEl.textContent = '加载失败: ' + (e && e.message ? e.message : '未知错误') + '  请检查网络或切换镜像后重试。';
      }
    }
    repoPanelLoading = false;
  }

  function renderRepoList(filter, items) {
    var panel = repoPanelEl;
    if (!panel) return;
    var listEl = panel.querySelector('.sfv-glass-list');
    if (!listEl) return;
    var all = items || panel._repoItems || [];
    var installed = getInstalledRuleNames();

    var rows = [];
    for (var i = 0; i < all.length; i++) {
      var it = all[i];
      var label = (it.name + ' ' + (it.author || '') + ' ' + (it.version || '')).toLowerCase();
      if (filter && label.indexOf(filter) === -1) continue;
      rows.push(it);
    }

    if (!rows.length) {
      listEl.innerHTML = '<div class="sfv-glass-empty">没有匹配的规则</div>';
      return;
    }

    var html = '';
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var key = r.name ? r.name.toLowerCase() : '';
      var isInstalled = !!installed[key];
      var ago = r.lastUpdate ? formatTimeAgo(r.lastUpdate) : '';
      var authorStr = r.author ? esc(' by ' + r.author) : '';
      var verStr = r.version ? ('v' + esc(r.version)) : '';
      html += '<div class="sfv-glass-item' + (isInstalled ? ' is-installed' : '') + '" data-name="' + esc(r.name || '') + '">' +
        '<div class="sfv-glass-item-main">' +
          '<div class="sfv-glass-item-name">' + esc(r.name || '—') +
            (isInstalled ? ' <span class="sfv-glass-badge-ok">已导入</span>' : '') +
            (r.antiCrawlerEnabled ? ' <span class="sfv-glass-badge-warn">反爬</span>' : '') +
          '</div>' +
          '<div class="sfv-glass-item-meta">' +
            '<span class="sfv-glass-item-ver">' + verStr + '</span>' +
            '<span class="sfv-glass-item-author">' + authorStr + '</span>' +
            (ago ? '<span class="sfv-glass-item-ago">' + esc(ago) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="sfv-glass-item-ops">' +
          (isInstalled
            ? '<button type="button" class="fx-mini-btn ghost sfv-glass-reinstall">重装</button>'
            : '<button type="button" class="fx-mini-btn sfv-glass-install">安装</button>') +
        '</div>' +
      '</div>';
    }
    listEl.innerHTML = html;

    var btns = listEl.querySelectorAll('.sfv-glass-install, .sfv-glass-reinstall');
    for (var b = 0; b < btns.length; b++) {
      (function (btn) {
        btn.addEventListener('click', async function (ev) {
          ev.stopPropagation();
          var itemEl = btn.closest('.sfv-glass-item');
          if (!itemEl) return;
          var name = itemEl.getAttribute('data-name');
          if (!name) return;
          if (btn.disabled) return;
          btn.disabled = true;
          var originText = btn.textContent;
          btn.textContent = '安装中…';
          try {
            await installRepoRule(name);
            btn.textContent = '✓ 已导入';
            btn.classList.remove('sfv-glass-install', 'sfv-glass-reinstall');
            btn.classList.add('sfv-glass-done');
            itemEl.classList.add('is-installed');
            var nameEl = itemEl.querySelector('.sfv-glass-item-name');
            if (nameEl && !nameEl.querySelector('.sfv-glass-badge-ok')) {
              nameEl.insertAdjacentHTML('beforeend', ' <span class="sfv-glass-badge-ok">已导入</span>');
            }
            renderRulesList();
          } catch (e) {
            btn.textContent = originText;
            btn.disabled = false;
            console.error('[SFV repo] 安装规则失败:', e);
            alert('安装失败: ' + (e && e.message ? e.message : '未知错误'));
          }
        });
      })(btns[b]);
    }
  }

  async function installRepoRule(name) {
    var kz = (global.Kazumi && global.Kazumi.rulesRepo) ? global.Kazumi.rulesRepo : global.KazumiRulesRepo;
    if (!kz) throw new Error('规则仓库客户端未加载');
    var ruleJson = await kz.getPlugin(name);
    var kzBridge = SFV.kazumi;
    if (!kzBridge || !kzBridge.importRule) throw new Error('桥接层未加载');
    kzBridge.importRule(ruleJson);
  }

  function formatTimeAgo(ts) {
    if (!ts) return '';
    var now = Math.floor(Date.now() / 1000);
    var diff = now - ts;
    if (diff < 60) return diff + ' 秒前';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 2592000) return Math.floor(diff / 86400) + ' 天前';
    if (diff < 31536000) return Math.floor(diff / 2592000) + ' 月前';
    return Math.floor(diff / 31536000) + ' 年前';
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
