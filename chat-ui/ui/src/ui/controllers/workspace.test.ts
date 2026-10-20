// controllers/workspace.ts 纯状态单测（R42 第二期 Task 3）：
// 右主区模式切换直接改 workspaceViewState.mode，无 bridge 依赖，可在 node 下断言。
import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import { selectWorkspaceMode, workspaceViewState, loadWorkspaceFile, discardWorkspaceDraft, openWorkspaceDirectory, closeWorkspaceFile, setWorkspaceRoot, updateWorkspaceDraft, leaveWorkspace } from "./workspace.ts";
import type { AppViewState } from "../app-view-state.ts";
import {setWorkspaceSearch,navigateWorkspaceHistory} from "./workspace.ts";
import {resolveAgentWorkspacePath,preloadWorkspaceDirectory,loadWorkspaceDirectory} from "./workspace.ts";

test("selectWorkspaceMode 切换右主区模式", () => {
  selectWorkspaceMode("git");
  assert.strictEqual(workspaceViewState.mode, "git");
  selectWorkspaceMode("files");
  assert.strictEqual(workspaceViewState.mode, "files");
});

test("native workspace context resolves offline and coalesces repeated path reads",async ctx=>{
  let calls=0;bridge(ctx,{workspaceGetContext:async()=>{calls++;return {success:true,data:{defaultRoot:"/local",activeRoot:null}};}});
  const state={client:null,connected:false};
  assert.deepEqual(await Promise.all([resolveAgentWorkspacePath(state,"main"),resolveAgentWorkspacePath(state,"main")]),["/local","/local"]);assert.equal(calls,1);
  await resolveAgentWorkspacePath(state,"main",true);assert.equal(calls,2);
});

test("directory preloading is read-only and is reused by foreground navigation",async ctx=>{
  let calls=0;bridge(ctx,{workspaceListDir:async()=>{calls++;return {success:true,data:{items:[{name:"a.txt",path:"/warm/a.txt",isDir:false}]}};}});
  const state={...host,client:{},connected:true} as unknown as AppViewState;
  Object.assign(workspaceViewState,{root:"/warm",currentPath:"/warm",selectedFile:"/draft.txt",draft:"keep",fileSaving:false,items:[]});
  await Promise.all([preloadWorkspaceDirectory(state),preloadWorkspaceDirectory(state)]);
  assert.equal(calls,1);assert.equal(workspaceViewState.selectedFile,"/draft.txt");assert.equal(workspaceViewState.draft,"keep");assert.equal(workspaceViewState.items.length,0);
  await loadWorkspaceDirectory(state,"/warm");assert.equal(calls,1);assert.equal(workspaceViewState.items[0].name,"a.txt");
  await loadWorkspaceDirectory(state,"/warm",true);assert.equal(calls,2);
  state.client={} as AppViewState["client"];await loadWorkspaceDirectory(state,"/warm");assert.equal(calls,3);
});

test("search clears old hits before debounce and ignores a late result after cancellation",async ctx=>{
  ctx.mock.timers.enable({apis:["setTimeout"]});
  let finish!:(value:unknown)=>void;
  bridge(ctx,{workspaceFindFiles:()=>new Promise(resolve=>{finish=resolve;})});
  Object.assign(workspaceViewState,{root:"/root",searchResults:[{name:"old.txt",path:"/root/old.txt",isDir:false}],error:"old failure",searchTruncated:true});
  setWorkspaceSearch(host,"new");
  assert.deepEqual(workspaceViewState.searchResults,[]);assert.equal(workspaceViewState.searchLoading,true);
  assert.equal(workspaceViewState.error,null);assert.equal(workspaceViewState.searchTruncated,false);
  ctx.mock.timers.tick(200);setWorkspaceSearch(host,"");
  finish({success:true,data:{items:[{name:"late"}],truncated:true}});
  await Promise.resolve();await Promise.resolve();
  assert.deepEqual(workspaceViewState.searchResults,[]);assert.equal(workspaceViewState.searchLoading,false);assert.equal(workspaceViewState.searchTruncated,false);
});

