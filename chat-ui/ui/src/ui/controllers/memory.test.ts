import test from "node:test";
import assert from "node:assert/strict";
import {loadMemoryStatus, invalidateMemoryStatus, resetGroundedShortTerm, type MemoryStatusState} from "./memory.ts";
import type {GatewayBrowserClient} from "../gateway.ts";

const state = (): MemoryStatusState => ({memoryStatus:null,statusLoading:false,statusLoaded:false,statusFailed:false});

test("failed memory prefetch releases its request so a later visit can retry", async () => {
  let calls = 0;
  const client = {async request() {
    if (++calls === 1) throw Error("temporarily unavailable");
    return {provider:"local",embedding:{ok:true}};
  }} as unknown as GatewayBrowserClient;
  const gateway = {client,connected:true}, prefetched = state(), visible = state();
  await loadMemoryStatus(prefetched,gateway,()=>{});
  assert.equal(prefetched.statusFailed,true);
  await loadMemoryStatus(visible,gateway,()=>{});
  assert.equal(calls,2);
  assert.equal(visible.memoryStatus?.embedding?.ok,true);
  assert.equal(visible.statusFailed,false);
});

test("concurrent memory readers share only the in-flight request and then reuse the successful snapshot", async () => {
  let calls = 0, finish!: (value:unknown)=>void;
  const client = {request() {calls++;return new Promise(resolve=>{finish=resolve;});}} as unknown as GatewayBrowserClient;
  const gateway = {client,connected:true}, a=state(), b=state();
  const readers=[loadMemoryStatus(a,gateway,()=>{}),loadMemoryStatus(b,gateway,()=>{})];
  finish({provider:"local",embedding:{ok:true}});
  await Promise.all(readers);
  await loadMemoryStatus(state(),gateway,()=>{});
  assert.equal(calls,1);
  assert.deepEqual(a.memoryStatus,b.memoryStatus);
});

test("a disconnected connection cannot retain a memory snapshot or admit a late result", async () => {
  let calls=0,finish!: (value:unknown)=>void;
  const client={request(){calls++;return calls===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve({provider:'new'});}} as unknown as GatewayBrowserClient;
  const gateway={client,connected:true},old=state();
  const pending=loadMemoryStatus(old,gateway,()=>{});
  invalidateMemoryStatus(client);
  finish({provider:'old'});await pending;
  const current=state();await loadMemoryStatus(current,gateway,()=>{});
  assert.equal(calls,2);assert.equal(current.memoryStatus?.provider,'new');
});

test("a successful memory reset invalidates the cached snapshot", async () => {
  let reads=0;
  const client={async request(method:string){return method==='doctor.memory.status'?{dreaming:{shortTermCount:++reads===1?9:0}}:{};}} as unknown as GatewayBrowserClient;
  const gateway={client,connected:true};await loadMemoryStatus(state(),gateway,()=>{});
  assert.equal(await resetGroundedShortTerm(client),true);
  const current=state();await loadMemoryStatus(current,gateway,()=>{});
  assert.equal(reads,2);assert.equal(current.memoryStatus?.dreaming?.shortTermCount,0);
});

test("a late old-client read cannot clear loading or overwrite a newer connection", async () => {
  let finishOld!: (value:unknown)=>void,finishNew!: (value:unknown)=>void;
  const oldClient={request:()=>new Promise(resolve=>{finishOld=resolve;})} as unknown as GatewayBrowserClient;
  const newClient={request:()=>new Promise(resolve=>{finishNew=resolve;})} as unknown as GatewayBrowserClient;
  const gateway={client:oldClient,connected:true},view=state();
  const old=loadMemoryStatus(view,gateway,()=>{});gateway.client=newClient;
  const next=loadMemoryStatus(view,gateway,()=>{});
  assert.equal(typeof finishNew,'function');
  finishOld({provider:'old'});await old;assert.equal(view.statusLoading,true);
  finishNew({provider:'new'});await next;assert.equal(view.memoryStatus?.provider,'new');assert.equal(view.statusLoading,false);
});

test("memory snapshots expire and an explicit probe always reaches the gateway", async () => {
  const originalNow=Date.now;let now=1000,calls=0;
  const client={async request(){return {provider:String(++calls)};}} as unknown as GatewayBrowserClient;
  const gateway={client,connected:true},view=state();
  try {Date.now=()=>now;await loadMemoryStatus(view,gateway,()=>{});now+=30001;
    await loadMemoryStatus(view,gateway,()=>{});assert.equal(calls,2);
    await loadMemoryStatus(state(),gateway,()=>{},{probe:true});assert.equal(calls,3);
  }finally{Date.now=originalNow;}
});
