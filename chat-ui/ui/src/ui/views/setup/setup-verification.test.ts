import test from 'node:test';import assert from 'node:assert/strict';
import {verifySetupSelection} from './setup-verification.ts';
test('setup saves the original verified selection and reports the saving phase',async()=>{
  const form={provider:'a',model:'one'};let finish!:(value:{success:boolean})=>void;const events:string[]=[];
  const pending=verifySetupSelection(form,()=>new Promise(resolve=>finish=resolve),async captured=>{assert.deepEqual(captured,{provider:'a',model:'one'});events.push('save');},()=>events.push('saving'));
  form.provider='b';form.model='two';finish({success:true});await pending;assert.deepEqual(events,['saving','save']);
});
test('verification failures never save and persistence failures propagate for retry',async()=>{
  let saves=0;await verifySetupSelection({},async()=>({success:false}),async()=>{saves++;},()=>{});assert.equal(saves,0);
  await assert.rejects(verifySetupSelection({},async()=>({success:true}),async()=>{throw Error('disk full');},()=>{}),/disk full/);
});
