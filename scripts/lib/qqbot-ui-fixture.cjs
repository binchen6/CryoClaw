'use strict';
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path');
const out=path.resolve(process.env.CRYOCLAW_QQ_QA_OUT);
app.setAppPath(path.resolve(__dirname,'../..'));
app.setPath('userData',path.join(out,'profile'));
process.env.OPENCLAW_STATE_DIR=path.join(out,'state');
let mode='waiting',attempt=0,polls=0,canceled=[],active=0,maxActive=0;
const svg=color=>'data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="white"/><path d="M20 20h60v60H20zm100 0h60v60h-60zM20 120h60v60H20zm90-10h30v30h-30zm40 40h30v30h-30z" fill="${color}"/></svg>`).toString('base64');
ipcMain.handle('settings:get-channel-runtime-state',()=>({success:true,data:{bundled:{qqbot:true},bundleMessages:{},weixinAccounts:[]}}));
ipcMain.handle('settings:verify-key',()=>({success:true}));
ipcMain.handle('settings:qqbot-login-start',()=>{attempt++;polls=0;return {success:true,data:{attemptId:String(attempt),status:'waiting',qrDataUrl:svg('black'),message:'Fixture: scan with phone QQ'}};});
ipcMain.handle('settings:qqbot-login-wait',async(_event,{attemptId})=>{
  active++;maxActive=Math.max(maxActive,active);polls++;await new Promise(r=>setTimeout(r,70));active--;
  const status=mode==='success'?'connected':mode==='expired'?'expired':mode==='error'?'error':'waiting';
  return {success:true,data:{attemptId,status,qrDataUrl:status==='waiting'?svg('navy'):undefined,message:`Fixture: ${status}`,accounts:status==='connected'?[{accountId:'3003',appId:'3003',name:'Linked'}]:undefined}};
});
ipcMain.handle('settings:qqbot-login-cancel',(_event,{attemptId})=>{canceled.push(attemptId);return {success:true};});
ipcMain.handle('qq-qa:scenario',(_event,value)=>{mode=value;return true;});
ipcMain.handle('qq-qa:stats',()=>({mode,attempt,polls,canceled,maxActive}));
app.whenReady().then(async()=>{
  const window=new BrowserWindow({width:1050,height:1050,webPreferences:{preload:path.join(__dirname,'qqbot-ui-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await window.loadFile(path.join(out,'build/index.html'),{query:{lang:'zh'}});
});
app.on('window-all-closed',()=>app.quit());
