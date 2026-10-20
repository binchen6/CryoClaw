import test from "node:test";
import assert from "node:assert/strict";
import {showToast,getToastMessage,getToastKind,getToastAction,hideToast,isToastLeaving} from "./app-toast.ts";
import type {AppViewState} from "./app-view-state.ts";
test("global feedback deduplicates messages and preserves error severity",async()=>{
  let updates=0;
  const state={requestUpdate:()=>updates++} as unknown as AppViewState;
  showToast(state,'Save failed',undefined,'error');showToast(state,'Save failed',undefined,'error');
  assert.equal(updates,1);assert.equal(getToastKind(),'error');assert.equal(getToastMessage(),'Save failed');
  hideToast(state);await new Promise(resolve=>setTimeout(resolve,250));assert.equal(getToastMessage(),null);
});
test("a new action is retained even when the notification text is unchanged",async()=>{
  const state={requestUpdate:()=>{}} as unknown as AppViewState;
  const one={label:'Open',onClick:()=>{}},two={label:'Open',onClick:()=>{}};
  showToast(state,'Ready',one);showToast(state,'Ready',two);assert.equal(getToastAction(),two);
  hideToast(state);await new Promise(resolve=>setTimeout(resolve,250));assert.equal(getToastMessage(),null);
});
test("re-showing the same toast resets its auto-dismiss timer",(t)=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const state={requestUpdate:()=>{}} as unknown as AppViewState;
  try{
    showToast(state,'Save failed',undefined,'error');
    t.mock.timers.tick(7000);
    assert.equal(isToastLeaving(),false);
    showToast(state,'Save failed',undefined,'error');
    // 距首次出现已 14s：旧 8s 时限早已到达，若计时被重置则仍在展示
    t.mock.timers.tick(7000);
    assert.equal(getToastMessage(),'Save failed');assert.equal(isToastLeaving(),false);
    // 距重复出现满 8s：开始退场；再经过 200ms 退场延迟后移除
    t.mock.timers.tick(1000);
    assert.equal(isToastLeaving(),true);assert.equal(getToastMessage(),'Save failed');
    t.mock.timers.tick(200);
    assert.equal(getToastMessage(),null);assert.equal(isToastLeaving(),false);
  }finally{
    hideToast(state);t.mock.timers.tick(200);
  }
});
