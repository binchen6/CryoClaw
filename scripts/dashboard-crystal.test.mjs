import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {crystalFieldScript} from '../builtin-plugins/cryoclaw-dashboards/crystal.mjs';

function fixture(){
 const listeners=new Map(),context={arcs:[],clears:0},frames=[],motionCallbacks=[];
 let layoutReads=0,stopCount=0,disconnectCount=0;
 const ctx={setTransform(){},clearRect(){context.arcs=[];context.clears++;},beginPath(){},moveTo(){},lineTo(){},stroke(){},closePath(){},fill(){},arc(x,y,radius){if(radius<6)context.arcs.push({x,y});}};
 const canvas={width:0,height:0,get clientWidth(){layoutReads++;return 600;},get clientHeight(){layoutReads++;return 300;},getBoundingClientRect(){layoutReads++;return {left:160,top:20,width:600,height:300};},getContext:()=>ctx};
 const motion={active:true,reduced:false,frame(fn){frames.push(fn);return()=>stopCount++;},subscribe(fn){motionCallbacks.push(fn);fn({active:motion.active,reduced:motion.reduced});return()=>{};}};
 vm.runInNewContext(crystalFieldScript,{window:{cryoclawDashboard:{motion}},document:{querySelector:selector=>selector==='.cryo-field'?canvas:null},devicePixelRatio:1,innerWidth:800,innerHeight:400,
  performance:{now:()=>0},ResizeObserver:class{observe(){}disconnect(){disconnectCount++;}},requestAnimationFrame:fn=>{fn(0);return 1;},cancelAnimationFrame(){},
  addEventListener:(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn)});
 return {context,motion,frames,get layoutReads(){return layoutReads;},get stopCount(){return stopCount;},get disconnectCount(){return disconnectCount;},
  draw:time=>frames[0](time),event:(name,event={})=>{for(const fn of listeners.get(name)??[])fn(event);},
  visibility:(active,reduced=false)=>{motion.active=active;motion.reduced=reduced;for(const fn of motionCallbacks)fn({active,reduced});}};
}

test('crystal drawing caches geometry instead of reading layout on each frame',()=>{
 const f=fixture(),reads=f.layoutReads;
 for(let i=0;i<80;i++)f.draw(1000);
 assert.equal(f.context.arcs.length,32);assert.equal(f.layoutReads,reads);
});
test('crystals respond near the pointer and gently return when it leaves',()=>{
 const f=fixture();for(let i=0;i<100;i++)f.draw(1000);const before=structuredClone(f.context.arcs);
 f.event('pointermove',{clientX:640,clientY:180,pointerType:'mouse'});
 for(let i=0;i<90;i++)f.draw(1000);
 assert.ok(f.context.arcs.some((point,i)=>Math.hypot(point.x-before[i].x,point.y-before[i].y)>2));
 f.event('pointerout',{relatedTarget:null});for(let i=0;i<300;i++)f.draw(1000);
 assert.ok(f.context.arcs.every((point,i)=>Math.hypot(point.x-before[i].x,point.y-before[i].y)<.3));
});
test('offscreen and reduced-motion states stop interaction, and pagehide cleans up',()=>{
 const f=fixture();f.visibility(false);const before=f.context.clears;f.draw(1000);assert.equal(f.context.clears,before);
 f.visibility(true,true);f.draw(1000);const reduced=structuredClone(f.context.arcs);
 f.event('pointermove',{clientX:640,clientY:180,pointerType:'mouse'});for(let i=0;i<30;i++)f.draw(1000);
 assert.deepEqual(f.context.arcs,reduced);
 f.event('pagehide');assert.equal(f.stopCount,1);assert.equal(f.disconnectCount,1);
});
