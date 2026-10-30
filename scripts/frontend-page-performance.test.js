const test=require('node:test');
const assert=require('node:assert/strict');
const {ITEMS,summarizeRuns,compareReports}=require('./frontend-page-performance-cdp-benchmark');
const vm=require('node:vm');

test('navigation waits for active page IPC data markers and paint, independently of unrelated RPCs',async()=>{
 const {navigationExpression}=require('./frontend-page-performance-cdp-benchmark');
 let now=0,frames=0;
 const marker={dataset:{pageId:'settings:backup',loadState:'loading'},getAttribute:name=>name==='aria-busy'&&marker.dataset.loadState==='loading'?'true':'false',getClientRects:()=>[{}]};
 const app={settings:{cryoclawView:'settings'},connected:true,client:{connected:true,pending:new Map()},updateComplete:Promise.resolve()};
 const perf={requests:0,rpcTimings:[],longTasks:[]};
 const document={querySelector:selector=>selector==='openclaw-app'?app:selector==='.oc-settings-container'?{dataset:{settingsTab:'backup'}}:selector==='oc-rail'?{props:{onOpenSettings(){}}}:selector.includes('data-page-id')?marker:null,querySelectorAll:()=>[{click(){}}]};
 const context={document,window:{__pagePerf:perf},performance:{now:()=>now},requestAnimationFrame:callback=>{frames++;now+=16;if(frames===3){marker.dataset.loadState='empty';app.client.pending.set('background',{});}if(frames>20)throw Error('Waited for unrelated background RPC');callback();},setTimeout:callback=>{now+=25;callback();}};
 const result=await vm.runInNewContext(navigationExpression({id:'settings:backup',view:'settings',tab:'backup',index:11,markerId:'settings:backup'},0),context);
 assert.equal(result.loadState,'empty');assert.ok(frames>=5,'Data completion must be followed by two painted frames');
 assert.equal(app.client.pending.size,1);
});

test('navigation records page data errors as failure instead of a successful fast page',async()=>{
 const {navigationExpression}=require('./frontend-page-performance-cdp-benchmark');
 const app={settings:{cryoclawView:'settings'},connected:true,client:{connected:true,pending:new Map()}};
 const marker={dataset:{pageId:'settings:backup',loadState:'error'},getAttribute:()=> 'false',getClientRects:()=>[{}]};
 const document={querySelector:selector=>selector==='openclaw-app'?app:selector==='.oc-settings-container'?{dataset:{settingsTab:'backup'}}:selector==='oc-rail'?{props:{onOpenSettings(){}}}:selector.includes('data-page-id')?marker:null,querySelectorAll:()=>[{click(){}}]};
 let errorNow=0;const result=await vm.runInNewContext(navigationExpression({id:'settings:backup',view:'settings',tab:'backup',index:11,markerId:'settings:backup'},0),{document,window:{__pagePerf:{requests:0,rpcTimings:[],longTasks:[]}},performance:{now:()=>errorNow++},requestAnimationFrame:callback=>callback(),setTimeout:callback=>callback()});
 assert.equal(result.ok,false);assert.equal(result.loadState,'error');
});

test('page workload can be fingerprinted without undefined optional fields',()=>{
 const {canonical}=require('./backend-performance-benchmark');
 assert.doesNotThrow(()=>canonical(ITEMS));
 assert.ok(ITEMS.every(item=>!Object.values(item).some(value=>value===undefined)));
});

test('read-only subpage scenarios declare their data dependencies and navigation identities',()=>{
 const ids=new Set(ITEMS.map(item=>item.id));
 for(const id of ['settings:memory:overview','settings:memory:memories','settings:memory:dreams','settings:memory:settings','extensions:skills:installed','extensions:skills:store','extensions:plugins:installed','extensions:plugins:market','workspace:files','workspace:git','workspace:worktrees','tasks:cron',...['weixin','feishu','wecom','dingtalk','qqbot'].map(platform=>'settings:channels:'+platform)])assert.ok(ids.has(id),id);
 assert.equal(ITEMS.find(item=>item.id==='extensions:plugins:market')?.dependency,'external-market');
});
test('RPC timing instrumentation preserves client ownership, failures and pending requests',async()=>{
 const {instrumentation}=require('./frontend-page-performance-cdp-benchmark');
 let finish,now=10;
 const client={request(method){assert.equal(this,client);if(method==='fail')return Promise.reject(Error('offline'));return new Promise(resolve=>{finish=resolve;});}};
 const context={window:{},document:{querySelector:()=>({client})},performance:{now:()=>now}};
 assert.equal(vm.runInNewContext(instrumentation,context),true);
 const pending=client.request('config.get',{});now=25;
 assert.equal(context.window.__pagePerf.rpcTimings[0].durationMs,null);
 finish({ok:true});assert.deepEqual(await pending,{ok:true});
 assert.equal(context.window.__pagePerf.rpcTimings[0].durationMs,15);
 assert.equal(context.window.__pagePerf.rpcTimings[0].ok,true);
 await assert.rejects(client.request('fail'),/offline/);
 assert.equal(context.window.__pagePerf.rpcTimings[1].ok,false);
 assert.equal(context.window.__pagePerf.requests,2);
});
function run(coldOffset=0,warmOffset=0){return {pages:ITEMS.map((item,index)=>({id:item.id,coldMs:1000+index+coldOffset,warmMs:600+index+warmOffset,coldRequests:4,warmRequests:2,coldState:"ready",warmState:"ready"}))};}
function report(coldOffset=0,warmOffset=0){const runs=[run(coldOffset,warmOffset),run(coldOffset+100,warmOffset+100),run(coldOffset+200,warmOffset+200)];return {schemaVersion:2,ok:true,workloadFingerprint:'same',configFingerprint:'config',machineFingerprint:'machine',stateDirectoryFingerprint:'state',cachePolicy:'existing-unreset-no-prewarm',capabilityFingerprint:'capabilities',runtime:{nodeVersion:'24.22.1',kernelVersion:'2026.10.7',electronVersion:'43.8.3',nodeBinarySha256:'node'},runs,summary:summarizeRuns(runs)};}
test('page summary keeps every top-level view and settings tab',()=>{
 const summary=summarizeRuns([run()]);assert.equal(Object.keys(summary).length,ITEMS.length);
 assert.ok(summary.dashboard.coldMedianMs>=500);assert.ok(summary['settings:about']);assert.equal(summary.tasks.warmRequestsMedian,2);
});
test('comparison uses per-page first and repeat data-ready timings',()=>{
 const baseline=report(),candidate=report(-400,-300),result=compareReports(baseline,candidate);
 assert.equal(result.slowColdPagesMeeting50Percent,false);
 assert.ok(result.pages.chat.coldReductionPercent>30);assert.ok(result.pages.chat.warmReductionPercent>40);
 const fast=report(-600,-400);assert.ok(compareReports(baseline,fast).slowColdPagesMeeting50Percent);
});
test('external market outages stay measured without hiding local page failures',()=>{
 const external=run();
 for(const page of external.pages)if(ITEMS.find(item=>item.id===page.id)?.dependency==='external-market'){page.coldState='error';page.warmState='error';}
 assert.doesNotThrow(()=>summarizeRuns([external]));
 const local=run();local.pages[0].coldState='error';assert.throws(()=>summarizeRuns([local]),/Unsuccessful page/);
});

