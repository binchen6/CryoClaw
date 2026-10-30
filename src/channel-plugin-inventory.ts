import fs from 'node:fs';
import path from 'node:path';
import {execFile,ChildProcess} from 'node:child_process';

export type ChannelPluginInventory={installed:Set<string>;channels:Map<string,string[]>};
const children=new Set<ChildProcess>();
let quitting=false;
export function cancelChannelPluginInventory():void {
  quitting=true;
  for(const child of children)child.kill();
}
export function parseChannelPluginInventory(value:unknown):ChannelPluginInventory {
  if(!Array.isArray(value))throw new Error('Invalid kernel plugin inventory');
  const installed=new Set<string>(),channels=new Map<string,string[]>();
  for(const plugin of value){
    if(!plugin||typeof plugin.id!=='string'||!plugin.id.trim()||['__proto__','constructor','prototype'].includes(plugin.id)||installed.has(plugin.id)||!Array.isArray(plugin.channels)||plugin.channels.some((name:unknown)=>typeof name!=='string'))throw new Error('Invalid kernel plugin metadata');
    installed.add(plugin.id);
    if(plugin.channels.length)channels.set(plugin.id,[...new Set<string>(plugin.channels)]);
  }
  return {installed,channels};
}
/** Use the kernel's selected manifests, including config/workspace/index recovery. */
export async function readChannelPluginInventory(nodeBin:string,packageDir:string,stateDir:string,config:any,extraEnv:NodeJS.ProcessEnv={},allowErrors=false):Promise<ChannelPluginInventory> {
  if(quitting)throw new Error('Application is quitting');
  const source=fs.readFileSync(path.join(__dirname,'..','shared','channel-plugin-inventory.cjs'),'utf8');
  const env={...process.env,...extraEnv,OPENCLAW_STATE_DIR:stateDir};
  const value=await new Promise<string>((resolve,reject)=>{
    const child=execFile(nodeBin,['--no-warnings','-e',source,'--','cryoclaw-channel-inventory'],{cwd:packageDir,env,windowsHide:true,timeout:30000,maxBuffer:8*1024*1024},(error,stdout,stderr)=>{
      children.delete(child);
      if(error)reject(new Error(stderr.trim()||error.message));else resolve(stdout);
    });
    children.add(child);
    child.stdin?.on('error',()=>{});
    child.stdin?.end(JSON.stringify({distDir:path.join(packageDir,'dist'),config,allowErrors}));
  });
  if(quitting)throw new Error('Application is quitting');
  return parseChannelPluginInventory(JSON.parse(value));
}
