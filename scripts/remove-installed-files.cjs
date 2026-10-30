'use strict';
const fs=require('node:fs'),path=require('node:path');

// The uninstaller waits for this process, then removes the retained Node binary.
// No deferred deletion: installation cannot race a background cleanup process.
async function removeInstalledFiles(root, executable=process.execPath) {
  const resolved=path.resolve(root),retained=path.resolve(executable);
  const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
  const expected=path.join(resolved,'resources','resources','runtime',process.platform==='win32'?'node.exe':'node');
  if(!path.isAbsolute(root)||same(resolved,path.parse(resolved).root)||!same(retained,expected))throw Error('Installation runtime ownership mismatch');
  const stat=fs.lstatSync(resolved);
  if(!stat.isDirectory()||stat.isSymbolicLink()||!same(fs.realpathSync.native(resolved),resolved))throw Error('Installation root is not a physical canonical directory');
  const retainedFiles=[path.join(resolved,'CryoClaw.exe'),path.join(resolved,'resources','app.asar'),retained];
  for(const file of retainedFiles){
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||!same(fs.realpathSync.native(file),file))throw Error('Installation marker is not a physical file');
  }
  const errors=[];
  async function remove(dir){
    for(const entry of await fs.promises.readdir(dir,{withFileTypes:true})){
      const target=path.join(dir,entry.name);
      if(retainedFiles.some(file=>same(target,file)))continue;
      const relative=path.relative(target,retained);
      if(entry.isDirectory()&&!entry.isSymbolicLink()&&relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))await remove(target);
      else try{await fs.promises.rm(target,{recursive:true,force:true,maxRetries:0});}catch(error){errors.push({code:error.code??'UNKNOWN'});}
    }
  }
  try{await remove(resolved);}catch(error){errors.push({code:error.code??'UNKNOWN'});}
  return {ok:errors.length===0,errors};
}
module.exports={removeInstalledFiles};
if(require.main===module)removeInstalledFiles(process.argv[2]??'').then(result=>{process.exitCode=result.ok?0:1;},error=>{console.error(error.message);process.exitCode=2;});
