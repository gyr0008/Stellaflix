'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'public', rel), 'utf8');

// 逐字移植契约。id 清单按页拆：cover-wrap 只存在于标准页（reference
// mini-player-compact.html 没有封面 DOM，逐字移植不得凭空造 #cover-wrap），
// 其余 id + 本计划新增的 #close 两页都要有。brief Step 1 的 cover-wrap 断言
// 对极简页属于过度约束（与 reference 现实冲突），按 Task1 先例做契约校正。
const ID_CONTRACT = {
  'mini-player.html': ['cover-wrap', 'previous', 'play', 'next', 'desktop-lyrics', 'restore', 'close'],
  'mini-player-compact.html': ['previous', 'play', 'next', 'desktop-lyrics', 'restore', 'close'],
};

for (const page of ['mini-player.html', 'mini-player-compact.html']) {
  test(`${page} 移植契约：stellaflix 通道 + 无 mineradio 残留 + 关闭钮`, () => {
    const src = read(page);
    assert.ok(!/mineradio/i.test(src), '不得残留 mineradio 字样');
    assert.match(src, /window\.miniPlayer/);
    for (const id of ID_CONTRACT[page])
      assert.ok(src.includes(`id="${id}"`) || src.includes(`id='${id}'`), 'missing #' + id);
    assert.ok(src.includes("'close'") || src.includes('"close"'), 'close 命令接线');
  });
}
