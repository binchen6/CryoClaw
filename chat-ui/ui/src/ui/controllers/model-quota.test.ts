import test from "node:test";
import assert from "node:assert/strict";
import {loadModelQuota,quotaProvider,quotaRemaining,invalidateModelQuota,quotaWindowsForModel} from "./model-quota.ts";
import type {GatewayBrowserClient} from "../gateway.ts";

test("quota uses the current session provider and the tightest known account window",()=>{
  assert.equal(quotaProvider("deepseek/deepseek-chat","kimi-coding"),"deepseek","selected qualified model wins over stale session metadata");
  assert.equal(quotaProvider("openai/model"),"openai");
  assert.equal(quotaProvider("model","custom-route"),"custom-route");
  assert.equal(quotaProvider("bare"),"");
  assert.equal(quotaRemaining([{label:"5h",usedPercent:52},{label:"Week",usedPercent:24}]),48);
  assert.equal(quotaRemaining([{label:"unknown",usedPercent:null}]),null);
  assert.equal(quotaRemaining([{label:"over",usedPercent:120}]),0);
});

test("Kimi composer quota reads the same usage/limits shape as model settings without waiting for unrelated accounts",async()=>{
  const previous=globalThis.window;let nativeCalls=0;
  try {
    Object.assign(globalThis,{window:{cryoclaw:{kimiGetUsage:async()=>({success:true,data:{usage:{used:'25',limit:'100'},limits:[{detail:{remaining:'70',limit:'100'}}]}})}}});
    const client={request:async()=>{nativeCalls++;return new Promise(()=>{});}} as unknown as GatewayBrowserClient;
    const value=await loadModelQuota(client,'kimi-coding');assert.equal(quotaRemaining(value.windows),70);assert.equal(nativeCalls,0);assert.equal(value.error,undefined);
  }finally{Object.assign(globalThis,{window:previous});}
});
test("quota requests coalesce per connection and provider and share native usage across model changes",async()=>{
  let calls=0;
  const client={async request(){calls++;return {providers:[{provider:"openai",plan:"plus",windows:[{label:"5h",usedPercent:52}]},{provider:"another",windows:[{label:"day",usedPercent:10}]}]};}} as unknown as GatewayBrowserClient;
  const [first,second]=await Promise.all([loadModelQuota(client,"openai-codex"),loadModelQuota(client,"openai-codex")]);
  assert.equal(first,second);assert.equal(calls,1);assert.equal(quotaRemaining(first.windows),48);
  await loadModelQuota(client,"another");assert.equal(calls,1);
  await loadModelQuota(client,"openai-codex",true);assert.equal(calls,2);
});
test("API balance fallback is displayed as money without inventing a percentage",async()=>{
  const previous=globalThis.window;
  try {
    Object.assign(globalThis,{window:{cryoclaw:{settingsGetProviderUsage:async()=>({success:true,data:{supported:true,kind:"balance",currency:"CNY",available:"12.34"}})}}});
    const client={async request(){return {providers:[]};}} as unknown as GatewayBrowserClient;
    const quota=await loadModelQuota(client,"deepseek");
    assert.equal(quota.balance?.available,"12.34");assert.equal(quotaRemaining(quota.windows),null);
  } finally {Object.assign(globalThis,{window:previous});}
});
test("unsupported providers remain unknown and a fresh connection never reuses another account cache",async()=>{
  const previous=globalThis.window;
  try {
    Object.assign(globalThis,{window:{cryoclaw:{settingsGetProviderUsage:async()=>({success:false,unsupported:true})}}});
    const client={async request(){return {providers:[]};}} as unknown as GatewayBrowserClient;
    const quota=await loadModelQuota(client,"custom-example");
    assert.equal(quota.unsupported,true);assert.equal(quotaRemaining(quota.windows),null);
    assert.equal(quota.balance,undefined);
  } finally {Object.assign(globalThis,{window:previous});}
});

test("temporary quota failure retains last successful values with an explicit stale marker",async()=>{
  const previous=globalThis.window;
  let failed=false;
  try {
    Object.assign(globalThis,{window:{cryoclaw:{settingsGetProviderUsage:async()=>({success:false,unsupported:true})}}});
    const client={async request(){return {updatedAt:Date.now(),providers:[failed
      ?{provider:"openai",windows:[],error:"Timeout"}
      :{provider:"openai",windows:[{label:"5h",usedPercent:35}]}]};}} as unknown as GatewayBrowserClient;
    const good=await loadModelQuota(client,"openai-codex");failed=true;
    const stale=await loadModelQuota(client,"openai-codex",true);
    assert.equal(quotaRemaining(stale.windows),65);assert.equal(stale.at,good.at);
    assert.equal(stale.stale,true);assert.equal(stale.error,"Timeout");
    invalidateModelQuota(client);
    const changedAccount=await loadModelQuota(client,"openai-codex");
    assert.equal(changedAccount.windows.length,0,"an account switch must discard old account values");
  } finally {Object.assign(globalThis,{window:previous});}
});

test("concurrent forced provider refreshes still share the same in-flight native request",async()=>{
  let finish!:(value:unknown)=>void,calls=0;
  const client={request(){calls++;return new Promise(resolve=>finish=resolve);}} as unknown as GatewayBrowserClient;
  const one=loadModelQuota(client,"openai",true),two=loadModelQuota(client,"anthropic",true);
  finish({providers:[{provider:"openai",windows:[{label:"day",usedPercent:10}]},{provider:"anthropic",windows:[{label:"week",usedPercent:20}]}]});
  await Promise.all([one,two]);assert.equal(calls,1);
});

test("free-model request limits do not incorrectly exhaust paid models",()=>{
  const windows=[{label:"key",usedPercent:20},{label:"free",usedPercent:100,model:":free"},
    {label:"specific",usedPercent:50,model:"MiniMax-M2.5"}];
  assert.equal(quotaRemaining(quotaWindowsForModel(windows,"openai/gpt-5")),80);
  assert.equal(quotaRemaining(quotaWindowsForModel(windows,"vendor/model:free")),0);
  assert.equal(quotaRemaining(quotaWindowsForModel(windows,"minimax-m2.5")),50);
});

test("a native refresh marker is re-read rather than cached as unsupported",async(t)=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  let calls=0;
  const client={async request(){return ++calls===1?{refreshing:true,providers:[]}:
    {providers:[{provider:"openai",windows:[{label:"5h",usedPercent:10}]}]};}} as unknown as GatewayBrowserClient;
  const loading=loadModelQuota(client,"openai-codex");
  await Promise.resolve();await Promise.resolve();
  t.mock.timers.tick(800);
  const value=await loading;
  assert.equal(calls,2);assert.equal(quotaRemaining(value.windows),90);
});
