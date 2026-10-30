#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const {arg,launch,quitLaunchedApp,waitForPageTarget,connect,waitForAppReady,dismissReleaseNotes}=require('./lib/cdp-harness');
const {readIdentity,canonical}=require('./backend-performance-benchmark');
const fingerprint=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
function capabilitiesFingerprint(features){
 const normalize=value=>Array.isArray(value)?[...new Set(value.filter(item=>typeof item==='string'))].sort():[];
 return fingerprint({methods:normalize(features?.methods),events:normalize(features?.events)});
}
const VIEWS=[
 {id:'dashboard',handler:'onOpenDashboard'},
 {id:'chat',handler:'onOpenChat'},
 {id:'tasks',handler:'onOpenTasks'},
 {id:'workspace',handler:'onOpenWorkspace'},
 {id:'extensions',handler:'onOpenExtensions'},
 {id:'settings',handler:'onOpenSettings'},
];
const SETTINGS_TABS=['channels','provider','search','memory','voice','usage','mcp-hooks','overview','appearance','advanced','approvals','backup','about'];
const defaults={dashboard:'dashboard',chat:'chat',tasks:'tasks:runs',workspace:'workspace:files',extensions:'extensions:skills:installed',settings:'settings:channels:weixin'};
const defaultNav={settings:['settings:channels','settings:channels:weixin'],extensions:['extensions:skills','extensions:skills:installed'],workspace:['workspace:files'],tasks:['tasks:runs']};
const ITEMS=[...VIEWS.map(view=>({...view,markerId:defaults[view.id],nav:defaultNav[view.id]??[]})),
 ...SETTINGS_TABS.map(tab=>({id:`settings:${tab}`,view:'settings',tab,markerId:tab==='channels'?'settings:channels:weixin':tab==='memory'?'settings:memory:overview':`settings:${tab}`,nav:[`settings:${tab}`]})),
 ...['overview','memories','dreams','settings'].map(tab=>({id:`settings:memory:${tab}`,view:'settings',markerId:`settings:memory:${tab}`,nav:['settings:memory',`settings:memory:${tab}`]})),
 ...['weixin','feishu','wecom','dingtalk','qqbot'].map(tab=>({id:`settings:channels:${tab}`,view:'settings',markerId:`settings:channels:${tab}`,nav:['settings:channels',`settings:channels:${tab}`],coverage:'configuration and existing runtime/pairing reads; no login, verification or changes'})),
 ...[['skills','installed'],['skills','store'],['plugins','installed'],['plugins','market']].map(([tab,subtab])=>({id:`extensions:${tab}:${subtab}`,view:'extensions',markerId:`extensions:${tab}:${subtab}`,nav:[`extensions:${tab}`,`extensions:${tab}:${subtab}`],dependency:subtab==='store'||subtab==='market'?'external-market':'local'})),
 ...['files','git','worktrees'].map(tab=>({id:`workspace:${tab}`,view:'workspace',markerId:`workspace:${tab}`,nav:tab==='git'?['workspace:git']:['workspace:files'],...(tab==='worktrees'?{coverage:'visible workspace sidebar inventory; no independent route or mutation'}:{})})),
 {id:'tasks:cron',view:'tasks',markerId:'tasks:cron',nav:['tasks:cron']}];
