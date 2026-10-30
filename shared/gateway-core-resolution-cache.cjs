'use strict';
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const ALLOWED_CONDITIONS=new Set(['node','import','require','module-sync','node-addons','default']);
// The installed core is replaced only with a process restart. Exact manifest hits
// avoid native stat storms; custom or external resolutions retain native behavior.
function createCoreResolutionMemo({rootUrl,coreNames,trustedManifest=false}){
 const base=new URL(rootUrl),names=new Set(coreNames),requests=new Map(),targets=new Map();let generation=0;
 const counters={misses:0,exactHits:0,crossParentHits:0,passThrough:0,manifestHits:0};
 function invalidate(){generation++;requests.clear();targets.clear();}
 function identify(specifier,context){
  if(typeof specifier!=='string'||!/^\.\/[A-Za-z0-9_.-]+\.mjs$/.test(specifier)||!names.has(specifier.slice(2)))return;
  if(!Array.isArray(context.conditions)||context.conditions.some(condition=>!ALLOWED_CONDITIONS.has(condition)))return;
  const attributes=Object.entries(context.importAttributes??{});if(attributes.length)return;
  let parent;try{parent=new URL(context.parentURL);}catch{return;}
  if(parent.protocol!=='file:'||parent.search||parent.hash||new URL('.',parent).href!==base.href)return;
  let parentName;try{parentName=decodeURIComponent(parent.pathname.slice(parent.pathname.lastIndexOf('/')+1));}catch{return;}
  if(!names.has(parentName))return;
  const target=new URL(specifier,parent);if(new URL('.',target).href!==base.href)return;
  return {target:target.href,key:JSON.stringify([generation,context.parentURL,specifier,context.conditions,attributes]),shared:JSON.stringify([generation,target.href,context.conditions,attributes])};
 }
 function resolve(specifier,context,nextResolve){
  const match=identify(specifier,context);if(!match){counters.passThrough++;return nextResolve(specifier,context);}
  if(trustedManifest){counters.manifestHits++;return {url:match.target,format:'module',shortCircuit:true};}
  const exact=requests.get(match.key);if(exact){counters.exactHits++;return {...exact,shortCircuit:true};}
  const shared=targets.get(match.shared);if(shared){counters.crossParentHits++;requests.set(match.key,shared);return {...shared,shortCircuit:true};}
  counters.misses++;const resolved=nextResolve(specifier,context);
  if(resolved?.url===match.target&&resolved.format==='module'){
   const cached=Object.freeze({...resolved});requests.set(match.key,cached);targets.set(match.shared,cached);
  }
  return resolved;
 }
 return Object.freeze({resolve,invalidate,counters,identify});
}
const INSTANCE=Symbol.for('cryoclaw.gateway.core-resolution-cache');
function installCoreResolutionCache(packageRoot,{registerHooks}={}){
 if(!packageRoot||process.env.CRYOCLAW_DISABLE_CORE_RESOLUTION_CACHE==='1')return null;
 if(globalThis[INSTANCE])return globalThis[INSTANCE];
 const register=registerHooks??require('node:module').registerHooks;if(typeof register!=='function')return null;
 const dist=path.join(packageRoot,'dist'),coreNames=fs.readdirSync(dist).filter(name=>/\.m?js$/.test(name));
 if(!coreNames.some(name=>name.endsWith('.mjs')))return null;
 const memo=createCoreResolutionMemo({rootUrl:pathToFileURL(dist+path.sep).href,coreNames,trustedManifest:process.env.CRYOCLAW_CORE_RESOLUTION_MANIFEST!=='0'});
 const hooks=register({resolve:memo.resolve});
 globalThis[INSTANCE]=Object.freeze({memo,hooks,deregister:()=>{hooks.deregister();delete globalThis[INSTANCE];}});
 return globalThis[INSTANCE];
}
module.exports={createCoreResolutionMemo,installCoreResolutionCache};
