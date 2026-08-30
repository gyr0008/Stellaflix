/*
 * Stellaflix 影视模块 — TMDB API Key 自填设置弹窗 + 轻量 toast 兜底
 *
 * 从 tmdb.js 拆出的纯 UI 子模块（VIDEO_MODULE_PLAN §六.6 单文件 ≤500 行约束）。
 * 仅依赖全局 document / localStorage / SFV.ui·SFV.online 的 toast；不触碰 TMDB 请求逻辑。
 * 由 index.html 在 video/tmdb.js 之前加载，tmdb.js 的 facade.openKeySettings 委托到此。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var LS_KEY = 'stellaflix-tmdb-key';

  // ---- 轻量 toast 兜底（优先复用 SFV.ui/SFV.online 的 toast，否则自建 .sfv-toast）----
  function toast(msg) {
    if (SFV.ui && SFV.ui.toast) { SFV.ui.toast(msg); return; }
    if (SFV.online && SFV.online.toast) { SFV.online.toast(msg); return; }
    var doc = global.document;
    if (!doc || !doc.body) return;
    var t = doc.createElement('div');
    t.className = 'sfv-toast';
    t.textContent = msg;
    doc.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
  }

  // ---- TMDB API Key 自填设置弹窗（消硬编码默认 key 风险）----
  // 写入/清除 localStorage('stellaflix-tmdb-key')；tmdb.js 的 cfg.apiKey getter 已保证
  // 请求时实时读取，无需刷新。ESC 用捕获阶段 + stopImmediatePropagation，避免与详情页 ESC 关闭冲突。
  function openKeySettings() {
    var doc = global.document;
    if (!doc) return;
    if (doc.getElementById('sfv-tmdb-settings-modal')) return; // 防重复

    var saved = '';
    try { saved = (global.localStorage && global.localStorage.getItem(LS_KEY)) || ''; } catch (e) {}

    var overlay = doc.createElement('div');
    overlay.id = 'sfv-tmdb-settings-modal';
    overlay.className = 'sfv-tmdb-settings-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'TMDB API Key 设置');

    var card = doc.createElement('div');
    card.className = 'sfv-tmdb-settings-card';

    var title = doc.createElement('div');
    title.className = 'sfv-tmdb-settings-title';
    title.textContent = 'TMDB API Key 设置';
    card.appendChild(title);

    var desc = doc.createElement('div');
    desc.className = 'sfv-tmdb-settings-desc';
    desc.textContent = '应用内置一个开发期默认 Key。你可填入自己的 TMDB v3 Key（免费、可随时在后台重置），以提升请求稳定性并避免共享默认额度。留空即使用默认 Key。';
    card.appendChild(desc);

    var warn = doc.createElement('div');
    warn.className = 'sfv-tmdb-settings-warn';
    warn.setAttribute('role', 'alert');
    warn.innerHTML = '⚠️ <b>当前为开发期默认 Key</b>，可能被 TMDB 限流或随时失效（开发者可随时在后台 revoke）。<br>强烈建议替换为你自己的 <b>TMDB v3 Key</b>（免费 Developer 档）：申请 → themoviedb.org/settings/api';
    card.appendChild(warn);

    var input = doc.createElement('input');
    input.type = 'text';
    input.className = 'sfv-tmdb-settings-input';
    input.placeholder = '粘贴你的 TMDB v3 API Key';
    input.value = saved;
    input.spellcheck = false;
    input.autocomplete = 'off';
    card.appendChild(input);

    var errEl = doc.createElement('div');
    errEl.className = 'sfv-tmdb-settings-err';
    errEl.style.display = 'none';
    card.appendChild(errEl);

    var btnRow = doc.createElement('div');
    btnRow.className = 'sfv-tmdb-settings-btns';

    function close() {
      try { doc.removeEventListener('keydown', onKey, true); } catch (_) {}
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    function onKey(e) {
      if (e && (e.key === 'Escape' || e.keyCode === 27)) {
        e.preventDefault();
        e.stopImmediatePropagation(); // 阻断冒泡到详情页 ESC 关闭
        close();
      }
    }

    var saveBtn = doc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'sfv-tmdb-settings-btn primary';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', function () {
      var v = (input.value || '').trim();
      if (v && !/^[A-Za-z0-9]{8,64}$/.test(v)) {
        errEl.textContent = 'Key 格式不正确（应为 8–64 位字母数字）。';
        errEl.style.display = 'block';
        return;
      }
      try {
        if (v) global.localStorage.setItem(LS_KEY, v);
        else global.localStorage.removeItem(LS_KEY);
      } catch (e2) {}
      close();
      toast(v ? 'TMDB Key 已保存，下次请求生效' : '已恢复使用默认 TMDB Key');
    });

    var clearBtn = doc.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'sfv-tmdb-settings-btn';
    clearBtn.textContent = '清除（用默认）';
    clearBtn.addEventListener('click', function () {
      try { global.localStorage.removeItem(LS_KEY); } catch (e2) {}
      close();
      toast('已恢复使用默认 TMDB Key');
    });

    var closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'sfv-tmdb-settings-btn';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', close);

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(clearBtn);
    btnRow.appendChild(closeBtn);
    card.appendChild(btnRow);

    var note = doc.createElement('div');
    note.className = 'sfv-tmdb-settings-note';
    note.textContent = '本产品使用 TMDB API，但未经 TMDB 认可或认证。申请：themoviedb.org/settings/api';
    card.appendChild(note);

    overlay.appendChild(card);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(overlay);
    try { input.focus(); } catch (_) {}
  }

  SFV.tmdbSettings = {
    openKeySettings: openKeySettings,
    toast: toast
  };
})(typeof window !== 'undefined' ? window : this);
