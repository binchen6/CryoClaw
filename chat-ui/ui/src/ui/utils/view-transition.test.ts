import test from 'node:test';
import assert from 'node:assert/strict';
import {transitionView,isViewTransitionActive} from './view-transition.ts';

test('route navigation applies synchronously without a document snapshot blocking controls',()=>{
 const previous=globalThis.document,previousWindow=globalThis.window;let actions=0,snapshots=0;
 try{Object.assign(globalThis,{window:{matchMedia:()=>({matches:false})},document:{startViewTransition(){snapshots++;return {finished:Promise.resolve(),skipTransition(){}};}}});transitionView(()=>actions++);assert.equal(actions,1);assert.equal(snapshots,0);}
 finally{Object.assign(globalThis,{document:previous,window:previousWindow});}
});
test('navigation retires an existing snapshot and keeps the action even if cleanup fails',()=>{
 const previous=globalThis.document;let skipped=0,actions=0;
 try{Object.assign(globalThis,{document:{activeViewTransition:{skipTransition(){skipped++;throw Error('already gone');}}}});transitionView(()=>actions++);assert.equal(skipped,1);assert.equal(actions,1);}
 finally{Object.assign(globalThis,{document:previous});}
});
test('rapid navigation keeps every latest action without waiting for animations',()=>{
 const previous=globalThis.document,actions:number[]=[];
 try{Object.assign(globalThis,{document:{}});transitionView(()=>actions.push(1));transitionView(()=>actions.push(2));assert.deepEqual(actions,[1,2]);}
 finally{Object.assign(globalThis,{document:previous});}
});
test('component motion observes actual native transition activity',()=>{
 const previous=globalThis.document;
 try{Object.assign(globalThis,{document:{documentElement:{matches:(selector:string)=>selector===':active-view-transition'}}});assert.equal(isViewTransitionActive(),true);Object.assign(globalThis,{document:{}});assert.equal(isViewTransitionActive(),false);}
 finally{Object.assign(globalThis,{document:previous});}
});
