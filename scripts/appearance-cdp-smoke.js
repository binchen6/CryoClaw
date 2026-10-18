"use strict";
const assert=require("node:assert/strict");
const path=require("node:path");
const fs=require("node:fs");
const {arg,launch,waitForPageTarget,connect,waitForAppReady,waitForSettle,setViewport}=require("./lib/cdp-harness.js");
(async()=>{
  if(!process.env.OPENCLAW_STATE_DIR || process.env.CRYOCLAW_MULTI_INSTANCE!=="1")throw Error("Use an isolated QA state");
  const {cleanup}=launch(arg(process.argv,"--exe",path.resolve("out/win32-x64/win-unpacked/CryoClaw.exe")),9242);
  let ws,cdp,libraryBackup;
  try {
    const page=await waitForPageTarget(9242,90000);assert.ok(page);
    const connection=await connect(page);ws=connection.ws;cdp=connection.cdp;
    assert.ok(await waitForAppReady(cdp,{timeoutMs:150000}));await setViewport(cdp,1200);
    libraryBackup=await cdp.evaluate(`localStorage.getItem('cryoclaw.theme-library.v1')`);
    await cdp.evaluate(`localStorage.removeItem('cryoclaw.theme-library.v1');document.querySelector('openclaw-app').requestUpdate()`);await waitForSettle(cdp,100);
    await cdp.evaluate(`[...document.querySelectorAll('.oc-rail__footer > button.oc-rail__item')].pop()?.click()`);
    await waitForSettle(cdp,400);
    await cdp.evaluate(`[...document.querySelectorAll('.oc-settings-nav-item')].find(e=>/外观|appearance/i.test(e.textContent))?.click()`);
    await waitForSettle(cdp,700);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.oc-theme-modes button').length`),3);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.oc-theme-module').length`),1);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.oc-theme-pair').length`),4);
    await cdp.evaluate(`[...document.querySelectorAll('.oc-theme-library-item .oc-theme-card')].find(button=>button.textContent.includes('Glacier')).click()`);
    await waitForSettle(cdp,150);
    assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--bg')`),'#f5f9ff');
    await cdp.evaluate(`document.querySelector('.oc-theme-modes [data-mode=dark]').click()`);await waitForSettle(cdp,150);
    assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--bg')`),'#101c2b');
    await cdp.evaluate(`document.querySelector('.oc-theme-modes [data-mode=system]').click()`);await waitForSettle(cdp,100);
    for(const [mode,color] of [['dark','#101c2b'],['light','#f5f9ff']]){
      await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:mode}]});await waitForSettle(cdp,200);
      assert.equal(await cdp.evaluate(`document.documentElement.dataset.theme`),mode);
      assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--bg')`),color,'system changes apply the matching custom palette');
    }
    await cdp.evaluate(`document.querySelector('.oc-theme-modes [data-mode=light]').click();document.querySelector('.oc-theme-customize').open=true`);await waitForSettle(cdp,100);
    await cdp.evaluate(`(() => {const input=document.querySelector('.oc-appearance-colors input[type=color]');input.value='#7744aa';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await waitForSettle(cdp,150);
    await cdp.evaluate(`document.querySelector('.oc-theme-modes [data-mode=dark]').click()`);await waitForSettle(cdp,100);
    assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--accent')`),'#8fc9ff');
    await cdp.evaluate(`document.querySelector('.oc-theme-modes [data-mode=light]').click()`);await waitForSettle(cdp,100);
    assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--accent')`),'#7744aa','light customization survives a round trip');
    await cdp.evaluate(`[...document.querySelectorAll('.oc-theme-customize > button')].find(button=>/点选|Pick and adjust/.test(button.textContent)).click()`);await waitForSettle(cdp,100);
    assert.ok(await cdp.evaluate(`!!document.querySelector('.theme-editor__close')`));
    await cdp.evaluate(`document.querySelector('.theme-editor__close').click()`);await waitForSettle(cdp,350);
    assert.equal(await cdp.evaluate(`document.querySelector('.theme-editor')===null`),true,'close button exits live editor');
    await cdp.evaluate(`[...document.querySelectorAll('.oc-theme-library-item .oc-theme-card')].find(button=>button.textContent.includes('Glacier')).click()`);await waitForSettle(cdp,150);
    await cdp.evaluate(`document.querySelector('.oc-theme-module').scrollIntoView({block:'start'})`);await waitForSettle(cdp,150);
    fs.mkdirSync(path.resolve('out/ui-qa/appearance'),{recursive:true});const themeShot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.resolve('out/ui-qa/appearance/paired-themes.png'),Buffer.from(themeShot.data,'base64'));
    assert.equal(await cdp.evaluate(`getComputedStyle(document.querySelector('.oc-settings__section > .btn-row .btn.primary')).backgroundColor`),'rgb(26, 111, 208)','Glacier restores the original CryoBlue primary color');
    const luminance=color=>{const numbers=color.match(/[\d.]+/g).slice(0,3).map(Number);const c=(color.startsWith('color(')?numbers:numbers.map(value=>value/255)).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
    for(const themeName of ['Default','Glacier','Graphite','Tundra']){
      await cdp.evaluate(`[...document.querySelectorAll('.oc-theme-library-item .oc-theme-card')].find(button=>button.textContent.includes('${themeName}')).click()`);await waitForSettle(cdp,100);
      for(const mode of ['light','dark']){
        await cdp.evaluate(`document.querySelector('.oc-theme-modes [data-mode=${mode}]').click();document.querySelector('.oc-theme-module').scrollIntoView({block:'start'})`);await waitForSettle(cdp,150);
        const colors=await cdp.evaluate(`(() => {const button=document.querySelector('.oc-settings__section > .btn-row .btn.primary'),style=getComputedStyle(button);return {fill:style.backgroundColor,text:style.color,secondary:getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim()};})()`);
        const values=[luminance(colors.fill),luminance(colors.text)].sort((a,b)=>a-b);assert.ok((values[1]+.05)/(values[0]+.05)>=4.5,themeName+'/'+mode+' primary label contrast');
        assert.ok(colors.secondary,'paired auxiliary palette');
        const cardColors=await cdp.evaluate(`(() => {const card=document.querySelector('.oc-theme-card'),style=getComputedStyle(card),probe=document.createElement('div');probe.style.backgroundColor='var(--bg-elevated)';document.body.append(probe);const expected=getComputedStyle(probe).backgroundColor;probe.remove();return {fill:style.backgroundColor,text:style.color,expected};})()`);
        assert.equal(cardColors.fill,cardColors.expected,'theme cards use palette surfaces rather than browser gray');
        const cardLuminances=[luminance(cardColors.fill),luminance(cardColors.text)].sort((a,b)=>a-b);assert.ok((cardLuminances[1]+.05)/(cardLuminances[0]+.05)>=4.5,themeName+'/'+mode+' card contrast');
        const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.resolve('out/ui-qa/appearance/'+themeName.toLowerCase()+'-'+mode+'.png'),Buffer.from(shot.data,'base64'));
      }
    }
    await cdp.evaluate(`[...document.querySelectorAll('.oc-theme-library-item .oc-theme-card')].find(button=>button.textContent.includes('Default')).click();document.querySelector('.oc-theme-modes [data-mode=light]').click()`);await waitForSettle(cdp,100);
    await cdp.evaluate(`document.querySelector('.oc-theme-modes [data-mode=system]').click()`);await waitForSettle(cdp,100);
    await cdp.evaluate(`[...document.querySelectorAll('.oc-theme-customize > button')].find(button=>/点选|Pick and adjust/.test(button.textContent)).click()`);await waitForSettle(cdp,100);
    await cdp.evaluate(`document.querySelector('.theme-editor__close').click()`);await waitForSettle(cdp,300);
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});await waitForSettle(cdp,150);
    assert.equal(await cdp.evaluate(`document.documentElement.dataset.theme`),'dark','closing the editor preserves follow-system mode');
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});await waitForSettle(cdp,150);
    await cdp.evaluate(`document.querySelector('.oc-theme-modes [data-mode=light]').click()`);await waitForSettle(cdp,100);
    assert.ok(await cdp.evaluate(`document.fonts.load('14px "Cryo MiSans"','中文界面').then(fonts=>fonts.length>0 && fonts.every(font=>font.status==='loaded'))`),"MiSans loads offline from the packaged application");
    await cdp.evaluate(`(() => {const input=[...document.querySelectorAll('.oc-appearance-editor input[type=range]')].find(input=>input.max==='22');input.value='18';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitForSettle(cdp,200);
    assert.equal(await cdp.evaluate(`getComputedStyle(document.body).fontSize`),"18px");
    await cdp.evaluate(`(() => {const weight=[...document.querySelectorAll('.oc-appearance-editor input[type=range]')].find(input=>input.max==='900');if(!weight)throw Error('continuous font weight slider missing');if(weight.step!=='any')throw Error('font weight must have no preset steps');weight.value='437.5';weight.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitForSettle(cdp,200);
    assert.equal(await cdp.evaluate(`getComputedStyle(document.body).fontWeight`),"437.5");
    await cdp.evaluate(`(() => {const control=[...document.querySelectorAll('oc-range-control')].find(control=>control.max===900);const input=control.querySelector('input[type=number]');input.focus();input.value='437.51';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.blur();})()`);
    await waitForSettle(cdp,150);
    assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--appearance-weight')`),"437.51","precise numerical font weight is retained");
    assert.ok(await cdp.evaluate(`getComputedStyle(document.body).fontVariationSettings.includes('437.51')`),"exact variable-font axis instead of browser font-weight quantization");
    await cdp.evaluate(`[...document.querySelectorAll('oc-range-control')].find(control=>control.max===900).querySelector('input[type=range]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true,cancelable:true}))`);
    await waitForSettle(cdp,150);
    assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--appearance-weight')`),"437.52","fine keyboard increments");
    await cdp.evaluate(`(() => {const control=[...document.querySelectorAll('oc-range-control')].find(control=>control.max===900);window.__qaRangeEvents=0;control.addEventListener('value-change',()=>window.__qaRangeEvents++);const input=control.querySelector('input[type=range]');for(let i=0;i<100;i++){input.value=String(400+i*.1);input.dispatchEvent(new Event('input',{bubbles:true}));}control.value=300;})()`);
    await waitForSettle(cdp,150);
    assert.equal(await cdp.evaluate(`window.__qaRangeEvents`),1,"100 slider inputs coalesce into one preview per frame");
    assert.equal(await cdp.evaluate(`document.documentElement.style.getPropertyValue('--appearance-weight')`),"409.9","a stale parent render never replaces the latest gesture value");
    const output=path.resolve("out/ui-qa/appearance");fs.mkdirSync(output,{recursive:true});
    const screenshot=await cdp.send("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(output,"misans.png"),Buffer.from(screenshot.data,"base64"));
    await cdp.evaluate(`(() => {const select=[...document.querySelectorAll('.oc-appearance-editor select')].find(select=>select.querySelector('option[value=studio]'));select.value='system';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitForSettle(cdp,200);
    assert.ok(await cdp.evaluate(`getComputedStyle(document.body).fontFamily.startsWith('system-ui')`),"system font fallback works");
    for(const width of [1200,800]){await setViewport(cdp,width);await waitForSettle(cdp,200);assert.ok(await cdp.evaluate(`document.documentElement.scrollWidth<=window.innerWidth`));}
    assert.equal(cdp.exceptions.length,0);
    console.log(JSON.stringify({font:"MiSans",loaded:true,fontSizePreview:true,systemFallback:true,themeCards:4,pairedPalettes:true,builtInThemes:4,contrastChecked:true,systemSwitch:true,editorClose:true,widths:[1200,800],rendererExceptions:0}));
  } finally {if(cdp && libraryBackup!==undefined)try{await cdp.evaluate(libraryBackup===null?`localStorage.removeItem('cryoclaw.theme-library.v1')`:`localStorage.setItem('cryoclaw.theme-library.v1',${JSON.stringify(libraryBackup)})`);}catch{}ws?.close();cleanup();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
