const test=require('node:test');
const assert=require('node:assert/strict');
const {compareCombinedReports}=require('./compare-performance-reports');
const {ITEMS,summarizeRuns}=require('./frontend-page-performance-cdp-benchmark');
function identity(){return {version:'2026.1030.0',archiveSha256:'a'.repeat(64),runtime:{nodeVersion:'24.22.1',kernelVersion:'2026.10.6',electronVersion:'43.8.3',nodeBinarySha256:'b'.repeat(64)}};}
function backend(overallMs){return {...identity(),schemaVersion:1,ok:true,mode:'launch',diagnostic:false,workloadFingerprint:'fixed',responseShapeFingerprint:'response-shapes',configFingerprint:'config',machineFingerprint:'machine',stateDirectoryFingerprint:'state',cachePolicy:'existing-unreset-no-prewarm',runs:[overallMs,overallMs,overallMs].map(overallMs=>({ok:true,overallMs,pluginStartup:{complete:true,clockAligned:true,elapsedMs:0},readyzMs:30000,usableMs:35000,capabilitiesReadyMs:36000,firstRpcBatchMs:1000,gracefulExit:true,steady:{elapsedMs:1000,count:5,latencies:[10,20]},resources:{gatewayObservedCpuMs:10000,gatewayPeakWorkingSetBytes:1000,gatewayPeakPrivateBytes:2000}}))};}
function pages(totalMs){const each=totalMs/(ITEMS.filter(item=>item.dependency!=="external-market").length*2),runs=[1,2,3].map(()=>({pages:ITEMS.map(item=>({id:item.id,coldMs:each,warmMs:each,coldRequests:1,warmRequests:1,coldState:"ready",warmState:"ready"}))}));return {...identity(),schemaVersion:2,ok:true,workloadFingerprint:'pages',configFingerprint:'config',machineFingerprint:'machine',stateDirectoryFingerprint:'state',cachePolicy:'existing-unreset-no-prewarm',capabilityFingerprint:'capabilities',runs,summary:summarizeRuns(runs)};}
test('combined performance weights backend and every page by elapsed time, not the best percentage',()=>{
 const result=compareCombinedReports(backend(120000),backend(60000),pages(80000),pages(32000));
 assert.ok(Math.abs(result.baselineMs-200000)<1e-6);assert.ok(Math.abs(result.candidateMs-92000)<1e-6);assert.ok(Math.abs(result.combinedReductionPercent-54)<1e-9);
 assert.equal(result.backend.comparison.overallReductionPercent,50);assert.ok(Math.abs(result.frontend.totalReductionPercent-60)<1e-9);
 assert.equal(result.meets50Percent,true);assert.equal(result.targetsMet,true);
});
test('combined fifty percent and the independent 50-second startup gates are both explicit',()=>{
 const result=compareCombinedReports(backend(120000),backend(48000),pages(80000),pages(28000));
 assert.ok(Math.abs(result.combinedReductionPercent-62)<1e-9);assert.equal(result.meets50Percent,true);assert.equal(result.startup50Seconds,true);assert.equal(result.targetsMet,true);
 const slow=backend(48000);slow.runs[0].capabilitiesReadyMs=50001;
 const rejected=compareCombinedReports(backend(120000),slow,pages(80000),pages(28000));assert.ok(Math.abs(rejected.combinedReductionPercent-62)<1e-9);assert.equal(rejected.startup50Seconds,false);assert.equal(rejected.targetsMet,false);
});
test('combined comparison rejects incomplete pages and non-launch backend evidence',()=>{
 const partial=pages(80000);delete partial.summary['settings:usage'];
 assert.throws(()=>compareCombinedReports(backend(120000),backend(60000),partial,pages(32000)),/settings:usage/);
 assert.throws(()=>compareCombinedReports({...backend(120000),mode:'attach'},backend(60000),pages(80000),pages(32000)),/launch/);
});

