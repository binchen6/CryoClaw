import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {transformSync} from 'esbuild';
import {inspectorScript} from '../builtin-plugins/cryoclaw-dashboards/inspector.mjs';
import {createDashboardStore} from '../builtin-plugins/cryoclaw-dashboards/store.mjs';

function fixture(){
  const window=new EventTarget(),messages=[];
  const context=vm.createContext({
    window,
    parent:{postMessage:value=>messages.push(value)},
    document:{body:{},querySelector:()=>null,documentElement:{append(){}}},
    addEventListener:(...args)=>window.addEventListener(...args),
    removeEventListener:(...args)=>window.removeEventListener(...args),
  });
  vm.runInContext(inspectorScript(),context);
  return {window,messages,active:value=>vm.runInContext(`updateInspector(${value})`,context)};
}
function keyEvent(key){
  const event=new Event('keydown',{cancelable:true});
  Object.defineProperty(event,'key',{value:key});
  return event;
}

test('element selection blocks capture handlers installed by the card before inspector activation',()=>{
  const {window,active}=fixture();let changes=0;
  window.addEventListener('pointerdown',()=>{changes++;},true);
  active(true);
  const event=new Event('pointerdown',{cancelable:true});window.dispatchEvent(event);
  assert.equal(event.defaultPrevented,true);
  assert.equal(changes,0,'selecting a target must not run the original card capture handler');
});

test('inspection blocks ordinary typing before it reaches an editable card handler',()=>{
  const {window,active}=fixture();active(true);let edits=0;
  window.addEventListener('keydown',()=>{edits++;});
  const event=keyEvent('a');window.dispatchEvent(event);
  assert.equal(event.defaultPrevented,true,'typing in a selected input must not modify its value');
  assert.equal(edits,0);
});

test('inspection blocks beforeinput so paste and IME cannot mutate card state',()=>{
  const {window,active}=fixture();active(true);let edits=0;
  window.addEventListener('beforeinput',()=>{edits++;});
  const event=new Event('beforeinput',{cancelable:true});window.dispatchEvent(event);
  assert.equal(event.defaultPrevented,true);
  assert.equal(edits,0);
});

test('inspection keeps Tab navigation and Escape clears the target',()=>{
  const {window,active,messages}=fixture();active(true);
  const tab=keyEvent('Tab');window.dispatchEvent(tab);assert.equal(tab.defaultPrevented,false);
  const escape=keyEvent('Escape');window.dispatchEvent(escape);assert.equal(escape.defaultPrevented,true);
  assert.equal(messages.at(-1).action,'clearSelection');
});

test('leaving inspection restores the original card behavior',()=>{
  const {window,active}=fixture();active(true);active(false);let changes=0;
  window.addEventListener('pointerdown',()=>{changes++;},true);
  const event=new Event('pointerdown',{cancelable:true});window.dispatchEvent(event);
  assert.equal(event.defaultPrevented,false);assert.equal(changes,1);
});

function hostFixture(){
  const window=new EventTarget(),document=new EventTarget();
  const module={exports:{}};
  class LitElement extends EventTarget{
    disconnectedCallback(){}
    get updateComplete(){return Promise.resolve();}
    querySelectorAll(){return [];}
    querySelector(){return null;}
  }
  const imports={
    lit:{LitElement,html:()=>{},nothing:null},
    'lit/decorators.js':{customElement:()=>value=>value},
    '../i18n.ts':{t:key=>key},
    '../utils/view-transition.ts':{isViewTransitionActive:()=>true},
  };
  const source=fs.readFileSync(new URL('../chat-ui/ui/src/ui/components/oc-dashboard.ts',import.meta.url),'utf8');
  const compiled=transformSync(source,{loader:'ts',format:'cjs',target:'es2022',tsconfigRaw:{compilerOptions:{experimentalDecorators:true}}}).code;
  vm.runInNewContext(compiled,{
    module,exports:module.exports,require:name=>imports[name]??{},window,document,
    matchMedia:()=>({matches:true}),localStorage:{getItem:()=>null,setItem(){}},crypto:globalThis.crypto,
    setTimeout,clearTimeout,setInterval,clearInterval,cancelAnimationFrame(){},
  });
  const host=new module.exports.OcDashboard();
  const card={id:'quick-notes',title:'Notes',kind:'html',layout:{w:6,h:300,order:0},taskLinks:[]};
  host.boards=[{id:'A',title:'Board A',cards:[structuredClone(card)],archived:false},{id:'B',title:'Board B',cards:[structuredClone(card)],archived:false}];
  host.selected='A';host.connected=true;
  return {host};
}

