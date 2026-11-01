// tests/helpers/mlib-detail-boot.js —— 批D Task 3：资料库详情测试的共用 boot（仓里唯一一份 bootDetail）
// 起点＝tests/mlib-page-detail.test.js 原 bootDetail（真读层 + 真页面，只把 getDetail 换成固定返回）；
// 抽出时逻辑不动，只补 brief Step 4 的五件事（弹窗子树 mount、spy 弹窗层、withBindings 记账桩、
// playback 全局桩、scrollTop/delayMs/busy）。Task 3/4/5 都从这里取 boot，不得再各造别名。
// 假 DOM 三条脾气（helpers/mlib-fake-dom.js 头注释）：
//   · fire(target,type,extra) 只触发该节点自己的监听器（不冒泡）；document.addEventListener 的监听
//     存在 body.listeners 上 ⇒ 委托点击一律 f.click(node)＝fire(f.body,'click',{target:node})。
//   · innerHTML setter 只记字符串不解析 ⇒ 被断言的结构都在 SHELL/createElement 里。
//   · el.querySelector 只查后代不含自身命中 ⇒ 判自身命中用 el.matches。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createFakeDom, fire, SHELL } = require('./mlib-fake-dom');

const SHELF_DIR = path.join(__dirname, '..', '..', 'public', 'js', 'modules', '04-shelf');
const READ_SRC = fs.readFileSync(path.join(SHELF_DIR, '07-mlib-readlayer.js'), 'utf8');
const PAGE_SRC = fs.readFileSync(path.join(SHELF_DIR, '08-mlib-page.js'), 'utf8');
const BIND_SRC = fs.readFileSync(path.join(SHELF_DIR, '09-mlib-bindings.js'), 'utf8');
// realModal:true 的两段真模块（08-account 的弹窗开合工具＝沙箱无 gsap 时走 style 兜底；15＝Task 2 取色上半 + Task 4 弹窗下半）
const LOGIN_MODAL_UTILS_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'modules', '08-account', '01-login-modal-utils.js'), 'utf8');
const DETAIL_MODAL_SRC = fs.readFileSync(path.join(SHELF_DIR, '15-mlib-detail-modal.js'), 'utf8');

// 默认详情返回（bootDetail 未显式给 detail 时用）：形状＝读层 getDetail 契约，一轨一实体。
const DEFAULT_DETAIL = {
  entity: {
    id: 'AL1', title: '十一月的萧邦', sub: '周杰伦', cover: 'https://cdn/a.jpg',
    count: 1, playable: true, meta: { releaseYear: 2005 },
  },
  tracks: [{
    id: 't1', name: '夜曲', artist: '周杰伦', album: '十一月的萧邦',
    cover: 'https://cdn/1.jpg', duration: 250, matched: true,
  }],
  status: 'ok',
};

/**
 * bootDetail(opts) → f（createFakeDom 返回值上叠加下列字段）
 *   f.win / f.doc / f.body / f.html      沙箱与文档（sandbox.window 即 win）
 *   f.sc                                 #music-library-scroll（网格与全屏详情共用的滚动容器）
 *   f.modal                              弹窗层 spy：{ calls, lastAxis, info, status, tracksEl }（realModal:true 时不装）
 *   f.pageCalls                          页面层被调流水：[{ name, args }, …]（withBindings 记账桩写入）
 *   f.ids(sel)                           '#id' 走 getElementById，其它走 querySelector
 *   f.click(node)                        fire(f.body, 'click', { target: node })（委托监听宿主是 body）
 *   f.key(k)                             fire(f.body, 'keydown', …) 并记 f.prevented
 *   f.openAxis(axis) / f.closeLibrary()  调 window.mlibOpenAxis / window.mlibClose（需 withBindings）
 *   f.themeWrites                        mask 上「当前还活着」的主题变量表：setProperty 写入、removeProperty 删除
 *   f.detailCalls                        读层 getDetail 被调流水
 *   f.read / f.scroll / f.grid / f.gridView / f.head / f.tracks / f.row / f.rows / f.card
 *
 * opts：{ axis, scrollTop, delayMs, detail, axisData, realModal, withBindings, playback, detailId,
 *        detailOpen, active, busy, hover, mount, withoutQueueSong, play }
 */
