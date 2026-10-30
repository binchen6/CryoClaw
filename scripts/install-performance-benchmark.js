#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn,execFile}=require('node:child_process'),{promisify}=require('node:util'),{performance}=require('node:perf_hooks');
const {stageInstaller}=require('./lib/stage-installer'),{summarizeTree}=require('./distribution-size-report');
const exec=promisify(execFile),median=values=>{assert.ok(values.length,'Missing install samples');const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;return n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2;};
function readInstallMeasurement(file,startedAtMs){
 const descriptor=fs.openSync(file,'r');let record,stat;
 try{stat=fs.fstatSync(descriptor);record=JSON.parse(fs.readFileSync(descriptor,'utf8'));}finally{fs.closeSync(descriptor);}
 assert.ok(stat.mtimeMs>=startedAtMs,'Fresh installer timing was not written by this installation');
 assert.ok(['rename','entry-rename','copy'].includes(record.payloadMode),'Unknown payload installation mode');
 assert.ok(Number.isFinite(record.installMs)&&Number.isFinite(record.payloadReadyMs)&&record.payloadReadyMs>=0&&record.installMs>=record.payloadReadyMs,'Invalid installer timing order');
 assert.ok(Number.isFinite(record.initCompletedMs)&&Number.isFinite(record.completionMs)&&Number.isFinite(record.oldUninstallCompletedMs),'Missing installer phase timing');
 assert.ok(record.initCompletedMs>=0&&record.payloadReadyMs>=record.initCompletedMs&&record.completionMs>=record.installMs,'Invalid installer timing order');
 assert.ok(record.oldUninstallCompletedMs===-1||record.oldUninstallCompletedMs>=record.initCompletedMs&&record.oldUninstallCompletedMs<=record.payloadReadyMs,'Invalid old uninstall timing');
 const reclaimState=record.reclaimState??(record.reclaimPending===true||record.reclaimPending===1?'pending':'none');
 assert.ok(['none','pending','complete'].includes(reclaimState),'Invalid install reclaim state');
 const reclaimPending=record.reclaimPending===true||record.reclaimPending===1||reclaimState==='pending';
 if(record.reclaimPending!==undefined){assert.ok(record.reclaimPending===true||record.reclaimPending===false||record.reclaimPending===0||record.reclaimPending===1,'Invalid reclaimPending flag');assert.equal(reclaimPending,reclaimState==='pending','Reclaim flag and state disagree');}
 const reclaimMs=record.reclaimMs===undefined||record.reclaimMs===null?null:record.reclaimMs;
 assert.ok(reclaimMs===null||Number.isFinite(reclaimMs)&&reclaimMs>=0,'Invalid reclaim timing');
 return {...record,reclaimPending,reclaimState,reclaimMs,measurementWrittenAtMs:stat.mtimeMs};
}
function summarizeInstallReport(report){
 assert.ok(report.runs.length&&report.runs.every(row=>row.ok),'Cannot summarize failed installs');
 const hasPhases=report.runs.every(row=>Number.isFinite(row.initCompletedMs)&&Number.isFinite(row.oldUninstallCompletedMs)&&Number.isFinite(row.completionMs)),oldRuns=report.runs.filter(row=>row.oldUninstallCompletedMs>=0);
 const phaseMediansMs=hasPhases?{initializationMs:median(report.runs.map(row=>row.initCompletedMs)),oldUninstallMs:oldRuns.length?median(oldRuns.map(row=>row.oldUninstallCompletedMs-row.initCompletedMs)):null,payloadPreparationMs:median(report.runs.map(row=>row.payloadReadyMs-Math.max(row.initCompletedMs,row.oldUninstallCompletedMs))),postPayloadMs:median(report.runs.map(row=>row.installMs-row.payloadReadyMs)),completionMs:median(report.runs.map(row=>row.completionMs-row.installMs))}:null;
 const reclaimSamples=report.runs.map(row=>row.reclaimMs).filter(Number.isFinite);
 return {runs:report.runs.length,wallMedianMs:median(report.runs.map(row=>row.wallMs)),installerMedianMs:median(report.runs.map(row=>row.installMs)),payloadMedianMs:median(report.runs.map(row=>row.payloadReadyMs)),phaseMediansMs,renameRuns:report.runs.filter(row=>row.payloadMode==='rename').length,entryRenameRuns:report.runs.filter(row=>row.payloadMode==='entry-rename').length,copyRuns:report.runs.filter(row=>row.payloadMode==='copy').length,pendingReclaimRuns:report.runs.filter(row=>row.reclaimPending).length,completedReclaimRuns:report.runs.filter(row=>row.reclaimState==='complete').length,reclaimMs:reclaimSamples.length?median(reclaimSamples):null,version:report.version,installTree:report.installTree??null};
}
function compareInstallReports(baseline,candidate){const a=summarizeInstallReport(baseline),b=summarizeInstallReport(candidate);return {wallReductionPercent:(1-b.wallMedianMs/a.wallMedianMs)*100,installerReductionPercent:(1-b.installerMedianMs/a.installerMedianMs)*100,payloadReductionPercent:(1-b.payloadMedianMs/a.payloadMedianMs)*100,baseline:a,candidate:b};}
async function preflight(){const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name='CryoClaw.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress"],{windowsHide:true,timeout:15000});const existing=JSON.parse(stdout.trim()||'null');assert.ok(!existing||Array.isArray(existing)&&existing.length===0,'Close the running CryoClaw app before the install benchmark');}
async function main(argv=process.argv){
 if(argv.includes('--help')){console.log('node scripts/install-performance-benchmark.js --installer <Setup.exe> --version <version> [--runs 3] [--install-dir <directory>] --out <directory>');return;}
 assert.equal(process.platform,'win32','Install benchmark requires Windows');const option=(name,fallback)=>{const index=argv.indexOf(name);return index>=0?argv[index+1]:fallback};
 const installer=path.resolve(option('--installer','')),expected=option('--version',''),runs=Number(option('--runs','3')),out=path.resolve(option('--out',path.join('out','install-performance',new Date().toISOString().replace(/[:.]/g,'-')))),installDir=path.resolve(option('--install-dir',path.join(process.env.LOCALAPPDATA||'','Programs','CryoClaw')));assert.ok(fs.existsSync(installer),'Installer not found');assert.ok(expected,'Pass --version');assert.ok(Number.isInteger(runs)&&runs>=1&&runs<=5,'--runs must be between 1 and 5');
 const report={schemaVersion:1,installer,expectedVersion:expected,installDir,runs:[],ok:false};fs.mkdirSync(out,{recursive:true});const write=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));write();
 try{for(let index=0;index<runs;index++){await preflight();const staged=await stageInstaller(installer),row={run:index+1,ok:false};report.runs.push(row);write();
  try{const startedAtMs=Date.now(),started=performance.now(),args=['/S',...(argv.includes('--install-dir')?[`/D=${installDir}`]:[])];row.startedAtMs=startedAtMs;const code=await new Promise((resolve,reject)=>{const child=spawn(staged.target,args,{stdio:'ignore',shell:false,windowsHide:true,env:{...process.env,TEMP:staged.tempRoot,TMP:staged.tempRoot}});const timer=setTimeout(()=>{child.kill();reject(Error('Install timed out'));},30*60_000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve(code):reject(Error('Installer exit code: '+code));});});row.wallMs=performance.now()-started;assert.equal(code,0);
   const archive=path.join(installDir,'resources','app.asar'),pkg=JSON.parse(require('@electron/asar').extractFile(archive,'package.json').toString('utf8'));assert.equal(pkg.version,expected,'Installed version mismatch');
   const performanceFile=path.join(installDir,'resources','install-performance.json');Object.assign(row,readInstallMeasurement(performanceFile,startedAtMs));row.ok=true;
  }catch(error){row.error=String(error.stack||error);throw error;}finally{await staged.cleanup();}
  write();console.log(JSON.stringify({run:index+1,ok:row.ok,wallMs:row.wallMs,installMs:row.installMs,payloadReadyMs:row.payloadReadyMs}));
 }
 report.version=expected;report.installTree=await summarizeTree(installDir);report.ok=true;report.summary=summarizeInstallReport(report);
 }catch(error){report.error=String(error.stack||error);throw error;}finally{report.finishedAt=new Date().toISOString();write();}
 console.log(JSON.stringify({ok:report.ok,summary:report.summary,out}));
}
module.exports={median,summarizeInstallReport,compareInstallReports,readInstallMeasurement,main};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
