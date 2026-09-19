#!/usr/bin/env node
/**
 * 打包前置/后置校验：确认安装包 resources/app 含启动必需文件。
 * 用法:
 *   node scripts/verify-pack-requirements.js            # 校验当前源码树
 *   node scripts/verify-pack-requirements.js <appDir>  # 校验 win-unpacked/resources/app
 */
const fs = require('fs');
const path = require('path');

const appDir = path.resolve(process.argv[2] || process.cwd());
const required = [
  'package.json',
  'server.js',
  'desktop/main.js',
  'desktop/hls-ad-filter.js',
  'agent-api.js',
  'dj-analyzer.js',
  'kugou-api.js',
  'qishui-api.js',
  'qishui-auth-v6.js',
  'qishui-qr-login.js',
  'qq-vip-api.js',
  'spotify-api.js',
  'subsonic-api.js',
  'cuefield/feedback-log.js',
  'cuefield/stellaflix-bridge.js',
  'desktop/global-proxy.js',
  'qishui-audio-decryptor/track-decryptor.js',
  'qishui-audio-decryptor/decrypt-utils.js',
  'qishui-audio-decryptor/mp4-box.js',
  'qishui-auth-v6/security_host.html',
  'qishui-auth-v6/security_seed.html',
  'qishui-auth-v6/sdk-glue.js',
  'qishui-auth-v6/bdms.js',
  'node_modules/fs-extra/package.json',
  'node_modules/electron-updater/out/main.js',
  'node_modules/electron-updater/package.json',
];

const missing = required.filter((rel) => !fs.existsSync(path.join(appDir, rel)));
if (missing.length) {
  console.error(`VERIFY FAIL appDir=${appDir}`);
  missing.forEach((m) => console.error(`  MISSING ${m}`));
  process.exit(1);
}
console.log(`VERIFY OK appDir=${appDir} checked=${required.length}`);
