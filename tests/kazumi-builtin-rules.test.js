/**
 * 内置 Kazumi 规则清单守卫测试
 *
 * 背景（务必读完再改本文件）：
 *  2026-10-01 首次「内置规则库」机制只有一条（骚火 SA），当晚该源实测不可用
 *  （四个域名全部 Cloudflare 522、且是 PY 规则没有 CMS10 形态）→ 被要求整体回滚。
 *  教训：内置的前提是「源真的能用」。
 *
 *  本次重建（netflixgc）的前置实测：
 *   - 搜索 110 条 / 7 线路 9~10 集
 *   - 抽样 14 部逐部走 详情→播放页→嗅探，14/14 拿到真实 m3u8 直链（HTTP 206）
 *   - 字段全部来自线上真实 DOM 实采，Schema.validate() PASS
 *
 * 因此本测试把「内置规则必须可用」的判据钉死：
 *   ① 清单非空、name 唯一
 *   ② 每条过 Schema.validate()
 *   ③ baseURL / searchURL 为绝对 http(s)（项目硬约定，buildSearchUrl 不拼 baseUrl）
 *   ④ xpath 查询字段非空，且不得出现全等 @class='x'（实际页面多是 class="a b"，
 *      全等会静默 0 结果 —— 这是接站最常见的翻车点）
 *   ⑤ 启动时自动注册开箱可用（幂等 + dismissed 后不再塞回）
 *
 * 跑法：node --test tests/kazumi-builtin-rules.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const BUILTIN_FILE = path.join(ROOT, 'public/video/kazumi-builtin-rules.js');
const INDEX_HTML = path.join(ROOT, 'public/index.html');
const SCHEMA_FILE = path.join(ROOT, 'public/video/kazumi/rule-schema.js');

// 需要参加「字段完整性」校验的 xpath 字段
const XPATH_FIELDS = ['searchList', 'searchName', 'searchResult', 'chapterRoads', 'chapterResult'];

function makeSandbox(rules, initialStore) {
  const store = Object.assign({}, initialStore || {});
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const sandbox = {
    console,
    localStorage,
    setTimeout,
    clearTimeout,
    kazumi: {
      _rules: (rules || []).slice(),
      listRules() { return this._rules.slice(); },
      importRule(input) {
        const arr = Array.isArray(input) ? input : [input];
        for (const r of arr) {
          if (!r || !r.name) { throw new Error('非法规则对象'); }
          const i = this._rules.findIndex((x) => x && x.name === r.name);
          if (i >= 0) { this._rules[i] = r; } else { this._rules.push(r); }
        }
      },
      removeRule(name) {
        const i = this._rules.findIndex((x) => x && x.name === name);
        if (i >= 0) { this._rules.splice(i, 1); }
      }
    }
  };
  const SFV = {};
  SFV.kazumi = sandbox.kazumi;
  sandbox.StellaflixVideo = SFV;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, SFV, store };
}

/**
 * 加载 rule-schema + 内置清单，返回 { SFV, store, sandbox }。
 * initialStore 用于跨沙箱复用 localStorage（验证 dismissed 的持久化）。
 */
function loadBuiltin(initialRules, initialStore) {
  const ctx = makeSandbox(initialRules, initialStore);
  vm.runInContext(fs.readFileSync(SCHEMA_FILE, 'utf8'), ctx.sandbox);
  vm.runInContext(fs.readFileSync(BUILTIN_FILE, 'utf8'), ctx.sandbox);
  return ctx;
}

function loadSchemaOnly() {
  const ctx = makeSandbox([]);
  vm.runInContext(fs.readFileSync(SCHEMA_FILE, 'utf8'), ctx.sandbox);
  return ctx.sandbox;
}

test('内置规则清单非空且 name 唯一', () => {
  const { SFV } = loadBuiltin();
  const rules = SFV.builtinRules;
  assert.ok(Array.isArray(rules) && rules.length > 0, '内置清单不能为空 —— 内置的前提是源真的能用');
  const names = rules.map((r) => r.name);
  assert.equal(new Set(names).size, names.length, '内置规则 name 必须唯一');
});

test('内置清单不要放在只读红线目录 public/video/kazumi/ 下', () => {
  const rel = path.relative(ROOT, BUILTIN_FILE).replace(/\\/g, '/');
  assert.ok(rel.indexOf('public/video/kazumi/') !== 0, '内置文件必须放在 kazumi 目录之外');
});

