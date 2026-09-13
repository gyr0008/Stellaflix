/*
 * 单元测试：sources-core.pickMainEpisode（电影默认起播集选择）
 * 运行：node tests/test-pick-main-episode.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/jsdom');

const ROOT = path.resolve(__dirname, '..');
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost:3000/' });
const ctx = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, console, URL: dom.window.URL };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'video', 'sources-core.js'), 'utf8'), ctx, { filename: 'sources-core.js' });

const S = ctx.window.StellaflixVideo.sources;
const pick = S.pickMainEpisode;
const parse = S.parsePlayUrl;

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  期望=' + expected + ' 实际=' + actual); }
}

function ep(name) { return { name: name, url: 'https://x/' + encodeURIComponent(name) + '.mp4', index: 0 }; }
function eps(names) { return names.map(function (n, i) { var e = ep(n); e.index = i; return e; }); }

console.log('=== pickMainEpisode 单元测试 ===');

// --- 1. 电影「预告片 + 正片」：核心修复场景
console.log('\n[1] 电影 playUrl = 预告片#HD中字');
var plays = parse('ckm3u8', '预告片$https://cdn/t.mp4#HD中字$https://cdn/m.mp4');
var picked = pick(plays[0].episodes);
eq('选中集名为 HD中字（跳过预告片）', picked && picked.name, 'HD中字');
eq('选中集 URL 为正片地址', picked && picked.url, 'https://cdn/m.mp4');
eq('不再选中第一集（预告片）', (picked && picked.name === '预告片'), false);

// --- 2. 片花 + 正片
console.log('\n[2] 电影 playUrl = 片花#正片');
var p2 = parse('ckm3u8', '片花$https://cdn/a.mp4#正片$https://cdn/b.mp4');
eq('选中正片', pick(p2[0].episodes).name, '正片');

// --- 3. 花絮在前、超清正片在后
console.log('\n[3] 电影 playUrl = 花絮#超清');
var p3 = parse('ckm3u8', '花絮$https://cdn/a.mp4#超清$https://cdn/b.mp4');
eq('选中超清', pick(p3[0].episodes).name, '超清');

// --- 4. 普通剧集不受影响（第1集/第2集/第3集 → 第1集）
console.log('\n[4] 剧集 playUrl = 第1集#第2集#第3集');
var p4 = parse('ckm3u8', '第1集$https://cdn/1.mp4#第2集$https://cdn/2.mp4#第3集$https://cdn/3.mp4');
eq('仍选中第1集（行为不变）', pick(p4[0].episodes).name, '第1集');

// --- 5. 纯数字集名剧集
console.log('\n[5] 剧集 playUrl = 01#02#03');
var p5 = parse('ckm3u8', '01$https://cdn/1.mp4#02$https://cdn/2.mp4#03$https://cdn/3.mp4');
eq('仍选中 01', pick(p5[0].episodes).name, '01');

// --- 6. 空 / 单集
console.log('\n[6] 边界：空数组 / 单集');
eq('空数组返回 null', pick([]), null);
eq('undefined 返回 null', pick(undefined), null);
var single = eps(['第1集']);
eq('单集返回该集', pick(single), single[0]);

// --- 7. 全是预告类 → 兜底第一集（保持旧行为，不返回空）
console.log('\n[7] 全部为预告类 → 兜底第一集');
var p7 = eps(['预告片', '先行版预告', '特辑']);
eq('兜底返回第一集', pick(p7).name, '预告片');

// --- 8. HD 字母边界：不误判 hidden 为正片关键词
console.log('\n[8] HD 字母边界（避免误命中 hidden 等英文单词）');
var p8 = eps(['hidden', '第1集']);
eq('hidden 不被当作正片，回退第一个非预告集（hidden 本身）', pick(p8).name, 'hidden');

// --- 9. 「HD预告」应被排除（同时含 HD 与预告词）
console.log('\n[9] 混合关键词：HD预告#HD中字');
var p9 = eps(['HD预告', 'HD中字']);
eq('排除 HD预告，选中 HD中字', pick(p9).name, 'HD中字');

// --- 10. 1080p 与 花絮
console.log('\n[10] 电影 playUrl = 1080p#花絮');
var p10 = eps(['1080p', '花絮']);
eq('选中 1080p', pick(p10).name, '1080p');

console.log('\n=== 结果：PASS=' + pass + '  FAIL=' + fail + ' ===');
if (fail > 0) process.exitCode = 1;
