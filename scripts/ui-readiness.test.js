const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {waitForVisualReady}=require('./lib/ui-readiness');

function renderer({widths=[800],animations=()=>[],fonts=Promise.resolve(),commit=Promise.resolve()}={}) {
  let samples=0;
  const element={checkVisibility:()=>true,scrollWidth:800,scrollHeight:600,getBoundingClientRect:()=>({
    x:0,y:0,width:widths[Math.min(samples++,widths.length-1)],height:600,
  })};
  const context={Date,setTimeout,clearTimeout,getComputedStyle:()=>({opacity:'1',transform:'none'}),
    window:{__smokeTransition:{updateCallbackDone:commit,finished:new Promise(()=>{})}},
    document:{fonts:{ready:fonts},querySelector:()=>({updateComplete:Promise.resolve()}),
      querySelectorAll:()=>[element],getAnimations:animations}};
  return {run:options=>vm.runInNewContext(`(${waitForVisualReady})(${JSON.stringify({pollMs:1,timeoutMs:200,...options})})`,context),samples:()=>samples};
}

test('committed transition can settle even if Chromium never resolves finished',async()=>{
  const page=renderer();await page.run();assert.equal(page.samples(),3);
});

test('layout must remain identical for three samples after its final change',async()=>{
  const page=renderer({widths:[800,810,820,820,820]});
  await page.run();assert.equal(page.samples(),5);
});

test('finite animations block readiness while perpetual status spinners do not',async()=>{
  let polls=0;
  const page=renderer({animations:()=>++polls<3?[{playState:'running',effect:{getComputedTiming:()=>({iterations:1})}}]:
    [{playState:'running',effect:{getComputedTiming:()=>({iterations:Infinity})}}]});
  await page.run();assert.equal(page.samples(),5);
});

test('fonts, transition content and permanently moving layouts fail within their deadline',async()=>{
  const never=new Promise(()=>{});
  await assert.rejects(renderer({fonts:never}).run({timeoutMs:10}),/timed out: fonts/);
  await assert.rejects(renderer({commit:never}).run({timeoutMs:10}),/timed out: transition content/);
  await assert.rejects(renderer({animations:()=>[{playState:'running'}]}).run({timeoutMs:10}),/layout or animation/);
});

test('operation pace is an explicit minimum even when the page is already stable',async()=>{
  const started=Date.now();await renderer().run({paceMs:20});assert.ok(Date.now()-started>=20);
});
