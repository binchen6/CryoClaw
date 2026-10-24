import test from "node:test";
import assert from "node:assert/strict";
import type {AppViewState} from "./app-view-state.ts";
import {preloadPage,stopPagePreloads,schedulePagePreloads} from "./page-preload.ts";

test("connecting never scans unopened pages even after visible reads finish",async t=>{
  const previous=globalThis.document,calls:string[]=[];
  const host={connected:true,chatLoading:false,sessionsLoading:false,progressCard:{loading:false},client:{request:async(method:string)=>{calls.push(method);return {};}}} as unknown as AppViewState;
  Object.assign(globalThis,{document:{hidden:false}});t.mock.timers.enable({apis:['setTimeout']});
  try {
    schedulePagePreloads(host);t.mock.timers.tick(60000);
    for(let n=0;n<30;n++)await Promise.resolve();
    assert.equal(calls.length,0,'background discovery must wait for navigation intent');
    await preloadPage(host,'settings');assert.ok(calls.includes('config.get'));
  }finally{stopPagePreloads(host);t.mock.timers.reset();Object.assign(globalThis,{document:previous});}
});

test("background page reads wait for visible startup data and are revoked on disconnect",async t=>{
  const previous=globalThis.document,calls:string[]=[];
  const host={connected:true,chatLoading:true,sessionsLoading:true,progressCard:{loading:false},client:{request:async(method:string)=>{calls.push(method);return {};}}} as unknown as AppViewState;
  Object.assign(globalThis,{document:{hidden:false}});t.mock.timers.enable({apis:["setTimeout"]});
  try{
    schedulePagePreloads(host);await preloadPage(host,"settings");t.mock.timers.tick(15000);
    for(let n=0;n<10;n++)await Promise.resolve();assert.equal(calls.length,0,"no scans compete with initial chat reads");
    stopPagePreloads(host);host.chatLoading=false;host.sessionsLoading=false;t.mock.timers.tick(30000);
    for(let n=0;n<10;n++)await Promise.resolve();assert.equal(calls.length,0,"retired connection never arms its delayed preloads");
    await preloadPage(host,"settings");assert.ok(calls.includes("config.get") && calls.includes("models.list"),"intent preloads resume after initial data is ready");
  }finally{stopPagePreloads(host);t.mock.timers.reset();Object.assign(globalThis,{document:previous});}
});

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