test("a successful search retry clears the failure and a rootless search ends loading",async ctx=>{
  ctx.mock.timers.enable({apis:["setTimeout"]});let fails=true;
  bridge(ctx,{workspaceFindFiles:async()=>fails?{success:false,message:"offline"}:{success:true,data:{items:[]}}});
  Object.assign(workspaceViewState,{root:"/root"});
  setWorkspaceSearch(host,"a");ctx.mock.timers.tick(200);await Promise.resolve();await Promise.resolve();
  assert.match(workspaceViewState.error??"",/offline/);
  fails=false;setWorkspaceSearch(host,"b");ctx.mock.timers.tick(200);await Promise.resolve();await Promise.resolve();
  assert.equal(workspaceViewState.error,null);assert.equal(workspaceViewState.searchLoading,false);
  workspaceViewState.root=null;setWorkspaceSearch(host,"c");ctx.mock.timers.tick(200);
  assert.equal(workspaceViewState.searchLoading,false);
});

test("history navigation cannot drift while a file save blocks directory loads",ctx=>{
  let calls=0;bridge(ctx,{workspaceListDir:async()=>{calls++;return {success:true,data:{items:[]}};}});
  Object.assign(workspaceViewState,{fileSaving:true,history:["/a","/b"],historyIndex:1,currentPath:"/b"});
  navigateWorkspaceHistory(host,-1);
  assert.equal(workspaceViewState.historyIndex,1);assert.equal(workspaceViewState.currentPath,"/b");assert.equal(calls,0);
  workspaceViewState.fileSaving=false;
});

test("file navigation requested during draft backup keeps the latest selection", async (ctx) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  ctx.after(() => { if(previous)Object.defineProperty(globalThis,"window",previous);else Reflect.deleteProperty(globalThis,"window"); });
  let finish!: () => void;
  const backup = new Promise<void>(resolve => { finish = resolve; });
  Object.defineProperty(globalThis,"window",{configurable:true,value:{cryoclaw:{
    workspaceSaveDraft:async()=>{await backup;return {success:true};},
    workspaceReadFile:async(path:string)=>({success:true,data:{content:path,hash:"hash",size:1}}),
  }}});
  Object.assign(workspaceViewState,{selectedFile:"/a.txt",fileContent:"original",draft:"draft",baseHash:"base",fileSaving:false});
  const host={requestUpdate(){}} as unknown as AppViewState;
  const older=loadWorkspaceFile(host,"/b.txt","b.txt");
  const newer=loadWorkspaceFile(host,"/c.txt","c.txt");
  finish();
  await Promise.all([older,newer]);
  assert.equal(workspaceViewState.selectedFile,"/c.txt");
  assert.equal(workspaceViewState.fileContent,"/c.txt");
});

test("discard completion cannot reload a different file opened while it was pending", async (ctx) => {
  const previous=Object.getOwnPropertyDescriptor(globalThis,"window");
  ctx.after(()=>{if(previous)Object.defineProperty(globalThis,"window",previous);else Reflect.deleteProperty(globalThis,"window");});
  let finish!:(value:unknown)=>void;
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  Object.defineProperty(globalThis,"window",{configurable:true,value:{cryoclaw:{workspaceSaveDraft:()=>new Promise(resolve=>{finish=resolve;entered();})}}});
  Object.assign(workspaceViewState,{selectedFile:"/a.txt",fileContent:"saved",draft:"saved",baseHash:"base",fileSaving:false});
  const pending=discardWorkspaceDraft({requestUpdate(){}} as unknown as AppViewState);
  await started;
  Object.assign(workspaceViewState,{selectedFile:"/b.txt",fileContent:"b",draft:"new draft"});
  finish({success:true});
  await pending;
  assert.equal(workspaceViewState.selectedFile,"/b.txt");
  assert.equal(workspaceViewState.draft,"new draft");
});

const host={requestUpdate(){}} as unknown as AppViewState;
function bridge(ctx: TestContext,value:unknown){
  const previous=Object.getOwnPropertyDescriptor(globalThis,"window");
  Object.defineProperty(globalThis,"window",{configurable:true,value:{cryoclaw:value}});
  ctx.after(()=>{if(previous)Object.defineProperty(globalThis,"window",previous);else Reflect.deleteProperty(globalThis,"window");});
}
function dirtyFile(){Object.assign(workspaceViewState,{selectedFile:"/keep.txt",fileContent:"saved",draft:"unsaved",baseHash:"base",fileSaving:false,recentFiles:[{path:"/keep.txt",name:"keep.txt",isDir:false}]});}

