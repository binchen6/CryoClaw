'use strict';
const fs=require('node:fs'),path=require('node:path');

function syncNativeKernelVersion(resources,io=fs){
 const marker=path.join(resources,'runtime','cryoclaw-runtime.json');
 if(!io.existsSync(marker))return false;
 const policy=JSON.parse(io.readFileSync(marker,'utf8'));
 if(policy.kind!=='node'||policy.gatewayMode!=='loose')throw Error('Invalid bundled gateway runtime policy');
 const core=path.join(resources,'gateway','node_modules','openclaw'),pkg=JSON.parse(io.readFileSync(path.join(core,'package.json'),'utf8'));
 if(typeof pkg.version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)||!io.existsSync(path.join(core,'openclaw.mjs'))||!io.statSync(path.join(core,'openclaw.mjs')).isFile())throw Error('Incomplete physical gateway directory');
 if(!io.statSync(path.join(resources,'runtime',process.platform==='win32'?'node.exe':'node')).isFile())throw Error('Bundled gateway Node runtime is missing');
 if(policy.kernelVersion===pkg.version)return false;
 const temporary=marker+'.tmp-'+process.pid;
 try{
  io.writeFileSync(temporary,JSON.stringify({...policy,kernelVersion:pkg.version})+'\n',{flush:true});
  io.renameSync(temporary,marker);
 }finally{io.rmSync(temporary,{force:true});}
 return true;
}
module.exports={syncNativeKernelVersion};
