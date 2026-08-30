/*
 * wallpaper-engine-legacy-scene-patch.js
 * ---------------------------------------------------------------------------
 * Wallpaper Engine 场景「静音补丁」兼容实现（独立模块，配合 wallpaper-engine-legacy.js）。
 *
 * 用途：Wallpaper Engine 场景(project.json type=scene)常自带 BGM / 音效，与 Stellaflix
 * 播放的音乐冲突。本模块解析场景包(.pkg/.pak)内的 scene.json，把所有含 sound 字段的
 * 音频对象置为 startsilent=true & volume=0，并以「就地覆盖、大小不变」的方式写回一个
 * 缓存副本（原 .pkg 不变）。运行时优先加载缓存副本。
 *
 * 低版本适配：
 *  - 不使用 Readable.fromWeb / Web Streams；同步 fs + Buffer，二进制在内存中处理。
 *  - 不使用 ?. ??，全部显式判空。
 *  - 不使用 Array.flat；用递归 walk 展开 scene 对象图。
 *  - PKGV 包索引解析手写，不依赖任何第三方解析库。
 *
 * 安全边界：包大小、条目数、scene 长度、对象图深度/节点数均有上限，防止恶意包放大攻击。
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WALLPAPER_PACKAGE_INDEX_MAX_BYTES = 16 * 1024 * 1024;
const WALLPAPER_PACKAGE_SCENE_MAX_BYTES = 32 * 1024 * 1024;
const WALLPAPER_PACKAGE_ENTRY_MAX_COUNT = 32768;
const WALLPAPER_PACKAGE_ENTRY_NAME_MAX_BYTES = 4096;
const MUTED_SCENE_PACKAGE_CACHE_VERSION = 1;
const MAX_SCENE_GRAPH_DEPTH = 128;
const MAX_SCENE_GRAPH_NODES = 250000;
const SCENE_PACKAGE_EXTENSIONS = (function () { const s = new Set(); s.add('.pkg'); s.add('.pak'); return s; })();

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeGet(obj, key) { return isObject(obj) ? obj[key] : undefined; }
function statFile(target) {
  try { const st = fs.statSync(target); return st.isFile() ? st : null; } catch (_) { return null; }
}
function readUInt32LE(buffer, offset) {
  if (!buffer || offset < 0 || offset + 4 > buffer.length) throw new Error('WALLPAPER_SCENE_PACKAGE_INDEX_INVALID');
  return buffer.readUInt32LE(offset);
}
function readString(buffer, state, maxLength) {
  const length = readUInt32LE(buffer, state.offset);
  state.offset += 4; // 跳过 4 字节长度前缀（与原始 readPackageString/readPackageUInt32 一致）
  if (length <= 0 || length > maxLength || state.offset + length > buffer.length) throw new Error('WALLPAPER_SCENE_PACKAGE_INDEX_INVALID');
  const value = buffer.toString('utf8', state.offset, state.offset + length);
  state.offset += length;
  return value;
}

/**
 * 解析 PKGV 包索引，定位 scene.json 的位置/长度。
 */
