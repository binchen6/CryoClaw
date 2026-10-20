const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {runSuites,runSuite}=require('./lib/test-suites');
test('suite scheduler bounds concurrency, runs every layer and preserves result order',async()=>{
  let active=0,max=0;const seen=[];
  const result=await runSuites(['a','b','c','d'].map(id=>({id})),{execute:async suite=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));seen.push(suite.id);active--;return {id:suite.id,ok:suite.id!=='b'};}});
  assert.equal(max,2);assert.equal(seen.length,4);assert.equal(result.ok,false);assert.deepEqual(result.results.map(x=>x.id),['a','b','c','d']);
});
test('suite execution keeps failure evidence and terminates hung processes',async t=>{
  const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'test-suite-'));t.after(()=>fs.rmSync(outDir,{recursive:true,force:true}));
  const failed=await runSuite({id:'fail',args:['-e','console.error("failure evidence");process.exit(3)']},{root:outDir,outDir});assert.equal(failed.ok,false);assert.match(fs.readFileSync(failed.log,'utf8'),/failure evidence/);
  const hung=await runSuite({id:'hang',args:['-e','setInterval(()=>{},1000)']},{root:outDir,outDir,timeoutMs:100});assert.equal(hung.ok,false);assert.equal(hung.timedOut,true);
});
