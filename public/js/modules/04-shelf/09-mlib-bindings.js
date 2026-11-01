// 本地化音乐资料库 · shell 绑定层（Task 7；spec §1 入口/让位、§5 事件分级）
// 职责严格三件：三卡委托点击（data-mlib-axis 是唯一映射源，不建卡 id/文案表）、
// body 类真相源的写入编排（mlib-active / mlib-axis-* / mlib-detail-open / mlib-leaving）、
// ESC 两级（capture 抢在 10-shell 既有冒泡链之前；资料库未开时完全不拦截）
// + 激活键 Enter/Space（F2：同一条 keydown、同一套优先级判定，焦点在真 button 上让位给原生激活）。
// 外加状态盒动作钮（data-mlib-action=import/retry）、播放意图与二级详情入口/返回钮（Task 8 C1/I1）
// 都走同一条 document 点击委托（F2：恰一枚）；批D 起弹窗 chrome（关闭/遮罩/整单播放/随机/展开简介）
// 也只加这条委托里的分支，不新增任何监听。
// 渲染与数据归 08-mlib-page.js（stellaMlibPage，fake 可桩）；本层只解析「点的是哪张卡/哪条轨的播放」，
// 可播判定与 track→song 入队映射都在页面层，绑定层不碰队列、不判本地/在线。
// 首页让位由 CSS 拥有（body.mlib-active 分支已置首页 opacity/pointer-events），
// 本层绝不双写首页样式。页面 DOM 用法限于 tests/helpers/mlib-fake-dom.js 的 API 面。
// 监听注册口径（F2）：click / keydown(capture) / 动作钮**各自一枚、都在 document 上**。
// 绝不在 window 再挂第二份：真浏览器里 click 会 document→window 冒泡两次，两份注册＝同一次点击跑两遍
// （开轴只是被幂等闸侥幸兜住，导入弹窗那种非幂等动作会直接开两次）。
(function () {
  'use strict';

  var AXIS_SELECTOR = '[data-mlib-axis]';
  var AXIS_ATTR = 'data-mlib-axis';
  var ACTION_SELECTOR = '[data-mlib-action]';
  // 动作 token 由读层的 getStateCopy 给、按钮文字由页面层的 ACTION_LABEL 给：本层只认 token，不复制文案。
  var ACTION_IMPORT = 'import';
  var ACTION_RETRY = 'retry';
  var AXIS_CLASS_PREFIX = 'mlib-axis-';
  var LEAVE_MS = 420; // 离场动画 .26s + 缓冲；timer 经 window.__mlibTimer || setTimeout 取，测试可注入假 clock

  // 关→开竞态守卫：每次开/关都递增序号，晚到的旧离场回调发现自己不是最新一代就作废
  // （因此无需 clearTimeout，注入的假 timer 只需 setTimeout 同签名）。
  var seq = 0;

  function bodyEl() { return document.body; }

  function hasBodyClass(name) {
    var b = bodyEl();
    return !!(b && b.classList && b.classList.contains(name));
  }

  // 摘除除 keep 外的全部 mlib-axis-* 类：轴类集合由现存类推出，不由映射表推出
  // ——data-mlib-axis 保持唯一映射源（brief Step 1）。
  function stripAxisClasses(b, keep) {
    String(b.className || '').split(/\s+/).forEach(function (c) {
      if (c && c.indexOf(AXIS_CLASS_PREFIX) === 0 && c !== keep) b.classList.remove(c);
    });
  }

  // 开轴前若详情还开着，先回网格（页面 closeDetail 复位详情视图 + detail-open 类 + 滚动）。
  function page() { return window.stellaMlibPage || null; }

  function ensureDetailClosed() {
    if (!hasBodyClass('mlib-detail-open')) return;
    var p = page();
    if (p && typeof p.closeDetail === 'function') p.closeDetail();
    else {
      var b = bodyEl();
      if (b) b.classList.remove('mlib-detail-open');
    }
  }

  // ---------- 公开面（vm 直调面，brief Interfaces：window.mlibOpenAxis / window.mlibClose） ----------

  // 只接受 data-mlib-axis 的词法（不建白名单表）
  function validAxis(raw) {
    var a = String(raw == null ? '' : raw).trim();
    return /^[a-z][a-z0-9-]*$/.test(a) ? a : '';
  }

  // 开轴的实体＝不带幂等闸的那一份：**每次「开」都在这里 seq+=1 并落壳类**。
  // mlibOpenAxis 放行后走它，状态盒 retry 也走它——retry 必须绕开闸（错误态下已 active 且同轴），
  // 但绝不能绕开代数：不 bump 的话，让位途中重读成功也会被上一枚 420 离场 timer 把层摘没。
  function forceOpenAxis(raw) {
    var a = validAxis(raw);
    if (!a) return null;
    var b = bodyEl();
    if (!b) return null;
    var axisClass = AXIS_CLASS_PREFIX + a;
    seq += 1;
    ensureDetailClosed();
    // 壳类先落（摘 leaving/其余轴类→置 active+目标轴）；页面层 markActive 再做一遍是同一真相源，无双写冲突。
    b.classList.remove('mlib-leaving');
    stripAxisClasses(b, axisClass);
    b.classList.add('mlib-active', axisClass);
    var p = page();
    if (p && typeof p.openAxis === 'function') {
      try { return p.openAxis(a) || null; } catch (e) { return null; } // 页面内部兜底，本层只保证不抛
    }
    return null;
  }

  window.mlibOpenAxis = function (axis) {
    var a = validAxis(axis);
    if (!a) return null;
    var b = bodyEl();
    if (!b) return null;
    var axisClass = AXIS_CLASS_PREFIX + a;
    // 幂等（brief Step 1）：已开且停在同轴（且不在 leaving）→ 直接返回，不重放入场动画。
    // leaving 期间同轴再点＝复活，必须放行。
    if (b.classList.contains('mlib-active') && b.classList.contains(axisClass) && !b.classList.contains('mlib-leaving')) return null;
    return forceOpenAxis(a);
  };

  window.mlibClose = function () {
    seq += 1;
    // 批D：关库前先把详情（含弹窗）复位，否则 mask 的 .show 浮在首页上。
    // 位置必须**先于** p.close()：close() 会 clearGrid() 清掉网格 payload，而 closeDetail() 里的
    // detailPayload.clear() 与 repaintDirtyGrid() 还要读现挂的轴类；顺序倒了就是「详情清理读到空网格」。
    // ESC 那一级本来就调 closeDetail（见上面的键盘分派），这里不重复挂。
    ensureDetailClosed();
    var my = seq;
    var b = bodyEl();
    var active = !!(b && b.classList.contains('mlib-active'));
    if (active) b.classList.add('mlib-leaving'); // 先置 leaving，CSS 才有东西可动
    var p = page();
    if (p && typeof p.close === 'function') {
      try { p.close(); } catch (e) { /* 页面 close 缺席/抛错不拦本层复位 */ }
    }
    if (!active) {
      // 未开：无动画可播，立即复位残留（不置 leaving、不排 timer）。
      leaveCleanup();
      return;
    }
    var timerFn = window.__mlibTimer || window.setTimeout;
    if (typeof timerFn !== 'function') { leaveCleanup(); return; }
    timerFn(function () { if (my === seq) leaveCleanup(); }, LEAVE_MS);
  };

  // 420ms 后摘 active/leaving/detail-open（轴类一并摘净，不留尸体类）。aria-hidden 归页面层。
  function leaveCleanup() {
    var b = bodyEl();
    if (!b || !b.classList) return;
    b.classList.remove('mlib-active', 'mlib-leaving', 'mlib-detail-open');
    stripAxisClasses(b, null);
  }

  // ---------- 入口：document 上的一枚 click 委托（三卡开轴 + 状态盒动作钮共用） ----------

  // 当前轴一律从 body 现挂的 mlib-axis-* 推出（真相源），绝不缓存变量：
  // 切轴/关闭后缓存会指错轴，retry 就会重读一条没在看的轴。
  function currentAxis() {
    var b = bodyEl();
    if (!b) return '';
    var found = '';
    String(b.className || '').split(/\s+/).some(function (c) {
      if (c && c.indexOf(AXIS_CLASS_PREFIX) === 0) { found = c.slice(AXIS_CLASS_PREFIX.length); return true; }
      return false;
    });
    return found;
  }

  // 状态盒动作钮（08-mlib-page.js 的 fillStateBox 每次空态/错误态都重渲 → 必须委托，绝不逐钮挂监听）。
  // 闸＝mlib-active：这两个钮只存在于已展开的资料库里，关着时一律静默；
  // 不需要 video-home-collapsed 闸——影视态收起的是首页卡，资料库内的状态盒与它不同源（收起时资料库本就不在画面入口）。
  function runStateAction(node) {
    if (!hasBodyClass('mlib-active')) return;
    var action = node.getAttribute('data-mlib-action');
    if (action === ACTION_IMPORT) {
      // typeof 守卫：导入模块没加载时静默不响应（本层不假设任何跨批次全局存在）。
      // 同一条委托只注册一次 ⇒ 一次点击只可能走到这里一次；openPlatformPlaylistImport 自身也是幂等的
      // （只 add class + 置 open 标志），所以不存在「开两层弹窗」的通路。
      if (typeof window.openPlatformPlaylistImport === 'function') window.openPlatformPlaylistImport();
      return;
    }
    if (action !== ACTION_RETRY) return; // 未知 token：不猜语义
    // retry 的正确顺序＝先让读层缓存作废，再强制重读**当前轴**（轴名只从 body 现挂的 mlib-axis-* 取）。
    // 走 forceOpenAxis 而不是 window.mlibOpenAxis：错误态下 body 已 active 且停在同轴，
    // 幂等闸会把这种请求判成重复点击而整吞——retry 要的正是「同轴再来一次」。
    // 仍留在本层的开轴实体里，所以代数（seq）与壳类复位一并保住，页面层的 markActive 只是重复写同一真相源。
    var read = window.stellaMlibRead;
    if (read && typeof read.invalidate === 'function') read.invalidate();
    forceOpenAxis(currentAxis());
  }

  // ---------- 播放意图（Task 8）：同一条 click 委托的第三个分支，**不新增任何监听** ----------
  // 分工（F2 单一属主的延伸）：绑定层只解析「这一下点的是哪张卡/哪条轨的播放」，
  // 可播判定、payload 命中、track→song 映射、入队全在页面层（stellaMlibPage.playEntity/playTrack）。
  // 选择器只认页面已渲染出的既有类名/属性（08-mlib-page.js 的 buildCard/trackMoreButton/buildTrackRow），
  // 本层不给 DOM 新加属性，也不复制任何文案。
  var TRACK_ROW_SELECTOR = '.stella-mlib-track';   // 整行即播放入口（music-library.css:536 cursor:pointer）
  var CARD_ID_ATTR = 'data-mlib-id';               // 网格卡根上的实体 id（完整卡对象在页面 payload 里）
  var CARD_SELECTOR = '[' + CARD_ID_ATTR + ']';
  var TRACK_ID_ATTR = 'data-mlib-track-id';
  var CARD_PLAY_SELECTOR = '.stella-mlib-play-btn'; // hover 设备的封面角标钮
  var COVER_SELECTOR = '.stella-mlib-art';           // 触屏整封面即播（CSS 的 html:not(.stella-mlib-has-hover) 分支）；圆形头像不挂该类，走详情入口
  var OPENABLE_CLASS = 'is-openable';                // buildCard 给「能开二级详情」的卡点的类（Task 6 真相源）
  var HOVER_CLASS = 'stella-mlib-has-hover';         // 由页面层 syncHoverCapability 落在 html 根上

  // hover 能力从 html 根类读（页面层是唯一写者）：本层不重复 matchMedia 探测，两处判定必须同源。
  function hasHoverCap() {
    var root = document.documentElement;
    return !!(root && root.classList && root.classList.contains(HOVER_CLASS));
  }

  // 页面动作缺席/抛错都不越界：本层只回答「这是不是一次播放意图」，播放成不成归页面层。
  // playEntity 是 async（在途 getDetail）：这里不 await、不二次派发、不看返回值——
  // 一旦在绑定层读它，播放判定就搬回了事件层（那正是 F2 要避免的属主漂移）。
  function callPageAction(name, args) {
    var p = page();
    var fn = p && p[name];
    if (typeof fn !== 'function') return;
    var r;
    try {
      r = fn.apply(p, args);
    } catch (e) {
      return; // 页面层内部已自行兜底；本层只保证委托不抛
    }
    if (r && typeof r.catch === 'function') r.catch(function () { /* 同上：只防 unhandled rejection */ });
  }

  // 返回值＝「这一下已被解析成播放意图」，true 时短路后面的轴分支；一次点击只可能出一个意图。
  function runPlayIntent(t) {
    // 闸＝mlib-active：网格与详情都只在已展开的资料库里可见，关着时一律静默
    //（与 runStateAction 同一口径；直调页面 API 仍是测试面，闸在这条委托入口）。
    if (!hasBodyClass('mlib-active')) return false;
    var row = t.closest(TRACK_ROW_SELECTOR);
    if (row) {
      // 曲名/时长格子点出来的都是同一行：closest 命中行本体，轨 id 只从属性读（完整轨对象在页面 payload 里）。
      // 不可播行（matched:false）在这里照样打得通——「不可达」由页面层的 matched 代码闸保证
      //（disabled 在真浏览器里不派发 click，但触屏与假 DOM 会送到这里，所以代码闸才是唯一真相源）。
      callPageAction('playTrack', [row.getAttribute(TRACK_ID_ATTR)]);
      return true;
    }
    var card = t.closest(CARD_SELECTOR);
    if (!card) return false;
    var id = card.getAttribute(CARD_ID_ATTR);
    var isPlayBtn = !!t.closest(CARD_PLAY_SELECTOR);
    // 触屏模（无 hover 能力）下圆形角标钮被 CSS display:none 摘掉，整张封面才是播放入口；
    // hover 模则只有角标钮算播放——封面/文案区是「进二级详情」的入口（C1：此前指针死区）。
    var isTouchCover = !hasHoverCap() && !!t.closest(COVER_SELECTOR);
    // 意图互斥（同一次点击只出一个）：播放优先于详情——命中播放钮/触屏封面就是播一张，绝不顺手开详情。
    if (isPlayBtn || isTouchCover) {
      // 轴名一律从 body 现挂的 mlib-axis-* 取（真相源）：卡上只有实体 id，没有轴。
      callPageAction('playEntity', [currentAxis(), id]);
      return true;
    }
    // 既不是播放钮也不是触屏封面 → 二级详情入口。is-openable 是「这张卡能开详情」的唯一真相源，
    // 与 buildCard 同一判据（三轴都有详情方法＝卡都带 is-openable；类缺席＝不可开＝这里不响应）。
    // 详情/可播的代码闸归页面层（openDetail 自己有 requestSeq 作废），本层只按已渲染的类决定是否路由。
    if (card.classList.contains(OPENABLE_CLASS)) {
      callPageAction('openDetail', [currentAxis(), id]);
      return true;
    }
    return false;
  }

  // ---------- 弹窗 chrome（批D）：关闭 / 遮罩 / 整单播放 / 随机 / 展开简介 ----------
  // 仍是同一条 document click 委托：本模块从 04-shelf 起就是资料库事件面的唯一属主，
  // 参照库那侧 inline onclick + 各自 wrap addEventListener（07-album-detail.js:809-853）不照搬。
  var MODAL_MASK_SELECTOR = '#mlib-detail-modal';
  var MODAL_CLOSE_SELECTOR = '[data-mlib-modal-close]';
  var MODAL_PLAY_SELECTOR = '[data-mlib-modal-play]';
  var MODAL_SHUFFLE_SELECTOR = '[data-mlib-modal-shuffle]';
  var MODAL_DESC_SELECTOR = '[data-mlib-modal-desc-toggle]';
  // 随机入口在参照库只长在 playlists 那条窗上（albums 窗压根没有这颗钮，07-album-detail.js:1049+）；
  // 本仓一窗承载两轴，隐藏交给 CSS（music-library.css:696
  // `body.mlib-axis-albums #mlib-detail-modal .stella-mlib-shuffle-btn{display:none}`）。
  // 代码闸读**同一条 body 轴类**：与 CSS 同源、可 grep，且不在本模块引入轴名字面量
  //（09 的轴名唯一映射源仍是 data-mlib-axis，见 mlib-bindings-contract ① 的源码守卫）。
  var MODAL_SHUFFLE_HIDDEN_AXIS_CLASS = 'mlib-axis-albums';

  function detailModal() {
    var m = window.stellaMlibDetailModal;
    return (m && typeof m.toggleDesc === 'function' && typeof m.isBusy === 'function') ? m : null;
  }

  // 整单播放拿的是「当前详情实体」，不是卡上的 data-mlib-id：弹窗底下的网格虽仍在（遮罩半透），
  // 但实体真相源只有页面层的 detailEntity（currentDetail()），属性面再塞一份就是第二个真相源。
  function currentDetailId() {
    var p = page();
    if (!p || typeof p.currentDetail !== 'function') return '';
    var d = p.currentDetail();
    return d && d.id != null ? String(d.id) : '';
  }

  function runModalChrome(t) {
    if (!hasBodyClass('mlib-detail-open')) return false;   // 真相源闸：详情没开一律静默
    var m = detailModal();
    if (t.closest(MODAL_DESC_SELECTOR)) { if (m) m.toggleDesc(); return true; }
    // 遮罩自身命中才算「点空白关闭」；窗口内任何子孙都走 closest 找不到 mask（el.matches 才判自身）
    if (t.closest(MODAL_CLOSE_SELECTOR) || (typeof t.matches === 'function' && t.matches(MODAL_MASK_SELECTOR))) {
      callPageAction('closeDetail', []);
      return true;
    }
    if (t.closest(MODAL_PLAY_SELECTOR)) {
      if (m && m.isBusy()) return true;                    // 参照库 743：进行中不重复入队
      var id = currentDetailId();
      if (id) callPageAction('playEntity', [currentAxis(), id]);
      return true;
    }
    if (t.closest(MODAL_SHUFFLE_SELECTOR)) {
      if (hasBodyClass(MODAL_SHUFFLE_HIDDEN_AXIS_CLASS)) return true; // albums 轴不放随机：命中也算已识别，但不发意图
      if (m && m.isBusy()) return true;
      var pid = currentDetailId();
      if (pid) callPageAction('playEntityShuffled', [currentAxis(), pid]);
      return true;
    }
    return false;
  }

  // ---------- 返回钮（C1）：#mlib-detail-back → closeDetail。仍是同一条 click 委托，不新增监听 ----------
  // 用**专用 id 选择器**而非 [data-mlib-action] 词汇：data-mlib-action 的 token 由读层 getStateCopy 给
  //（import/retry＝状态盒动作，与「返回」这种壳层 chrome 是两套词汇）；把返回塞进那套词汇就得让读层多吐一个
  // action token，改的是读层的动作契约。chrome 钮用固定 id 选择器，读层契约零改动。
  // 闸＝body.mlib-detail-open（真相源，非缓存标志）：返回钮只在详情视图里有意义，详情没开就静默。
  var DETAIL_BACK_SELECTOR = '#mlib-detail-back';

  function runDetailBack(t) {
    if (!t.closest(DETAIL_BACK_SELECTOR)) return false;
    if (!hasBodyClass('mlib-detail-open')) return true; // 命中返回钮但详情没开＝已识别为返回意图但无操作，不落到轴分支
    callPageAction('closeDetail', []);
    return true;
  }

  function onCardClick(e) {
    var t = e && e.target;
    if (!t || typeof t.closest !== 'function') return;
    // 先判状态盒动作钮：它在已展开的资料库内部，与首页卡入口是两条互不相干的轴。
    var actionNode = t.closest(ACTION_SELECTOR);
    if (actionNode) { runStateAction(actionNode); return; }
    // 再判播放/详情意图（同一条委托的第三个分支）：排在 video-home-collapsed 之前——资料库已展开时
    // 封面/曲目行在画面正中央，那个类收起的是首页卡，与资料库内的播放钮/详情入口不同源，不该把它一起吃掉。
    if (runPlayIntent(t)) return;
    // 批D：弹窗 chrome（关闭/遮罩/整单/随机/简介）——排在播放之后、返回钮之前：
    // 弹窗里的曲目行已被 TRACK_ROW_SELECTOR 那条分支吃掉，chrome 钮不得和行/卡抢顺序。
    if (runModalChrome(t)) return;
    // 返回钮（二级详情→网格）：详情视图里的 chrome，命中即 closeDetail；不在详情里＝无操作但仍算已识别。
    if (runDetailBack(t)) return;
    // 影视态专属 Home 收起（body.video-home-collapsed，index.css 此时本就隐藏首页）：
    // 闸在点击入口，不在 window.mlibOpenAxis 直调面。
    if (hasBodyClass('video-home-collapsed')) return;
    var card = t.closest(AXIS_SELECTOR);
    if (!card) return;
    window.mlibOpenAxis(card.getAttribute(AXIS_ATTR));
  }

  document.addEventListener('click', onCardClick);

  // ---------- ESC 两级：详情→网格→关闭。document capture 抢在 10-shell 冒泡链前；未开时完全让位 ----------
  // 为什么 capture 就够：keydown 的目标永远是页面里的元素（不可能是 document 自身），
  // 同一节点上 capture 恒早于 bubble ⇒ 早于 10-shell/01-viewport-resize-shortcuts.js:22（document 冒泡）
  // 与 10-shell/04-desktop-overlay-fullscreen.js:706（dock 元素冒泡）；stopPropagation 后它们再也收不到。

  function isEsc(e) { return !!e && (e.key === 'Escape' || e.code === 'Escape'); }

  // ---------- 激活键（F2）：Enter/Space 走的是**同一条** document keydown 监听、**同一套** click 优先级判定 ----------
  // 页面层给出的可聚焦面：08 buildCard 的卡根（tabIndex=0）与 buildTrackRow 的行（role=button tabindex=0）。
  // 判据一律复用 runPlayIntent，不复制第二份：行＝该行 playTrack，可开详情的卡＝openDetail。
  // 焦点落在真 <button>（含其内层图标）上一律让位：原生 Enter/Space 自己会补发一次 click，
  // 那条委托已经负责播放/详情——这里再走一遍就是双触发（同一次按键入队两次），所以先于判定摘掉。
  // 不可播的行/钮同样不响应：判据与 click 完全一致（可播性归页面层的代码闸，本层不设第二判据）。
  var NATIVE_BUTTON_SELECTOR = 'button';

  function isActivateKey(e) { return !!e && (e.key === 'Enter' || e.key === ' '); }

  function onActivateKey(e) {
    if (e && e.repeat) return; // R5：长按连发只认刚按下那一发（参照库 06-music-library.js:1238 同口径）——
    // 浏览器按住 Enter/Space 不放会按键盘重复率连发 keydown，不认这个标志就是把同一张卡/同一行连打 N 次。
    // 放在最前面（先于让位判定与分派）：这一档整段不消费事件，也不产生任何意图。
    var t = e && e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (t.closest(NATIVE_BUTTON_SELECTOR)) return; // 让位给原生激活随后那发 click
    // 闸与播放意图同在 runPlayIntent 入口（未开库一律静默），这里不重复设闸、也不另立优先级。
    if (runPlayIntent(t) && typeof e.preventDefault === 'function') {
      e.preventDefault(); // 命中的按键必须吃掉：Space 不拦就把整页滚走了
    }
  }

  function onKeydownCapture(e) {
    if (isEsc(e)) {
      if (!hasBodyClass('mlib-active')) return; // 资料库未开：不拦截、不消费，既有 ESC 链原样运行
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (hasBodyClass('mlib-detail-open')) {
        var p = page();
        if (p && typeof p.closeDetail === 'function') {
          try { p.closeDetail(); return; } catch (err) { /* fallthrough */ }
        }
        var b = bodyEl();
        if (b) b.classList.remove('mlib-detail-open');
        return;
      }
      window.mlibClose();
      return;
    }
    if (isActivateKey(e)) onActivateKey(e);
  }

  document.addEventListener('keydown', onKeydownCapture, true);
})();
