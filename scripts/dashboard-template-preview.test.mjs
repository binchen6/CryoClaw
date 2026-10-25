import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {templateCatalog,templatePreview} from '../builtin-plugins/cryoclaw-dashboards/templates.mjs';
import plugin from '../builtin-plugins/cryoclaw-dashboards/index.mjs';

function previewRoutes(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cryoclaw-preview-route-')),stateDir=path.join(dir,'unopened-state');
 const previous=process.env.OPENCLAW_STATE_DIR,methods=new Map();let route;
 process.env.OPENCLAW_STATE_DIR=stateDir;
 try{plugin.register({config:{gateway:{auth:{token:'host-token-must-stay-private'}}},registerGatewayMethod:(name,handler)=>methods.set(name,handler),registerHttpRoute:value=>{route=value;},registerTool(){}});}
 finally{if(previous===undefined)delete process.env.OPENCLAW_STATE_DIR;else process.env.OPENCLAW_STATE_DIR=previous;}
 t.after(()=>{assert.equal(fs.existsSync(stateDir),false,'template previews must never open or create the dashboard database');fs.rmSync(dir,{recursive:true,force:true});});
 return {methods,async request(url,method='GET'){
  const response={status:0,headers:{},body:''};
  const req={url,method,headers:{cookie:'host-session=private',authorization:'Bearer host-token-must-stay-private'},async *[Symbol.asyncIterator](){throw Error('Preview must not read a request body');}};
  const res={writeHead(status,headers){response.status=status;response.headers=headers??{};},end(value){response.body=value??'';}};
  assert.equal(await route.handler(req,res),true);return response;
 }};
}

function previewSdk(id){
 const preview=templatePreview(id),window={};
 const runtime=preview.html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/)[1];
 vm.runInNewContext(runtime,{window,innerWidth:360,innerHeight:480,matchMedia:()=>({matches:false}),
  document:{hidden:false},addEventListener(){},structuredClone,
  parent:{postMessage(){throw Error('Preview must not contact its host');}},
  fetch(){throw Error('Preview must not make network requests');}});
 return {preview,sdk:window.cryoclawDashboard};
}

test('all module previews include responsive styling and a restrictive network policy',()=>{
 const catalog=templateCatalog();assert.equal(catalog.cards.length,11);
 for(const card of catalog.cards){
  const {preview,sdk}=previewSdk(card.id);
  assert.match(preview.html,/data-cryoclaw-responsive/,card.id);
  assert.match(preview.html,/default-src 'none'/,card.id);
  assert.equal(sdk.preview,true,card.id);
  assert.equal(sdk.viewport.width,360);assert.equal(sdk.viewport.height,480);
  assert.equal(sdk.compose('Do not send'),false);
  if(card.id==='release-gallery')assert.doesNotMatch(preview.html,/card\.onpointerenter=\(\)=>card\.click/,'selection must not jump between moving cards under the pointer');
 }
});

test('market, currency and release previews return complete clearly marked sample fixtures',async()=>{
 const {sdk:fx}=previewSdk('fx-rates'),rates=await fx.data('rates'),history=await fx.data('history');
 assert.equal(rates.preview,true);assert.equal(rates.value.length,4);
 assert.ok(history.value.length>=8);
 const {sdk:market}=previewSdk('market-watch'),stocks=await market.data('stocks');
 assert.equal(stocks.preview,true);assert.equal(stocks.value.data.diff.length,3);
 assert.ok((await market.data('k600519')).value.data.klines.length>=2);
 const {sdk:releases}=previewSdk('release-gallery'),journal=await releases.data('releases');
 assert.equal(journal.preview,true);assert.ok(journal.value.length>=4);
 assert.ok(journal.value.every(item=>item.name.includes('示例')));
 await assert.rejects(fx.data('unlisted-source'),/preview/i);
});

test('preview notes are useful, editable and isolated from other previews',async()=>{
 const first=previewSdk('quick-notes').sdk,second=previewSdk('quick-notes').sdk;
 assert.ok((await first.getState()).text.length>0);
 await first.setState({text:'temporary changes'});
 assert.equal((await first.getState()).text,'temporary changes');
 assert.notEqual((await second.getState()).text,'temporary changes');
 const state=await first.getState();state.text='mutated caller copy';
 assert.equal((await first.getState()).text,'temporary changes');
});

test('system and disk previews use samples without querying this computer',async()=>{
 for(const id of ['system-check','disk-space']){
  const {sdk,preview}=previewSdk(id),system=await sdk.system();
  assert.equal(system.preview,true);assert.ok(system.diskFree>0&&system.diskTotal>system.diskFree);
  if(id==='system-check'){
   assert.match(preview.html,/data-system-preview/);assert.match(preview.html,/示例数据/);
   assert.match(preview.html,/id="check"/);assert.match(preview.html,/CPU/);
  }
 }
});

test('template RPC returns a ticket-free document path for the selected local template',async t=>{
 const {methods}=previewRoutes(t);let result;
 await methods.get('cryoclaw.dashboards.templates')({params:{templateId:'quick-notes'},respond:(ok,value)=>{assert.equal(ok,true);result=value;}});
 assert.equal(result.previewPath,'/__cryoclaw__/dashboards/preview/quick-notes?v=1.3.0');
 assert.match(result.html,/preview:true/);
 assert.doesNotMatch(JSON.stringify(result),/host-token-must-stay-private|ticket=/);
});

test('HTTP previews serve only static fixtures with their own opaque network-free policy',async t=>{
 const {request}=previewRoutes(t);
 for(const {id} of templateCatalog().cards){
  const response=await request(`/__cryoclaw__/dashboards/preview/${id}?v=1.3.0`);
  assert.equal(response.status,200,id);
  assert.equal(response.headers['Content-Type'],'text/html; charset=utf-8');
  const policy=response.headers['Content-Security-Policy'];
  assert.match(policy,/(?:^|; )connect-src 'none'(?:;|$)/);
  assert.match(policy,/(?:^|; )form-action 'none'(?:;|$)/);
  assert.match(policy,/(?:^|; )sandbox allow-scripts allow-forms(?:;|$)/);
  assert.doesNotMatch(policy,/allow-same-origin|allow-popups|https?:/);
  assert.equal(response.headers['Cache-Control'],'no-store');
  assert.match(response.body,/preview:true/);
  assert.doesNotMatch(response.body,/host-token-must-stay-private|host-session|ticket=/);
 }
});

test('HTTP previews reject write methods, arbitrary template paths and state API queries',async t=>{
 const {request}=previewRoutes(t),base='/__cryoclaw__/dashboards/preview/';
 for(const method of ['HEAD','POST','PUT','PATCH','DELETE','OPTIONS']){
  const response=await request(base+'quick-notes?v=1.3.0',method);
  assert.equal(response.status,405,method);assert.equal(response.headers.Allow,'GET');
 }
 for(const suffix of ['missing','toString','quick-notes/child','quick-notes/','%71uick-notes','quick-notes%2fchild','quick-notes/../quick-notes','../preview/quick-notes','quick-notes?api=getState','quick-notes?api=setState','quick-notes?ticket=private']){
  const response=await request(base+suffix);
  assert.equal(response.status,403,suffix);assert.doesNotMatch(response.body,/preview:true/);
 }
});
