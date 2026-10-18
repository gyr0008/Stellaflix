'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createLxSourceHost } = require('../lx-source-host')

const fixture = () => fs.readFileSync(path.join(__dirname, 'fixtures/lx-fake-source.js'), 'utf8')
const tmpUserData = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-lx-host-'))

// 隔离本机真实 lx-music-desktop LxDatas 自动迁移目录（若存在会污染回退链轮换/排除测试），
// 配合宿主侧惰性读取 env，保证测试封闭。
process.env.APPDATA = path.join(os.tmpdir(), 'sf-lx-host-isolated-appdata')
process.env.LOCALAPPDATA = process.env.APPDATA

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
  const host = createLxSourceHost({ userDataPath: tmpUserData() })
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
  const host = createLxSourceHost({ userDataPath: tmpUserData() })
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