function readWallpaperPackageScene(scenePackage) {
  const pkgStat = statFile(scenePackage);
  if (!pkgStat || pkgStat.size < 32) throw new Error('WALLPAPER_SCENE_PACKAGE_INVALID');
  const handle = fs.openSync(scenePackage, 'r');
  try {
    const indexLength = Math.min(pkgStat.size, WALLPAPER_PACKAGE_INDEX_MAX_BYTES);
    const indexBuffer = Buffer.alloc(indexLength);
    let readOffset = 0;
    while (readOffset < indexLength) {
      const bytesRead = fs.readSync(handle, indexBuffer, readOffset, indexLength - readOffset, readOffset);
      if (bytesRead <= 0) throw new Error('WALLPAPER_SCENE_PACKAGE_INVALID');
      readOffset += bytesRead;
    }
    const state = { offset: 0 };
    const header = readString(indexBuffer, state, 32);
    if (!/^PKGV\d{4}$/i.test(header)) throw new Error('WALLPAPER_SCENE_PACKAGE_FORMAT_UNSUPPORTED');
    const entryCount = readUInt32LE(indexBuffer, state.offset);
    state.offset += 4; // readUInt32LE 不自动推进，此处手动跳过 entryCount（与原始 readPackageUInt32 一致）
    if (entryCount <= 0 || entryCount > WALLPAPER_PACKAGE_ENTRY_MAX_COUNT) throw new Error('WALLPAPER_SCENE_PACKAGE_INDEX_INVALID');
    let sceneEntry = null;
    for (let i = 0; i < entryCount; i += 1) {
      const name = readString(indexBuffer, state, WALLPAPER_PACKAGE_ENTRY_NAME_MAX_BYTES);
      const entryOffset = readUInt32LE(indexBuffer, state.offset);
      const entryLength = readUInt32LE(indexBuffer, state.offset + 4);
      if (name.replace(/\\/g, '/').toLowerCase() === 'scene.json') sceneEntry = { offset: entryOffset, length: entryLength };
      state.offset += 8;
    }
    if (!sceneEntry || sceneEntry.length <= 0 || sceneEntry.length > WALLPAPER_PACKAGE_SCENE_MAX_BYTES) throw new Error('WALLPAPER_SCENE_PACKAGE_SCENE_INVALID');
    const dataOffset = state.offset + sceneEntry.offset;
    if (!Number.isSafeInteger(dataOffset) || dataOffset < state.offset || dataOffset + sceneEntry.length > pkgStat.size) throw new Error('WALLPAPER_SCENE_PACKAGE_SCENE_INVALID');
    const sceneBuffer = Buffer.alloc(sceneEntry.length);
    let sceneRead = 0;
    while (sceneRead < sceneEntry.length) {
      const n = fs.readSync(handle, sceneBuffer, sceneRead, sceneEntry.length - sceneRead, dataOffset + sceneRead);
      if (n <= 0) throw new Error('WALLPAPER_SCENE_PACKAGE_SCENE_INVALID');
      sceneRead += n;
    }
    let scene;
    try { scene = JSON.parse(sceneBuffer.toString('utf8').replace(/^\uFEFF/, '')); } catch (_) { throw new Error('WALLPAPER_SCENE_PACKAGE_SCENE_INVALID'); }
    if (!isObject(scene)) throw new Error('WALLPAPER_SCENE_PACKAGE_SCENE_INVALID');
    return { dataOffset: dataOffset, sceneLength: sceneEntry.length, scene: scene, packageSize: pkgStat.size, packageMtimeMs: Number(pkgStat.mtimeMs) || 0 };
  } finally {
    fs.closeSync(handle);
  }
}

function visitSceneAudioObjects(scene, visitor) {
  let audioObjectCount = 0;
  let visited = 0;
  const walk = function (value, depth) {
    if (!value || typeof value !== 'object' || depth > MAX_SCENE_GRAPH_DEPTH) return;
    visited += 1;
    if (visited > MAX_SCENE_GRAPH_NODES) throw new Error('WALLPAPER_SCENE_PACKAGE_SCENE_TOO_COMPLEX');
    const hasSound = Object.prototype.hasOwnProperty.call(value, 'sound') && (typeof value.sound === 'string' || Array.isArray(value.sound));
    if (hasSound) { audioObjectCount += 1; visitor(value); }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) walk(value[i], depth + 1);
    } else {
      Object.keys(value).forEach(function (k) { walk(value[k], depth + 1); });
    }
  };
  walk(scene, 0);
  return audioObjectCount;
}
function forceSceneAudioSilent(scene) {
  return visitSceneAudioObjects(scene, function (value) { value.startsilent = true; value.volume = 0; });
}
function inspectSceneAudioSilence(scene) {
  let allSilent = true;
  const count = visitSceneAudioObjects(scene, function (value) {
    if (value.startsilent !== true || value.volume !== 0) allSilent = false;
  });
  return { audioObjectCount: count, allSilent: allSilent };
}
function validateMutedScenePackage(scenePackage, expectedSize, expectedCount) {
  try {
    const cached = readWallpaperPackageScene(scenePackage);
    if (cached.packageSize !== expectedSize) return false;
    const inspection = inspectSceneAudioSilence(cached.scene);
    return inspection.allSilent && inspection.audioObjectCount === expectedCount;
  } catch (_) { return false; }
}
function encodePatchedScene(scene, originalLength) {
  const encoded = Buffer.from(JSON.stringify(scene), 'utf8');
  if (encoded.length > originalLength) throw new Error('WALLPAPER_SCENE_PACKAGE_PATCH_TOO_LARGE');
  const output = Buffer.alloc(originalLength, 0x20); // 以空格填充，保持包体积不变
  encoded.copy(output);
  return output;
}

