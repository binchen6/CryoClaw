import {ipcMain,type WebContents} from "electron";
import {randomUUID} from "node:crypto";
import {assertTrustedIpcSender} from "./ipc-sender-guard";

const pending=new Map<string,{sender:number;resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
let registered=false;
export function requestThemeUi(target:WebContents,payload:unknown):Promise<unknown> {
  if(target.isDestroyed())return Promise.reject(new Error("UI unavailable"));
  if(!registered){
    registered=true;
    ipcMain.on("theme:result",(event,response)=>{
      if(!assertTrustedIpcSender(event,"theme:result") || typeof response?.id!=="string")return;
      const item=pending.get(response.id);if(!item || item.sender!==event.sender.id)return;
      clearTimeout(item.timer);pending.delete(response.id);
      try {
        if(response.error)item.reject(new Error(String(response.error).slice(0,300)));
        else if(Buffer.byteLength(JSON.stringify(response.value??null))>65536)item.reject(new Error("Theme response too large"));
        else item.resolve(response.value);
      } catch {item.reject(new Error("Invalid theme response"));}
    });
  }
  if(pending.size>=8)return Promise.reject(new Error("Theme preview is busy"));
  const id=randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error("Theme UI did not respond; open CryoClaw and retry"));},10000);
    pending.set(id,{sender:target.id,resolve,reject,timer});
    try {target.send("theme:request",{id,payload});}
    catch {clearTimeout(timer);pending.delete(id);reject(new Error("UI unavailable"));}
  });
}
