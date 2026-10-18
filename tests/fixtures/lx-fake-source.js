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
  lx.on('request', ({ action, source, quality, musicInfo, id }) => {
    if (action !== 'musicUrl') return
    lx.send('request', { id, data: { ok: true, url: 'https://fake.example/song.mp3', quality } })
  })
  lx.send('inited', { name: '假脚本', sources: { 'kg': { qualitys: ['128k', '320k', 'flac'] } } })
})()
