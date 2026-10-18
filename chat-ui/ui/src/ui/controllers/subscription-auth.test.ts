import test from "node:test";
import assert from "node:assert/strict";
import { SubscriptionAuth, safeOpenAIAuthUrl } from "./subscription-auth.ts";
import type { GatewayBrowserClient } from "../gateway.ts";

test("account flow uses the kernel's login choices and wizard protocol", async () => {
  const calls: Array<{method:string;params:unknown}> = [];
  const snapshot = { providerCapabilities: [{ provider: "openai", loginOptions: [
    {id:"openai/openai",label:"Codex login",kind:"oauth"},
    {id:"openai/api-key",label:"API key",kind:"secret"},
  ] }] };
  let next = 0;
  const client = { async request(method:string, params:unknown) {
    calls.push({method,params});
    if (method === "models.authStatus") return snapshot;
    if (method === "models.authLogin") return {sessionId:(params as {sessionId:string}).sessionId};
    if (method === "wizard.next") return ++next === 1
      ? {done:false,status:"running",step:{id:"step-1",type:"text",message:"Sign in"}}
      : {done:true,status:"done"};
  } } as unknown as GatewayBrowserClient;
  const host = {client,connected:true,requestUpdate() {}};
  const auth = new SubscriptionAuth(host);
  await auth.refresh();
  assert.equal(auth.options.length,1);
  await auth.start(auth.options[0]);
  assert.equal(auth.step?.id,"step-1");
  await auth.next("");
  assert.equal(auth.sessionId,null);
  const login = calls.find(c=>c.method==="models.authLogin")?.params as {sessionId:string;authChoice:string};
  assert.equal(login.authChoice,"openai/openai");
  assert.ok(login.sessionId);
  assert.deepEqual(calls.filter(c=>c.method==="wizard.next")[1].params,
    {sessionId:login.sessionId,answer:{stepId:"step-1",value:""}});
});

test("gateway progress and informational notes advance automatically, preserving the sign-in link", async () => {
  const calls: any[] = [];
  const option = {id:"openai/openai",label:"Codex",kind:"oauth"};
  const steps = [
    {id:"progress",type:"progress",executor:"gateway",message:"Starting device code flow…"},
    {id:"note",type:"note",executor:"client",externalUrl:"https://auth.openai.com/device"},
    {id:"redirect",type:"text",executor:"client",message:"Paste redirect"},
  ];
  const client = {async request(method:string,params:any) {
    if (method === "models.authLogin") return {sessionId:params.sessionId};
    if (method === "wizard.next") {calls.push(params);return {done:false,status:"running",step:steps.shift()};}
    return {};
  }} as unknown as GatewayBrowserClient;
  const auth = new SubscriptionAuth({client,connected:true,requestUpdate(){}});
  auth.snapshot = {providerCapabilities:[{provider:"openai",loginOptions:[option]}]};
  try {
    await auth.start(option);
    assert.equal(auth.step?.id,"redirect");
    assert.equal(auth.externalUrl,"https://auth.openai.com/device");
    assert.equal(calls[1].answer,undefined,"progress is polled without an answer");
    assert.deepEqual(calls[2].answer,{stepId:"note"},"notes are acknowledged without user input");
  } finally {await auth.cancel();}
});

test("cancel discards late account responses", async () => {
  let resolve!: (value:unknown)=>void;
  const client = {request:()=>new Promise(r=>resolve=r)} as unknown as GatewayBrowserClient;
  const auth = new SubscriptionAuth({client,connected:true,requestUpdate() {}});
  const loading = auth.refresh();
  await auth.cancel();
  resolve({providers:[{provider:"openai",status:"ok"}]});
  await loading;
  assert.equal(auth.snapshot,null);
  assert.equal(auth.busy,false);
});

test("authorization URLs only open approved HTTPS hosts", () => {
  assert.ok(safeOpenAIAuthUrl("https://auth.openai.com/oauth/authorize?state=test"));
  for (const url of ["http://auth.openai.com", "https://auth.openai.com.evil.test", "https://user:pass@auth.openai.com", "file:///tmp/key", "javascript:alert(1)"]) {
    assert.equal(safeOpenAIAuthUrl(url),null);
  }
});

test("first-login ownership migration reconnects once and restores account plus limits",async()=>{
  const option={id:"openai/openai",label:"Codex",kind:"oauth"};
  let saved=false,reconnects=0;
  const client={async request(method:string,params:any){
    if(method==="models.authLogin")return {sessionId:params.sessionId};
    if(method==="wizard.next"){saved=true;return {done:true,status:"done"};}
    if(method==="models.authStatus")return {providers:reconnects?[{provider:"openai",status:"ok",profiles:[{type:"oauth",status:"ok"}]}]:[],providerCapabilities:[{provider:"openai",loginOptions:[option]}]};
    if(method==="models.authRefresh"){assert.deepEqual(params,{operation:"login"});return {refreshed:true};}
    if(method==="usage.status")return {providers:[{provider:"openai",plan:"plus",windows:[{label:"5h",usedPercent:52}]}]};
  }} as unknown as GatewayBrowserClient;
  const auth=new SubscriptionAuth({client,connected:true,requestUpdate(){}},()=>{assert.ok(saved);reconnects++;});
  await auth.refresh();await auth.start(option);
  assert.equal(reconnects,1);assert.ok(auth.loginCompleted);
  await auth.refresh();
  assert.equal(auth.snapshot?.providers?.[0]?.status,"ok");
  assert.equal(auth.usage?.providers?.[0]?.windows[0].usedPercent,52);
});

test("cancelled login start cannot resume or advance a newer session", async () => {
  let finish!: (result: unknown) => void;
  const calls: string[] = [];
  let sessionId = "";
  const client = {request(method: string, params: any) {
    calls.push(method);
    if (method === "models.authLogin") {
      sessionId = params.sessionId;
      return new Promise(resolve => finish = resolve);
    }
    return Promise.resolve({status:"cancelled"});
  }} as unknown as GatewayBrowserClient;
  const auth = new SubscriptionAuth({client,connected:true,requestUpdate() {}});
  const option = {id:"openai/openai",label:"Codex",kind:"oauth"};
  auth.snapshot = {providerCapabilities:[{provider:"openai",loginOptions:[option]}]};
  const start = auth.start(option);
  await auth.cancel();
  finish({sessionId,status:"running"});
  await start;
  assert.equal(auth.sessionId,null);
  assert.equal(calls.includes("wizard.next"),false);
  assert.ok(calls.filter(method=>method==="wizard.cancel").length>=1);
});
