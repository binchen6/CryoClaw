"use strict";
const {spawn,execFileSync}=require('node:child_process');

/** A ready signal ends the probe only after its process tree has stopped. */
function probeProcess(executable,args,{env,cwd,isReady,timeoutMs=30000,maxOutput=64000}={}){
  return new Promise(resolve=>{
    const child=spawn(executable,args,{env,cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',settled=false,timer;
    const finish=(kind)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(child.exitCode===null && child.pid){
        if(process.platform==='win32'){
          try{execFileSync('taskkill',['/F','/T','/PID',String(child.pid)],{stdio:'ignore',timeout:5000});}catch{}
        }
        // Sandbox policy can deny taskkill; the process handle still owns this child.
        try{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}catch{}
      }
      const result={kind,stdout,stderr};
      if(child.exitCode!==null || !child.pid)resolve(result);
      else {
        const fallback=setTimeout(()=>{const stopped=child.exitCode!==null||child.signalCode!==null;child.stdout?.destroy();child.stderr?.destroy();child.unref();resolve(stopped?result:{...result,kind:'cleanup-failed'});},1500);
        child.once('close',()=>{clearTimeout(fallback);resolve(result);});
      }
    };
    const output=(stream,chunk)=>{
      if(stream==='stdout')stdout=(stdout+chunk.toString('utf8')).slice(-maxOutput);
      else stderr=(stderr+chunk.toString('utf8')).slice(-maxOutput);
      if(isReady?.({stdout,stderr}))finish('ready');
    };
    child.stdout.on('data',chunk=>output('stdout',chunk));child.stderr.on('data',chunk=>output('stderr',chunk));
    child.once('error',error=>{stderr=(stderr+'\n'+error.message).slice(-maxOutput);finish('spawn-error');});
    child.once('close',code=>finish(`exit:${code}`));
    timer=setTimeout(()=>finish('timeout'),timeoutMs);
  });
}
module.exports={probeProcess};
