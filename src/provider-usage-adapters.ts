export interface ProviderQuotaWindow {label:string;usedPercent:number;resetAt?:number;model?:string;remaining?:number;total?:number;unit?:"USD"|"requests"}
export interface ExtendedProviderUsage {
  supported:true;kind:"balance" | "progress";available?:string;total?:string;granted?:string;toppedUp?:string;
  currency?:string;pct?:number;plan?:string;scope?:"account"|"key";windows?:ProviderQuotaWindow[];notice?:"key-limit-unset";
}
export type UsageAdapter="siliconflow"|"openrouter"|"minimax";
export function resolveUsageAdapter(baseUrl:string):{adapter:UsageAdapter;url:string}|null {
  let url:URL;try{url=new URL(baseUrl);}catch{return null;}
  if(url.protocol!=="https:" || url.username || url.password || (url.port && url.port!=="443"))return null;
  const host=url.hostname.toLowerCase();
  if(host==="openrouter.ai")return {adapter:"openrouter",url:"https://openrouter.ai/api/v1/key"};
  if(["api.siliconflow.cn","api.siliconflow.com","api.ap.siliconflow.com"].includes(host))return {adapter:"siliconflow",url:`${url.origin}/v1/user/info`};
  if(["api.minimax.io","api.minimaxi.com","api.minimax.cn"].includes(host))return {adapter:"minimax",url:`https://www.minimax.${host==="api.minimax.io"?"io":"cn"}/v1/token_plan/remains`};
  return null;
}
function numeric(value:unknown):number|undefined {
  if(typeof value!=="number" && !(typeof value==="string" && value.trim()))return;
  const n=Number(value);return Number.isFinite(n)?n:undefined;
}
function stamp(value:unknown):number|undefined {
  const n=numeric(value);if(n!==undefined && n>0)return n<1e12?n*1000:n;
  if(typeof value==="string"){const t=Date.parse(value);if(Number.isFinite(t))return t;}
}
function pct(remaining:number,total:number):number{return Math.max(0,Math.min(100,(1-remaining/total)*100));}
export function parseExtendedProviderUsage(adapter:UsageAdapter,payload:any):ExtendedProviderUsage {
  const data=payload?.data;
  if(adapter==="siliconflow") {
    if(payload?.status===false || (payload?.code!==undefined && ![0,20000].includes(payload.code)))throw new Error("硅基流动余额查询失败");
    const available=numeric(data?.totalBalance)!==undefined?data.totalBalance:data?.balance;
    if(numeric(available)===undefined)throw new Error("硅基流动未返回余额数据");
    return {supported:true,kind:"balance",scope:"account",available:String(available),total:String(available),
      toppedUp:numeric(data?.chargeBalance)===undefined?undefined:String(data.chargeBalance),currency:typeof data?.currency==="string"?data.currency:undefined};
  }
  if(adapter==="openrouter") {
    if(!data || typeof data!=="object")throw new Error("OpenRouter 未返回密钥额度");
    const windows:ProviderQuotaWindow[]=[];
    const add=(label:string,total:unknown,remaining:unknown,reset?:unknown,unit:"USD"|"requests"="USD")=>{
      const t=numeric(total),r=numeric(remaining);
      if(t!==undefined && t>=0 && r!==undefined)windows.push({label,usedPercent:t===0?100:pct(r,t),resetAt:stamp(reset),remaining:r,total:t,unit});
    };
    add("API key (USD)",data.limit,data.limit_remaining);
    add("Effective budget (USD)",data.effective_budget?.limit_usd,data.effective_budget?.remaining_usd,data.effective_budget?.resets_at);
    add("Free model requests",data.free_model_daily_requests?.limit,data.free_model_daily_requests?.remaining,undefined,"requests");
    const freeRequests=windows.find(window=>window.label==="Free model requests");
    if(freeRequests)freeRequests.model=":free";
    // A key with no cap is not an unlimited account balance. Its account credits
    // endpoint requires a separate management key, which we never request here.
    return {supported:true,kind:"progress",scope:"key",windows,notice:windows.length?undefined:"key-limit-unset",pct:windows.length?Math.max(...windows.map(w=>w.usedPercent)):undefined,plan:typeof data.limit_reset==="string"?data.limit_reset:undefined};
  }
  if(payload?.base_resp?.status_code || (payload?.code!==undefined && payload.code!==0))throw new Error("MiniMax 额度查询失败，请确认使用订阅密钥");
  const windows:ProviderQuotaWindow[]=[];
  const add=(row:any,label:string,prefix:string,model?:string)=>{
    const remainingPct=numeric(row?.[`${prefix}_remaining_percent`]);
    const total=numeric(row?.[`${prefix}_total_count`]);
    // MiniMax uses usage_count for remaining capacity; keep native OpenClaw semantics.
    const remaining=numeric(row?.[`${prefix}_usage_count`]);
    const used=remainingPct!==undefined?100-remainingPct:total!==undefined && total>0 && remaining!==undefined?pct(remaining,total):undefined;
    if(used!==undefined)windows.push({label,model,usedPercent:Math.max(0,Math.min(100,used)),resetAt:stamp(row?.[`${prefix}_reset_time`]??row?.end_time)});
  };
  const rows=Array.isArray(data?.model_remains)?data.model_remains:Array.isArray(payload?.model_remains)?payload.model_remains:[data??payload];
  for(const row of rows.slice(0,64)) {
    const model=typeof row?.model_name==="string"?row.model_name:undefined;
    add(row,"5h","current_interval",model);add(row,"Week","current_weekly",model);
  }
  if(!windows.length)throw new Error("MiniMax 未返回可识别额度，请确认订阅密钥和套餐状态");
  return {supported:true,kind:"progress",scope:"account",windows,pct:Math.max(...windows.map(w=>w.usedPercent)),plan:typeof data?.plan_name==="string"?data.plan_name:undefined};
}
