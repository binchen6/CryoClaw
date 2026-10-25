'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {arg,waitForPageTarget,connect,waitForAppReady,dismissReleaseNotes,sleep}=require('./lib/cdp-harness');
const {recordQaFixtures}=require('./lib/qa-fixtures');

function analyzeTrace(trace){
 const samples=trace.samples??[],issues=new Set(),last=samples.at(-1);
 const fail=(condition,name)=>{if(condition)issues.add(name);};
 fail(!last,'noFrameSamples');fail(trace.timedOut,'animationDidNotSettle');
 for(const sample of samples){
  fail(!sample.cardSame||!sample.cardConnected,'cardIdentityChanged');
  fail(!sample.visible||!sample.contentVisible,'contentDisappeared');
  fail(sample.reason==='raf'&&!sample.hitCard,'cardOccluded');
  fail(sample.phase==='close'&&sample.morphing&&!sample.topLayer,'closeLeftTopLayerEarly');
  fail(sample.phase==='open'&&sample.reason==='raf'&&sample.morphing&&!sample.topLayer,'openNotInTopLayer');
  if(trace.hasFrame){
   fail(!sample.iframeSame,'iframeIdentityChanged');fail(!sample.iframeWindowSame,'iframeWindowChanged');
   fail(!sample.iframeSrcSame,'iframeSourceChanged');fail(sample.frameLoads>0,'iframeReloaded');
  }
 }
 fail(trace.hasFrame&&trace.documentPreserved===false,'iframeDocumentReloaded');
 if(last){
  fail(Boolean(last.hostExpanded)!==Boolean(trace.expectedExpanded),'wrongFinalExpandedState');
  fail(trace.expectedExpanded?!last.topLayer:last.topLayer,trace.expectedExpanded?'expandedNotInTopLayer':'topLayerNotClosed');
  if(!trace.expectedExpanded){
   fail(trace.originScrollTop!==undefined&&Math.abs(last.scrollTop-trace.originScrollTop)>2,'scrollNotRestored');
   if(trace.originRect)fail(['x','y','width','height'].some(key=>Math.abs(last.rect[key]-trace.originRect[key])>3),'geometryNotRestored');
  }
  const card=last.style?.card,slot=last.style?.slot;
  if(card){
   fail(card.radii.some(value=>parseFloat(value)<=0),'cardCornersNotRounded');
   fail(!['hidden','clip'].includes(card.overflowX)||!['hidden','clip'].includes(card.overflowY),'cardContentNotClipped');
   fail(card.boxShadow==='none'&&(!slot?.boxShadow||slot.boxShadow==='none'),'cardShadowMissing');
  }
  const paintContained=slot&&(/\b(?:paint|content|strict)\b/.test(slot.contain)||['auto','hidden'].includes(slot.contentVisibility));
  fail(card?.boxShadow&&card.boxShadow!=='none'&&paintContained,'slotClipsCardShadow');
  fail(slot&&(slot.overflowX!=='visible'||slot.overflowY!=='visible'),'slotClipsCardShadow');
 }
 const active=samples.filter(sample=>sample.reason==='raf'&&sample.morphing);
 fail(trace.mode==='reduced'&&active.length>0,'reducedMotionAnimated');
 fail(trace.mode!=='reduced'&&active.length<2,'insufficientAnimationSamples');
 const gaps=samples.slice(1).map((sample,index)=>sample.t-samples[index].t);
 return {passed:issues.size===0,issues:[...issues],sampleCount:samples.length,animatedFrames:active.length,
  durationMs:last?.t??0,maxFrameGapMs:Math.max(0,...gaps),closeFrames:active.filter(sample=>sample.phase==='close').length};
}