test('external market speedups do not improve the local combined score and failed data cannot be compared',()=>{
 const a=pages(80000),b=pages(80000);
 for(const run of b.runs)for(const page of run.pages)if(ITEMS.find(item=>item.id===page.id)?.dependency==='external-market'){page.coldMs=1;page.warmMs=1;}
 b.summary=summarizeRuns(b.runs);
 const result=compareCombinedReports(backend(120000),backend(120000),a,b);
 assert.equal(result.combinedReductionPercent,0);assert.equal(result.externalMarket.includedInCombinedScore,false);
 assert.ok(result.externalMarket.candidateMs<result.externalMarket.baselineMs);
 b.runs[0].pages[0].warmState='error';assert.throws(()=>compareCombinedReports(backend(120000),backend(120000),a,b),/Unsuccessful page/);
});
test('combined comparison checks each side before combining independent measurements',()=>{
 for(const side of ['baseline','candidate'])for(const key of ['version','archiveSha256','configFingerprint','machineFingerprint','stateDirectoryFingerprint','cachePolicy']){
  const a=backend(120000),b=backend(60000),c=pages(80000),d=pages(32000);
  (side==='baseline'?c:d)[key]=key==='archiveSha256'?'c'.repeat(64):'different';
  assert.throws(()=>compareCombinedReports(a,b,c,d),new RegExp(`${side}.*${key}`));
 }
 // Two frontend reports can match each other while both describe a different machine/config/state.
 for(const key of ['configFingerprint','machineFingerprint','stateDirectoryFingerprint','cachePolicy']){
  const a=pages(80000),b=pages(32000);a[key]=b[key]='different';
  assert.throws(()=>compareCombinedReports(backend(120000),backend(60000),a,b),new RegExp(`baseline.*${key}`));
 }
 for(const key of ['nodeVersion','kernelVersion','electronVersion','nodeBinarySha256']){
  const a=pages(80000),b=pages(32000);a.runtime[key]=b.runtime[key]=key==='nodeBinarySha256'?'c'.repeat(64):'other-runtime';
  assert.throws(()=>compareCombinedReports(backend(120000),backend(60000),a,b),new RegExp(`baseline.*runtime.${key}`));
 }
});

test('combined comparison refuses missing identity evidence rather than inferring a match',()=>{
 for(const side of ['baseline','candidate'])for(const type of ['backend','frontend'])for(const key of ['version','archiveSha256','configFingerprint','machineFingerprint','stateDirectoryFingerprint','cachePolicy','runtime.nodeVersion','runtime.kernelVersion','runtime.electronVersion','runtime.nodeBinarySha256']){
  const a=backend(120000),b=backend(60000),c=pages(80000),d=pages(32000),report=type==='backend'?(side==='baseline'?a:b):(side==='baseline'?c:d);
  if(key.startsWith('runtime.'))delete report.runtime[key.slice(8)];else delete report[key];
  assert.throws(()=>compareCombinedReports(a,b,c,d),new RegExp(`${side}.*${key}`));
 }
});

test('combined identity permits a new candidate artifact and separate observation times',()=>{
 const a=backend(120000),b=backend(110000),c=pages(80000),d=pages(79000);
 a.startedAt='2026-10-29T00:00:00Z';c.startedAt='2026-10-29T01:00:00Z';b.startedAt='2026-10-30T00:00:00Z';d.startedAt='2026-10-30T01:00:00Z';
 b.archiveSha256=d.archiveSha256='c'.repeat(64);b.version=d.version='2026.1030.1';
 const result=compareCombinedReports(a,b,c,d);
 assert.equal(result.measurementIntegrityValidated,true);assert.equal(result.legacyDiagnosticTargets.targetsMet,false);
 assert.equal(result.targetsMet,result.legacyDiagnosticTargets.targetsMet);assert.equal(result.legacyDiagnosticTargets.currentAcceptanceGate,false);
 assert.match(result.note,/historical diagnostics.*not current acceptance/);
});

test('CLI help and failures settle synchronously',()=>{
 const {spawnSync}=require('node:child_process'),script=require.resolve('./compare-performance-reports');
 const help=spawnSync(process.execPath,[script,'--help'],{encoding:'utf8'});assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/--backend-baseline/);
 const invalid=spawnSync(process.execPath,[script],{encoding:'utf8'});assert.equal(invalid.status,1);assert.match(invalid.stderr,/--backend-baseline/);
});
