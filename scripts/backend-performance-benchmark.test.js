const test=require('node:test');
const assert=require('node:assert/strict');
const {summarizeReport,compareReports,summarizeResources,validateRpcResult,startResourceSampler,parsePluginStartupIntervals,main}=require('./backend-performance-benchmark');

test('temporary gateway staging is rejected because plugin peer links outlive it',async()=>{
 await assert.rejects(main(['--stage-runtime']),/peer links/);
});

const launchWallClockMs=Date.parse('2026-10-29T23:47:00.000Z');
function phaseLog(receivedMs,name,durationMs,totalMs){return `[${new Date(launchWallClockMs+receivedMs).toISOString()}] stdout: 2026-10-30T07:49:15.751+08:00 [gateway] startup phase: ${name} ${durationMs}ms total=${totalMs}ms`;}

test('plugin phase accounting aligns native time and merges nested intervals once',()=>{
 const phases=parsePluginStartupIntervals([
  phaseLog(11000,'cli.bootstrap.plugin-plan',100,1000),
  phaseLog(14500,'plugins.nested',1000,4500),
  phaseLog(15000,'plugins.runtime-post-bind',2000,5000),
 ].join('\n'),20000,launchWallClockMs);
 assert.equal(phases.complete,true);assert.equal(phases.clockAligned,true);assert.equal(phases.elapsedMs,2100);
 assert.deepEqual(phases.intervals,[{startMs:10901,endMs:11001},{startMs:13001,endMs:15001}]);
});

test('native phases completed after app readyz never reduce other startup even when native total is smaller',()=>{
 const log=[phaseLog(115000,'plugins.runtime-post-bind',5000,101225.7),phaseLog(135751,'startup.maintenance.plugin-registry',6302.2,121976.7)].join('\n');
 const plugin=parsePluginStartupIntervals(log,130000,launchWallClockMs);
 assert.equal(plugin.complete,true);assert.equal(plugin.elapsedMs,5000);
 assert.deepEqual(plugin.phases.map(p=>p.name),['plugins.runtime-post-bind']);
 const a=report(),b=report([42000,42000,42000]);
 b.runs.forEach(r=>{r.readyzMs=130000;r.capabilitiesReadyMs=130000;r.pluginStartup=plugin;});
 assert.equal(compareReports(a,b).otherStartupMaxMs,125000);
 assert.equal(compareReports(a,b).otherStartupEveryRunWithinBudget,false);
});

test('receipt delays use one conservative origin and preserve overlaps across stdout continuation lines',()=>{
 const log=[phaseLog(11000,'cli.bootstrap.plugin-plan',100,1000),phaseLog(15000,'plugins.nested',1000,4500),
  '2026-10-30T07:49:15.751+08:00 [gateway] startup phase: plugins.runtime-post-bind 2000ms total=5000ms'].join('\n');
 const result=parsePluginStartupIntervals(log,20000,launchWallClockMs);
 assert.equal(result.complete,true);assert.equal(result.elapsedMs,2100);
 assert.deepEqual(result.intervals,[{startMs:11401,endMs:11501},{startMs:13501,endMs:15501}]);
 const boundary=parsePluginStartupIntervals(phaseLog(15000,'plugins.runtime-post-bind',2000,5000),15000,launchWallClockMs);
 assert.equal(boundary.complete,false);assert.equal(boundary.elapsedMs,0,'Receipt millisecond precision must not exclude work that could finish after readyz');
});

test('native bracketed continuation lines retain their chunk receipt but parent events retire it',()=>{
 const continuation='[gateway] startup phase: plugins.runtime-post-bind 2000ms total=5000ms';
 const log=[phaseLog(15000,'plugins.nested',1000,4500),'[plugins] native continuation',continuation].join('\n');
 const result=parsePluginStartupIntervals(log,20000,launchWallClockMs);
 assert.equal(result.complete,true);assert.equal(result.clockAligned,true);assert.equal(result.elapsedMs,2000);
 const parent=`[${new Date(launchWallClockMs+16000).toISOString()}] state: running`;
 const missing=parsePluginStartupIntervals([phaseLog(15000,'plugins.nested',1000,4500),parent,continuation].join('\n'),20000,launchWallClockMs);
 assert.equal(missing.complete,false);assert.equal(missing.elapsedMs,0);
});

