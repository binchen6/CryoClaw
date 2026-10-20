import type { GatewayBrowserClient } from "../gateway.ts";
import {ResourceCache} from "../utils/resource-cache.ts";
import { t, tWithDetail } from "../i18n.ts";

// tts.status 返回结构（内核 2026.7.1-2，字段防御性取值）：
// { enabled, auto, provider, persona, personas: [{id,label,description,provider}], fallbackProvider, fallbackProviders, prefsPath, providerStates: [{id,label,configured}] }
export type TtsProviderState = { id?: string; label?: string; configured?: boolean };
export type TtsPersona = { id?: string; label?: string; description?: string; provider?: string };
export type TtsStatus = {
  enabled?: boolean;
  auto?: string;
  provider?: string;
  persona?: string | null;
  personas?: TtsPersona[];
  fallbackProvider?: string | null;
  providerStates?: TtsProviderState[];
};

// talk.config 返回 { config: { talk?: {...} } }，talk 配置节见内核 src/config/talk.ts。
export type TalkSection = {
  provider?: string;
  speechLocale?: string;
  interruptOnSpeech?: boolean;
  realtime?: { mode?: string; transport?: string; provider?: string };
};
type TalkConfigResult = { config?: { talk?: TalkSection } };

// voicewake.get 返回 { triggers: string[] }。

export type VoiceGatewayState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
};

export type VoiceStatusState = {
  error: string | null;
  successMsg: string | null;
  actionPending: boolean;
  // TTS 状态/开关（走 gateway RPC）
  ttsStatus: TtsStatus | null;
  ttsLoading: boolean;
  ttsLoaded: boolean;
  ttsFailed: boolean;
  // Talk 配置（只读展示）
  talkConfig: TalkSection | null;
  talkLoaded: boolean;
  // 语音唤醒词（只读展示）
  wakeTriggers: string[] | null;
  wakeLoaded: boolean;
};

type VoiceSnapshot={ttsStatus:TtsStatus|null;ttsFailed:boolean;talkConfig:TalkSection|null;wakeTriggers:string[]|null};
const caches=new WeakMap<GatewayBrowserClient,ResourceCache<VoiceSnapshot>>();
const failures=new WeakMap<GatewayBrowserClient,{at:number;error:unknown}>();
const owners=new WeakMap<VoiceStatusState,GatewayBrowserClient>();
const requests=new WeakMap<VoiceStatusState,object>();
function cacheFor(client:GatewayBrowserClient){let cache=caches.get(client);if(!cache){cache=new ResourceCache<VoiceSnapshot>(30000,1);caches.set(client,cache);}return cache;}
export function voiceStatusFresh(client:GatewayBrowserClient|null,view?:VoiceStatusState):boolean{return !!client && (!view || owners.get(view)===client) && (!!cacheFor(client).peek("voice") || Date.now()-(failures.get(client)?.at??0)<5000);}
export function invalidateVoiceStatus(client:GatewayBrowserClient){cacheFor(client).clear();failures.delete(client);}
async function snapshot(client:GatewayBrowserClient,force=false):Promise<VoiceSnapshot>{
  if(force)invalidateVoiceStatus(client);
  const failure=failures.get(client);if(!force && failure && Date.now()-failure.at<5000)throw failure.error;
  try{return await cacheFor(client).read("voice",async()=>{
    const [tts,talk,wake]=await Promise.allSettled([client.request("tts.status",{}),client.request("talk.config",{}),client.request("voicewake.get",{})]);
    if(tts.status==="rejected" && talk.status==="rejected" && wake.status==="rejected")throw tts.reason;
    return {ttsStatus:tts.status==="fulfilled"?tts.value as TtsStatus:null,ttsFailed:tts.status==="rejected",talkConfig:talk.status==="fulfilled"?(talk.value as TalkConfigResult)?.config?.talk??null:null,wakeTriggers:wake.status==="fulfilled" && Array.isArray((wake.value as any)?.triggers)?(wake.value as any).triggers:null};
  });}catch(error){failures.set(client,{at:Date.now(),error});throw error;}
}
export function preloadVoiceStatus(gateway:VoiceGatewayState){if(gateway.client && gateway.connected)return snapshot(gateway.client);}
function applySnapshot(state:VoiceStatusState,value:VoiceSnapshot){Object.assign(state,value,{ttsLoaded:true,talkLoaded:true,wakeLoaded:true});}
export async function loadVoiceStatus(state:VoiceStatusState,gateway:VoiceGatewayState,requestUpdate:()=>void,force=false){
  const client=gateway.client;if(!client || !gateway.connected)return;
  if(!force && owners.get(state)===client && (state.ttsLoading || state.ttsLoaded && voiceStatusFresh(client)))return;
  const token={};requests.set(state,token);owners.set(state,client);
  const owns=()=>requests.get(state)===token,current=()=>owns() && gateway.client===client && gateway.connected;
  const cached=!force?cacheFor(client).peek("voice"):undefined;
  if(cached){applySnapshot(state,cached);state.ttsLoading=false;requestUpdate();return;}
  state.ttsLoading=true;requestUpdate();
  try{const value=await snapshot(client,force);if(current())applySnapshot(state,value);}
  catch{if(current())applySnapshot(state,{ttsStatus:null,ttsFailed:true,talkConfig:null,wakeTriggers:null});}
  finally{if(owns()){state.ttsLoading=false;requestUpdate();}}
}
export async function applyTtsAction(state:VoiceStatusState,gateway:VoiceGatewayState,method:string,params:Record<string,unknown>,requestUpdate:()=>void){
  const client=gateway.client;if(state.actionPending || !client || !gateway.connected)return;
  state.actionPending=true;state.error=null;state.successMsg=null;requestUpdate();
  const current=()=>gateway.client===client && gateway.connected;
  try{await client.request(method,params);invalidateVoiceStatus(client);if(!current())return;state.successMsg=t("settings.saved");state.ttsLoaded=false;await loadVoiceStatus(state,gateway,requestUpdate,true);}
  catch(error:any){if(current())state.error=tWithDetail("settings.error.saveFailed",error?.message);}
  finally{state.actionPending=false;requestUpdate();}
}
