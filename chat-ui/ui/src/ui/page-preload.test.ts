import test from "node:test";
import assert from "node:assert/strict";
import type {AppViewState} from "./app-view-state.ts";
import {preloadPage,stopPagePreloads} from "./page-preload.ts";

test("preload skips hidden, offline and actively generating views",async()=>{
  const previous=globalThis.document;
  let calls=0;
  const host={connected:true,client:{request:async()=>{calls++;return {};}}} as unknown as AppViewState;
  try {
    Object.assign(globalThis,{document:{hidden:true}});
    await preloadPage(host,"extensions");
    Object.assign(globalThis,{document:{hidden:false}});
    host.connected=false;await preloadPage(host,"extensions");
    host.connected=true;host.chatRunId="active";await preloadPage(host,"extensions");
    assert.equal(calls,0);
  } finally {stopPagePreloads(host);Object.assign(globalThis,{document:previous});}
});

test("preloads coalesce by view, serialize across pages and stop queued work on disconnect",async()=>{
  const previous=globalThis.document;
  const calls:string[]=[];
  let finish!:(value:unknown)=>void;
  const host={connected:true,hello:null,skillsLoading:false,cronLoading:false,runsLoading:false,cronJobs:[],
    client:{request(method:string){calls.push(method);return new Promise(resolve=>finish=resolve);}}} as unknown as AppViewState;
  try {
    Object.assign(globalThis,{document:{hidden:false}});
    const first=preloadPage(host,"extensions"),duplicate=preloadPage(host,"extensions");
    const next=preloadPage(host,"tasks");
    assert.equal(first,duplicate);await Promise.resolve();
    assert.deepEqual(calls,["skills.status"]);
    stopPagePreloads(host);finish({skills:[]});await next;
    assert.deepEqual(calls,["skills.status"],"revoked queued task requests never start");
  } finally {stopPagePreloads(host);Object.assign(globalThis,{document:previous});}
});
