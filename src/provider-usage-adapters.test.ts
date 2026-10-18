import {test} from "node:test";
import assert from "node:assert/strict";
import {parseExtendedProviderUsage as parse,resolveUsageAdapter as resolve} from "./provider-usage-adapters";

test("quota adapters select only official HTTPS hosts, including custom provider names",()=>{
  assert.deepEqual(resolve("https://openrouter.ai/api/v1"),{adapter:"openrouter",url:"https://openrouter.ai/api/v1/key"});
  assert.deepEqual(resolve("https://api.siliconflow.cn/v1"),{adapter:"siliconflow",url:"https://api.siliconflow.cn/v1/user/info"});
  assert.equal(resolve("https://api.ap.siliconflow.com/v1")?.adapter,"siliconflow");
  assert.equal(resolve("https://api.minimax.io/anthropic")?.url,"https://www.minimax.io/v1/token_plan/remains");
  assert.equal(resolve("https://api.minimaxi.com/anthropic")?.url,"https://www.minimax.cn/v1/token_plan/remains");
  for(const url of ["http://openrouter.ai","https://openrouter.ai.evil.test","https://evil.test/openrouter.ai",
    "https://user:pass@openrouter.ai","https://openrouter.ai:8443","file:///api.siliconflow.cn","bad-url"]){
    assert.equal(resolve(url),null,url);
  }
});

test("SiliconFlow keeps decimal balance and currency exact without inventing a quota percentage",()=>{
  const usage=parse("siliconflow",{code:20000,status:true,data:{balance:"1.000000001",chargeBalance:"2.00",totalBalance:"3.000000001"}});
  assert.equal(usage.kind,"balance");assert.equal(usage.available,"3.000000001");
  assert.equal(usage.toppedUp,"2.00");assert.equal(usage.scope,"account");
  assert.equal(usage.currency,undefined);assert.equal(usage.pct,undefined);
  assert.equal(parse("siliconflow",{data:{balance:0,currency:"CNY"}}).available,"0");
});

test("SiliconFlow rejects errors and missing or invalid balances",()=>{
  for(const payload of [{status:false,data:{balance:1}},{code:401,data:{balance:1}},{data:{}},{data:{balance:"NaN"}},{data:{balance:null}}]){
    assert.throws(()=>parse("siliconflow",payload));
  }
});

test("OpenRouter separates key caps, effective budgets and free request allowance",()=>{
  const usage=parse("openrouter",{data:{limit:100,limit_remaining:75,limit_reset:"monthly",
    effective_budget:{limit_usd:50,remaining_usd:10,resets_at:"2026-11-01T00:00:00Z"},
    free_model_daily_requests:{limit:50,remaining:38}}});
  assert.equal(usage.scope,"key");assert.equal(usage.pct,80);
  assert.deepEqual(usage.windows?.map(w=>w.usedPercent),[25,80,24]);
  assert.equal(usage.windows?.[1].resetAt,Date.parse("2026-11-01T00:00:00Z"));
  assert.equal(usage.available,undefined);
});

test("OpenRouter unlimited key cap remains unknown and zero cap is exhausted",()=>{
  const unlimited=parse("openrouter",{data:{limit:null,limit_remaining:null,usage:2}});
  assert.equal(unlimited.pct,undefined);assert.deepEqual(unlimited.windows,[]);
  assert.equal(parse("openrouter",{data:{limit:0,limit_remaining:0}}).pct,100);
  assert.throws(()=>parse("openrouter",{error:{code:401}}));
});

test("MiniMax usage_count denotes remaining capacity and model windows stay separate",()=>{
  const usage=parse("minimax",{base_resp:{status_code:0},model_remains:[{model_name:"MiniMax-M2.5",
    current_interval_total_count:100,current_interval_usage_count:75,current_interval_reset_time:1800000000,
    current_weekly_total_count:1000,current_weekly_usage_count:600}]});
  assert.deepEqual(usage.windows?.map(w=>[w.label,w.usedPercent,w.model]),[["5h",25,"MiniMax-M2.5"],["Week",40,"MiniMax-M2.5"]]);
  assert.equal(usage.windows?.[0].resetAt,1800000000000);
});

test("MiniMax accepts explicit remaining percentages and rejects PAYG or unknown response",()=>{
  const usage=parse("minimax",{data:{plan_name:"Plus",model_remains:[{current_interval_remaining_percent:0,current_weekly_remaining_percent:70}]}});
  assert.equal(usage.plan,"Plus");assert.deepEqual(usage.windows?.map(w=>w.usedPercent),[100,30]);
  assert.throws(()=>parse("minimax",{base_resp:{status_code:1004}}));
  assert.throws(()=>parse("minimax",{data:{balance:123}}));
});
