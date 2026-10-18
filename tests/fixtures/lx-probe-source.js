/*
 * @name 探针脚本
 * @description probe fixture（T3：音质降级链+Range 魔数探测）
 * @version 1.0.0
 * @author test
 * @homepage https://example.invalid
 */
;(function () {
  if (typeof lx === 'undefined') return
  // 模拟真实 LX 脚本的自降级：宿主按上游 :1067 别名门控可能发来 flac24bit/hires，
  // 脚本只声明 128k/320k/flac，于是实际供档落回 flac，URL 以实际供档为键，
  // 便于桩 fetch 按 URL 路由探测字节。
  const OFFERED = { flac24bit: 'flac', hires: 'flac', master: 'flac', atmos: 'flac', atmos_plus: 'flac' }
  lx.on('request', ({ action, info }) => {
    if (action !== 'musicUrl') return
    const requested = String((info && (info.quality || info.type)) || '')
    const served = OFFERED[requested] || requested
    return { ok: true, url: 'https://probe.example/' + served, quality: served }
  })
  lx.send('inited', { name: '探针脚本', sources: { 'kg': { qualitys: ['128k', '320k', 'flac'] } } })
})()
