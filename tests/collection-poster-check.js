const { JSDOM } = require('C:\\Users\\Administrator\\.workbuddy\\binaries\\node\\workspace\\node_modules\\jsdom');
const fs = require('fs');
const path = require('path');

function freshWindow() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const window = dom.window;
  global.window = window;
  global.document = window.document;
  global.localStorage = window.localStorage;
  return window;
}

function evalFile(window, relPath) {
  const src = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
  window.eval(src);
}

(function testDetailPayloadFix() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'video', 'detail.js'), 'utf8');
  const hasPicPosterFallback = /poster:\s*view\.pic\s*\|\|\s*view\.poster\s*\|\|/.test(src);
  console.log('detail.js collectItemPayload 包含 pic||poster 回退:', hasPicPosterFallback);
  if (!hasPicPosterFallback) throw new Error('detail.js poster 回退未写入');
})();

(function testOnlineDetailResolvePicFix() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'video', 'online-detail.js'), 'utf8');
  const hasPosterFallback = /if \(it\.poster\) return it\.poster;/.test(src);
  console.log('online-detail.js resolvePic 包含 poster 回退:', hasPosterFallback);
  if (!hasPosterFallback) throw new Error('online-detail.js poster 回退未写入');
})();

(function testMineCardDelete() {
  const window = freshWindow();
  evalFile(window, 'public/video/collections.js');

  // jsdom 缺少 WAAPI animate
  window.Element.prototype.animate = function () { return { onfinish: null }; };
  window.confirm = function () { return true; }; // 自动确认，方便测试删除
  window.StellaflixVideo.online = { openDetailFromMeta: function () {} };
  window.StellaflixVideo.tmdb = {
    hasKey: function () { return false; },
    getMovieLogos: function () { return Promise.reject(); }
  };

  evalFile(window, 'public/video/page-collections.js');

  const SFV = window.StellaflixVideo;
  const folderId = SFV.collections.createUserFolder('测试片单');
  SFV.collections.addUserItem(folderId, {
    id: 'spider-001', mediaType: 'movie', title: '蜘蛛侠：崭新之日',
    poster: 'https://image.tmdb.org/t/p/w500/spider.jpg', year: '2026'
  });

  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  SFV.pageCollections.mount(host, {});
  SFV.pageCollections.renderGrid(host, 'mine');

  const card = host.querySelector('.sfv-plex-card');
  const delBtn = host.querySelector('.sfv-plex-card__del');
  console.log('我的片单卡片是否渲染删除按钮:', !!delBtn);
  console.log('删除按钮是否在卡片内:', card && card.contains(delBtn));
  if (!delBtn) throw new Error('我的片单卡片未渲染删除按钮');

  // 模拟点击删除
  delBtn.click();

  const itemsAfter = SFV.collections.getUserFolderItems(folderId);
  console.log('删除后片单内影片数:', itemsAfter.length);
  if (itemsAfter.length !== 0) throw new Error('点击删除按钮后影片未从片单移除');
})();

(function testBuildMovieCardPlaceholder() {
  const window = freshWindow();
  evalFile(window, 'public/video/collections.js');

  window.Element.prototype.animate = function () { return { onfinish: null }; };
  window.StellaflixVideo.online = { openDetailFromMeta: function () {} };
  window.StellaflixVideo.tmdb = {
    hasKey: function () { return false; },
    getMovieLogos: function () { return Promise.reject(); }
  };

  evalFile(window, 'public/video/page-collections.js');

  const SFV = window.StellaflixVideo;
  const folderId = SFV.collections.createUserFolder('测试片单2');
  SFV.collections.addUserItem(folderId, {
    id: 'no-poster', mediaType: 'movie', title: '无海报影片',
    poster: '', year: '2024'
  });

  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  SFV.pageCollections.mount(host, {});
  SFV.pageCollections.renderGrid(host, 'mine');

  const placeholder = host.querySelector('.sfv-plex-card-img--placeholder');
  console.log('无海报卡片是否渲染占位图:', !!placeholder);
  if (!placeholder) throw new Error('无海报卡片未渲染占位图');
})();

(function testOnlineCollectionsPlaceholder() {
  const window = freshWindow();
  evalFile(window, 'public/video/collections.js');

  window.StellaflixVideo.onlineShared = {
    setBrowseChrome: function () {},
    overlay: window.document.createElement('div'),
    titleEl: window.document.createElement('div'),
    bodyEl: window.document.createElement('div'),
    setNote: function () {},
    toast: function () {},
    el: function (tag, cls) {
      const n = window.document.createElement(tag);
      if (cls) n.className = cls;
      return n;
    },
    d: function () { return window.document; },
    openDetailFromMeta: function () {}
  };
  window.StellaflixVideo.tmdb = { hasKey: function () { return false; } };

  evalFile(window, 'public/video/online-collections.js');

  const S = window.StellaflixVideo.onlineShared;
  window.StellaflixVideo.onlineShared.renderCollectionItems({
    collTitle: '测试合集',
    collDef: { type: 'user-folder', folderId: null }
  });
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'video', 'online-collections.js'), 'utf8');
  const hasPlaceholder = /sfv-plex-card-img--placeholder/.test(src);
  console.log('online-collections.js 包含占位图分支:', hasPlaceholder);
  if (!hasPlaceholder) throw new Error('online-collections.js 占位图分支未写入');
})();

console.log('所有片单检查通过');
