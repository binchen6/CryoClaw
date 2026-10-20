const {contextBridge,ipcRenderer}=require('electron');
const call=(name,args)=>ipcRenderer.invoke('setup-smoke:invoke',name,args);
contextBridge.exposeInMainWorld('cryoclaw',{
  detectInstallation:()=>call('detectInstallation'),detectEnvKeys:()=>call('detectEnvKeys'),
  verifyKey:args=>call('verifyKey',args),saveConfig:args=>call('saveConfig',args),completeSetup:args=>call('completeSetup',args),
  setupGetLaunchAtLogin:()=>call('setupGetLaunchAtLogin'),settingsGetDefaultBrowserName:()=>call('settingsGetDefaultBrowserName'),
  resolveConflict:()=>call('resolveConflict'),openExternal:()=>{},reportSetupViewState:()=>{},
  getGatewayState:async()=>({state:'stopped',progress:null}),getGatewayPort:async()=>0,
  onNavigate:callback=>{const listener=(_event,payload)=>callback(payload);ipcRenderer.on('app:navigate',listener);return()=>ipcRenderer.removeListener('app:navigate',listener);},
  qaState:()=>call('qaState'),qaConfigure:args=>call('qaConfigure',args),
});
