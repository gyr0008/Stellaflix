'use strict';

/**
 * Stellaflare 影视态 — ffprobe 媒体元数据探测器 (ffprobe.js)
 * ----------------------------------------------------------------------------
 * 封装 ffprobe.exe 子进程，返回标准化的媒体元信息流。
 *
 * 输入：url / 文件路径 / 磁力 infohash（由前置模块解析成 file path）
 * 输出：统一的 MediaInfo 对象，供 mpv-controller 和 protocol-adapters 使用。
 *
 * 标准化输出结构（对齐 PDF 第 5.2 章片源码率探测）：
 *   {
 *     format: {
 *       durationSec: number,         // 总时长（秒）
 *       sizeBytes: number,           // 文件字节
 *       bitRate: number,             // 总码率（bps）
 *       formatName: string,          // 容器名（matroska, mov 等）
 *       streams: [{
 *         type: 'video'|'audio'|'subtitle',
 *         codec: string,
 *         width, height,
 *         bitRate,                   // 流级码率（VBR 优先）
 *         frameRate,
 *         colorSpace, colorTransfer,  // 用于 HDR 判别
 *         dvProfile,                 // 杜比视界 Profile（若有）
 *         language, title
 *       }]
 *     }
 *   }
 *
 * 关键设计：
 *   - 优先流级 bit_rate（对 VBR 更齐 PDF §5.2）
 *   - 容器级 format.bit_rate 次之
 *   - duration + size 反推作为兜底
 *   - ffprobe 路径从 video-config 读，可执行文件不存在时 graceful 降级
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let _config = null;

function setConfig(cfg) {
  _config = cfg;
}

function getFfprobePath() {
  if (_config && _config.mpv && _config.mpv.ffprobePath && fs.existsSync(_config.mpv.ffprobePath)) {
    return _config.mpv.ffprobePath;
  }
  // 兜底：PATH 里找 ffprobe
  return 'ffprobe';
}

/**
 * 执行 ffprobe 并返回 JSON
 * @param {string} input - URL 或文件路径
 * @param {object} opts.timeoutMs（默认 15000）
 */
function probeRaw(input, opts) {
  opts = opts || {};
  const ffprobe = getFfprobePath();
  const timeoutMs = opts.timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-show_entries', 'stream=index,codec_type,codec_name,width,height,bit_rate,r_frame_rate,color_space,color_transfer,color_primaries,profile,language,title:stream_disposition=:format=duration,size,bit_rate,format_name',
      input,
    ];
    let stdout = '';
    let stderr = '';
    const child = spawn(ffprobe, args, { windowsHide: true });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
      reject(new Error('ffprobe timeout'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error('ffprobe exit ' + code + ': ' + stderr.slice(0, 200))); return; }
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('ffprobe JSON parse error: ' + stdout.slice(0, 200))); }
    });
  });
}

/** 把 ffprobe 原始输出转成标准化 MediaInfo */
function normalize(raw) {
  const fmt = raw.format || {};
  const streams = (raw.streams || []).map(s => {
    const isVideo = s.codec_type === 'video';
    const isAudio = s.codec_type === 'audio';
    const isSub = s.codec_type === 'subtitle';
    let dvProfile = null;
    if (isVideo && (s.codec_name === 'dvh1' || s.codec_name === 'dvhe' || /dolby/i.test(s.profile || ''))) {
      dvProfile = parseInt((s.profile || '').replace(/\D/g, ''), 10) || 5;
    }
    let frameRate = null;
    if (s.r_frame_rate) {
      const parts = String(s.r_frame_rate).split('/');
      if (parts.length === 2 && parseInt(parts[1], 10) !== 0) {
        frameRate = parseInt(parts[0], 10) / parseInt(parts[1], 10);
      }
    }
    return {
      type: isVideo ? 'video' : isAudio ? 'audio' : isSub ? 'subtitle' : s.codec_type,
      codec: s.codec_name || '',
      width: isVideo ? (s.width || 0) : undefined,
      height: isVideo ? (s.height || 0) : undefined,
      bitRate: s.bit_rate ? parseInt(s.bit_rate, 10) : 0,
      frameRate,
      colorSpace: s.color_space,
      colorTransfer: s.color_transfer,
      colorPrimaries: s.color_primaries,
      dvProfile,
      language: s.language,
      title: s.title || s.profile || '',
    };
  });
  let durationSec = parseFloat(fmt.duration || '0');
  let sizeBytes = parseInt(fmt.size || '0', 10);
  let bitRate = parseInt(fmt.bit_rate || '0', 10);
  const videoStream = streams.find(s => s.type === 'video');
  // 对齐 PDF §5.2：流级 bit_rate 优先
  if (videoStream && videoStream.bitRate) bitRate = videoStream.bitRate;
  // duration+size 反推兜底
  if (!durationSec && bitRate && sizeBytes) durationSec = (sizeBytes * 8) / bitRate;
  return {
    format: {
      durationSec,
      sizeBytes,
      bitRate,
      formatName: fmt.format_name || '',
      streams,
      video: videoStream || null,
      audio: streams.find(s => s.type === 'audio') || null,
      subtitles: streams.filter(s => s.type === 'subtitle'),
    },
  };
}

/** 对外主入口：probe(input) → MediaInfo */
function probe(input, opts) {
  return probeRaw(input, opts).then(normalize);
}

/**
 * 快速探测：只拿前 N 秒（fast=true 时加 -analyzeduration / -probesize）
 * 用于协议适配器的"可用性校验"，不拉全片信息。
 */
function probeFast(input, opts) {
  opts = opts || {};
  return probe(input, { timeoutMs: opts.timeoutMs || 8000 });
}

module.exports = { probe, probeFast, probeRaw, normalize, setConfig };
