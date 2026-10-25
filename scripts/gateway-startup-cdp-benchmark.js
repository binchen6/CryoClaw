"use strict";
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {arg,launch,quitLaunchedApp,waitForPageTarget,connect,waitForAppReady,waitForGateway}=require('./lib/cdp-harness');
(async()=>{
 const exe=arg(process.argv,'--exe','C:/Users/binchen/AppData/Local/Programs/CryoClaw/CryoClaw.exe');
 const out=path.resolve('out/startup-review',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(out,{recursive:true});
 const manifest=path.join(path.dirname(path.resolve(exe)),'resources','app.asar');let version=null;try{version=JSON.parse(require('@electron/asar').extractFile(manifest,'package.json').toString()).version;}catch{}const report={version,exe:path.resolve(exe),label:arg(process.argv,'--label','unlabeled'),runs:[],error:null};
 for(let n=0;n<Number(arg(process.argv,'--runs','3'));n++){
  let ws,cdp;const started=Date.now(),port=9280+n,running=launch(exe,port),row={windowMs:null,healthzMs:null,readyzMs:null,readyMs:null,quitMs:null,gracefulExit:false};
  try{
   const health=waitForGateway('http://127.0.0.1:18789/healthz',240000,150).then(ok=>{if(ok)row.healthzMs=Date.now()-started;return ok;});
   const ready=waitForGateway('http://127.0.0.1:18789/readyz',240000,150).then(ok=>{if(ok)row.readyzMs=Date.now()-started;return ok;});
   const page=await waitForPageTarget(port);assert.ok(page,'app page');row.windowMs=Date.now()-started;({ws,cdp}=await connect(page));
   assert.ok(await waitForAppReady(cdp,{timeoutMs:240000}),'usable session data');row.readyMs=Date.now()-started;assert.ok(await health,'healthz endpoint');assert.ok(await ready,'readyz endpoint');
  }catch(error){report.error=String(error.stack||error);throw error;}
  finally{
   const quitStarted=Date.now();await quitLaunchedApp(running,cdp);row.quitMs=Date.now()-quitStarted;row.gracefulExit=running.child.exitCode===0;ws?.close();report.runs.push(row);
   fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,run:n+1,...row,error:report.error}));
  }
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
