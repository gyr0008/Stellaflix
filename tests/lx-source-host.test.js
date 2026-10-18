'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {
  createLxSourceHost, QUALITY_ALIASES, fallbackChainFor,
  normalizeImportSourceUrl, sourceUrlHttpFallback,
} = require('../lx-source-host')

const fixture = () => fs.readFileSync(path.join(__dirname, 'fixtures/lx-fake-source.js'), 'utf8')
const probeFixture = () => fs.readFileSync(path.join(__dirname, 'fixtures/lx-probe-source.js'), 'utf8')
const tmpUserData = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-lx-host-'))

// 隔离本机真实 lx-music-desktop LxDatas 自动迁移目录（若存在会污染回退链轮换/排除测试），
// 配合宿主侧惰性读取 env，保证测试封闭。
process.env.APPDATA = path.join(os.tmpdir(), 'sf-lx-host-isolated-appdata')
process.env.LOCALAPPDATA = process.env.APPDATA

// T3 起 resolveMusicUrl 会对候选 URL 发起探测（复用注入的 fetchImpl）。
// 既有用例统一注入离线桩：探测失败仅 advisory（上游 :1163-1184 语义），不改变断言，
// 同时避免 fake.example 真联网造成测试封闭性/速度问题。
const offlineFetch = async () => { throw new Error('LX_TEST_OFFLINE_FETCH') }

test('导入合规脚本后 listSources 含元数据且 source keys 过白名单', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData() })
  const { id, meta } = await host.importSource('假脚本', fixture())
  assert.equal(meta.name, '假脚本')
  const [row] = await host.listSources()
  assert.equal(row.id, id)
  assert.deepEqual(Object.keys(row.sources), ['kg'])
})

test('缺 lx.on(request) 的脚本报 LX_SOURCE_REQUEST_HANDLER_MISSING 且不落盘', async () => {
  const dir = tmpUserData()
  const host = createLxSourceHost({ userDataPath: dir })
  await assert.rejects(host.importSource('坏', 'lx.send("inited",{sources:{kg:{qualitys:["128k"]}}})'),
    /LX_SOURCE_REQUEST_HANDLER_MISSING/)
  assert.equal((await host.listSources()).length, 0)
})

test('10s 不 inited 报 LX_SOURCE_INIT_TIMEOUT（测试用注入时钟缩短）', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData(), initTimeoutMs: 50 })
  await assert.rejects(host.importSource('卡死', 'lx.on("request",()=>{})'), /LX_SOURCE_INIT_TIMEOUT/)
})

test('非白名单源键被过滤（上游 lx-source-host.js:511-514 语义）', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData() })
  await host.importSource('杂源', fixture().replace("'kg'", "'bogus'"))
  const [row] = await host.listSources()
  assert.deepEqual(Object.keys(row.sources), [])
})

test('当前脚本解析失败时惰性轮换其它已装脚本，成功 resolver 名回传', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData(), fetchImpl: offlineFetch })
  const bad = await host.importSource('坏脚本', fixture()
    .replace('@name 假脚本', '@name 坏脚本')
    .replace('song.mp3', '').replace(/ok: true/, 'ok: false'))
  const good = await host.importSource('好脚本', fixture())
  await host.selectSource(bad.id) // 让坏脚本成为 current
  const rows = host.listSources()
  const badName = rows.find(row => row.id === bad.id).name
  const goodName = rows.find(row => row.id === good.id).name
  assert.notEqual(badName, goodName) // 名字可区分才能证明轮换（brief 注：按 listSources 返回名对齐）
  const r = await host.resolveMusicUrl({ source: 'kg', quality: '320k', musicInfo: { kg: { mid: 'X' }, type: 'music', name: 't', singer: 's' } })
  assert.equal(r.ok, true)
  assert.equal(r.resolver, goodName)
  assert.equal(r.url, 'https://fake.example/song.mp3')
})

