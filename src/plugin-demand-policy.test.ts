import {test} from "node:test";
import assert from "node:assert/strict";
import {reconcilePluginDemand,optionalPluginEnableBlock,disableOptionalPluginChannel} from "./plugin-demand-policy";

test("unused Codex and inactive channel plugins are disabled without deleting credentials or configuration",()=>{
  const config:any={plugins:{entries:{codex:{enabled:true,config:{keep:1}},'wecom-openclaw-plugin':{enabled:true,config:{keep:2}},'openclaw-weixin':{enabled:true}}},models:{providers:{openai:{models:[{id:'gpt-test'}]}}},agents:{defaults:{models:{'openai/gpt-test':{}}}},channels:{wecom:{enabled:false,secret:'keep'},'openclaw-weixin':{enabled:false}}};
  assert.deepEqual(reconcilePluginDemand(config),['codex','wecom-openclaw-plugin','openclaw-weixin']);
  assert.equal(config.plugins.entries.codex.enabled,false);assert.equal(config.plugins.entries.codex.config.keep,1);assert.equal(config.channels.wecom.secret,'keep');
  assert.deepEqual(reconcilePluginDemand(config),[]);
});
test("configured native Codex references retain the runtime, including agent fallbacks",()=>{
  for(const agents of [{defaults:{models:{'codex/gpt-test':{}}}},{defaults:{model:{primary:'other/model',fallbacks:['codex/gpt-test']}}},{list:[{id:'work',model:'codex/gpt-test'}]},{defaults:{heartbeat:{model:'codex/gpt-test'}}},{defaults:{models:{'openai/gpt-test':{agentRuntime:{id:'codex'}}}}}]){
    const config:any={agents,plugins:{entries:{codex:{enabled:true}}}};
    reconcilePluginDemand(config);assert.equal(config.plugins.entries.codex.enabled,true);
  }
});
test("provider runtime policies and execution reviewers count as Codex demand",()=>{
  for(const extra of [{models:{providers:{openai:{models:[{id:'gpt-test',agentRuntime:{id:'codex'}}]}}}},{tools:{exec:{reviewer:{model:'codex/gpt-test'}}}}]){
    const config:any={...extra,plugins:{entries:{codex:{enabled:true}}}};
    reconcilePluginDemand(config);assert.equal(config.plugins.entries.codex.enabled,true);
  }
});
test("every channel plugin follows declared channel switches, including multi-channel plugins",()=>{
  const channels=new Map([['telegram',['telegram']],['multi-bot',['slack','discord']]]);
  const config:any={plugins:{entries:{telegram:{enabled:true},'multi-bot':{enabled:true}}},channels:{telegram:{enabled:false},slack:{enabled:false},discord:{enabled:true}}};
  assert.deepEqual(reconcilePluginDemand(config,new Set(),channels),['telegram']);
  assert.equal(config.plugins.entries['multi-bot'].enabled,true);
  assert.ok(optionalPluginEnableBlock(config,'telegram',channels));
  disableOptionalPluginChannel(config,'multi-bot',channels);assert.equal(config.channels.discord.enabled,false);
});
test("channel switches are authoritative and explicit plugin opt-outs stay disabled",()=>{
  const config:any={plugins:{entries:{codex:{enabled:false},'wecom-openclaw-plugin':{enabled:false},'openclaw-weixin':{enabled:true}}},agents:{defaults:{models:{'codex/gpt-test':{}}}},channels:{wecom:{enabled:true},'openclaw-weixin':{enabled:true}}};
  reconcilePluginDemand(config);assert.equal(config.plugins.entries.codex.enabled,false);assert.equal(config.plugins.entries['wecom-openclaw-plugin'].enabled,true);assert.equal(config.plugins.entries['openclaw-weixin'].enabled,true);
});
test("only installed implicit plugins gain a disabled entry; unrelated plugins are unchanged",()=>{
  const config:any={plugins:{entries:{tavily:{enabled:true}}}};
  assert.deepEqual(reconcilePluginDemand(config,new Set(['codex','wecom-openclaw-plugin'])),['codex','wecom-openclaw-plugin']);
  assert.equal(config.plugins.entries['openclaw-weixin'],undefined);assert.equal(config.plugins.entries.tavily.enabled,true);
});
test("generic plugin switches cannot silently activate an inactive bot channel",()=>{
  const config:any={channels:{wecom:{enabled:false,secret:'keep'}}};
  assert.match(optionalPluginEnableBlock(config,'wecom-openclaw-plugin')!,/企业微信/);
  config.channels.wecom.enabled=true;assert.equal(optionalPluginEnableBlock(config,'wecom-openclaw-plugin'),null);
  disableOptionalPluginChannel(config,'wecom-openclaw-plugin');assert.equal(config.channels.wecom.enabled,false);assert.equal(config.channels.wecom.secret,'keep');
  assert.equal(optionalPluginEnableBlock(config,'tavily'),null);
});
