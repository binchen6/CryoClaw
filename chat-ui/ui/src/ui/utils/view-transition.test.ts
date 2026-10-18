import test from "node:test";
import assert from "node:assert/strict";
import {transitionView} from "./view-transition.ts";

test("navigation respects reduced motion and unsupported browsers",()=>{
  const previousWindow=globalThis.window,previousDocument=globalThis.document;
  let actions=0,snapshots=0;
  try {
    Object.assign(globalThis,{window:{matchMedia:()=>({matches:true})},document:{startViewTransition(){snapshots++;}}});
    transitionView(()=>actions++);
    Object.assign(globalThis,{window:{matchMedia:()=>({matches:false})},document:{}});
    transitionView(()=>actions++);
    assert.equal(actions,2);assert.equal(snapshots,0);
  } finally {Object.assign(globalThis,{window:previousWindow,document:previousDocument});}
});
test("rapid navigation skips an old animation without dropping actions",async()=>{
  const previousWindow=globalThis.window,previousDocument=globalThis.document;
  const actions:number[]=[];let skipped=0;
  let finish!:()=>void;
  const finished=new Promise<void>(r=>{finish=r;});
  try {
    Object.assign(globalThis,{window:{matchMedia:()=>({matches:false})},document:{startViewTransition(update:()=>Promise<void>){void update();return {finished,skipTransition(){skipped++;}};}}});
    transitionView(()=>actions.push(1));transitionView(()=>actions.push(2));
    assert.deepEqual(actions,[1,2]);assert.equal(skipped,1);
    finish();await finished;await Promise.resolve();
  } finally {Object.assign(globalThis,{window:previousWindow,document:previousDocument});}
});
