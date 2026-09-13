const { JSDOM } = require('C:\\Users\\Administrator\\.workbuddy\\binaries\\node\\workspace\\node_modules\\jsdom');
const fs = require('fs');
const path = require('path');

const FX_SRC = path.join(__dirname, '..', 'public', 'video', 'fx-sources.js');

// 同步 MockFileReader：按文件名从预置内容表读取
class MockFileReader {
  readAsText(file) {
    const content = MockFileReader._store[file.name] != null ? MockFileReader._store[file.name] : '';
    this.result = content;
    if (this.onload) this.onload({ target: { result: content } });
  }
}

function defineFiles(input, arr) {
  Object.defineProperty(input, 'files', { configurable: true, value: arr });
}

function makeStore() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="fx-console-page-system"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const window = dom.window;
  const doc = window.document;

  // 片源内存存储（带去重，模拟 sources-core.addSource 行为）
  const sources = [];
  const sourcesApi = {
    getSources() { return sources.slice(); },
    addSource(input) {
      const api = String(input.api == null ? '' : input.api).trim();
      if (!api) return { ok: false, reason: 'empty-api' };
      let u;
      try { u = new window.URL(api); } catch (e) { return { ok: false, reason: 'invalid-api-url' }; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'unsupported-scheme:' + u.protocol };
      for (let i = 0; i < sources.length; i++) if (sources[i].api === u.href) return { ok: false, reason: 'duplicate-api' };
      const src = { id: 's' + sources.length, name: input.name || u.hostname, api: u.href, enabled: true };
      sources.push(src);
      return { ok: true, source: src };
    },
    removeSource() {}, setEnabled() {}, testSource() { return Promise.resolve({ ok: true, count: 1, ms: 10 }); },
  };

  // 规则导入：记录最后一次 importRule 入参
  let lastImported = null;
  const kazumiApi = {
    listRules() { return []; },
    importRule(data) { lastImported = data; return Array.isArray(data) ? data.length : 1; },
    removeRule() {}, setEnabled() {},
  };

  window.StellaflixVideo = { sources: sourcesApi, kazumi: kazumiApi };
  window.FileReader = MockFileReader;
  MockFileReader._store = {};

  const code = fs.readFileSync(FX_SRC, 'utf8');
  window.eval(code);
  // 若 boot() 因 document.readyState==='loading' 推迟了注入，这里手动触发一次
  // DOMContentLoaded；injectFolds 内置 injected 守卫，重复触发安全。
  try { window.document.dispatchEvent(new window.Event('DOMContentLoaded')); } catch (e) {}

  return { window, doc, sourcesApi, kazumiApi, getLastImported() { return lastImported; } };
}

(async () => {
  let pass = 0, fail = 0;
  function assert(cond, msg) {
    if (cond) { pass++; console.log('  ✓ ' + msg); }
    else { fail++; console.log('  ✗ ' + msg); }
  }
  const tick = () => new Promise(r => setTimeout(r, 30));

  // 场景1：CMS10 文本批量（含重复 + 非法 + 纯地址行）
  {
    const s = makeStore();
    const ta = s.doc.querySelector('.sfv-bulk-text');
    assert(!!ta, 'CMS10 面板存在批量文本框 .sfv-bulk-text');
    ta.value = [
      '我的片源,https://a.com/api.php/provide/vod',
      'https://b.com/api.php/provide/vod',
      '我的片源,https://a.com/api.php/provide/vod',
      'not-a-url',
      'https://c.com/api.php/provide/vod',
    ].join('\n');
    s.doc.querySelector('.sfv-bulk-add').click();
    await tick();
    const list = s.sourcesApi.getSources();
    assert(list.length === 3, '文本导入成功 3 条(a/b/c)，实际=' + list.length);
    const hintEl = s.doc.querySelector('.sfv-src-hint');
    const ok = /成功 3/.test(hintEl.textContent) && /重复跳过 1/.test(hintEl.textContent) && /格式错误 1/.test(hintEl.textContent);
    assert(ok, '汇总文案=成功3/重复1/错误1，实际=' + hintEl.textContent);
    const b = list.find(x => x.api.indexOf('b.com') !== -1);
    assert(b && b.name === 'b.com', '纯地址行名称自动取域名(b.com)，实际=' + (b && b.name));
    const a = list.find(x => x.api.indexOf('a.com') !== -1);
    assert(a && a.name === '我的片源', '名称+地址行名称保留，实际=' + (a && a.name));
  }

  // 场景2：CMS10 文件批量（.json 数组 + .txt 每行一条）
  {
    const s = makeStore();
    MockFileReader._store = {
      'list.json': JSON.stringify([{ name: 'f1', api: 'https://f1.com/x' }, { name: 'f2', api: 'https://f2.com/x' }]),
      'list.txt': 'https://t1.com/x\nhttps://t2.com/x',
    };
    const input = s.doc.querySelector('#sfv-bulk-file');
    defineFiles(input, [{ name: 'list.json' }, { name: 'list.txt' }]);
    input.dispatchEvent(new s.window.Event('change'));
    await tick();
    assert(s.sourcesApi.getSources().length === 4, '.json数组(2)+.txt(2) 共导入 4 条，实际=' + s.sourcesApi.getSources().length);
  }

  // 场景3：规则多选（.json 数组 + 单条对象）
  {
    const s = makeStore();
    MockFileReader._store = {
      'r1.json': JSON.stringify([{ name: 'ruleA' }, { name: 'ruleB' }]),
      'r2.json': JSON.stringify({ name: 'ruleC' }),
    };
    const input = s.doc.querySelector('#sfv-rule-file');
    defineFiles(input, [{ name: 'r1.json' }, { name: 'r2.json' }]);
    input.dispatchEvent(new s.window.Event('change'));
    await tick();
    const imported = s.getLastImported();
    assert(Array.isArray(imported) && imported.length === 3, '规则 importRule 收到合并数组长度 3，实际=' + (imported && imported.length));
  }

  // 场景4：规则单个数组文件
  {
    const s = makeStore();
    MockFileReader._store = { 'arr.json': JSON.stringify([{ name: 'x' }, { name: 'y' }]) };
    const input = s.doc.querySelector('#sfv-rule-file');
    defineFiles(input, [{ name: 'arr.json' }]);
    input.dispatchEvent(new s.window.Event('change'));
    await tick();
    const imported = s.getLastImported();
    assert(Array.isArray(imported) && imported.length === 2, '单数组文件 importRule 收到长度 2，实际=' + (imported && imported.length));
  }

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
