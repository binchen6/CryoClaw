"use strict";

// Serialized into the renderer; keep this function independent of Node and module state.
async function waitForVisualReady({paceMs=0,timeoutMs=8000,pollMs=100}={}) {
  const started=Date.now(),end=started+timeoutMs;
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function bounded(promise,label) {
    let timer;
    try {
      return await Promise.race([promise,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error(`UI readiness timed out: ${label}`)),Math.max(0,end-Date.now()));
      })]);
    } finally {clearTimeout(timer);}
  }
  await bounded(document.fonts.ready,'fonts');
  await bounded(document.querySelector('openclaw-app')?.updateComplete,'render');
  // Chromium may leave finished pending even after the new DOM is committed.
  await bounded(window.__smokeTransition?.updateCallbackDone,'transition content');
  let previous,stable=0;
  const observations=[];
  const animationEvidence=animation=>{
    const effect=animation.effect,timing=effect?.getComputedTiming(),target=effect?.target;
    return {name:animation.animationName??animation.transitionProperty??animation.id??'',
      target:target?`${target.tagName??''}${target.id?'#'+target.id:''}${typeof target.className==='string'?'.'+target.className.trim().replace(/\s+/g,'.'):''}`.slice(0,200):null,
      pseudo:effect?.pseudoElement??null,state:animation.playState,pending:animation.pending===true,
      currentTime:typeof animation.currentTime==='number'?animation.currentTime:null,
      localTime:timing?.localTime??null,duration:timing?.duration??null,iterations:timing?.iterations??null};
  };
  while(stable<3) {
    if(Date.now()>=end)throw Error('UI readiness timed out: layout or animation still changing; '+JSON.stringify({
      visibility:document.visibilityState??'unknown',focused:document.hasFocus?.()??null,observations,
    }));
    const elements=[...document.querySelectorAll('.cryoclaw-content,.oc-settings-content,.oc-rail,[data-confirm-dialog],.cm-detail')];
    const snapshot=JSON.stringify(elements.filter(el=>el.checkVisibility({visibilityProperty:true})).map(el=>{
      const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
      return [rect.x,rect.y,rect.width,rect.height,el.scrollWidth,el.scrollHeight,style.opacity,style.transform];
    }));
    const movingAnimations=document.getAnimations().filter(animation=>
      (animation.playState==='running' || animation.pending) && animation.effect?.getComputedTiming().iterations!==Infinity);
    const moving=movingAnimations.length>0;
    observations.push({atMs:Date.now()-started,layout:JSON.parse(snapshot),moving:movingAnimations.slice(0,8).map(animationEvidence),movingCount:movingAnimations.length});
    if(observations.length>3)observations.shift();
    stable=!moving && snapshot===previous?stable+1:1;
    if(moving)stable=0;
    previous=snapshot;
    if(stable<3)await delay(pollMs);
  }
  if(paceMs)await bounded(delay(paceMs),'operation pace');
  await bounded(document.querySelector('openclaw-app')?.updateComplete,'final render');
}

module.exports={waitForVisualReady};