test('excludeResolvers 命中的脚本被跳过；全部排除报 LX_ALL_RESOLVERS_EXHAUSTED', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData() })
  const a = await host.importSource('A', fixture())
  await assert.rejects(host.resolveMusicUrl({ source: 'kg', quality: '128k',
    musicInfo: { type: 'music', name: 't', singer: 's' }, excludeResolvers: [a.id] }),
    /EXHAUSTED|没有可用于这首歌的音源/)
})

test('同参数 90s 内二次解析命中缓存不再执行脚本', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData(), fetchImpl: offlineFetch })
  await host.importSource('A', fixture())
  const q = { source: 'kg', quality: '128k', musicInfo: { type: 'music', name: 't', singer: 's' } }
  const r1 = await host.resolveMusicUrl(q)
  const r2 = await host.resolveMusicUrl(q)
  assert.equal(r2.url, r1.url)
  assert.equal(r1.cached, undefined)
  assert.equal(r2.cached, true)
})

test('maxResolvers=1 时仅尝试当前脚本，不轮换后备（上限链 :1110-1127 生效）', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData() })
  const bad = await host.importSource('坏脚本', fixture()
    .replace('@name 假脚本', '@name 坏脚本')
    .replace('song.mp3', '').replace(/ok: true/, 'ok: false'))
  await host.importSource('好脚本', fixture())
  await host.selectSource(bad.id)
  await assert.rejects(host.resolveMusicUrl({ source: 'kg', quality: '128k',
    musicInfo: { type: 'music', name: 't', singer: 's' }, maxResolvers: 1 }),
    /当前音源及备用音源均解析失败|EXHAUSTED/)
})

// —— T3：音质降级链 + Range 魔数探测 ——
// 桩 fetch 同时服务脚本沙箱与探测 Range 请求（同一 fetchImpl 注入，上游 :1012 electronFetch 位）。
// 探测响应按 URL 路由；未注册的 URL 直接抛错（探测失败=advisory，不影响 URL 返回）。
function probeResponse(bytes, status = 200) {
  const buffer = Uint8Array.from(bytes).buffer
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buffer,
  }
}
function probeStubFetch(routes) {
  return async (url) => {
    const entry = routes[String(url)]
    if (!entry) throw new Error('LX_TEST_FETCH_UNROUTED_' + String(url))
    return entry
  }
}
// ID3v2(size=0) + 0xFFFB 帧头（MPEG1 Layer III, bitrateIdx=9, sampleIdx=0）→ mp3 128k/44100
const MP3_128K_BYTES = [0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x00]
// 'fLaC' + STREAMINFO(0x80=last/type0,len16) @18-21: 96000Hz/2ch/24bit（上游 :1030-1037 解析位）
const FLAC_24BIT_BYTES = (() => {
  const b = new Array(32).fill(0)
  b[0] = 0x66; b[1] = 0x4c; b[2] = 0x61; b[3] = 0x43
  b[4] = 0x80; b[7] = 0x10
  b[18] = 0x17; b[19] = 0x70; b[20] = 0x05; b[21] = 0x70
  return b
})()
const probeMusicInfo = { type: 'music', name: 't', singer: 's' }
const probeNamed = (cn, hostTag) => probeFixture()
  .replace('@name 探针脚本', '@name ' + cn)
  .replace('https://probe.example/', 'https://' + hostTag + '.example/')