/**
 * 为场景包生成静音缓存副本。返回缓存文件路径；若场景无音频对象，返回原文件。
 * cacheRoot 由调用方传入（如 app.getPath('userData') 下的 wallpaper-engine-legacy-muted-package-cache）。
 */
function prepareMutedScenePackage(scenePackage, cacheRoot) {
  const source = readWallpaperPackageScene(scenePackage);
  const patchedScene = JSON.parse(JSON.stringify(source.scene));
  const audioObjectCount = forceSceneAudioSilent(patchedScene);
  if (!audioObjectCount) return scenePackage;
  const patchedBuffer = encodePatchedScene(patchedScene, source.sceneLength);
  if (!fs.existsSync(cacheRoot)) fs.mkdirSync(cacheRoot, { recursive: true });
  const identity = crypto.createHash('sha256')
    .update(String(MUTED_SCENE_PACKAGE_CACHE_VERSION))
    .update('\0').update(path.resolve(scenePackage).toLowerCase())
    .update('\0').update(String(source.packageSize))
    .update('\0').update(String(Math.round(source.packageMtimeMs)))
    .digest('hex');
  const cachedFile = path.join(cacheRoot, identity + '.pkg');
  const cachedStat = statFile(cachedFile);
  const cachedValid = !!cachedStat && cachedStat.size === source.packageSize && validateMutedScenePackage(cachedFile, source.packageSize, audioObjectCount);
  if (!cachedValid) {
    if (cachedStat) fs.unlinkSync(cachedFile);
    const tempFile = path.join(cacheRoot, identity + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
    fs.copyFileSync(scenePackage, tempFile);
    const handle = fs.openSync(tempFile, 'r+');
    try {
      let offset = 0;
      while (offset < patchedBuffer.length) {
        const written = fs.writeSync(handle, patchedBuffer, offset, patchedBuffer.length - offset, source.dataOffset + offset);
        if (written <= 0) throw new Error('WALLPAPER_SCENE_PACKAGE_PATCH_FAILED');
        offset += written;
      }
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    try { fs.renameSync(tempFile, cachedFile); }
    catch (e) {
      if (!validateMutedScenePackage(cachedFile, source.packageSize, audioObjectCount)) {
        fs.unlinkSync(cachedFile);
        fs.renameSync(tempFile, cachedFile);
      } else { fs.unlinkSync(tempFile); }
    }
    if (!validateMutedScenePackage(cachedFile, source.packageSize, audioObjectCount)) {
      fs.unlinkSync(cachedFile);
      throw new Error('WALLPAPER_SCENE_PACKAGE_PATCH_FAILED');
    }
  }
  return cachedFile;
}

module.exports = {
  SCENE_PACKAGE_EXTENSIONS: SCENE_PACKAGE_EXTENSIONS,
  readWallpaperPackageScene: readWallpaperPackageScene,
  forceSceneAudioSilent: forceSceneAudioSilent,
  prepareMutedScenePackage: prepareMutedScenePackage,
  analyzeSceneSilence: inspectSceneAudioSilence
};
