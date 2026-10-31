// Isolated renderer fixture: no gateway, credentials, updater, or user profile access.
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const output = process.argv[process.argv.indexOf('--out') + 1];
app.setPath('userData', path.join(path.resolve(output), 'profile'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1440, height: 1000, title: 'CryoClaw Reference UI QA',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, done) => done({ cancel: true }),
  );
  await window.loadFile(path.join(root, 'chat-ui/dist/index.html'), {
    query: { lang: 'zh', gatewayUrl: 'ws://127.0.0.1:0', qaMarker: process.env.CRYOCLAW_REFERENCE_MARKER ?? '' },
  });
});
app.on('window-all-closed', () => app.quit());
