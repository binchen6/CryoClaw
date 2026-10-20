"use strict";
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {pipeline}=require('node:stream/promises');
async function stageElectronRuntime(source,parent=process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'Temp'):os.tmpdir()){
  const tempRoot=path.resolve(parent),dir=await fs.promises.mkdtemp(path.join(tempRoot,'cryoclaw-ui-runtime-'));
  const cleanup=async()=>{
    if(path.dirname(path.resolve(dir))!==tempRoot || !path.basename(dir).startsWith('cryoclaw-ui-runtime-'))throw Error('Invalid runtime cleanup target');
    await fs.promises.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  };
  async function copy(from,to){
    await fs.promises.mkdir(to,{recursive:true});
    for(const entry of await fs.promises.readdir(from,{withFileTypes:true})){
      const input=path.join(from,entry.name),output=path.join(to,entry.name);
      if(entry.isSymbolicLink())throw Error('Unexpected link in Windows runtime');
      if(entry.isDirectory())await copy(input,output);
      else await pipeline(fs.createReadStream(input),fs.createWriteStream(output,{flags:'wx',mode:0o700}));
    }
  }
  try{await copy(path.dirname(path.resolve(source)),dir);return {exe:path.join(dir,path.basename(source)),cleanup};}
  catch(error){await cleanup().catch(()=>{});throw error;}
}
module.exports={stageElectronRuntime};