test('flac24bit 不被脚本支持时按降级链实发 flac，actual 回真实达成档', async () => {
  const host = createLxSourceHost({
    userDataPath: tmpUserData(),
    fetchImpl: probeStubFetch({ 'https://probe.example/flac': probeResponse(FLAC_24BIT_BYTES) }),
  })
  await host.importSource('探针脚本', probeFixture())
  const r = await host.resolveMusicUrl({ source: 'kg', quality: 'flac24bit', musicInfo: probeMusicInfo })
  assert.equal(r.ok, true)
  // 上游 :1067 把 flac 列入 flac24bit 别名表 → :1137-1146 门控判定脚本“可用”后
  // 仍按原变体名发请求，由脚本自降级并回报实际供档（本 fixture 模拟该行为：
  // 收到 flac24bit → 实际供 flac 档 URL）。
  assert.equal(r.requestedQuality, 'flac24bit')   // 降级链入口档保留
  assert.equal(r.url, 'https://probe.example/flac') // 降级链落点：脚本实际供档 flac
  assert.equal(r.probeWarning, '')
  assert.ok(r.actual, 'actual 需为探测结果对象')
  assert.equal(r.actual.codec, 'flac')            // actual 反映真实达成档
  assert.equal(r.actual.bitDepth, 24)
})

test('探测到 MP3 帧头但请求 flac：仍返回 URL 且 probeWarning=advisory，不跳下一 resolver', async () => {
  const host = createLxSourceHost({
    userDataPath: tmpUserData(),
    fetchImpl: probeStubFetch({ 'https://probe-a.example/flac': probeResponse(MP3_128K_BYTES) }),
  })
  const a = await host.importSource('主探针脚本', probeNamed('主探针脚本', 'probe-a'))
  await host.importSource('备探针脚本', probeNamed('备探针脚本', 'probe-b'))
  await host.selectSource(a.id)
  const r = await host.resolveMusicUrl({ source: 'kg', quality: 'flac', musicInfo: probeMusicInfo })
  assert.equal(r.ok, true)
  assert.equal(r.url, 'https://probe-a.example/flac') // advisory：静默降级的 URL 仍可用
  assert.equal(r.resolver, '主探针脚本')              // 未轮换到后备 resolver
  assert.equal(r.probeWarning, 'LX_AUDIO_QUALITY_DOWNGRADED_mp3_128000')
  assert.ok(r.actual && r.actual.codec === 'mp3')
})

test('探测 404：该候选作废，换下一候选/下一 resolver 继续（配合回退链）', async () => {
  const host = createLxSourceHost({
    userDataPath: tmpUserData(),
    fetchImpl: probeStubFetch({
      'https://probe-a.example/flac': probeResponse([], 404),   // 主脚本全部候选变体（含 320k/320K 拼写变体）404
      'https://probe-a.example/320k': probeResponse([], 404),
      'https://probe-a.example/320K': probeResponse([], 404),
      'https://probe-b.example/flac': probeResponse(FLAC_24BIT_BYTES),
    }),
  })
  const a = await host.importSource('主探针脚本', probeNamed('主探针脚本', 'probe-a'))
  await host.importSource('备探针脚本', probeNamed('备探针脚本', 'probe-b'))
  await host.selectSource(a.id)
  const r = await host.resolveMusicUrl({ source: 'kg', quality: 'flac', musicInfo: probeMusicInfo })
  assert.equal(r.ok, true)
  assert.equal(r.url, 'https://probe-b.example/flac') // 404 候选作废后轮换成功
  assert.equal(r.resolver, '备探针脚本')
  assert.equal(r.probeWarning, '')
})

test('QUALITY_ALIASES/fallbackChainFor 与上游 :1064-1084/:1092-1100 对齐', () => {
  assert.deepEqual(QUALITY_ALIASES.flac, ['flac', 'lossless', 'ape'])
  assert.deepEqual(QUALITY_ALIASES['320k'], ['320k', '320', '320K', 'high'])
  assert.deepEqual(fallbackChainFor('flac24bit'), ['flac24bit', 'hires', 'flac', '320k', '128k'])
  assert.deepEqual(fallbackChainFor('master'), ['master', 'flac24bit', 'hires', 'flac', '320k', '128k'])
  assert.deepEqual(fallbackChainFor('320k'), ['320k', '128k'])
  assert.deepEqual(fallbackChainFor('bogus'), ['bogus', 'flac', '320k', '128k']) // :1136 默认链
  fallbackChainFor('flac').push('polluted') // 回传副本，不共享内部表
  assert.deepEqual(fallbackChainFor('flac'), ['flac', '320k', '128k'])
})