test("failed draft backup preserves the open file across navigation, root selection and close",async ctx=>{
  const calls:string[]=[];
  bridge(ctx,{workspaceSaveDraft:async()=>({success:false,message:"disk full"}),workspaceReadFile:async()=>{calls.push("read");},workspaceSetRoot:async()=>{calls.push("root");}});
  dirtyFile();
  await loadWorkspaceFile(host,"/other.txt","other.txt");
  await openWorkspaceDirectory(host,{path:"/folder",name:"folder",isDir:true});
  await closeWorkspaceFile(host,"/keep.txt");
  assert.equal(await setWorkspaceRoot(host,"/other-root"),false);
  assert.equal(workspaceViewState.selectedFile,"/keep.txt");
  assert.equal(workspaceViewState.draft,"unsaved");
  assert.equal(workspaceViewState.recentFiles.length,1);
  assert.deepEqual(calls,[]);
  assert.equal(workspaceViewState.loading,false);
});

test("edits made during draft backup are flushed before navigation",async ctx=>{
  let finish!:()=>void;const wait=new Promise<void>(resolve=>{finish=resolve;});const saved:string[]=[];
  bridge(ctx,{workspaceSaveDraft:async(p:{draft:string})=>{saved.push(p.draft);if(saved.length===1)await wait;return {success:true};},workspaceReadFile:async()=>({success:true,data:{content:"next",hash:"next"}})});
  dirtyFile();const loading=loadWorkspaceFile(host,"/next.txt","next.txt");
  await Promise.resolve();await Promise.resolve();
  updateWorkspaceDraft(host,"newest edit");finish();await loading;
  assert.deepEqual(saved,["unsaved","newest edit"]);
  assert.equal(workspaceViewState.selectedFile,"/next.txt");
});

test("root IPC mutations serialize so the backend and UI finish at the latest root",async ctx=>{
  let finish!:()=>void;const wait=new Promise<void>(resolve=>{finish=resolve;});const roots:string[]=[];
  bridge(ctx,{workspaceSetRoot:async(root:string)=>{roots.push(root);if(root==="/first")await wait;return {success:true};},workspaceListDir:async()=>({success:true,data:{items:[]}})});
  Object.assign(workspaceViewState,{selectedFile:null,fileSaving:false,root:null});
  const first=setWorkspaceRoot(host,"/first");
  for(let i=0;i<6;i++)await Promise.resolve();
  const last=setWorkspaceRoot(host,"/last");finish();await Promise.all([first,last]);
  assert.equal(roots.at(-1),"/last");assert.equal(workspaceViewState.root,"/last");
});

test("root IPC rejection clears loading and remains retryable",async ctx=>{
  bridge(ctx,{workspaceSetRoot:async()=>{throw Error("bridge closed");}});
  Object.assign(workspaceViewState,{selectedFile:null,fileSaving:false,loading:true});
  assert.equal(await setWorkspaceRoot(host,"/failed"),false);
  assert.equal(workspaceViewState.loading,false);assert.match(workspaceViewState.error??"",/bridge closed/);
});

test("discard cannot erase a newer backup created while its clear IPC is pending",async ctx=>{
  let finishClear!:()=>void,finishBackup!:()=>void;
  const wait=new Promise<void>(resolve=>{finishClear=resolve;}),backedUp=new Promise<void>(resolve=>{finishBackup=resolve;});
  let disk:string|null='old';
  bridge(ctx,{workspaceSaveDraft:async(p:{draft:string|null})=>{if(p.draft===null){await wait;disk=null;}else{disk=p.draft;finishBackup();}return {success:true};}});
  Object.assign(workspaceViewState,{selectedFile:'/discard-race.txt',fileContent:'saved',draft:'saved',baseHash:'base',fileSaving:false});
  const pending=discardWorkspaceDraft(host);
  for(let i=0;i<4;i++)await Promise.resolve();
  updateWorkspaceDraft(host,'new edit');leaveWorkspace(host);
  for(let i=0;i<4;i++)await Promise.resolve();
  finishClear();await pending;await backedUp;
  assert.equal(disk,'new edit');assert.equal(workspaceViewState.draft,'new edit');
});