test('external market summaries separate measurement completion from successful loads',()=>{
 const a=run(),b=run();const id='extensions:plugins:market';
 a.pages.find(page=>page.id===id).coldState='error';
 b.pages.find(page=>page.id===id).warmState='error';
 const summary=summarizeRuns([a,b])[id];
 assert.equal(summary.measurementCompleted,true);assert.equal(summary.pagesSuccessful,false);
 assert.deepEqual(summary.coldStateCounts,{ready:1,empty:0,error:1});assert.deepEqual(summary.warmStateCounts,{ready:1,empty:0,error:1});
 assert.equal(summary.timingMetric,'time-to-terminal-state');assert.match(summary.note,/not successful data-ready/);
 assert.equal(summary.coldMedianMs,a.pages.find(page=>page.id===id).coldMs,'raw terminal timing must stay inspectable');
});

test('faster market errors and recovery from errors have no successful-load improvement percentage',()=>{
 const id='extensions:plugins:market';
 for(const [baselineError,candidateError]of [[true,true],[false,true],[true,false]]){
  const a=report(),b=report();
  for(const row of a.runs)if(baselineError)row.pages.find(page=>page.id===id).coldState='error';
  for(const row of b.runs){const page=row.pages.find(page=>page.id===id);page.coldMs=1;page.warmMs=1;if(candidateError)page.warmState='error';}
  // Historical reports lack outcome metadata and may have stale summaries; raw runs are authoritative.
  const result=compareReports(a,b),page=result.externalMarketPages[id];
  assert.equal(result.measurementCompleted,true);assert.equal(result.pagesSuccessful,false);
  for(const key of ['firstNavigationReductionPercent','revisitReductionPercent','coldReductionPercent','warmReductionPercent'])assert.equal(page[key],null,key);
  assert.equal(page.comparisonStatus,'terminal-state-observation');assert.match(page.note,/not successful data-ready/);
  assert.ok(result.pages.chat.coldReductionPercent===0,'local successful pages remain comparable');
 }
});

test('failed or altered workloads, configurations, capabilities and runtimes cannot be compared',()=>{
 const a=report(),b=report();assert.throws(()=>compareReports({...a,ok:false},b),/failed/);
 assert.throws(()=>compareReports(a,{...b,workloadFingerprint:'changed'}),/workload/);
 for(const key of ['configFingerprint','machineFingerprint','stateDirectoryFingerprint','cachePolicy','capabilityFingerprint'])assert.throws(()=>compareReports(a,{...b,[key]:'changed'}),/comparable/);
 assert.throws(()=>compareReports(a,{...b,runtime:{...b.runtime,electronVersion:'other'}}),/runtime/);
 assert.throws(()=>compareReports({...a,schemaVersion:1},b),/schema/);
 b.runs[0].pages[0].coldState='error';assert.throws(()=>compareReports(a,b),/Unsuccessful page/);
});

test('first navigation aliases preserve measured wall time and external market dependencies stay separate',()=>{
 const a=report(),b=report();
 for(const run of b.runs)for(const page of run.pages)if(ITEMS.find(item=>item.id===page.id)?.dependency==='external-market'){page.coldMs=1;page.warmMs=1;}
 b.summary=summarizeRuns(b.runs);
 const result=compareReports(a,b);
 assert.equal(result.pages.chat.firstNavigationReductionPercent,0);
 assert.equal(b.summary.chat.firstNavigationMedianMs,b.summary.chat.coldMedianMs);
 assert.equal(Object.keys(result.externalMarketPages).length,2);
 assert.equal(result.slowLocalFirstNavigationsMeeting50Percent,false);
 assert.match(result.timingSemantics,/first measured navigation after app readiness/);
});
