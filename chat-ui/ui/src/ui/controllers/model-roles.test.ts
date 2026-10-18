import test from "node:test";
import assert from "node:assert/strict";
import {configureModelRoles} from "./model-roles.ts";
test("native auxiliary and decision roles preserve primary, fallbacks and model metadata",()=>{
  const config={agents:{defaults:{model:{primary:"a/main",fallbacks:["b/one","c/two"]},models:{"a/main":{alias:"Main"}}}}};
  configureModelRoles(config,{utilityModel:"a/small",decisionModel:"b/router"});
  assert.deepEqual(config.agents.defaults.model,{primary:"a/main",fallbacks:["b/one","c/two"]});
  assert.deepEqual(config.agents.defaults.models,{"a/main":{alias:"Main"}});
  assert.equal((config.agents.defaults as any).utilityModel,"a/small");
});
test("inherit and explicit disable have different native semantics",()=>{
  const config={agents:{defaults:{utilityModel:"a/small",decisionModel:"a/router"}}};
  configureModelRoles(config,{utilityModel:undefined,decisionModel:""});
  assert.equal("utilityModel" in config.agents.defaults,false);assert.equal(config.agents.defaults.decisionModel,"");
});
test("invalid role references fail before mutating configuration",()=>{
  const config={agents:{defaults:{utilityModel:"a/keep"}}};
  assert.throws(()=>configureModelRoles(config,{utilityModel:"b/new",decisionModel:"bare-model"}));
  assert.equal(config.agents.defaults.utilityModel,"a/keep");
});
