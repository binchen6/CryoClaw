// This main process is used only by setup-ui-smoke, never shipped in the app.
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const out=process.argv[process.argv.indexOf('--out')+1];
app.commandLine.appendSwitch('remote-debugging-port','9348');
app.setPath('userData',path.join(path.resolve(out),'profile'));
const state={verifyCalls:0,saves:0,completions:0,primaryModel:null,lastComplete:null,browserSupported:true,failCompleteOnce:true};
const success=data=>({success:true,data});
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1000,height:800,title:'CryoClaw Setup QA',webPreferences:{preload:path.join(__dirname,'setup-smoke-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_details,callback)=>callback({cancel:true}));
  const handlers={
    detectInstallation:()=>success({portInUse:false,portProcess:'',portPid:0,globalInstalled:false,globalPath:''}),
    detectEnvKeys:()=>success([]),
    verifyKey:async params=>{state.verifyCalls++;await new Promise(resolve=>setTimeout(resolve,1500));return {success:params.apiKey!=='fixture-fail',message:'Fixture verification failed',supportsImage:false};},
    saveConfig:params=>{state.saves++;state.primaryModel=params.primaryModel;return {success:true};},
    completeSetup:params=>{state.completions++;state.lastComplete=params;return state.failCompleteOnce && state.completions===1?{success:false,message:'Fixture startup failed; retry'}:{success:true};},
    setupGetLaunchAtLogin:()=>success({supported:true,enabled:false}),
    settingsGetDefaultBrowserName:()=>success(state.browserSupported?{id:'chrome',name:'Chrome'}:null),
    resolveConflict:()=>({success:false,message:'Destructive operations are disabled in this fixture'}),
    qaState:()=>({...state}),qaConfigure:params=>{if(typeof params?.browserSupported==='boolean')state.browserSupported=params.browserSupported;return true;},
  };
  ipcMain.handle('setup-smoke:invoke',(event,name,args)=>{if(event.sender.id!==win.webContents.id || !Object.hasOwn(handlers,name))throw Error('Unsupported fixture request');return handlers[name](args);});
  await win.loadFile(path.join(root,'chat-ui/dist/index.html'),{query:{view:'setup',lang:'zh',gatewayUrl:'ws://127.0.0.1:0'}});
});
app.on('window-all-closed',()=>app.quit());
