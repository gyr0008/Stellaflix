/**
 * Stellaflix — Bangumi 条目详情页（移植自 Kazumi lib/pages/info/ 的取数面）
 *
 * 数据来源（全部为 GET，走既有 /api/proxy，无需新增服务端路由）：
 *   - 条目详情：GET https://next.bgm.tv/p1/subjects/{id}
 *               （Kazumi ApiEndpoints.bangumiAPINextDomain + bangumiInfoByIDNext）
 *   - 角色    ：GET https://api.bgm.tv/v0/subjects/{id}/characters
 *               （bangumiAPIDomain + bangumiCharacterByID）
 *   - 职员    ：GET https://next.bgm.tv/p1/subjects/{id}/staffs/persons
 *               （bangumiStaffByIDNext）
 *   - 关联条目：GET https://api.bgm.tv/v0/subjects/{id}/subjects
 *               （bangumiRelationsByID）
 *   - 评论    ：GET https://next.bgm.tv/p1/subjects/{id}/comments?limit=20&offset=0
 *               （bangumiCommentsByIDNext）
 *
 * 交互：
 *   - 追番 6 态：复用 SFV.model（key = bangumi:<id>），与时间表页共用同一份状态
 *   - 返回    ：back() 回到时间表页（router page 'bangumi-timeline'）
 *
 * 约定：kazumi/ 内部不改；本文件为目录外新增。
 * @license GPL-3.0
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  var doc = global.document;

  var PAGE_ID = 'bangumi-info';
  var NEXT = 'https://next.bgm.tv';
  var V0 = 'https://api.bgm.tv';

  var API = {
    subject: function (id) { return NEXT + '/p1/subjects/' + id; },
    characters: function (id) { return V0 + '/v0/subjects/' + id + '/characters'; },
    staff: function (id) { return NEXT + '/p1/subjects/' + id + '/staffs/persons'; },
    relations: function (id) { return V0 + '/v0/subjects/' + id + '/subjects'; },
    comments: function (id, limit, offset) {
      return NEXT + '/p1/subjects/' + id + '/comments?limit=' + (limit || 20) + '&offset=' + (offset || 0);
    }
  };

  var trackToast = global.toast || function (m) { console.log('[bgm-info]', m); };

  var _current = null;   // 当前条目（来自时间表卡片的归一化 item）
  var _host = null;
  var _detail = null;    // 详情原始 JSON

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function trackKey(item) { return 'bangumi:' + item.id; }

  // ---------------------------------------------------------------- 取数
  function fetchJSON(url) {
    var http = global.KazumiHttpClient;
    var p;
    if (http && typeof http.get === 'function') {
      p = http.get(url, { useProxy: true }).then(function (t) { return JSON.parse(t); });
    } else {
      p = fetch('/api/proxy?url=' + encodeURIComponent(url), {
        method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function (t) { return JSON.parse(t); });
    }
    return p;
  }

  function safeFetch(url) {
    return fetchJSON(url).catch(function (e) {
      console.warn('[bangumiInfo] 取数失败', url, e && e.message);
      return null;
    });
  }

  // ---------------------------------------------------------------- 入口
  /** 由时间表卡片调用：打开详情页 */
  function open(item) {
    if (!item) return;
    _current = item;
    _detail = null;
    var S = SFV.onlineShared;
    if (S && typeof S.openPage === 'function') {
      S.openPage(PAGE_ID, item.title || item.name || '条目详情');
      return;
    }
    if (SFV.router) SFV.router.go(PAGE_ID);
  }

  // ---------------------------------------------------------------- 渲染
  function mount(host) {
    _host = host;
    if (!host) return;
    host.innerHTML = '';
    if (!_current) {
      host.appendChild(el('div', 'sfv-bgi-ph', '未指定条目'));
      return;
    }
    renderSkeleton(host);

    var id = _current.id;
    safeFetch(API.subject(id)).then(function (d) {
      if (_current && _current.id !== id) return;   // 已切走
      _detail = d || null;
      renderFull(host);
      if (!d) return;
      // 附加数据并行拉取，失败不影响主信息
      Promise.all([
        safeFetch(API.characters(id)),
        safeFetch(API.relations(id)),
        safeFetch(API.comments(id, 20, 0))
      ]).then(function (res) {
        if (_current && _current.id !== id) return;
        renderExtras(host, res[0], res[1], res[2]);
      });
    });
  }

  function renderSkeleton(host) {
    host.innerHTML = '';
    var wrap = el('div', 'sfv-bgi');
    var hero = el('div', 'sfv-bgi-hero');
    var img = doc.createElement('img');
    img.className = 'sfv-bgi-poster';
    img.src = (_current && _current.poster) || '';
    img.alt = '';
    hero.appendChild(img);
    var meta = el('div', 'sfv-bgi-meta');
    meta.appendChild(el('h1', 'sfv-bgi-title', (_current && (_current.title || _current.name)) || '加载中…'));
    meta.appendChild(el('div', 'sfv-bgi-loading', '正在获取条目详情…'));
    hero.appendChild(meta);
    wrap.appendChild(hero);
    host.appendChild(wrap);
  }

  function renderFull(host) {
    if (!host) return;
    host.innerHTML = '';
    var item = mergeItem(_current, _detail);
    var wrap = el('div', 'sfv-bgi');

    // ---- Hero：海报 + 标题 + 指标 + 操作 ----
    var hero = el('div', 'sfv-bgi-hero');
    var img = doc.createElement('img');
    img.className = 'sfv-bgi-poster';
    img.src = item.poster || '';
    img.alt = '';
    img.addEventListener('error', function () { img.style.visibility = 'hidden'; });
    hero.appendChild(img);

    var meta = el('div', 'sfv-bgi-meta');
    meta.appendChild(el('h1', 'sfv-bgi-title', item.title || item.name));
    if (item.name && item.name !== item.title) {
      meta.appendChild(el('div', 'sfv-bgi-subtitle', item.name));
    }

    var facts = el('div', 'sfv-bgi-facts');
    if (item.airDate) facts.appendChild(el('span', 'sfv-bgi-fact', '开播 ' + item.airDate));
    if (item.ratingScore) facts.appendChild(el('span', 'sfv-bgi-fact', '评分 ' + item.ratingScore.toFixed(1)));
    if (item.rank) facts.appendChild(el('span', 'sfv-bgi-fact', '排名 #' + item.rank));
    if (item.votes) facts.appendChild(el('span', 'sfv-bgi-fact', '评分人数 ' + item.votes));
    if (facts.childNodes.length) meta.appendChild(facts);

    meta.appendChild(buildActions(item));
    hero.appendChild(meta);
    wrap.appendChild(hero);

    // ---- 简介 ----
    if (item.summary) {
      wrap.appendChild(section('简介', el('p', 'sfv-bgi-summary', item.summary)));
    }

    // ---- 标签 / 别名 ----
    var tagBox = el('div', 'sfv-bgi-tags');
    (item.tags || []).slice(0, 24).forEach(function (t) {
      if (t && t.name) tagBox.appendChild(el('span', 'sfv-bgi-tag', t.name));
    });
    if (tagBox.childNodes.length) wrap.appendChild(section('标签', tagBox));

    if ((item.alias || []).length) {
      var aliasBox = el('div', 'sfv-bgi-tags');
      item.alias.forEach(function (a) { aliasBox.appendChild(el('span', 'sfv-bgi-tag soft', a)); });
      wrap.appendChild(section('别名', aliasBox));
    }

    // 附加区块占位（异步填充）
    wrap.appendChild(el('div', 'sfv-bgi-extras'));

    host.appendChild(wrap);
  }

  function mergeItem(base, d) {
    var item = {
      id: base.id,
      title: base.title || base.name,
      name: base.name,
      poster: base.poster,
      summary: base.summary,
      airDate: base.airDate,
      ratingScore: base.ratingScore,
      rank: base.rank,
      votes: base.votes,
      tags: base.tags || [],
      alias: base.alias || [],
      images: base.images || {}
    };
    if (d && typeof d === 'object') {
      var n = SFV.bangumi ? SFV.bangumi.normSubject(d) : null;
      if (n) {
        item.title = n.title || item.title;
        item.name = n.name || item.name;
        item.summary = n.summary || item.summary;
        item.airDate = n.airDate || item.airDate;
        item.ratingScore = n.ratingScore || item.ratingScore;
        item.rank = n.rank || item.rank;
        item.votes = n.votes || item.votes;
        item.tags = (n.tags && n.tags.length) ? n.tags : item.tags;
        item.alias = (n.alias && n.alias.length) ? n.alias : item.alias;
        item.poster = n.poster || item.poster;
      }
    }
    return item;
  }

  function section(title, bodyEl) {
    var s = el('section', 'sfv-bgi-section');
    s.appendChild(el('h2', 'sfv-bgi-section-title', title));
    s.appendChild(bodyEl);
    return s;
  }

  // ---- 追番 ----
  function buildActions(item) {
    var row = el('div', 'sfv-bgi-actions');

    var states = [{ key: null, label: '未追' }].concat(
      (SFV.model && SFV.model.TRACK_STATUSES || []).map(function (k) {
        return { key: k, label: (SFV.model.TRACK_LABELS && SFV.model.TRACK_LABELS[k]) || k };
      })
    );
    var cur = (SFV.model && SFV.model.getTrackStatus) ? SFV.model.getTrackStatus(trackKey(item)) : null;
    states.forEach(function (st) {
      var b = el('button', 'sfv-bgi-btn' + (st.key === cur ? ' active' : '') + (st.key ? ' st-' + st.key : ''));
      b.type = 'button';
      b.textContent = st.label;
      b.addEventListener('click', function () {
        if (SFV.model && SFV.model.setTrackStatus) SFV.model.setTrackStatus(trackKey(item), st.key);
        trackToast(st.key ? ('已标记为「' + st.label + '」') : '已清除追番状态');
        if (_host) renderFull(_host);
      });
      row.appendChild(b);
    });

    return row;
  }

  // ---- 附加区块：角色 / 关联 / 评论 ----
  function renderExtras(host, characters, relations, comments) {
    var box = host.querySelector('.sfv-bgi-extras');
    if (!box) return;
    box.innerHTML = '';

    // 角色
    var chars = extractCharacters(characters);
    if (chars.length) {
      var rail = el('div', 'sfv-bgi-rail');
      chars.slice(0, 24).forEach(function (c) { rail.appendChild(personCard(c)); });
      box.appendChild(section('角色', rail));
    }

    // 关联条目
    var rels = Array.isArray(relations) ? relations : [];
    if (rels.length) {
      var rrail = el('div', 'sfv-bgi-rail');
      rels.slice(0, 24).forEach(function (r) {
        var sub = r && r.subject ? r.subject : r;
        if (!sub || !sub.id) return;
        var n = SFV.bangumi ? SFV.bangumi.normSubject(sub) : null;
        if (!n) return;
        var card = el('div', 'sfv-bgi-rel');
        var i = doc.createElement('img');
        i.className = 'sfv-bgi-rel-poster';
        i.loading = 'lazy';
        i.src = n.poster || '';
        i.alt = '';
        card.appendChild(i);
        card.appendChild(el('div', 'sfv-bgi-rel-title', n.title || n.name));
        card.addEventListener('click', function () { open(n); });
        rrail.appendChild(card);
      });
      if (rrail.childNodes.length) box.appendChild(section('关联条目', rrail));
    }

    // 评论
    var list = (comments && comments.data) ? comments.data : [];
    if (list.length) {
      var ul = el('div', 'sfv-bgi-comments');
      list.slice(0, 10).forEach(function (c) {
        var it = el('div', 'sfv-bgi-comment');
        var u = (c.user && (c.user.nickname || c.user.username)) || '匿名';
        it.appendChild(el('div', 'sfv-bgi-comment-user', u));
        it.appendChild(el('div', 'sfv-bgi-comment-text', String(c.comment || '').slice(0, 300)));
        ul.appendChild(it);
      });
      box.appendChild(section('评论', ul));
    }
  }

  function extractCharacters(res) {
    if (!res) return [];
    var arr = Array.isArray(res) ? res : (res.data || []);
    return arr.map(function (c) {
      var ch = (c && c.character) ? c.character : c;
      var images = (ch && ch.images) || {};
      return {
        name: (ch && (ch.name || ch.nameCn)) || '',
        role: (c && c.relation) || '',
        poster: SFV.bangumi ? SFV.bangumi.rewriteImage(images.medium || images.large || images.grid || images.small || '') : ''
      };
    }).filter(function (c) { return !!c.name; });
  }

  function personCard(c) {
    var card = el('div', 'sfv-bgi-person');
    var i = doc.createElement('img');
    i.className = 'sfv-bgi-person-poster';
    i.loading = 'lazy';
    i.src = c.poster || '';
    i.alt = '';
    i.addEventListener('error', function () { i.style.visibility = 'hidden'; });
    card.appendChild(i);
    card.appendChild(el('div', 'sfv-bgi-person-name', c.name));
    if (c.role) card.appendChild(el('div', 'sfv-bgi-person-role', c.role));
    return card;
  }

  // ---------------------------------------------------------------- 路由注册
  if (SFV.router) {
    SFV.router.register({
      id: PAGE_ID,
      title: '条目详情',
      mount: mount,
      back: function () {
        // 返回时间表页
        if (SFV.bangumiTimeline && typeof SFV.bangumiTimeline.openPage === 'function') {
          SFV.bangumiTimeline.openPage();
          return true;
        }
        return false;
      },
      unmount: function () {
        _host = null;
        _detail = null;
      }
    });
  }

  SFV.bangumiInfo = { open: open, mount: mount, _current: function () { return _current; } };
})(typeof window !== 'undefined' ? window : this);
