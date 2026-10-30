const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{pathToFileURL}=require('node:url');
const kdp=require('./lib/kernel-dist-patch');
const preflight=`export async function run(sourceConfig,env){
 const read={snapshot:{sourceConfig}};env.events.push('state-admission');
 const { HISTORICAL_WEBHOOK_CHANNELS, recordUnwrittenWebhookCompletion } = await import("./legacy-webhook-pins-wrapper.mjs");
 const webhookCompletion = read.snapshot.sourceConfig.meta?.migrations?.webhookListeners;
 if (webhookCompletion !== true && !HISTORICAL_WEBHOOK_CHANNELS.every((id) => Object.hasOwn(webhookCompletion ?? {}, id))) {
  const { applyPluginDoctorCompatibilityMigrations } = await import("./doctor-contract-registry-fixture.mjs");
  await applyPluginDoctorCompatibilityMigrations(sourceConfig,{env});
 }
 env.events.push('plugin-quarantine');return env.events;
}`;
const pins=`import { readConfigMachineState } from "./config-machine-state-fixture.mjs";
import { resolveConfigPath } from "./paths-fixture.mjs";
const HISTORICAL_WEBHOOK_CHANNELS=["telegram","feishu","msteams","nextcloud-talk"];
function webhookCompletionKey(env) {
 return \`webhookListeners:\${resolveConfigPath(env)}\`;
}
function recordUnwrittenWebhookCompletion(){}
function applyHistoricalWebhookPins(mutation,declaration,context={}) {
 const env=context.env;
 const marker = mutation.config.meta?.migrations?.webhookListeners ?? readConfigMachineState(webhookCompletionKey(env), { env });
 return marker;
}
export {HISTORICAL_WEBHOOK_CHANNELS as t,recordUnwrittenWebhookCompletion as r,applyHistoricalWebhookPins as n};`;
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cryo-webhook-precheck-')),gatewayDir=path.join(root,'gateway'),packageDir=path.join(gatewayDir,'node_modules','openclaw'),dist=path.join(packageDir,'dist');fs.mkdirSync(dist,{recursive:true});
 const files={'startup-config-preflight-fixture.mjs':preflight,'legacy-webhook-pins-impl.mjs':pins,'legacy-webhook-pins-wrapper.mjs':'import {r as recordUnwrittenWebhookCompletion,t as HISTORICAL_WEBHOOK_CHANNELS} from "./legacy-webhook-pins-impl.mjs";export {HISTORICAL_WEBHOOK_CHANNELS,recordUnwrittenWebhookCompletion};','paths-fixture.mjs':'export function resolveConfigPath(env){return env.configPath;}','config-machine-state-fixture.mjs':'export function readConfigMachineState(key,{env}){env.readKeys.push(key);if(env.readError)throw Error("read-only DB unavailable");return env.rows[key];}','spy-fixture.mjs':'export const spy={imports:0,migrations:0};','doctor-contract-registry-fixture.mjs':'import {spy} from "./spy-fixture.mjs";spy.imports++;export async function applyPluginDoctorCompatibilityMigrations(_config,{env}){spy.migrations++;env.events.push("migration");return {changes:[]};}'};
 for(const [name,source]of Object.entries(files))fs.writeFileSync(path.join(dist,name),source);fs.writeFileSync(path.join(packageDir,'package.json'),JSON.stringify({version:'2026.10.7'}));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {gatewayDir,dist,files,environment:(marker,configPath='C:/qa/openclaw.json')=>({configPath,rows:{['webhookListeners:'+configPath]:marker},readKeys:[],events:[]}),load:()=>import(pathToFileURL(path.join(dist,'startup-config-preflight-fixture.mjs')).href),spy:async()=>(await import(pathToFileURL(path.join(dist,'spy-fixture.mjs')).href)).spy};
}
const config=marker=>marker===undefined?{}:{meta:{migrations:{webhookListeners:marker}}};

