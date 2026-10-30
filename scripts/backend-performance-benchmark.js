#!/usr/bin/env node
'use strict';
// Packaged Windows backend benchmark. No model request, state mutation or profiler.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),http=require('node:http');
const crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn,execFile}=require('node:child_process'),{promisify}=require('node:util');
const {performance}=require('node:perf_hooks');
const {arg,launch,quitLaunchedApp,waitForPageTarget,connect,waitForAppReady,sleep}=require('./lib/cdp-harness');
const exec=promisify(execFile),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const WORKLOAD=[
 {method:'sessions.list',params:{includeGlobal:true,includeUnknown:true}},
 {method:'models.list',params:{view:'all'}},
 {method:'commands.list',params:{includeArgs:true,scope:'text'}},
 {method:'config.get',params:{}},
 {method:'cryoclaw.dashboards.list',params:{includeArchived:true}},
];
function canonical(value){return JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])):value);}
function percentile(values,p){assert.ok(values.length,'Missing metric samples');const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)];}
function median(values){assert.ok(values.length,'Missing metric samples');const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;return n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2;}
function parsePluginStartupIntervals(log,maxElapsedMs,launchWallClockMs){
 const scope='Union of completed native plugin phases conservatively aligned to app launch by parent log receipt timestamps; only phases wholly before readyz count. Overlaps count once. Unlabelled, late or unproven work stays in other startup.';
 const insufficient=reason=>({complete:false,clockAligned:false,elapsedMs:0,intervals:[],phases:[],reason,scope});
 if(!Number.isFinite(launchWallClockMs)||!Number.isFinite(maxElapsedMs)||maxElapsedMs<0)return insufficient('Missing reliable launch/readiness clock');
 if((log.match(/--- gateway start ---/g)||[]).length>1||(log.match(/\bspawn: .*\(gen=\d+\)/g)||[]).length>1)return insufficient('Multiple gateway startup generations');
 const nativePhases=[];let receivedAtMs=null,previousReceivedAtMs=-Infinity,previousTotalMs=-Infinity,originUpperBoundMs=-Infinity;
 for(const line of log.split(/\r?\n/)){
  // A stdout/stderr chunk may contain continuation lines sharing its receipt time.
  const receipt=line.match(/^\[([^\]]+)\] (stdout|stderr): /);
  if(receipt)receivedAtMs=Date.parse(receipt[1]);
  else {
   // Native continuation lines also begin with tags such as [gateway]. Only
   // another parent timestamp ends the receipt scope of this output chunk.
   const parent=line.match(/^\[([^\]]+)\] /);
   if(parent&&Number.isFinite(Date.parse(parent[1])))receivedAtMs=null;
  }
  for(const match of line.matchAll(/startup phase: ([\w.-]+) (?:([\d.]+)ms|starting) total=([\d.]+)ms/g)){
   const durationMs=match[2]===undefined?null:Number(match[2]),totalMs=Number(match[3]);
   if(!Number.isFinite(receivedAtMs)||receivedAtMs<launchWallClockMs||receivedAtMs<previousReceivedAtMs)return insufficient('Missing or inconsistent parent receipt clock');
   if(!Number.isFinite(totalMs)||totalMs<previousTotalMs||durationMs!==null&&(!Number.isFinite(durationMs)||durationMs>totalMs))return insufficient('Invalid or restarted native startup clock');
   previousReceivedAtMs=receivedAtMs;previousTotalMs=totalMs;
   // Receipt follows native completion. Round the millisecond timestamp upward,
   // then use one latest possible native origin so relative intervals survive.
   originUpperBoundMs=Math.max(originUpperBoundMs,receivedAtMs+1-launchWallClockMs-totalMs);
   if(match[1].includes('plugin')&&durationMs!==null)nativePhases.push({name:match[1],totalMs,durationMs});
  }
 }
 if(!nativePhases.length)return insufficient('No completed plugin startup evidence');
 const phases=nativePhases.map(p=>({name:p.name,startMs:originUpperBoundMs+p.totalMs-p.durationMs,endMs:originUpperBoundMs+p.totalMs,durationMs:p.durationMs})).filter(p=>p.startMs>=0&&p.endMs<=maxElapsedMs);
 const intervals=[];
 for(const phase of [...phases].sort((a,b)=>a.startMs-b.startMs)){
  const last=intervals.at(-1);
  if(last&&phase.startMs<=last.endMs)last.endMs=Math.max(last.endMs,phase.endMs);
  else intervals.push({startMs:phase.startMs,endMs:phase.endMs});
 }
 return {complete:phases.some(p=>p.name==='plugins.runtime-post-bind'),clockAligned:true,originUpperBoundMs,elapsedMs:intervals.reduce((sum,p)=>sum+p.endMs-p.startMs,0),intervals,phases,scope};
}
function validateRpcResult(method,value){
 const key={'sessions.list':'sessions','models.list':'models','commands.list':'commands','cryoclaw.dashboards.list':'boards'}[method];
 if(!value||typeof value!=='object'||value.ok===false||value.success===false||value.error||key&&!Array.isArray(value[key])||method==='config.get'&&(!value.config||typeof value.config!=='object'||Array.isArray(value.config)))throw Error('Required RPC result invalid: '+method);
}
function summarizeResources(samples){
 assert.ok(samples.length,'Missing gateway resource samples');assert.equal(new Set(samples.map(s=>s.pid)).size,1,'Gateway process identity changed');
 for(const s of samples)for(const key of ['atMs','cpuMs','workingSetBytes','peakWorkingSetBytes','privateBytes'])assert.ok(Number.isFinite(s[key])&&s[key]>=0,'Invalid gateway resource metric: '+key);
 const first=samples[0],last=samples.at(-1),elapsed=last.atMs-first.atMs;
 return {scope:'single owned native gateway process; excludes its child processes and Electron',pid:first.pid,samples:samples.length,
  gatewayObservedCpuMs:Math.max(...samples.map(s=>s.cpuMs)),gatewayCpuIntervalOneCorePercent:elapsed>0?(last.cpuMs-first.cpuMs)/elapsed*100:null,
  gatewayPeakWorkingSetBytes:Math.max(...samples.map(s=>s.peakWorkingSetBytes)),gatewaySampledWorkingSetPeakBytes:Math.max(...samples.map(s=>s.workingSetBytes)),gatewayPeakPrivateBytes:Math.max(...samples.map(s=>s.privateBytes)),
  note:'Windows WorkingSet64 is resident shared+private memory (RSS); PeakWorkingSet64 is the OS high-water mark. PrivateMemorySize64 is committed private bytes, not private RSS. CPU is cumulative user+kernel time at the last alive sample; the final sampling tail is unobserved.'};
}
function summarizeReport(report){
 assert.ok(report.runs?.length,'No benchmark runs');const rows=report.runs;
 for(const row of rows){assert.equal(row.ok,true,'Cannot summarize a failed run');assert.ok(row.steady?.latencies.length&&row.steady.elapsedMs>0,'Missing steady RPC work');}
 const latencies=rows.flatMap(r=>r.steady.latencies),perMethod={};
 for(const item of WORKLOAD){const samples=rows.flatMap(r=>(r.steady.results??[]).filter(v=>v.method===item.method).map(v=>v.durationMs));if(samples.length)perMethod[item.method]={p50Ms:percentile(samples,.5),p95Ms:percentile(samples,.95),samples:samples.length};}
 return {runs:rows.length,overallMedianMs:report.mode==='launch'?median(rows.map(r=>r.overallMs)):null,gatewayReadyMedianMs:report.mode==='launch'?median(rows.map(r=>r.readyzMs)):null,usableMedianMs:report.mode==='launch'?median(rows.map(r=>r.usableMs)):null,firstRpcBatchMedianMs:median(rows.map(r=>r.firstRpcBatchMs)),steadyP50Ms:percentile(latencies,.5),steadyP95Ms:percentile(latencies,.95),steadyThroughputMedianPerSecond:median(rows.map(r=>r.steady.count/r.steady.elapsedMs*1000)),gatewayObservedCpuMedianMs:median(rows.map(r=>r.resources.gatewayObservedCpuMs)),gatewayPeakWorkingSetMedianBytes:median(rows.map(r=>r.resources.gatewayPeakWorkingSetBytes)),gatewayPeakPrivateMedianBytes:median(rows.map(r=>r.resources.gatewayPeakPrivateBytes)),perMethod};
}
function compareReports(baseline,candidate){
 for(const report of [baseline,candidate]){assert.equal(report.schemaVersion,1,'Reports are not comparable: schema');assert.equal(report.ok,true,'Cannot compare failed report');assert.equal(report.mode,'launch','Overall comparison requires launch mode');assert.equal(report.diagnostic,false,'Cannot compare diagnostic profile');assert.ok(report.runs?.length,'Missing runs');for(const r of report.runs){assert.ok(r.ok&&r.gracefulExit,'Failed or non-graceful run');for(const key of ['overallMs','readyzMs','usableMs','firstRpcBatchMs'])assert.ok(Number.isFinite(r[key])&&r[key]>=0,'Missing startup metric: '+key);}}
 for(const key of ['workloadFingerprint','responseShapeFingerprint','configFingerprint','machineFingerprint','stateDirectoryFingerprint','cachePolicy'])assert.ok(baseline[key]&&baseline[key]===candidate[key],'Reports are not comparable: '+key);
 for(const key of ['nodeVersion','kernelVersion','electronVersion','nodeBinarySha256'])assert.equal(baseline.runtime[key],candidate.runtime[key],'Reports are not comparable: runtime '+key);
 const a=summarizeReport(baseline),b=summarizeReport(candidate),reduction=(old,next)=>(1-next/old)*100;
 const startupBudgetMs=50000,overallReductionPercent=reduction(a.overallMedianMs,b.overallMedianMs);
 const gatewayEveryRunWithinBudget=candidate.runs.every(r=>r.readyzMs<=startupBudgetMs);
 const firstCapabilityMaxMs=Math.max(...candidate.runs.map(r=>r.capabilitiesReadyMs??r.usableMs+r.firstRpcBatchMs)),capabilitiesEveryRunWithinBudget=firstCapabilityMaxMs<=startupBudgetMs;
 const otherTimes=candidate.runs.map(r=>{const plugin=r.pluginStartup,capabilities=r.capabilitiesReadyMs??r.usableMs+r.firstRpcBatchMs;return plugin?.complete&&plugin.clockAligned===true&&Number.isFinite(plugin.elapsedMs)&&plugin.elapsedMs>=0&&plugin.elapsedMs<=r.readyzMs?Math.max(r.readyzMs,capabilities)-plugin.elapsedMs:null;});
 const otherStartupEveryRunWithinBudget=otherTimes.every(value=>Number.isFinite(value)&&value<startupBudgetMs),otherStartupMaxMs=otherTimes.every(Number.isFinite)?Math.max(...otherTimes):null;
 return {baselineVersion:baseline.version,candidateVersion:candidate.version,baselineRuns:baseline.runs.length,candidateRuns:candidate.runs.length,overallReductionPercent,overallSpeedup:a.overallMedianMs/b.overallMedianMs,startupBudgetMs,gatewayEveryRunWithinBudget,capabilitiesEveryRunWithinBudget,firstCapabilityMaxMs,otherStartupEveryRunWithinBudget,otherStartupMaxMs,timeTargetsMet:overallReductionPercent>=50&&otherStartupEveryRunWithinBudget,steadyP95ReductionPercent:reduction(a.steadyP95Ms,b.steadyP95Ms),gatewayObservedCpuReductionPercent:reduction(a.gatewayObservedCpuMedianMs,b.gatewayObservedCpuMedianMs),gatewayPeakWorkingSetReductionPercent:reduction(a.gatewayPeakWorkingSetMedianBytes,b.gatewayPeakWorkingSetMedianBytes),baseline:a,candidate:b,note:'This compares the declared fixed end-to-end workload, not every possible backend operation. A smaller median does not establish a cold-OS-cache guarantee. Review per-run tails, first capabilities, RPC latency, CPU and memory before accepting a performance claim.'};
}
function positiveInteger(value,name,max=1000){const n=Number(value);assert.ok(Number.isSafeInteger(n)&&n>0&&n<=max,'Invalid '+name);return n;}
function readIdentity(exe,stateDir){
 const asar=require('@electron/asar'),archive=path.join(path.dirname(exe),'resources','app.asar'),pkg=JSON.parse(asar.extractFile(archive,'package.json').toString('utf8'));
 const resources=path.join(path.dirname(archive),'resources'),nativeNode=path.join(resources,'runtime','node.exe'),policy=JSON.parse(fs.readFileSync(path.join(resources,'runtime','cryoclaw-runtime.json'),'utf8'));
 const core=JSON.parse(fs.readFileSync(path.join(resources,'gateway','node_modules','openclaw','package.json'),'utf8'));
 assert.equal(policy.kind,'node','Benchmark requires native Node');assert.equal(policy.gatewayMode,'loose','Benchmark requires physical gateway');assert.equal(policy.kernelVersion,core.version,'Kernel metadata mismatch');
 const configPath=path.join(stateDir,'openclaw.json'),config=JSON.parse(fs.readFileSync(configPath,'utf8'));
 return {version:pkg.version,exe,archive,nativeNode,config,configFingerprint:hash(canonical(config)),stateDirectoryFingerprint:hash(path.resolve(stateDir).toLowerCase()),runtime:{nodeVersion:policy.nodeVersion,kernelVersion:core.version,nodeBinarySha256:null,electronVersion:null}};
}
function psString(value){return "'"+String(value).replace(/'/g,"''")+"'";}
async function psJson(code){const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});return JSON.parse(stdout.trim()||'null');}
function listening(port){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port}),done=value=>{socket.destroy();resolve(value)};socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.setTimeout(1000,()=>done(false));});}
async function preflight(exe,gatewayPort,cdpPort){
 for(const [label,port]of [['gateway',gatewayPort],['CDP',cdpPort]])assert.equal(await listening(port),false,`Existing ${label} listener on ${port}; close the other app normally first`);
 const existing=await psJson(`@(Get-CimInstance Win32_Process -Filter "Name='CryoClaw.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`);
 assert.ok(!existing||Array.isArray(existing)&&existing.length===0,'An existing CryoClaw main process is running; refusing a single-instance or old-port measurement');
 assert.ok(/^cryoclaw\.exe$/i.test(path.basename(exe)),'Pass the packaged CryoClaw.exe');
}
function startResourceSampler(mainPid,nativeNode){
 assert.ok(Number.isSafeInteger(mainPid)&&mainPid>0,'Invalid owned app PID');
 // WMI can expose the command line before ExecutablePath during process startup.
 // A missing path waits for identity; a different nonempty path still fails.
 const script=`$ErrorActionPreference='Stop';$mainId=${mainPid};$expected=${psString(nativeNode)};$deadline=[DateTime]::UtcNow.AddMinutes(6);$gateway=$null;while([DateTime]::UtcNow -lt $deadline){$candidates=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $mainId" | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'gateway run' });if($candidates.Count -gt 1){throw 'More than one owned gateway candidate'};if($candidates.Count -eq 1){$candidate=$candidates[0];$actual=$candidate.ExecutablePath;if([string]::IsNullOrWhiteSpace($actual)){$actual=(Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue).Path};if(![string]::IsNullOrWhiteSpace($actual)){if([IO.Path]::GetFullPath($actual) -ine [IO.Path]::GetFullPath($expected)){throw "Gateway native executable identity mismatch: actual=$actual expected=$expected"};$gateway=$candidate;break}};Start-Sleep -Milliseconds 300};if(!$gateway){throw 'Owned gateway executable identity was not identified'};$proc=[System.Diagnostics.Process]::GetProcessById($gateway.ProcessId);@{kind='identity';pid=$gateway.ProcessId;parentPid=$mainId} | ConvertTo-Json -Compress;while([DateTime]::UtcNow -lt $deadline){try{$proc.Refresh();if($proc.HasExited){break};@{kind='sample';pid=$proc.Id;atMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();cpuMs=$proc.TotalProcessorTime.TotalMilliseconds;workingSetBytes=$proc.WorkingSet64;peakWorkingSetBytes=$proc.PeakWorkingSet64;privateBytes=$proc.PrivateMemorySize64} | ConvertTo-Json -Compress}catch{break};Start-Sleep -Milliseconds 250}`;
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['ignore','pipe','pipe']}),samples=[];let buffer='',stderr='',identity=null,error=null,stopping=false;
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stderr.on('data',s=>{stderr=(stderr+s).slice(-2000)});
 child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(!line)continue;try{const row=JSON.parse(line);if(row.kind==='sample')samples.push(row);else if(row.kind==='identity')identity=row}catch{error=Error('Invalid resource sampler output')}}});
 const closed=new Promise(resolve=>{child.once('error',e=>{error=e;resolve()});child.once('close',code=>{if(code!==0&&!error&&!stopping)error=Error('Resource sampler failed: '+stderr.replace(/[\r\n]+/g,' ').slice(0,500));resolve()})});
 return {samples,stop:async()=>{stopping=true;child.kill();let expired=false;const timer=setTimeout(()=>{expired=true;child.kill()},10000);await closed;clearTimeout(timer);if(expired)throw Error('Resource sampler did not stop');if(error)throw error;assert.ok(identity&&samples.length,'No owned gateway resource samples');return summarizeResources(samples)}};
}
function endpointProbe(port,pathname,signal){return new Promise(resolve=>{if(signal.aborted)return resolve(false);const req=http.get({host:'127.0.0.1',port,path:pathname,timeout:2000,signal},res=>{res.resume();resolve(res.statusCode===200)});req.once('error',()=>resolve(false));req.once('timeout',()=>{req.destroy();resolve(false)})});}
async function pollEndpoint(port,pathname,signal,timeoutMs){const started=performance.now();while(!signal.aborted&&performance.now()-started<timeoutMs){if(await endpointProbe(port,pathname,signal))return true;await sleep(150)}return false;}
async function rpcBatch(cdp,rounds,timeoutMs){
 const expression=`(async()=>{const client=document.querySelector('openclaw-app')?.client;if(!client?.connected)throw Error('Authenticated gateway connection missing');const work=${JSON.stringify(WORKLOAD)},results=[],validate=${validateRpcResult.toString()},start=performance.now();for(let round=0;round<${rounds};round++)for(const item of work){const at=performance.now();const value=await client.request(item.method,item.params,{timeoutMs:${timeoutMs}});validate(item.method,value);results.push({method:item.method,round,durationMs:performance.now()-at,responseBytes:new TextEncoder().encode(JSON.stringify(value)).byteLength})}return {elapsedMs:performance.now()-start,count:results.length,latencies:results.map(r=>r.durationMs),results}})()`;
 return cdp.evaluate(expression,{timeoutMs:timeoutMs*WORKLOAD.length*rounds+10000});
}
async function main(argv=process.argv){
 if(argv.includes('--help')){console.log('node scripts/backend-performance-benchmark.js --exe <packaged CryoClaw.exe> --runs 3 --out <directory> --label <name> [--steady-rounds 20] [--cache-label existing-unreset-no-prewarm]\nUse the installed app or an unpacked copy at a durable path; never delete a test runtime whose plugin peer links refer to it.\n--attach-port <port> records first observed/steady RPCs and single gateway resources only; never startup, overall, or quit.\n--compare <baseline/report.json> <candidate/report.json> refuses mismatched workloads/configs/machines/caches/runtime or diagnostic/attached/failed samples.');return;}
 if(argv.includes('--compare')){const i=argv.indexOf('--compare');assert.ok(argv[i+1]&&argv[i+2],'Pass two report paths');const result=compareReports(JSON.parse(fs.readFileSync(argv[i+1],'utf8')),JSON.parse(fs.readFileSync(argv[i+2],'utf8')));console.log(JSON.stringify(result,null,2));return;}
 assert.equal(process.platform,'win32','Resource collection presently requires Windows; refusing an incomplete backend benchmark');
 assert.ok(!argv.includes('--stage-runtime'),'Temporary staging can invalidate plugin peer links; use a durable unpacked path or the installed app');
 const exe=path.resolve(arg(argv,'--exe',path.join(process.env.LOCALAPPDATA||'','Programs','CryoClaw','CryoClaw.exe'))),out=path.resolve(arg(argv,'--out',path.join('out','backend-performance',new Date().toISOString().replace(/[:.]/g,'-'))));fs.mkdirSync(out,{recursive:true});
 const stateDir=path.resolve(process.env.OPENCLAW_STATE_DIR||path.join(process.env.USERPROFILE||os.homedir(),'.openclaw')),identity=readIdentity(exe,stateDir),attached=argv.includes('--attach-port'),runs=positiveInteger(arg(argv,'--runs',attached?'1':'3'),'runs',20),steadyRounds=positiveInteger(arg(argv,'--steady-rounds','20'),'steady rounds',100),rpcTimeoutMs=65000;
 const gatewayPort=positiveInteger(arg(argv,'--gateway-port',process.env.OPENCLAW_GATEWAY_PORT||identity.config.gateway?.port||18789),'gateway port',65535),basePort=positiveInteger(arg(argv,attached?'--attach-port':'--port','9340'),'CDP port',65515);
 const report={schemaVersion:1,startedAt:new Date().toISOString(),label:arg(argv,'--label','unlabeled'),version:identity.version,exe,archiveSha256:null,runtime:identity.runtime,configFingerprint:identity.configFingerprint,stateDirectoryFingerprint:identity.stateDirectoryFingerprint,machineFingerprint:hash(canonical({host:os.hostname(),platform:process.platform,arch:process.arch,release:os.release(),cpu:os.cpus().map(c=>c.model),memory:os.totalmem()})),mode:attached?'attach':'launch',diagnostic:argv.includes('--diagnostic')||Boolean(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE||/--(?:cpu-prof|prof|inspect)/.test(process.env.NODE_OPTIONS||'')),cachePolicy:arg(argv,'--cache-label','existing-unreset-no-prewarm'),workload:WORKLOAD,workloadOrder:'sequential first observed batch, then sequential repeated batches',steadyRounds,workloadFingerprint:hash(canonical({version:1,workload:WORKLOAD,steadyRounds,order:'sequential',rpcTimeoutMs})),responseShapeFingerprint:null,runs:[],ok:false,notes:['No model invocation, profiler, cache deletion, prewarm, or user-state mutation is performed by this tool. Existing UI reads and post-ready maintenance remain part of the launch.','Overall wall time starts immediately before spawn and ends after normal app exit. It includes readyz, authenticated/session-ready UI, first mandatory RPC batch, steady repeated RPCs and normal quit.','An attach report cannot establish startup or overall speedup. Gateway memory/CPU covers one verified native gateway process, not the multi-process tree.','Filesystem/V8 caches are not reset; report run order and first-run results separately. Compare on the same machine/state/config and with the same declared cache policy. Provenance reads only small manifests before launch; full ASAR/Node hashes are calculated after all timed runs to avoid prewarming those binaries.']};
 const write=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));write();
 try{for(let n=0;n<runs;n++){
  const port=attached?basePort:basePort+n,row={run:n+1,ok:false,windowMs:null,healthzMs:null,readyzMs:null,usableMs:null,capabilitiesReadyMs:null,firstRpcBatchMs:null,overallMs:null,quitMs:null,gracefulExit:attached?null:false};report.runs.push(row);let running,cdp,ws,sampler;const abort=new AbortController();let tasks=[];let started;
  const gatewayLog=path.join(stateDir,'logs','gateway.log');let logOffset=0;try{logOffset=fs.statSync(gatewayLog).size;}catch{}
  try{
   if(!attached)await preflight(exe,gatewayPort,port);
   row.launchWallClockMs=Date.now();started=performance.now();
   if(!attached){running=launch(exe,port);running.child.once('error',()=>{});sampler=startResourceSampler(running.child.pid,identity.nativeNode);tasks=[['/healthz','healthzMs'],['/readyz','readyzMs']].map(async([endpoint,key])=>{const ok=await pollEndpoint(gatewayPort,endpoint,abort.signal,240000);if(ok)row[key]=performance.now()-started;return ok;});}
   const page=await waitForPageTarget(port,90000);assert.ok(page,'Packaged app page target unavailable');if(!attached)row.windowMs=performance.now()-started;
   const expected=path.dirname(exe).replace(/\\/g,'/').toLowerCase();assert.ok(decodeURIComponent(page.url).replace(/\\/g,'/').toLowerCase().includes(expected),'CDP page belongs to a different installation');
   ({cdp,ws}=await connect(page));
   if(attached){const mainPid=await psJson(`Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess -Unique | ConvertTo-Json -Compress`);assert.ok(Number.isSafeInteger(mainPid),'CDP listener owner is ambiguous');const actual=await psJson(`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${mainPid}').ExecutablePath | ConvertTo-Json -Compress`);assert.equal(String(actual).toLowerCase(),exe.toLowerCase(),'Attached main process identity mismatch');sampler=startResourceSampler(mainPid,identity.nativeNode);}
   const actualVersion=await cdp.evaluate("navigator.userAgent.match(/Electron\\/([^ ]+)/)?.[1]??null");assert.ok(actualVersion,'Electron runtime version missing');if(report.runtime.electronVersion)assert.equal(actualVersion,report.runtime.electronVersion,'Runtime changed between runs');report.runtime.electronVersion=actualVersion;
   assert.ok(await waitForAppReady(cdp,{timeoutMs:240000}),'Authenticated/session-ready app unavailable');if(!attached){row.usableMs=performance.now()-started;assert.ok((await Promise.all(tasks)).every(Boolean),'Gateway liveness/readiness did not succeed');}
   row.first=await rpcBatch(cdp,1,rpcTimeoutMs);row.firstRpcBatchMs=row.first.elapsedMs;if(!attached)row.capabilitiesReadyMs=performance.now()-started;
   row.steady=await rpcBatch(cdp,steadyRounds,rpcTimeoutMs);row.rendererExceptions=cdp.exceptions;assert.deepEqual(cdp.exceptions,[],'Renderer exception during required work');
   row.ok=true;
  }catch(error){row.error=String(error.stack||error);throw error;}
  finally{
   abort.abort();await Promise.allSettled(tasks);
   if(running){const at=performance.now();let exitAt=null;running.child.once('exit',()=>{exitAt=performance.now()});await quitLaunchedApp(running,cdp,70000);row.quitMs=performance.now()-at;row.overallMs=performance.now()-started;row.gracefulExit=running.child.exitCode===0&&running.child.signalCode===null&&exitAt!==null&&exitAt-at<70000;if(!row.gracefulExit){row.ok=false;row.error=row.error||'App did not complete a normal quit before the cleanup deadline';}}
   try{if(sampler)row.resources=await sampler.stop();else throw Error('Resource sampler unavailable');}catch(error){row.ok=false;row.resourceError=String(error.message)}
   if(!attached && Number.isFinite(row.readyzMs))try{
    const log=fs.readFileSync(gatewayLog);row.pluginStartup=parsePluginStartupIntervals(log.subarray(log.length>=logOffset?logOffset:0).toString('utf8'),row.readyzMs,row.launchWallClockMs);
    if(row.pluginStartup.complete&&Number.isFinite(row.capabilitiesReadyMs)&&row.pluginStartup.elapsedMs<=row.readyzMs){row.otherGatewayStartupMs=row.readyzMs-row.pluginStartup.elapsedMs;row.otherCapabilitiesStartupMs=row.capabilitiesReadyMs-row.pluginStartup.elapsedMs;}
   }catch(error){row.pluginPhaseError=error.message;}
   ws?.close();row.finishedAt=new Date().toISOString();write();console.log(JSON.stringify({run:row.run,ok:row.ok,readyzMs:row.readyzMs,capabilitiesReadyMs:row.capabilitiesReadyMs,overallMs:row.overallMs,otherCapabilitiesStartupMs:row.otherCapabilitiesStartupMs,gracefulExit:row.gracefulExit,out}));
  }
  assert.ok(row.ok,row.error||row.resourceError||'Backend run failed');
  const currentConfigFingerprint=hash(canonical(JSON.parse(fs.readFileSync(path.join(stateDir,'openclaw.json'),'utf8'))));assert.equal(currentConfigFingerprint,identity.configFingerprint,'Configuration changed during benchmark; refuse comparison');
 }}catch(error){report.error=String(error.stack||error);throw error;}
 finally{
  report.ok=report.runs.length===runs&&report.runs.every(r=>r.ok)&&!report.error;
  try{
   if(report.ok){
    for(const row of report.runs){assert.equal(row.first?.results?.length,WORKLOAD.length,'Required response shape missing');row.first.results.forEach((result,index)=>{assert.equal(result.method,WORKLOAD[index].method,'RPC response order changed');assert.ok(Number.isSafeInteger(result.responseBytes)&&result.responseBytes>=0,'Invalid RPC response size');});}
    report.responseShapeFingerprint=hash(canonical(report.runs.map(row=>row.first.results.map(result=>({method:result.method,responseBytes:result.responseBytes})))));
   }
   report.archiveSha256=hash(fs.readFileSync(identity.archive));report.runtime.nodeBinarySha256=hash(fs.readFileSync(identity.nativeNode));
  }catch(error){report.ok=false;report.error=report.error||'Artifact provenance read failed: '+error.message}
  if(report.ok)report.summary=summarizeReport(report);report.finishedAt=new Date().toISOString();write();
 }
 console.log(JSON.stringify({ok:report.ok,mode:report.mode,summary:report.summary,out}));
}
module.exports={WORKLOAD,validateRpcResult,summarizeResources,summarizeReport,compareReports,startResourceSampler,parsePluginStartupIntervals,readIdentity,canonical,main};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1});
