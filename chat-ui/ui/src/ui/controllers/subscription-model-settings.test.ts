import test from "node:test";
import assert from "node:assert/strict";
import {configureSubscriptionModel,parseSubscriptionParams} from "./subscription-model-settings.ts";
import {mergeAccountModels} from "./models.ts";

test("account configuration preserves native transport, other models and access policy",()=>{
  const draft:any={models:{providers:{other:{apiKey:"keep"}}},agents:{defaults:{model:{primary:"other/a",fallbacks:["other/b"]},modelPolicy:{allow:["other/*"]},models:{"other/a":{alias:"Existing"},"openai/test":{codeMode:true}}}}};
  configureSubscriptionModel(draft,{provider:"openai",id:"test"},{alias:" My model ",streaming:false,params:{temperature:0.5},primary:true});
  assert.deepEqual(draft.models,{providers:{other:{apiKey:"keep"}}});
  assert.deepEqual(draft.agents.defaults.model,{primary:"openai/test",fallbacks:["other/b"]});
  assert.deepEqual(draft.agents.defaults.modelPolicy.allow,["other/*","openai/test"]);
  assert.deepEqual(draft.agents.defaults.models["openai/test"],{codeMode:true,alias:"My model",streaming:false,params:{temperature:0.5}});
  assert.equal(draft.agents.defaults.models["other/a"].alias,"Existing");
});
test("selecting account models does not narrow an unrestricted policy",()=>{
  const draft:any={agents:{defaults:{modelPolicy:{allow:[]}}}};
  configureSubscriptionModel(draft,{provider:"openai",id:"test"},{alias:"",streaming:true,params:{},primary:false});
  assert.deepEqual(draft.agents.defaults.modelPolicy.allow,[]);
  assert.equal(draft.agents.defaults.model,undefined);
  for(const value of ['[]','null','"text"','{bad'])assert.throws(()=>parseSubscriptionParams(value));
});
test("account alias is reflected in chat and task model selectors",()=>{
  assert.equal(mergeAccountModels([],{models:[{provider:"openai",id:"test",available:true}]},"openai/test",{"openai/test":{alias:"Work"}})[0].name,"Work");
});
