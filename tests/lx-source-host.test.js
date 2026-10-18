'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createLxSourceHost, QUALITY_ALIASES, fallbackChainFor } = require('../lx-source-host')

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
