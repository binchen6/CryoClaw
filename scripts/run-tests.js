#!/usr/bin/env node
"use strict";
const fs=require('node:fs'),path=require('node:path');
const {runSuites}=require('./lib/test-suites');
const root=path.resolve(__dirname,'..'),outDir=path.join(root,'.cache/test-results');fs.mkdirSync(outDir,{recursive:true});
const suites=[{id:'vitest',args:[path.join(root,'node_modules/vitest/vitest.mjs'),'run']},...['node','chat-ui','script'].map((name,i)=>({id:['node','chat','scripts'][i],args:[path.join(__dirname,`run-${name}-tests.js`)]}))];
const started=Date.now();
runSuites(suites,{root,outDir,concurrency:process.argv.includes('--serial')?1:Number(process.env.CRYOCLAW_TEST_CONCURRENCY??3),onResult:r=>{console.log(`${r.ok?'PASS':'FAIL'} ${r.id} ${r.elapsedMs??0}ms (${r.log??r.error})`);if(!r.ok&&r.log)console.error(fs.readFileSync(r.log,'utf8').split(/\r?\n/).slice(-35).join('\n'));}}).then(report=>{
  fs.writeFileSync(path.join(outDir,'report.json'),JSON.stringify({...report,elapsedMs:Date.now()-started},null,2));console.log(`All four test layers: ${report.ok?'PASS':'FAIL'} (${Date.now()-started}ms)`);process.exitCode=report.ok?0:1;
}).catch(error=>{console.error(error);process.exitCode=1;});
