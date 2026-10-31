import test from 'node:test';
import assert from 'node:assert/strict';
import {transitionView,isViewTransitionActive} from './view-transition.ts';

test('route navigation applies synchronously without a document snapshot blocking controls',()=>{
 const previous=globalThis.document,previousWindow=globalThis.window;let actions=0,snapshots=0;
 try{Object.assign(globalThis,{window:{matchMedia:()=>({matches:false})},document:{startViewTransition(){snapshots++;return {finished:Promise.resolve(),skipTransition(){}};}}});transitionView(()=>actions++);assert.equal(actions,1);assert.equal(snapshots,0);}
 finally{Object.assign(globalThis,{document:previous,window:previousWindow});}
});
test('navigation retires an existing snapshot and keeps the action even if cleanup fails',()=>{
 const previous=globalThis.document;let skipped=0,actions=0;
 try{Object.assign(globalThis,{document:{activeViewTransition:{skipTransition(){skipped++;throw Error('already gone');}}}});transitionView(()=>actions++);assert.equal(skipped,1);assert.equal(actions,1);}
 finally{Object.assign(globalThis,{document:previous});}
});
test('rapid navigation keeps every latest action without waiting for animations',()=>{
 const previous=globalThis.document,actions:number[]=[];
 try{Object.assign(globalThis,{document:{}});transitionView(()=>actions.push(1));transitionView(()=>actions.push(2));assert.deepEqual(actions,[1,2]);}
 finally{Object.assign(globalThis,{document:previous});}
});
test('component motion observes actual native transition activity',()=>{
 const previous=globalThis.document;
 try{Object.assign(globalThis,{document:{documentElement:{matches:(selector:string)=>selector===':active-view-transition'}}});assert.equal(isViewTransitionActive(),true);Object.assign(globalThis,{document:{}});assert.equal(isViewTransitionActive(),false);}
 finally{Object.assign(globalThis,{document:previous});}
});

test('top-level and tab navigation share forward/back direction rules',()=>{
 const previous=globalThis.document;
 const app={settings:{cryoclawView:'chat'}};
 const settingsTabs=[0,1].map(()=>({classList:{contains:()=>false as boolean}}));
 const taskTabs=[0,1].map(()=>({getAttribute:()=> 'false' as string}));
 const documentElement={dataset:{} as Record<string,string>};
 try{
  Object.assign(globalThis,{document:{documentElement,querySelector:(selector:string)=>selector==='openclaw-app'?app:null,querySelectorAll:(selector:string)=>selector==='.oc-settings-nav-item'?settingsTabs:taskTabs}});
  transitionView(()=>{app.settings.cryoclawView='tasks';});
  assert.equal(documentElement.dataset.navigationDirection,'forward');
  transitionView(()=>{app.settings.cryoclawView='chat';});
  assert.equal(documentElement.dataset.navigationDirection,'back');
  app.settings.cryoclawView='settings';
  settingsTabs[0].classList.contains=()=>true;
  transitionView(()=>{settingsTabs[0].classList.contains=()=>false;settingsTabs[1].classList.contains=()=>true;});
  assert.equal(documentElement.dataset.navigationDirection,'forward');
  transitionView(()=>{settingsTabs[1].classList.contains=()=>false;settingsTabs[0].classList.contains=()=>true;});
  assert.equal(documentElement.dataset.navigationDirection,'back');
  app.settings.cryoclawView='tasks';
  taskTabs[0].getAttribute=()=> 'true';
  transitionView(()=>{taskTabs[0].getAttribute=()=> 'false';taskTabs[1].getAttribute=()=> 'true';});
  assert.equal(documentElement.dataset.navigationDirection,'forward');
 }finally{Object.assign(globalThis,{document:previous});}
});

test('workspace and extension peer tabs use selected data-page-nav position',()=>{
 const previous=globalThis.document;
 const app={settings:{cryoclawView:'workspace'}};
 const tabs=['files','git'].map(id=>({selected:id==='files',getAttribute(name:string){
  if(name==='data-page-nav')return `workspace:${id}`;
  if(name==='aria-selected')return this.selected?'true':'false';
  return '';
 }}));
 const documentElement={dataset:{} as Record<string,string>};
 try{
  Object.assign(globalThis,{document:{documentElement,querySelector:()=>app,querySelectorAll:()=>tabs}});
  transitionView(()=>{tabs[0].selected=false;tabs[1].selected=true;});
  assert.equal(documentElement.dataset.navigationDirection,'forward');
  transitionView(()=>{tabs[1].selected=false;tabs[0].selected=true;});
  assert.equal(documentElement.dataset.navigationDirection,'back');
 }finally{Object.assign(globalThis,{document:previous});}
});
