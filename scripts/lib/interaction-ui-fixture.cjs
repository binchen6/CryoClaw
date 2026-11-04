'use strict';
const {app,BrowserWindow}=require('electron'),path=require('path');
const out=path.resolve(process.env.CRYOCLAW_INTERACTION_QA_OUT);
app.setPath('userData',path.join(out,'profile'));
app.whenReady().then(async()=>{const window=new BrowserWindow({width:1050,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await window.loadFile(path.join(out,'build/index.html'));});
app.on('window-all-closed',()=>app.quit());