test('completed machine state avoids importing migration registry and retains both admission boundaries',async t=>{
 const f=fixture(t);assert.equal(kdp.patchWebhookCompletionPrecheck(f.gatewayDir),1);const {run}=await f.load(),env=f.environment(true);await run(config(),env);
 assert.deepEqual(env.events,['state-admission','plugin-quarantine']);assert.deepEqual(env.readKeys,['webhookListeners:C:/qa/openclaw.json']);assert.deepEqual(await f.spy(),{imports:0,migrations:0});
 const source=f.environment(false);await run(config(true),source);assert.deepEqual(source.readKeys,[]);assert.deepEqual(source.events,['state-admission','plugin-quarantine']);
 const all=Object.fromEntries(['telegram','feishu','msteams','nextcloud-talk'].map(id=>[id,[]]));const complete=f.environment(all);await run(config(null),complete);assert.deepEqual(complete.events,['state-admission','plugin-quarantine']);
});

test('source false, incomplete markers, read failures and another config path retain migration',async t=>{
 const f=fixture(t);kdp.patchWebhookCompletionPrecheck(f.gatewayDir);const {run}=await f.load();
 const cases=[[false,true],[{telegram:[]},true],[undefined,undefined],[undefined,false],[undefined,'true'],[undefined,{telegram:[]}]];
 for(const [source,machine]of cases){const env=f.environment(machine);await run(config(source),env);assert.deepEqual(env.events,['state-admission','migration','plugin-quarantine']);if(source!==undefined)assert.deepEqual(env.readKeys,[]);}
 const denied=f.environment(true);denied.readError=true;await run(config(),denied);assert.ok(denied.events.includes('migration'));
 const different=f.environment(true);different.configPath='C:/other/openclaw.json';await run(config(),different);assert.ok(different.events.includes('migration'));assert.equal(different.readKeys[0],'webhookListeners:C:/other/openclaw.json');assert.equal((await f.spy()).migrations,8);
});

test('patch is byte-for-byte idempotent and preserves the original migration import',t=>{
 const f=fixture(t);assert.equal(kdp.patchWebhookCompletionPrecheck(f.gatewayDir),1);const names=['startup-config-preflight-fixture.mjs','legacy-webhook-pins-impl.mjs','legacy-webhook-pins-wrapper.mjs'],once=names.map(name=>fs.readFileSync(path.join(f.dist,name),'utf8'));
 assert.equal(kdp.patchWebhookCompletionPrecheck(f.gatewayDir),1);assert.deepEqual(names.map(name=>fs.readFileSync(path.join(f.dist,name),'utf8')),once);assert.match(once[0],/await import\("\.\/doctor-contract-registry-fixture\.mjs"\)/);assert.equal(once[2],f.files[names[2]]);
});

test('unknown upstream contracts fail before writing either module',t=>{
 for(const [file,from,to]of [['startup-config-preflight-fixture.mjs','read.snapshot.sourceConfig.meta?.migrations?.webhookListeners','newUpstreamSelection()'],['legacy-webhook-pins-impl.mjs','?? readConfigMachineState','|| readConfigMachineState'],['legacy-webhook-pins-impl.mjs','webhookListeners:','changedMarker:']]){
  const f=fixture(t),target=path.join(f.dist,file);fs.writeFileSync(target,fs.readFileSync(target,'utf8').replace(from,to));const before=Object.fromEntries(fs.readdirSync(f.dist).map(name=>[name,fs.readFileSync(path.join(f.dist,name),'utf8')]));assert.throws(()=>kdp.patchWebhookCompletionPrecheck(f.gatewayDir),/Webhook.*contract changed/);assert.deepEqual(Object.fromEntries(fs.readdirSync(f.dist).map(name=>[name,fs.readFileSync(path.join(f.dist,name),'utf8')])),before);
 }
});

test('a corrupted existing marker is rejected and a pinned kernel cannot silently lose coverage',t=>{
 const f=fixture(t);kdp.patchWebhookCompletionPrecheck(f.gatewayDir);const file=path.join(f.dist,'legacy-webhook-pins-impl.mjs');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('catch { return undefined; }','catch { return true; }'));assert.throws(()=>kdp.patchWebhookCompletionPrecheck(f.gatewayDir),/Webhook.*contract changed/);
 const missing=fixture(t);fs.unlinkSync(path.join(missing.dist,'startup-config-preflight-fixture.mjs'));assert.throws(()=>kdp.patchWebhookCompletionPrecheck(missing.gatewayDir),/Webhook.*coverage/);
});
