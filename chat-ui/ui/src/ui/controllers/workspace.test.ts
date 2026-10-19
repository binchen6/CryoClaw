// controllers/workspace.ts 纯状态单测（R42 第二期 Task 3）：
// 右主区模式切换直接改 workspaceViewState.mode，无 bridge 依赖，可在 node 下断言。
import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import { selectWorkspaceMode, workspaceViewState, loadWorkspaceFile, discardWorkspaceDraft, openWorkspaceDirectory, closeWorkspaceFile, setWorkspaceRoot, updateWorkspaceDraft, leaveWorkspace } from "./workspace.ts";
import type { AppViewState } from "../app-view-state.ts";

test("selectWorkspaceMode 切换右主区模式", () => {
  selectWorkspaceMode("git");
  assert.strictEqual(workspaceViewState.mode, "git");
  selectWorkspaceMode("files");
  assert.strictEqual(workspaceViewState.mode, "files");
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
