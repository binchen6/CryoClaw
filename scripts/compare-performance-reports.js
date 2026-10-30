#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {compareReports:compareBackendReports}=require('./backend-performance-benchmark');
const {ITEMS,summarizeRuns,compareReports:comparePageReports}=require('./frontend-page-performance-cdp-benchmark');
function pageWorkflowMs(report,dependency='local'){
 let totalMs=0;
 const summary=summarizeRuns(report.runs);
 for(const item of ITEMS){
  assert.ok(report.summary?.[item.id],`Missing page summary: ${item.id}`);
  if((item.dependency??'local')!==dependency)continue;
  const row=summary[item.id];
  for(const key of ['coldMedianMs','warmMedianMs']){assert.ok(Number.isFinite(row[key])&&row[key]>=0,`Invalid ${key}: ${item.id}`);totalMs+=row[key];}
 }
 return totalMs;
}
function assertSideIdentity(side,backend,frontend){
 const fields=['version','archiveSha256','configFingerprint','stateDirectoryFingerprint','machineFingerprint','cachePolicy'].map(key=>[key,backend[key],frontend[key]]);
 for(const key of ['nodeVersion','kernelVersion','electronVersion','nodeBinarySha256'])fields.push([`runtime.${key}`,backend.runtime?.[key],frontend.runtime?.[key]]);
 for(const [key,a,b]of fields){
  for(const [source,value]of [['backend',a],['frontend',b]]){
   assert.ok(typeof value==='string'&&value.trim(),`Combined reports are not comparable: ${side} missing ${key} (${source})`);
   if(key.endsWith('Sha256'))assert.match(value,/^[a-f0-9]{64}$/i,`Combined reports are not comparable: ${side} invalid ${key} (${source})`);
  }
  assert.equal(key.endsWith('Sha256')?a.toLowerCase():a,key.endsWith('Sha256')?b.toLowerCase():b,`Combined reports are not comparable: ${side} backend/frontend ${key} mismatch`);
 }
}
function compareCombinedReports(baselineBackend,candidateBackend,baselinePages,candidatePages){
 assertSideIdentity('baseline',baselineBackend,baselinePages);assertSideIdentity('candidate',candidateBackend,candidatePages);
 const baselinePageMs=pageWorkflowMs(baselinePages),candidatePageMs=pageWorkflowMs(candidatePages);
 const backend=compareBackendReports(baselineBackend,candidateBackend),pages=comparePageReports(baselinePages,candidatePages);
 const baselineMs=backend.baseline.overallMedianMs+baselinePageMs,candidateMs=backend.candidate.overallMedianMs+candidatePageMs;
 assert.ok(baselineMs>0&&candidateMs>=0,'Invalid combined workflow duration');
 const combinedReductionPercent=(1-candidateMs/baselineMs)*100,startup50Seconds=backend.gatewayEveryRunWithinBudget&&backend.capabilitiesEveryRunWithinBudget,meets50Percent=combinedReductionPercent>=50;
 const legacyDiagnosticTargets={currentAcceptanceGate:false,meets50Percent,startup50Seconds,nonPluginStartup50Seconds:backend.otherStartupEveryRunWithinBudget,targetsMet:meets50Percent&&backend.otherStartupEveryRunWithinBudget};
 return {
  schemaVersion:2,measurementIntegrityValidated:true,identityPolicy:'Each side matches recorded app.asar and native Node SHA-256, app/runtime versions, config, state directory, machine and cache policy. Observation times may differ. Physical gateway files are identified by the recorded kernel version, not a whole-tree hash.',legacyDiagnosticTargets,metric:'backend-overall-median-plus-local-page-first-navigation-and-revisit-medians',baselineMs,candidateMs,combinedReductionPercent,meets50Percent,startup50Seconds,nonPluginStartup50Seconds:backend.otherStartupEveryRunWithinBudget,targetsMet:legacyDiagnosticTargets.targetsMet,
  backend:{baselineMs:backend.baseline.overallMedianMs,candidateMs:backend.candidate.overallMedianMs,comparison:backend},
  frontend:{baselineMs:baselinePageMs,candidateMs:candidatePageMs,totalReductionPercent:(1-candidatePageMs/baselinePageMs)*100,comparison:pages},
  externalMarket:{baselineMs:pageWorkflowMs(baselinePages,'external-market'),candidateMs:pageWorkflowMs(candidatePages,'external-market'),includedInCombinedScore:false,note:'External network and market service observations; excluded from local performance gains.'},
  note:'The combined score measures the declared backend workflow plus two navigations to each local scenario after app readiness, with existing startup and prefetch caches. First navigation is not cold OS cache. External market observations are separate. Windowed gateway RPC counts exclude IPC. Startup including plugins is reported separately. All percentage/seconds target fields here and in nested comparisons are historical diagnostics, not current acceptance criteria; compatibility aliases remain available. Measurement integrity is validated independently of those thresholds.'
 };
}
function readJson(file){return JSON.parse(fs.readFileSync(path.resolve(file),'utf8'));}
function main(argv=process.argv){
 if(argv.includes('--help')){console.log('node scripts/compare-performance-reports.js --backend-baseline <report.json> --backend-candidate <report.json> --frontend-baseline <report.json> --frontend-candidate <report.json> [--out <report.json>]\nEach side requires matching recorded artifact/runtime/config/state/machine/cache identities. Missing identity evidence is not comparable. Target fields are historical diagnostics, not current acceptance criteria.');return;}
 const option=name=>{const index=argv.indexOf(name);assert.ok(index>=0&&argv[index+1],`Missing ${name}`);return argv[index+1];};
 const result=compareCombinedReports(readJson(option('--backend-baseline')),readJson(option('--backend-candidate')),readJson(option('--frontend-baseline')),readJson(option('--frontend-candidate'))),out=argv.indexOf('--out')>=0?option('--out'):null;
 if(out){fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(path.resolve(out),JSON.stringify(result,null,2)+'\n');}
 console.log(JSON.stringify(result,null,2));
}
module.exports={pageWorkflowMs,compareCombinedReports,main};
if(require.main===module){try{main();}catch(error){console.error(error.message);process.exitCode=1;}}
