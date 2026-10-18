"use strict";
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const {launch,connect,waitForPageTarget,waitForAppReady,waitForSettle,setViewport}=require("./lib/cdp-harness");
(async()=>{
  if(!process.env.OPENCLAW_STATE_DIR || process.env.CRYOCLAW_MULTI_INSTANCE!=="1")throw Error("Use an isolated QA state");
  const {cleanup}=launch(path.resolve("out/win32-x64/win-unpacked/CryoClaw.exe"),9246);let ws,cdp,backup;
  try{
    const page=await waitForPageTarget(9246);assert.ok(page);const connection=await connect(page);ws=connection.ws;cdp=connection.cdp;
    assert.ok(await waitForAppReady(cdp,{timeoutMs:150000}));await setViewport(cdp,1200);
    backup=await cdp.evaluate(`localStorage.getItem('cryoclaw.theme-library.v1')`);
    await cdp.evaluate(`localStorage.removeItem('cryoclaw.theme-library.v1')`);
    const open=async()=>{await cdp.evaluate(`[...document.querySelectorAll('.oc-rail__footer > button.oc-rail__item')].pop().click()`);await waitForSettle(cdp,200);await cdp.evaluate(`[...document.querySelectorAll('.oc-settings-nav-item')].find(el=>/外观|appearance/i.test(el.textContent)).click()`);await waitForSettle(cdp,200);await cdp.evaluate(`document.querySelector('.oc-theme-customize').open=true`);};
    await open();
    await cdp.evaluate(`document.querySelector('.oc-theme-modes [data-mode=light]').click()`);await waitForSettle(cdp,100);
    const upload=async contents=>{await cdp.evaluate(`(() => {const input=document.querySelector('.oc-theme-customize input[type=file]'),transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(contents)}],'test-theme.json',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);await waitForSettle(cdp,300);};
    const name='<img onerror="window.__themeInjected=true">'+"🌿".repeat(100);
    const legacy=JSON.stringify({format:"cryoclaw-theme",version:1,name,appearance:{colors:{accent:"#784f9b",background:"#fffaf4",surface:"#f5eee5",text:"#3f3941",muted:"#746a75"}}});
    await upload(legacy);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.oc-theme-card').length`),5);
    assert.ok(await cdp.evaluate(`!!document.querySelector('.theme-preview-banner') && !document.querySelector('.theme-editor')`),'imports use a reversible preview without opening the full editor');
    assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--bg')`),'#fffaf4');
    assert.ok(await cdp.evaluate(`(() => {const cards=[...document.querySelectorAll('.oc-theme-card[aria-pressed=true]')];return cards.length===1 && !!cards[0].querySelector('.oc-theme-card__imported') && /默认|default/i.test(cards[0].querySelector('.oc-theme-card__fallback').textContent) && !cards[0].querySelector('img') && !window.__themeInjected && Array.from(cards[0].title).length===80;})()`),'imported cards are named, escaped and explain missing dark colors');
    await cdp.evaluate(`document.querySelector('.oc-theme-modes [data-mode=dark]').click()`);await waitForSettle(cdp,100);
    assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--bg')`),'','a missing dark variant clears the light background');
    await cdp.evaluate(`document.querySelector('.oc-theme-modes [data-mode=light]').click()`);await waitForSettle(cdp,100);
    await upload(legacy);
    assert.ok(await cdp.evaluate(`document.querySelector('.oc-theme-card[aria-pressed=true]').title.endsWith(' · 2')`),'duplicate imports never overwrite the earlier theme');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.oc-theme-card').length`),6);
    await upload('{invalid json');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.oc-theme-card').length`),6);
    assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--bg')`),'#fffaf4');
    assert.ok(await cdp.evaluate(`!!document.querySelector('.global-toast--error[role=alert]')`),'invalid imports show a global error and preserve the active preview');
    await upload(JSON.stringify({format:'cryoclaw-theme',version:1,name:'Paired import',appearance:{mode:'dark',palettes:{light:{accent:'#2b6f8a',background:'#fbf8f4',surface:'#f0ece5',text:'#343c43',muted:'#626e78'},dark:{accent:'#9bcde1',background:'#162a3b',surface:'#213c50',text:'#e2edf5',muted:'#a9bfd0'}}}}));
    assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--bg')`),'#fbf8f4','paired-only packages infer the light colors');
    await cdp.evaluate(`document.querySelector('.oc-theme-modes [data-mode=dark]').click()`);await waitForSettle(cdp,100);
    assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--bg')`),'#162a3b');
    for(const width of [1200,800]){await setViewport(cdp,width);await waitForSettle(cdp,100);assert.ok(await cdp.evaluate(`document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('.oc-theme-card')].every(card=>card.scrollWidth<=card.clientWidth+2)`),'long imported names stay inside the grid');}
    const output=path.resolve('out/ui-qa/imported-themes');fs.mkdirSync(output,{recursive:true});await cdp.evaluate(`document.querySelector('.oc-theme-card[aria-pressed=true]').scrollIntoView({block:'center'})`);await waitForSettle(cdp,100);
    const screenshot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'imported.png'),Buffer.from(screenshot.data,'base64'));
    await cdp.send('Page.reload',{});assert.ok(await waitForAppReady(cdp,{timeoutMs:30000}));await open();
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.oc-theme-card__imported').length`),3,'imported themes remain available after reload');
    await cdp.evaluate(`[...document.querySelectorAll('.oc-theme-card')].find(card=>card.title==='Paired import').click();document.querySelector('.oc-theme-modes [data-mode=dark]').click()`);await waitForSettle(cdp,150);
    assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--bg')`),'#162a3b');const panelId=await cdp.evaluate(`document.querySelector('.oc-settings__section').dataset.themeNode`);assert.ok(panelId);
    await upload(JSON.stringify({format:'cryoclaw-theme',version:1,name:'Layout recovery QA',appearance:{components:{[panelId]:{x:0,y:0,radius:12,opacity:0}}}}));
    assert.ok(await cdp.evaluate(`(() => {const banner=document.querySelector('.theme-preview-banner'),rect=banner.getBoundingClientRect();return getComputedStyle(document.querySelector('.oc-settings__section')).opacity==='0' && rect.width>0 && rect.right<=innerWidth && getComputedStyle(banner).opacity==='1';})()`),'the revert banner stays visible even when an imported layout hides settings');
    await cdp.evaluate(`[...document.querySelectorAll('.theme-preview-banner button')].find(button=>/撤销|Revert/.test(button.textContent)).click()`);await waitForSettle(cdp,300);
    assert.ok(await cdp.evaluate(`getComputedStyle(document.querySelector('.oc-settings__section')).opacity==='1' && !document.querySelector('.theme-preview-banner')`),'revert restores a usable interface');
    await upload(JSON.stringify({format:'cryoclaw-theme',version:1,name:'Reset recovery QA',appearance:{components:{[panelId]:{x:30,y:0,radius:12}}}}));
    await cdp.evaluate(`[...document.querySelectorAll('.oc-theme-customize button')].find(button=>/重置主题设置|Reset customization/.test(button.textContent)).click()`);await waitForSettle(cdp,200);
    assert.equal(await cdp.evaluate(`document.querySelector('.oc-settings__section').style.translate`),'','reset also clears imported component positions during preview');
    assert.equal(cdp.exceptions.length,0);
    console.log(JSON.stringify({importCards:true,legacyColors:true,fallback:true,duplicateSafe:true,longNames:true,invalidPreservesTheme:true,pairedOnly:true,reload:true,reversiblePreview:true,hiddenLayoutRecovery:true,componentReset:true,widths:[1200,800],rendererExceptions:0}));
  }finally{
    if(cdp && backup!==undefined)try{await cdp.evaluate(backup===null?`localStorage.removeItem('cryoclaw.theme-library.v1')`:`localStorage.setItem('cryoclaw.theme-library.v1',${JSON.stringify(backup)})`);}catch{}
    ws?.close();cleanup();
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
