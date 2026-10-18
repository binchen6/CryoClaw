import test from "node:test";
import assert from "node:assert/strict";
import {scheduleAppearancePreview,cancelAppearancePreview} from "./appearance-preview-scheduler.ts";
test("many slider events coalesce into the latest preview per frame and can be cancelled",()=>{
  const previous={request:globalThis.requestAnimationFrame,cancel:globalThis.cancelAnimationFrame};
  const callbacks=new Map<number,FrameRequestCallback>();let id=0,frames=0,result=-1;
  Object.assign(globalThis,{requestAnimationFrame:(callback:FrameRequestCallback)=>{frames++;callbacks.set(++id,callback);return id;},cancelAnimationFrame:(key:number)=>callbacks.delete(key)});
  try {
    const host={};for(let value=0;value<100;value++)scheduleAppearancePreview(host,()=>{result=value;});
    assert.equal(frames,1);callbacks.get(1)!(0);assert.equal(result,99);
    scheduleAppearancePreview(host,()=>{result=200;});cancelAppearancePreview(host);assert.equal(callbacks.has(2),false);
  } finally {Object.assign(globalThis,{requestAnimationFrame:previous.request,cancelAnimationFrame:previous.cancel});}
});
