// 本地化音乐资料库 · 页面层（spec: 2026-10-18-local-music-library-design.md §1/§2/§4/§5）
// Task 5：三轴共用网格渲染器 + payload Map + 封面/头像三级兜底 + other 分界条 + 状态盒。
// 数据只来自 window.stellaMlibRead（读层给状态与文案，页面只显示、不改写、不重排）。
// DOM 约定：卡对象存 Map<element, card>，DOM 属性只放 data-mlib-id（见 spec §2 payload 条）。
// 本文件的 DOM 用法限定在 tests/helpers/mlib-fake-dom.js 实现的子集内
// （getElementById / querySelector(All) / createElement / classList / textContent /
//   setAttribute / innerHTML 赋值 / appendChild / dataset），假 DOM 测出来的结论才当真。
(function () {
  'use strict';

  var AXES = ['albums', 'artists', 'playlists'];
  var AXIS_CLASS_PREFIX = 'mlib-axis-';
  var AXIS_CLASS = {
    albums: 'mlib-axis-albums', artists: 'mlib-axis-artists', playlists: 'mlib-axis-playlists',
  };
  // 读层只给 action token，按钮文字归页面（spec §5 表里的动作列）
  var ACTION_LABEL = { import: '去导入', retry: '重试' };
  var STATE_TONE = { 'engine-missing': 'warn', error: 'warn' }; // empty/轴为空＝诚实空态，不涂警告色
  var DIVIDER_LABEL = '其他'; // 「其他」组的跨行分界标签（读层不管标签）
  // 图标是模块内静态字面量，永远不含卡数据
  var PLAY_GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 5.5v13l10.5-6.5z"/></svg>';
  var MUSIC_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"' +
    ' stroke-linecap="round" aria-hidden="true" focusable="false">' +
    '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>';

  // 网格卡数据：Map<DOM 节点, 读层卡对象>（值＝读层那张卡本身的引用，不复制、不回写）
  var gridPayload = new Map();
  // 详情曲目行数据：Map<DOM 节点, 读层轨对象>（与网格同一做法，DOM 只放 data-mlib-track-id）
  var detailPayload = new Map();
  var requestSeq = 0;  // UI 侧请求序号：切轴/关闭/通知重绘期间的晚到旧响应一律丢弃（spec §3 并发口径）
  var playSeq = 0;     // 播放侧代数：**只代表用户动作**（切轴/关闭）——R 裁2：后台通知刷新不得作废用户已发出的播放
  var savedScrollTop = 0; // 进入二级详情前记录的网格滚动位置，返回时恢复（spec §2 滚动条）
  var renderedAxis = '';  // 本层上一次渲染的轴（关闭后 body 类被摘净时仍用它兜底脏补；不再是滚动闸）
  var detailEntity = null; // 当前详情实体 { axis, id }：通知到来时才知道该重绘哪一份（R1）
  var gridDirty = false;   // 详情开着时来过通知＝底下那份网格脏了，等 closeDetail 恢复滚动后再补（R1 ②③）

  window.__mlibGridPayloadForTests = gridPayload;
  window.__mlibDetailPayloadForTests = detailPayload;

  // ---------- 小工具 ----------

  // 与 05-playback/00-api-quality-output.js 的全局 escHtml 同一映射表；
  // 这里自带一份：04-shelf 段与 05-playback 段互不共享文件作用域，跨 bundle 引用全局是运气不是契约。
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  function byId(id) { return document.getElementById(id); }
  function el(tag) { return document.createElement(tag); }

  function drop(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function readLayer() { return window.stellaMlibRead || null; }

  // 首字母占位规则（spec §2 三级兜底）：拉丁取首个字母、中文取首个汉字、取不到＝空串（改画图标）
  function artistInitial(name) {
    var s = String(name || '').trim();
    if (!s) return '';
    var latin = s.match(/[A-Za-z]/);
    var han = s.match(/[㐀-䶿一-鿿]/);
    if (latin && han) return latin.index <= han.index ? latin[0].toUpperCase() : han[0];
    if (latin) return latin[0].toUpperCase();
    if (han) return han[0];
    var any = s.match(/[^\s\p{P}\p{S}]/u);
    return any ? any[0].toUpperCase() : '';
  }

  // 时长格式化：秒 → m:ss（spec §3 duration 为数值；纯数值格式化，不含任何本地化文案）。
  // 非数值/非正数一律空串——宁可留空，也不显示 "NaN:NaN" 或负数。
  function fmtDur(sec) {
    var n = Number(sec);
    if (!isFinite(n) || n <= 0) return '';
    n = Math.floor(n);
    var m = Math.floor(n / 60);
    var s = n % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---------- 渲染：卡片 ----------

  // 专辑/歌单封面：有 URL 才出 img（URL 走属性赋值，不进 HTML 字符串，从构造上就没有注入面）；
  // 无封面＝只有 .stella-mlib-art 的底色占位，绝不画「蓝盘」SVG（首页快卡那套路子不在这里用）。
  function coverArt(card) {
    var art = el('div');
    art.classList.add('stella-mlib-art');
    var url = String(card.cover || '').trim();
    if (!url) {
      art.classList.add('is-loaded'); // 占位没有图，微光不该空转
      return art;
    }
    var img = el('img');
    img.src = url;
    img.setAttribute('alt', '');
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.addEventListener('load', function () { art.classList.add('is-loaded'); });
    // 取不到图不显示破图：摘掉 img，退回底色占位（版面不跳）
    img.addEventListener('error', function () { art.classList.add('is-loaded'); drop(img); });
    art.appendChild(img);
    return art;
  }

  // 艺人头像三级兜底：代表图 → 名称首字母 → 音乐图标。**绝不用 card.cover（专辑封面）冒充**。
  function artistArt(card) {
    var art = el('div');
    art.classList.add('stella-mlib-artist-art');
    var initial = artistInitial(card.title);
    var ph = el('span');
    ph.classList.add('stella-mlib-artist-initial');
    if (initial) ph.textContent = initial;
    else { ph.classList.add('is-icon'); ph.innerHTML = MUSIC_GLYPH; }
    ph.setAttribute('aria-hidden', 'true');
    art.appendChild(ph); // 占位先落，图加载成功后才盖上去
    var avatar = String((card.meta && card.meta.avatar) || '').trim();
    if (avatar) {
      var img = el('img');
      img.classList.add('stella-mlib-artist-img');
      img.src = avatar;
      img.setAttribute('alt', '');
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.addEventListener('load', function () { art.classList.add('has-image'); });
      img.addEventListener('error', function () { art.classList.remove('has-image'); drop(img); });
      art.appendChild(img);
    }
    return art;
  }

  // 悬停播放钮只在方形封面上出现（专辑/歌单轴）；触屏设备由 CSS 的
  // html:not(.stella-mlib-has-hover) 分支隐藏，整张封面即播放入口（Task 8 接线）。
  function playButton(card, unplayableHint) {
    var btn = el('button');
    btn.classList.add('stella-mlib-play-btn');
    btn.setAttribute('type', 'button');
    btn.innerHTML = PLAY_GLYPH;
    if (!card.playable) {
      btn.disabled = true;
      if (unplayableHint) btn.setAttribute('title', unplayableHint);
    }
    return btn;
  }

  // 文案区：与 homeDashboardCardHtml 同一套「esc 文本拼接」模式（仓内既有模式），
  // 拼进 innerHTML 的一切文本都已转义；需要被检查的结构（封面/头像/播放钮）用 createElement。
  function metaRows(card) {
    var html = '<div class="stella-mlib-album-name">' + esc(card.title) + '</div>';
    if (String(card.sub == null ? '' : card.sub)) {
      html += '<div class="stella-mlib-album-sub">' + esc(card.sub) + '</div>';
    }
    return html;
  }

  function buildCard(axis, card, unplayableHint) {
    if (!card) return null;
    var node = el('article');
    node.classList.add('stella-mlib-album-card'); // 三轴共用同一张卡
    // 三轴的卡都是二级详情入口（getAlbumDetail/getArtistDetail/getPlaylistDetail），
    // 统一点亮可开态：CSS 靠 .is-openable 给指针手势（Task 5 刻意留白，本任务补上真相源）。
    node.classList.add('is-openable');
    if (axis === 'artists') node.classList.add('stella-mlib-artist-card');
    node.setAttribute('data-mlib-id', String(card.id == null ? '' : card.id));
    // 键盘可达（参照库 06-music-library.js:659 的卡带 tabindex="0"）：卡根进 Tab 序列，
    // Enter/Space 由 09 那条唯一的 keydown 监听按 click 同一套优先级判定分派。
    // 走 tabIndex 属性赋值（真 DOM 会反射成 tabindex），数据字段依旧一个都不进 DOM 属性。
    node.tabIndex = 0;
    var art = axis === 'artists' ? artistArt(card) : coverArt(card);
    if (axis !== 'artists') art.appendChild(playButton(card, unplayableHint));
    node.appendChild(art);
    var meta = el('div');
    meta.classList.add('stella-mlib-album-meta');
    meta.innerHTML = metaRows(card);
    node.appendChild(meta);
    return node;
  }

  function divider() {
    var d = el('div');
    d.classList.add('stella-mlib-artist-divider');
    d.setAttribute('role', 'separator');
    d.textContent = DIVIDER_LABEL;
    return d;
  }

  // 网格：顺序照读层（读层已排好），页面绝不 sort/重排。
  // 分界条只属于艺人轴：other 组（数字/符号/无拼音汉字）之前插一条跨整行的分界。
  function renderGrid(axis, cards, unplayableHint) {
    var grid = byId('mlib-grid');
    if (!grid) return;
    var list = Array.isArray(cards) ? cards.slice() : []; // 缓存返回的是共享引用：只读本地副本
    var prevBucket = '';
    list.forEach(function (card) {
      if (!card) return;
      var bucket = String(card.sortBucket || '');
      if (axis === 'artists' && bucket === 'other' && prevBucket !== 'other') grid.appendChild(divider());
      prevBucket = bucket;
      var node = buildCard(axis, card, unplayableHint);
      if (!node) return;
      grid.appendChild(node);
      gridPayload.set(node, card);
    });
  }

  // ---------- 渲染：状态盒 ----------

  function clearStateBox() {
    var box = byId('mlib-state-box');
    if (!box) return;
    box.innerHTML = ''; // 真 DOM 的 #mlib-state-box:empty 才 display:none
    box.removeAttribute('data-tone');
  }

  function stateRow(className, text) {
    var row = el('div');
    row.classList.add(className);
    row.textContent = text;
    return row;
  }

  // copy = getStateCopy 的 { heading, hint, action }（文案一字不改，页面只加动作按钮的字）
  // box 由调用方传入：网格态传 #mlib-state-box，详情态传列表区里的状态盒容器——同一套行/按钮逻辑。
  function fillStateBox(box, axis, copy, status) {
    if (!box) return;
    box.innerHTML = '';
    if (STATE_TONE[status]) box.setAttribute('data-tone', STATE_TONE[status]);
    else box.removeAttribute('data-tone');
    if (copy.heading) box.appendChild(stateRow('stella-mlib-state-heading', copy.heading));
    if (copy.hint) box.appendChild(stateRow('stella-mlib-state-hint', copy.hint));
    var label = copy.action ? ACTION_LABEL[copy.action] : null;
    if (!label) return;
    var btn = el('button');
    btn.classList.add('stella-mlib-state-btn');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-mlib-action', String(copy.action)); // 动作 token，非卡数据：Task 7 按它接线
    btn.textContent = label;
    box.appendChild(btn);
  }

  function renderStateBox(axis, copy, status) {
    fillStateBox(byId('mlib-state-box'), axis, copy, status);
  }

  // ---------- 壳层状态（真相源＝body 类） ----------

  function markActive(axis) {
    var body = document.body;
    if (!body) return;
    body.classList.add('mlib-active', AXIS_CLASS_PREFIX + axis);
    body.classList.remove('mlib-leaving');
    AXES.forEach(function (a) { if (a !== axis) body.classList.remove(AXIS_CLASS[a]); });
  }

  // body 类的摘除（active / leaving / detail-open / 轴类）整体归 09-mlib-bindings.js 的 420ms 让位复位（F3：单一属主）。
  // 本层不再自建离场 timer 抢着摘类；页面层负责的是在途请求作废、网格/状态盒清空与 #music-library 的 aria-hidden。
  // aria-hidden 是页面自己的可访问性真相源，关闭时就位（不等动画）。
  function setLayerAria(hidden) {
    var layer = byId('music-library');
    if (layer) layer.setAttribute('aria-hidden', hidden ? 'true' : 'false');
  }

  function clearGrid() {
    var grid = byId('mlib-grid');
    if (grid) grid.innerHTML = '';
    gridPayload.clear();
  }

  // R2（终审回批第2轮）：清网格与「作废在途整张播放」是两件事，第1轮把它们并在一处才引出探针②
  //（通知刷新走 clearGrid → 顺带 bump playSeq → 用户点了整张播放却一首都没入队）。
  // 这枚代数只由用户动作推进：切轴/开轴/关闭（R 裁2：后台数据变更不该取消用户已发出的播放意图）。
  function voidInflightPlayback() {
    playSeq += 1; // 切轴/关闭后晚到的详情响应一份都不许入队
  }

  // 桌面/hover 能力探测：结果落一个 html 根类，CSS 据此决定播放钮显隐与整封面点按。
  function syncHoverCapability() {
    var hasHover = false;
    try {
      hasHover = !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
    } catch (e) {
      hasHover = false; // 探测不了就按触屏处理：播放钮不铺满封面
    }
    var root = document.documentElement;
    if (root && root.classList) root.classList.toggle('stella-mlib-has-hover', hasHover);
  }
  syncHoverCapability();

  // ---------- 数据 → 视图 ----------

  function unplayableHintOf(read) {
    return typeof read.unplayableHint === 'function' ? String(read.unplayableHint() || '') : '';
  }

  // 缝抛错/读层缺失时的兜底态：形状同 error，文案仍走读层表（页面不自带文案）
  function syntheticError(axis, err) {
    return { axis: axis, cards: [], status: 'error', message: (err && err.message) || '' };
  }

  function paint(axis, result) {
    var read = readLayer();
    if (!read) return; // 读层未就绪：网格保持清空，不猜状态、不刷屏
    var copy = typeof read.getStateCopy === 'function'
      ? read.getStateCopy(axis, result)
      : { heading: '', hint: '', action: null };
    if (!copy) { // null＝正常有卡（Task 3 口径），必须先判空再碰 heading/hint/action
      clearStateBox();
      renderGrid(axis, result.cards, unplayableHintOf(read));
      return;
    }
    renderStateBox(axis, copy, result.status);
  }

  // 网格渲染主体：用户开轴（openAxis）与后台通知重绘（onSeamNotify / 返回脏补）共用这一条路，
  // 差别全部落在 opts 上——两条路必须分开，否则第1轮那种「通知顺手把用户的东西废掉」会重演：
  //   opts.pinTop     —— 是否把滚动钉回顶部。R 裁3（回参照库口径）：**每次 open 都钉**，
  //                       含同轴重开、关闭后重开、离场复活（参照库 06-music-library.js:1547-1548 在
  //                       openMusicLibrary 里每次打开都钉 0，没有「仅换轴才钉」这一档）。
  //                       后台重绘（通知刷新、closeDetail 后的脏补）**不钉**：那是把用户正在看的位置弹走的新骚扰。
  //   opts.userAction —— 是否代表用户动作：只有它作废在途整张播放（R 裁2）。
  // 同步清场（网格/payload/状态盒）两条路都做：新数据到位前绝不残留上一份。
  async function renderAxis(axis, opts) {
    var o = opts || {};
    var seq = ++requestSeq;
    renderedAxis = axis;
    syncHoverCapability();
    registerSeamWatch(); // F1：首次开库就把刷新回调登记进读层（订阅本身归 07）
    clearGrid();      // 同步清场：新数据到位前绝不残留上一轴的卡
    if (o.userAction) voidInflightPlayback(); // 只有用户动作作废在途播放（R 裁2）
    clearStateBox();
    markActive(axis); // body 类真相源＋轴类互斥
    setLayerAria(false);
    gridDirty = false; // 本轴正在重绘：脏位到此为止
    if (o.pinTop) {
      var sc = scrollEl();
      if (sc) sc.scrollTop = 0; // 用户开轴＝新版面从头看（参照库每次 open 都钉）
    }
    var read = readLayer();
    if (!read || typeof read.getAxisData !== 'function') return;
    var result;
    try {
      result = await read.getAxisData(axis);
    } catch (e) {
      result = syntheticError(axis, e);
    }
    if (seq !== requestSeq) return; // 晚到的旧响应：不覆盖新视图、不复活 payload
    paint(axis, result || { axis: axis, cards: [], status: 'error' });
  }

  // 用户开轴（三卡点击 / retry / 离场复活都走这里）：钉顶 + 作废在途播放。
  // 为什么不再判「换没换轴」：参照库那档就是每次 open 都钉；而通知刷新根本不走这条（见 onSeamNotify）。
  async function openAxis(axis) {
    return renderAxis(axis, { pinTop: true, userAction: true });
  }

  function close() {
    requestSeq += 1; // 在途渲染一并作废
    clearGrid();
    voidInflightPlayback(); // 关闭＝用户动作：在途整张播放一并作废
    clearStateBox();
    gridDirty = false; // 层都关了，脏位没有下一站可补
    var body = document.body;
    // 只点亮动画态（CSS 靠 body.mlib-leaving 起 .26s 离场过渡）；active/leaving/轴类的摘除一律由绑定层 420ms 负责。
    // 未开时连 leaving 都不点：没有动画可播，且残留复位同样归绑定层。
    if (body && body.classList && body.classList.contains('mlib-active')) {
      body.classList.add('mlib-leaving');
    }
    setLayerAria(true);
  }

  // ---------- F1（终审回批）＋ R1/R2（第2轮回批）：缝通知 → 详情开着重绘详情并把网格标脏，否则重绘现值轴 ----------
  // 读层 engine-missing 那句「导入……后这里会自动出现」的兑现路径：07 的 watchSeam 订缝并先 invalidate，
  // 本层只负责「要不要趁现在重画」。订阅/失效一律不在这里做（分层：页面不碰缝）。
  // 闸＝body 真相源：库开着（mlib-active 且不在 mlib-leaving）才重渲染；关着/让位途中直接返回，零渲染零请求。
  // 第2轮补的两条口径（都是第1轮接线留下的新破口，scoped 复审探针实锤）：
  //   · R 裁1：详情开着时来通知＝重取重绘那一份详情，网格标脏等返回再补——不是让 openAxis 判废在途详情留空白壳。
  //   · R 裁2：通知刷新这一路一律不 bump playSeq（作废在途整张播放只属于用户动作）。
  var seamWatchRegistered = false;

  // 现值轴从 body 现挂的 mlib-axis-* 推出（与绑定层同一口径），绝不缓存变量。
  function currentBodyAxis() {
    var body = document.body;
    if (!body || !body.classList) return '';
    var found = '';
    String(body.className || '').split(/\s+/).some(function (c) {
      if (c && c.indexOf(AXIS_CLASS_PREFIX) === 0) { found = c.slice(AXIS_CLASS_PREFIX.length); return true; }
      return false;
    });
    return found;
  }

  function onSeamNotify() {
    var body = document.body;
    if (!body || !body.classList) return;
    if (!body.classList.contains('mlib-active')) return;   // 库关着：什么都不画
    if (body.classList.contains('mlib-leaving')) return;   // 让位途中：别打断离场动画
    var axis = currentBodyAxis();
    if (!axis) return;
    if (body.classList.contains('mlib-detail-open')) {
      // R 裁1（spec §5 line 74）：rev 变化要**三轴+详情一起作废**。详情开着时的正确行为是
      // 「详情重新取数重绘」——既不是跳过刷新（数据就永久陈旧），也不是像第1轮那样让 openAxis
      // 把在途 openDetail 判废、留下一个还挂着 mlib-detail-open 的永久空白壳（探针①）。
      // 底下那份网格此刻被 CSS 遮着：只标脏，等 closeDetail 恢复完滚动再补一次重绘（R1 ②③）。
      gridDirty = true;
      var d = refreshDetail();
      if (d && typeof d.catch === 'function') d.catch(function () { /* 内部已兜底，只防 unhandled rejection */ });
      return;
    }
    // 网格就在屏幕上：直接重绘这一轴。走 renderAxis 的后台档——不钉顶（R3：通知是后台重绘，
    // 把用户正在看的位置弹走是新的骚扰）、不作废在途播放（R 裁2）。
    gridDirty = false;
    var r = renderAxis(axis, {});
    if (r && typeof r.catch === 'function') r.catch(function () { /* 同上 */ });
  }

  // 只登记一次：多轮开/关库共用同一个回调（订阅与监听数组的生命周期都在读层）。
  function registerSeamWatch() {
    if (seamWatchRegistered) return;
    var read = readLayer();
    if (!read || typeof read.watchSeam !== 'function') return; // 读层没这条契约＝没有自动刷新，不抛
    seamWatchRegistered = true;
    try { read.watchSeam(onSeamNotify); } catch (e) { /* 读层抛错也不拖累本页 */ }
  }

  // ---------- 二级详情（Task 6）----------
  // 只负责详情视图渲染 + 进入/返回滚动记录恢复 + body 类 mlib-detail-open（真相源，Task 7 依赖）。
  // 返回钮点击、ESC、播放接线全部归 Task 7/8：本层不监听任何事件，只暴露 openDetail/closeDetail。

  function scrollEl() { return byId('music-library-scroll'); }

  function setGridViewAria(hidden) {
    var g = byId('mlib-view-grid');
    if (g) g.setAttribute('aria-hidden', hidden ? 'true' : 'false'); // 详情压住网格时对读屏隐藏，返回恢复
  }

  function clearDetail() {
    var head = byId('mlib-detail-head');
    var tracks = byId('mlib-detail-tracks');
    if (head) head.innerHTML = '';
    if (tracks) tracks.innerHTML = '';
    detailPayload.clear();
  }

  // 头部只用 entity 原文字段（sub→eyebrow、title→标题）+ meta（曲目数 / 发行年）。
  // 曲目数带「首」量词是参照库自己的做法（07-album-detail.js:468/894 把 '<span>N 首</span>' 直接写在页面模块里），
  // 移植后该量词归页面所有（读层不产出详情曲目数的带单位串）；「首」不是读层状态文案表里的串，
  // 反硬编码源码守卫不拦它——是否集中归口交 Task 9 终审决定。除此之外不发明参照库没有的量词（如「分钟」）。
  function renderDetailHead(entity) {
    var head = byId('mlib-detail-head');
    if (!head) return;
    head.innerHTML = '';
    var e = entity || {};
    var eyebrow = el('div');
    eyebrow.classList.add('stella-mlib-eyebrow');
    eyebrow.textContent = String(e.sub == null ? '' : e.sub);

    var title = el('h2');
    title.classList.add('stella-mlib-detail-title');
    title.textContent = String(e.title == null ? '' : e.title);

    var bits = [];
    var count = Number(e.count);
    if (isFinite(count) && count > 0) bits.push(count + ' 首'); // 参照库原文带「首」量词
    var year = Number((e.meta && e.meta.releaseYear) || 0);
    if (year > 0) bits.push(String(year));
    var meta = el('div');
    meta.classList.add('stella-mlib-head-meta');
    meta.textContent = bits.join(' · '); // 分隔符是排版胶水，不含可本地化词

    head.appendChild(eyebrow);
    head.appendChild(title);
    head.appendChild(meta);
  }

  // 参照库（07-album-detail.js:493-505）的曲目行＝连续 5 列：序号 / 曲名 / 艺人次级 / 时长 / 播放动作。
  // 移植 CSS .stella-mlib-track 只有这 5 列（music-library.css:527-533，窄屏 760px 再摘掉艺人列），
  // 没有封面列，第 5 列 .stella-mlib-track-more 承载播放三角——CSS 不可改，本渲染器严格贴合既有列数。
  function trackPart(className, text) {
    var s = el('div');
    s.classList.add(className);
    s.textContent = text; // 一律 textContent：恶意串按原文显示，绝不当标签解析
    return s;
  }

  // 第 5 列播放动作：参照库用 .am-album-track-more 装播放三角（不是「⋯」菜单），移植类名 .stella-mlib-track-more。
  // aria-label 恒为「播放 + 曲名」（参照库原文）；曲名走属性赋值，不经 HTML 串，从构造上就没有注入面。
  // matched:false 才置灰 + title 取读层文案（item ④）；可播行不放 title——不发明参照库没有的播放文案。
  // 按钮惰性：Task 8 才接线，本层不加任何监听。
  function trackMoreButton(name, unplayableHint, matched) {
    var btn = el('button');
    btn.classList.add('stella-mlib-track-more');
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', '播放 ' + name);
    btn.innerHTML = PLAY_GLYPH; // 播放三角静态图标（同网格），不含轨数据
    if (!matched) {
      btn.disabled = true;
      if (unplayableHint) btn.setAttribute('title', unplayableHint);
    }
    return btn;
  }

  function buildTrackRow(track, index, unplayableHint) {
    if (!track) return null;
    var matched = !!track.matched;
    var name = String(track.name == null ? '' : track.name);
    var row = el('div');
    row.classList.add('stella-mlib-track');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0'); // 参照库行可聚焦；键盘进播放归 Task 7
    row.setAttribute('data-mlib-track-id', String(track.id == null ? '' : track.id)); // DOM 只放 id，完整轨对象进 payload Map
    if (!matched) row.setAttribute('aria-disabled', 'true'); // 不可播行标 aria-disabled；可播行不带
    row.appendChild(trackPart('stella-mlib-track-no', String(index + 1)));
    row.appendChild(trackPart('stella-mlib-track-name', name));
    row.appendChild(trackPart('stella-mlib-track-artist', String(track.artist == null ? '' : track.artist)));
    row.appendChild(trackPart('stella-mlib-track-dur', fmtDur(track.duration)));
    row.appendChild(trackMoreButton(name, unplayableHint, matched));
    return row;
  }

  function renderTracks(tracks, unplayableHint) {
    var list = byId('mlib-detail-tracks');
    if (!list) return;
    var arr = Array.isArray(tracks) ? tracks.slice() : []; // 读层返回的是共享引用：只读本地副本
    var n = 0;
    arr.forEach(function (track) {
      if (!track) return;
      var row = buildTrackRow(track, n, unplayableHint);
      if (!row) return;
      list.appendChild(row);
      detailPayload.set(row, track);
      n += 1; // 序号按实际渲染出的行计，跳过 null 不空号
    });
  }

  function renderDetail(axis, res) {
    var read = readLayer();
    if (!read) return; // 读层未就绪：详情容器保持清空，不猜状态
    clearDetail();
    renderDetailHead(res.entity);
    // getStateCopy 期望结果列表挂在 .cards：详情轨在 .tracks，须适配后再喂（Task 3 口径）。
    // message 一并带上——error 态要把缝 message 逐字透传，否则退化成通用「读取失败」。
    var copy = typeof read.getStateCopy === 'function'
      ? read.getStateCopy(axis, { status: res.status, cards: res.tracks, message: res.message })
      : null;
    if (copy === null) { // null＝正常有轨（ok 且列表非空），渲染曲目行
      renderTracks(res.tracks, unplayableHintOf(read));
      return;
    }
    var list = byId('mlib-detail-tracks');
    if (!list) return;
    var box = el('div'); // 详情状态盒走网格同一 fillStateBox 助手；挂 .stella-mlib-state-box（该类已在 CSS 里有主，与 #mlib-state-box 共享三条状态盒规则）
    box.classList.add('stella-mlib-state-box');
    list.appendChild(box);
    fillStateBox(box, axis, copy, res.status);
  }

  async function openDetail(axis, id) {
    var seq = ++requestSeq; // 复用网格同一序号：开详情即令在途网格/旧详情渲染作废
    detailEntity = { axis: axis, id: id }; // R1：记住当前详情实体，通知来了才知道要重绘哪一份
    var sc = scrollEl();
    savedScrollTop = sc && typeof sc.scrollTop === 'number' ? sc.scrollTop : 0; // 进入前记录网格滚动
    if (sc) {
      sc.scrollTop = 0; // 新详情从头看；也让「返回恢复」成为可被观测的往返（否则 0→0 无从证明）
      if (typeof requestAnimationFrame === 'function') {
        // 真浏览器：显隐切换会触发重排，rAF 后二次钉顶防止旧值被随后恢复覆盖
        requestAnimationFrame(function () { sc.scrollTop = 0; });
      }
    }
    var body = document.body;
    if (body && body.classList) body.classList.add('mlib-detail-open'); // 真相源
    setGridViewAria(true);
    clearDetail(); // 同步清场：新详情到位前不残留上一份
    var read = readLayer();
    if (!read || typeof read.getDetail !== 'function') return;
    var res;
    try {
      res = await read.getDetail(axis, id);
    } catch (e) {
      res = { entity: null, tracks: [], status: 'error', message: (e && e.message) || '' }; // 读层约定不抛；真抛按 error 兜底
    }
    if (seq !== requestSeq) return; // 晚到的旧详情/已被返回：不铺行、不复活 payload
    renderDetail(axis, res || { entity: null, tracks: [], status: 'error' });
  }

  // R1（终审回批第2轮）：详情开着时来了通知＝这份详情重新取数重绘（不是跳过、也不是留空白壳）。
  // 与 openDetail 的三点差别，逐条都是裁决要求的：
  //   · **不记录滚动**：绝不覆写 savedScrollTop——那是「进详情前的网格位置」，被详情的 0/300 覆写后
  //     返回时就把主人弹到别处（R1 要求的 savedScrollTop 守卫）。
  //   · **不钉顶**：详情正在屏幕上，重绘不该动 scrollTop。
  //   · **不重放 body 类/aria**：真相源已就位（mlib-detail-open 还挂着）。
  // requestSeq 照 bump：让更早的在途渲染（含开详情那一份晚到的响应）一并作废——探针①的空白就是这么来的。
  // 失败/空列表由既有 renderDetail 的状态盒分支兑现（R1 ④：不得留空壳）。
  async function refreshDetail() {
    var e = detailEntity;
    if (!e) return; // 没记住实体（例如详情类是别人手动点的）：不猜该重绘什么
    var seq = ++requestSeq;
    var read = readLayer();
    if (!read || typeof read.getDetail !== 'function') return;
    var res;
    try {
      res = await read.getDetail(e.axis, e.id);
    } catch (err) {
      res = { entity: null, tracks: [], status: 'error', message: (err && err.message) || '' };
    }
    if (seq !== requestSeq) return; // 又晚了：不铺行、不复活 payload
    renderDetail(e.axis, res || { entity: null, tracks: [], status: 'error' });
  }

  // R1 ③：详情开着时网格被标脏，返回（滚动恢复之后）补一次当前轴重绘。
  // 走 renderAxis 的后台档（不钉顶、不作废在途播放）——恢复好的位置绝不能被这一下弹走。
  function repaintDirtyGrid() {
    if (!gridDirty) return;
    gridDirty = false;
    var axis = currentBodyAxis() || renderedAxis;
    if (!axis) return; // 轴真相源没了（层已被绑定层摘净）：没有该补的网格
    var r = renderAxis(axis, {});
    if (r && typeof r.catch === 'function') r.catch(function () { /* 内部已兜底 */ });
  }

  function closeDetail() {
    requestSeq += 1; // 在途详情一并作废
    detailEntity = null;
    clearDetail();
    var body = document.body;
    if (body && body.classList) body.classList.remove('mlib-detail-open');
    setGridViewAria(false);
    var sc = scrollEl();
    if (sc) sc.scrollTop = savedScrollTop; // 恢复到进入详情前记录的网格位置
    repaintDirtyGrid(); // 恢复完滚动才补脏网格（顺序就是 R1 ③ 要求的顺序）
  }

  // ---------- 播放接线（Task 8；C1/I1 修复轮）----------
  // 事件面不在本层：document 上唯一那枚 click 委托归 09-mlib-bindings.js（F2 单一属主）。
  // 绑定层只解析「点了哪张卡/哪条轨的播放/哪个是详情入口」→ 调本层 playEntity/playTrack/openDetail/closeDetail；
  // payload 命中、「这行到底可不可播」的代码闸、以及 track→song 映射都归本层。
  // 队列入口只用既有全局 queueSong（05-playback/10-queue-actions.js:1：cloneSong→入队尾→safeRenderQueuePanel/shelf 重建），
  // 它回的就是这一项的插入索引；起播只用既有全局 playQueueAt（13-playback-start-audio.js:932），
  // 播「本批首个新入队项」——这是 spec line 40「整封面可点即播」的兑现，不是「替换整队列并起播」。
  // 本层不直接摸 05-playback 的队列内部态（队列表本体 / 当前索引两枚私有变量），也不照抄那两枚「整队列替换」入口
  //（06-lyrics/03-podcast-playlist-loaders.js:209、03a-home-dashboard.js:1646）——它们各自要 provider id 与
  // API 取页/hydrate 前置数据，页面层没有这些数据，硬接＝发明播放行为。追加即起播只做「append + 播首项」两件事。

  function queueSongFn() {
    // window-qualified + typeof 守卫（同绑定层对「去导入」动作钮的口径）：
    // 05-playback 段没加载/没把这枚普通 function 泄漏到全局时，静默不动作、绝不抛。
    return typeof window.queueSong === 'function' ? window.queueSong : null;
  }

  // track→song：缝轨（spec §3 最小字段）原样浅复制——缝给的字段名与仓内 song 对象惯例本就同名小写
  // （name/artist/album/albumId/artistId/cover/duration/id：见 desktop/local-music-library.js:371-391 的
  //  serializeRecord 与 06-lyrics/05-upload-dragdrop.js:27-43 的 localSongFromAudioFile），
  // provider 侧身份字段（mid/hash/spotifyId/…）也一并直传，queueSong 里的 cloneSong 同样是 Object.assign 语义
  // （06-track-detail-lyrics-actions.js:1712），额外字段存活。然后只补两条仓内既有惯例：
  //   · localFile→localKey：本地标识在仓内的字段名是 localKey（06-lyrics/05-upload-dragdrop.js:38 真生产者），
  //     队列身份 local: 由它决定（09-queue-snapshot-autoplay.js:8）；缝已给 localKey 时不覆盖，
  //     并且**页面绝不合成 localUrl**——播放地址只可能来自缝自己给的值（playLocalQueueSong 只认 song.localUrl，
  //     13-playback-start-audio.js:847），从路径串造 scheme 就是发明播放行为。
  //   · mlibTrackId：纯溯源，不参与任何播放判定；快照白名单 playbackRestoreSongSnapshot
  //     （09-queue-snapshot-autoplay.js:15-23）本来就会把它摘掉，队列/换源链看不见它。
  // source/provider 一律不写 'mlib'：songProviderKey（07-search.js:445-451）与 normalizePlaybackProvider
  // （00-api-quality-output.js:47-54）对认不出的词一律回 netease，而本地分支看的正是 source/type/localUrl
  // （00-api-quality-output.js:85、13-playback-start-audio.js:1121）——覆写只会把可播性弄丢，不会多给你任何解析。
  function songFromTrack(track) {
    var t = track || {};
    var song = Object.assign({}, t);
    song.mlibTrackId = String(t.id == null ? '' : t.id);
    if (song.localKey == null || song.localKey === '') {
      var localFile = typeof t.localFile === 'string' ? t.localFile : '';
      if (localFile) song.localKey = localFile; // 缝给过 localKey/localUrl 的本地记录走直传，这里只兜 localFile 那一档
    }
    return song;
  }

  // 只入可播轨：matched 是渲染播放钮 disabled 的同一个字段（trackMoreButton 用 !!track.matched），
  // 所以「钮是灰的」与「代码进不进得来」恒同一判据——disabled 在真浏览器里根本不派发 click，
  // 触屏分支（钮被 CSS 隐藏）与假 DOM 都会把点击送到这里，代码闸才是那条路的真相源。
  // 返回值＝{ n, firstIdx }：n 实际入队首数，firstIdx 本批**首个新入队项**在队列里的插入索引
  //（queueSong 回的就是插入索引，10-queue-actions.js:24/28），供调用方「追加后立刻播这一首」。
  // 既有队列项在前时 firstIdx 自然落在它们之后——本层只追加、不替换、不空队列（append 非 replace 的落点）。
  function enqueueMatched(tracks) {
    var push = queueSongFn();
    if (!push) return { n: 0, firstIdx: -1 }; // 队列链缺席：静默零入队
    var n = 0;
    var firstIdx = -1;
    (Array.isArray(tracks) ? tracks : []).forEach(function (track) {
      if (!track || !track.matched) return; // 整张播放跳过 unmatched（spec §3/§5）
      try {
        var idx = push(songFromTrack(track)); // 单参＝默认队尾追加；不传 position：抢「下一首」不是整张/单曲入队的语义
        n += 1;
        if (firstIdx < 0 && typeof idx === 'number' && idx >= 0) firstIdx = idx; // 首个新入队项的插入位
      } catch (e) { /* 既有队列链自己抛错：不虚报这一首，也不因此丢掉后面的曲目 */ }
    });
    return { n: n, firstIdx: firstIdx };
  }

  // 追加后立刻起播：用既有全局 playQueueAt（13-playback-start-audio.js:932，async）播**首个新入队项**，
  // 兑现 spec line 40「整封面可点即播」——只入队不出声不满足批准设计（参照库 07-album-detail.js「播完当前索引」的既有口径）。
  // · 不替换、不清空、不碰队列内部态：只把 queueSong 回的那个插入索引交给既有起播链（起播/本地优先/换源都在 05-playback 里）。
  // · { manual:true }＝手动起播，沿用既有口径（14-player-controls.js:545），不是自动连播。
  // · 缺席守卫：05-playback 段没加载时静默不起播，绝不抛（与入队同样的 typeof 口径）。
  // · 返回 Promise 时补 .catch，避免未处理 rejection；本层不 await 起播结果（起播成败归既有链）。
  function startPlaybackAt(idx) {
    if (typeof idx !== 'number' || idx < 0) return;
    if (typeof window.playQueueAt !== 'function') return; // 起播链缺席：已入队即可，静默不播
    var r;
    try {
      r = window.playQueueAt(idx, { manual: true });
    } catch (e) { return; } // 既有起播入口自己兜底；本层只保证委托不抛
    if (r && typeof r.catch === 'function') r.catch(function () { /* 只防 unhandled rejection，起播失败由既有链提示 */ });
  }

  // payload 命中：两张 Map 都是 Map<DOM 节点, 读层对象>，只有点击时才线性扫一遍（当前轴卡数/详情轨数有界）。
  // 查不到＝那份 payload 已经随切轴/关闭被清掉：这条播放路径不可达（不请求、不入队、不复活旧数据）。
  function gridCardById(id) {
    var key = String(id == null ? '' : id);
    var found = null;
    gridPayload.forEach(function (card) {
      if (found || !card) return;
      if (String(card.id == null ? '' : card.id) === key) found = card;
    });
    return found;
  }

  function detailTrackById(trackId) {
    var key = String(trackId == null ? '' : trackId);
    var found = null;
    detailPayload.forEach(function (track) {
      if (found || !track) return;
      if (String(track.id == null ? '' : track.id) === key) found = track;
    });
    return found;
  }

  // 整张播放：卡 payload 在场且 card.playable（playButton 的 disabled 同源）才向读层要曲目；
  // 顺序照读层返回的 tracks 原样（本层绝不 sort/重排，spec §4），unmatched 在入队时被过滤。
  // 入队后立刻播首个新入队项（spec line 40「整封面可点即播」）。playSeq 代数以「入队」为界：
  // 晚到的详情响应在 playSeq 检查处就 return，因此**既不入队也不起播**——起播天然被同一作废口径盖住。
  async function playEntity(axis, id) {
    var card = gridCardById(id);
    if (!card || !card.playable) return 0;
    var read = readLayer();
    if (!read || typeof read.getDetail !== 'function') return 0;
    var seq = playSeq;
    var res;
    try {
      res = await read.getDetail(axis, id);
    } catch (e) {
      return 0; // 读层约定不抛；真抛＝零入队
    }
    if (seq !== playSeq) return 0; // 在途期间用户切轴/关闭：晚到的响应一份都不入队、一步都不起播（通知刷新不在此列，R 裁2）
    var enq = enqueueMatched(res && res.tracks);
    if (enq.n > 0) startPlaybackAt(enq.firstIdx); // 追加到位后再播这一首（不 await、不看返回值）
    return enq.n;
  }

  // 单曲入队：用已渲染的那份 payload（不再打读层——行本来就在那儿），入队后立刻播该项，
  // 与整张/卡点击同一「追加即起播」口径（spec line 40 两模一致）。
  function playTrack(trackId) {
    var track = detailTrackById(trackId);
    if (!track || !track.matched) return 0;
    var enq = enqueueMatched([track]);
    if (enq.n > 0) startPlaybackAt(enq.firstIdx);
    return enq.n;
  }

  window.stellaMlibPage = Object.assign(window.stellaMlibPage || {}, {
    openAxis: openAxis, close: close, openDetail: openDetail, closeDetail: closeDetail,
    playEntity: playEntity, playTrack: playTrack,
  });
})();
