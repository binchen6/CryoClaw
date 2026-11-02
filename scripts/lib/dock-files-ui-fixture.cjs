'use strict';
// Real files, isolated roots and profile. This harness never loads product main or user config.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const out=path.resolve(process.env.CRYOCLAW_DOCK_FILES_QA_OUT);
const roots={current:path.join(out,'fixturefiles','workspace-alpha'),alternate:path.join(out,'fixturefiles','workspace-beta')};
let activeRoot=roots.current;
const stats={lists:0,reads:0,searches:0,pendingSlow:0,completedSlow:0,denied:0};
const drafts=new Map();
app.setAppPath(path.resolve(__dirname,'../..'));
app.setPath('userData',path.join(out,'profile',`${Date.now()}-${process.pid}`));
process.env.OPENCLAW_STATE_DIR=path.join(out,'state');
const inside=(root,file)=>{const relative=path.relative(root,path.resolve(file));return !relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
async function authorized(file,root=activeRoot){
  if(typeof file!=='string'||!inside(root,file))throw Error('Fixture root denied');
  const physical=await fs.realpath(file);
  if(!inside(root,physical))throw Error('Fixture link denied');
  return physical;
}
const safe=handler=>async(...args)=>{try{return await handler(...args);}catch{stats.denied++;return {success:false,message:'Fixture operation denied'};}};
async function itemsAt(dir,showHidden){
  const entries=await fs.readdir(dir,{withFileTypes:true});
  return entries.filter(entry=>!entry.isSymbolicLink()&&(showHidden||!entry.name.startsWith('.'))).slice(0,400).map(entry=>({name:entry.name,path:path.join(dir,entry.name),isDir:entry.isDirectory()}));
}
ipcMain.handle('dock-files:context',()=>({success:true,data:{defaultRoot:roots.current,activeRoot}}));
ipcMain.handle('dock-files:set-root',safe(async(_event,root)=>{
  if(!Object.values(roots).includes(root))throw Error('Unknown fixture root');
  activeRoot=root;return {success:true};
}));
ipcMain.handle('dock-files:list',safe(async(_event,dir,options)=>{
  const rootAtRequest=activeRoot,target=await authorized(dir,rootAtRequest);stats.lists++;
  const items=await itemsAt(target,options?.showHidden===true);
  if(path.basename(target)==='slow'){
    stats.pendingSlow++;await new Promise(resolve=>setTimeout(resolve,1400));stats.pendingSlow--;stats.completedSlow++;
  }
  return {success:true,data:{items,truncated:false}};
}));
ipcMain.handle('dock-files:read',safe(async(_event,file)=>{
  const target=await authorized(file),stat=await fs.stat(target);
  if(!stat.isFile()||stat.size>128*1024)throw Error('Fixture read bound');
  const content=await fs.readFile(target,'utf8');stats.reads++;
  return {success:true,data:{content,size:stat.size,hash:crypto.createHash('sha256').update(content).digest('hex')}};
}));
ipcMain.handle('dock-files:draft',safe(async(_event,params)=>{
  await authorized(params.path);if(params.draft===null)drafts.delete(params.path);else drafts.set(params.path,params.draft);
  return {success:true};
}));
ipcMain.handle('dock-files:search',safe(async(_event,params)=>{
  if(params.root!==activeRoot)throw Error('Inactive root');
  const root=await authorized(params.root),query=String(params.query).toLowerCase().slice(0,100),items=[];let visited=0;
  async function visit(dir,depth){
    if(depth>8||visited>1000||items.length>=200)return;
    for(const item of await itemsAt(dir,params.showHidden===true)){
      if(++visited>1000||items.length>=200)break;
      if(item.isDir)await visit(item.path,depth+1);
      else if(item.name.toLowerCase().includes(query))items.push({...item,relativePath:path.relative(root,item.path)});
    }
  }
  await visit(root,0);stats.searches++;return {success:true,data:{items,truncated:false}};
}));
ipcMain.handle('dock-files:qa-info',()=>({roots,activeRoot}));
ipcMain.handle('dock-files:qa-stats',()=>({...stats,activeRoot}));
ipcMain.handle('dock-files:qa-create',async()=>{
  await fs.writeFile(path.join(activeRoot,'fresh-after-refresh.txt'),'Created on disk by the isolated QA fixture.\n');return true;
});
app.whenReady().then(async()=>{
  for(const root of Object.values(roots))await fs.mkdir(root,{recursive:true});
  await fs.mkdir(path.join(roots.current,'docs'),{recursive:true});
  await fs.mkdir(path.join(roots.current,'slow'),{recursive:true});
  await fs.writeFile(path.join(roots.current,'README.md'),'# Workspace Alpha\n\nReal fixture file, read through the restricted Electron bridge.\n');
  await fs.writeFile(path.join(roots.current,'docs','notes.md'),'# Project notes\n\nDOCK_FILES_REAL_PREVIEW: the selected file was read from disk.\n');
  await fs.writeFile(path.join(roots.current,'slow','OLD_ROOT_SENTINEL.txt'),'Old root delayed listing.\n');
  await fs.writeFile(path.join(roots.current,'.hidden.txt'),'Hidden fixture file.\n');
  await fs.writeFile(path.join(roots.alternate,'BETA_ONLY.txt'),'Only the second authorized root.\n');
  await fs.unlink(path.join(roots.current,'fresh-after-refresh.txt')).catch(error=>{if(error.code!=='ENOENT')throw error;});
  const window=new BrowserWindow({width:1100,height:800,webPreferences:{preload:path.join(__dirname,'dock-files-ui-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await window.loadFile(path.join(out,'build/index.html'),{query:{lang:'en'}});
}).catch(error=>{console.error(error);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
