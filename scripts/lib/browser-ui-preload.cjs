'use strict';
const {contextBridge, ipcRenderer} = require('electron');
const api = {};
api.browserQaNativeBounds=()=>ipcRenderer.invoke('browser-qa:native-bounds');
for (const [name, channel] of Object.entries({
  embeddedBrowserShow:'show', embeddedBrowserHide:'hide', embeddedBrowserBounds:'bounds',
  embeddedBrowserNavigate:'navigate', embeddedBrowserAction:'action', embeddedBrowserPreferences:'preferences',
  embeddedBrowserEvaluate:'evaluate', embeddedBrowserAgentPolicy:'agent-policy', embeddedBrowserUtility:'utility',
})) api[name] = (...args) => ipcRenderer.invoke(`embedded-browser:${channel}`, ...args);
for (const [name, channel] of Object.entries({onEmbeddedBrowserState:'state-changed', onEmbeddedBrowserAgentOpen:'agent-open'})) {
  api[name] = cb => { const handler = (_event, value) => cb(value); ipcRenderer.on(`embedded-browser:${channel}`,handler); return () => ipcRenderer.removeListener(`embedded-browser:${channel}`,handler); };
}
contextBridge.exposeInMainWorld('cryoclaw', api);