// —— T4：URL/APIKEY 导入 + checkSources + 批量启停删除 ——
// 网络全部走 fetchImpl 注入桩（脚本沙箱/下载/探测共用同一注入点，上游 electronFetch 位）。
function makeFetchStub(routes) {
  const calls = []
  const fn = async (url) => {
    calls.push(String(url))
    const entry = routes[String(url)]
    if (entry instanceof Error) throw entry
    if (!entry) throw new Error('LX_TEST_FETCH_UNROUTED_' + String(url))
    return entry
  }
  fn.calls = calls
  return fn
}
// lxRequest(fetch 分支)消费 shape：ok/status + headers.forEach + arrayBuffer
function scriptResponse(text, status = 200) {
  const bytes = Uint8Array.from(Buffer.from(text, 'utf8'))
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: { forEach() {} },
    arrayBuffer: async () => bytes.buffer,
  }
}
const namedFixture = cn => fixture().replace('@name 假脚本', '@name ' + cn)
const badResolveFixture = () => namedFixture('坏脚本').replace('song.mp3', '').replace(/ok: true/, 'ok: false')
// 直接向存储追加一条「不 inited」坏记录（importSource 校验进不去，只能落盘注入）
function appendBrokenRecord(dir, id, script = 'lx.on("request",()=>{})') {
  const file = path.join(dir, 'sources', 'sources.json')
  const store = JSON.parse(fs.readFileSync(file, 'utf8'))
  store.records.push({ id, name: '坏体', version: '0.0.0', script, enabled: true })
  fs.writeFileSync(file, JSON.stringify(store), 'utf8')
}
const rotQuery = (tag, quality = '320k') => ({
  source: 'kg', quality, musicInfo: { type: 'music', name: 't', singer: 's', songmid: tag },
})

test('importSourceUrl(http URL)：fetchImpl 桩取回正文，走 importSource 校验入库', async () => {
  const stub = makeFetchStub({ 'https://script.test/pkg/y.js': scriptResponse(fixture()) })
  const host = createLxSourceHost({ userDataPath: tmpUserData(), fetchImpl: stub })
  const { id, meta } = await host.importSourceUrl('https://script.test/pkg/y.js')
  assert.deepEqual(stub.calls, ['https://script.test/pkg/y.js'])
  assert.ok(String(id).startsWith('stellaflix_'))
  assert.equal(meta.name, '假脚本') // 元数据来自 @name，fileName 仅兜底
  assert.equal(host.listSources().length, 1)
})

test('importSourceUrl(64-hex APIKEY)：展开为 ynx 端点再取（上游 :250-254 原样保留）', async () => {
  const key = '0123456789abcdef'.repeat(4)
  const expected = 'http://ynx.de5.net/API/lx-ynx.php?APIKEY=' + key
  const stub = makeFetchStub({ [expected]: scriptResponse(fixture()) })
  const host = createLxSourceHost({ userDataPath: tmpUserData(), fetchImpl: stub })
  const { id } = await host.importSourceUrl(key)
  assert.deepEqual(stub.calls, [expected])
  assert.ok(host.listSources().some(row => row.id === id))
})

test('ynx.de5.net https 输入直接降级 http 取回（:265-268 证书不匹配域官方绕行）', async () => {
  const stub = makeFetchStub({ 'http://ynx.de5.net/API/fetch.js': scriptResponse(fixture()) })
  const host = createLxSourceHost({ userDataPath: tmpUserData(), fetchImpl: stub })
  await host.importSourceUrl('https://ynx.de5.net/API/fetch.js')
  assert.deepEqual(stub.calls, ['http://ynx.de5.net/API/fetch.js'])
})

