const test=require('node:test');
const assert=require('node:assert/strict');
const {buildPlan,hardFailures}=require('./lib/release-ui-plan');

test('release plan covers every view, settings tab and boundary without duplicate scenes',()=>{
  const plan=buildPlan(4,13);
  assert.equal(new Set(plan.map(x=>x.name)).size,plan.length);
  for(let i=0;i<4;i++){
    const view=plan.filter(x=>x.route==='main' && x.index===i);
    assert.ok(view.some(x=>x.width===800 && x.theme==='dark'));
    assert.ok(view.some(x=>x.width===1440 && x.theme==='light'));
    assert.ok(view.some(x=>x.lang==='en'));
  }
  for(let i=0;i<13;i++)assert.ok(plan.some(x=>x.route==='settings' && x.index===i));
  assert.ok(plan.some(x=>x.dsf===1.25));assert.ok(plan.some(x=>x.dsf===1.5));assert.ok(plan.some(x=>x.motion));
});

test('default smoke materially reduces scenes and screenshots while full mode restores all corners',()=>{
  const fast=buildPlan(4,13),full=buildPlan(4,13,true);
  assert.ok(fast.length<=full.length*0.55);
  assert.equal(fast.filter(x=>x.screenshot).length,5);
  for(let i=0;i<13;i++)assert.equal(full.filter(x=>x.route==='settings' && x.index===i && x.lang==='zh').length,4);
});

test('missing navigation and any hard gate failure cannot become a silent pass',()=>{
  assert.throws(()=>buildPlan(3,13));assert.throws(()=>buildPlan(4,0));
  for(const fail of [{overlaps:['x']},{bare:['key']},{text:{pageHOverflow:true}},{rendererExceptions:1}])assert.equal(hardFailures(fail).length,1);
  assert.deepEqual(hardFailures({text:{clipped:['soft warning']},contrast:['soft warning']}),[]);
});

test('a missing required interactive control fails instead of being skipped',async()=>{
  const {click}=require('./release-ui-smoke');
  await assert.rejects(click({evaluate:async()=>false},'missingControl',{timeoutMs:0}),/Required control missing/);
});

test('startup failures still write a machine-readable failure report',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'release-ui-report-'));
  t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
  const {main}=require('./release-ui-smoke');
  assert.equal(await main(['node','smoke','--exe',path.join(out,'missing.exe'),'--out',out]),1);
  const result=JSON.parse(fs.readFileSync(path.join(out,'report.json'),'utf8'));
  assert.equal(result.ok,false);assert.equal(result.launches,0);assert.match(result.error,/executable/);
  assert.equal(result.phase,'startup');
});

test('page-data readiness waits for data and rejects persistent loading screens',async()=>{
  const {waitForData}=require('./release-ui-smoke');let polls=0;
  await waitForData({evaluate:async()=>++polls<2});assert.equal(polls,2);
  await assert.rejects(waitForData({evaluate:async()=>true},{timeoutMs:0}),/loading screen/);
});
