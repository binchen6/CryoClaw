import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual main-process orchestration, without Electron or real children.
function fixture(prepare?:()=>Promise<void>){
 const source=fs.readFileSync(path.join(__dirname,'..','src','main.ts'),'utf8');
 const parsed=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
 const functions=new Set(['prepareGatewayForStart','ensureGatewayRunning','startGatewayAndShowMain','requestGatewayStart','requestGatewayRestart','requestGatewayStop','cancelPendingGatewayRestart','cancelScheduledCrashRestart','scheduleGatewayCrashRestart']);
 const variables=new Set(['inflightGatewayOp','gatewayControlEpoch','gatewayManuallyStopped','restartTimer','crashRestartTimer','crashRestartTimes','isQuitting','openclawStateImportLifecycle']);
 const declarations=parsed.statements.filter(statement=>{
  if(ts.isFunctionDeclaration(statement))return functions.has(statement.name?.text??'');
  if(ts.isVariableStatement(statement))return statement.declarationList.declarations.some(declaration=>ts.isIdentifier(declaration.name)&&variables.has(declaration.name.text));
  if(ts.isExpressionStatement(statement)&&ts.isCallExpression(statement.expression)){const call=statement.expression;return ts.isPropertyAccessExpression(call.expression)&&call.expression.getText(parsed)==='ipcMain.handle'&&ts.isStringLiteral(call.arguments[0])&&['kernel:update','kernel:rollback'].includes(call.arguments[0].text);}
  return false;
 }).map(statement=>statement.getText(parsed)).join('\n');
 const calls:string[]=[],timers=new Set<()=>void>();let state='stopped';
 const env:any={Promise,MAX_GATEWAY_START_ATTEMPTS:3,CRASH_RESTART_DELAY_MS:3000,CRASH_RESTART_MAX:3,CRASH_RESTART_WINDOW_MS:300000,Date,
  log:{info(){},warn(){},error(){}},openclawStateImportLifecycle:{isImportActive:()=>false},getKernelUpdateState:()=>({running:false}),
  ensureBundledDeliverablesEnabled(){},migrateLegacyFeishuConfigForGatewayStart(){},ensureOptionalPluginDemand:async()=>{calls.push('demand');await prepare?.();},syncGatewayRuntimeConfigFromDisk:async()=>{calls.push('config');},
  gateway:{getState:()=>state,start:async()=>{calls.push('start');state='running';},restart:async()=>{calls.push('restart');state='running';},stop:async()=>{calls.push('stop');state='stopped';}},recordLastKnownGoodConfigSnapshot(){},
  decideCrashRestart:()=>({allow:true,times:[],attempt:1}),openRecoverySettings(){},
  setTimeout:(callback:()=>void)=>{timers.add(callback);return {callback,unref(){}};},clearTimeout:(timer:{callback:()=>void})=>timers.delete(timer.callback),
  showMainWindow:async()=>{},reconcileExtensionsOnAppLaunch:async()=>{},reconcilePluginsAllowWithEnabled(){},reportGatewayStartFailure(){calls.push('failure-report');return 'ignore';},
  createOpenclawStateImportLifecycle:(deps:any)=>{env.importDeps=deps;return {isImportActive:()=>false};},
  assertTrustedIpcSender:()=>true,ipcMain:{handle:(name:string,callback:any)=>{env[name]=callback;}},
 };
 vm.runInNewContext(ts.transpileModule(declarations+'\nObject.assign(globalThis,{requestGatewayStart,requestGatewayRestart,requestGatewayStop,scheduleGatewayCrashRestart,ensureGatewayRunning,startGatewayAndShowMain,pending:()=>inflightGatewayOp});',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,env);
 env.runKernelUpdate=async()=>({ok:await env.ensureGatewayRunning('kernel-update')});env.runKernelRollback=env.runKernelUpdate;
 return {env,calls,timers,runTimers:()=>{for(const callback of [...timers]){timers.delete(callback);callback();}}};
}
test('manual stop cancels a debounced restart and a pending crash recovery',async()=>{
 const f=fixture();f.env.requestGatewayRestart('test');f.env.scheduleGatewayCrashRestart({code:1,signal:null});
 await f.env.requestGatewayStop('test');f.runTimers();await f.env.pending();assert.equal(f.calls.includes('restart'),false);assert.equal(f.calls.includes('start'),false);assert.equal(f.timers.size,0);
});
test('stop invalidates a queued start while plugin demand is still being prepared',async()=>{
 let finish!:()=>void;const f=fixture(()=>new Promise<void>(resolve=>finish=resolve));
 f.env.requestGatewayStart('test');await Promise.resolve();await Promise.resolve();const stopped=f.env.requestGatewayStop('test');finish();await stopped;await f.env.pending();assert.equal(f.calls.includes('start'),false);
});
test('an explicit start after stopping prepares demand before synchronizing runtime and starting',async()=>{
 const f=fixture();await f.env.requestGatewayStop('test');f.calls.length=0;f.env.requestGatewayStart('test');await f.env.pending();assert.deepEqual(f.calls,['demand','config','start']);
});
test('manual stop also cancels the unqueued supervised startup path',async()=>{
 let finish!:()=>void;const f=fixture(()=>new Promise<void>(resolve=>finish=resolve));
 const starting=f.env.ensureGatewayRunning('boot');await Promise.resolve();const stopped=f.env.requestGatewayStop('test');finish();await stopped;assert.equal(await starting,false);assert.equal(f.calls.includes('start'),false);
});
test('stop then start does not let an old canceled launch report a failure or restore configuration',async()=>{
 let finish!:()=>void,count=0;const f=fixture(()=>++count===1?new Promise<void>(resolve=>finish=resolve):Promise.resolve());
 const boot=f.env.startGatewayAndShowMain('boot');for(let i=0;i<6&&!finish;i++)await Promise.resolve();
 await f.env.requestGatewayStop('test');f.env.requestGatewayStart('test');finish();await boot;await f.env.pending();assert.equal(f.calls.includes('failure-report'),false);assert.equal(f.calls.filter(call=>call==='start').length,1);
});
test('a user-requested import or kernel mutation can start a previously stopped gateway',async()=>{
 for(const operation of ['import','kernel:update','kernel:rollback']){
  const f=fixture();await f.env.requestGatewayStop('test');
  if(operation==='import'){await f.env.importDeps.quiesceGateway();await f.env.importDeps.startGateway();}
  else assert.equal((await f.env[operation]({})).ok,true);
  assert.equal(f.calls.filter(call=>call==='start').length,1,operation);
 }
});
