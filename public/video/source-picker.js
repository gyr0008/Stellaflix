/*
 * Stellaflix 影视模块 — 多源选择弹窗（对齐 Kazumi SourceSheet · 阶段1 形态对齐）
 *
 * 触发：浏览厅点海报后并行搜 CMS10 + Kazumi，候选源 > 1 时弹出。
 * 视觉：Kazumi 风格纯色弹窗（#18181b 暗底，无玻璃/模糊）+ 每源 Tab（水平滚动）
 *       + 五色状态圆点（绿=成功/橙=无结果/蓝=验证/红=错误/灰=等待）+ 源内条目卡片。
 *
 * 与 Kazumi 的结构对齐（阶段1）：
 *   - 每源一个 Tab（隔离键 = 阶段0 引入的 sourceKey = cms:<source.id> / kazumi:<ruleName>）；
 *   - Tab 头部圆点表达该源搜索/解析状态（阶段1 暂默认 ok，阶段2 流式填充接入 setStatus）；
 *   - Tab 内是该源对片名的命中条目卡片（源内隔离，不跨源合并）。
 * 点击条目 → onPick(candidate) → 由 detail-source.playCandidate 解析线路并跳视频页（选集留阶段3）。
 *
 * 铁律：零业务逻辑进 index.html；本模块仅提供 SFV.sourcePicker.open()/close()/setStatus()。
 * 单文件 ≤ 500 行。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var root = null;        // 弹窗根 DOM
  var backdrop = null;
  var onPick = null;
  var current = null;     // 扁平候选 [{ id, label, sub, kind, isEmbed, _ref, sourceKey }]
  var groups = [];        // 按 sourceKey 分组 [{ sourceKey, sourceName, items:[{c,i}] }]
  var statusMap = {};     // { sourceKey: 'ok'|'none'|'captcha'|'error'|'wait' }
  var activeKey = null;   // 当前激活源 Tab 的 sourceKey
  var groupRefs = {};     // sourceKey -> 源单元 ref（含 ruleName/id，供验证码弹窗取规则名，B1）
  var aliasesByKey = {};  // sourceKey -> [string] 该源累积别名（B2 别名/手动检索）
  var currentTitle = '';  // 当前影片标题（B1 验证码搜索页 URL 用）
  var pillEls = {};       // sourceKey -> Tab DOM
  var sectionEls = {};    // sourceKey -> 源内条目容器 DOM

  function d() { return global.document; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 状态点语义色（对齐 Kazumi：绿=成功/橙=无结果/蓝=验证/红=错误/灰=等待）
  var DOT_CLASS = {
    ok: 'sfv-picker-dot--ok', none: 'sfv-picker-dot--none',
    captcha: 'sfv-picker-dot--captcha', error: 'sfv-picker-dot--error',
    wait: 'sfv-picker-dot--wait'
  };
  function statusToDot(s) { return DOT_CLASS[s] || DOT_CLASS.ok; }

  function close() {
    if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    if (root && root.parentNode) root.parentNode.removeChild(root);
    backdrop = null; root = null; onPick = null; current = null;
    groups = []; statusMap = {}; activeKey = null; pillEls = {}; sectionEls = {};
    groupRefs = {}; aliasesByKey = {}; currentTitle = '';
    if (global.document && global.document.body) {
      global.document.body.classList.remove('sfv-picker-open');
    }
  }

  /*
   * 按 sourceKey 隔离分组（修复审查 P1：隔离键=稳定 sourceKey，不靠展示名）。
   * 同名但不同 id 的源（如两个同名 CMS 源）= 两个 sourceKey = 两个 Tab，不串台。
   */
  function groupBySource(cands) {
    var gs = [], gmap = {};
    (cands || []).forEach(function (c, i) {
      var key = c.sourceKey ||
        ('__fallback:' + (c.kind || 'x') + ':' + (c.label || '') + ':' + i);
      var name = (c.kind === 'kazumi')
        ? (c.ruleName || c.group || 'Kazumi')
        : (c.sourceName || c.group || 'CMS');
      if (!gmap[key]) {
        gmap[key] = { sourceKey: key, sourceName: name, items: [] };
        gs.push(gmap[key]);
      }
      gmap[key].items.push({ c: c, i: i });
    });
    return gs;
  }

  function activate(key) {
    if (!key || key === activeKey) return;
    activeKey = key;
    Object.keys(pillEls).forEach(function (k) {
      pillEls[k].classList.toggle('is-selected', k === key);
    });
    Object.keys(sectionEls).forEach(function (k) {
      sectionEls[k].classList.toggle('is-active', k === key);
    });
  }

  /*
   * @param {Object} opt
   *   title    {string}  影片名（弹窗标题）
   *   poster   {string}  海报（可选）
   *   candidates {Array} 扁平候选（须含 sourceKey；缺省按 fallback 分组）
   *   statusMap  {Object} { sourceKey: 'ok'|'none'|'captcha'|'error'|'wait' }（阶段2 流式用）
   *   onPick   {Function} 选中候选后回调(candidate)
   */
  function open(opt) {
    opt = opt || {};
    var doc = d();
    if (!doc) return;
    close(); // 先清旧弹窗
    current = opt.candidates || [];
    onPick = opt.onPick || null;
    statusMap = opt.statusMap || {};
    // B1/B2：缓存源 ref（含规则名）与标题，供错误态动作按钮取用。
    groupRefs = {}; aliasesByKey = {};
    (opt.groups || []).forEach(function (g) { if (g && g.sourceKey) groupRefs[g.sourceKey] = g.ref || null; });
    currentTitle = opt.title || '';
    // 阶段2 流式：调用方可显式预建 groups（按源单元 key/name 先建 Tab）；
    // 否则回退按 candidates 聚合分组（兼容旧调用）。
    if (opt.groups && opt.groups.length) {
      groups = opt.groups.map(function (g) {
        return { sourceKey: g.sourceKey, sourceName: g.sourceName, items: [] };
      });
      // 预建时所有源初始为「等待」灰点
      groups.forEach(function (g) { statusMap[g.sourceKey] = 'wait'; });
    } else {
      groups = groupBySource(current);
    }
    pillEls = {}; sectionEls = {};
    activeKey = groups.length ? groups[0].sourceKey : null;

    backdrop = doc.createElement('div');
    backdrop.className = 'sfv-picker-backdrop';
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) close();
    });

    root = doc.createElement('div');
    root.className = 'sfv-picker';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', '选择播放源');

    // ---- 头部：海报 + 标题 + 关闭 ----
    var head = doc.createElement('div');
    head.className = 'sfv-picker-head';
    if (opt.poster) {
      var img = doc.createElement('img');
      img.className = 'sfv-picker-poster';
      img.src = opt.poster; img.alt = ''; img.loading = 'lazy';
      img.addEventListener('error', function () { img.style.display = 'none'; });
      head.appendChild(img);
    }
    var ht = doc.createElement('div');
    ht.className = 'sfv-picker-headtext';
    var htitle = doc.createElement('div');
    htitle.className = 'sfv-picker-title';
    htitle.textContent = opt.title || '选择播放源';
    var hsub = doc.createElement('div');
    hsub.className = 'sfv-picker-subtitle';
    hsub.textContent = groups.length
      ? (groups.length + ' 个数据源 · ' + current.length + ' 个命中条目')
      : '未找到播放源';
    ht.appendChild(htitle); ht.appendChild(hsub);
    head.appendChild(ht);

    var x = doc.createElement('button');
    x.type = 'button'; x.className = 'sfv-picker-close';
    x.setAttribute('aria-label', '关闭');
    x.textContent = '×';
    x.addEventListener('click', close);
    head.appendChild(x);
    root.appendChild(head);

    // ---- 每源 Tab（对齐 Kazumi：每源一个 Tab + 状态圆点）----
    var tabbar = doc.createElement('div');
    tabbar.className = 'sfv-picker-tabs';
    groups.forEach(function (g, gi) {
      var pill = doc.createElement('button');
      pill.type = 'button';
      pill.className = 'sfv-picker-pill' + (g.sourceKey === activeKey ? ' is-selected' : '');
      pill.setAttribute('data-key', g.sourceKey);
      var dot = doc.createElement('span');
      dot.className = 'sfv-picker-dot ' + statusToDot(statusMap[g.sourceKey] || 'ok');
      var label = doc.createElement('span');
      label.className = 'sfv-picker-pill-label';
      label.textContent = g.sourceName || ('源 ' + (gi + 1));
      pill.appendChild(dot); pill.appendChild(label);
      pill.addEventListener('click', function () { activate(g.sourceKey); });
      tabbar.appendChild(pill);
      pillEls[g.sourceKey] = pill;
    });
    root.appendChild(tabbar);

    // ---- 源内条目容器（每源一个 section，仅激活源显示）----
    var list = doc.createElement('div');
    list.className = 'sfv-picker-list';
    if (!groups.length) {
      var empty = doc.createElement('div');
      empty.className = 'sfv-picker-empty';
      empty.textContent = '没有可用的播放源，试试其它影片或手动导入片源。';
      list.appendChild(empty);
    } else {
      groups.forEach(function (g) {
        var sec = doc.createElement('div');
        sec.className = 'sfv-picker-source' + (g.sourceKey === activeKey ? ' is-active' : '');
        sec.setAttribute('data-key', g.sourceKey);
        g.items.forEach(function (ent) {
          sec.appendChild(makeRow(ent.c, ent.i));
        });
        // 阶段2 流式：预建 groups 时（无初始候选）显示「搜索中」占位
        if (!g.items.length) {
          var ph = doc.createElement('div');
          ph.className = 'sfv-picker-source-ph';
          ph.textContent = '搜索中…';
          sec.appendChild(ph);
        }
        list.appendChild(sec);
        sectionEls[g.sourceKey] = sec;
      });
    }
    root.appendChild(list);

    (doc.body || doc.documentElement).appendChild(backdrop);
    (doc.body || doc.documentElement).appendChild(root);
    doc.body.classList.add('sfv-picker-open');

    // 入场动画（轻量，不用 GSAP）
    requestAnimationFrame(function () {
      if (root) root.classList.add('sfv-picker-in');
    });
  }

  function makeRow(c, i) {
    var doc = d();
    var row = doc.createElement('button');
    row.type = 'button';
    row.className = 'sfv-picker-row';
    row.setAttribute('data-idx', String(i));
    var ic = doc.createElement('span');
    ic.className = 'sfv-picker-row-ic';
    ic.textContent = (c.kind === 'kazumi') ? '🛰' : '📡';
    var badge = doc.createElement('span');
    badge.className = 'sfv-picker-row-badge ' + (c.isEmbed ? 'sfv-picker-badge-embed' : 'sfv-picker-badge-direct');
    badge.textContent = c.isEmbed ? '内嵌' : '直链';
    var txt = doc.createElement('span');
    txt.className = 'sfv-picker-row-txt';
    var rl = doc.createElement('span');
    rl.className = 'sfv-picker-row-label';
    rl.textContent = c.label || ('源 ' + (i + 1));
    var rs = doc.createElement('span');
    rs.className = 'sfv-picker-row-sub';
    rs.textContent = c.sub || '';
    txt.appendChild(rl); txt.appendChild(rs);
    var go = doc.createElement('span');
    go.className = 'sfv-picker-row-go';
    go.textContent = '播放 ▸';
    row.appendChild(ic); row.appendChild(badge); row.appendChild(txt); row.appendChild(go);
    row.addEventListener('click', function () { pick(i); });
    return row;
  }

  function pick(i) {
    var c = current && current[i];
    if (!c) return;
    var cb = onPick;
    close();
    if (cb) try { cb(c); } catch (e) { console.warn('[source-picker] onPick error:', e); }
  }

  /*
   * 阶段2 流式填充接口：更新某源 Tab 的状态点（不重建 DOM，仅换 class）。
   * @param {string} sourceKey
   * @param {string} status  'ok'|'none'|'captcha'|'error'|'wait'
   */
  function setStatus(sourceKey, status) {
    if (!sourceKey || !pillEls[sourceKey]) return;
    statusMap[sourceKey] = status;
    var pill = pillEls[sourceKey];
    var dot = pill.querySelector('.sfv-picker-dot');
    if (dot) dot.className = 'sfv-picker-dot ' + statusToDot(status);
    // B2：状态点翻转时同步错误部件（none/error/captcha 显示，ok/wait 清除）。
    syncErrorWidget(sourceKey, status);
  }

  // ---------- B2：错误态部件（对齐 Kazumi GeneralErrorWidget + GeneralErrorButton，三态见 source_sheet.dart:314-356）----------

  function removeErrorWidget(sec) {
    if (!sec) return;
    var old = sec.querySelector('.sfv-picker-error');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }

  function syncErrorWidget(sourceKey, status) {
    var sec = sectionEls[sourceKey];
    if (!sec) return;
    if (status === 'none' || status === 'error' || status === 'captcha') {
      renderErrorWidget(sec, sourceKey, status);
    } else {
      removeErrorWidget(sec); // ok/wait：清除任何残留错误部件
    }
  }

  function makeBtn(label, cls, onClick) {
    var b = d().createElement('button');
    b.type = 'button';
    b.className = 'sfv-picker-ebtn ' + (cls || '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderErrorWidget(sec, sourceKey, status) {
    removeErrorWidget(sec);
    var name = (groups.filter(function (g) { return g.sourceKey === sourceKey; })[0] || {}).sourceName || sourceKey;
    var box = d().createElement('div');
    box.className = 'sfv-picker-error sfv-picker-error--' + status;
    var msg = d().createElement('div');
    msg.className = 'sfv-picker-error-msg';
    var actions = d().createElement('div');
    actions.className = 'sfv-picker-error-actions';

    if (status === 'captcha') {
      msg.textContent = name + ' 需要验证码验证';
      var ruleName = (groupRefs[sourceKey] && groupRefs[sourceKey].name) || name;
      actions.appendChild(makeBtn('进行验证', 'sfv-picker-ebtn--primary', function () {
        if (SFV.sourcePickerCaptcha && SFV.sourcePickerCaptcha.showCaptchaDialog) {
          SFV.sourcePickerCaptcha.showCaptchaDialog(sourceKey, ruleName, name);
        } else { toastMsg('验证组件未就绪'); }
      }));
      actions.appendChild(makeBtn('重试', '', function () {
        if (SFV.detailSource && SFV.detailSource.retrySource) SFV.detailSource.retrySource(sourceKey);
      }));
    } else if (status === 'none') {
      msg.textContent = name + ' 无结果 使用别名或左右滑动以切换到其他视频来源';
      actions.appendChild(makeBtn('别名检索', '', function () { showAliasDialog(sourceKey, name); }));
      actions.appendChild(makeBtn('手动检索', '', function () { showManualDialog(sourceKey, name); }));
    } else { // error
      msg.textContent = name + ' 检索失败 重试或左右滑动以切换到其他视频来源';
      actions.appendChild(makeBtn('重试', 'sfv-picker-ebtn--primary', function () {
        if (SFV.detailSource && SFV.detailSource.retrySource) SFV.detailSource.retrySource(sourceKey);
      }));
    }
    box.appendChild(msg);
    box.appendChild(actions);
    sec.appendChild(box);
  }

  // 轻量自包含 toast（不依赖外部模块）。
  function toastMsg(text) {
    if (!text) return;
    var doc = d();
    if (!doc || !doc.body) { console.warn('[source-picker] ' + text); return; }
    var t = doc.createElement('div');
    t.className = 'sfv-picker-toast';
    t.textContent = text;
    doc.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2400);
  }

  // 通用模态：返回 close 函数（B2 别名/手动检索弹窗复用）。
  function openModal(build) {
    var doc = d();
    if (!doc || !doc.body) return function () {};
    var backdrop = doc.createElement('div');
    backdrop.className = 'sfv-picker-modal-backdrop';
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close2(backdrop); });
    var card = doc.createElement('div');
    card.className = 'sfv-picker-modal';
    backdrop.appendChild(card);
    build(card, function () { close2(backdrop); });
    doc.body.appendChild(backdrop);
    requestAnimationFrame(function () { if (backdrop) backdrop.classList.add('is-in'); });
    return function () { close2(backdrop); };
  }
  function close2(backdrop) {
    if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
  }

  // B2 别名检索：列出该源累积别名，选中即用该别名重查（对齐 Kazumi showAliasSearchDialog）。
  function showAliasDialog(sourceKey, sourceName) {
    var aliases = aliasesByKey[sourceKey] || [];
    if (!aliases.length) { toastMsg('无可用别名，试试手动检索'); return; }
    openModal(function (card, close) {
      var h = d().createElement('div'); h.className = 'sfv-picker-modal-title';
      h.textContent = '选择别名 · ' + sourceName;
      card.appendChild(h);
      var list = d().createElement('div'); list.className = 'sfv-picker-alias-list';
      aliases.forEach(function (a) {
        var row = d().createElement('button'); row.type = 'button';
        row.className = 'sfv-picker-alias'; row.textContent = a;
        row.addEventListener('click', function () {
          close();
          if (SFV.detailSource && SFV.detailSource.searchSourceWithKeyword) {
            SFV.detailSource.searchSourceWithKeyword(sourceKey, a);
          }
        });
        list.appendChild(row);
      });
      card.appendChild(list);
    });
  }

  // B2 手动检索：输入关键词 → 加入别名 store → 用该词重查（对齐 Kazumi showCustomSearchDialog）。
  function showManualDialog(sourceKey, sourceName) {
    openModal(function (card, close) {
      var h = d().createElement('div'); h.className = 'sfv-picker-modal-title';
      h.textContent = '输入别名 · ' + sourceName;
      card.appendChild(h);
      var input = d().createElement('input');
      input.type = 'text'; input.className = 'sfv-picker-input';
      input.placeholder = '自定义搜索关键词';
      card.appendChild(input);
      var bar = d().createElement('div'); bar.className = 'sfv-picker-error-actions';
      bar.appendChild(makeBtn('取消', '', close));
      bar.appendChild(makeBtn('确认', 'sfv-picker-ebtn--primary', function () {
        var kw = (input.value || '').trim();
        if (!kw) { toastMsg('关键词不能为空'); return; }
        if (!aliasesByKey[sourceKey]) aliasesByKey[sourceKey] = [];
        if (aliasesByKey[sourceKey].indexOf(kw) < 0) aliasesByKey[sourceKey].push(kw);
        close();
        if (SFV.detailSource && SFV.detailSource.searchSourceWithKeyword) {
          SFV.detailSource.searchSourceWithKeyword(sourceKey, kw);
        }
      }));
      card.appendChild(bar);
      setTimeout(function () { if (input.focus) input.focus(); }, 30);
    });
  }

  /*
   * 阶段2 流式填充接口：先开弹窗（groups 已建、section 空），
   * 待某源搜索完成后调用本函数增量填充该源卡片并刷新状态点/计数。
   * @param {string} sourceKey
   * @param {Array}  items  [{ i, c }] 该源命中候选（i=扁平下标，c=候选对象）
   */
  function appendSource(sourceKey, items) {
    if (!sourceKey || !sectionEls[sourceKey]) return;
    var sec = sectionEls[sourceKey];
    // 先清旧 placeholder（如有）
    var ph = sec.querySelector('.sfv-picker-source-ph');
    if (ph) ph.parentNode.removeChild(ph);
    var cnt = 0;
    (items || []).forEach(function (ent) {
      // 避免重复：同下标已渲染则跳过
      if (sec.querySelector('[data-idx="' + ent.i + '"]')) return;
      sec.appendChild(makeRow(ent.c, ent.i));
      cnt++;
    });
    // 更新该源状态点：有命中=ok，无命中=none
    setStatus(sourceKey, cnt ? 'ok' : 'none');
    // 更新标题计数
    updateCount();
  }

  // 源内「等待中」占位（流式期间显示）
  function setSourceWaiting(sourceKey, waiting) {
    if (!sourceKey || !sectionEls[sourceKey]) return;
    var sec = sectionEls[sourceKey];
    var ph = sec.querySelector('.sfv-picker-source-ph');
    if (waiting) {
      if (!ph) {
        ph = d().createElement('div');
        ph.className = 'sfv-picker-source-ph';
        ph.textContent = '搜索中…';
        sec.appendChild(ph);
      }
    } else if (ph) {
      ph.parentNode.removeChild(ph);
    }
  }

  function updateCount() {
    if (!root) return;
    var sub = root.querySelector('.sfv-picker-subtitle');
    if (!sub) return;
    var total = 0, nSrc = 0;
    groups.forEach(function (g) {
      var sec = sectionEls[g.sourceKey];
      if (!sec) return;
      var rows = sec.querySelectorAll('.sfv-picker-row').length;
      total += rows;
      if (rows) nSrc++;
    });
    sub.textContent = groups.length
      ? (groups.length + ' 个数据源 · ' + total + ' 个命中条目')
      : '未找到播放源';
  }

  function isOpen() { return !!root; }

  SFV.sourcePicker = {
    open: open, close: close, isOpen: isOpen, setStatus: setStatus,
    appendSource: appendSource, setSourceWaiting: setSourceWaiting,
    showAliasDialog: showAliasDialog, showManualDialog: showManualDialog,
    _test: {
      groupBySource: groupBySource, statusToDot: statusToDot,
      getTitle: function () { return currentTitle; },
      getGroupRef: function (k) { return groupRefs[k] || null; },
      renderErrorWidget: renderErrorWidget, removeErrorWidget: removeErrorWidget,
      syncErrorWidget: syncErrorWidget, toastMsg: toastMsg
    }
  };
})(typeof window !== 'undefined' ? window : this);