test('index.html 已引入内置清单，且位置在桥接层之后', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const scripts = html.match(/"video\/[^"]+\.js"/g) || [];
  const idxBuiltin = scripts.indexOf('"video/kazumi-builtin-rules.js"');
  assert.ok(idxBuiltin !== -1, 'index.html 未引入 video/kazumi-builtin-rules.js');
  const idxBridge = scripts.indexOf('"video/kazumi-bridge.js"');
  assert.ok(idxBridge !== -1, 'index.html 未引入 video/kazumi-bridge.js（基线断言）');
  assert.ok(idxBuiltin > idxBridge, '内置清单必须在桥接层之后加载，否则自动注册时 SFV.kazumi 还不存在');
});

test('每条内置规则都通过 Schema.validate()', () => {
  const sandbox = loadSchemaOnly();
  const { SFV } = loadBuiltin();
  // 注意：validate() 校验的是**规范化后**的规则（字段是 baseUrl 而非 JSON 里的 baseURL），
  // 必须先 fromJson() 归一，否则会误报「baseURL 不能为空」。
  for (const rule of SFV.builtinRules) {
    const normalized = sandbox.KazumiRuleSchema.fromJson(rule);
    const res = sandbox.KazumiRuleSchema.validate(normalized);
    assert.ok(res.valid, `内置规则[${rule.name}]未通过 Schema: ` + JSON.stringify(res.errors || res));
  }
});