test('plugin phase accounting refuses missing clocks, incomplete startup and restarted native traces',()=>{
 const completed=phaseLog(15000,'plugins.runtime-post-bind',2000,5000);
 for(const [log,clock]of [[completed,undefined],['startup phase: plugins.runtime-post-bind 2000ms total=5000ms',launchWallClockMs],['',launchWallClockMs],
  [completed+'\n'+phaseLog(16000,'plugins.restarted',100,1000),launchWallClockMs],
  ['--- gateway start ---\n'+completed+'\n--- gateway start ---',launchWallClockMs],
  ['spawn: node.exe gateway run (gen=1)\n'+completed+'\nspawn: node.exe gateway run (gen=2)',launchWallClockMs],
  [completed+'\n'+phaseLog(14000,'plugins.backwards-clock',100,6000),launchWallClockMs],
  [phaseLog(15000,'plugins.runtime-post-bind','starting',5000),launchWallClockMs]]){
  const result=parsePluginStartupIntervals(log,20000,clock);
  assert.equal(result.complete,false);assert.equal(result.elapsedMs,0);
 }
 const a=report(),b=report([42000,42000,42000]);
 b.runs.forEach(r=>{r.readyzMs=59000;r.capabilitiesReadyMs=60000;r.pluginStartup={complete:true,elapsedMs:11000};});
 assert.equal(compareReports(a,b).otherStartupEveryRunWithinBudget,false,'Legacy unaligned phase totals cannot pass the gate');
 b.runs[0].ok=false;assert.throws(()=>compareReports(a,b),/Failed/);
});

