import test from "node:test";
import assert from "node:assert/strict";
import {showToast,getToastMessage,getToastKind,getToastAction,hideToast} from "./app-toast.ts";
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
