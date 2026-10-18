"use strict";
const path=require('node:path'),assert=require('node:assert/strict');
const {arg,launch,connect,waitForPageTarget,waitForAppReady,waitForSettle,sleep}=require('./lib/cdp-harness');
(async()=>{
  if(!process.env.OPENCLAW_STATE_DIR || process.env.CRYOCLAW_MULTI_INSTANCE!=='1')throw Error('Use isolated QA state');
  const {cleanup}=launch(arg(process.argv,'--exe',path.resolve('out/win32-x64/win-unpacked/CryoClaw.exe')),9254);let ws;
  try{
    const page=await waitForPageTarget(9254);assert.ok(page);const connection=await connect(page);ws=connection.ws;const cdp=connection.cdp;assert.ok(await waitForAppReady(cdp,{timeoutMs:150000}));
    await cdp.evaluate(`document.querySelector('.oc-rail__nav .oc-rail__item').click()`);await waitForSettle(cdp,200);
    const avatarStatuses=[];ws.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method==='Network.responseReceived' && /\/avatar\//.test(message.params.response.url))avatarStatuses.push(message.params.response.status);});await cdp.send('Network.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__qaPreload={connectedAt:0,memory:[]};const timer=setInterval(()=>{const app=document.querySelector('openclaw-app');if(!app)return;if(app.connected && !window.__qaPreload.connectedAt)window.__qaPreload.connectedAt=performance.now();if(app.client && !app.client.__qaObserved){const client=app.client,request=client.request;client.__qaObserved=true;client.request=function(method,...args){if(method==='doctor.memory.status')window.__qaPreload.memory.push(performance.now());return request.call(this,method,...args);};}if(performance.now()>25000)clearInterval(timer);},10);`});
    await cdp.send('Page.reload');assert.ok(await waitForAppReady(cdp,{timeoutMs:60000}));await sleep(11000);
    const memory=await cdp.evaluate(`window.__qaPreload`);assert.equal(memory.memory.length,1,'memory refreshes once after readiness');const delay=memory.memory[0]-memory.connectedAt;assert.ok(delay>=4500 && delay<8500,`memory refresh delay ${Math.round(delay)}ms`);
    assert.ok(avatarStatuses.length>0 && avatarStatuses.every(status=>status===200),'native avatar metadata is authenticated');
    await cdp.evaluate(`[...document.querySelectorAll('.oc-rail__footer > button.oc-rail__item')].pop().click()`);await waitForSettle(cdp,200);await cdp.evaluate(`[...document.querySelectorAll('.oc-settings-nav-item')].find(el=>/软件更新|about|updates/i.test(el.textContent))?.click()`);await waitForSettle(cdp,200);
    const pin=await cdp.evaluate(`window.cryoclaw.kernelCheckUpdate().then(async()=>{const state=await window.cryoclaw.kernelGetUpdateState();return {latest:state.latest,source:state.stableSource,error:state.checkError};})`);
    assert.ok(pin.latest && /^\d+\.\d+\.\d+(?:-\d+)?$/.test(pin.latest),'stable pin is a release version');assert.ok(pin.source,'pin provenance is exposed');
    assert.equal(cdp.exceptions.length,0);console.log(JSON.stringify({avatarAuthenticated:true,memoryRefreshOnce:true,memoryDelayMs:Math.round(delay),stablePin:pin.latest,pinSource:pin.source,offlineFallback:pin.source==='builtin-fallback',rendererExceptions:0}));
  }finally{ws?.close();cleanup();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
