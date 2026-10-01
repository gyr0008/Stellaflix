'use strict';
/**
 * 汇联新页契约测：单注册源(id=discover)、mount 必设浏览态 chrome、
 * 非桌面环境降级（输入禁用+桌面版提示）、unmount 幂等。
 * 运行：node --test tests/huilian-page-contract.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadPage } = require('./helpers/huilian-harness');

test('注册且仅注册一个 id=discover 页面', () => {
  const { registrations } = loadPage({ bridge: null });
  assert.strictEqual(registrations.length, 1);
  assert.strictEqual(registrations[0].id, 'discover');
  assert.strictEqual(registrations[0].title, '汇联');
});

test('mount 调 setTitle(汇联) 且 setBrowseChrome(true)', () => {
  const { page, uiCalls, host } = loadPage({ bridge: null });
  page.mount(host);
  assert.deepStrictEqual(uiCalls, [['setTitle', '汇联'], ['setBrowseChrome', true]]);
});

test('非桌面：无桥 → 降级提示 + 输入区 disabled', () => {
  const { page, host, doc } = loadPage({ bridge: null });
  page.mount(host);
  const input = doc.querySelector('#huilian-input');
  const hint = doc.querySelector('.huilian-desk-only');
  assert.ok(hint, '缺少降级提示节点');
  assert.ok(hint.textContent.indexOf('桌面版') >= 0);
  assert.strictEqual(input.disabled, true);
});

test('桌面：有桥 → 输入可用且无降级提示', () => {
  const { page, host, doc, sandbox } = loadPage({ bridge: true });
  // I1 后 mount 会装 2s 轮询：本测只验渲染分支，桩掉真实定时器避免遗留活动句柄，末尾 unmount 收尾
  sandbox.setInterval = () => 1;
  sandbox.clearInterval = () => {};
  page.mount(host);
  assert.strictEqual(doc.querySelector('#huilian-input').disabled, false);
  assert.strictEqual(doc.querySelector('.huilian-desk-only'), null);
  page.unmount();
});