test('sourceUrlHttpFallback 证书降级判定（上游 :230-240，https+ynx+证书错误才回 http）', () => {
  assert.equal(sourceUrlHttpFallback('https://ynx.de5.net/API/a.js', new Error('certificate has expired')),
    'http://ynx.de5.net/API/a.js')
  assert.equal(sourceUrlHttpFallback('https://ynx.de5.net/API/a.js', { code: 'CERT_HAS_EXPIRED' }),
    'http://ynx.de5.net/API/a.js')
  assert.equal(sourceUrlHttpFallback('https://ynx.de5.net/API/a.js', new Error('ECONNRESET')), '')
  assert.equal(sourceUrlHttpFallback('https://other.test/a.js', new Error('CERT_HAS_EXPIRED')), '')
  assert.equal(sourceUrlHttpFallback('http://ynx.de5.net/a.js', new Error('CERT_HAS_EXPIRED')), '')
})

test('normalizeImportSourceUrl 非法输入报 LX_SOURCE_URL_INVALID（含 63hex/ftp/空）', () => {
  assert.throws(() => normalizeImportSourceUrl(''), /LX_SOURCE_URL_INVALID/)
  assert.throws(() => normalizeImportSourceUrl('not a url'), /LX_SOURCE_URL_INVALID/)
  assert.throws(() => normalizeImportSourceUrl('ftp://x.test/a.js'), /LX_SOURCE_URL_INVALID/)
  assert.throws(() => normalizeImportSourceUrl('0123456789abcdef'.repeat(4).slice(1)), /LX_SOURCE_URL_INVALID/)
  assert.equal(normalizeImportSourceUrl(' ynx.de5.net/API/a.js '), 'http://ynx.de5.net/API/a.js') // :255-257 裸域补协议
})

test('URL 导入失败（正文起不了沙箱）回滚：不入新记录、原激活不受影响', async () => {
  const dir = tmpUserData()
  const stub = makeFetchStub({
    'https://ok.test/a.js': scriptResponse(fixture()),
    'https://bad.test/b.js': scriptResponse('lx.on("request",()=>{})'), // 永不 inited
  })
  const host = createLxSourceHost({ userDataPath: dir, fetchImpl: stub, initTimeoutMs: 50 })
  const good = await host.importSourceUrl('https://ok.test/a.js')
  await assert.rejects(host.importSourceUrl('https://bad.test/b.js'), /LX_SOURCE_INIT_TIMEOUT/)
  const rows = host.listSources()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, good.id)
  assert.equal(rows[0].current, true)
  const r = await host.resolveMusicUrl(rotQuery('rbA1')) // 回滚后原链路仍可用
  assert.equal(r.ok, true)
})

test('下载脚本正文 5MB 上限 / 空正文 → LX_SOURCE_FILE_INVALID 且不入库（上游 :809）', async () => {
  const big = 'x'.repeat(5 * 1024 * 1024 + 1)
  const stub = makeFetchStub({
    'https://big.test/a.js': scriptResponse(big),
    'https://empty.test/a.js': scriptResponse(''),
  })
  const host = createLxSourceHost({ userDataPath: tmpUserData(), fetchImpl: stub })
  await assert.rejects(host.importSourceUrl('https://big.test/a.js'), /LX_SOURCE_FILE_INVALID/)
  await assert.rejects(host.importSourceUrl('https://empty.test/a.js'), /LX_SOURCE_FILE_INVALID/)
  assert.equal(host.listSources().length, 0)
})

