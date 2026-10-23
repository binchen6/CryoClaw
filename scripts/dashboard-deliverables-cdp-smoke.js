"use strict";
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const {arg,launch,waitForPageTarget,connect,waitForAppReady,waitForGateway,dismissReleaseNotes,sleep,setViewport}=require("./lib/cdp-harness");

(async()=>{
  const out=path.resolve("out/feature-review",new Date().toISOString().replace(/[:.]/g,"-"));fs.mkdirSync(out,{recursive:true});
  const exe=path.resolve(arg(process.argv,"--exe","out/review-2026.1021.2/win-unpacked/CryoClaw.exe"));
  const port=Number(arg(process.argv,"--port","9264"));
  const {stageElectronRuntime}=require('./lib/stage-electron-runtime');
  const staged=process.argv.includes('--in-place')?{exe,cleanup:async()=>{}}:await stageElectronRuntime(exe);
  const start=Date.now();
  let running=launch(staged.exe,port),ws,cdp,original;
  const cpuProfile=process.argv.includes("--profile") ? require('./lib/gateway-cpu-profile').profileGatewayChild(running.child.pid,out,{nativeNodeBin:path.join(path.dirname(staged.exe),'resources/resources/runtime/node.exe')}).catch(error=>({error:String(error)})) : null;
  const report={startupMs:null,startupRunsMs:[],startupSamples:[],checks:{},screenshots:[],error:null};
  const initialSample={windowMs:null,healthMs:null,readyMs:null,gracefulExit:false};report.startupSamples.push(initialSample);
  const initialHealth=waitForGateway('http://127.0.0.1:18789/healthz',240000,150).then(ok=>{if(ok)initialSample.healthMs=Date.now()-start;return ok;});
  const stop=async()=>{
    if(cdp)await cdp.evaluate("window.cryoclaw.quit();true").catch(()=>{});
    const deadline=Date.now()+70000;while(running.child.exitCode===null&&Date.now()<deadline)await sleep(100);
    report.startupSamples.at(-1).gracefulExit=running.child.exitCode===0;
    ws?.close();running.cleanup();ws=null;cdp=null;
  };
  const until=async(expression,label,timeout=30000)=>{const end=Date.now()+timeout;do{if(await cdp.evaluate(expression))return;await sleep(200);}while(Date.now()<end);throw Error(label);};
  const capture=async name=>{const result=await cdp.send("Page.captureScreenshot",{format:"png",fromSurface:false,captureBeyondViewport:false});const file=path.join(out,name+".png");fs.writeFileSync(file,Buffer.from(result.data,"base64"));report.screenshots.push(file);};
  const frameEvaluate=async(cardId,expression,media)=>{
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      const targets=await cdp.send('Target.getTargets');const target=targets.targetInfos.find(t=>t.type==='iframe'&&t.url.includes('/__cryoclaw__/dashboards/')&&t.url.includes('/'+cardId+'?'));
      if(target){const attached=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});try{if(media)await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:media}]},{sessionId:attached.sessionId});const result=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},{sessionId:attached.sessionId});if(result.exceptionDetails)throw Error(result.exceptionDetails.text+': '+result.exceptionDetails.exception?.description);return result.result?.value;}finally{await cdp.send('Target.detachFromTarget',{sessionId:attached.sessionId}).catch(()=>{});}}
      await sleep(250);
    }throw Error('Dashboard frame unavailable: '+cardId);
  };
  try{
    const page=await waitForPageTarget(port);assert.ok(page,"packaged app page");initialSample.windowMs=Date.now()-start;({ws,cdp}=await connect(page));
    assert.ok(await waitForAppReady(cdp,{timeoutMs:240000}),"session data ready");report.startupMs=Date.now()-start;
    initialSample.readyMs=report.startupMs;assert.ok(await initialHealth,'initial gateway health');
    report.startupRunsMs.push(report.startupMs);
    await dismissReleaseNotes(cdp);
    original=await cdp.evaluate("document.querySelector('openclaw-app').sessionKey");
    report.checks.startupWithoutFalseErrors=await cdp.evaluate("!document.querySelector('openclaw-app').lastError && !document.querySelector('openclaw-app').progressCard.error");
    const key="agent:main:dashboard-qa-"+Date.now();
    const file=path.join(out,"交付报告 & sample.pdf"),other=path.join(out,"legacy-result.csv");
    fs.writeFileSync(file,"%PDF-1.4\n% QA fixture\n");fs.writeFileSync(other,"item,value\nverified,1\n");
    await cdp.evaluate(`document.querySelector('openclaw-app').client.request('sessions.create',{key:${JSON.stringify(key)},agentId:'main',displayName:'QA dashboard & deliverables'})`);
    await cdp.evaluate(`document.querySelector('oc-rail').props.onOpenChat()`);
    await until("!!document.querySelector('oc-session-panel')","chat navigation");
    await cdp.evaluate(`document.querySelector('oc-session-panel').props.onSelectSession(${JSON.stringify(key)})`);
    await until(`document.querySelector('openclaw-app').sessionKey===${JSON.stringify(key)} && !document.querySelector('openclaw-app').chatLoading`,"QA session selected");
    const delivered=await cdp.evaluate(`document.querySelector('openclaw-app').client.request('tools.invoke',{name:'cryoclaw_deliver_files',sessionKey:${JSON.stringify(key)},args:{files:[{path:${JSON.stringify(file)},title:'交付报告'}]}})`);
    assert.equal(delivered.ok,true,JSON.stringify(delivered.error));
    assert.equal(delivered.output.details.cryoclawDeliverables.files.length,1);report.checks.nativeDeliveryPlugin=true;
    // Use the actual native plugin receipt to cover live and history rendering,
    // including a legacy duplicate and a distinct file in the same answer.
    await cdp.evaluate(`(()=>{const app=document.querySelector('openclaw-app');app.chatMessages=[
      {role:'assistant',content:[{type:'toolCall',id:'qa-delivery',name:'cryoclaw_deliver_files',arguments:{files:[{path:${JSON.stringify(file)}}]}}],timestamp:Date.now()},
      {role:'toolResult',toolCallId:'qa-delivery',toolName:'cryoclaw_deliver_files',content:${JSON.stringify(delivered.output.content)},details:${JSON.stringify(delivered.output.details)},timestamp:Date.now()},
      {role:'assistant',content:[{type:'text',text:${JSON.stringify('已完成。\nMEDIA:"'+file+'"\nMEDIA:"'+other+'"')}}],timestamp:Date.now()}];app.chatVisibleMessageCount=100;app.chatToolMessages=[];app.requestUpdate();})()`);
    await until("document.querySelectorAll('.chat-file-card').length===2","plugin precedence and distinct legacy card");
    try{await until("[...document.querySelectorAll('.chat-file-card__meta')].every(el=>/ B| KB/.test(el.textContent))","visible file metadata");}
    catch(error){report.metadataDiagnostic=await cdp.evaluate(`(async()=>({bridge:typeof window.cryoclaw.fileCardInfo,cards:[...document.querySelectorAll('.chat-file-card')].map(el=>({bound:el.dataset.fileInfoBound,meta:el.querySelector('.chat-file-card__meta')?.textContent,visible:el.getBoundingClientRect().top<innerHeight})),native:await window.cryoclaw.fileCardInfo(${JSON.stringify(file)}).catch(e=>({error:String(e)}))}))()`);throw error;}
    report.checks.dualProtocolDedup=true;
    report.checks.cardActions=await cdp.evaluate("document.querySelectorAll('[data-file-copy]').length===2 && document.querySelectorAll('[data-file-save]').length===2 && document.querySelectorAll('[data-file-reveal]').length===2");
    await capture("file-cards-light");
    const rpc=(method,params={})=>cdp.evaluate('document.querySelector("openclaw-app").client.request('+JSON.stringify(method)+','+JSON.stringify(params)+')');
    await rpc('cryoclaw.dashboards.mutate',{action:'seed'});
    // Refresh only our untouched QA example cards when iterating an unpublished candidate.
    if(process.argv.includes('--refresh-examples')){const starter=await import('../builtin-plugins/cryoclaw-dashboards/starter.mjs');const sample=(await rpc('cryoclaw.dashboards.list')).boards.find(b=>b.title==='Hello World');if(sample)for(const card of starter.starterCards)await rpc('cryoclaw.dashboards.mutate',{action:'publish_card',boardId:sample.id,...card});}
    const created=await rpc('tools.invoke',{name:'cryoclaw_dashboard',sessionKey:key,args:{action:'create',title:'QA · 独立看板'}});assert.equal(created.ok,true,JSON.stringify(created.error));
    const board=JSON.parse(created.output.content[0].text).board;report.dashboardId=board.id;
    for(const [cardId,title] of [['qa-overview','项目概览'],['qa-detail','详细分析']]){
      const html='<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px system-ui;padding:24px;background:#f8fafc;color:#111827}button{padding:12px}</style></head><body><h1>'+title+'</h1><p>模型生成的独立交互面板</p><button id="count">0</button><script>let count=0;cryoclawDashboard.getState().then(s=>{count=s?.count||0;document.getElementById("count").textContent=count});document.getElementById("count").onclick=async()=>{await cryoclawDashboard.setState({count:++count});document.getElementById("count").textContent=count};window.qaMarker="persistent-document";</script></body></html>';
      const published=await rpc('tools.invoke',{name:'cryoclaw_dashboard',sessionKey:key,args:{action:'publish_card',boardId:board.id,cardId,title,html}});assert.equal(published.ok,true,JSON.stringify(published.error));
    }
    await setViewport(cdp,1920,1200);await cdp.evaluate('document.querySelector("oc-rail").props.onOpenDashboard()');
    await until('document.querySelectorAll("oc-dashboard .dashboard-tabs [role=tab]").length>=2','independent dashboard tabs');
    await cdp.evaluate('[...document.querySelectorAll("oc-dashboard [role=tab]")].find(b=>b.textContent.includes("QA · 独立看板")).click()');
    await until('document.querySelectorAll("oc-dashboard .dashboard-card").length===2','native plugin cards discovered');report.checks.dashboardEntry=true;
    await frameEvaluate('qa-overview','document.getElementById("count").click();true');const liveDocumentMarker='doc-'+require('node:crypto').randomUUID();await frameEvaluate('qa-overview','window.qaMarker='+JSON.stringify(liveDocumentMarker));
    await until('document.querySelector("openclaw-app").client.request("cryoclaw.dashboards.getState",'+JSON.stringify({boardId:board.id,cardId:'qa-overview'})+').then(s=>s?.count===1)','sandbox state write');report.checks.dashboardDocumentInteraction=true;
    await cdp.evaluate('document.querySelector("[data-card-id=qa-overview] [data-card-close]").click()');await until('!!document.querySelector(".dashboard-card[data-expanded=true]")','expanded card');
    assert.equal(await frameEvaluate('qa-overview','window.qaMarker'), liveDocumentMarker);assert.equal(await frameEvaluate('qa-overview','document.getElementById("count").textContent'),'1');
    await capture('dashboard-expanded');await cdp.pressEscape();await until('!document.querySelector(".dashboard-card[data-expanded=true]")','Escape restores card');report.checks.expandPreservesState=true;
    const resize=await cdp.evaluate('(()=>{const r=document.querySelector("[data-card-id=qa-overview] .dashboard-card__resize").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...resize,button:'left',clickCount:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:resize.x+100,y:resize.y+80,button:'left',buttons:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:resize.x+100,y:resize.y+80,button:'left',clickCount:1});
    await until('!document.querySelector("oc-dashboard").saving','resize save');assert.ok((await rpc('cryoclaw.dashboards.list')).boards.find(b=>b.id===board.id).cards.find(c=>c.id==='qa-overview').layout.h>=360);report.checks.dragResizePersists=true;
    await cdp.evaluate('document.querySelector("[data-card-id=qa-overview] .dashboard-card__drag").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');await until('!document.querySelector("oc-dashboard").saving','reorder save');assert.equal((await rpc('cryoclaw.dashboards.list')).boards.find(b=>b.id===board.id).cards[1].id,'qa-overview');
    await cdp.evaluate('document.querySelector("[data-card-id=qa-overview] .dashboard-card__actions button").click()');await until('document.querySelector("oc-dashboard").error===""','pin no error');await sleep(1500);
    const targets=await cdp.send('Target.getTargets'),pinned=targets.targetInfos.find(t=>t.type==='page'&&t.url.includes('/__cryoclaw__/dashboards/'+board.id+'/qa-overview'));
    assert.ok(pinned,'pinned desktop window');report.checks.desktopPin=true;const pinSession=await cdp.send('Target.attachToTarget',{targetId:pinned.targetId,flatten:true});
    const pinnedState=await cdp.send('Runtime.evaluate',{expression:'cryoclawDashboard.getState()',awaitPromise:true,returnByValue:true},{sessionId:pinSession.sessionId});assert.equal(pinnedState.result.value.count,1);
    const pinnedWrite=await cdp.send('Runtime.evaluate',{expression:'(async()=>{await cryoclawDashboard.setState({count:2});return await cryoclawDashboard.getState();})()',awaitPromise:true,returnByValue:true},{sessionId:pinSession.sessionId});assert.ok(!pinnedWrite.exceptionDetails,'pinned state write must pass browser CORS');assert.equal(pinnedWrite.result.value?.count,2);assert.equal((await rpc('cryoclaw.dashboards.getState',{boardId:board.id,cardId:'qa-overview'})).count,2);report.checks.pinnedStateWrite=true;await cdp.send('Page.close',{}, {sessionId:pinSession.sessionId});
    await cdp.evaluate('(()=>{const frame=document.querySelector("[data-card-id=qa-overview] iframe");frame.src=frame.src;})()');await sleep(800);assert.equal(await frameEvaluate('qa-overview','cryoclawDashboard.getState().then(s=>s.count)'),2,'main card reads the state saved in its pinned window');assert.equal(await frameEvaluate('qa-overview','document.getElementById("count").textContent'),'2','main card restores the pinned edit visibly after refresh');report.checks.pinnedStateShared=true;
    await cdp.evaluate('document.querySelector("[data-card-id=qa-overview] .dashboard-card__tasks").click()');await until('!!document.querySelector("oc-dashboard-tasks dialog[open]")','card task dialog');
    await cdp.evaluate('document.querySelector("oc-dashboard-tasks form").requestSubmit()');let linkedJobId;
    await until('document.querySelector("openclaw-app").client.request("cryoclaw.dashboards.list",{}).then(s=>s.boards.find(b=>b.id==='+JSON.stringify(board.id)+').cards.find(c=>c.id==="qa-overview").taskLinks?.length===1)','native scheduled update linked');
    linkedJobId=(await rpc('cryoclaw.dashboards.list')).boards.find(b=>b.id===board.id).cards.find(c=>c.id==='qa-overview').taskLinks[0].jobId;
    await until('!document.querySelector("oc-dashboard-tasks").busy && document.querySelectorAll(".dashboard-task-links article").length===1','task setup completed');await capture('dashboard-task-link');
    await cdp.evaluate('document.querySelector(".dashboard-task-links article>div:last-child button:last-child").click()');await until('!document.querySelector("oc-dashboard-tasks").busy','task pause and unlink');
    assert.equal((await rpc('cron.list',{includeDisabled:true})).jobs.find(j=>j.id===linkedJobId).enabled,false);await rpc('cron.remove',{id:linkedJobId});await cdp.pressEscape();await until('!document.querySelector("oc-dashboard-tasks")','task dialog closes');report.checks.nativeTaskBinding=true;
    await cdp.evaluate('document.querySelector("oc-dashboard").select('+JSON.stringify((await rpc('cryoclaw.dashboards.list')).boards.find(b=>b.title==='Hello World').id)+')');await sleep(1200);await capture('dashboard-reference-light');
    await cdp.evaluate('document.querySelector("[data-card-id=todo-habits]").scrollIntoView({block:"center"})');await sleep(1000);await capture('dashboard-local-widgets');
    await cdp.evaluate('document.querySelector("[data-card-id=audio-lab]").scrollIntoView({block:"center"})');await sleep(1000);await capture('dashboard-media');
    assert.equal(await frameEvaluate('welcome','cryoclawDashboard.motion.active'),false,'offscreen module pauses motion');await cdp.evaluate('document.querySelector("[data-card-id=welcome]").scrollIntoView({block:"center"})');await sleep(400);assert.equal(await frameEvaluate('welcome','cryoclawDashboard.motion.active'),true,'visible module resumes motion');report.checks.visibilityMotion=true;
    assert.deepEqual(await frameEvaluate('welcome','(async()=>{await new Promise(r=>setTimeout(r,80));return {reduced:cryoclawDashboard.motion.reduced,animation:getComputedStyle(document.body).animationName,visible:Number(getComputedStyle(document.body).opacity)>0.99};})()','reduce'),{reduced:true,animation:'none',visible:true},'reduced motion keeps card content visible');await frameEvaluate('welcome','true','no-preference');report.checks.reducedMotion=true;
    const designWidth=await frameEvaluate('welcome','innerWidth'),wide=await cdp.evaluate('document.querySelector("[data-card-id=welcome]").getBoundingClientRect().width');
    await setViewport(cdp,800,900);await cdp.evaluate('document.documentElement.dataset.theme="dark"');await sleep(700);
    assert.equal(await frameEvaluate('welcome','innerWidth'),designWidth,'window resize preserves iframe design width');assert.ok(await cdp.evaluate('document.querySelector("[data-card-id=welcome]").getBoundingClientRect().width')<wide,'canvas scales down proportionally');report.checks.proportionalCanvas=true;await capture('dashboard-dark-narrow');
    assert.equal(await cdp.evaluate('(()=>{const scroll=document.querySelector(".dashboard-workspace__scroll"),r=scroll.getBoundingClientRect();return getComputedStyle(scroll).overflowX==="hidden"&&[...document.querySelectorAll(".dashboard-card")].every(card=>{const c=card.getBoundingClientRect();return c.left>=r.left-1&&c.right<=r.right+1;});})()'),true,'scaled cards fit without blank horizontal scrolling');report.checks.canvasFitsViewport=true;
    if(process.argv.includes('--live-dashboard'))report.liveDashboard=await require('./lib/live-dashboard-qa').verifyLiveDashboard(cdp,out,board.id);
    if(process.argv.includes('--live-query'))report.liveQuery=await require('./lib/live-query-qa').verifyLiveQuery(cdp,out);
    if(process.argv.includes('--live-cron'))report.liveCron=await require('./lib/live-dashboard-cron-qa').verifyLiveDashboardCron(cdp,out,board.id,key);
    await rpc('cryoclaw.dashboards.mutate',{action:'archive',boardId:board.id});report.checks.archivePersists=true;
    report.checks.noHorizontalOverflow=await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth+1");
    report.checks.noRendererExceptions=cdp.exceptions.length===0;
    assert.ok(Object.values(report.checks).every(Boolean),JSON.stringify(report.checks));
    if(process.argv.includes('--live'))report.liveProvider=await require('./lib/live-deliverables-qa').verifyLiveDeliverables(cdp,out,{reuseHistory:arg(process.argv,'--reuse-live-history',null)});
    if(process.argv.includes('--echo')){
      const run=require('node:util').promisify(require('node:child_process').execFile);
      const result=await run(process.execPath,[path.join(__dirname,'live-chat-cdp-smoke.js'),'--exe',exe,'--attach-port',String(port),'--live'],{windowsHide:true,timeout:300000});
      report.liveEcho=JSON.parse(result.stdout.trim());
    }
    if(process.argv.includes('--release-ui')){
      const code=await require('./release-ui-smoke').main(['node','release-ui-smoke.js','--exe',exe,'--attach-port',String(port),'--full','--out',path.join(out,'ui-release')]);
      assert.equal(code,0,'full installed release UI gate');report.fullReleaseUi=true;
    }
    if(cpuProfile)report.cpuProfile=await cpuProfile;
    const runs=Number(arg(process.argv,"--startup-runs","1"));
    for(let run=1;run<runs;run++){
      await cdp.evaluate(`(()=>{document.querySelector('oc-rail').props.onOpenChat();document.querySelector('oc-session-panel')?.props.onSelectSession(${JSON.stringify(original)});})()`);
      await stop();const started=Date.now();const restartPort=port+run;running=launch(staged.exe,restartPort);const sample={windowMs:null,healthMs:null,readyMs:null,gracefulExit:false};report.startupSamples.push(sample);
      const health=waitForGateway('http://127.0.0.1:18789/healthz',240000,150).then(ok=>{if(ok)sample.healthMs=Date.now()-started;return ok;});
      const page=await waitForPageTarget(restartPort);assert.ok(page,"restart page");sample.windowMs=Date.now()-started;({ws,cdp}=await connect(page));
      assert.ok(await waitForAppReady(cdp,{timeoutMs:240000}),"restart session data ready");sample.readyMs=Date.now()-started;report.startupRunsMs.push(sample.readyMs);assert.ok(await health,'restart gateway health');await dismissReleaseNotes(cdp);
    }
  }catch(error){report.error=String(error.stack||error);if(cdp){report.consoleErrors=cdp.consoleErrors;report.frameTree=await cdp.send('Page.getFrameTree').catch(()=>null);report.targets=await cdp.send('Target.getTargets').catch(()=>null);await capture("failure").catch(()=>{});}throw error;}
  finally{
    if(cdp&&report.dashboardId)report.scheduledFixtureCleanup=await cdp.evaluate(`(async()=>{const client=document.querySelector('openclaw-app').client;const result=await client.request('cron.list',{includeDisabled:true});const jobs=(result.jobs??[]).filter(j=>j.payload?.kind==='agentTurn'&&j.payload.message?.includes('[cryoclaw-dashboard-target]\\nboardId='+${JSON.stringify(report.dashboardId)}+'\\n'));for(const job of jobs)await client.request('cron.remove',{id:job.id});return jobs.length;})()`).catch(()=>null);
    if(cdp && original)await cdp.evaluate(`(()=>{document.querySelector('oc-rail').props.onOpenChat();document.querySelector('oc-session-panel')?.props.onSelectSession(${JSON.stringify(original)});})()`).catch(()=>{});
    if(cpuProfile)report.cpuProfile=await cpuProfile;
    await stop();fs.writeFileSync(path.join(out,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify({out,...report}));await staged.cleanup();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
