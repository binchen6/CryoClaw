import test from 'node:test';import assert from 'node:assert/strict';
import {createCompletionOptions,loadCompletionOptions,completionPayload,finishSetup} from './setup-completion-state.ts';
test('startup options settle independently and unsupported/failed browsers remain off',async()=>{
  const state=createCompletionOptions();await loadCompletionOptions(state,async()=>({supported:true,enabled:true}),async()=>{throw Error('unknown browser');},()=>{});
  assert.equal(state.optionsLoaded,true);assert.equal(state.optionsFailed,true);assert.equal(state.launchAtLogin,true);assert.equal(completionPayload(state).enableWebbridge,false);
  state.launchAtLogin=false;state.launchTouched=true;await loadCompletionOptions(state,async()=>({supported:true,enabled:true}),async()=>({id:'chrome',name:'Chrome'}),()=>{});assert.equal(state.launchAtLogin,false);assert.equal(state.enableWebbridge,true);
});
test('a late startup-options query cannot overwrite a newer retry',async()=>{
  const state=createCompletionOptions();let finish!:(value:{supported:boolean;enabled:boolean})=>void;
  const old=loadCompletionOptions(state,()=>new Promise(resolve=>finish=resolve),async()=>null,()=>{});await Promise.resolve();
  await loadCompletionOptions(state,async()=>({supported:true,enabled:true}),async()=>({id:'edge',name:'Edge'}),()=>{});finish({supported:false,enabled:false});await old;
  assert.equal(state.defaultBrowser?.id,'edge');assert.equal(state.launchAtLogin,true);
});
test('a hung optional setting cannot trap the final setup screen',async ctx=>{
  ctx.mock.timers.enable({apis:['setTimeout']});const state=createCompletionOptions();
  const pending=loadCompletionOptions(state,()=>new Promise(()=>{}),async()=>null,()=>{},100);
  ctx.mock.timers.tick(100);await pending;assert.equal(state.optionsLoaded,true);assert.equal(state.initializing,false);assert.equal(state.optionsFailed,true);
});
test('completion waits for options, coalesces clicks and permits retry after failure',async()=>{
  const state=createCompletionOptions();let calls=0;
  assert.equal(await finishSetup(state,async()=>{calls++;return {success:true};},()=>{}),false);assert.equal(calls,0);
  state.optionsLoaded=true;let finish!:(value:{success:boolean})=>void;
  const pending=finishSetup(state,()=>{calls++;return new Promise(resolve=>finish=resolve);},()=>{});assert.equal(await finishSetup(state,async()=>({success:true}),()=>{}),false);finish({success:false});await assert.rejects(pending);assert.equal(state.starting,false);
  assert.equal(await finishSetup(state,async()=>({success:true}),()=>{}),true);assert.equal(state.completed,true);
});
