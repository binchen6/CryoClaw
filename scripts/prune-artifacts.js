#!/usr/bin/env node
"use strict";
const fs=require('node:fs'),path=require('node:path');
const CACHE_EXPIRED=['kernel-recon','kernel-recon-913','gw-extract','gateway-extracted','probe-gw','asar-inspect','kernel-20261004','archived-release-assets','goal-temp','goal-remote-download','goal-installer-app.asar','goal-npm-cache','package-store-asar.7z','package-compressed.7z','electron-qa','npm-build','npm-release-cache','promo-final','promo-final-2','promo-live','openclaw-10.6-pristine','openclaw-2026.10.6.tgz','e-test.exe','maintenance-temp','proxy-ui-smoke-state','theme-quota-state','next-ui-state','theme-agent-qa','ui-smoke-state','release-qa-state','workbench-qa-state','test-tmp','tmp','website-rework','app-extract','video-tools','website-20261025-font-tools','promo-font-tools'];
const OUT_EXPIRED=['win32-x64-new','release-20261018-1','next-review','next-test','theme-quota-test','release'];
function inside(base,target){const rel=path.relative(base,target);return rel!=='' && rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel);}
function validateTarget(root,relative){
  const canonical=fs.realpathSync(root),target=path.resolve(root,relative);
  const base=['.cache','out'].map(name=>path.resolve(root,name)).find(base=>inside(base,target));
  if(!base || !inside(canonical,base))throw Error('Cleanup target must be inside .cache or out');
  const baseReal=fs.realpathSync(base);
  if(!inside(canonical,baseReal) || fs.lstatSync(base).isSymbolicLink())throw Error('Cleanup root must not redirect outside the workspace');
  const stat=fs.lstatSync(target);
  if(stat.isSymbolicLink() || !inside(baseReal,fs.realpathSync(target)))throw Error('Cleanup target must not be a redirected path');
  return {target,base:baseReal};
}
function planPrune(root,{version,before=Date.now()-24*60*60*1000}={}){
  for(const name of ['.cache','out']){
    const base=path.resolve(root,name);
    if(fs.existsSync(base) && (fs.lstatSync(base).isSymbolicLink() || !inside(fs.realpathSync(root),fs.realpathSync(base))))throw Error('Cleanup root must not redirect outside the workspace');
  }
  const candidates=[];
  const add=(relative,reason)=>{if(!fs.existsSync(path.resolve(root,relative)))return;const checked=validateTarget(root,relative);if(fs.statSync(checked.target).mtimeMs<=before)candidates.push({relative,reason});};
  for(const name of CACHE_EXPIRED)add(path.join('.cache',name),'obsolete investigation or completed release scratch');
  for(const name of OUT_EXPIRED)add(path.join('out',name),'superseded experimental build');
  const outputs=path.join(root,'out');
  if(fs.existsSync(outputs))for(const target of fs.readdirSync(outputs).filter(name=>/^win32-(x64|arm64)$/.test(name))){
    const dir=path.join(outputs,target);if(fs.lstatSync(dir).isSymbolicLink())throw Error('Build output must not be a link');
    const names=fs.readdirSync(dir),pattern=/^CryoClaw-Setup-(\d+\.\d+\.\d+)-(?:x64|arm64)\.exe(?:\.blockmap)?$/;
    const versions=[...new Set([version,...names.map(name=>pattern.exec(name)?.[1])].filter(Boolean))].sort((a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);return y[0]-x[0]||y[1]-x[1]||y[2]-x[2];});
    const keep=new Set(versions.slice(0,2));
    for(const name of names){const v=pattern.exec(name)?.[1];if(v && !keep.has(v))add(path.join('out',target,name),'older than the two retained release versions');}
  }
  const qa=path.join(outputs,'ui-qa');
  if(fs.existsSync(qa)){
    if(fs.lstatSync(qa).isSymbolicLink())throw Error('Screenshot output must not be a link');
    const dates=fs.readdirSync(qa).filter(name=>/^\d{4}-\d\d-\d\dT/.test(name)).sort().reverse();
    for(const name of dates.slice(2))add(path.join('out','ui-qa',name),'older than the two retained screenshot runs');
  }
  return candidates;
}
function removeTree(target,base){
  if(!inside(base,target))throw Error('Deletion escaped the approved root');
  const stat=fs.lstatSync(target);
  if(stat.isSymbolicLink()){try{fs.unlinkSync(target);}catch{fs.rmdirSync(target);}return 0;}
  if(!inside(base,fs.realpathSync(target)))throw Error('Deletion resolved outside the approved root');
  let bytes=0;
  if(stat.isDirectory()){
    let names;try{names=fs.readdirSync(target);}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;fs.chmodSync(target,0o700);names=fs.readdirSync(target);}
    for(const name of names)bytes+=removeTree(path.join(target,name),base);
    try{fs.rmdirSync(target);}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;fs.chmodSync(target,0o700);fs.rmdirSync(target);}
  }else{
    try{fs.unlinkSync(target);}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;fs.chmodSync(target,0o600);fs.unlinkSync(target);}
    bytes=stat.size;
  }
  if(fs.existsSync(target))throw Error('Deletion left a residual target');
  return bytes;
}
function applyPlan(root,plan){
  let bytes=0;const deleted=[],failed=[];
  for(const entry of plan){try{const {target,base}=validateTarget(root,entry.relative);bytes+=removeTree(target,base);deleted.push(entry.relative);console.log('[prune] removed '+entry.relative);}catch(error){failed.push({path:entry.relative,error:error.message});}}
  return {deleted,failed,bytes};
}
function main(){
  const args=process.argv.slice(2),root=path.resolve(__dirname,'..'),version=require('../package.json').version;
  const beforeIndex=args.indexOf('--before');const before=beforeIndex<0?undefined:Date.parse(args[beforeIndex+1]);
  if(beforeIndex>=0 && !Number.isFinite(before))throw Error('--before requires an ISO timestamp');
  const plan=planPrune(root,{version,before});
  if(!args.includes('--apply')){console.log(JSON.stringify({dryRun:true,plan},null,2));return;}
  const report=applyPlan(root,plan);fs.writeFileSync(path.join(root,'.cache','maintenance-prune-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({deleted:report.deleted.length,failed:report.failed,bytes:report.bytes},null,2));if(report.failed.length)process.exitCode=1;
}
module.exports={planPrune,validateTarget,applyPlan};
if(require.main===module){try{main();}catch(error){console.error(error.message);process.exitCode=1;}}
