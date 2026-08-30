// 回归测试：第三方音源 rid 提取链路
//
// 背景（2026-08-29 修复）：
//   前端 songToLxMusicInfo() 曾把原生歌曲整体塞进 _raw，顶层只留 name/singer/album/interval，
//   而主进程 toLxMusicInfo() 直接读顶层字段提取 rid，导致 rid 取空、
//   音源脚本抛 "rid should not be empty"，custom-only 模式必然「找不到音源」。
//
// 本测试覆盖三条入口，确保任意一条都能取到非空 rid：
//   1. 原生 song → 前端转换 → 主进程（当前实际链路）
//   2. 旧 wire 格式（平台 ID 只在 _raw 里）→ 主进程（_raw 解包兜底）
//   3. 原生 song → 主进程（向后兼容）
//
// 前端函数直接从源码文本提取执行，避免测试与实现漂移。

const fs = require('node:fs');
const path = require('node:path');
const { toLxMusicInfo, platformKey, unwrapRawSong } = require('../desktop/custom-source/music-info');

const FRONTEND_FILE = path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '14-custom-source-integration.js');

// 从前端源码中提取 songToLxMusicInfo 的真实实现
function loadFrontendSongToLxMusicInfo() {
  const src = fs.readFileSync(FRONTEND_FILE, 'utf8');
  const start = src.indexOf('function songToLxMusicInfo');
  if (start < 0) throw new Error('未找到 songToLxMusicInfo，前端源码结构可能已变化');
  const end = src.indexOf('\n  }\n', start);
  if (end < 0) throw new Error('未找到 songToLxMusicInfo 结束边界');
  const body = src.slice(start, end + 4);
  // normalizePlaybackQuality 在前端是全局函数，这里注入等价桩
  const factory = new Function('normalizePlaybackQuality', body + '\nreturn songToLxMusicInfo;');
  return factory(q => String(q || 'hires'));
}

const songToLxMusicInfo = loadFrontendSongToLxMusicInfo();

// 复刻 bundled/qing_haitang_resolve.js:41-47 的 rid 契约
function scriptRid(musicInfo) {
  return musicInfo.hash
    ?? musicInfo.songmid
    ?? musicInfo.strMediaMid
    ?? musicInfo.id
    ?? (musicInfo.meta && (musicInfo.meta.strMediaMid ?? musicInfo.meta.id ?? musicInfo.meta.songId))
    ?? '';
}

const SAMPLES = [
  {
    label: 'QQ 音乐 (provider=qq)',
    song: {
      id: '001Qu4I30eVFYb', songmid: '001Qu4I30eVFYb', mid: '001Qu4I30eVFYb',
      mediaMid: '004Z8Ihr0JIu5s', strMediaMid: '004Z8Ihr0JIu5s', albumMid: '001VaGvL4HTgSK',
      name: '晴天', title: '晴天', artist: '周杰伦', artists: [{ name: '周杰伦' }],
      album: { name: '叶惠美' }, albumName: '叶惠美', duration: 269, provider: 'qq',
    },
    expectSource: 'tx',
  },
  {
    label: '网易云 (provider=netease)',
    song: { id: '186855', name: '起风了', artist: '买辣椒也用券', album: { name: '起风了' }, duration: 325000, provider: 'netease' },
    expectSource: 'wy',
  },
  {
    label: '酷狗 (provider=kugou)',
    song: { hash: 'A1B2C3D4E5F6', id: '1234567', name: '海阔天空', artist: 'Beyond', albumAudioId: '998877', duration: 326, provider: 'kugou' },
    expectSource: 'kg',
  },
  {
    label: '酷我 (provider=kuwo)',
    song: { rid: '98765432', name: '稻香', artist: '周杰伦', duration: 223, provider: 'kuwo' },
    expectSource: 'kw',
  },
  {
    label: '汽水音乐 (provider=qishui)',
    song: { id: '77889900', name: '诺言', artist: '陈柯宇', duration: 254, provider: 'qishui' },
    expectSource: 'tx',
  },
];

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  PASS  ' + label + (detail ? '  (' + detail + ')' : ''));
  } else {
    failed += 1;
    console.log('  FAIL  ' + label + (detail ? '  (' + detail + ')' : ''));
  }
}

console.log('=== 1. unwarpRawSong 解包 ===');
const wrapped = { name: '晴天', _raw: { provider: 'qq', songmid: 'SM001' } };
check('顶层缺失时回填 _raw', unwrapRawSong(wrapped).songmid === 'SM001');
check('顶层非空优先于 _raw', unwrapRawSong({ songmid: 'TOP', _raw: { songmid: 'INNER' } }).songmid === 'TOP');
check('无 _raw 时原样返回', unwrapRawSong({ provider: 'qq' }).provider === 'qq');
check('解包结果不含 _raw（幂等）', unwrapRawSong(unwrapRawSong(wrapped))._raw === undefined);

console.log('\n=== 2. 实际链路：原生 song → 前端转换 → 主进程 ===');
for (const sample of SAMPLES) {
  const wire = songToLxMusicInfo(sample.song, 'hires');
  const info = toLxMusicInfo(wire);
  const rid = scriptRid(info);
  check(sample.label, rid !== '' && info.source === sample.expectSource,
    'source=' + info.source + ' rid=' + JSON.stringify(rid));
}

console.log('\n=== 3. 兜底：旧 wire 格式（平台 ID 只在 _raw 里）→ 主进程 ===');
for (const sample of SAMPLES) {
  const legacyWire = {
    name: sample.song.name || sample.song.title || '',
    singer: String(sample.song.artist || ''),
    album: (sample.song.album && sample.song.album.name) || sample.song.albumName || '',
    interval: 0,
    _raw: sample.song,
    quality: 'hires',
  };
  const info = toLxMusicInfo(legacyWire);
  const rid = scriptRid(info);
  check(sample.label + ' [旧格式]', rid !== '', 'source=' + info.source + ' rid=' + JSON.stringify(rid));
}

console.log('\n=== 4. 向后兼容：原生 song 直接进主进程 ===');
for (const sample of SAMPLES) {
  const info = toLxMusicInfo(sample.song);
  const rid = scriptRid(info);
  check(sample.label + ' [原生]', rid !== '' && info.source === sample.expectSource,
    'source=' + info.source + ' rid=' + JSON.stringify(rid));
}

console.log('\n=== 5. 边界：无平台 ID 的未知歌曲 ===');
const anonymous = toLxMusicInfo({ name: '未知曲', singer: '未知歌手' });
check('不抛异常', typeof anonymous === 'object');
check('降级为 __any__', anonymous.source === '__any__', 'source=' + anonymous.source);

console.log('\n=== 6. platformKey 直接调用 ===');
check('识别 qq', platformKey({ provider: 'qq' }) === 'tx');
check('识别 netease', platformKey({ provider: 'netease' }) === 'wy');
check('识别 kugou', platformKey({ provider: 'kugou' }) === 'kg');
check('本地歌曲返回 null', platformKey({ provider: 'local' }) === null);
check('_raw 包裹下仍可识别', platformKey({ name: 'x', _raw: { provider: 'kugou' } }) === 'kg');

console.log('\n----------------------------------------');
console.log('PASS ' + passed + ' / FAIL ' + failed);
if (failed > 0) process.exit(1);
console.log('全部通过');
