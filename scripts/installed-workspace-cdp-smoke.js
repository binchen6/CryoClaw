'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {connect,waitForPageTarget,arg,setViewport,setTheme}=require('./lib/cdp-harness');
const {waitForVisualReady}=require('./lib/ui-readiness');
async function main(){
  const port=Number(arg(process.argv,'--attach-port','9373')),out=path.resolve(arg(process.argv,'--out','out/ui-release/startup-1103/workspace'));
  fs.mkdirSync(out,{recursive:true});
  const {ws,cdp}=await connect(await waitForPageTarget(port));
  const report={ok:false,checks:[]},pause=ms=>new Promise(r=>setTimeout(r,ms));
  let viewportOverridden=false;
  async function until(expression,label){const deadline=Date.now()+30000;while(!await cdp.evaluate(expression)){assert.ok(Date.now()<deadline,label);await pause(100);}}
  async function menu(selector){
    await cdp.evaluate(`(${waitForVisualReady.toString()})()`);
    await cdp.evaluate(`(()=>{const host=document.querySelector(${JSON.stringify(selector)});window.__menuQa={host,button:host.querySelector('.file-open-menu__toggle'),panel:host.querySelector('[popover]'),events:[]};window.__menuQa.panel.addEventListener('beforetoggle',e=>window.__menuQa.events.push(e.oldState+'>'+e.newState));})()`);
    await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).querySelector('.file-open-menu__toggle').click()`);await pause(180);
    const state=await cdp.evaluate(`(()=>{const host=document.querySelector(${JSON.stringify(selector)}),panel=host.querySelector('[popover]'),p=panel.getBoundingClientRect(),a=host.querySelector('.file-open-menu__split').getBoundingClientRect();return {open:panel.matches(':popover-open'),side:panel.dataset.anchorSide,inBounds:p.left>=10&&p.top>=10&&p.right<=innerWidth-10&&p.bottom<=innerHeight-10,overlap:p.left<a.right&&p.right>a.left&&p.top<a.bottom&&p.bottom>a.top};})()`);
    assert.equal(state.open,true);assert.equal(state.inBounds,true);assert.equal(state.overlap,false);assert.ok(state.side);
    const close=await cdp.evaluate(`(()=>{const host=document.querySelector(${JSON.stringify(selector)}),button=host.querySelector('.file-open-menu__toggle'),panel=host.querySelector('[popover]'),before=panel.matches(':popover-open');button.click();return {before,after:panel.matches(':popover-open'),sameHost:host===window.__menuQa.host,sameButton:button===window.__menuQa.button,samePanel:panel===window.__menuQa.panel,events:window.__menuQa.events,focus:document.activeElement?.className};})()`);assert.equal(close.after,false,JSON.stringify(close));await pause(180);return state;
  }
  try{
    await cdp.evaluate(`(()=>{const app=document.querySelector('openclaw-app');window.__workspaceQaSettings=structuredClone(app.settings);})()`);
    const width=Number(arg(process.argv,'--width','0'));
    if(width){await setViewport(cdp,width);viewportOverridden=true;await setTheme(cdp,'dark');}
    await cdp.evaluate(`document.querySelectorAll('.oc-rail__nav .oc-rail__item')[3].click()`);
    await until(`!!document.querySelector('.wk-nav__file-row .wk-nav__item')`,'workspace file list');
    await cdp.evaluate(`(()=>{const files=[...document.querySelectorAll('.wk-nav__file-row .wk-nav__item')],file=files.find(b=>b.textContent.includes('IDENTITY.md'))||files.find(b=>/\.md\b/.test(b.textContent));if(!file)throw Error('No readable markdown fixture');file.click();})()`);
    await until(`!!document.querySelector('.wk-main oc-file-open-menu')?.path&&!!document.querySelector('.wk-preview__text')`,'workspace file loaded');
    const selected=await cdp.evaluate(`document.querySelector('.wk-main oc-file-open-menu').path`);
    report.checks.push({workspaceMenu:await menu('.wk-main oc-file-open-menu')});
    const focus=await cdp.evaluate(`(()=>{const input=document.querySelector('.wk-nav__search input');input.focus();const probe=document.createElement('input');probe.style.boxShadow='var(--focus-field)';document.body.append(probe);const result=getComputedStyle(input).boxShadow===getComputedStyle(probe).boxShadow&&getComputedStyle(input).outlineStyle==='none';probe.remove();return result;})()`);assert.equal(focus,true);report.checks.push({workspaceFocus:true});
    await cdp.evaluate(`document.querySelector('.wk-main oc-file-open-menu .file-open-menu__toggle').click()`);await pause(180);let shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'workspace-menu.png'),Buffer.from(shot.data,'base64'));await cdp.pressEscape();await pause(180);
    await cdp.evaluate(`document.querySelectorAll('.oc-rail__nav .oc-rail__item')[0].click()`);
    await cdp.evaluate(`document.dispatchEvent(new CustomEvent('cryoclaw:file-preview',{detail:{path:${JSON.stringify(selected)}}}))`);
    await until(`!!document.querySelector('oc-context-dock oc-file-open-menu')?.path`,'Dock preview has Open With');
    report.checks.push({dockMenu:await menu('oc-context-dock oc-file-open-menu')});
    const drag=await cdp.evaluate(`(()=>{const app=document.querySelector('openclaw-app'),d=document.querySelector('.chat-split-container oc-resizable-divider')||document.querySelector('.chat-main')?.nextElementSibling;if(!d?.matches('oc-resizable-divider'))throw Error('Dock divider missing');window.__workspaceQaApply=app.applySettings;window.__workspaceQaWrites=0;app.applySettings=function(...args){window.__workspaceQaWrites++;return window.__workspaceQaApply.apply(this,args);};const r=d.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+80,dx:d.splitRatio>.55?-50:50};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:drag.x,y:drag.y,button:'left',clickCount:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:drag.x+drag.dx,y:drag.y,button:'left',buttons:1});
    const tracking=await cdp.evaluate(`({writes:window.__workspaceQaWrites,transition:getComputedStyle(document.querySelector('.chat-main')).transitionDuration})`);assert.equal(tracking.writes,0);assert.equal(tracking.transition,'0s');
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:drag.x+drag.dx,y:drag.y,button:'left',clickCount:1});assert.equal(await cdp.evaluate('window.__workspaceQaWrites'),1);report.checks.push({dockDrag:tracking,committedOnce:true});
    shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'dock-preview.png'),Buffer.from(shot.data,'base64'));
    assert.deepEqual(cdp.exceptions,[]);report.ok=true;
  }catch(error){report.error=String(error.stack||error);throw error;}
  finally{
    await cdp.evaluate(`(()=>{const app=document.querySelector('openclaw-app');if(window.__workspaceQaApply)app.applySettings=window.__workspaceQaApply;if(window.__workspaceQaSettings)app.applySettings(window.__workspaceQaSettings);delete window.__workspaceQaApply;delete window.__workspaceQaSettings;delete window.__workspaceQaWrites;delete window.__menuQa;})()`).catch(error=>{report.cleanupError=String(error);process.exitCode=1;});
    if(viewportOverridden)await cdp.send('Emulation.clearDeviceMetricsOverride').catch(error=>{report.viewportCleanupError=String(error);process.exitCode=1;});
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));ws.close();
  }
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1});