function report(overall=[100000,120000,110000]){
 return {schemaVersion:1,ok:true,mode:'launch',diagnostic:false,workloadFingerprint:'fixed-workload',responseShapeFingerprint:'response-shapes',configFingerprint:'same-secret-config-hash',machineFingerprint:'machine',stateDirectoryFingerprint:'state',cachePolicy:'existing-unreset-no-prewarm',runtime:{nodeVersion:'24.22.1',kernelVersion:'2026.10.6',electronVersion:'43.8.3'},runs:overall.map((overallMs,i)=>({ok:true,overallMs,pluginStartup:{complete:true,clockAligned:true,elapsedMs:0},readyzMs:60000+i*1000,usableMs:70000,firstRpcBatchMs:1000,gracefulExit:true,steady:{elapsedMs:1000,count:5,latencies:[1,2,3,4,100]},resources:{gatewayObservedCpuMs:10000,gatewayPeakWorkingSetBytes:1000000,gatewayPeakPrivateBytes:2000000}}))};
}
test('overall summary keeps first startup and RPC costs and aggregates actual latency samples',()=>{
 const summary=summarizeReport(report());
 assert.equal(summary.overallMedianMs,110000);assert.equal(summary.gatewayReadyMedianMs,61000);assert.equal(summary.steadyP95Ms,100);assert.equal(summary.steadyThroughputMedianPerSecond,5);
});
test('resource summary describes one process and rejects PID changes or missing samples',()=>{
 const r=summarizeResources([{pid:42,atMs:0,cpuMs:10,workingSetBytes:50,peakWorkingSetBytes:70,privateBytes:80},{pid:42,atMs:100,cpuMs:70,workingSetBytes:65,peakWorkingSetBytes:90,privateBytes:100}]);
 assert.equal(r.gatewayObservedCpuMs,70);assert.equal(r.gatewayPeakWorkingSetBytes,90);assert.equal(r.gatewayCpuIntervalOneCorePercent,60);
 assert.throws(()=>summarizeResources([]),/samples/);assert.throws(()=>summarizeResources([{pid:42},{pid:43}]),/identity/);
});
test('comparison refuses altered work, secrets/config, caches, runtime, machine, failed and attached runs',()=>{
 const a=report(),b=report([40000,45000,42000]);
 for(const [key,value]of [['workloadFingerprint','other'],['responseShapeFingerprint','different-responses'],['configFingerprint','changed'],['cachePolicy','prewarmed'],['machineFingerprint','other'],['stateDirectoryFingerprint','other'],['mode','attach'],['diagnostic',true],['ok',false]]){
  assert.throws(()=>compareReports(a,{...b,[key]:value}),/comparable|failed|launch|diagnostic/);
 }
 assert.throws(()=>compareReports(a,{...b,runtime:{...b.runtime,nodeVersion:'25.0.0'}}),/runtime/);
 const bad=report();bad.runs[0].gracefulExit=false;assert.throws(()=>compareReports(a,bad),/graceful/);
});
test('fifty percent and the 50-second startup gates use the complete workflow',()=>{
 const a=report(),b=report([40000,44000,42000]);b.runs.forEach(r=>{r.readyzMs=29000;r.capabilitiesReadyMs=29500;});
 const r=compareReports(a,b);assert.ok(r.overallReductionPercent>60);assert.equal(r.startupBudgetMs,50000);assert.equal(r.gatewayEveryRunWithinBudget,true);assert.equal(r.capabilitiesEveryRunWithinBudget,true);assert.equal(r.timeTargetsMet,true);
 b.runs[0].readyzMs=50001;assert.equal(compareReports(a,b).timeTargetsMet,false);
 b.runs[0].readyzMs=49999;b.runs[0].capabilitiesReadyMs=49999;assert.equal(compareReports(a,b).timeTargetsMet,true);
 b.runs[0].capabilitiesReadyMs=50001;assert.equal(compareReports(a,b).timeTargetsMet,false);
 b.runs[0].capabilitiesReadyMs=29500;b.runs.forEach(r=>r.overallMs=55000);assert.equal(compareReports(a,b).timeTargetsMet,true);
 b.runs.forEach(r=>r.overallMs=55001);assert.equal(compareReports(a,b).timeTargetsMet,false);
});
test('a successful HTTP/WebSocket envelope is insufficient when the required RPC shape is missing',()=>{
 validateRpcResult('models.list',{models:[]});validateRpcResult('config.get',{config:{}});
 assert.throws(()=>validateRpcResult('models.list',{ok:false,error:'failed'}),/models.list/);
 assert.throws(()=>validateRpcResult('sessions.list',null),/sessions.list/);
});
test('the other-startup gate excludes only recorded plugin intervals and stays strict below 50 seconds',()=>{
 const a=report(),b=report([42000,42000,42000]);
 b.runs.forEach(r=>{r.readyzMs=59000;r.capabilitiesReadyMs=60000;r.pluginStartup={complete:true,clockAligned:true,elapsedMs:11000};});
 assert.equal(compareReports(a,b).capabilitiesEveryRunWithinBudget,false);
 assert.equal(compareReports(a,b).otherStartupEveryRunWithinBudget,true);
 assert.equal(compareReports(a,b).timeTargetsMet,true);
 b.runs[0].pluginStartup.elapsedMs=10000;assert.equal(compareReports(a,b).otherStartupEveryRunWithinBudget,false);
 b.runs[0].pluginStartup.complete=false;assert.equal(compareReports(a,b).otherStartupEveryRunWithinBudget,false);
});
test('Windows resource collector samples only its owned Node child and stops without terminating it',{skip:process.platform!=='win32',timeout:20000},async t=>{
 const {spawn}=require('node:child_process');
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},15000)','gateway','run'],{windowsHide:true,stdio:'ignore'});t.after(()=>{if(child.exitCode===null)child.kill()});
 const sampler=startResourceSampler(process.pid,process.execPath);let stopped=false;t.after(async()=>{if(!stopped)await sampler.stop().catch(()=>{})});
 const until=Date.now()+12000;while(sampler.samples.length<2&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
 const result=await sampler.stop();stopped=true;assert.equal(result.pid,child.pid);assert.ok(result.samples>=2);assert.ok(result.gatewayPeakWorkingSetBytes>0);assert.equal(child.exitCode,null,'Stopping measurement must not kill the gateway');
});
