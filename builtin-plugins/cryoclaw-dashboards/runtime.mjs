import {inspectorScript} from './inspector.mjs';
import {viewportScript,responsiveStyle} from './viewport.mjs';
/** The iframe never receives gateway credentials or arbitrary RPC access. */
export function runtimeScript(){return `<style>html[data-cryoclaw-paused] *,html[data-cryoclaw-paused] *::before,html[data-cryoclaw-paused] *::after{animation-play-state:paused!important} @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}</style><script>(()=>{
const endpoint=new URL(location.href),pending=new Map(),prefix=Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-'),motionListeners=new Set(),media=matchMedia('(prefers-reduced-motion: reduce)');let sequence=0,visible=parent===window,directRequests=0;
${viewportScript()}
const motion=Object.freeze({get active(){return visible&&!document.hidden},get reduced(){return media.matches},frame,animate,subscribe(fn){if(typeof fn!=='function')throw Error('Expected a motion callback');motionListeners.add(fn);fn({active:motion.active,reduced:motion.reduced});return()=>motionListeners.delete(fn);}});
function frame(draw,{fps=30}={}){
 if(typeof draw!=='function'||!Number.isFinite(fps)||fps<1||fps>60)throw Error('Use a frame callback and 1–60 fps');
 let raf=0,last=-Infinity,closed=false;
 const tick=time=>{raf=0;if(closed||!motion.active||motion.reduced)return;if(time-last>=1000/fps){last=time;draw(time);}raf=requestAnimationFrame(tick);};
 const update=()=>{if(raf)cancelAnimationFrame(raf);raf=0;if(closed||!motion.active)return;if(motion.reduced){draw(performance.now());return;}last=-Infinity;raf=requestAnimationFrame(tick);};
 const unsubscribe=motion.subscribe(update),stop=()=>{if(closed)return;closed=true;unsubscribe();if(raf)cancelAnimationFrame(raf);raf=0;removeEventListener('pagehide',stop);};
 addEventListener('pagehide',stop,{once:true});return stop;
}
function animate(target,keyframes,options={}){
 if(!target||typeof target.animate!=='function')throw Error('Expected an animatable element');
 if(motion.reduced){const animation=target.animate(keyframes,{...options,duration:0,iterations:1,fill:'both'});animation.finish();return animation;}
 const animation=target.animate(keyframes,{duration:240,easing:'cubic-bezier(.2,.8,.2,1)',...options});
 const update=()=>{if(motion.active){if(animation.playState==='paused')animation.play();}else if(animation.playState==='running')animation.pause();};
 const unsubscribe=motion.subscribe(update),clear=()=>{unsubscribe();removeEventListener('pagehide',cancel);},cancel=()=>{clear();animation.cancel();};
 addEventListener('pagehide',cancel,{once:true});animation.finished.then(clear,clear);update();return animation;
}
function updateMotion(active=visible){visible=active;document.documentElement.toggleAttribute('data-cryoclaw-paused',!motion.active||motion.reduced);for(const fn of motionListeners)try{fn({active:motion.active,reduced:motion.reduced});}catch{}}
media.addEventListener('change',()=>updateMotion());addEventListener('visibilitychange',()=>updateMotion());updateMotion();
function request(action,value){
 if(action==='setState'&&JSON.stringify(value)?.length>32768)return Promise.reject(Error('Card state exceeds 32 KiB'));
 if(action==='data'&&(typeof value!=='string'||!/^[-a-zA-Z0-9_]{1,64}$/.test(value)))return Promise.reject(Error('Invalid source ID'));
 if(parent===window){if(directRequests>=4)return Promise.reject(Error('Card requests are busy'));directRequests++;const url=new URL(endpoint);url.searchParams.set('api',action);if(action==='data')url.searchParams.set('id',value);return fetch(url,{method:action==='setState'?'POST':'GET',headers:action==='setState'?{'Content-Type':'text/plain;charset=UTF-8'}:{},body:action==='setState'?JSON.stringify(value):undefined,credentials:'omit'}).then(async r=>{const data=await r.json();if(!r.ok)throw Error(data.error||'Card operation failed');return data;}).finally(()=>{directRequests--;});}
 if(pending.size>=16)return Promise.reject(Error('Too many pending card requests'));
 const requestId=prefix+':'+(++sequence);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Card operation timed out'));},20000);pending.set(requestId,{resolve,reject,timer});parent.postMessage({type:'cryoclaw:dashboard',action,requestId,value},'*');});
}
${inspectorScript()}
addEventListener('message',e=>{if(e.source!==parent)return;if(e.data?.type==='cryoclaw:dashboard:inspect'){updateInspector(e.data.active,e.data.selector,e.data.color);return;}if(e.data?.type==='cryoclaw:dashboard:visibility'){updateMotion(e.data.active===true);return;}if(e.data?.type!=='cryoclaw:dashboard:result')return;const p=pending.get(e.data.requestId);if(!p)return;clearTimeout(p.timer);pending.delete(e.data.requestId);e.data.error?p.reject(Error(e.data.error)):p.resolve(e.data.value);});
const control=action=>{if(parent===window){if(action==='refresh')location.reload();return;}parent.postMessage({type:'cryoclaw:dashboard',action},'*');};
// The card is an opaque sandbox whose root ignores user scrolling, so a wheel over card
// content would die here instead of scrolling the board. Hand unhandled deltas to the host.
function scrollableInDirection(target,deltaY){
 const root=document.scrollingElement||document.documentElement,userScroll=/^(auto|scroll|overlay)$/;
 for(let element=target instanceof Element?target:null;element&&element!==root;element=element.parentElement){
  if(!userScroll.test(getComputedStyle(element).overflowY)||element.scrollHeight-element.clientHeight<=1)continue;
  if(deltaY>0?element.scrollTop+element.clientHeight<element.scrollHeight-1:element.scrollTop>1)return true;
 }
 if(userScroll.test(getComputedStyle(root).overflowY)){if(deltaY>0?root.scrollTop+root.clientHeight<root.scrollHeight-1:root.scrollTop>1)return true;}
 return false;
}
if(parent!==window){
 let pendingWheel=null,wheelFrame=0;
 const flushWheel=()=>{wheelFrame=0;const pending=pendingWheel;pendingWheel=null;if(pending&&pending.dy)parent.postMessage({type:'cryoclaw:dashboard',action:'wheel',value:pending},'*');};
 addEventListener('wheel',event=>{
  if(event.ctrlKey||event.defaultPrevented)return;
  const scale=event.deltaMode===1?16:event.deltaMode===2?innerHeight:1,deltaY=event.deltaY*scale;
  if(!Number.isFinite(deltaY)||!deltaY||scrollableInDirection(event.target,deltaY))return;
  event.preventDefault();
  pendingWheel=pendingWheel||{dy:0};
  pendingWheel.dy+=Math.max(-1200,Math.min(1200,deltaY));
  if(!wheelFrame)wheelFrame=requestAnimationFrame(flushWheel);
 },{passive:false});
 addEventListener('pagehide',()=>{if(wheelFrame)cancelAnimationFrame(wheelFrame);wheelFrame=0;pendingWheel=null;},{once:true});
}
Object.defineProperty(window,'cryoclawDashboard',{value:Object.freeze({version:2,motion,viewport,getState:()=>request('getState'),setState:value=>request('setState',value),data:id=>request('data',id),system:()=>request('system'),asset:id=>{const url=new URL(endpoint);url.searchParams.set('api','asset');url.searchParams.set('id',id);return url.href;},refresh:()=>control('refresh'),expand:()=>control('expand'),collapse:()=>control('collapse'),compose:prompt=>{if(parent===window||!navigator.userActivation.isActive||typeof prompt!=='string'||!prompt.trim()||prompt.length>2000)return false;parent.postMessage({type:'cryoclaw:dashboard',action:'compose',value:prompt},'*');return true;},tasks:()=>{if(parent===window||!navigator.userActivation.isActive)return false;control('tasks');return true;},openLink:url=>{if(!navigator.userActivation.isActive)return;if(parent===window)window.open(url,'_blank','noopener,noreferrer');else parent.postMessage({type:'cryoclaw:dashboard',action:'openLink',value:url},'*');}})});
addEventListener('keydown',e=>{if(e.key==='Escape')control('collapse');});
})();<\/script>`;}
export function injectRuntime(html){const script=runtimeScript();const styled=/<\/head\s*>/i.test(html)?html.replace(/<\/head\s*>/i,responsiveStyle+'$&'):html+responsiveStyle;if(/<head(?:\s[^>]*)?>/i.test(styled))return styled.replace(/<head(?:\s[^>]*)?>/i,match=>match+script);if(/<!doctype[^>]*>/i.test(styled))return styled.replace(/<!doctype[^>]*>/i,match=>match+script);return '<!doctype html>'+script+styled;}
