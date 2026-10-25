"use strict";
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {arg,waitForPageTarget,connect,waitForAppReady,dismissReleaseNotes,sleep}=require('./lib/cdp-harness');

(async()=>{
 const port=Number(arg(process.argv,'--port','9295')),out=path.resolve(arg(process.argv,'--out','.cache/workbench-ui-review'));
 fs.mkdirSync(out,{recursive:true});const report={checks:{},boards:[],screenshots:[]};let cdp,ws,original;
 const ev=code=>cdp.evaluate('(()=>eval('+JSON.stringify(code)+'))()');
 const rpc=(method,params={})=>ev(`document.querySelector('openclaw-app').client.request(${JSON.stringify(method)},${JSON.stringify(params)})`);
 const until=async(code,label,timeout=20000)=>{const end=Date.now()+timeout;do{if(await ev(code))return;await sleep(80);}while(Date.now()<end);throw Error(label);};
 const check=(name,value)=>{assert.ok(value,name);report.checks[name]=true;};
 const click=async(selector,button='left')=>{await sleep(450);const rect=await ev(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing click target');if(el.closest('.dashboard-workspace__scroll'))el.scrollIntoView({block:'nearest',behavior:'instant'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...rect});await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...rect,button,clickCount:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...rect,button,clickCount:1});};
 const fill=async(selector,text)=>{await ev(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select();true`);await cdp.send('Input.insertText',{text});};
 const shot=async(name)=>{const result=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});const file=path.join(out,name+'.png');fs.writeFileSync(file,Buffer.from(result.data,'base64'));report.screenshots.push(file);};
 const frame=async(boardId,cardId,code)=>{const end=Date.now()+15000;do{const targets=await cdp.send('Target.getTargets'),target=targets.targetInfos.find(target=>target.type==='iframe'&&target.url.includes('/'+boardId+'/'+cardId+'?'));if(target){const attached=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});try{const result=await cdp.send('Runtime.evaluate',{expression:code,returnByValue:true,awaitPromise:true},{sessionId:attached.sessionId});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;}finally{await cdp.send('Target.detachFromTarget',{sessionId:attached.sessionId}).catch(()=>{});}}await sleep(80);}while(Date.now()<end);throw Error('Frame unavailable: '+cardId);};
 const clickFrame=async(boardId,cardId,selector)=>{await ev(`document.querySelector('[data-card-id="${cardId}"]').scrollIntoView({block:'center',behavior:'instant'});true`);await sleep(180);const inner=await frame(boardId,cardId,`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth};})()`),outer=await ev(`(()=>{const r=document.querySelector('[data-card-id="${cardId}"] iframe').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width}})()`),x=outer.x+inner.x*outer.width/inner.width,y=outer.y+inner.y*outer.width/inner.width;await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});};
 try{
  const page=await waitForPageTarget(port,30000);assert.ok(page,'app target');({cdp,ws}=await connect(page));
  if(process.argv.includes('--reload'))await cdp.send('Page.navigate',{url:await cdp.evaluate("new URL('index.html'+location.search,location.href).href")});
  assert.ok(await waitForAppReady(cdp,{timeoutMs:120000}),'app ready');await dismissReleaseNotes(cdp);await until("document.querySelector('openclaw-app').connected",'gateway connected',180000);await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  original=await ev("({draft:document.querySelector('openclaw-app').chatMessage,selected:localStorage.getItem('cryoclaw.dashboard.selected')})");
  await ev("document.querySelector('oc-rail').props.onOpenDashboard();true");await until("!!document.querySelector('.dashboard-tabs__add')&&!document.querySelector('.dashboard-tabs__add').disabled",'dashboard route');
  await ev("document.querySelector('oc-dashboard').dialog='';true");await sleep(100);await click('.dashboard-tabs__add');await until("document.querySelector('.dashboard-dialog').open",'create dialog');
  await ev("const s=document.querySelector('.dashboard-dialog select');s.value='productivity';s.dispatchEvent(new Event('change',{bubbles:true}));true");
  await fill('.dashboard-dialog input','QA · daily workbench');await fill('.dashboard-dialog textarea','Keep project Alpha visible; preserve local notes.');await click('.dashboard-dialog button[type=submit]');
  await until("document.querySelector('oc-dashboard').board?.title==='QA · daily workbench'&&!document.querySelector('oc-dashboard').saving",'created curated board');
  const board=await ev("document.querySelector('oc-dashboard').board");report.boards.push(board.id);check('curatedTemplateCreatesFourModules',board.cards.length===4);
  const background=(await rpc('cryoclaw.dashboards.mutate',{action:'create',title:'QA · background',description:'Original background'})).board.id;report.boards.push(background);
  await until(`!!document.querySelector('[data-board-id="${background}"]')`,'background tab');
  await click(`[data-board-id="${background}"]`,'right');await until("!!document.querySelector('.dashboard-tab-menu')",'tab context menu');
  const labels=await ev("[...document.querySelectorAll('.dashboard-tab-menu [role=menuitem]')].map(button=>button.textContent.trim())");assert.deepEqual(labels,['编辑看板详情','删除看板']);report.checks.exactTwoContextActions=true;
  await click('.dashboard-tab-menu button:first-child');await until("document.querySelector('.dashboard-dialog').open",'details dialog');
  await fill('.dashboard-dialog input','QA · background edited');await fill('.dashboard-dialog textarea','Use this background description.');await click('.dashboard-dialog button[type=submit]');
  await until(`document.querySelector('oc-dashboard').boards.find(board=>board.id==='${background}')?.description==='Use this background description.'`,'background details saved');
  check('backgroundTabEditsDoNotSwitchBoard',await ev(`document.querySelector('oc-dashboard').selected==='${board.id}'`));
  const backgroundDetails=(await rpc('cryoclaw.dashboards.list',{includeArchived:true})).boards.find(item=>item.id===background);check('titleAndDescriptionPersist',backgroundDetails.title==='QA · background edited');
  await click('.dashboard-menu summary');await click('.dashboard-menu__add');await until("!!document.querySelector('.dashboard-library iframe')",'template preview');await sleep(400);
  check('libraryStaysOpenAcrossParentUpdates',await ev("document.querySelector('.dashboard-library').open"));check('previewScriptsRunUnderTheRealShellCsp',await frame('preview','quick-notes',"cryoclawDashboard.preview===true"));await shot('template-library');
  await click('.dashboard-library footer .primary');await until("!document.querySelector('oc-dashboard-library')&&document.querySelector('oc-dashboard').board.cards.length===5",'template inserted');
  const cards=await ev("document.querySelector('oc-dashboard').board.cards");check('moduleInsertionHasIndependentIdentity',new Set(cards.map(card=>card.id)).size===5&&cards.some(card=>card.id==='quick-notes'));
  for(const card of cards){
   await ev(`window.__fullscreenFrame=document.querySelector('[data-card-id="${card.id}"] iframe');document.querySelector('oc-dashboard').expand(${JSON.stringify(card.id)});true`);
   await until("!document.querySelector('oc-dashboard').morphing",'fullscreen animation settled');
   check('fullscreenVisible_'+card.id,await ev(`(()=>{const card=document.querySelector('[data-card-id="${card.id}"]'),r=card.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return card.contains(hit)&&r.width>innerWidth*.85&&r.height>innerHeight*.8})()`));
   await ev("document.querySelector('oc-dashboard').collapse();true");await until("!document.querySelector('oc-dashboard').morphing&&!document.querySelector('[data-expanded=true]')",'fullscreen restored');
   check('fullscreenPreservesDocument_'+card.id,await ev(`window.__fullscreenFrame===document.querySelector('[data-card-id="${card.id}"] iframe')`));
  }
  const fixtureHtml='<!doctype html><html><head><style>body{margin:0;padding:48px;font:22px system-ui}button,input{font:inherit;padding:12px;margin:10px}</style></head><body><h1>Element targeting</h1><button id="action"><span id="label">Refine this label</span></button><input id="field" value="Keep me"><p id="count">0</p><script>window.actions=0;window.captures=0;addEventListener("pointerdown",()=>window.captures++,true);document.querySelector("#action").onclick=()=>{window.actions++;document.querySelector("#count").textContent=window.actions;cryoclawDashboard.setState({count:window.actions})};</script></body></html>';
  await rpc('cryoclaw.dashboards.mutate',{action:'publish_card',boardId:board.id,cardId:'target-fixture',title:'QA element target',html:fixtureHtml,layout:{w:12,h:300,order:0}});
  await until("!!document.querySelector('[data-card-id=target-fixture] iframe[src]')",'target fixture loaded');
  await click('.dashboard-floatbar__edit');await until("document.querySelector('oc-dashboard').editing",'edit mode');
  check('unifiedPencilShowsComposer',await ev("!!document.querySelector('.dashboard-compose')&&!document.querySelector('.dashboard-tabs__ask')&&!document.querySelector('.dashboard-compose__close')"));
  await clickFrame(board.id,'target-fixture','#label');report.inspectorDiagnostics=await frame(board.id,'target-fixture',"({sdk:typeof cryoclawDashboard,actions:window.actions,captures:window.captures,overlay:!!document.querySelector('[data-cryoclaw-inspector]'),label:document.querySelector('#label').getBoundingClientRect().toJSON()})");await until("document.querySelector('oc-dashboard').selection?.tagName==='span'",'element selected');
  const selected=await ev("document.querySelector('oc-dashboard').selection");check('elementSelectionUsesOwningCard',selected.cardId==='target-fixture'&&selected.text==='Refine this label');
  const actions=await frame(board.id,'target-fixture','({actions:window.actions,captures:window.captures})');assert.deepEqual(actions,{actions:0,captures:0});report.checks.inspectionDoesNotRunOriginalHandlers=true;
  await frame(board.id,'target-fixture',"document.querySelector('#field').focus();true");await cdp.send('Input.insertText',{text:'must not be entered'});
  check('inspectorBlocksTextAndImeInput',await frame(board.id,'target-fixture',"document.querySelector('#field').value==='Keep me'"));
  await until("!!document.querySelector('.dashboard-compose__selection')",'selected target composer');
  await fill('.dashboard-compose textarea','Make the selected label calmer.');await sleep(200);
  await ev("window.workbenchOriginalRequest=document.querySelector('openclaw-app').client.request;document.querySelector('openclaw-app').client.request=function(method,params){if(method==='chat.send'){window.workbenchSent=params;return Promise.reject(Error('QA send intercepted before gateway'))}return window.workbenchOriginalRequest.call(this,method,params)};true");
  await click('.dashboard-compose .chat-compose__send-btn--send');await until("!!window.workbenchSent",'shared composer target message');
  const sent=await ev('window.workbenchSent');const message=sent.message;
  check('modelReceivesBoardDescriptionAndElement',message.includes('Keep project Alpha visible')&&message.includes('cardId=target-fixture')&&message.includes('Refine this label')&&message.includes('read_card'));
  await ev("document.querySelector('openclaw-app').client.request=window.workbenchOriginalRequest;document.querySelector('openclaw-app').lastError=null;true");
  await shot('selected-element-composer');
  await click('[data-card-id=target-fixture] .dashboard-card__select');check('wholeCardSelectionHasNoElementSelector',await ev("document.querySelector('oc-dashboard').selection.cardId==='target-fixture'&&!document.querySelector('oc-dashboard').selection.selector"));
  await click('.dashboard-floatbar__edit');await until("!document.querySelector('oc-dashboard').editing&&!document.querySelector('.dashboard-compose')",'finish editing');
  await clickFrame(board.id,'target-fixture','#action');for(let i=0;i<20&&!await frame(board.id,'target-fixture','window.actions===1');i++)await sleep(100);check('cardInteractionRestoredAfterEditing',await frame(board.id,'target-fixture','window.actions===1'));
  await until(`document.querySelector('openclaw-app').client.request('cryoclaw.dashboards.getState',{boardId:'${board.id}',cardId:'target-fixture'}).then(state=>state?.count===1)`,'normal state persists');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1000,height:800,deviceScaleFactor:0,mobile:false});await sleep(500);
  await ev("document.querySelector('[data-card-id=quick-notes]').scrollIntoView({block:'center',behavior:'instant'});window.__sizedFrame=document.querySelector('[data-card-id=quick-notes] iframe');true");await sleep(500);
  const sizeBefore=await ev("(()=>{const c=document.querySelector('[data-card-id=quick-notes]'),b=c.querySelector('.dashboard-card__resize').getBoundingClientRect();return {width:c.getBoundingClientRect().width,x:b.x+b.width/2,y:b.y+b.height/2}})()");
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:sizeBefore.x,y:sizeBefore.y});await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:sizeBefore.x,y:sizeBefore.y,button:'left',buttons:1,clickCount:1});
  for(let i=1;i<=4;i++){await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:sizeBefore.x-17*i/4,y:sizeBefore.y+13*i/4,button:'left',buttons:1});await sleep(35);}
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:sizeBefore.x-17,y:sizeBefore.y+13,button:'left',buttons:0,clickCount:1});await until("!document.querySelector('oc-dashboard').gesture&&!document.querySelector('oc-dashboard').saving",'continuous resize saved');
  const sizeAfter=await ev("(()=>{const d=document.querySelector('oc-dashboard'),c=document.querySelector('[data-card-id=quick-notes]');return {width:c.getBoundingClientRect().width,layout:d.board.cards.find(c=>c.id==='quick-notes').layout,same:window.__sizedFrame===c.querySelector('iframe')}})()");
  check('narrowResizeTracksPointerWithoutColumnSnap',Math.abs(sizeBefore.width-sizeAfter.width-17)<3&&sizeAfter.layout.free&&!Number.isInteger(sizeAfter.layout.w));check('resizeKeepsSameRunningDocument',sizeAfter.same);
  const persisted=(await rpc('cryoclaw.dashboards.list',{includeArchived:true})).boards.find(b=>b.id===board.id).cards.find(c=>c.id==='quick-notes').layout;check('fractionalSizePersists',persisted.w===sizeAfter.layout.w&&persisted.free);
  const layoutBefore=await ev("document.querySelector('oc-dashboard').board.cards.map(c=>({id:c.id,w:c.layout.w,h:c.layout.h,free:Boolean(c.layout.free)}))");await click('.dashboard-floatbar>button:nth-child(2)');await until("!document.querySelector('oc-dashboard').saving&&!!document.querySelector('.dashboard-floatbar__undo')",'arrangement');await click('.dashboard-floatbar__undo');await until("!document.querySelector('oc-dashboard').saving&&!document.querySelector('.dashboard-floatbar__undo')",'undo arrangement');assert.deepEqual(await ev("document.querySelector('oc-dashboard').board.cards.map(c=>({id:c.id,w:c.layout.w,h:c.layout.h,free:Boolean(c.layout.free)}))"),layoutBefore);report.checks.arrangeUndoRestoresGeometry=true;
  await cdp.send('Emulation.clearDeviceMetricsOverride');await sleep(500);
  await click(`[data-board-id="${background}"]`,'right');await click('.dashboard-tab-menu button:last-child');await until("document.querySelector('.dashboard-dialog').open",'delete dialog');
  check('deleteNamesTheBackgroundTab',await ev("document.querySelector('.dashboard-dialog__target').textContent==='QA · background edited'"));
  await click('.dashboard-dialog button[type=submit]');await until(`!document.querySelector('[data-board-id="${background}"]')`,'background deleted');check('backgroundDeletionKeepsActiveBoard',await ev(`document.querySelector('oc-dashboard').selected==='${board.id}'`));
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'},{name:'prefers-reduced-motion',value:'reduce'}]});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1000,height:800,deviceScaleFactor:0,mobile:false});await sleep(300);await shot('workbench-narrow');
  check('focusedModeClearsNativeTitlebar',await ev("document.querySelector('oc-dashboard').focusMode=true;true").then(()=>until("document.querySelector('.dashboard-workspace').getBoundingClientRect().top>=32",'focus titlebar clearance')).then(()=>true));
  check('narrowViewDoesNotOverflow',await ev('document.documentElement.scrollWidth<=innerWidth+1'));
  check('noRendererExceptions',cdp.exceptions.length===0);
 }catch(error){report.error=String(error.stack||error);process.exitCode=1;if(cdp)await shot('failure').catch(()=>{});}
 finally{
  if(cdp){await ev("if(window.workbenchOriginalRequest)document.querySelector('openclaw-app').client.request=window.workbenchOriginalRequest;true").catch(()=>{});
   for(const id of report.boards)await rpc('cryoclaw.dashboards.mutate',{action:'delete',boardId:id,confirmDelete:true}).catch(()=>{});
   if(original)await ev(`const a=document.querySelector('openclaw-app');a.chatMessage=${JSON.stringify(original.draft??'')};a.lastError=null;if(${JSON.stringify(original.selected)})localStorage.setItem('cryoclaw.dashboard.selected',${JSON.stringify(original.selected)});a.requestUpdate();true`).catch(()=>{});
   await cdp.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});await cdp.send('Emulation.setEmulatedMedia',{features:[]}).catch(()=>{});report.exceptions=cdp.exceptions;report.consoleErrors=cdp.consoleErrors;
   if(process.argv.includes('--quit'))await ev('window.cryoclaw.quit();true').catch(()=>{});ws.close();
  }
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,...report}));
 }
})().catch(error=>{console.error(error);process.exitCode=1});
