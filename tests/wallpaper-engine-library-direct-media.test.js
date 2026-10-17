'use strict';

// Stellaflix v2.1.4 "direct video/image media import" tests for
// desktop/wallpaper-engine-library.js, adapted from the upstream
// wallpaper-engine-library test suite (real temp dirs, node:test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  WallpaperEngineLibrary,
} = require('../desktop/wallpaper-engine-library');

function writeProject(dir, name, manifest, files) {
  const projectDir = path.join(dir, name);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(manifest), 'utf8');
  Object.entries(files || {}).forEach(([file, content]) => {
    const target = path.join(projectDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  });
  return projectDir;
}

function makeLibrary(temp) {
  return new WallpaperEngineLibrary({
    userDataPath: path.join(temp, 'user-data'),
    autoDiscover: false,
  });
}

function mediaRequest(id, token, range) {
  return {
    url: 'stellaflix-wallpaper://media/' + id + '?token=' + encodeURIComponent(token),
    method: 'GET',
    headers: { get: (name) => (String(name).toLowerCase() === 'range' ? (range || '') : '') },
  };
}

function responseBytes(response) {
  return response.arrayBuffer().then((buffer) => Buffer.from(buffer));
}

test('Wallpaper Engine 可直接导入 mp4 视频文件（无 project.json 也能播放）', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-we-media-'));
  const dir = path.join(temp, 'clips');
  fs.mkdirSync(dir, { recursive: true });
  const media = Buffer.from('stellaflix-mp4-payload-0123456789');
  const file = path.join(dir, 'my-loop.mp4');
  fs.writeFileSync(file, media);

  const library = makeLibrary(temp);
  assert.equal(typeof library.addManualMediaFile, 'function',
    'addManualMediaFile 应随直接导入功能一起提供');
  const snapshot = await library.addManualProjectFile(file);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.count, 1);
  const item = snapshot.projects[0];
  assert.equal(item.playable, true);
  assert.equal(item.mediaType, 'video');
  assert.equal(item.projectType, 'video');
  assert.equal(item.title, 'my-loop');
  assert.equal(item.direct, true);
  assert.equal(item.safetyMode, 'direct-media');

  const full = await library.mediaResponse(mediaRequest(item.id, snapshot.mediaToken));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.ok((await responseBytes(full)).equals(media));

  const partial = await library.mediaResponse(mediaRequest(item.id, snapshot.mediaToken, 'bytes=0-7'));
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 0-7/' + media.length);
  assert.equal((await responseBytes(partial)).toString('utf8'), media.subarray(0, 8).toString('utf8'));

  const denied = await library.mediaResponse(mediaRequest(item.id, 'deadbeef'));
  assert.equal(denied.status, 404);
  if (typeof library.dispose === 'function') library.dispose();
});

test('Wallpaper Engine 可直接导入 jpg 图片文件', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-we-image-'));
  fs.mkdirSync(path.join(temp, 'shots'), { recursive: true });
  const file = path.join(temp, 'shots', 'still.jpg');
  fs.writeFileSync(file, Buffer.alloc(64, 0xff));

  const library = makeLibrary(temp);
  const snapshot = await library.addManualProjectFile(file);
  assert.equal(snapshot.count, 1);
  const item = snapshot.projects[0];
  assert.equal(item.playable, true);
  assert.equal(item.mediaType, 'image');
  assert.equal(item.projectType, 'image');
  assert.equal(item.direct, true);
  assert.equal(item.safetyMode, 'direct-media');
  if (typeof library.dispose === 'function') library.dispose();
});

test('addManualMediaFile 持久化后新实例仍能重新索引同一媒体', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-we-persist-'));
  fs.mkdirSync(path.join(temp, 'clips'), { recursive: true });
  const file = path.join(temp, 'clips', 'loop.m4v');
  fs.writeFileSync(file, Buffer.from('payload'));

  const library = makeLibrary(temp);
  const snapshot = await library.addManualMediaFile(file);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.projects[0].direct, true);
  if (typeof library.dispose === 'function') library.dispose();

  const reloaded = makeLibrary(temp);
  const list = await reloaded.list({ force: true });
  assert.equal(list.count, 1);
  assert.equal(list.projects[0].title, 'loop');
  assert.equal(list.projects[0].safetyMode, 'direct-media');
  const summary = list.manualRoots.filter((entry) => entry.kind === 'media');
  assert.equal(summary.length, 1);
  assert.equal(summary[0].name, 'loop.m4v');
  if (typeof reloaded.dispose === 'function') reloaded.dispose();
});

