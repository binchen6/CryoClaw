"use strict";
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pipeline}=require('node:stream/promises');

// Create a new file inheriting the approved host's Temp-directory integrity label.
// Copy data through streams rather than carrying workspace security attributes along.
async function stageInstaller(source,parent=process.platform==='win32' && process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'Temp'):os.tmpdir()){
  const dir=await fs.promises.mkdtemp(path.join(parent,'cryoclaw-install-'));
  const target=path.join(dir,path.basename(source));
  const cleanup=async()=>{await fs.promises.unlink(target).catch(e=>{if(e.code!=='ENOENT')throw e;});await fs.promises.rmdir(dir);};
  try{await pipeline(fs.createReadStream(source),fs.createWriteStream(target,{flags:'wx',mode:0o700}));}
  catch(error){await cleanup().catch(()=>{});throw error;}
  return {target,tempRoot:path.resolve(parent),cleanup};
}
module.exports={stageInstaller};
