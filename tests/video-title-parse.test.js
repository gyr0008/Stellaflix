/*
 * tests/video-title-parse.test.js
 * 验证：播放电影《奥本海默》应解析为 query=奥本海默，而不是「电影《奥本海默」。
 * 运行：node tests/video-title-parse.test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost/',
  runScripts: 'dangerously',
  pretendToBeVisual: true
});
const win = dom.window;
win.eval(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'agent-video-tools.js'), 'utf8'));
win.eval(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'music-agent-command.js'), 'utf8'));

const cmd = win.StellaflixMusicAgentCommand;
assert(cmd && typeof cmd.parseVideoCommand === 'function', 'parseVideoCommand 未导出');

function check(msg, expectedQuery) {
  const parsed = cmd.parseVideoCommand(msg);
  assert(parsed && parsed.action === 'search_and_play_movie', msg + ' 应解析为搜片，得到 ' + JSON.stringify(parsed));
  assert(parsed.query === expectedQuery, msg + ' → query 应为「' + expectedQuery + '」，实际「' + parsed.query + '」');
}

check('播放电影《奥本海默》', '奥本海默');
check('播放《奥本海默》', '奥本海默');
check('播放电影奥本海默', '奥本海默');
check('我想看奥本海默', '奥本海默');
check('我想看《盗梦空间》', '盗梦空间');
check('播放电影《奥本海默》2023', '奥本海默');
assert(cmd.parseVideoCommand('播放电影《奥本海默》2023').year === '2023', '应识别年份 2023');

// 意图分流：歌曲不能被影视抢走
function expectVideo(msg, video) {
  const got = !!cmd.isVideoCommandIntent(msg);
  assert(got === video, msg + ' → isVideoCommandIntent 应为 ' + video + '，实际 ' + got);
}
expectVideo('播放周杰伦的东风破', false);
expectVideo('播放蔡健雅的Beautiful Love', false);
expectVideo('播放东风破', false);
expectVideo('想听周杰伦的晴天', false);
expectVideo('播放电影《奥本海默》', true);
expectVideo('播放电影奥本海默', true);
expectVideo('我想看奥本海默', true);
expectVideo('打开片源管理', true);
assert(!!cmd.isMusicIntent('播放周杰伦的东风破'), '歌曲应识别为音乐意图');
assert(!cmd.isMusicIntent('播放电影《奥本海默》'), '明确电影不应再走音乐');

// 解说过滤：title 命中；content 里偶发关键词不得误伤
win.StellaflixVideo = win.StellaflixVideo || {};
win.StellaflixVideo.sources = {
  getEnabledSources: () => [{ id: 's1', name: 'm', api: 'http://x/', enabled: true }],
  getSources: () => [{ id: 's1', name: 'm', api: 'http://x/', enabled: true }],
  search: async () => ({
    items: [
      { title: '奥本海默', year: '2023', typeName: '电影', content: '关于原子弹的剧情剪辑与历史盘点', variants: [{ sourceId: 's1', vodId: '1' }] },
      { title: '奥本海默电影解说', year: '2023', variants: [{ sourceId: 's1', vodId: '2' }] }
    ],
    errors: []
  })
};
win.StellaflixAgentVideoTools.search_movies({ query: '奥本海默' }).then((r) => {
  assert(r.ok === true, '应有正片: ' + JSON.stringify(r));
  assert(r.candidates.length === 1, '应只剩正片');
  assert(r.candidates[0].title === '奥本海默', '正片标题应为奥本海默');
  console.log('OK video-title-parse: all assertions passed');
  process.exit(0);
}).catch((e) => {
  console.error('FAIL', e && e.message ? e.message : e);
  process.exit(1);
});
