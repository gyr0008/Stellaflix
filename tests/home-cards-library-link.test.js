'use strict';

/**
 * 首页片库卡 ↔ 蜂窝墙选中卡连线
 * 运行：node --test tests/home-cards-library-link.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function loadHomeCards(store, model) {
  const sandbox = { console, Math, Number, Array, Object, String, Boolean, JSON };
  sandbox.window = sandbox;
  sandbox.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  sandbox.StellaflixVideo = {
    homeCore: { escAttr: (s) => String(s).replace(/"/g, '&quot;') },
    model: model || { getKeysByFlag: () => [] },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/home-cards.js'), sandbox, { filename: 'home-cards.js' });
  return sandbox.StellaflixVideo.homeCards;
}

function makeCard() {
  const art = { style: {}, classList: { add() {}, remove() {} } };
  return {
    art,
    querySelector(sel) { return sel === '.home-card-art' ? art : null; },
  };
}

test('setCardArt(lists)：优先展示蜂窝墙选中卡海报', () => {
  const store = {
    'stellaflix:library:lastPoster': JSON.stringify({ poster: 'https://img/p42.jpg', title: '歪心狼对阵ACME' }),
  };
  const HC = loadHomeCards(store);
  const card = makeCard();
  const pic = HC.setCardArt(card, 'lists');
  assert.equal(pic, 'https://img/p42.jpg');
  assert.match(card.art.style.backgroundImage, /p42\.jpg/);
});

test('setCardArt(lists)：无选中记录时回退旧 inList 逻辑', () => {
  const posterUrl = 'https://legacy/old.jpg';
  const model = {
    getKeysByFlag: (f) => (f === 'inList' ? ['k1'] : []),
    getMeta: () => ({ pic: posterUrl }),
    getHistory: () => [{ key: 'k1', ts: 5 }],
  };
  const HC = loadHomeCards({}, model);
  const card = makeCard();
  assert.equal(HC.setCardArt(card, 'lists'), posterUrl);
});

test('cardDefs LIBRARY 副标题：有选中卡时显示片名', () => {
  const store = {
    'stellaflix:library:lastPoster': JSON.stringify({ poster: 'https://img/p42.jpg', title: '歪心狼对阵ACME' }),
  };
  const HC = loadHomeCards(store);
  const lib = HC.cardDefs().find((c) => c.label === 'LIBRARY');
  assert.equal(lib.sub, '歪心狼对阵ACME');
});

test('cardDefs LIBRARY 副标题：无选中卡时保持原文案', () => {
  const HC = loadHomeCards({});
  const lib = HC.cardDefs().find((c) => c.label === 'LIBRARY');
  assert.match(lib.sub, /海报墙筹备中/);
});
