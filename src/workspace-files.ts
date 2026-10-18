import * as fs from "node:fs/promises";
import * as path from "node:path";
import {createHash,randomUUID} from "node:crypto";
export const WORKSPACE_TEXT_LIMIT=1024*1024;
export async function readWorkspaceText(target:string){
  const handle=await fs.open(target,"r");
  try {
    const stat=await handle.stat();if(!stat.isFile() || stat.size>WORKSPACE_TEXT_LIMIT)throw new Error("文件过大或不是普通文件（文本上限 1 MiB）");
    const buffer=Buffer.allocUnsafe(WORKSPACE_TEXT_LIMIT+1);let size=0;
    while(size<buffer.length){const result=await handle.read(buffer,size,buffer.length-size,size);if(!result.bytesRead)break;size+=result.bytesRead;}
    if(size>WORKSPACE_TEXT_LIMIT)throw new Error("文件超过文本预览上限 1 MiB");
    const data=buffer.subarray(0,size);if(data.includes(0))throw new Error("二进制文件或不支持的文本编码");
    try{new TextDecoder("utf-8",{fatal:true}).decode(data);}catch{throw new Error("不支持的文本编码，请使用 UTF-8 文件");}
    return {content:data.toString("utf8"),hash:createHash("sha256").update(data).digest("hex"),size,mtimeMs:stat.mtimeMs,mode:stat.mode};
  }finally{await handle.close();}
}
export async function saveWorkspaceText(target:string,content:string,baseHash:string,revalidate:()=>Promise<boolean>){
  if(typeof content!=="string" || content.includes("\0") || Buffer.byteLength(content)>WORKSPACE_TEXT_LIMIT || !/^[a-f0-9]{64}$/.test(baseHash))throw new Error("无效的文件内容或版本，请重新加载文件");
  if(!await revalidate())throw new Error("Access denied");
  const stat=await fs.lstat(target);if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink>1)throw new Error("不能编辑链接或非普通文件");
  const before=await readWorkspaceText(target);if(before.hash!==baseHash)return {success:false,conflict:true,message:"文件已被其他程序修改，请重新加载后再保存。"};
  const temporary=path.join(path.dirname(target),`.cryoclaw-edit-${randomUUID()}.tmp`);
  try {
    const handle=await fs.open(temporary,"wx",before.mode&0o777);
    try{await handle.writeFile(content,"utf8");await handle.sync();}finally{await handle.close();}
    if(!await revalidate())throw new Error("Access denied");
    const latest=await readWorkspaceText(target);
    if(latest.hash!==baseHash)return {success:false,conflict:true,message:"保存前检测到文件变化，原文件未被覆盖。"};
    await fs.rename(temporary,target);
    return {success:true,data:{hash:createHash("sha256").update(content).digest("hex"),size:Buffer.byteLength(content)}};
  }finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
}
function draftPath(target:string,stateDir:string){return path.join(stateDir,"editor-drafts",createHash("sha256").update(target).digest("hex")+".json");}
export async function readWorkspaceDraft(target:string,stateDir:string){
  let handle;
  try {
    handle=await fs.open(draftPath(target,stateDir),"r");const stat=await handle.stat();if(stat.size>8*WORKSPACE_TEXT_LIMIT)return null;
    const buffer=Buffer.alloc(stat.size+1);let size=0;
    while(size<buffer.length){const read=await handle.read(buffer,size,buffer.length-size,size);if(!read.bytesRead)break;size+=read.bytesRead;}
    if(size>stat.size)return null;const data=JSON.parse(buffer.subarray(0,size).toString("utf8"));
    return data.path===target && typeof data.draft==="string" && Buffer.byteLength(data.draft)<=WORKSPACE_TEXT_LIMIT && /^[a-f0-9]{64}$/.test(data.baseHash)?{draft:data.draft as string,baseHash:data.baseHash as string}:null;
  }catch{return null;}finally{await handle?.close();}
}
export async function writeWorkspaceDraft(target:string,stateDir:string,draft:string|null,baseHash:string){
  const filename=draftPath(target,stateDir);if(draft===null){await fs.rm(filename,{force:true});return;}
  if(typeof draft!=="string" || Buffer.byteLength(draft)>WORKSPACE_TEXT_LIMIT || !/^[a-f0-9]{64}$/.test(baseHash))throw new Error("草稿超过上限或缺少文件版本");
  await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});const temporary=filename+"."+randomUUID();
  try{await fs.writeFile(temporary,JSON.stringify({path:target,draft,baseHash}),{mode:0o600,flag:"wx"});await fs.rename(temporary,filename);}finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
}
export async function findWorkspaceFiles(root:string,query:string,showHidden=false,cancelled=()=>false){
  const items:Array<{name:string;path:string;isDir:boolean;relativePath:string}>=[];const queue=[root];let visited=0,truncated=false;
  const normalized=query.trim().toLowerCase();if(!normalized)return {items,truncated};
  const started=Date.now();
  while(queue.length){
    if(cancelled())return {items:[],truncated:false,cancelled:true};
    if(visited>=12000 || Date.now()-started>1500 || items.length>=200){truncated=true;break;}
    const directory=queue.shift()!;let handle;
    try{handle=await fs.opendir(directory);}catch{continue;}
    for await(const item of handle){
      if(++visited>12000 || items.length>=200){truncated=true;break;}
      if(visited%64===0 && (cancelled() || Date.now()-started>1500)){truncated=true;break;}
      if(item.isSymbolicLink() || (!showHidden && (item.name.startsWith(".") || ["node_modules","dist","build","vendor"].includes(item.name))))continue;
      const filename=path.join(directory,item.name),relativePath=path.relative(root,filename);
      if(relativePath.toLowerCase().includes(normalized))items.push({name:item.name,path:filename,isDir:item.isDirectory(),relativePath});
      if(item.isDirectory())queue.push(filename);
    }
  }
  return {items:items.sort((a,b)=>a.relativePath.localeCompare(b.relativePath)),truncated};
}
