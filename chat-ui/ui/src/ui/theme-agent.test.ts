import test from "node:test";
import assert from "node:assert/strict";
import {buildThemeDesignPrompt,prepareThemeDesignSkill} from "./theme-agent.ts";
import type {GatewayBrowserClient} from "./gateway.ts";
test("theme design requests carry user intent, paired palettes and a normalized appearance-only reference",()=>{
  const prompt=buildThemeDesignPrompt({request:"蓝白加少量绿色",mode:"system",preserveLayout:true,locale:"zh-CN"},{size:18,weight:437.5,token:"private-secret",gatewayUrl:"https://secret.test",colors:{accent:"#1a6fd0"}});
  for(const text of ["cryoclaw-theme-studio","蓝白加少量绿色","palettes.light","palettes.dark","4.5:1","preview helper","60 秒","保留现有字体",'"size":18','"weight":437.5'])assert.ok(prompt.includes(text));
  assert.ok(!prompt.includes("private-secret"));assert.ok(!prompt.includes("https://secret.test"));
  assert.throws(()=>buildThemeDesignPrompt({request:"  ",mode:"light",preserveLayout:true,locale:"en"},{}));
});
test("layout refinement is explicit and a chosen dark baseline uses its matching palette",()=>{
  const prompt=buildThemeDesignPrompt({request:"Soft dark mode",mode:"dark",preserveLayout:false,locale:"en"},{mode:"light",colors:{background:"#ffffff"},palettes:{dark:{background:"#151515"}}});
  assert.ok(prompt.includes("registered element geometry"));assert.ok(prompt.includes('"paletteMode":"dark"'));assert.ok(prompt.includes('"colors":{"background":"#151515"}'));
});
test("a ready native theme skill needs no repair or configuration mutation",async()=>{
  let calls=0;
  const result=await prepareThemeDesignSkill({request:async(method:string)=>{calls++;assert.equal(method,"skills.status");return {skills:[{skillKey:"cryoclaw-theme-studio",eligible:true}]};}} as unknown as GatewayBrowserClient);
  assert.equal(calls,1);assert.equal(result.recovered,false);
});
test("theme skill preparation recovers a transient lookup without modifying config",async()=>{
  const methods:string[]=[];let calls=0;
  const result=await prepareThemeDesignSkill({request:async(method:string)=>{methods.push(method);if(++calls===1)throw Error("temporary failure");return {skills:[{skillKey:"cryoclaw-theme-studio"}]};}} as unknown as GatewayBrowserClient,{wait:async()=>{}});
  assert.equal(result.recovered,true);assert.deepEqual(methods,["skills.status","skills.status"]);
});
test("theme skill preparation can enable only its own disabled bundled skill",async()=>{
  const updates:unknown[]=[];let enabled=false;
  const result=await prepareThemeDesignSkill({request:async(method:string,params:unknown)=>{if(method==="skills.update"){updates.push(params);enabled=true;return {};}return {skills:[{name:"cryoclaw-theme-studio",disabled:!enabled,eligible:enabled}]};}} as unknown as GatewayBrowserClient,{wait:async()=>{}});
  assert.equal(result.recovered,true);assert.deepEqual(updates,[{skillKey:"cryoclaw-theme-studio",enabled:true}]);
});
test("theme skill recovery is bounded and cancellation prevents later mutations",async()=>{
  let reads=0,writes=0;
  await assert.rejects(prepareThemeDesignSkill({request:async(method:string)=>{if(method==="skills.update"){writes++;throw Error("denied");}reads++;return {skills:[{skillKey:"cryoclaw-theme-studio",disabled:true}]};}} as unknown as GatewayBrowserClient,{wait:async()=>{}}),/could not be enabled/);
  assert.equal(reads,3);assert.equal(writes,1);
  let canceled=false,calls=0;
  await assert.rejects(prepareThemeDesignSkill({request:async()=>{calls++;canceled=true;return {skills:[{skillKey:"cryoclaw-theme-studio",disabled:true}]};}} as unknown as GatewayBrowserClient,{canContinue:()=>!canceled,wait:async()=>{}}),/canceled/);
  assert.equal(calls,1);
});
