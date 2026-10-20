"use strict";
const fs=require('node:fs'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
function runSuite(suite,{root,outDir,timeoutMs=600000}){
  const started=Date.now(),log=path.join(outDir,`${suite.id}.log`),fd=fs.openSync(log,'w');
  return new Promise(resolve=>{
    const child=spawn(process.execPath,suite.args,{cwd:root,env:process.env,stdio:['ignore',fd,fd],windowsHide:true,detached:process.platform!=='win32'});
    let finished=false,timedOut=false;
    const finish=(code,error)=>{if(finished)return;finished=true;clearTimeout(timer);fs.closeSync(fd);resolve({id:suite.id,ok:code===0&&!timedOut,code,timedOut,error:error?.message,elapsedMs:Date.now()-started,log});};
    const timer=setTimeout(()=>{timedOut=true;try{if(process.platform==='win32')execFileSync('taskkill',['/F','/T','/PID',String(child.pid)],{stdio:'ignore',timeout:5000});else process.kill(-child.pid,'SIGKILL');}catch{}},timeoutMs);
    child.once('error',error=>finish(null,error));child.once('close',code=>finish(code));
  });
}
async function runSuites(suites,options={}){
  const {concurrency=2,execute=runSuite,onResult=()=>{}}=options;
  if(!Number.isInteger(concurrency)||concurrency<1)throw Error('Invalid test concurrency');
  const results=new Array(suites.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(concurrency,suites.length)},async()=>{
    while(cursor<suites.length){const i=cursor++;try{results[i]=await execute(suites[i],options);}catch(error){results[i]={id:suites[i].id,ok:false,error:error.message};}onResult(results[i]);}
  }));return {ok:results.every(result=>result.ok),results};
}
module.exports={runSuite,runSuites};
