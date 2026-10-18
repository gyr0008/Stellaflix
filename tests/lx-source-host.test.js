'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createLxSourceHost } = require('../lx-source-host')

const fixture = () => fs.readFileSync(path.join(__dirname, 'fixtures/lx-fake-source.js'), 'utf8')
const tmpUserData = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-lx-host-'))

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
