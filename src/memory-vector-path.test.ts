import test from 'node:test';import assert from 'node:assert/strict';import {clearMissingLegacyVectorPath} from './memory-vector-path.ts';
const legacy='C:\\old-build\\gateway.asar.unpacked\\node_modules\\sqlite-vec-windows-x64\\vec0.dll';
test('loose runtime drops only a missing former auto-generated vector path',()=>{
 const config={memory:{search:{store:{path:'keep.sqlite',vector:{enabled:true,extensionPath:legacy}}}}};
 assert.equal(clearMissingLegacyVectorPath(config,'C:/app/gateway',()=>false),true);
 assert.deepEqual(config.memory.search.store,{path:'keep.sqlite',vector:{enabled:true}});
});
test('custom paths, usable paths and ASAR installations remain unchanged',()=>{
 for(const [value,root,exists]of [['C:/custom/vec0.dll','C:/app/gateway',false],[legacy,'C:/app/gateway',true],[legacy,'C:/app/gateway.asar',false]] as const){const config={memory:{search:{store:{vector:{extensionPath:value}}}}};assert.equal(clearMissingLegacyVectorPath(config,root,()=>exists),false);assert.equal(config.memory.search.store.vector.extensionPath,value);}
});
