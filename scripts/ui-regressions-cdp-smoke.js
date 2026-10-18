"use strict";
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const {launch,connect,waitForPageTarget,waitForAppReady,waitForSettle,setViewport}=require("./lib/cdp-harness");
(async()=>{
  const stateDir=process.env.OPENCLAW_STATE_DIR;
  if(!stateDir || process.env.CRYOCLAW_MULTI_INSTANCE!=="1" || !path.resolve(stateDir).startsWith(path.resolve(".cache")+path.sep))throw Error("Use a repository-local isolated QA state");
  const configFile=path.join(stateDir,"openclaw.json"),config=JSON.parse(fs.readFileSync(configFile,"utf8"));
  const previousModels=config.models;
  config.models={...config.models,providers:{...config.models?.providers,"qa-local":{baseUrl:"http://127.0.0.1:9/v1",apiKey:"qa-placeholder",api:"openai-completions",models:[{id:"qa-short",name:"QA model",input:["text","image"],contextWindow:262144,maxTokens:131072}]}}};
  fs.writeFileSync(configFile,JSON.stringify(config,null,2));
  let cleanup=()=>{},ws;
  try{
    ({cleanup}=launch(path.resolve("out/win32-x64/win-unpacked/CryoClaw.exe"),9244));
    const page=await waitForPageTarget(9244);assert.ok(page);const connection=await connect(page);ws=connection.ws;const cdp=connection.cdp;
    assert.ok(await waitForAppReady(cdp,{timeoutMs:150000}));await setViewport(cdp,1200);
    await cdp.evaluate(`document.querySelector('.oc-rail__nav .oc-rail__item').click()`);await waitForSettle(cdp,250);
    for(let i=0;i<60;i++){if(await cdp.evaluate(`document.querySelector('openclaw-app').chatLoading===false`))break;await waitForSettle(cdp,200);}
    await cdp.evaluate(`(() => {const app=document.querySelector('openclaw-app');app.chatLoading=false;app.chatMessages=[];app.chatToolMessages=[];app.chatStream=null;app.chatThinkingStream=null;app.chatNarrationText=null;app.requestUpdate();})()`);await waitForSettle(cdp,200);
    assert.ok(await cdp.evaluate(`(() => {const icons=[...document.querySelectorAll('.chat-hero__chip-icon')];return icons.length===4 && icons.every(icon=>getComputedStyle(icon).backgroundColor==='rgba(0, 0, 0, 0)' && getComputedStyle(icon.querySelector('svg')).fill==='none');})()`),'starter icons have transparent backgrounds');
    assert.ok(await cdp.evaluate(`(() => {const buttons=[...document.querySelectorAll('.chat-hero__chip')];buttons.forEach(button=>button.disabled=true);const transparent=buttons.every(button=>getComputedStyle(button.querySelector('.chat-hero__chip-icon')).backgroundColor==='rgba(0, 0, 0, 0)');buttons.forEach(button=>button.disabled=false);return transparent;})()`),'disabled starter icons stay transparent');
    await cdp.evaluate(`(() => {const app=document.querySelector('openclaw-app');app.chatLoading=false;app.chatMessages=[{role:'user',id:'qa-short-message',content:[{type:'text',text:'Hi'}],timestamp:Date.now()},{role:'assistant',content:[{type:'text',text:'A longer reply to check message controls.'}],timestamp:Date.now()+1}];app.requestUpdate();})()`);await waitForSettle(cdp,400);
    assert.ok(await cdp.evaluate(`(() => {const bubbles=[...document.querySelectorAll('.chat-message-shell')].filter(el=>el.querySelector('.chat-message-actions'));return bubbles.length>=2 && bubbles.every(bubble=>{const text=bubble.querySelector('.chat-bubble'),row=bubble.querySelector('.chat-message-actions');return !!text && row.getBoundingClientRect().top>=text.getBoundingClientRect().bottom-1 && [...row.querySelectorAll('button')].every(button=>getComputedStyle(button).position!=='absolute');});})()`),"message action rows stay below text even for a one-word message");
    await cdp.evaluate(`(() => {const meter=document.createElement('oc-model-quota');meter.id='qa-quota-meter';meter.style.cssText='position:fixed;bottom:100px;left:350px;z-index:200';document.body.append(meter);})()`);await waitForSettle(cdp,200);
    assert.ok(await cdp.evaluate(`(() => {const meter=document.querySelector('#qa-quota-meter'),button=meter.querySelector('button');return button.dataset.state==='unknown' && Number(getComputedStyle(button.querySelector('svg')).opacity)<.5 && !button.querySelector('.chat-quota__fill') && button.textContent.trim()!=='0' && button.getBoundingClientRect().width>=32;})()`),'unknown quota remains subtle without implying zero');
    await cdp.evaluate(`(() => {const sentinel=document.createElement('button');sentinel.id='qa-quota-focus-start';sentinel.style.cssText='position:fixed;bottom:0;left:0;opacity:.01';document.querySelector('#qa-quota-meter').before(sentinel);sentinel.focus();})()`);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9});await waitForSettle(cdp,180);
    assert.ok(await cdp.evaluate(`Number(getComputedStyle(document.querySelector('#qa-quota-meter button svg')).opacity)>.8`),'keyboard focus restores quota affordance');
    await cdp.evaluate(`document.querySelector('#qa-quota-meter button').click()`);await waitForSettle(cdp,150);
    assert.ok(await cdp.evaluate(`!!document.querySelector('#qa-quota-meter .chat-quota__details:popover-open')`),'unknown quota details remain available');
    await cdp.pressEscape();
    await cdp.evaluate(`(() => {const meter=document.querySelector('#qa-quota-meter');meter.client={request:async()=>({updatedAt:Date.now(),providers:[{provider:'qa-known',windows:[{label:'Week',usedPercent:25}]}]})};meter.provider='qa-known';meter.connected=true;})()`);await waitForSettle(cdp,250);
    assert.ok(await cdp.evaluate(`(() => {const button=document.querySelector('#qa-quota-meter button');return button.dataset.state==='known' && button.textContent.trim()==='75' && Number(getComputedStyle(button.querySelector('svg')).opacity)===1;})()`),'known limits retain their normal appearance');
    await cdp.evaluate(`document.querySelector('#qa-quota-meter').remove();document.querySelector('#qa-quota-focus-start').remove();document.activeElement?.blur()`);
    const output=path.resolve("out/ui-qa/ui-regressions");fs.mkdirSync(output,{recursive:true});
    const point=await cdp.evaluate(`(() => {const node=document.querySelector('.chat-group.user .chat-bubble');const rect=node.getBoundingClientRect();return {x:rect.left+10,y:rect.top+10};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await waitForSettle(cdp,150);
    let screenshot=await cdp.send("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(output,"message-actions.png"),Buffer.from(screenshot.data,"base64"));
    await cdp.evaluate(`[...document.querySelectorAll('.oc-rail__footer > button.oc-rail__item')].pop().click()`);await waitForSettle(cdp,250);
    await cdp.evaluate(`[...document.querySelectorAll('.oc-settings-nav-item')].find(el=>/模型|models/i.test(el.textContent)).click()`);
    for(let i=0;i<60;i++){if(await cdp.evaluate(`[...document.querySelectorAll('.oc-provider-card')].some(el=>el.textContent.includes('qa-short'))`))break;await waitForSettle(cdp,500);}
    await cdp.evaluate(`(() => {const card=[...document.querySelectorAll('.oc-provider-card')].find(el=>el.textContent.includes('qa-short'));if(!card)throw Error('QA model card absent');card.querySelector('.oc-provider-card__actions button').click();})()`);await waitForSettle(cdp,350);
    for(const width of [1200,800]){
      await setViewport(cdp,width);await waitForSettle(cdp,150);
      assert.ok(await cdp.evaluate(`(() => {const dialog=document.querySelector('dialog.oc-provider-edit-drawer__backdrop');if(!dialog?.matches(':modal'))return false;const rect=dialog.getBoundingClientRect(),panel=dialog.querySelector('aside').getBoundingClientRect();return rect.left===0 && rect.top===0 && Math.abs(rect.width-innerWidth)<2 && Math.abs(rect.height-innerHeight)<2 && panel.right<=innerWidth+1 && panel.left>=0 && dialog.contains(document.activeElement);})()`),`modal backdrop covers the full ${width}px viewport in the top layer`);
    }
    screenshot=await cdp.send("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(output,"model-editor.png"),Buffer.from(screenshot.data,"base64"));
    await cdp.evaluate(`document.querySelector('[data-dialog-dismiss]').click()`);await waitForSettle(cdp,350);
    assert.equal(await cdp.evaluate(`document.querySelector('dialog.oc-provider-edit-drawer__backdrop')===null`),true);
    assert.equal(cdp.exceptions.length,0);
    console.log(JSON.stringify({messageActionsBelowText:true,transparentStarterIcons:true,unknownQuotaSubtle:true,unknownQuotaInteractive:true,knownQuotaNormal:true,modalTopLayer:true,fullViewportBackdrop:true,closeButton:true,widths:[1200,800],rendererExceptions:0}));
  }finally{
    ws?.close();cleanup();
    const current=JSON.parse(fs.readFileSync(configFile,"utf8"));if(previousModels===undefined)delete current.models;else current.models=previousModels;fs.writeFileSync(configFile,JSON.stringify(current,null,2));
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
