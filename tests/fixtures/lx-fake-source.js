/*
 * @name 假脚本
 * @description fixture
 * @version 1.0.0
 * @author test
 * @homepage https://example.invalid
 */
;(function () {
  if (typeof lx === 'undefined') return
  lx.on('init', () => {
    lx.send('inited', {
      name: '假脚本', description: 'fixture', version: '1.0.0',
      sources: { kg: { qualitys: ['128k', '320k', 'flac'] } }
    })
  })
  lx.on('request', ({ action, info }) => {
    if (action !== 'musicUrl') return
    return { ok: true, url: 'https://fake.example/song.mp3', quality: info && info.quality }
  })
  lx.send('inited', { name: '假脚本', sources: { 'kg': { qualitys: ['128k', '320k', 'flac'] } } })
})()
