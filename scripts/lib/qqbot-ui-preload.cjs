'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('cryoclaw',{
  settingsGetChannelRuntimeState:()=>ipcRenderer.invoke('settings:get-channel-runtime-state'),
  settingsVerifyKey:params=>ipcRenderer.invoke('settings:verify-key',params),
  settingsQqbotLoginStart:()=>ipcRenderer.invoke('settings:qqbot-login-start'),
  settingsQqbotLoginWait:params=>ipcRenderer.invoke('settings:qqbot-login-wait',params),
  settingsQqbotLoginCancel:params=>ipcRenderer.invoke('settings:qqbot-login-cancel',params),
  qqQaScenario:mode=>ipcRenderer.invoke('qq-qa:scenario',mode),
  qqQaStats:()=>ipcRenderer.invoke('qq-qa:stats'),
  openExternal:()=>{},
});