test('checkSources 逐脚本起沙箱试跑：好脚本 ok:true+sources；坏体 ok:false+error；未知 id 不抛错', async () => {
  const dir = tmpUserData()
  const host = createLxSourceHost({ userDataPath: dir, initTimeoutMs: 40 })
  const a = await host.importSource('A', namedFixture('A'))
  const b = await host.importSource('B', namedFixture('B'))
  appendBrokenRecord(dir, 'broken-1') // 注册 handler 但永不 send inited
  const res = await host.checkSources([a.id, b.id, 'broken-1', 'ghost'])
  assert.equal(res.length, 4)
  assert.deepEqual(res.map(item => item.id), [a.id, b.id, 'broken-1', 'ghost'])
  assert.equal(res[0].ok, true)
  assert.deepEqual(res[0].sources, ['kg'])
  assert.equal(res[0].current, false)
  assert.equal(res[1].ok, true)
  assert.equal(res[2].ok, false)
  assert.match(res[2].error, /LX_SOURCE_INIT_TIMEOUT/)
  assert.equal(res[3].ok, false)
  assert.equal(res[3].error, 'LX_SOURCE_NOT_FOUND')
})

test('checkSources 单脚本封顶超时：外层超时先于 init 超时触发 LX_SOURCE_CHECK_TIMEOUT（默认 12s，注入点验证）', async () => {
  const dir = tmpUserData()
  const host = createLxSourceHost({ userDataPath: dir, initTimeoutMs: 20000, checkTimeoutMs: 30 })
  await host.importSource('A', namedFixture('A'))
  appendBrokenRecord(dir, 'broken-1')
  const [entry] = await host.checkSources(['broken-1'])
  assert.equal(entry.ok, false)
  assert.equal(entry.error, 'LX_SOURCE_CHECK_TIMEOUT')
})

test('checkSources 省略 ids 检查全部记录；显式空数组报 LX_SOURCE_IDS_REQUIRED', async () => {
  const dir = tmpUserData()
  const host = createLxSourceHost({ userDataPath: dir, initTimeoutMs: 40 })
  const a = await host.importSource('A', namedFixture('A'))
  appendBrokenRecord(dir, 'broken-1')
  const all = await host.checkSources()
  assert.equal(all.length, 2)
  assert.ok(all.some(item => item.id === a.id && item.ok === true))
  assert.ok(all.some(item => item.id === 'broken-1' && item.ok === false))
  await assert.rejects(host.checkSources([]), /LX_SOURCE_IDS_REQUIRED/)
})

test('setSourcesEnabled 批量停用：disabled 脚本不再被 resolveMusicUrl 轮换；重新启用恢复轮换', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData(), fetchImpl: offlineFetch })
  const bad = await host.importSource('坏脚本', badResolveFixture())
  const good = await host.importSource('好脚本', namedFixture('好脚本'))
  const sel = await host.selectSource(bad.id)
  assert.ok(Array.isArray(sel.installed)) // 上游 :616 返回 installed 快照
  const r1 = await host.resolveMusicUrl(rotQuery('rotA1'))
  assert.equal(r1.resolver, '好脚本') // 先坐实：good 在轮换后备集中，且已入 fallbackRuntimeCache
  const res = await host.setSourcesEnabled([good.id], false)
  assert.equal(res.ok, true)
  assert.equal(res.installed.find(row => row.id === good.id).enabled, false)
  await assert.rejects(host.resolveMusicUrl(rotQuery('rotA2')), /当前音源及备用音源均解析失败/)
  await host.setSourcesEnabled([good.id], true)
  const r3 = await host.resolveMusicUrl(rotQuery('rotA3'))
  assert.equal(r3.resolver, '好脚本') // 停用清缓存后惰性重建 runtime 恢复轮换
})

test('setSourcesEnabled 停用当前脚本时激活迁移到启用脚本；全停用被拒且不改存储', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData(), fetchImpl: offlineFetch })
  const a = await host.importSource('A', namedFixture('A'))
  const b = await host.importSource('B', namedFixture('B'))
  await host.selectSource(a.id)
  await host.setSourcesEnabled([a.id], false)
  const rows = host.listSources()
  assert.equal(rows.find(row => row.id === a.id).enabled, false)
  assert.equal(rows.find(row => row.id === b.id).current, true)
  await assert.rejects(host.setSourcesEnabled([a.id, b.id], false), /LX_SOURCE_AT_LEAST_ONE_ENABLED/)
  const after = host.listSources()
  assert.equal(after.find(row => row.id === a.id).enabled, false) // 抛错先于写盘，store 未动
  assert.equal(after.find(row => row.id === b.id).current, true)
})

