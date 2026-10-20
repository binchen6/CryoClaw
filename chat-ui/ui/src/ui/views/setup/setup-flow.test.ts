import test from 'node:test';import assert from 'node:assert/strict';
import type {DetectionResult} from '../../data/ipc-bridge.ts';
import {createSetupFlow,detectSetup} from './setup-flow.ts';
const clean:DetectionResult={portInUse:false,portProcess:'',portPid:0,globalInstalled:false,globalPath:''};
test('setup detection routes clean and conflicting installations explicitly',async()=>{
  const flow=createSetupFlow();await detectSetup(flow,async()=>clean,()=>{});assert.equal(flow.currentStep,1);
  await detectSetup(flow,async()=>({...clean,portInUse:true}),()=>{});assert.equal(flow.currentStep,0);assert.equal(flow.conflictResult?.portInUse,true);
});
test('failed or timed-out detection stays recoverable instead of silently advancing',async ctx=>{
  ctx.mock.timers.enable({apis:['setTimeout']});const flow=createSetupFlow();
  const pending=detectSetup(flow,()=>new Promise(()=>{}),()=>{},100);ctx.mock.timers.tick(100);await pending;
  assert.equal(flow.currentStep,-1);assert.match(flow.detectError??'',/timed out/);assert.equal(flow.detecting,false);
  await detectSetup(flow,async()=>clean,()=>{});assert.equal(flow.currentStep,1);assert.equal(flow.detectError,null);
});
test('a late detection result cannot replace the result of a newer retry',async()=>{
  const flow=createSetupFlow();let finish!:(value:DetectionResult)=>void;
  const old=detectSetup(flow,()=>new Promise(resolve=>finish=resolve),()=>{});
  await detectSetup(flow,async()=>clean,()=>{});finish({...clean,portInUse:true});await old;
  assert.equal(flow.currentStep,1);assert.equal(flow.conflictResult,null);
});
