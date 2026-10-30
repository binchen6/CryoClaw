const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const {createCoreResolutionMemo,installCoreResolutionCache}=require('../shared/gateway-core-resolution-cache.cjs');
const root='file:///C:/app/openclaw/dist/',names=['a-12345678.mjs','b-12345678.mjs','shared-12345678.mjs'];
const context=parent=>({parentURL:root+parent,conditions:['node','import','module-sync','node-addons'],importAttributes:{}});
test('core resolution reuses only identical canonical native results',()=>{
 const memo=createCoreResolutionMemo({rootUrl:root,coreNames:names});let calls=0;
 const native=(specifier,ctx)=>{calls++;return {url:new URL(specifier,ctx.parentURL).href,format:'module'}};
 memo.resolve('./shared-12345678.mjs',context(names[0]),native);memo.resolve('./shared-12345678.mjs',context(names[1]),native);
 assert.equal(calls,1);assert.equal(memo.counters.crossParentHits,1);memo.invalidate();memo.resolve('./shared-12345678.mjs',context(names[1]),native);assert.equal(calls,2);
});
test('manifest hits bypass native stat only for exact packaged modules',()=>{
 const memo=createCoreResolutionMemo({rootUrl:root,coreNames:names,trustedManifest:true});let calls=0;
 const native=()=>{calls++;return {url:'file:///C:/else/shared-12345678.mjs',format:'module'}};
 const hit=memo.resolve('./shared-12345678.mjs',context(names[0]),native);
 assert.equal(hit.url,root+'shared-12345678.mjs');assert.equal(hit.format,'module');assert.equal(calls,0);assert.equal(memo.counters.manifestHits,1);
 memo.resolve('./missing-12345678.mjs',context(names[0]),native);assert.equal(calls,1);
 memo.resolve('./shared-12345678.mjs',{...context(names[0]),importAttributes:{type:'json'}},native);assert.equal(calls,2);
});
test('external, custom and failed resolutions always pass through',()=>{
 const memo=createCoreResolutionMemo({rootUrl:root,coreNames:names});let calls=0;const next=()=>{calls++;return {url:'file:///C:/else/shared-12345678.mjs',format:'module'}};
 for(const [specifier,ctx]of [['./shared-12345678.mjs',{...context(names[0]),parentURL:'file:///C:/user/plugin/index.mjs'}],['openclaw/plugin-sdk',context(names[0])],['./other-12345678.mjs',context(names[0])],['./shared-12345678.mjs',{...context(names[0]),conditions:['@zod/source']}],['./shared-12345678.mjs',{...context(names[0]),importAttributes:{type:'json'}}]])memo.resolve(specifier,ctx,next);
 assert.equal(calls,5);const fail=()=>{calls++;throw Error('ENOENT')};assert.throws(()=>memo.resolve('./shared-12345678.mjs',context(names[0]),fail));assert.throws(()=>memo.resolve('./shared-12345678.mjs',context(names[0]),fail));assert.equal(calls,7);
});
test('later owner hooks retain preparation and admission on cache hits',async t=>{
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'cryo-resolution-')),dist=path.join(fixture,'dist');fs.mkdirSync(dist);
 const shared='shared-12345678.mjs',a='a-12345678.mjs',b='b-12345678.mjs';
 fs.writeFileSync(path.join(dist,shared),'globalThis.__cryoResolutionEvaluations=(globalThis.__cryoResolutionEvaluations??0)+1;export const value=globalThis.__cryoResolutionEvaluations;');
 for(const name of [a,b])fs.writeFileSync(path.join(dist,name),`export {value} from './${shared}';`);
 const instance=installCoreResolutionCache(fixture);let later,before=0,after=0;
 t.after(()=>{later?.deregister();instance?.deregister();fs.rmSync(fixture,{recursive:true,force:true});delete globalThis.__cryoResolutionEvaluations;});
 assert.ok(instance);later=Module.registerHooks({resolve(specifier,context,next){const target=specifier==='./'+shared;if(target)before++;const resolved=next(specifier,context);if(target)after++;return resolved;}});
 const base=require('node:url').pathToFileURL(dist+path.sep).href,left=await import(new URL(a,base)),right=await import(new URL(b,base));
 assert.equal(left.value,1);assert.equal(right.value,1);assert.equal(before,2);assert.equal(after,2);assert.equal(instance.memo.counters.manifestHits,2);
});
