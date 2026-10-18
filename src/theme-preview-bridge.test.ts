import {test,expect,vi,beforeEach,afterEach} from "vitest";
const state=vi.hoisted(()=>({listener:null as null|((event:any,response:any)=>void)}));
vi.mock("electron",()=>({ipcMain:{on:(_channel:string,listener:any)=>{state.listener=listener;}}}));
vi.mock("./ipc-sender-guard",()=>({assertTrustedIpcSender:()=>true}));
beforeEach(()=>{vi.resetModules();state.listener=null;vi.useFakeTimers();});
afterEach(()=>{vi.useRealTimers();});
test("theme responses from another window cannot settle the pending request",async()=>{
  const {requestThemeUi}=await import("./theme-preview-bridge");let sent:any;
  const pending=requestThemeUi({id:7,isDestroyed:()=>false,send:(_channel:string,value:any)=>{sent=value;}} as never,{action:"inspect"});
  state.listener!({sender:{id:8}},{id:sent.id,value:{wrong:true}});
  state.listener!({sender:{id:7}},{id:sent.id,value:{preview:true}});
  await expect(pending).resolves.toEqual({preview:true});
});
test("cyclic renderer responses reject safely without throwing in the main listener",async()=>{
  const {requestThemeUi}=await import("./theme-preview-bridge");let sent:any;
  const pending=requestThemeUi({id:7,isDestroyed:()=>false,send:(_channel:string,value:any)=>{sent=value;}} as never,{action:"inspect"});
  const cyclic:any={};cyclic.self=cyclic;
  const rejected=expect(pending).rejects.toThrow("Invalid theme response");
  expect(()=>state.listener!({sender:{id:7}},{id:sent.id,value:cyclic})).not.toThrow();await rejected;
});
test("failed UI sends release bounded request slots immediately",async()=>{
  const {requestThemeUi}=await import("./theme-preview-bridge");
  const target={id:7,isDestroyed:()=>false,send:()=>{throw Error("window closed");}};
  for(let i=0;i<10;i++)await expect(requestThemeUi(target as never,{action:"inspect"})).rejects.toThrow("UI unavailable");
  expect(vi.getTimerCount()).toBe(0);
});