test('baseURL / searchURL 必须是绝对 http(s)（buildSearchUrl 不拼 baseUrl）', () => {
  const { SFV } = loadBuiltin();
  for (const rule of SFV.builtinRules) {
    assert.match(rule.baseURL, /^https?:\/\//i, `规则[${rule.name}] baseURL 必须绝对 http(s)`);
    assert.match(rule.searchURL, /^https?:\/\//i, `规则[${rule.name}] searchURL 必须绝对 http(s)`);
  }
});

test('xpath 字段非空，且不得用全等 @class=（必须 contains，否则静默 0 结果）', () => {
  const { SFV } = loadBuiltin();
  for (const rule of SFV.builtinRules) {
    for (const f of XPATH_FIELDS) {
      const v = rule[f];
      assert.ok(typeof v === 'string' && v.trim().length > 0, `规则[${rule.name}] 字段 ${f} 不能为空`);
      assert.ok(
        !/@class\s*=\s*['"][^'"]*['"]/.test(v),
        `规则[${rule.name}] 的 ${f} 用了全等 @class=，页面 class 多为 "a b" 会导致静默 0 结果；请改用 contains(@class,'x')`
      );
    }
  }
});

test('内置清单必须包含 555dy 系三镜像，且每条的 host 自洽、searchList 是条目级收敛', () => {
  // 来源：用户 2026-10-01 指令「555有cms10格式吗？没有的就加进规则仓库」。
  // 前置实测（_scratch 脚本 probe-cms10.js）：三站 /api.php/provide/vod 对
  // ac=list&wd / ac=list&id / ac=detail / ac=search 四动作全部返
  // 200 + text/html + 5 字节「域名未授权」→ 站点后台关了 CMS10 采集口 → 无 CMS10 格式，
  // 只能走 Kazumi 规则通道。故这三条「没有 CMS10 也必须存在」。
  const { SFV } = loadBuiltin();
  const rules = SFV.builtinRules;

  const expected = [
    { name: '555dy系 · 555k31', host: 'https://www.555k31.com/' },
    { name: '555dy系 · 5k12', host: 'https://5k12.top/' },
    { name: '555dy系 · 5k20', host: 'https://www.5k20.top/' }
  ];
  const byName = {};
  for (const r of rules) { byName[r.name] = r; }

  for (const exp of expected) {
    const rule = byName[exp.name];
    assert.ok(rule, `内置清单缺少规则「${exp.name}」—— 555dy 无 CMS10 采集口，必须靠内置规则开箱可用`);
    assert.equal(rule.baseURL, exp.host, `规则[${exp.name}] baseURL 与约定的 ${exp.host} 不一致`);
    // host 自洽：searchURL 必须带自己域名的完整 host，防止复制粘贴漏改（这类 bug 会静默搜空）
    assert.ok(
      rule.searchURL.indexOf(new URL(exp.host).host) !== -1,
      `规则[${exp.name}] 的 searchURL「${rule.searchURL}」不含自身 host ${new URL(exp.host).host}，多半是 copy 其它站没改`
    );
    assert.equal(
      rule.searchURL.indexOf('m=vod-search') !== -1 && rule.searchURL.indexOf('@keyword') !== -1,
      true,
      `规则[${exp.name}] 的 searchURL 必须是真搜索口 index.php?m=vod-search&wd=@keyword`
    );
    // 555dy 搜索条目自身就是 <a class="module-poster-item">：
    // 用后代选择器（如 //a[@href]）取不到它自己 → 静默 0 结果；必须 self::a
    assert.equal(rule.searchResult, 'self::a', `规则[${exp.name}] searchResult 必须是 'self::a'`);
    // 收敛进真实结果区：行容器（module-items）包住条目（module-poster-item），
    // 只写行容器时引擎每条只取首个 name/link → 119 条被压成 15 条
    assert.ok(
      rule.searchList.indexOf('module-poster-items-base') !== -1 &&
      rule.searchList.indexOf('module-poster-item') !== -1,
      `规则[${exp.name}] searchList 未收敛到「结果行容器内的 module-poster-item 条目」（实测会 119→15）`
    );
    assert.ok(
      rule.chapterRoads.indexOf('module-play-list-content') !== -1 &&
      rule.chapterResult.indexOf('module-play-list-link') !== -1,
      `规则[${exp.name}] 章节 xpath 不是 555dy 真实 DOM（module-play-list-content/link）`
    );
  }
});

test('启动自动注册：开箱即用，且幂等（重复调用不重复注册）', () => {
  const { SFV, sandbox } = loadBuiltin();
  assert.ok(SFV.builtinRules.length > 0, '前置：清单非空');
  // 文件加载末尾已自动 installAll()
  assert.ok(sandbox.kazumi.listRules().length > 0, '自动注册后本地规则列表应含内置规则');
  const names = sandbox.kazumi.listRules().map((r) => r.name);
  for (const r of SFV.builtinRules) {
    assert.ok(names.indexOf(r.name) !== -1, `内置规则[${r.name}] 未自动注册（开箱不可用）`);
  }
  // 幂等
  SFV.installBuiltinRules();
  SFV.installBuiltinRules();
  assert.equal(sandbox.kazumi.listRules().length, names.length, '重复注册不应产生重复条目');
});

test('dismissed：用户移除后不再自动塞回，且面板可查询', () => {
  const first = loadBuiltin();
  const { SFV, store } = first;
  assert.ok(SFV.builtinRules.length > 0, '前置：清单非空');
  const target = SFV.builtinRules[0].name;

  SFV.dismissBuiltinRule(target);
  assert.equal(SFV.isBuiltinDismissed(target), true, 'dismiss 后应查询到已移除标记');

  // 走一遍完整的「重新加载 → 自动注册」：已 dismissed 的不应再写回（复用同一 localStorage）
  const again = loadBuiltin([], store);
  assert.equal(again.SFV.isBuiltinDismissed(target), true, 'dismiss 标记应持久化到 localStorage');
  const names = again.sandbox.kazumi.listRules().map((r) => r.name);
  assert.equal(names.indexOf(target), -1, '已移除的内置规则不应再次自动注册');
});

test('面板层（fx-sources.js）对内置模块缺失有兜底，不会整页炸', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/video/fx-sources.js'), 'utf8');
  const hooks = [
    'SFV.getBuiltinRules',
    'SFV.isBuiltinInstalled',
    'SFV.isBuiltinDismissed',
    'SFV.installBuiltinRule',
    'SFV.dismissBuiltinRule'
  ];
  // 逐个 hook 检查「存在性判断」而非「每次调用都判空」：
  // 同一个 hook 常在一段里先判空（if (!SFV.x) throw）再裸调（SFV.x(name)），
  // 逐行断言必然假阳性。这里守住的是底线：整段里至少有一处判空，
  // 否则内置模块未加载（脚本被删/顺序错）时面板会直接 TypeError。
  for (const hook of hooks) {
    const used = src.indexOf(hook) !== -1;
    assert.ok(used, `fx-sources.js 应调用 ${hook}（基线断言）`);
    const guarded = src.split('\n').some((line) => {
      return line.indexOf(hook) !== -1 && /if\s*\(|&&|\?/.test(line);
    });
    assert.ok(guarded, `${hook} 在 fx-sources.js 里没有任何存在性判断（既无 if 也无 && 也无 ?:），内置模块缺失时会抛 TypeError`);
  }
});

test('负面对照：字段留空的占位规则过不了 Schema（守卫有牙齿）', () => {
  const sandbox = loadSchemaOnly();
  const placeholder = {
    api: '4', type: 'video', name: '占位规则（未实测）', version: '1.0',
    baseURL: 'https://example.invalid/',
    searchURL: 'https://example.invalid/search?wd=@keyword',
    searchList: '', searchName: '', searchResult: '',
    chapterRoads: '', chapterResult: '',
    searchMode: 'xpath', chapterMode: 'xpath'
  };
  const res = sandbox.KazumiRuleSchema.validate(sandbox.KazumiRuleSchema.fromJson(placeholder));
  assert.equal(res.valid, false, '空字段的占位规则必须被 Schema 挡下 —— 否则它就该被允许写进内置清单');
});
