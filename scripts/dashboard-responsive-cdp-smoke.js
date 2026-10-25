'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {arg,waitForPageTarget,connect,waitForAppReady,dismissReleaseNotes,sleep}=require('./lib/cdp-harness');
const {cleanupOwnedQa}=require('./lib/qa-fixtures');

(async()=>{
 const port=Number(arg(process.argv,'--port','9295')),out=path.resolve(arg(process.argv,'--out',path.join('.cache','dashboard-responsive',new Date().toISOString().replace(/[:.]/g,'-'))));
 fs.mkdirSync(out,{recursive:true});const report={boards:[],checks:[],failures:[],screenshots:[],cleanup:{boards:[],errors:[]}};let cdp,ws;
 const ev=source=>cdp.evaluate('(()=>eval('+JSON.stringify(source)+'))()');
 const rpc=(method,params={})=>ev(`document.querySelector('openclaw-app').client.request(${JSON.stringify(method)},${JSON.stringify(params)})`);
 const until=async(source,label,ms=20000)=>{const end=Date.now()+ms;do{if(await ev(source))return;await sleep(60)}while(Date.now()<end);throw Error(label)};
 const frame=async(cardId,expression)=>{const end=Date.now()+15000;do{const targets=await cdp.send('Target.getTargets'),target=targets.targetInfos.find(t=>t.type==='iframe'&&report.boards.some(id=>t.url.includes('/'+id+'/'+cardId+'?')));if(target){const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});try{const result=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},{sessionId});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value}finally{await cdp.send('Target.detachFromTarget',{sessionId}).catch(()=>{})}}await sleep(60)}while(Date.now()<end);throw Error('Frame unavailable: '+cardId)};
 const shot=async name=>{const result=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});const file=path.join(out,name+'.png');fs.writeFileSync(file,Buffer.from(result.data,'base64'));report.screenshots.push(file)};
 try{
  const page=await waitForPageTarget(port,30000);assert.ok(page,'Electron page');({cdp,ws}=await connect(page));assert.ok(await waitForAppReady(cdp,{timeoutMs:120000}),'app ready');await dismissReleaseNotes(cdp);await cdp.send('Page.bringToFront');
  const created=await rpc('cryoclaw.dashboards.mutate',{action:'create_example',title:'QA · all module responsive'});const boardId=created.board.id;report.boards.push(boardId);
  await ev("document.querySelector('oc-rail').props.onOpenDashboard();true");await until("!!document.querySelector('oc-dashboard')",'dashboard');await ev(`document.querySelector('oc-dashboard').select(${JSON.stringify(boardId)});true`);await until(`document.querySelector('oc-dashboard').board?.id===${JSON.stringify(boardId)}&&document.querySelectorAll('.dashboard-card').length===21`,'example cards');
  const cards=await ev("document.querySelector('oc-dashboard').board.cards.map(c=>({id:c.id,title:c.title,kind:c.kind}))");
  const sizes=[{name:'compact',w:2,h:180},{name:'narrow',w:4,h:360},{name:'wide-short',w:12,h:220},{name:'large',w:12,h:700}];
  for(const card of cards){
   for(let index=0;index<sizes.length;index++){
    const size=sizes[index],before=await ev(`(()=>{const f=document.querySelector('[data-card-id=${card.id}] iframe');window.__responsiveIdentity=window.__responsiveIdentity||{};if(f)window.__responsiveIdentity[${JSON.stringify(card.id)}]=f;return true})()`);
    await ev(`(()=>{const d=document.querySelector('oc-dashboard');d.replaceCards(d.board.cards.map(c=>c.id===${JSON.stringify(card.id)}?{...c,layout:{...c.layout,w:${size.w},h:${size.h},free:true,order:0}}:c));return true})()`);
    await ev(`document.querySelector('[data-card-id=${card.id}]').scrollIntoView({block:'center',behavior:'instant'});true`);
    await until(`(()=>{const f=document.querySelector('[data-card-id=${card.id}] iframe');return ${card.kind==='system'?'true':`f&&f.clientWidth>0&&f.clientHeight>0&&f.closest('.dashboard-card__surface').dataset.framePending!=='true'`}})()`,'mounted '+card.id+' '+size.name);
    await sleep(180);
    const result=card.kind==='system'?await ev(`(()=>{const root=document.querySelector('[data-card-id=${card.id}] .dashboard-system'),r=root.getBoundingClientRect();return {width:r.width,height:r.height,scrollWidth:root.scrollWidth,bodyScrollWidth:root.scrollWidth,scrollHeight:root.scrollHeight,controls:root.querySelectorAll('button').length,unreachable:[],clippedText:[]}})()`):await frame(card.id,`(()=>{const visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0};const interactive=[...document.querySelectorAll('button,input,textarea,select,a[href]')].filter(visible),canScroll=getComputedStyle(document.body).overflowY!=='hidden';return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,bodyScrollWidth:document.body.scrollWidth,scrollHeight:document.documentElement.scrollHeight,controls:interactive.length,unreachable:canScroll?[]:interactive.filter(e=>{const r=e.getBoundingClientRect();return r.right<0||r.left>innerWidth+1||r.bottom<0||r.top>innerHeight+1}).map(e=>e.id||e.textContent.trim().slice(0,40)),clippedText:[...document.querySelectorAll('h1,h2,h3,p,button,label')].filter(visible).filter(e=>{const s=getComputedStyle(e);return s.overflowY==='hidden'&&e.scrollHeight>e.clientHeight+2}).map(e=>e.textContent.trim().slice(0,60))}})()`);
    const geometry=await ev(`(()=>{const f=document.querySelector('[data-card-id=${card.id}] iframe'),root=document.querySelector('[data-card-id=${card.id}] .dashboard-card__content'),r=(f||root).getBoundingClientRect();return {width:r.width,height:r.height,same:${card.kind==='system'?'true':`f===window.__responsiveIdentity[${JSON.stringify(card.id)}]`}}})()`);
    const failures=[];if(Math.abs(result.width-geometry.width)>2||Math.abs(result.height-geometry.height)>2)failures.push('iframe viewport differs from actual card');if(result.scrollWidth>result.width+2||result.bodyScrollWidth>result.width+2)failures.push(`document horizontal overflow ${result.scrollWidth}/${result.bodyScrollWidth} > ${result.width}`);if(result.unreachable.length)failures.push('controls outside viewport: '+result.unreachable.join(','));if(result.clippedText.length)failures.push('clipped text: '+result.clippedText.join(','));if(!geometry.same)failures.push('iframe document replaced');
    const check={cardId:card.id,title:card.title,size:size.name,...size,result,geometry,failures};report.checks.push(check);if(failures.length)report.failures.push(check);
    if(index===0||failures.length)await shot(card.id+'-'+size.name);
   }
   console.log(JSON.stringify({event:'card-responsive-checked',cardId:card.id,completed:report.checks.length,total:cards.length*sizes.length}));
  }
  report.rendererExceptions=cdp.exceptions;if(cdp.exceptions.length)report.failures.push({scope:'renderer',failures:cdp.exceptions});
  assert.equal(report.failures.length,0,JSON.stringify(report.failures.map(f=>({cardId:f.cardId,size:f.size,failures:f.failures}))));
 }catch(error){report.error=String(error.stack||error);process.exitCode=1}
 finally{if(cdp){try{report.cleanup=await cleanupOwnedQa(rpc,{boardIds:report.boards,jobIds:[]});if(report.cleanup.errors.length)process.exitCode=1}catch(error){report.cleanupError=String(error);process.exitCode=1}await cdp.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});ws?.close()}fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,checks:report.checks.length,failures:report.failures.length,error:report.error}))}
})().catch(error=>{console.error(error);process.exitCode=1});
