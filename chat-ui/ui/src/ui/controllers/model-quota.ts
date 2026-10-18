import type {GatewayBrowserClient} from "../gateway.ts";
import {settingsGetProviderUsage, kimiGetUsage, type ProviderUsageInfo} from "../data/ipc-bridge.ts";

export interface QuotaWindow {label:string; usedPercent:number | null; resetAt?:number; model?:string;remaining?:number;total?:number;unit?:"USD"|"requests"}
export interface ModelQuota {provider:string; at:number; windows:QuotaWindow[]; plan?:string;
  balance?:Extract<ProviderUsageInfo,{kind:"balance"}>; error?:string; stale?:boolean; unsupported?:boolean; scope?:"account"|"key";notice?:"key-limit-unset"}
const TTL=60_000;
const caches=new WeakMap<GatewayBrowserClient,Map<string,{at:number; value?:ModelQuota; pending?:Promise<ModelQuota>}>>();
const nativeCaches=new WeakMap<GatewayBrowserClient,{at:number; pending?:Promise<any>; value?:any}>();
export function invalidateModelQuota(client:GatewayBrowserClient):void {
  caches.delete(client);nativeCaches.delete(client);
}
/** The native endpoint can return a refresh marker or an old snapshot while refreshing. */
async function loadNativeUsage(client:GatewayBrowserClient,force:boolean):Promise<any> {
  const hit=nativeCaches.get(client);
  if(hit?.pending)return hit.pending;
  if(!force && hit && Date.now()-hit.at<TTL)return hit.value;
  const entry:{at:number;pending?:Promise<any>;value?:any}={at:Date.now()};
  const pending=(async()=>{
    let data=await client.request<any>("usage.status",{}, {timeoutMs:20_000});
    for(const delay of [800,1200,2000,3000]) {
      if(!data?.refreshing && !(typeof data?.updatedAt==="number" && Date.now()-data.updatedAt>=TTL))break;
      await new Promise(resolve=>setTimeout(resolve,delay));
      data=await client.request<any>("usage.status",{}, {timeoutMs:20_000});
    }
    return data;
  })();
  entry.pending=pending;nativeCaches.set(client,entry);
  try {entry.value=await pending;entry.at=Date.now();return entry.value;}
  catch {if(nativeCaches.get(client)===entry)nativeCaches.delete(client);return null;}
  finally {entry.pending=undefined;}
}
export function quotaProvider(model:string | null | undefined, explicit?:string):string {
  return explicit || (model?.includes("/") ? model.slice(0,model.indexOf("/")) : "");
}
export function quotaRemaining(windows:QuotaWindow[]):number | null {
  const used=windows.map(w=>w.usedPercent).filter((n):n is number=>typeof n==="number" && Number.isFinite(n));
  return used.length ? Math.max(0,Math.min(100,100-Math.max(...used))) : null;
}
export function quotaWindowsForModel(windows:QuotaWindow[],model:string):QuotaWindow[] {
  const id=model.toLowerCase();
  return windows.filter(w=>!w.model || (w.model===":free"?id.endsWith(":free"):w.model.toLowerCase()===id));
}
export function quotaWindowLabel(label:string,zh:boolean):string {
  if(!zh)return label;
  return ({Week:"每周额度","5h":"5 小时额度","Rate limit":"短周期额度",Usage:"用量",
    "API key (USD)":"密钥金额上限","Effective budget (USD)":"当前有效预算","Free model requests":"免费模型请求"} as Record<string,string>)[label]??label;
}
function normalizeWindows(windows:any):QuotaWindow[] {
  if(!Array.isArray(windows))return [];
  return windows.filter(w=>w && typeof w==="object").slice(0,128).map(w=>({label:typeof w.label==="string"?w.label:"Usage",
    usedPercent:typeof w.usedPercent==="number" && Number.isFinite(w.usedPercent)?w.usedPercent:null,
    resetAt:typeof w.resetAt==="number" && Number.isFinite(w.resetAt)?w.resetAt:undefined,
    model:typeof w.model==="string"?w.model:undefined,
    remaining:typeof w.remaining==="number" && Number.isFinite(w.remaining)?w.remaining:undefined,
    total:typeof w.total==="number" && Number.isFinite(w.total)?w.total:undefined,
    unit:w.unit==="USD" || w.unit==="requests"?w.unit:undefined}));
}
/** Shared per connection/provider cache: typing and model switches never fan out requests. */
export async function loadModelQuota(client:GatewayBrowserClient,provider:string,force=false):Promise<ModelQuota> {
  let cache=caches.get(client);if(!cache){cache=new Map();caches.set(client,cache);}
  const hit=cache.get(provider);
  if(hit?.pending)return hit.pending;
  if(!force && hit?.value && Date.now()-hit.at<(hit.value.error?15_000:TTL))return hit.value;
  const pending=(async()=>{
    const data=await loadNativeUsage(client,force);
    const aliases:Record<string,string>={"openai-codex":"openai","claude-cli":"anthropic","minimax-cn":"minimax","minimax-portal":"minimax","minimax-portal-cn":"minimax","zai-cn":"zai","zai-cn-coding":"zai","zai-global":"zai"};
    const canonical=aliases[provider]??provider;
    const source=Array.isArray(data?.providers)?data.providers.find((p:any)=>p?.provider===provider || p?.provider===canonical):undefined;
    const result:ModelQuota={provider,at:typeof data?.updatedAt==="number"?data.updatedAt:Date.now(),windows:normalizeWindows(source?.windows),plan:source?.plan,error:source?.error,
      stale:typeof data?.updatedAt==="number" && Date.now()-data.updatedAt>=TTL};
    if(result.windows.length)return result;
    if(!data)result.error="Gateway usage query failed";
    try {
      if(provider==="kimi-coding" || provider==="kimi-code") {
        const usage=await kimiGetUsage();const value=usage.data??usage;
        for(const [label,w] of [["Week",value.weekUsage],["Rate limit",value.rateLimits]] as const) {
          if(w && Number.isFinite(w.used) && Number.isFinite(w.limit) && w.limit>0)result.windows.push({label,usedPercent:w.used/w.limit*100});
        }
        if(usage.authExpired)result.error="Account sign-in expired";
        else if(!usage.success && usage.message)result.error=usage.message;
      } else {
        const fallback=await settingsGetProviderUsage(provider);
        const info=fallback.data;
        if(fallback.success && info?.supported) {
          result.at=Date.now();result.error=undefined;
          if(info.kind==="balance")result.balance=info;
          else {result.plan=info.plan;result.notice=info.notice;result.windows=info.windows?.length?normalizeWindows(info.windows):info.notice?[]:[{label:"Usage",usedPercent:typeof info.pct==="number" && Number.isFinite(info.pct)?info.pct:null,
            resetAt:info.resetSeconds && info.resetSeconds>0?Date.now()+info.resetSeconds*1000:undefined}];}
          result.scope=info.scope;
        } else if(!fallback.unsupported && fallback.message)result.error=fallback.message;
      }
    } catch(error) {if(!result.error)result.error=error instanceof Error?error.message:String(error);}
    // Keep the timestamp and disclose staleness. Never turn a failed request into zero usage.
    if(result.error && hit?.value && (hit.value.balance || hit.value.windows.some(w=>w.usedPercent!==null))) {
      return {...hit.value,error:result.error,stale:true};
    }
    result.unsupported=!result.windows.length && !result.balance && !result.error && !result.notice;
    return result;
  })();
  cache.set(provider,{at:Date.now(),pending});
  try {const value=await pending;cache.set(provider,{at:Date.now(),value});return value;}
  catch(error){cache.delete(provider);throw error;}
}
