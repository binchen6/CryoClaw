import type {AppViewState} from "./app-view-state.ts";
import type {CryoClawViewId} from "./views/registry.ts";
import {getConfigSnapshot} from "./controllers/config.ts";
import {loadGatewayModels} from "./controllers/models.ts";
import {loadCronJobs} from "./controllers/cron.ts";
import {loadRunHistory} from "./controllers/tasks.ts";
import {loadSkills} from "./controllers/skills.ts";
import {preloadWorkspaceDirectory} from "./controllers/workspace.ts";
import {preloadViewModule} from "./lazy-view.ts";

type Scope={client:AppViewState["client"];loaded:Map<string,number>;pending:Set<string>;queue:Promise<void>;timers:Array<ReturnType<typeof setTimeout>>};
const scopes=new WeakMap<AppViewState,Scope>();
function initialReadsPending(host:AppViewState){return host.chatLoading || host.sessionsLoading || host.progressCard?.loading;}
function scopeFor(host:AppViewState):Scope {
  let scope=scopes.get(host);
  if(!scope || scope.client!==host.client){
    scope?.timers.forEach(clearTimeout);
    scope={client:host.client,loaded:new Map(),pending:new Set(),queue:Promise.resolve(),timers:[]};scopes.set(host,scope);
  }
  return scope;
}
/** Intent + idle prefetch, one job at a time and no background polling. */
function enqueuePreload(host:AppViewState,view:string,job:()=>Promise<unknown>):Promise<void>|undefined {
  if(!host.connected || !host.client || document.hidden || host.chatRunId || initialReadsPending(host))return;
  const scope=scopeFor(host);
  if(scope.pending.has(view))return scope.queue;
  if(Date.now()-(scope.loaded.get(view)??0)<60_000)return;
  scope.pending.add(view);
  scope.queue=scope.queue.then(async()=>{
    if(scopes.get(host)!==scope || !host.connected || host.client!==scope.client || document.hidden || host.chatRunId || initialReadsPending(host))return;
    const client=host.client!;
    await job();
    if(host.client===client)scope.loaded.set(view,Date.now());
  }).catch(()=>{}).finally(()=>{scope.pending.delete(view);});
  return scope.queue;
}
export function preloadPage(host:AppViewState,view:CryoClawViewId){
  preloadViewModule(view);
  return enqueuePreload(host,view,async()=>{
  const client=host.client!;
  if(view==="settings")await Promise.all([getConfigSnapshot(client),loadGatewayModels(client)]);
  else if(view==="tasks")await Promise.all([loadCronJobs(host),loadRunHistory(host)]);
  else if(view==="extensions")await loadSkills(host);
  else if(view==="workspace")await preloadWorkspaceDirectory(host);
});}
export function preloadSettingsTab(host:AppViewState,tab:string){
  if(tab==="memory")return enqueuePreload(host,"settings:memory",async()=>{const module=await import("./controllers/memory.ts");await module.preloadMemoryStatus(host);});
  if(tab==="voice")return enqueuePreload(host,"settings:voice",async()=>{const module=await import("./controllers/voice.ts");await module.preloadVoiceStatus(host);});
  if(tab==="usage")return enqueuePreload(host,"settings:usage",async()=>{const module=await import("./controllers/usage-cache.ts");await module.loadUsageSnapshot(host,"30d");});
}
/** Connection establishes a fresh cache; navigation hover/focus supplies intent. */
export function schedulePagePreloads(host:AppViewState):void {
  stopPagePreloads(host);
  scopeFor(host);
}
export function stopPagePreloads(host:AppViewState):void {
  const scope=scopes.get(host);scope?.timers.forEach(clearTimeout);scopes.delete(host);
}
