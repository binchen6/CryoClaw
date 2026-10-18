import test from "node:test";
import assert from "node:assert/strict";
import { mergeAccountModels,loadGatewayModels,getCachedGatewayModels } from "./models.ts";
import type {GatewayBrowserClient} from "../gateway.ts";

test("account models follow kernel readiness without requiring API key config", () => {
  const configured = [{key:"openai/api",name:"My alias",provider:"openai",isDefault:false}];
  const result = mergeAccountModels(configured, {models:[
    {provider:"openai",id:"api",name:"Original",available:true},
    {provider:"openai-codex",id:"subscription",name:"Subscription",available:true},
    {provider:"openai-codex",id:"blocked",available:false},
    {provider:"openai-codex",id:"unknown"},
    {provider:"other",id:"unrelated",available:true},
  ]}, "openai-codex/subscription");
  assert.deepEqual(result, [...configured, {key:"openai-codex/subscription",name:"Subscription",provider:"openai-codex",isDefault:true}]);
  assert.deepEqual(mergeAccountModels(configured, null, undefined), configured);
});

test("a late model catalog cannot overwrite a newer gateway connection",async()=>{
  let resolve!:(value:unknown)=>void;
  const oldClient={request:()=>new Promise(r=>{resolve=r;})} as unknown as GatewayBrowserClient;
  const newClient={request:async()=>({models:[{provider:"openai",id:"new-account"}]})} as unknown as GatewayBrowserClient;
  const previous=loadGatewayModels(oldClient,{force:true});
  await loadGatewayModels(newClient,{force:true});
  resolve({models:[{provider:"openai",id:"old-account"}]});
  assert.equal(await previous,null);
  assert.deepEqual(getCachedGatewayModels(),{openai:["new-account"]});
});
