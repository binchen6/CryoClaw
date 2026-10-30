import test from "node:test";
import assert from "node:assert/strict";
import {html} from "lit";
import type {AppViewState} from "../../app-view-state.ts";
type View={strings:readonly string[];values:unknown[]};
function loadState(view:unknown){const result=view as View,index=result.strings.findIndex(text=>text.endsWith("data-load-state="));assert.ok(index>=0,"Root exposes its actual data loading state");return result.values[index];}
function deferred(){let resolve!:(value:any)=>void,reject!:(error:Error)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function tick(){for(let i=0;i<20;i++)await Promise.resolve();}
const original={window:globalThis.window,document:globalThis.document,CSSStyleSheet:globalThis.CSSStyleSheet};
Object.assign(globalThis,{CSSStyleSheet:class{replaceSync(){}},document:{adoptedStyleSheets:[]},window:{cryoclaw:{}}});
void html;
const modules=Promise.all([import("./tab-backup.ts"),import("./tab-plugins.ts"),import("./tab-memory.ts"),import("./tab-about.ts"),import("./tab-search.ts")]);
test.after(()=>Object.assign(globalThis,original));

test("backup data marker stays loading until initial IPC finishes and distinguishes empty and failure",async()=>{
 const [{renderTabBackup,cleanupBackupTab}]=await modules;
 const state={requestUpdate(){}} as unknown as AppViewState;
 for(const fail of [false,true]){
  const pending=deferred();Object.assign(window,{cryoclaw:{settingsListConfigBackups:()=>pending.promise,getGatewayState:async()=>({state:"running"}),onArchiveProgress:()=>()=>{}}});
  cleanupBackupTab();assert.equal(loadState(renderTabBackup(state,null)),"loading");
  if(fail)pending.reject(Error("unavailable"));else pending.resolve({backups:[],hasLastKnownGood:false});
  await tick();assert.equal(loadState(renderTabBackup(state,null)),fail?"error":"empty");cleanupBackupTab();
 }
});

test("plugin inventory marker does not report an empty success while its IPC read is pending or failed",async()=>{
 const [,{renderPluginsView,resetPluginsView}]=await modules;
 const pending=deferred();Object.assign(window,{cryoclaw:{pluginStoreList:()=>pending.promise}});
 const state={requestUpdate(){}} as unknown as AppViewState;
 resetPluginsView();assert.equal(loadState(renderPluginsView(state)),"loading");
 pending.reject(Error("offline"));await tick();assert.equal(loadState(renderPluginsView(state)),"error");resetPluginsView();
});

test("memory overview marker waits for workspace and dream IPC lists, not just gateway status",async()=>{
 const [,,{renderTabMemory,resetMemoryTab}]=await modules;
 const workspace=deferred(),dreams=deferred();Object.assign(window,{cryoclaw:{memoryListWorkspace:()=>workspace.promise,memoryListDreams:()=>dreams.promise}});
 const state={connected:true,client:{request:async(method:string)=>method==="config.get"?{hash:"fixture",config:{}}:{}},configuredModels:[],requestUpdate(){}} as unknown as AppViewState;
 resetMemoryTab();assert.equal(loadState(renderTabMemory(state)),"loading");
 workspace.resolve({success:true,data:{entries:[],longTermCount:0,dailyCount:0,hasLongTermFile:false}});await tick();assert.equal(loadState(renderTabMemory(state)),"loading");
 dreams.resolve({success:true,data:{found:false,entries:[]}});await tick();assert.equal(loadState(renderTabMemory(state)),"empty");resetMemoryTab();
});

test("about waits for all local version/update snapshots without checking remote updates",async()=>{
 const [,,,{renderTabAbout,cleanupAboutTab}]=await modules;
 const pending=deferred();let checks=0;
 Object.assign(window,{cryoclaw:{settingsGetAboutInfo:async()=>({}),kernelGetUpdateState:()=>pending.promise,appUpdateGetState:async()=>({status:'idle'}),onKernelUpdateProgress:()=>()=>{},onAppUpdateState:()=>()=>{},kernelCheckUpdate:()=>{checks++;}}});
 const state={requestUpdate(){}} as unknown as AppViewState;
 cleanupAboutTab();assert.equal(loadState(renderTabAbout(state)),"loading");await tick();assert.equal(loadState(renderTabAbout(state)),"loading");
 pending.resolve({});await tick();assert.equal(loadState(renderTabAbout(state)),"ready");assert.equal(checks,0);cleanupAboutTab();
});

test("search waits for sidecar reads and reports a failed read instead of empty success",async()=>{
 const [,,,,{renderTabSearch,resetSearchTab}]=await modules;
 const pending=deferred();Object.assign(window,{cryoclaw:{settingsGetKimiSearchKey:()=>pending.promise,settingsGetChannelRuntimeState:async()=>({bundled:{kimiSearch:true},bundleMessages:{}})}});
 const state={connected:true,client:{request:async()=>({hash:'search-fixture',config:{}})},requestUpdate(){}} as unknown as AppViewState;
 resetSearchTab();assert.equal(loadState(renderTabSearch(state)),"loading");pending.reject(Error('unavailable'));await tick();assert.equal(loadState(renderTabSearch(state)),"error");resetSearchTab();
});

test("channel marker waits for both runtime and pairing reads after its configuration is available",async()=>{
 const {renderChannelFeishu,resetFeishuTab}=await import("./tab-channels-feishu.ts");
 const runtime=deferred(),pairing=deferred();
 Object.assign(window,{cryoclaw:{settingsGetChannelRuntimeState:()=>runtime.promise,settingsListFeishuPairing:()=>pairing.promise,settingsListFeishuApproved:async()=>[]}});
 const state={connected:true,client:{request:async()=>({hash:"channel-fixture",config:{}})},requestUpdate(){}} as unknown as AppViewState;
 resetFeishuTab();assert.equal(loadState(renderChannelFeishu(state)),"loading");
 runtime.resolve({bundled:{feishu:true},bundleMessages:{}});await tick();assert.equal(loadState(renderChannelFeishu(state)),"loading");
 pairing.reject(Error("unavailable"));await tick();assert.equal(loadState(renderChannelFeishu(state)),"error");resetFeishuTab();
});

test("installed skills marker includes its local IPC inventory even after the gateway report is ready",async()=>{
 const {renderSkillsView}=await import("../../app-skills.ts");
 const inventory=deferred();Object.assign(window,{cryoclaw:{skillStoreListInstalled:()=>inventory.promise}});
 const state={skillsReport:{skills:[]},skillsLoading:false,skillsError:null,skillMessages:{},requestUpdate(){}} as unknown as AppViewState;
 assert.equal(loadState(renderSkillsView(state)),"loading");
 inventory.resolve({success:false,message:"inventory unavailable"});await tick();assert.equal(loadState(renderSkillsView(state)),"error");
});