function bootDetail(opts) {
  const options = opts || {};

  // 4. playback:true → 队列/起播全局桩（逐字照搬 tests/mlib-page-playback.test.js:50-70，含 withoutQueueSong 逃生门）
  const state = { queued: [], next: [], imports: 0, playCalls: [] };
  const globals = {};
  if (options.playback) {
    globals.queueSong = function (song, qo) { state.queued.push({ song, opts: qo === undefined ? null : qo }); return state.queued.length - 1; };
    globals.queueSongNext = function (song) { state.next.push(song); return state.queued.length; };
    globals.openPlatformPlaylistImport = function () { state.imports += 1; };
    if (options.withoutQueueSong) delete globals.queueSong;
    // 「立即播放」入口桩：仅显式要才注入（缺席时页面层 typeof 守卫必须静默）
    if (options.play) {
      globals.playQueueAt = function (idx, po) { state.playCalls.push({ idx, opts: po === undefined ? null : po }); return true; };
    }
  }

  // 1. mount 用扩展后的 SHELL（弹窗子树已在其中）
  const fake = createFakeDom({ hover: options.hover, mount: options.mount || SHELL, globals });
  const { win, doc } = fake;

  // 壳层真相源 body 类（09 的 currentAxis() 唯一真相源）；active:false 只摘 mlib-active
  if (options.axis) {
    doc.body.classList.add('mlib-active', 'mlib-axis-' + options.axis);
    if (options.active === false) doc.body.classList.remove('mlib-active');
  }
  // detailOpen：真相源类预挂（Task 5 验 ESC/返回钮的闸），currentDetail 桩在页面装载后补
  if (options.detailOpen) doc.body.classList.add('mlib-detail-open');

  fake.state = state;
  fake.pageCalls = [];

  // 真读层 + 真页面（与既有 bootDetail 同一加载序）
  win.loadScript(READ_SRC, '07-mlib-readlayer.js');
  if (options.axisData) {
    win.stellaMlibRead.getAxisData = async () => options.axisData;
  }
  fake.detailCalls = [];
  win.stellaMlibRead.getDetail = async function (axis, id) {
    fake.detailCalls.push({ axis, id });
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs)); // 测在途作废
    const detail = typeof options.detail === 'function'
      ? await options.detail(axis, id)
      : (options.detail === undefined ? DEFAULT_DETAIL : options.detail);
    return detail;
  };
  win.loadScript(PAGE_SRC, '08-mlib-page.js');

  // realModal:true → 不装 spy，加载真模块两段（15 当前只有取色上半＝stellaMlibDetailModal 缺席，
  // 恰好驱动 08 的降级闸；Task 4 落地后这段自动变真弹窗层）
  if (options.realModal) {
    win.loadScript(LOGIN_MODAL_UTILS_SRC, '01-login-modal-utils.js');
    win.loadScript(DETAIL_MODAL_SRC, '15-mlib-detail-modal.js');
  } else {
    // 2. 默认装 spy 弹窗层覆盖真模块（Task 3 只验分流，不验渲染）
    // 面形状逐字按 brief Interfaces：{ isModalAxis, show, hide, skeleton, renderInfo, tracksEl,
    // setStatus, setBusy, isBusy, toggleDesc }（brief Step 4 的代码片段把 tracksEl 只挂在 modal 记账面上，
    // 少了窗口面这一条——08 的 detailModalLayer() 判据就认 tracksEl，这里按 Interfaces 形状补齐）。
    const modal = { calls: [], lastAxis: null, info: [], status: [], tracksEl: () => doc.getElementById('mlib-detail-modal-tracks') };
    win.stellaMlibDetailModal = {
      isModalAxis: (axis) => axis === 'albums' || axis === 'playlists',
      show(axis) { modal.calls.push('show'); modal.lastAxis = axis; },
      skeleton() { modal.calls.push('skeleton'); },
      renderInfo(axis, res) { modal.calls.push('renderInfo'); modal.info.push({ axis, res }); },
      tracksEl: modal.tracksEl,
      hide() { modal.calls.push('hide'); },
      setStatus(text, tone) { modal.calls.push('setStatus'); modal.status.push({ text, tone }); },
      setBusy(busy) { modal.calls.push('setBusy'); },
      isBusy: () => !!options.busy,                             // Task 5 的「进行中不重复入队」闸用桩打开
      toggleDesc() { modal.calls.push('toggleDesc'); },
      kickerLabel: (axis) => '本地曲库 · ' + axis,
    };
    fake.modal = modal;
  }

  // 5. 网格滚动预置（弹窗轴「不许动网格滚动」的反证）
  fake.sc = doc.getElementById('music-library-scroll');
  fake.sc.scrollTop = options.scrollTop == null ? 0 : options.scrollTop;

  // detailOpen 的 currentDetail 桩（不开 withBindings 时打在真页面面上；与 spy 的 form:'modal' 同口径）
  if (options.detailOpen && !options.withBindings) {
    win.stellaMlibPage.currentDetail = () => ({ axis: options.axis || '', id: options.detailId || '', form: 'modal' });
  }

  // 3. withBindings:true → 页面层整面换记账桩（closeDetail 顺手摘 mlib-detail-open：真相源复位归页面层，
  //    与既有 mlib-bindings-contract.test.js:79 同一口径），再加载真 09
  if (options.withBindings) {
    const pageCalls = fake.pageCalls;
    const record = (name) => function () {
      pageCalls.push({ name, args: Array.prototype.slice.call(arguments) });
    };
    win.stellaMlibPage = {
      openAxis: record('openAxis'),
      close: record('close'),
      openDetail: record('openDetail'),
      closeDetail: function () {
        pageCalls.push({ name: 'closeDetail', args: [] });
        win.document.body.classList.remove('mlib-detail-open');
      },
      playEntity: record('playEntity'),
      playTrack: record('playTrack'),
      playEntityShuffled: record('playEntityShuffled'),
      detailForm: function (axis) {
        pageCalls.push({ name: 'detailForm', args: [axis] });
        return axis === 'artists' ? 'page' : 'modal';
      },
      // Task 5 的整单播放拿实体 id 只认 currentDetail()，不读 DOM 属性
      currentDetail: function () {
        pageCalls.push({ name: 'currentDetail', args: [] });
        return options.detailOpen
          ? { axis: options.axis || '', id: options.detailId || '', form: 'modal' }
          : null;
      },
    };
    win.loadScript(BIND_SRC, '09-mlib-bindings.js');
  }

  // Task 4「空封面不写变量」/「关窗不残留」两条断言的记账面：mask 的 style 成对维护 themeWrites。
  // （15 的 clearTheme/applyThemeVars 只走 setProperty/removeProperty，这张表就是「当前还活着的主题变量」。）
  fake.themeWrites = Object.create(null);
  const modalMask = doc.getElementById('mlib-detail-modal');
  if (modalMask) {
    const themeWrites = fake.themeWrites;
    modalMask.style = {
      setProperty(name, value) { themeWrites[name] = value; },
      removeProperty(name) { delete themeWrites[name]; },
    };
  }

  // 便捷访问器（既有那份逐条保留 + brief 定的新面）
  fake.read = win.stellaMlibRead;
  fake.scroll = () => doc.getElementById('music-library-scroll');
  fake.grid = () => doc.getElementById('mlib-grid');
  fake.gridView = () => doc.getElementById('mlib-view-grid');
  fake.head = () => doc.getElementById('mlib-detail-head');
  fake.tracks = () => doc.getElementById('mlib-detail-tracks');
  fake.row = (id) => doc.querySelector('[data-mlib-track-id="' + id + '"]');
  fake.rows = () => doc.querySelectorAll('.stella-mlib-track');
  fake.card = (id) => doc.querySelector('[data-mlib-id="' + id + '"]');
  fake.ids = (sel) => (String(sel)[0] === '#'
    ? doc.getElementById(String(sel).slice(1))
    : doc.querySelector(String(sel)));
  fake.click = (node) => fire(fake.body, 'click', { target: node });
  fake.key = (k) => {
    fake.prevented = false;
    fire(fake.body, 'keydown', {
      key: k, code: k, target: fake.body,
      preventDefault() { fake.prevented = true; },
    });
  };
  fake.openAxis = (axis) => win.mlibOpenAxis(axis);
  fake.closeLibrary = () => win.mlibClose();
  return fake;
}

module.exports = { bootDetail, READ_SRC, PAGE_SRC, BIND_SRC, SHELL };
