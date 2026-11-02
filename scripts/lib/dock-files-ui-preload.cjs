'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('cryoclaw',{
  workspaceGetContext:()=>ipcRenderer.invoke('dock-files:context'),
  workspaceSetRoot:root=>ipcRenderer.invoke('dock-files:set-root',root),
  workspaceListDir:(dir,options)=>ipcRenderer.invoke('dock-files:list',dir,options),
  workspaceReadFile:file=>ipcRenderer.invoke('dock-files:read',file),
  workspaceSaveDraft:params=>ipcRenderer.invoke('dock-files:draft',params),
  workspaceFindFiles:params=>ipcRenderer.invoke('dock-files:search',params),
  dockFilesQaInfo:()=>ipcRenderer.invoke('dock-files:qa-info'),
  dockFilesQaCreateFile:()=>ipcRenderer.invoke('dock-files:qa-create'),
  dockFilesQaStats:()=>ipcRenderer.invoke('dock-files:qa-stats'),
});
