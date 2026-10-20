import test from 'node:test';import assert from 'node:assert/strict';
import type {AppViewState} from '../app-view-state.ts';
import {runKimiOAuthLogin,type KimiOAuthFlowState} from './kimi-oauth-flow.ts';
const host={requestUpdate(){}} as AppViewState;
function state():KimiOAuthFlowState{return {oauthLoading:false,oauthSuccess:false,oauthNoMembership:false,error:null};}
function loginBridge(ctx:any,login:()=>Promise<any>){const previous=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{configurable:true,value:{cryoclaw:{kimiOAuthLogin:login}}});ctx.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});}
test('OAuth persistence failures are visible and always release the busy state',async ctx=>{
  loginBridge(ctx,async()=>({success:true,accessToken:'fixture'}));const s=state();
  await runKimiOAuthLogin(host,s,async()=>{throw Error('save failed');});assert.equal(s.oauthLoading,false);assert.match(s.error??'',/save failed/);
});
test('cancelled login results cannot advance setup or clear a newer login state',async ctx=>{
  const finish:Array<(value:any)=>void>=[];loginBridge(ctx,()=>new Promise(resolve=>finish.push(resolve)));const s=state();let completed=0;
  const first=runKimiOAuthLogin(host,s,()=>{completed++;});s.oauthLoading=false;
  const second=runKimiOAuthLogin(host,s,()=>{completed++;});finish[0]({success:true});await first;
  assert.equal(completed,0);assert.equal(s.oauthLoading,true);finish[1]({success:true});await second;assert.equal(completed,1);assert.equal(s.oauthLoading,false);
});
test('a cancelled login rejection cannot overwrite a newer login attempt',async ctx=>{
  const pending:Array<{resolve:(value:any)=>void;reject:(error:Error)=>void}>=[];
  loginBridge(ctx,()=>new Promise((resolve,reject)=>pending.push({resolve,reject})));const s=state();
  const first=runKimiOAuthLogin(host,s,()=>{});s.oauthLoading=false;
  const second=runKimiOAuthLogin(host,s,()=>{});pending[0].reject(Error('old failure'));await first;
  assert.equal(s.error,null);assert.equal(s.oauthLoading,true);pending[1].resolve({success:true});await second;
});
