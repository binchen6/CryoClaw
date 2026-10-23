import {BrowserWindow,ipcMain,shell} from 'electron';
import {assertTrustedIpcSender} from './ipc-sender-guard';

export function validateDashboardPin(value:unknown,port:number){
  const p=value as {id?:unknown;url?:unknown;title?:unknown;width?:unknown;height?:unknown};
  if(!p||typeof p.id!=='string'||!/^[-\w]{1,64}\/[-\w]{1,64}$/.test(p.id)||typeof p.url!=='string'||p.url.length>4096)throw Error('Invalid dashboard card');
  const url=new URL(p.url);if(url.origin!==`http://127.0.0.1:${port}`||url.username||url.password||url.pathname!==`/__cryoclaw__/dashboards/${p.id}`||!url.searchParams.has('ticket')||url.hash)throw Error('Invalid dashboard origin');
  const size=(v:unknown,min:number,max:number,fallback:number)=>typeof v==='number'&&Number.isFinite(v)?Math.max(min,Math.min(max,Math.round(v))):fallback;
  return {id:p.id,url:url.href,title:typeof p.title==='string'?p.title.slice(0,100):'CryoClaw',width:size(p.width,320,1400,500),height:size(p.height,240,1000,400)};
}
export function registerDashboardPin(getPort:()=>number){
  const windows=new Map<string,BrowserWindow>();
  ipcMain.handle('app:pin-dashboard-card',async(event,value:unknown)=>{
    if(!assertTrustedIpcSender(event,'app:pin-dashboard-card'))throw Error('IPC sender not trusted');const p=validateDashboardPin(value,getPort()),existing=windows.get(p.id);
    if(existing&&!existing.isDestroyed()){await existing.loadURL(p.url);existing.show();existing.focus();return {pinned:true};}
    const win=new BrowserWindow({title:p.title,width:p.width,height:p.height,minWidth:300,minHeight:220,alwaysOnTop:true,autoHideMenuBar:true,backgroundColor:'#10191f',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
    windows.set(p.id,win);win.on('closed',()=>windows.delete(p.id));
    win.webContents.on('will-navigate',(e,url)=>{if(url!==p.url)e.preventDefault();});win.webContents.on('will-redirect',e=>e.preventDefault());
    let lastOpen=0;win.webContents.setWindowOpenHandler(({url})=>{try{const target=new URL(url);if(target.protocol==='https:'&&!target.username&&!target.password&&win.isFocused()&&Date.now()-lastOpen>1000){lastOpen=Date.now();void win.webContents.executeJavaScriptInIsolatedWorld(999,[{code:'navigator.userActivation.isActive'}]).then(active=>{if(active&&!win.isDestroyed()&&win.isFocused())void shell.openExternal(target.href);}).catch(()=>{});}}catch{}return {action:'deny'};});
    try{await win.loadURL(p.url);return {pinned:true};}catch(error){win.destroy();throw error;}
  });
}