test('automatic board fallback clears the previous board element target and open template library',async()=>{
  const {host}=hostFixture();host.editing=true;host.libraryOpen=true;
  host.selection={cardId:'quick-notes',cardTitle:'A notes',selector:'#text',tagName:'textarea',text:'Board A content'};
  host.client={request:async()=>({revision:2,boards:[host.boards[1]]})};
  await host.load(true);
  assert.equal(host.selected,'B');
  assert.equal(host.selection,null,'a shared template card ID must not transfer element selection to the fallback board');
  assert.equal(host.editing,false);assert.equal(host.libraryOpen,false);
});

test('the final queued layout survives navigation while an earlier layout save is still pending',async()=>{
  const {host}=hostFixture(),requests=[];let releaseFirst;
  host.client={request:(method,params)=>{
    requests.push({method,params});
    if(requests.length===1)return new Promise(resolve=>{releaseFirst=()=>resolve({board:{id:'A'}});});
    return Promise.resolve({board:{id:'A'}});
  }};
  host.saveLayout();
  host.boards[0].cards[0].layout.h=400;host.saveLayout();
  host.disconnectedCallback();releaseFirst();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,2,'the second user layout must be persisted after the first request settles');
  assert.equal(requests[1].params.boardId,'A');
  assert.equal(requests[1].params.layouts[0].h,400);
});

test('each board keeps its final pending layout when another board is edited during a save',async()=>{
 const {host}=hostFixture(),requests=[];let releaseFirst;
 host.client={request:(method,params)=>{if(method.endsWith('.list'))return Promise.resolve({unchanged:true});requests.push(params);if(requests.length===1)return new Promise(resolve=>releaseFirst=()=>resolve({board:{id:'A'}}));return Promise.resolve({board:{id:params.boardId}});}};
 host.saveLayout();host.boards[0].cards[0].layout.h=400;host.saveLayout();host.selected='B';host.boards[1].cards[0].layout.h=500;host.saveLayout();releaseFirst();
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(requests.map(p=>[p.boardId,p.layouts[0].h]),[['A',300],['A',400],['B',500]]);
});

test('a parent dashboard update leaves its nested template library modal open',()=>{
  const {host}=hostFixture();host.libraryOpen=true;
  host.resizeObserver={observe(){}};host.visibilityObserver={observe(){},unobserve(){}};
  let closed=0;
  const libraryDialog={open:true,close(){closed++;}},ownDialog={open:false};
  host.querySelector=selector=>selector==='dialog'?libraryDialog:selector.includes('dashboard-dialog')?ownDialog:null;
  host.updated(new Map());
  assert.equal(closed,0,'the dashboard must manage its own details dialog, not close a child library/task dialog');
});

function storeFixture(t){
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-review-'));
  const store=createDashboardStore({stateDir,secret:Buffer.alloc(32,1)});
  t.after(()=>{store.close();fs.rmSync(stateDir,{recursive:true,force:true});});
  return {store,stateDir};
}

test('template creation and addition remain idempotent at the card capacity boundary',async t=>{
  const {store}=storeFixture(t),args={action:'create_template',templateId:'productivity'};
  const first=await store.execute(args,undefined,'create-request');
  assert.equal((await store.execute(args,undefined,'create-request')).board.id,first.board.id);
  assert.equal((await store.list()).boards.length,1);
  const add={action:'add_template',templateId:'quick-notes',boardId:first.board.id};
  const added=await store.execute(add,undefined,'add-request');
  await store.setState(first.board.id,'quick-notes',{text:'original card'});
  assert.equal(await store.getState(first.board.id,added.cardId),null,'a copied template must start with independent state');
  while((await store.list()).boards[0].cards.length<24)await store.execute(add);
  assert.equal((await store.execute(add,undefined,'add-request')).cardId,added.cardId,'a transport retry must work even after the board reaches capacity');
  assert.equal((await store.list()).boards[0].cards.length,24);
  await assert.rejects(store.execute(add),/Card limit reached/);
});

test('template preview SDK state is local and creates no persistent dashboard',async t=>{
  const {store,stateDir}=storeFixture(t),preview=await store.templates({templateId:'quick-notes'});
  const window={};
  const runtime=preview.html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(runtime,{window,matchMedia:()=>({matches:false}),document:{hidden:false},addEventListener(){},structuredClone,
    parent:{postMessage(){throw Error('preview attempted a parent mutation');}},fetch(){throw Error('preview attempted a network request');}});
  await window.cryoclawDashboard.setState({text:'preview only'});
  assert.deepEqual(await window.cryoclawDashboard.getState(),{text:'preview only'});
  assert.equal(fs.existsSync(path.join(stateDir,'cryoclaw-dashboards')),false);
  assert.deepEqual((await store.list()).boards,[]);
});
