'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto');
const {arg,launch,quitLaunchedApp,waitForPageTarget,connect,waitForAppReady,dismissReleaseNotes,sleep,setViewport,setTheme}=require('./lib/cdp-harness');

async function main(argv=process.argv){
 if(!argv.includes('--live'))throw new Error('Pass --live for the two dedicated provider test messages');
 const exe=path.resolve(arg(argv,'--exe',path.join(process.env.LOCALAPPDATA,'Programs','CryoClaw','CryoClaw.exe')));
 const attached=argv.includes('--attach-port'),port=Number(arg(argv,attached?'--attach-port':'--port','9253'));
 const out=path.resolve(arg(argv,'--out','out/ui-qa/chat-stability-20261030'));fs.mkdirSync(out,{recursive:true});
 const report={startedAt:new Date().toISOString(),exe,ok:false,checks:{},screenshots:[]};
 const write=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));write();
 let running,ws,cdp,key,originalSession,originalTheme;
 async function until(expression,label,timeout=30000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(report.terminalError)throw new Error(report.terminalError);if(await cdp.evaluate(expression))return;await sleep(150);}throw new Error('Timed out: '+label);}
 async function click(selector){
  const expression=`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button||button.disabled)throw Error('Control unavailable');const r=button.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return{x,y,hit:hit?.tagName,hitClass:hit?.className?.baseVal??hit?.className,inside:x>=0&&y>=0&&x<innerWidth&&y<innerHeight,matched:hit?.closest('button')===button};})()`;
  let point=await cdp.evaluate(expression);
  (report.initialClickHits??=[]).push({selector,matched:point.matched});
  if(!argv.includes('--require-immediate-hit')){const deadline=Date.now()+2000;while(!point.matched&&Date.now()<deadline){await sleep(30);point=await cdp.evaluate(expression);}}
  report.lastClick=point;write();assert.ok(point.inside&&point.matched,'intended button receives pointer input');
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
 }
 async function fill(text){await cdp.evaluate(`(()=>{const field=document.querySelector('.chat-compose textarea');field.focus();field.select();})()`);await cdp.send('Input.insertText',{text});await until(`document.querySelector('openclaw-app').chatMessage===${JSON.stringify(text)}`,'draft input');}
 async function screenshot(name){const result=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:false});fs.writeFileSync(path.join(out,name),Buffer.from(result.data,'base64'));report.screenshots.push(name);write();}
 try{
  if(!attached)running=launch(exe,port);
  const page=await waitForPageTarget(port);assert.ok(page,'app page');({ws,cdp}=await connect(page));
  await cdp.send('Network.enable');
  const abortRequests=new Set();
  const sends=new Map();
  ws.addEventListener('message',event=>{
    try{
      const message=JSON.parse(event.data),data=JSON.parse(message.params?.response?.payloadData??'null');
      if(message.method==='Network.webSocketFrameSent'&&data?.method==='chat.send'&&data.params?.sessionKey===key){const timing={sentAt:Date.now()};sends.set(data.id,timing);(report.chatTimings??=[]).push(timing);}
      if(message.method==='Network.webSocketFrameReceived'&&sends.has(data?.id)){const timing=sends.get(data.id);timing.ackMs=Date.now()-timing.sentAt;timing.status=data.payload?.status??(data.ok?'ok':'error');timing.runId=data.payload?.runId;}
      if(message.method==='Network.webSocketFrameReceived'&&data?.event==='chat'&&data.payload?.sessionKey===key){const timing=report.chatTimings?.at(-1);if(timing&&data.payload.state==='delta'&&timing.firstTextMs==null)timing.firstTextMs=Date.now()-timing.sentAt;if(data.payload.state==='error')report.terminalError=String(data.payload.errorMessage??'Gateway chat error');}
      if(message.method==='Network.webSocketFrameSent'&&data?.method==='chat.abort'&&data.params?.sessionKey===key)abortRequests.add(data.id);
      if(message.method==='Network.webSocketFrameReceived'&&abortRequests.has(data?.id)&&data.ok&&data.payload?.aborted===true)report.abortAcknowledged=true;
      if(message.method==='Network.webSocketFrameReceived'&&data?.event==='chat'&&data.payload?.sessionKey===key&&data.payload.state==='aborted')report.abortedEvent=true;
    }catch{}
  });
  assert.ok(await waitForAppReady(cdp,{timeoutMs:210000}),'gateway connected');await dismissReleaseNotes(cdp);
  report.startupConsoleErrorCount=cdp.consoleErrors.length;
  report.page=await cdp.evaluate('({url:location.protocol,title:document.title,blank:!document.body.textContent.trim()})');assert.equal(report.page.url,'file:');assert.equal(report.page.blank,false);
  originalSession=await cdp.evaluate("document.querySelector('openclaw-app').sessionKey");originalTheme=await cdp.evaluate('document.documentElement.dataset.theme');
  key='agent:main:release-smoke-'+Date.now();
  report.sessionKey=key;fs.writeFileSync(path.join(out,'qa-fixtures.json'),JSON.stringify({sessionKey:key}));write();
  await cdp.evaluate(`(async()=>{const app=document.querySelector('openclaw-app');await app.client.request('sessions.create',{key:${JSON.stringify(key)},agentId:'main',displayName:'Composer verification'},{timeoutMs:90000});document.querySelector('oc-rail').props.onOpenChat();await app.updateComplete;document.querySelector('oc-session-panel').props.onSelectSession(${JSON.stringify(key)});return true;})()`,{timeoutMs:100000});
  await until(`(()=>{const app=document.querySelector('openclaw-app');return app.sessionKey===${JSON.stringify(key)}&&!app.chatLoading&&!!document.querySelector('.chat-compose textarea');})()`,'QA session');
  await fill('first');
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
  await until(`document.querySelector('openclaw-app').chatMessage===${JSON.stringify('first\n')}`,'Enter newline');
  report.checks.enterNewline=await cdp.evaluate("(()=>{const a=document.querySelector('openclaw-app');return !a.chatRunId&&!a.chatSending;})()");assert.ok(report.checks.enterNewline);
  const nonce='COMPOSER_ECHO_'+randomUUID(),prompt='通信回声检查：请只逐字回复下一行，不添加解释，不调用工具。\n'+nonce;
  await fill(prompt);const sendStart=Date.now();await click('.chat-compose__send-btn--send');
  await until("(()=>{const a=document.querySelector('openclaw-app');return !!a.chatRunId||a.chatSending||!a.chatMessage;})()",'click accepted');report.checks.clickAccepted=true;write();
  await until(`(()=>{const a=document.querySelector('openclaw-app');return !a.chatRunId&&!a.chatSending&&a.chatMessages.some(m=>m.role==='assistant'&&(Array.isArray(m.content)?m.content.filter(c=>c.type==='text').map(c=>c.text??'').join(''):typeof m.content==='string'?m.content:'').trim()===${JSON.stringify(nonce)});})()`,'real echoed reply and terminal UI',150000);
  report.replyMs=Date.now()-sendStart;report.checks.visibleReplyAndIdle=true;
  report.checks.persistedReply=await cdp.evaluate(`document.querySelector('openclaw-app').client.request('chat.history',{sessionKey:${JSON.stringify(key)},limit:10}).then(r=>r.messages.some(m=>m.role==='assistant'&&(Array.isArray(m.content)?m.content.filter(c=>c.type==='text').map(c=>c.text??'').join(''):m.content??'').trim()===${JSON.stringify(nonce)}))`);assert.ok(report.checks.persistedReply);
  await screenshot('reply-idle.png');
  await fill('这是停止按钮测试，请逐个输出从1到500的整数，不调用工具。');await click('.chat-compose__send-btn--send');
  await until("(()=>{const a=document.querySelector('openclaw-app');return !!a.chatRunId&&!a.chatSending;})()",'remote send accepted');
  await until("!!document.querySelector('.chat-compose__send-btn--stop:not(:disabled)')",'stop available');
  report.stopGeometry=await cdp.evaluate("(()=>{const b=document.querySelector('.chat-compose__send-btn--stop'),i=b.querySelector('.chat-compose__stop-icon');return{width:parseFloat(getComputedStyle(b).width),iconWidth:parseFloat(getComputedStyle(i).width),busy:b.getAttribute('aria-busy')};})()");
  assert.equal(report.stopGeometry.width,34);assert.equal(report.stopGeometry.iconWidth,10);
  await screenshot('stop-available.png');const stopStart=Date.now();await click('.chat-compose__send-btn--stop');
  await until("(()=>{const a=document.querySelector('openclaw-app');return !a.chatRunId&&!a.chatSending&&!a.chatAbortPending;})()",'stop settles',45000);report.stopMs=Date.now()-stopStart;report.checks.stopSettled=true;
  assert.ok(report.abortAcknowledged||report.abortedEvent,'gateway confirms an actual aborted run');report.checks.remoteAbort=true;
  for(const [width,theme] of [[1440,'light'],[800,'dark']]){await setViewport(cdp,width);await setTheme(cdp,theme);await sleep(180);const fits=await cdp.evaluate("(()=>{const r=document.querySelector('.chat-compose__toolbar').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;})()");assert.ok(fits,'toolbar within viewport');await screenshot(`compose-${width}-${theme}.png`);}
  report.checks.noRendererExceptions=cdp.exceptions.length===0;report.rendererExceptions=cdp.exceptions;report.consoleErrors=cdp.consoleErrors;
  report.consoleErrorsAfterReady=cdp.consoleErrors.slice(report.startupConsoleErrorCount);report.checks.noPostReadyConsoleErrors=report.consoleErrorsAfterReady.length===0;
  assert.equal(report.consoleErrorsAfterReady.length,0);
  assert.equal(cdp.exceptions.length,0);report.archiveSha256=createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources','app.asar'))).digest('hex');report.ok=true;
 }catch(error){
  report.error=String(error.stack||error);
  if(cdp){report.failureState=await cdp.evaluate("(()=>{const a=document.querySelector('openclaw-app');return{draftLength:a?.chatMessage?.length,sending:a?.chatSending,run:!!a?.chatRunId,abortPending:a?.chatAbortPending,lastError:a?.lastError,connected:a?.connected,viewport:{width:innerWidth,height:innerHeight}};})()").catch(()=>null);report.rendererExceptions=cdp.exceptions;await screenshot('failure.png').catch(()=>{});}
  throw error;
 }
 finally{
  if(cdp&&key){
   await cdp.evaluate(`(async()=>{const app=document.querySelector('openclaw-app');await app.client.request('chat.abort',{sessionKey:${JSON.stringify(key)}}).catch(()=>{});document.querySelector('oc-session-panel')?.props.onSelectSession(${JSON.stringify(originalSession)});await app.client.request('sessions.delete',{key:${JSON.stringify(key)},agentId:'main',deleteTranscript:true});return true;})()`).then(()=>report.cleaned=true).catch(error=>{report.cleanupError=String(error);report.ok=false;process.exitCode=1;});
  }
  if(cdp&&originalTheme)await setTheme(cdp,originalTheme).catch(()=>{});
  if(running)await quitLaunchedApp(running,cdp);ws?.close();report.finishedAt=new Date().toISOString();write();
 }
 console.log(JSON.stringify({ok:report.ok,out,checks:report.checks,replyMs:report.replyMs,stopMs:report.stopMs}));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
