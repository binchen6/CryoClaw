"use strict";
const fs=require("node:fs"),path=require("node:path"),http=require("node:http"),assert=require("node:assert/strict");
const {promisify}=require("node:util"),{execFile}=require("node:child_process");
const {launch,waitForPageTarget,connect,waitForAppReady,waitForSettle,setViewport}=require("./lib/cdp-harness");
function themeApi(payload){
  const control=JSON.parse(fs.readFileSync(path.join(process.env.OPENCLAW_STATE_DIR,"cryoclaw.config.json"),"utf8")).gatewayControl;
  return new Promise((resolve,reject)=>{const request=http.request({host:"127.0.0.1",port:control.port,path:"/ui/theme",method:"POST",headers:{authorization:`Bearer ${control.token}`,"content-type":"application/json"}},response=>{
    const chunks=[];response.on("data",chunk=>chunks.push(chunk));response.on("end",()=>{try{const value=JSON.parse(Buffer.concat(chunks));if(response.statusCode!==200 || !value.ok)throw Error(value.error||"Theme API rejected request");resolve(value.result);}catch(error){reject(error);}});
  });request.on("error",reject);request.end(JSON.stringify(payload));});
}
(async()=>{
  if(!process.env.OPENCLAW_STATE_DIR || process.env.CRYOCLAW_MULTI_INSTANCE!=="1")throw Error("Use an isolated QA state");
  const {cleanup}=launch(path.resolve("out/win32-x64/win-unpacked/CryoClaw.exe"),9243);let ws;
  try {
    const page=await waitForPageTarget(9243,90000);assert.ok(page);const connection=await connect(page);ws=connection.ws;const cdp=connection.cdp;
    assert.ok(await waitForAppReady(cdp,{timeoutMs:150000}));await setViewport(cdp,1200);
    assert.ok(await cdp.evaluate(`document.querySelector('openclaw-app').client.request('skills.status',{}).then(report=>report.skills?.some(skill=>skill.name==='cryoclaw-theme-studio' || skill.skillKey==='cryoclaw-theme-studio'))`),"the bundled theme skill is discoverable by the native gateway");
    const helper=path.resolve("out/win32-x64/win-unpacked/CryoClaw Helper.exe");
    const client=path.resolve("out/win32-x64/win-unpacked/resources/resources/gateway.asar.unpacked/node_modules/openclaw/skills/cryoclaw-theme-studio/scripts/theme-client.mjs");
    const inspection=await promisify(execFile)(helper,[client,"inspect"],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1"},windowsHide:true,timeout:20000});
    assert.equal(JSON.parse(inspection.stdout).ok,true,"the actual bundled skill helper can call the live theme API");
    await cdp.evaluate(`[...document.querySelectorAll('.oc-rail__footer > button.oc-rail__item')].pop()?.click()`);await waitForSettle(cdp,300);
    await cdp.evaluate(`[...document.querySelectorAll('.oc-settings-nav-item')].find(e=>/外观|appearance/i.test(e.textContent))?.click()`);await waitForSettle(cdp,400);
    const original=await themeApi({action:"inspect"});assert.ok(original.targets.includes("rangeControl"));
    const target=original.elements.find(id=>/button\//.test(id));assert.ok(target);
    const theme=JSON.parse(JSON.stringify(original.theme));theme.name="Theme Studio QA";theme.appearance.components={[target]:{x:3.5,y:4,radius:13.5,padding:9,fontWeight:450.5}};
    assert.equal((await themeApi({action:"preview",theme})).preview,true);await waitForSettle(cdp,200);
    assert.ok(await cdp.evaluate(`!!document.querySelector('.theme-preview-banner')`));
    assert.ok(await cdp.evaluate(`([...document.querySelectorAll('[data-theme-node]')].find(node=>node.dataset.themeNode===${JSON.stringify(target)})?.style.translate??'').includes('3.5px')`));
    await themeApi({action:"restore"});await waitForSettle(cdp,200);assert.equal((await themeApi({action:"inspect"})).preview,false);
    const lowContrast=JSON.parse(JSON.stringify(original.theme));lowContrast.name='Recovery contrast QA';lowContrast.appearance.colors={accent:'#ffffff',secondary:'#ffffff',background:'#ffffff',surface:'#ffffff',text:'#ffffff',muted:'#ffffff'};delete lowContrast.appearance.palettes;
    await themeApi({action:'preview',theme:lowContrast});await waitForSettle(cdp,150);
    assert.ok(await cdp.evaluate(`(() => {const banner=document.querySelector('.theme-preview-banner'),button=banner.querySelector('.primary'),editor=document.querySelector('.theme-editor');return getComputedStyle(banner).color==='rgb(37, 50, 74)' && getComputedStyle(button).backgroundColor==='rgb(26, 111, 208)' && getComputedStyle(button).color==='rgb(255, 255, 255)' && getComputedStyle(editor).backgroundColor==='rgb(255, 255, 255)';})()`),'recovery controls remain readable under an all-white theme');
    await cdp.evaluate(`document.querySelector('.theme-editor__close').click()`);await waitForSettle(cdp,350);assert.equal((await themeApi({action:'inspect'})).preview,false);
    await cdp.evaluate(`document.querySelector(".oc-theme-customize").open=true`);
    await cdp.evaluate(`[...document.querySelectorAll('.oc-theme-customize > button')].find(button=>/点选|Pick and adjust/.test(button.textContent)).click()`);await waitForSettle(cdp,200);
    await cdp.evaluate(`[...document.querySelectorAll('.theme-editor > button')].find(button=>/选择界面元素|Pick an element/.test(button.textContent)).click()`);await waitForSettle(cdp,100);
    // Real pointer events must select the destructive-safe control without running its click handler.
    const point=await cdp.evaluate(`(() => {const button=[...document.querySelectorAll('.oc-theme-customize > button')].find(button=>/点选|Pick and adjust/.test(button.textContent));button.scrollIntoView({block:'center'});const rect=button.getBoundingClientRect();return {x:rect.left+20,y:rect.top+rect.height/2};})()`);
    await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...point});await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...point});await waitForSettle(cdp,200);
    assert.ok(await cdp.evaluate(`!!document.querySelector('.theme-editor__selection')`),"visual element picking");
    await cdp.evaluate(`(() => {const control=[...document.querySelectorAll('.theme-editor oc-range-control')].find(control=>/水平|Horizontal/.test(control.label));const input=control.querySelector('input[type=number]');input.focus();input.value='12.25';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.blur();})()`);await waitForSettle(cdp,200);
    const changed=await themeApi({action:"inspect"});assert.ok(Object.values(changed.theme.appearance.components).some(part=>part.x===12.25));
    await cdp.evaluate(`[...document.querySelectorAll('.theme-editor__history button')].find(button=>/撤销|Undo/.test(button.textContent)).click()`);await waitForSettle(cdp,200);
    assert.ok(!Object.values((await themeApi({action:"inspect"})).theme.appearance.components).some(part=>part.x===12.25),"undo restores previous properties");
    await cdp.evaluate(`[...document.querySelectorAll('.theme-editor__history button')].find(button=>/重做|Redo/.test(button.textContent)).click()`);await waitForSettle(cdp,200);
    assert.ok(Object.values((await themeApi({action:"inspect"})).theme.appearance.components).some(part=>part.x===12.25),"redo restores edited properties");
    const output=path.resolve("out/ui-qa/theme-studio");fs.mkdirSync(output,{recursive:true});const screenshot=await cdp.send("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(output,"editor.png"),Buffer.from(screenshot.data,"base64"));
    await cdp.pressEscape();await waitForSettle(cdp,200);assert.equal((await themeApi({action:"inspect"})).preview,false);
    await cdp.evaluate(`document.querySelector('.oc-rail__nav .oc-rail__item')?.click()`);await waitForSettle(cdp,400);
    const png=path.resolve("assets/icon.png"),textFile=path.resolve("README.md");
    assert.ok(await cdp.evaluate(`window.cryoclaw.fileThumbnail(${JSON.stringify(png)}).then(value=>typeof value==='string' && value.startsWith('data:image/png'))`),"native image thumbnail");
    await cdp.evaluate(`window.dispatchEvent(new CustomEvent('cryoclaw:file-drop',{detail:{paths:[${JSON.stringify(png)},${JSON.stringify(textFile)}]}}))`);
    for(let attempt=0;attempt<20;attempt++){if(await cdp.evaluate(`!!document.querySelector('.chat-attachment__img')`))break;await waitForSettle(cdp,200);}
    assert.ok(await cdp.evaluate(`!!document.querySelector('.chat-attachment__img')`),"dropped image preview");
    assert.ok(await cdp.evaluate(`!!document.querySelector('.chat-attachment__file-name')`),"document file card");
    await cdp.evaluate(`(() => {const transfer=new DataTransfer();transfer.items.add(new File(['test'],'preview.txt'));document.querySelector('.chat-compose').dispatchEvent(new DragEvent('dragenter',{bubbles:true,dataTransfer:transfer}));})()`);await waitForSettle(cdp,250);
    assert.ok(await cdp.evaluate(`document.querySelector('.chat-compose').dataset.fileDrag==='true' && getComputedStyle(document.querySelector('.chat-compose__drop-hint')).visibility==='visible'`),"file drop blur hint");
    await cdp.evaluate(`document.querySelector('.chat-compose').dispatchEvent(new DragEvent('dragleave',{bubbles:true}))`);
    assert.equal(cdp.exceptions.length,0);console.log(JSON.stringify({api:true,visualPick:true,preciseValue:true,undo:true,redo:true,escapeRestore:true,thumbnails:true,fileCards:true,dropHint:true,rendererExceptions:0}));
  } finally {ws?.close();cleanup();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
