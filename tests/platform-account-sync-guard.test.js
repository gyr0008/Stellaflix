'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const listenStats = fs.readFileSync(
  path.join(root, 'public', 'js', 'modules', '05-playback', '02-listen-stats.js'),
  'utf8'
);
const accountActions = fs.readFileSync(
  path.join(root, 'public', 'js', 'modules', '05-playback', '06-track-detail-lyrics-actions.js'),
  'utf8'
);
const playlistDetail = fs.readFileSync(
  path.join(root, 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'),
  'utf8'
);

assert(
  /snapshot\.provider\s*\|\|\s*snapshot\.sourceKey\s*\|\|\s*snapshot\.resolvedPlaybackProvider/.test(listenStats),
  'listen reports must follow the song account provider before a matched playback source'
);
assert(
  /body\.provider\s*\|\|\s*song\.provider\s*\|\|\s*song\.source\s*\|\|\s*song\.sourceKey\s*\|\|\s*song\.type\s*\|\|\s*song\.resolvedPlaybackProvider/.test(server),
  'the server must preserve account-provider affinity for listen reports'
);
assert(
  /fetch\('\/api\/listen\/report'/.test(listenStats)
    && /stellaflix-listen-rollup-v2/.test(listenStats)
    && /sessionId:\s*createListenSessionId\(\)/.test(listenStats),
  'local rollup and idempotent listen reporting must stay connected'
);

[
  '/api/spotify/song/like',
  '/api/spotify/playlist/add-song',
  '/api/qishui/song/like',
  '/api/qishui/playlist/add-song',
  '/api/qishui/song/comments',
  '/api/album/subscribe',
  '/api/playlist/subscribe',
  '/api/song/comments',
].forEach(endpoint => {
  assert(server.includes(endpoint), `server route missing: ${endpoint}`);
});

assert(
  /accountDurationSync:\s*'submitted_unverified'/.test(server)
    && /accountDurationSync:\s*'unsupported'/.test(server)
    && /PLATFORM_DURATION_WRITE_UNAVAILABLE/.test(server),
  'listen-time capability responses must not overstate platform support'
);
assert(
  /provider\s*\+\s*':'\s*\+\s*id/.test(accountActions),
  'liked-state identity must remain provider scoped'
);
assert(
  /\/api\/playlist\/subscribe/.test(playlistDetail),
  'netease cookie playlist subscribe stays wired until the T16 account batch retires it'
);
// 批 T15.5b：平台前缀的歌单写回/红心/评论消费方整体改道 lx-source，
// 官方路由本身仍留在 server.js（删除归 T16），所以这里只做负向钉桩。
assert(
  !/\/api\/spotify\/playlist\/collect/.test(playlistDetail)
    && !/\/api\/qishui\/playlist\/collect/.test(playlistDetail),
  'platform-prefixed playlist collect consumers must be retired from the frontend'
);
assert(
  !/apiJson\(\s*'\/api\/(kugou|spotify|qishui|qq)\/song\/like(?:\/check)?/.test(accountActions)
    && !/apiJson\(\s*'\/api\/song\/(like|comments)/.test(accountActions)
    && !/likeUrl:\s*'\/api\//.test(accountActions)
    && !/likeCheckUrl:\s*'\/api\//.test(accountActions),
  'official like/comment sync consumers must be gone; like state is a local stub'
);

console.log('[OK] Platform account actions, provider-affine listen reports, and truthful duration-sync boundaries are guarded.');
