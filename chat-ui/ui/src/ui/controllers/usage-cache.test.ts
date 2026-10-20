import test from 'node:test';import assert from 'node:assert/strict';
import type {GatewayBrowserClient} from '../gateway.ts';
import {loadUsageSnapshot,peekUsageSnapshot} from './usage-cache.ts';
function gateway(request:(method:string,params:any)=>Promise<any>){return {connected:true,client:{request} as unknown as GatewayBrowserClient};}
test('usage prefetch and foreground reads coalesce and ranges/clients stay isolated',async()=>{
  let calls=0;const state=gateway(async()=>{calls++;return {sessions:[],totals:{input:1}};});
  const [first,next]=await Promise.all([loadUsageSnapshot(state,'30d'),loadUsageSnapshot(state,'30d')]);
  assert.equal(calls,3);assert.equal(first,next);assert.equal(peekUsageSnapshot(state,'30d'),first);
  await loadUsageSnapshot(state,'7d');assert.equal(calls,6);await loadUsageSnapshot(state,'30d',true);assert.equal(calls,9);
  const other=gateway(async()=>({sessions:[]}));assert.equal(peekUsageSnapshot(other,'30d'),undefined);
});
test('failed required usage reads are retryable and optional failures do not reuse old enhanced data',async()=>{
  let fails=true;const state=gateway(async method=>{if(fails || method!=='sessions.usage')throw Error('offline');return {sessions:[]};});
  await assert.rejects(loadUsageSnapshot(state,'today'));assert.equal(peekUsageSnapshot(state,'today'),undefined);
  fails=false;const result=await loadUsageSnapshot(state,'today');assert.equal(result.cost.totals,null);assert.deepEqual(result.providerStatus,[]);
});
