const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
const preloadText = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');

function ipcHandlerBody(source, channel) {
  const start = source.indexOf(`ipcMain.handle('${channel}'`);
  assert.notEqual(start, -1, `missing ipc handler: ${channel}`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `missing handler body: ${channel}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  assert.fail(`unbalanced braces in handler: ${channel}`);
}

test('desktop update bridge opens only bounded HTTPS pages from the trusted main document', () => {
  assert.match(mainText, /ipcMain\.handle\('stellaflix-open-update-page', async \(event, value\) =>/);
  assert.match(mainText, /if \(!isTrustedMainWindowIpc\(event\)\) return \{ ok: false, error: 'UNTRUSTED_SENDER' \}/);
  assert.match(mainText, /target\.length > 2048/);
  assert.match(mainText, /parsed\.protocol !== 'https:'/);
  assert.match(mainText, /await shell\.openExternal\(parsed\.href\)/);
  assert.match(preloadText, /openUpdatePage: \(url\) => ipcRenderer\.invoke\('stellaflix-open-update-page', String\(url \|\| ''\)\)/);
});

test('local update installer and update-cache bridges are absent', () => {
  const bridgeText = mainText + '\n' + preloadText;
  assert.doesNotMatch(bridgeText, /stellaflix-open-update-installer/);
  assert.doesNotMatch(bridgeText, /openUpdateInstaller/);
  assert.doesNotMatch(mainText, /getUpdateDownloadDir/);
  assert.doesNotMatch(mainText, /STELLAFLIX_UPDATE_DIR/);
  // Anchor on the update IPC handler body rather than the whole file: shell.openPath
  // is legitimately used by the custom-source script directory bridge, so a
  // file-wide regex reports a false positive.
  const updateHandler = ipcHandlerBody(mainText, 'stellaflix-open-update-page');
  assert.match(updateHandler, /shell\.openExternal\(/);
  assert.doesNotMatch(updateHandler, /shell\.openPath\(/);
  assert.doesNotMatch(updateHandler, /shell\.openItem\(/);
});
