import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {viewportScript} from '../builtin-plugins/cryoclaw-dashboards/viewport.mjs';

test('card viewport reports real sizes and coalesces a resize burst without losing the latest size',()=>{
 const events=new Map(),frames=new Map();let id=0;
 const scope=vm.createContext({Object,Set,innerWidth:360,innerHeight:300,addEventListener:(name,fn)=>events.set(name,fn),requestAnimationFrame:fn=>{frames.set(++id,fn);return id},cancelAnimationFrame:key=>frames.delete(key)});
 vm.runInContext(viewportScript()+';globalThis.api=viewport;',scope);
 const sizes=[],unsubscribe=scope.api.subscribe(size=>sizes.push({width:size.width,height:size.height}));
 assert.deepEqual(sizes,[{width:360,height:300}]);
 scope.innerWidth=800;events.get('resize')();scope.innerWidth=1440;scope.innerHeight=850;events.get('resize')();
 assert.equal(frames.size,1);const tick=frames.values().next().value;frames.clear();tick();
 assert.deepEqual(sizes.at(-1),{width:1440,height:850});assert.equal(scope.api.width,1440);
 unsubscribe();scope.innerWidth=320;events.get('resize')();const last=frames.values().next().value;frames.clear();last();assert.equal(sizes.length,2);
 events.get('pagehide')();assert.equal(frames.size,0);
});

test('a failing subscriber cannot stop other cards resize work',()=>{
 const events=new Map();let tick;
 const scope=vm.createContext({Object,Set,innerWidth:400,innerHeight:300,addEventListener:(name,fn)=>events.set(name,fn),requestAnimationFrame:fn=>{tick=fn;return 1},cancelAnimationFrame(){}});
 vm.runInContext(viewportScript()+';globalThis.api=viewport;',scope);
 let count=0;scope.api.subscribe(()=>{if(count)throw Error('widget callback')});scope.api.subscribe(()=>count++);
 events.get('resize')();tick();assert.equal(count,2);
});
