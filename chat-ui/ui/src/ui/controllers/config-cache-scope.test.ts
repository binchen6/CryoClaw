import test from "node:test";
import assert from "node:assert/strict";
import type {GatewayBrowserClient} from "../gateway.ts";
import {getConfigSnapshot,getCachedConfigSnapshot,invalidateConfigSnapshotCache} from "./config.ts";

test("a gateway connection never inherits another connection's configuration",async()=>{
  const client=(hash:string)=>({request:async()=>({hash,config:{},raw:null})}) as unknown as GatewayBrowserClient;
  assert.equal((await getConfigSnapshot(client("first")))?.hash,"first");
  assert.equal((await getConfigSnapshot(client("second")))?.hash,"second");
});

test("a late preloaded snapshot cannot replace a newer connection snapshot",async()=>{
  let finish!:(value:unknown)=>void;
  const old={request:()=>new Promise(resolve=>finish=resolve)} as unknown as GatewayBrowserClient;
  const fresh={request:async()=>({hash:"fresh",config:{},raw:null})} as unknown as GatewayBrowserClient;
  const loading=getConfigSnapshot(old);
  await getConfigSnapshot(fresh);
  finish({hash:"old",config:{},raw:null});
  assert.equal(await loading,null);assert.equal(getCachedConfigSnapshot()?.hash,"fresh");
});

test("invalidating configuration also revokes an in-flight snapshot",async()=>{
  let finish!:(value:unknown)=>void;
  const client={request:()=>new Promise(resolve=>finish=resolve)} as unknown as GatewayBrowserClient;
  const loading=getConfigSnapshot(client);invalidateConfigSnapshotCache();
  finish({hash:"obsolete",config:{},raw:null});
  assert.equal(await loading,null);assert.equal(getCachedConfigSnapshot(),null);
});
