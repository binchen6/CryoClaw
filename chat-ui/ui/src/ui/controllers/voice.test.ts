import test from 'node:test';import assert from 'node:assert/strict';
import type {GatewayBrowserClient} from '../gateway.ts';
import {loadVoiceStatus,preloadVoiceStatus,applyTtsAction,type VoiceStatusState} from './voice.ts';
function state():VoiceStatusState{return {error:null,successMsg:null,actionPending:false,ttsStatus:null,ttsLoading:false,ttsLoaded:false,ttsFailed:false,talkConfig:null,talkLoaded:false,wakeTriggers:null,wakeLoaded:false};}
function gateway(request:(method:string)=>Promise<any>){return {connected:true,client:{request} as unknown as GatewayBrowserClient};}
test('voice prefetch shares three requests and writes invalidate the snapshot',async()=>{
  const calls:string[]=[];let enabled=false;const g=gateway(async method=>{calls.push(method);if(method==='tts.enable')enabled=true;return method==='tts.status'?{enabled,provider:'test'}:{};});
  const s=state();await Promise.all([preloadVoiceStatus(g),loadVoiceStatus(s,g,()=>{})]);assert.equal(calls.length,3);assert.equal(s.ttsStatus?.enabled,false);
  await loadVoiceStatus(s,g,()=>{});assert.equal(calls.length,3);
  await applyTtsAction(s,g,'tts.enable',{},()=>{});assert.equal(calls.length,7);assert.equal(s.ttsStatus?.enabled,true);
});
test('an older voice connection cannot overwrite a newer snapshot or its loading state',async()=>{
  let finish!:(value:any)=>void;const old=new Promise(resolve=>finish=resolve),g=gateway(async()=>old),s=state();
  const pending=loadVoiceStatus(s,g,()=>{});await Promise.resolve();
  g.client=gateway(async()=>({provider:'new'})).client;await loadVoiceStatus(s,g,()=>{});finish({provider:'old'});await pending;
  assert.equal(s.ttsStatus?.provider,'new');assert.equal(s.ttsLoading,false);
});
test('offline voice writes cannot report success and a failed read remains explicitly retryable',async()=>{
  let calls=0;const g=gateway(async()=>{calls++;throw Error('offline');}),s=state();g.connected=false;
  await applyTtsAction(s,g,'tts.enable',{},()=>{});assert.equal(calls,0);assert.equal(s.successMsg,null);
  g.connected=true;await loadVoiceStatus(s,g,()=>{});assert.equal(s.ttsFailed,true);assert.equal(calls,3);
  await loadVoiceStatus(s,g,()=>{});assert.equal(calls,3);
  await loadVoiceStatus(s,g,()=>{},true);assert.equal(calls,6);
});
