"use strict";
const fs=require('node:fs'),path=require('node:path');
// Reuse only the installed Windows distribution matching both the resolved package and target PE machine.
function localElectronDist(root,version,arch){
  const relative='node_modules/electron/dist',dir=path.join(root,relative);
  let fd;
  try{
    if(fs.readFileSync(path.join(dir,'version'),'utf8').trim()!==version)return null;
    const expected=arch==='x64'?0x8664:arch==='arm64'?0xaa64:0;
    if(!expected)return null;
    fd=fs.openSync(path.join(dir,'electron.exe'),'r');const head=Buffer.alloc(64),pe=Buffer.alloc(6);
    if(fs.readSync(fd,head,0,64,0)!==64 || head.readUInt16LE(0)!==0x5a4d)return null;
    if(fs.readSync(fd,pe,0,6,head.readUInt32LE(0x3c))!==6 || pe.readUInt32LE(0)!==0x4550 || pe.readUInt16LE(4)!==expected)return null;
    return relative;
  }catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
module.exports={localElectronDist};