const TIMING_SEMANTICS='firstNavigationMs/coldMs: first measured navigation after app readiness, with existing startup/prefetch caches; revisitMs/warmMs: second traversal. Neither means cold OS cache or an unmounted resource. Gateway RPCs are windowed observations only; IPC is included in page data-ready wall time, not RPC counts.';
function acceptedPageState(item,state){return ['ready','empty'].includes(state)||item.dependency==='external-market'&&state==='error';}
const ERROR_TIMING_NOTE='Includes error outcomes: timings measure time to terminal state, not successful data-ready loads or performance gains.';
function median(values){assert.ok(values.length,'Missing samples');const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;return n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2;}
function summarizeRuns(runs){
 assert.ok(runs.length,'Missing page benchmark runs');
 const summary={};
 for(const item of ITEMS){const rows=runs.map(run=>run.pages.find(page=>page.id===item.id));assert.ok(rows.every(Boolean),`Missing page samples: ${item.id}`);
  for(const row of rows)for(const phase of ['cold','warm']){assert.ok(acceptedPageState(item,row[`${phase}State`]),`Unsuccessful page data state: ${item.id} ${phase}`);for(const key of [`${phase}Ms`,`${phase}Requests`])assert.ok(Number.isFinite(row[key])&&row[key]>=0,`Invalid page metric: ${item.id} ${key}`);}
  const coldMedianMs=median(rows.map(row=>row.coldMs)),warmMedianMs=median(rows.map(row=>row.warmMs));
  const stateCounts=phase=>rows.reduce((counts,row)=>{counts[row[`${phase}State`]]++;return counts;},{ready:0,empty:0,error:0});
  const coldStateCounts=stateCounts('cold'),warmStateCounts=stateCounts('warm'),pagesSuccessful=coldStateCounts.error+warmStateCounts.error===0;
  summary[item.id]={dependency:item.dependency??'local',measurementCompleted:true,pagesSuccessful,coldStateCounts,warmStateCounts,timingMetric:pagesSuccessful?'successful-data-ready':'time-to-terminal-state',...pagesSuccessful?{}:{note:ERROR_TIMING_NOTE},firstNavigationMedianMs:coldMedianMs,revisitMedianMs:warmMedianMs,coldMedianMs,warmMedianMs,coldRequestsMedian:median(rows.map(row=>row.coldRequests)),warmRequestsMedian:median(rows.map(row=>row.warmRequests)),coldMaxMs:Math.max(...rows.map(row=>row.coldMs)),warmMaxMs:Math.max(...rows.map(row=>row.warmMs))};}
 return summary;
}
function compareReports(baseline,candidate){
 for(const report of [baseline,candidate]){assert.equal(report.ok,true,'Cannot compare failed page benchmark');assert.equal(report.schemaVersion,2,'Page measurement schema changed');summarizeRuns(report.runs);for(const item of ITEMS)assert.ok(report.summary?.[item.id],`Missing page summary: ${item.id}`);}
 assert.equal(baseline.workloadFingerprint,candidate.workloadFingerprint,'Page workload changed');
 for(const key of ['configFingerprint','machineFingerprint','stateDirectoryFingerprint','cachePolicy','capabilityFingerprint'])assert.ok(baseline[key]&&baseline[key]===candidate[key],`Page reports are not comparable: ${key}`);
 for(const key of ['nodeVersion','kernelVersion','electronVersion','nodeBinarySha256'])assert.equal(baseline.runtime?.[key],candidate.runtime?.[key],`Page reports are not comparable: runtime ${key}`);
 const pages={},summaries=[summarizeRuns(baseline.runs),summarizeRuns(candidate.runs)];for(const item of ITEMS){const a=summaries[0][item.id],b=summaries[1][item.id],successful=a.pagesSuccessful&&b.pagesSuccessful;
  const coldReductionPercent=successful?(1-b.coldMedianMs/a.coldMedianMs)*100:null,warmReductionPercent=successful?(1-b.warmMedianMs/a.warmMedianMs)*100:null;
  pages[item.id]={dependency:item.dependency??'local',comparisonStatus:successful?'successful-data-ready':'terminal-state-observation',...successful?{}:{note:ERROR_TIMING_NOTE},firstNavigationReductionPercent:coldReductionPercent,revisitReductionPercent:warmReductionPercent,coldReductionPercent,warmReductionPercent,baseline:a,candidate:b};}
 const local=ITEMS.filter(item=>item.dependency!=='external-market'),externalMarketPages=Object.fromEntries(ITEMS.filter(item=>item.dependency==='external-market').map(item=>[item.id,pages[item.id]]));
 const slowLocalFirstNavigationsMeeting50Percent=local.filter(item=>summaries[0][item.id].coldMedianMs>=500).every(item=>pages[item.id].coldReductionPercent>=50);
 const baselinePagesSuccessful=Object.values(summaries[0]).every(page=>page.pagesSuccessful),candidatePagesSuccessful=Object.values(summaries[1]).every(page=>page.pagesSuccessful);
 return {measurementCompleted:true,pagesSuccessful:baselinePagesSuccessful&&candidatePagesSuccessful,baselinePagesSuccessful,candidatePagesSuccessful,pages,externalMarketPages,slowLocalFirstNavigationsMeeting50Percent,slowColdPagesMeeting50Percent:slowLocalFirstNavigationsMeeting50Percent,timingSemantics:TIMING_SEMANTICS};
}
const instrumentation=`(()=>{
 const app=document.querySelector('openclaw-app');if(!app)throw Error('App missing');
 window.__pagePerf={requests:0,rpcTimings:[],longTasks:[],wrapped:false};
 try{new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__pagePerf.longTasks.push({startTime:entry.startTime,duration:entry.duration});}).observe({type:'longtask'});}catch{}
 const client=app.client,original=client?.request;
 if(client&&typeof original==='function'){
  client.request=function(...args){
   const perf=window.__pagePerf,row={method:args[0],startTime:performance.now(),durationMs:null,ok:null};
   perf.requests++;perf.rpcTimings.push(row);
   const finish=ok=>{row.durationMs=performance.now()-row.startTime;row.ok=ok;};
   try{return original.apply(this,args).then(value=>{finish(true);return value;},error=>{finish(false);throw error;});}
   catch(error){finish(false);throw error;}
  };
  window.__pagePerf.wrapped=true;
 }
 return window.__pagePerf.wrapped;
})()`;
function navigationExpression(item,startedAt){
 return `(async()=>{
  const app=document.querySelector('openclaw-app'),perf=window.__pagePerf,start=${startedAt},before=perf.requests,rpcBefore=perf.rpcTimings.length,item=${JSON.stringify(item)};
  const markerSelector='[data-page-id="'+item.markerId+'"]',previouslyMounted=!!document.querySelector(markerSelector);
  const handler=document.querySelector('oc-rail')?.props?.${VIEWS.find(view=>view.id===(item.view??item.id))?.handler};
  if(typeof handler!=='function')throw Error('Navigation handler missing: '+item.id);handler();
  for(const id of item.nav??[]){
   let button;
   while(!(button=document.querySelector('[data-page-nav="'+id+'"]'))&&performance.now()-start<90000){if(app.updateComplete)await app.updateComplete;await new Promise(requestAnimationFrame);}
   if(!button)throw Error('Subpage navigation missing: '+id);button.click();
   if(app.updateComplete)await app.updateComplete;
   await new Promise(requestAnimationFrame);
  }
  let stable=0,lastMarker=null,lastState=null;
  while(performance.now()-start<90000){
   if(app.updateComplete)await app.updateComplete;
   const dashboard=document.querySelector('oc-dashboard');if(dashboard?.updateComplete)await dashboard.updateComplete;
   await new Promise(requestAnimationFrame);
   const marker=document.querySelector(markerSelector),loadState=marker?.dataset.loadState,viewOk=app.settings.cryoclawView===(item.view??item.id),mounted=!!marker?.getClientRects().length;
   const terminal=['ready','empty','error','unsupported'].includes(loadState),ready=viewOk&&mounted&&terminal&&marker.getAttribute('aria-busy')!=='true'&&!marker.closest?.('[aria-busy="true"]')&&app.connected&&app.client?.connected;
   stable=ready?(marker===lastMarker&&loadState===lastState?stable+1:1):0;lastMarker=marker;lastState=loadState;
   if(stable>=3){const elapsedMs=performance.now()-start,longTasks=perf.longTasks.filter(row=>row.startTime>=start&&row.startTime<=start+elapsedMs);return {ok:loadState==='ready'||loadState==='empty',loadState,previouslyMounted,elapsedMs,requests:perf.requests-before,rpcTimings:perf.rpcTimings.slice(rpcBefore),rpcScope:'windowed gateway RPCs only; excludes IPC counts',longTaskCount:longTasks.length,longTaskTotalMs:longTasks.reduce((sum,row)=>sum+row.duration,0)};}
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error('Page readiness timeout: '+item.id+' '+JSON.stringify({view:app.settings.cryoclawView,loadState:lastState}));
 })()`;
}
async function measure(cdp,item){
 const startedAt=await cdp.evaluate('performance.now()');
 return cdp.evaluate(navigationExpression(item,startedAt),{timeoutMs:100000});
}
async function runOnce(exe,port){
 const running=launch(exe,port);let ws,cdp;const pages=ITEMS.map(item=>({id:item.id,coldMs:null,warmMs:null,coldRequests:null,warmRequests:null}));
 try{
  const page=await waitForPageTarget(port,120000);assert.ok(page,'Application page target');({ws,cdp}=await connect(page));
  assert.ok(await waitForAppReady(cdp,{timeoutMs:240000}),'Initial app readiness');await dismissReleaseNotes(cdp);
  const features=await cdp.evaluate("document.querySelector('openclaw-app')?.hello?.features??null"),electronVersion=await cdp.evaluate("navigator.userAgent.match(/Electron\\/([^ ]+)/)?.[1]??null");
  assert.ok(features?.methods?.length,'Gateway capability snapshot missing');assert.ok(electronVersion,'Electron runtime version missing');
  assert.ok(await cdp.evaluate(instrumentation),'Gateway request instrumentation');
  assert.ok(await cdp.evaluate('!document.querySelector("openclaw-app").chatRunId'),'Benchmark requires an idle chat');
  for(const phase of ['cold','warm'])for(const item of ITEMS){let result;try{result=await measure(cdp,item);}catch(error){throw Error(`Page measurement failed: ${phase} ${item.id}: ${error.message}`,{cause:error});}const row=pages.find(page=>page.id===item.id);row[`${phase}Ms`]=result.elapsedMs;row[phase==='cold'?'firstNavigationMs':'revisitMs']=result.elapsedMs;row[`${phase}State`]=result.loadState;row[`${phase}PreviouslyMounted`]=result.previouslyMounted;row[`${phase}Requests`]=result.requests;row[`${phase}RpcTimings`]=result.rpcTimings;row[`${phase}LongTaskCount`]=result.longTaskCount;row[`${phase}LongTaskTotalMs`]=result.longTaskTotalMs;row.dependency=item.dependency??'local';row.coverage=item.coverage;}
  assert.deepEqual(cdp.exceptions,[],'Renderer exceptions');
  const measurementCompleted=pages.every(page=>{const item=ITEMS.find(candidate=>candidate.id===page.id);return acceptedPageState(item,page.coldState)&&acceptedPageState(item,page.warmState);});
  return {ok:measurementCompleted,measurementCompleted,pagesSuccessful:pages.every(page=>['ready','empty'].includes(page.coldState)&&['ready','empty'].includes(page.warmState)),pages,rendererExceptions:cdp.exceptions,consoleErrors:cdp.consoleErrors,capabilityFingerprint:capabilitiesFingerprint(features),electronVersion};
 }finally{await quitLaunchedApp(running,cdp);ws?.close();}
}
async function main(argv=process.argv){
 if(argv.includes('--help')){console.log('node scripts/frontend-page-performance-cdp-benchmark.js --exe <CryoClaw.exe> [--runs 3] --out <directory> --label <name>\n--compare <baseline/report.json> <candidate/report.json>');return;}
 if(argv.includes('--compare')){const index=argv.indexOf('--compare'),a=JSON.parse(fs.readFileSync(argv[index+1],'utf8')),b=JSON.parse(fs.readFileSync(argv[index+2],'utf8'));console.log(JSON.stringify(compareReports(a,b),null,2));return;}
 const exe=path.resolve(arg(argv,'--exe',path.join(process.env.LOCALAPPDATA||'','Programs','CryoClaw','CryoClaw.exe'))),runs=Number(arg(argv,'--runs','3')),stateDir=path.resolve(process.env.OPENCLAW_STATE_DIR||path.join(process.env.USERPROFILE||os.homedir(),'.openclaw')),identity=readIdentity(exe,stateDir);
 assert.ok(Number.isInteger(runs)&&runs>=1&&runs<=5,'--runs must be between 1 and 5');assert.ok(fs.existsSync(exe),'Application not found: '+exe);
 const out=path.resolve(arg(argv,'--out',path.join('out','frontend-page-performance',new Date().toISOString().replace(/[:.]/g,'-')))),report={schemaVersion:2,timingSemantics:TIMING_SEMANTICS,rpcScope:"windowed gateway RPCs only; excludes IPC counts and unrelated work ownership",externalMarketPolicy:"Observed separately; external network latency and failures are not local performance gains",label:arg(argv,'--label','unlabeled'),version:identity.version,exe,archiveSha256:null,runtime:identity.runtime,configFingerprint:identity.configFingerprint,stateDirectoryFingerprint:identity.stateDirectoryFingerprint,machineFingerprint:fingerprint({host:os.hostname(),platform:process.platform,arch:process.arch,release:os.release(),cpu:os.cpus().map(c=>c.model),memory:os.totalmem()}),cachePolicy:arg(argv,'--cache-label','existing-unreset-no-prewarm'),capabilityFingerprint:null,workloadFingerprint:fingerprint({version:2,items:ITEMS,readiness:"active-data-state-and-two-paints",timing:TIMING_SEMANTICS}),startedAt:new Date().toISOString(),runs:[],ok:false,measurementCompleted:false,pagesSuccessful:false};fs.mkdirSync(out,{recursive:true});
 const write=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));write();
 try{for(let index=0;index<runs;index++){const row=await runOnce(exe,9400+index);
  if(report.capabilityFingerprint&&report.capabilityFingerprint!==row.capabilityFingerprint)throw Error('Gateway capabilities changed during page benchmark');report.capabilityFingerprint=row.capabilityFingerprint;
  if(report.runtime.electronVersion&&report.runtime.electronVersion!==row.electronVersion)throw Error('Electron runtime changed during page benchmark');report.runtime.electronVersion=row.electronVersion;
  report.runs.push(row);write();assert.ok(row.ok,"One or more page data loads failed; inspect per-page states");console.log(JSON.stringify({run:index+1,pages:row.pages.length,out}));}
  const currentConfigFingerprint=fingerprint(JSON.parse(fs.readFileSync(path.join(stateDir,'openclaw.json'),'utf8')));assert.equal(currentConfigFingerprint,identity.configFingerprint,'Configuration changed during page benchmark');
  report.summary=summarizeRuns(report.runs);report.ok=true;
 }catch(error){report.error=String(error.stack||error);throw error;}
 finally{
  report.ok=report.runs.length===runs&&report.runs.every(row=>row.ok&&row.capabilityFingerprint===report.capabilityFingerprint)&&!report.error;
  try{report.archiveSha256=crypto.createHash('sha256').update(fs.readFileSync(identity.archive)).digest('hex');report.runtime.nodeBinarySha256=crypto.createHash('sha256').update(fs.readFileSync(identity.nativeNode)).digest('hex');}catch(error){report.ok=false;report.error=report.error||'Artifact provenance read failed: '+error.message;}
  if(report.ok)report.summary=summarizeRuns(report.runs);report.measurementCompleted=report.ok;report.pagesSuccessful=report.ok&&Object.values(report.summary).every(page=>page.pagesSuccessful);report.finishedAt=new Date().toISOString();write();
 }
 console.log(JSON.stringify({ok:report.ok,measurementCompleted:report.measurementCompleted,pagesSuccessful:report.pagesSuccessful,summary:report.summary,out}));
}
module.exports={VIEWS,SETTINGS_TABS,ITEMS,TIMING_SEMANTICS,median,summarizeRuns,compareReports,instrumentation,navigationExpression,main};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