test('setSourcesEnabled 入参校验：空 ids 报 LX_SOURCE_IDS_REQUIRED，未知 id 报 LX_SOURCE_NOT_FOUND', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData() })
  await assert.rejects(host.setSourcesEnabled([], true), /LX_SOURCE_IDS_REQUIRED/)
  await assert.rejects(host.setSourcesEnabled(['ghost'], true), /LX_SOURCE_NOT_FOUND/)
})

test('deleteSource 单删；删激活脚本时激活迁移并重写存储；未知 id 报错', async () => {
  const dir = tmpUserData()
  const host = createLxSourceHost({ userDataPath: dir, fetchImpl: offlineFetch })
  const a = await host.importSource('A', namedFixture('A'))
  const b = await host.importSource('B', namedFixture('B')) // b 为当前激活
  const res = await host.deleteSource(b.id)
  assert.equal(res.ok, true)
  assert.equal(res.installed.length, 1)
  const rows = host.listSources()
  assert.deepEqual(rows.map(row => row.id), [a.id])
  assert.equal(rows[0].current, true)
  await assert.rejects(host.deleteSource('ghost'), /LX_SOURCE_NOT_FOUND/)
})

test('deleteSources 批量删：fallbackRuntimeCache 随删清（缓存携带forward），全删后进未配置态', async () => {
  const dir = tmpUserData()
  const host = createLxSourceHost({ userDataPath: dir, fetchImpl: offlineFetch })
  const bad = await host.importSource('坏脚本', badResolveFixture())
  const good = await host.importSource('好脚本', namedFixture('好脚本'))
  await host.selectSource(bad.id)
  const r1 = await host.resolveMusicUrl(rotQuery('delA1'))
  assert.equal(r1.resolver, '好脚本') // 已惰性建 good 的 fallback runtime 缓存
  const res = await host.deleteSources([good.id])
  assert.equal(res.deleted, 1)
  await assert.rejects(host.resolveMusicUrl(rotQuery('delA2')), /当前音源及备用音源均解析失败/)
  const res2 = await host.deleteSources([bad.id])
  assert.equal(res2.ok, true)
  assert.equal(res2.name, '未配置')
  assert.deepEqual(res2.installed, [])
  assert.equal(host.listSources().length, 0)
  assert.equal(fs.existsSync(path.join(dir, 'sources', 'active-source.json')), false)
  // 无脚本态：activeScriptRecord 直接抛 LX_SOURCE_NOT_CONFIGURED（上游 :1087 前置 getRuntime 同款语义）
  await assert.rejects(host.resolveMusicUrl(rotQuery('delA3')), /LX_SOURCE_NOT_CONFIGURED/)
})

test('deleteSources 入参校验：空 ids 报 LX_SOURCE_DELETE_IDS_REQUIRED；含未知 id 整批拒绝且存储不动', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData() })
  const a = await host.importSource('A', namedFixture('A'))
  await assert.rejects(host.deleteSources([]), /LX_SOURCE_DELETE_IDS_REQUIRED/)
  await assert.rejects(host.deleteSources([a.id, 'ghost']), /LX_SOURCE_NOT_FOUND/)
  assert.deepEqual(host.listSources().map(row => row.id), [a.id])
})

test('脚本 id 防碰撞：连续导入生成互不相同的 stellaflix_ 前缀 id（T1 携带整改）', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData() })
  const ids = []
  for (let i = 0; i < 6; i += 1) {
    ids.push((await host.importSource('S' + i, namedFixture('S' + i))).id)
  }
  assert.equal(new Set(ids).size, 6)
  assert.ok(ids.every(id => /^stellaflix_\d+_[0-9a-f]+$/.test(id)))
})
