import test from "node:test";
import assert from "node:assert/strict";
import {buildThemeDesignPrompt,cleanThemeFields,themeFieldsError,EMPTY_THEME_FIELDS,prepareThemeDesignSkill} from "./theme-agent.ts";
import type {GatewayBrowserClient} from "./gateway.ts";

const fields=(overrides:Partial<typeof EMPTY_THEME_FIELDS>={})=>({...EMPTY_THEME_FIELDS,style:"蓝白加少量绿色",...overrides});

test("fill-in brief is rendered field by field with paired palettes, bounded fields and the v1 package rules",()=>{
  const prompt=buildThemeDesignPrompt({...fields({primary:"#1a6fd0",secondary:"叶绿",appearance:"浅色为主",corners:"适中圆角",typography:"保留现有字体",keep:"保留布局",avoid:"高饱和撞色",extra:"深色柔和"}),mode:"system",preserveLayout:true,locale:"zh-CN",referenceImages:2},{size:18,weight:437.5,token:"private-secret",gatewayUrl:"https://secret.test",colors:{accent:"#1a6fd0"}});
  for(const text of ["cryoclaw-theme-studio","风格意象：蓝白加少量绿色","主色：#1a6fd0","辅色：叶绿","明暗偏好：浅色为主","圆角倾向：适中圆角","排版偏好：保留现有字体","必须保留：保留布局","希望避免：高饱和撞色","补充要求：深色柔和","palettes.light","palettes.dark","4.5:1","preview helper","60 秒","保留现有字体","参考图","2 张","density 0.9–1.1","shadow none|soft|default|strong","borderWidth 0–2","description","64 KiB",'"size":18','"weight":437.5'])assert.ok(prompt.includes(text),`prompt lacks ${text}`);
  assert.ok(!prompt.includes("private-secret"));assert.ok(!prompt.includes("https://secret.test"));
});
test("empty or invalid fill-in fields are rejected before a request is sent",()=>{
  assert.ok(themeFieldsError({...EMPTY_THEME_FIELDS},"zh-CN"));
  assert.ok(themeFieldsError({...EMPTY_THEME_FIELDS,style:"x"},"en"));
  assert.equal(themeFieldsError({...EMPTY_THEME_FIELDS,style:"清爽蓝白"},"zh-CN"),null);
  assert.ok(themeFieldsError(fields({primary:"#12"}),"zh-CN"));
  assert.ok(themeFieldsError(fields({secondary:"#12345"}),"en"));
  assert.equal(themeFieldsError(fields({primary:"#1a6fd0"}),"zh-CN"),null);
  assert.throws(()=>buildThemeDesignPrompt({...fields({style:"   "}),mode:"light",preserveLayout:true,locale:"en"},{}));
});
test("fill-in fields are bounded and control characters cannot leak into the brief",()=>{
  const clean=cleanThemeFields({style:"  a\u0000b\n c ",primary:"x".repeat(500)});
  assert.equal(clean.style,"a b c");assert.equal(Array.from(clean.primary).length,120);
});
test("reference images are only a palette and texture reference, and are absent when none are attached",()=>{
  const withImages=buildThemeDesignPrompt({...fields(),mode:"light",preserveLayout:true,locale:"zh-CN",referenceImages:1},{});
  assert.ok(withImages.includes("参考图：用户随本条消息附上 1 张参考图"));
  assert.ok(withImages.includes("不要复制其中的文字、logo、品牌标识"));
  const english=buildThemeDesignPrompt({...fields(),mode:"light",preserveLayout:true,locale:"en",referenceImages:3},{});
  assert.ok(english.includes("attached 3 image(s)"));assert.ok(english.includes("Do not copy their text, logos"));
  const without=buildThemeDesignPrompt({...fields(),mode:"light",preserveLayout:true,locale:"en"},{});
  assert.ok(without.includes("none attached"));assert.ok(!without.includes("attached 0"));
});
test("layout refinement is explicit and a chosen dark baseline uses its matching palette",()=>{
  const prompt=buildThemeDesignPrompt({...fields({style:"Soft dark mode"}),mode:"dark",preserveLayout:false,locale:"en"},{mode:"light",colors:{background:"#ffffff"},palettes:{dark:{background:"#151515"}}});
  assert.ok(prompt.includes("registered element geometry"));assert.ok(prompt.includes('"paletteMode":"dark"'));assert.ok(prompt.includes('"colors":{"background":"#151515"}'));
  const preserve=buildThemeDesignPrompt({...fields(),mode:"dark",preserveLayout:true,locale:"zh-CN"},{});
  assert.ok(preserve.includes("保留现有字体、字号、字重、布局与单元素调整"));
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
