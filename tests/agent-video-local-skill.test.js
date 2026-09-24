/*
 * tests/agent-video-local-skill.test.js
 * 验证：小M 影视本地无 API 技能 — 工具层 + 意图正则（不访问真实网络）。
 * 运行：node tests/agent-video-local-skill.test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

function freshWindow() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div class="music-agent-chat-log"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  return dom.window;
}

function evalFile(window, relPath) {
  const src = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
  window.eval(src);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  const win = freshWindow();
  global.window = win;
  global.document = win.document;

  const mockSources = [{ id: 's1', name: 'mock', api: 'http://x/', enabled: true }];
  const pickMain = (eps) => {
    if (!eps || !eps.length) return null;
    const main = eps.find((e) => /正片|完整版|高清|超清|中字|国语/i.test(e.name || '') && !/预告|片花|花絮/.test(e.name || ''));
    if (main) return main;
    const clean = eps.find((e) => !/预告|片花|花絮/.test(e.name || ''));
    return clean || eps[0];
  };

  win.StellaflixVideo = {
    state: { isVideo: () => true },
    sources: {
      getEnabledSources: () => [],
      getSources: () => [],
      search: async () => ({ items: [], errors: [], noSource: true }),
      detail: async () => ({ ok: false, plays: [], reason: 'no-source' }),
      pickMainEpisode: pickMain
    },
    player: {
      isOpen: () => true,
      getMeta: () => ({ title: '测试电影' }),
      getVideoEl: () => ({ paused: false, duration: 7200, currentTime: 0, play() {}, pause() {} }),
      togglePlay() {},
      playNextEpisode: () => true,
      playPrevEpisode: () => true,
      hasNextEpisode: () => true,
      hasPrevEpisode: () => true,
      toggleFullscreen() {}
    },
    playOrchestrator: {
      play: (view, ep) => {
        win.__played = { title: view.title, ep: ep && ep.name, url: ep && ep.url };
      }
    }
  };

  evalFile(win, 'public/js/agent-video-tools.js');
  const tools = win.StellaflixAgentVideoTools;
  assert(tools && typeof tools.search_and_play_movie === 'function', 'StellaflixAgentVideoTools 未导出');

  const noSource = await tools.search_and_play_movie({ query: '奥本海默' });
  assert(noSource && noSource.ok === false && noSource.error === 'NO_VIDEO_SOURCE', '无片源应返回 NO_VIDEO_SOURCE');

  const ctx = tools.get_video_context();
  assert(ctx.ok && ctx.playerOpen && ctx.currentTitle === '测试电影', 'get_video_context 应读到播放器');

  win.StellaflixVideo.sources.getEnabledSources = () => mockSources;
  win.StellaflixVideo.sources.getSources = () => mockSources;
  win.StellaflixVideo.sources.search = async () => ({
    items: [
      { title: '盗梦空间', year: '2010', variants: [{ sourceId: 's1', vodId: '1', sourceName: 'mock' }] },
      { title: '盗梦空间', year: '2014', variants: [{ sourceId: 's1', vodId: '2', sourceName: 'mock' }] }
    ],
    errors: []
  });
  const multi = await tools.search_and_play_movie({ query: '盗梦空间' });
  assert(multi.needsSelection === true && multi.candidates.length === 2, '多结果应 needsSelection');

  // 解说类结果必须被过滤，不得进入候选
  win.StellaflixVideo.sources.search = async () => ({
    items: [
      { title: '你的名字是玫瑰[电影解说]', year: '2019', typeName: '解说', variants: [{ sourceId: 's1', vodId: '10' }] },
      { title: '你的名字。[电影解说]', year: '2016', remarks: '电影解说', variants: [{ sourceId: 's1', vodId: '11' }] },
      { title: '三分钟看完你的名字', year: '2020', variants: [{ sourceId: 's1', vodId: '12' }] },
      { title: '你的名字。', year: '2016', typeName: '动画', variants: [{ sourceId: 's1', vodId: '13' }] }
    ],
    errors: []
  });
  const filtered = await tools.search_movies({ query: '你的名字' });
  assert(filtered.ok === true, '应有正片结果: ' + JSON.stringify(filtered));
  assert(filtered.candidates.length === 1, '应只剩 1 个正片候选');
  assert(filtered.candidates[0].title === '你的名字。', '正片标题不对: ' + filtered.candidates[0].title);
  assert(filtered.filteredCommentary >= 3, '应统计被过滤的解说条数');
  assert(!filtered.candidates.some((c) => /解说/.test(c.title || '')), '候选中不得含解说');

  // 全是解说时明确告知没有正片
  win.StellaflixVideo.sources.search = async () => ({
    items: [
      { title: '奥本海默电影解说', year: '2023', variants: [{ sourceId: 's1', vodId: '20' }] },
      { title: '5分钟看完奥本海默', year: '2023', variants: [{ sourceId: 's1', vodId: '21' }] }
    ],
    errors: []
  });
  const onlyCommentary = await tools.search_movies({ query: '奥本海默' });
  assert(onlyCommentary.ok === false && onlyCommentary.error === 'NOT_FOUND', '仅解说时应 NOT_FOUND');
  assert(/正片|解说/.test(onlyCommentary.message || ''), '仅解说提示应说明已过滤解说');

  win.StellaflixVideo.sources.search = async () => ({
    items: [
      { title: '盗梦空间', year: '2010', variants: [{ sourceId: 's1', vodId: '1', sourceName: 'mock' }] },
      { title: '盗梦空间', year: '2014', variants: [{ sourceId: 's1', vodId: '2', sourceName: 'mock' }] }
    ],
    errors: []
  });
  const multiAgain = await tools.search_and_play_movie({ query: '盗梦空间' });
  assert(multiAgain.needsSelection === true && multiAgain.candidates.length === 2, '多结果应 needsSelection');

  win.StellaflixVideo.sources.detail = async () => ({
    ok: true,
    vod: { title: '盗梦空间' },
    plays: [{ from: '默认', episodes: [{ name: '预告片', url: 'http://a/t.mp4', index: 0 }, { name: '正片', url: 'http://a/m.mp4', index: 1 }] }]
  });
  const played = await tools.play_movie_candidate({
    sourceId: 's1',
    vodId: '1',
    title: '盗梦空间',
    year: '2010'
  });
  assert(played.ok === true, '起播应成功: ' + JSON.stringify(played));
  assert(win.__played && win.__played.ep === '正片', '应跳过预告片播正片');

  const videoEl = {
    paused: false,
    duration: 7200,
    currentTime: 0,
    play() { this.paused = false; },
    pause() { this.paused = true; }
  };
  win.StellaflixVideo.player.getVideoEl = () => videoEl;
  win.StellaflixVideo.player.togglePlay = () => { videoEl.paused = !videoEl.paused; };
  const pausedResult = await tools.control_video_playback({ action: 'pause' });
  assert(pausedResult.ok && pausedResult.playing === false, '应能暂停视频: ' + JSON.stringify(pausedResult));

  const cmdSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'music-agent-command.js'), 'utf8');
  assert(/isVideoStrongIntent/.test(cmdSrc), 'music-agent-command 应包含 isVideoStrongIntent');
  assert(/isVideoCommandIntent/.test(cmdSrc), 'music-agent-command 应包含 isVideoCommandIntent');
  assert(/playVideoFromTool/.test(cmdSrc), '应接入 playVideoFromTool');
  assert(/agent-video-tools\.js/.test(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  ), 'index.html 应加载 agent-video-tools.js');

  const samples = [
    { text: '播放电影《奥本海默》', expectVideo: true },
    { text: '我想看星际穿越', expectVideo: true },
    { text: '下一集', expectVideo: true },
    { text: '播放周杰伦的晴天', expectVideo: false },
    { text: '音量调到 30', expectVideo: false }
  ];
  const strongRe = /(?:电影|影片|剧场版|纪录片|电视剧|剧集|连续剧|番剧|观影|影视)|(?:我想看|想看|看一?部|观看|去看)|(?:下一集|上一集|这一集|第\s*\d+\s*集|换一集)/;
  for (const s of samples) {
    const hit = strongRe.test(s.text);
    assert(hit === s.expectVideo, '意图判断不符: ' + s.text + ' => ' + hit);
  }

  console.log('OK agent-video-local-skill: all assertions passed');
}

run().catch((err) => {
  console.error('FAIL', err && err.message ? err.message : err);
  process.exit(1);
});
