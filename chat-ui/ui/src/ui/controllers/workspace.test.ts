// controllers/workspace.ts 纯状态单测（R42 第二期 Task 3）：
// 右主区模式切换直接改 workspaceViewState.mode，无 bridge 依赖，可在 node 下断言。
import test from "node:test";
import assert from "node:assert/strict";
import { selectWorkspaceMode, workspaceViewState, loadWorkspaceFile, discardWorkspaceDraft } from "./workspace.ts";
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
  Object.defineProperty(globalThis,"window",{configurable:true,value:{cryoclaw:{workspaceSaveDraft:()=>new Promise(resolve=>{finish=resolve;})}}});
  Object.assign(workspaceViewState,{selectedFile:"/a.txt",fileContent:"saved",draft:"saved",baseHash:"base",fileSaving:false});
  const pending=discardWorkspaceDraft({requestUpdate(){}} as unknown as AppViewState);
  await Promise.resolve();
  Object.assign(workspaceViewState,{selectedFile:"/b.txt",fileContent:"b",draft:"new draft"});
  finish({success:true});
  await pending;
  assert.equal(workspaceViewState.selectedFile,"/b.txt");
  assert.equal(workspaceViewState.draft,"new draft");
});
