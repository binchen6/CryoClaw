const test=require('node:test'),assert=require('node:assert/strict');
const {summarizeInstallReport,compareInstallReports,readInstallMeasurement}=require('./install-performance-benchmark');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('same-version installation cannot reuse an older installer timing file',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'install-measurement-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'install-performance.json');fs.writeFileSync(file,JSON.stringify({payloadMode:'entry-rename',initCompletedMs:20,oldUninstallCompletedMs:50,payloadReadyMs:80,installMs:100,completionMs:130}));
 const writtenAt=fs.statSync(file).mtimeMs;
 assert.throws(()=>readInstallMeasurement(file,writtenAt+2000),/Fresh installer timing/);
 assert.equal(readInstallMeasurement(file,writtenAt-1000).payloadMode,'entry-rename');
 fs.writeFileSync(file,JSON.stringify({payloadMode:'entry-rename',initCompletedMs:20,oldUninstallCompletedMs:50,payloadReadyMs:120,installMs:100,completionMs:130}));
 assert.throws(()=>readInstallMeasurement(file,0),/timing order/);
 fs.writeFileSync(file,JSON.stringify({payloadMode:'entry-rename',payloadReadyMs:80,installMs:100}));
 assert.throws(()=>readInstallMeasurement(file,0),/phase timing/);
});
function report(wall,install,payload){return {version:'1.2.3',runs:wall.map((wallMs,index)=>({ok:true,wallMs,initCompletedMs:10,oldUninstallCompletedMs:20,payloadReadyMs:payload[index],installMs:install[index],completionMs:install[index]+15,payloadMode:'rename'})),ok:true};}
test('install summary separates wall, payload and complete install timings',()=>{
 const summary=summarizeInstallReport(report([100000,120000,110000],[90000,100000,95000],[80000,85000,82000]));
 assert.equal(summary.wallMedianMs,110000);assert.equal(summary.installerMedianMs,95000);assert.equal(summary.payloadMedianMs,82000);assert.equal(summary.renameRuns,3);
});
test('install summary separates initialization, old removal, extraction and post-payload work',()=>{
 const input=report([100000,120000,110000],[90000,100000,95000],[80000,85000,82000]);
 input.runs.forEach((row,index)=>Object.assign(row,{initCompletedMs:[10,20,30][index],oldUninstallCompletedMs:[40,60,80][index],completionMs:[110000,130000,115000][index]}));
 const phases=summarizeInstallReport(input).phaseMediansMs;
 assert.deepEqual(phases,{initializationMs:20,oldUninstallMs:40,payloadPreparationMs:81920,postPayloadMs:13000,completionMs:20000});
});
test('install comparison measures wall and installer reductions independently',()=>{
 const result=compareInstallReports(report([100000,120000,110000],[90000,100000,95000],[80000,85000,82000]),report([40000,50000,45000],[30000,40000,35000],[20000,30000,25000]));
 assert.ok(result.wallReductionPercent>50);assert.ok(result.installerReductionPercent>50);assert.ok(result.payloadReductionPercent>60);
});
test('failed install samples cannot be summarized',()=>{assert.throws(()=>summarizeInstallReport({runs:[{ok:false}]}),/failed/);});
test('whole-directory and top-level entry moves are reported separately from copies',()=>{
 const input=report([100,200,300],[90,190,290],[80,180,280]);
 input.runs[1].payloadMode='entry-rename';input.runs[2].payloadMode='copy';
 const result=summarizeInstallReport(input);
 assert.equal(result.renameRuns,1);assert.equal(result.entryRenameRuns,1);assert.equal(result.copyRuns,1);
});

test('install reclaim is validated and reported separately from installation time',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'install-reclaim-measurement-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'install-performance.json');fs.writeFileSync(file,JSON.stringify({payloadMode:'rename',initCompletedMs:20,oldUninstallCompletedMs:50,payloadReadyMs:80,installMs:100,completionMs:130,reclaimPending:1,reclaimState:'pending'}));
 const pending=readInstallMeasurement(file,0);assert.equal(pending.reclaimPending,true);assert.equal(pending.reclaimState,'pending');assert.equal(pending.reclaimMs,null);
 fs.writeFileSync(file,JSON.stringify({payloadMode:'rename',initCompletedMs:20,oldUninstallCompletedMs:50,payloadReadyMs:80,installMs:100,completionMs:130,reclaimPending:true,reclaimState:'complete'}));
 assert.throws(()=>readInstallMeasurement(file,0),/flag and state disagree/);
 const input=report([100,200,300],[90,190,290],[80,180,280]);input.runs.forEach((row,index)=>Object.assign(row,{reclaimPending:index!==0,reclaimState:index===0?'complete':'pending',reclaimMs:index===0?40:null}));
 const summary=summarizeInstallReport(input);assert.equal(summary.pendingReclaimRuns,2);assert.equal(summary.completedReclaimRuns,1);assert.equal(summary.reclaimMs,40);
});