// Runs in the renderer. References stay here; only booleans, geometry and styles leave the page.
function installProbe(){
 window.__dashboardMorphQa?.destroy();
 const tracked=new Map();let active=null,raf=0;
 const round=value=>Math.round(value*1000)/1000;
 const rect=element=>{const value=element?.getBoundingClientRect();return value?{x:round(value.x),y:round(value.y),width:round(value.width),height:round(value.height)}:null;};
 const css=element=>{if(!element)return null;const value=getComputedStyle(element);return {display:value.display,visibility:value.visibility,opacity:value.opacity,position:value.position,transform:value.transform,
  boxShadow:value.boxShadow,radii:[value.borderTopLeftRadius,value.borderTopRightRadius,value.borderBottomRightRadius,value.borderBottomLeftRadius],overflowX:value.overflowX,overflowY:value.overflowY,
  clipPath:value.clipPath,contain:value.contain,contentVisibility:value.contentVisibility,isolation:value.isolation,zIndex:value.zIndex};};
 const cardFor=id=>[...document.querySelectorAll('oc-dashboard .dashboard-card')].find(card=>card.dataset.cardId===id);
 const track=id=>{
  if(tracked.has(id))return tracked.get(id);
  const card=cardFor(id);if(!card)throw Error('Missing QA card: '+id);
  const frame=card.querySelector('iframe'),entry={card,frame,frameWindow:frame?.contentWindow,frameSrc:frame?.src,loads:0};
  entry.onLoad=()=>{entry.loads++;if(active?.id===id)active.loadEvents.push({t:round(performance.now()-active.started),phase:active.phase});};
  entry.onToggle=event=>{if(active?.id===id)active.toggleEvents.push({t:round(performance.now()-active.started),type:event.type,oldState:event.oldState,newState:event.newState,morphing:Boolean(document.querySelector('oc-dashboard')?.morphing)});};
  frame?.addEventListener('load',entry.onLoad);card.addEventListener('beforetoggle',entry.onToggle);card.addEventListener('toggle',entry.onToggle);
  tracked.set(id,entry);return entry;
 };
 const sample=(state,reason)=>{
  const dashboard=document.querySelector('oc-dashboard'),entry=track(state.id),card=cardFor(state.id),frame=card?.querySelector('iframe'),r=rect(card),style={card:css(card),slot:css(card?.closest('.dashboard-card-slot'))};
  const surface=card?.querySelector('.dashboard-card__surface'),surfaceCss=css(surface),frameCss=css(frame),scroll=document.querySelector('.dashboard-workspace__scroll');
  const area=r&&{left:Math.max(0,r.x),top:Math.max(0,r.y),right:Math.min(innerWidth,r.x+r.width),bottom:Math.min(innerHeight,r.y+r.height)};
  const visible=Boolean(area&&area.right-area.left>1&&area.bottom-area.top>1&&style.card.display!=='none'&&style.card.visibility!=='hidden'&&Number(style.card.opacity)>.01);
  const points=visible?[.3,.5,.7].map(f=>({x:area.left+(area.right-area.left)*f,y:area.top+(area.bottom-area.top)*f})):[];
  const hitCard=points.some(point=>{const hit=document.elementFromPoint(point.x,point.y);return hit===card||card?.contains(hit);});
  const contentVisible=visible&&surfaceCss?.display!=='none'&&surfaceCss?.visibility!=='hidden'&&(!frame||(frameCss.display!=='none'&&frameCss.visibility!=='hidden'&&Number(frameCss.opacity)>.01&&frame.getBoundingClientRect().height>1&&surface?.dataset.framePending!=='true'));
  const animations=card?.getAnimations().filter(animation=>animation.effect?.target===card).map(animation=>{const timing=animation.effect.getComputedTiming();return {playState:animation.playState,currentTime:round(Number(animation.currentTime)||0),duration:timing.duration,progress:timing.progress};})??[];
  const value={t:round(performance.now()-state.started),phase:state.phase,reason,hostExpanded:dashboard?.expanded??'',morphing:Boolean(dashboard?.morphing),morphingCard:dashboard?.morphingCard??'',
   topLayer:Boolean(card?.matches(':popover-open')),popover:card?.getAttribute('popover')??null,cardSame:card===entry.card,cardConnected:Boolean(card?.isConnected),
   iframeSame:frame===entry.frame,iframeWindowSame:frame?.contentWindow===entry.frameWindow,iframeSrcSame:frame?.src===entry.frameSrc,frameLoads:entry.loads-state.initialLoads,
   visible,contentVisible,hitCard,rect:r,slotRect:rect(card?.closest('.dashboard-card-slot')),scrollTop:round(scroll?.scrollTop??0),style,animations};
  state.samples.push(value);return value;
 };
 const snapshot=state=>({id:state.id,mode:state.mode,kind:state.kind,hasFrame:state.hasFrame,expectedExpanded:state.expectedExpanded,originRect:state.originRect,originScrollTop:state.originScrollTop,
  samples:state.samples,toggleEvents:state.toggleEvents,loadEvents:state.loadEvents,timedOut:state.timedOut,done:state.done});
 const perform=(state,operation)=>{
  state.phase=operation==='open'?'open':'close';
  const dashboard=document.querySelector('oc-dashboard');
  if(operation==='open')dashboard.expand(state.id);else dashboard.collapse();
  sample(state,'afterAction');
 };
 const tick=()=>{
  if(!active||active.done)return;
  const state=active;state.frame++;
  while(state.next<state.plan.length&&state.frame>=state.plan[state.next].frame){perform(state,state.plan[state.next++].operation);state.stable=0;}
  const value=sample(state,'raf'),dashboard=document.querySelector('oc-dashboard');
  const complete=state.next===state.plan.length&&!dashboard.morphing&&Boolean(dashboard.expanded)===state.expectedExpanded&&!value.animations.some(animation=>animation.playState==='running');
  state.stable=complete?state.stable+1:0;
  state.timedOut=performance.now()-state.started>6000;
  if(state.stable>=3||state.timedOut){sample(state,'settled');state.done=true;return;}
  raf=requestAnimationFrame(tick);
 };
 window.__dashboardMorphQa={
  prepare(id){const entry=track(id),scroll=document.querySelector('.dashboard-workspace__scroll');return {hasFrame:Boolean(entry.frame),rect:rect(entry.card),scrollTop:round(scroll?.scrollTop??0),style:{card:css(entry.card),slot:css(entry.card.closest('.dashboard-card-slot'))}};},
  begin(id,options){
   if(active&&!active.done)throw Error('A morph probe is already running');
   const entry=track(id),plan=options.kind==='rapid'?[{frame:0,operation:'open'},{frame:2,operation:'close'},{frame:4,operation:'open'},{frame:6,operation:'close'},{frame:8,operation:'open'},{frame:10,operation:'close'}]:[{frame:0,operation:options.kind}];
   active={id,kind:options.kind,mode:options.mode,hasFrame:Boolean(entry.frame),plan,next:1,frame:0,phase:plan[0].operation,expectedExpanded:plan.at(-1).operation==='open',
    started:performance.now(),initialLoads:entry.loads,originRect:options.originRect,originScrollTop:options.originScrollTop,samples:[],toggleEvents:[],loadEvents:[],stable:0,timedOut:false,done:false};
   sample(active,'beforeAction');perform(active,plan[0].operation);raf=requestAnimationFrame(tick);return true;
  },
  status(){return active?{done:active.done,frames:active.frame,phase:active.phase,elapsed:performance.now()-active.started}:null;},
  result(){return active?snapshot(active):null;},
  geometry(id){const card=cardFor(id);return {rect:rect(card),viewport:{width:innerWidth,height:innerHeight},style:{card:css(card),slot:css(card?.closest('.dashboard-card-slot'))}};},
  destroy(){cancelAnimationFrame(raf);for(const entry of tracked.values()){entry.frame?.removeEventListener('load',entry.onLoad);entry.card.removeEventListener('beforetoggle',entry.onToggle);entry.card.removeEventListener('toggle',entry.onToggle);}tracked.clear();active=null;delete window.__dashboardMorphQa;},
 };
 return true;
}