test('直接导入的 mp4 没有 Scene 包与项目设置，但仍可读基本信息', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-we-direct-'));
  const file = path.join(temp, 'solo.mp4');
  fs.writeFileSync(file, Buffer.from('payload'));

  const library = makeLibrary(temp);
  const snapshot = await library.addManualProjectFile(file);
  const id = snapshot.projects[0].id;
  await assert.rejects(() => library.getNativeSceneTarget(id), /WALLPAPER_SCENE_NOT_FOUND/);
  const details = await library.getProjectDetails(id);
  assert.equal(details.ok, true);
  assert.equal(details.projectType, 'video');
  assert.equal(details.properties.length, 0);
  assert.equal(details.workshopId, '');
  if (typeof library.dispose === 'function') library.dispose();
});

test('移除手动导入的 mp4 会从索引与存档同时摘掉', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-we-remove-'));
  const file = path.join(temp, 'remove-me.webm');
  fs.writeFileSync(file, Buffer.from('payload'));

  const library = makeLibrary(temp);
  const snapshot = await library.addManualProjectFile(file);
  assert.equal(snapshot.count, 1);
  const mediaRoot = snapshot.manualRoots.find((entry) => entry.kind === 'media');
  assert.ok(mediaRoot, '手动导入的视频应在手动清单里以 media 条目出现');
  assert.equal(mediaRoot.name, 'remove-me.webm');

  const after = await library.removeManualRoot(mediaRoot.id);
  assert.equal(after.count, 0);
  assert.equal(after.manualRoots.filter((entry) => entry.kind === 'media').length, 0);
  if (typeof library.dispose === 'function') library.dispose();

  const reloaded = makeLibrary(temp);
  const list = await reloaded.list({ force: true });
  assert.equal(list.count, 0);
  assert.equal(list.manualRoots.length, 0);
  if (typeof reloaded.dispose === 'function') reloaded.dispose();
});

test('清单指向的媒体无法解析时，手动导入的视频接管为可播放条目', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-we-broken-'));
  const libraryRoot = path.join(temp, 'library');
  fs.mkdirSync(libraryRoot, { recursive: true });
  const projectDir = writeProject(libraryRoot, 'broken-video', {
    title: 'Broken Video',
    type: 'video',
    file: 'missing.mp4',
  });
  const actual = path.join(projectDir, 'actual.mp4');
  fs.writeFileSync(actual, Buffer.from('payload-bytes'));

  const library = makeLibrary(temp);
  const snapshot = await library.addManualProjectFile(actual);
  const matches = snapshot.projects.filter((item) => item.title === 'Broken Video');
  assert.equal(matches.length, 1, '同一目录只应产生一个条目，不重复计数');
  assert.equal(matches[0].playable, true);
  assert.equal(matches[0].mediaType, 'video');
  const served = await library.mediaResponse(mediaRequest(matches[0].id, snapshot.mediaToken));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'video/mp4');
  if (typeof library.dispose === 'function') library.dispose();
});

test('project.json 声明媒体但缺 type 时仍按直接媒体索引', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-we-typeless-'));
  const libraryRoot = path.join(temp, 'library');
  fs.mkdirSync(libraryRoot, { recursive: true });
  writeProject(libraryRoot, 'typeless', {
    title: 'Typeless Fixture',
    file: 'clip.mp4',
  }, {
    'clip.mp4': Buffer.from('clip-bytes'),
  });

  const library = makeLibrary(temp);
  const snapshot = await library.addManualRoot(libraryRoot);
  const item = snapshot.projects.find((entry) => entry.title === 'Typeless Fixture');
  assert.ok(item);
  assert.equal(item.playable, true);
  assert.equal(item.mediaType, 'video');
  assert.equal(item.projectType, 'video');
  if (typeof library.dispose === 'function') library.dispose();
});

test('在 Scene 项目目录里导入视频不会把 Scene 条目改标成 Video', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-we-scene-clip-'));
  const libraryRoot = path.join(temp, 'library');
  fs.mkdirSync(libraryRoot, { recursive: true });
  const projectDir = writeProject(libraryRoot, 'scene-with-clip', {
    title: 'Scene Clip',
    type: 'scene',
    file: 'scene.json',
    preview: 'preview.jpg',
  }, {
    'scene.pkg': Buffer.concat([Buffer.from([8, 0, 0, 0]), Buffer.from('PKGV0002', 'ascii'), Buffer.alloc(20, 1)]),
    'preview.jpg': Buffer.alloc(48, 0xff),
  });
  const clip = path.join(projectDir, 'extra.mp4');
  fs.writeFileSync(clip, Buffer.from('clip-bytes'));

  const library = makeLibrary(temp);
  const snapshot = await library.addManualProjectFile(clip);
  const matches = snapshot.projects.filter((item) => item.title === 'Scene Clip');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].projectType, 'scene');
  assert.equal(matches[0].enginePlayable, true);
  assert.equal(matches[0].playable, false, 'Scene 条目的媒体覆盖必须被排除');
  assert.equal(matches[0].mediaType, '');
  if (typeof library.dispose === 'function') library.dispose();
});