async function main(argv=process.argv){
 if(argv.includes('--help')){
  console.log('Usage: node scripts/dashboard-morph-cdp-smoke.js [--port 9295] [--out .cache/dashboard-morph/<timestamp>] [--only card-id,card-id] [--no-screenshots]\nAttaches to a running Electron app, creates one owned example board, samples all expand/collapse frames, then deletes only that board. Never sends a model request.');return;
 }
 const port=Number(arg(argv,'--port','9295'));assert.ok(Number.isInteger(port)&&port>0&&port<65536,'valid --port');
 const runId=Date.now()+'-'+randomUUID().slice(0,8),out=path.resolve(arg(argv,'--out',path.join('.cache','dashboard-morph',runId)));
 fs.mkdirSync(path.join(out,'traces'),{recursive:true});fs.mkdirSync(path.join(out,'corners'),{recursive:true});
 const report={runId,port,startedAt:new Date().toISOString(),boards:[],checks:{},cards:[],cycles:[],screenshots:[],failures:[],cleanup:{boards:[],errors:[]},noModelCalls:true};
 const ownedTitle='QA · morph continuity · '+runId;let cdp,ws,original;
 const ev=source=>cdp.evaluate('(()=>eval('+JSON.stringify(source)+'))()');
 const rpc=(method,params={})=>ev(`document.querySelector('openclaw-app').client.request(${JSON.stringify(method)},${JSON.stringify(params)})`);
 const until=async(source,label,timeout=20000)=>{const end=Date.now()+timeout;do{if(await ev(source))return;await sleep(40);}while(Date.now()<end);throw Error(label);};
 const issue=(scope,message)=>report.failures.push({scope,message});
 const shot=async(name,clip)=>{
  if(argv.includes('--no-screenshots'))return;
  const result=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false,...clip?{clip:{...clip,scale:1}}:{}},{timeoutMs:12000});
  const file=path.join(out,name+'.png');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.from(result.data,'base64'));report.screenshots.push(file);
 };
 const cornerShots=async(id,phase)=>{
  if(argv.includes('--no-screenshots'))return;
  const geometry=await ev(`window.__dashboardMorphQa.geometry(${JSON.stringify(id)})`);
  const file=path.join(out,'corners',id+'-'+phase+'-computed.json');fs.writeFileSync(file,JSON.stringify(geometry,null,2));
  const r=geometry.rect,view=geometry.viewport;
  for(const [corner,x,y] of [['top-left',r.x-22,r.y-22],['bottom-right',r.x+r.width-138,r.y+r.height-138]]){
   const left=Math.max(0,Math.min(view.width-1,x)),top=Math.max(0,Math.min(view.height-1,y));
   if((corner==='top-left'&&(r.y<0||r.y>view.height))||(corner==='bottom-right'&&(r.y+r.height<0||r.y+r.height>view.height)))continue;
   await shot(path.join('corners',id+'-'+phase+'-'+corner),{x:left,y:top,width:Math.min(160,view.width-left),height:Math.min(160,view.height-top)});
  }
 };
 const frameEval=async(boardId,cardId,expression)=>{
  const end=Date.now()+15000;
  do{
   const targets=await cdp.send('Target.getTargets'),target=targets.targetInfos.find(value=>value.type==='iframe'&&value.url.includes('/'+boardId+'/'+cardId+'?'));
   if(target){const attached=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});try{
    const result=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},{sessionId:attached.sessionId});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;
   }finally{await cdp.send('Target.detachFromTarget',{sessionId:attached.sessionId}).catch(()=>{});}}
   await sleep(50);
  }while(Date.now()<end);
  throw Error('Card document unavailable: '+cardId);
 };
 const markDocument=async(card,origin)=>{
  const token=randomUUID();
  if(origin.hasFrame)await frameEval(report.boards[0],card.id,`(async()=>{const end=Date.now()+10000;while(document.readyState!=='complete'||!window.cryoclawDashboard){if(Date.now()>end)throw Error('Dashboard SDK not ready');await new Promise(resolve=>setTimeout(resolve,50));}window.__dashboardMorphDocument=${JSON.stringify(token)};return true})()`);
  return token;
 };
 const scrollTo=async id=>{
  await ev(`(()=>{const d=document.querySelector('oc-dashboard'),c=[...d.querySelectorAll('.dashboard-card')].find(c=>c.dataset.cardId===${JSON.stringify(id)}),s=d.querySelector('.dashboard-workspace__scroll');s.scrollTo({top:s.scrollTop+c.getBoundingClientRect().top-s.getBoundingClientRect().top-24,behavior:'instant'});c.querySelector('[data-card-close]')?.focus({preventScroll:true});return true})()`);
  try{await until(`(()=>{const c=[...document.querySelectorAll('.dashboard-card')].find(c=>c.dataset.cardId===${JSON.stringify(id)}),f=c?.querySelector('iframe');return !!c&&(!f||(f.hasAttribute('src')&&f.closest('.dashboard-card__surface').dataset.framePending!=='true'&&!f.getAnimations().some(a=>a.playState==='running')))})()`,'visible card mounted: '+id);}catch{throw Error('visible card mounted: '+id+' '+JSON.stringify(await ev(`(()=>{const d=document.querySelector('oc-dashboard'),c=[...d.querySelectorAll('.dashboard-card')].find(c=>c.dataset.cardId===${JSON.stringify(id)}),f=c?.querySelector('iframe'),s=d.querySelector('.dashboard-workspace__scroll');return {hidden:document.hidden,selected:d.selected,board:d.board?.id,scroll:s.scrollTop,card:c?.getBoundingClientRect().toJSON(),root:s.getBoundingClientRect().toJSON(),src:f?.getAttribute('src'),visible:f?.dataset.visible,pending:f?.closest('.dashboard-card__surface').dataset.framePending,animations:f?.getAnimations().map(a=>({state:a.playState,name:a.animationName}))}})()`)))}
  await ev('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
 };
 const transition=async(card,kind,mode,origin,documentToken,options={})=>{
  const name=card.id+'-'+mode+'-'+kind;
  await ev(`window.__dashboardMorphQa.begin(${JSON.stringify(card.id)},${JSON.stringify({kind,mode,originRect:origin.rect,originScrollTop:origin.scrollTop})})`);
  if(options.midScreenshot){await until('window.__dashboardMorphQa.status().frames>=2','capture closing frame',3000);await shot(name+'-during');}
  await until('window.__dashboardMorphQa.status()?.done','morph settled: '+name,10000);
  const trace=await ev('window.__dashboardMorphQa.result()');
  if(origin.hasFrame){try{trace.documentPreserved=await frameEval(report.boards[0],card.id,`window.__dashboardMorphDocument===${JSON.stringify(documentToken)}`);}catch(error){trace.documentPreserved=false;trace.documentError=String(error);}}
  const summary=analyzeTrace(trace);fs.writeFileSync(path.join(out,'traces',name+'.json'),JSON.stringify({summary,...trace},null,2));
  report.cycles.push({cardId:card.id,mode,kind,...summary,trace:path.join(out,'traces',name+'.json')});
  for(const value of summary.issues)issue(name,value);
  return trace;
 };
 try{
  const target=await waitForPageTarget(port,30000);assert.ok(target,'Electron file:// target');({cdp,ws}=await connect(target));
  assert.ok(await waitForAppReady(cdp,{timeoutMs:120000}),'app ready');await dismissReleaseNotes(cdp);await cdp.send('Page.bringToFront');
  original=await ev(`(()=>{const a=document.querySelector('openclaw-app'),d=document.querySelector('oc-dashboard');return {view:a.settings.cryoclawView??'chat',selected:d?.selected??localStorage.getItem('cryoclaw.dashboard.selected'),storedSelected:localStorage.getItem('cryoclaw.dashboard.selected'),scrollTop:d?.querySelector('.dashboard-workspace__scroll')?.scrollTop??0,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches}})()`);
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await ev(`(()=>{const a=document.querySelector('openclaw-app'),client=a.client,request=client.request;window.__dashboardMorphRequestGuard={client,request,attempts:[]};client.request=function(method,...args){if(/^(chat\.send|agent|agent\.run)$/.test(method)){window.__dashboardMorphRequestGuard.attempts.push(method);return Promise.reject(Error('Model calls are disabled during morph QA'))}return request.call(this,method,...args)};return true})()`);
  const created=await rpc('cryoclaw.dashboards.mutate',{action:'create_example',title:ownedTitle});report.boards.push(created.board.id);recordQaFixtures(out,report);
  await ev("document.querySelector('oc-rail').props.onOpenDashboard();true");await until("!!document.querySelector('oc-dashboard')",'dashboard route');
  await ev(`document.querySelector('oc-dashboard').select(${JSON.stringify(created.board.id)});true`);
  await until(`document.querySelector('oc-dashboard').board?.id===${JSON.stringify(created.board.id)}&&document.querySelectorAll('.dashboard-card').length>=17`,'owned example board');
  await until("!document.querySelector('oc-dashboard').boardTransition&&!document.querySelector('.dashboard-card-slot').getAnimations().some(a=>a.playState==='running')",'board entrance settled');
  const allCards=await ev("document.querySelector('oc-dashboard').board.cards.map(c=>({id:c.id,title:c.title,kind:c.kind}))");
  const only=arg(argv,'--only','').split(',').filter(Boolean),cards=only.length?allCards.filter(card=>only.includes(card.id)):allCards;
  assert.ok(cards.length>0,'at least one selected card');assert.ok(only.every(id=>allCards.some(card=>card.id===id)),'--only contains known card ids');
  report.cards=cards;report.totalExampleCards=allCards.length;report.scope=only.length?'selected cards':'all example cards';
  report.viewport=await ev('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})');await ev('('+installProbe.toString()+')()');
  let deepest;
  for(const card of cards){
   await scrollTo(card.id);
   const origin=await ev(`window.__dashboardMorphQa.prepare(${JSON.stringify(card.id)})`),token=await markDocument(card,origin);
   if(!deepest||origin.scrollTop>deepest.scrollTop)deepest={id:card.id,scrollTop:origin.scrollTop};
   await transition(card,'open','normal',origin,token);await cornerShots(card.id,'expanded');
   if(card.id===cards[0].id||card.id==='quick-notes')await shot(card.id+'-expanded');
   await transition(card,'close','normal',origin,token,{midScreenshot:card.id===cards[0].id||card.id==='quick-notes'});await cornerShots(card.id,'restored');
   console.log(JSON.stringify({event:'normal-card-checked',cardId:card.id,completed:report.cycles.filter(cycle=>cycle.mode==='normal').length/2,total:cards.length}));
  }
  report.deepestCard=deepest;
  const rapidIds=[...new Set([cards[0].id,cards.find(card=>card.id==='quick-notes')?.id,deepest?.id].filter(Boolean))];
  for(const id of rapidIds){
   const card=cards.find(card=>card.id===id);await scrollTo(id);const origin=await ev(`window.__dashboardMorphQa.prepare(${JSON.stringify(id)})`),token=await markDocument(card,origin);
   await transition(card,'rapid','rapid',origin,token);await shot(id+'-rapid-restored');
  }
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.ok(await ev("matchMedia('(prefers-reduced-motion: reduce)').matches"),'reduced motion emulation');
  for(const card of cards){
   await scrollTo(card.id);const origin=await ev(`window.__dashboardMorphQa.prepare(${JSON.stringify(card.id)})`),token=await markDocument(card,origin);
   await transition(card,'open','reduced',origin,token);await transition(card,'close','reduced',origin,token);
  }
  report.modelAttempts=await ev('window.__dashboardMorphRequestGuard.attempts');report.noModelCalls=report.modelAttempts.length===0;if(!report.noModelCalls)issue('safety','model call attempted');
  report.checks.allNormalCardsExercised=cards.every(card=>['open','close'].every(kind=>report.cycles.some(cycle=>cycle.cardId===card.id&&cycle.mode==='normal'&&cycle.kind===kind)));
  report.checks.allReducedMotionCardsExercised=cards.every(card=>['open','close'].every(kind=>report.cycles.some(cycle=>cycle.cardId===card.id&&cycle.mode==='reduced'&&cycle.kind===kind)));
  report.checks.rapidReversalsExercised=rapidIds.every(id=>report.cycles.some(cycle=>cycle.cardId===id&&cycle.kind==='rapid'));
  report.checks.deepScrollExercised=Boolean(deepest&&deepest.scrollTop>report.viewport.height);
  if(!only.length&&!report.checks.deepScrollExercised)issue('coverage','example board never scrolled beyond one viewport');
  if(cdp.exceptions.length)issue('renderer','uncaught exceptions');
 }catch(error){report.error=String(error.stack||error);issue('harness',report.error);if(cdp)await shot('failure').catch(()=>{});}
 finally{
  if(cdp){
   await ev("window.__dashboardMorphQa?.destroy();const d=document.querySelector('oc-dashboard');if(d?.expanded||d?.morphing)d.collapse();true").catch(()=>{});
   await until("!document.querySelector('oc-dashboard')?.morphing",'cleanup collapse',5000).catch(error=>report.cleanup.errors.push(String(error)));
   // Never scan or delete another run's sessions, cron jobs or QA boards.
   for(const id of report.boards){try{
    const current=(await rpc('cryoclaw.dashboards.list',{includeArchived:true})).boards.find(board=>board.id===id);
    if(current&&current.title!==ownedTitle)throw Error('Owned board title changed; refusing deletion: '+id);
    if(current)await rpc('cryoclaw.dashboards.mutate',{action:'delete',boardId:id,confirmDelete:true});report.cleanup.boards.push(id);
   }catch(error){report.cleanup.errors.push(String(error));}}
   if(original){
    await ev(`(async()=>{const d=document.querySelector('oc-dashboard');if(d&&${JSON.stringify(original.selected)}&&d.boards.some(b=>b.id===${JSON.stringify(original.selected)})){d.select(${JSON.stringify(original.selected)});await d.updateComplete;const s=d.querySelector('.dashboard-workspace__scroll');if(s)s.scrollTop=${Number(original.scrollTop)||0}}if(${JSON.stringify(original.storedSelected)}===null)localStorage.removeItem('cryoclaw.dashboard.selected');else localStorage.setItem('cryoclaw.dashboard.selected',${JSON.stringify(original.storedSelected)});const a=document.querySelector('openclaw-app');if(a.settings.cryoclawView!==${JSON.stringify(original.view)})a.applySettings({...a.settings,cryoclawView:${JSON.stringify(original.view)}});return true})()`).catch(error=>report.cleanup.errors.push(String(error)));
    await cdp.send('Emulation.setEmulatedMedia',{features:[]}).catch(()=>{});
   }
   report.modelAttempts=await ev('window.__dashboardMorphRequestGuard?.attempts??[]').catch(()=>[]);
   report.noModelCalls=report.modelAttempts.length===0;
   await ev("const guard=window.__dashboardMorphRequestGuard;if(guard){guard.client.request=guard.request;delete window.__dashboardMorphRequestGuard;}true").catch(error=>report.cleanup.errors.push(String(error)));
   report.exceptions=cdp.exceptions;report.consoleErrors=cdp.consoleErrors;if(cdp.exceptions.length&&!report.failures.some(failure=>failure.scope==='renderer'))issue('renderer','uncaught exceptions');ws?.close();
  }
  report.finishedAt=new Date().toISOString();report.passed=report.failures.length===0&&report.cleanup.errors.length===0&&report.noModelCalls;
  const redact=(_key,value)=>typeof value==='string'?value.replace(/ticket=[^&\s'"<>]+/g,'ticket=[redacted]'):value;
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,redact,2));
  console.log(JSON.stringify({out,passed:report.passed,cards:report.cards.length,cycles:report.cycles.length,failures:report.failures,cleanup:report.cleanup},redact,2));
  if(!report.passed)process.exitCode=1;
 }
 return report;
}

module.exports={analyzeTrace,installProbe,main};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
