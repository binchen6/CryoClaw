#!/usr/bin/env node
"use strict";
// One release gate, one app lifetime. Legacy scripts remain useful for targeted diagnosis.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {buildPlan,hardFailures}=require('./lib/release-ui-plan');
const {waitForVisualReady}=require('./lib/ui-readiness');
const {overlapCheckExpr}=require('./lib/overlap-scan');
const {bareI18nScanExpr}=require('./lib/bare-i18n-scan');
const {textOverflowScanExpr,contrastScanExpr}=require('./lib/text-quality-scan');
const {arg,launch,quitLaunchedApp,waitForPageTarget,connect,waitForAppReady,waitForGateway,dismissReleaseNotes,setViewport,setTheme,navigateChecked,waitForLocale}=require('./lib/cdp-harness');
const settingsButton="[...document.querySelectorAll('.oc-rail__footer > button.oc-rail__item')].pop()";

async function observeTransitions(cdp) {
  await cdp.evaluate(`(()=>{if(window.__smokeOriginalTransition || !document.startViewTransition)return;window.__smokeOriginalTransition=document.startViewTransition;document.startViewTransition=function(...args){const transition=window.__smokeOriginalTransition.apply(this,args);window.__smokeTransition=transition;return transition;};})()`);
}

async function settle(cdp,pace=false) {
  await cdp.evaluate(`(${waitForVisualReady.toString()})({paceMs:${pace?600:0}})`);
}

async function click(cdp,expression,{timeoutMs=5000}={}) {
  const deadline=Date.now()+timeoutMs;
  while(!await cdp.evaluate(`(()=>{const b=${expression};return !!b && !b.disabled && b.checkVisibility({contentVisibilityAuto:true});})()`)){
    assert.ok(Date.now()<deadline,`Required control missing or not ready: ${expression}`);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(await cdp.evaluate(`(()=>{const button=${expression};if(!button || button.disabled)return false;button.click();return true;})()`),true,`Required control missing: ${expression}`);
  try{await settle(cdp,true);}catch(error){throw Error(`After clicking ${expression}: ${error.message}`);}
}

async function waitForData(cdp,{timeoutMs=45000}={}) {
  const deadline=Date.now()+timeoutMs;
  while(true){
    const busy=await cdp.evaluate(`(()=>{
      const root=document.querySelector('.cryoclaw-content')??document.querySelector('openclaw-app');
      return [...root.querySelectorAll('[role="status"],[aria-busy="true"],[class*="skeleton"],.wk-nav__hint,.ts-loading,.oc-settings__loading,.muted')].some(el=>{
        if(!el.checkVisibility({contentVisibilityAuto:true,visibilityProperty:true}))return false;
        if(el.closest('.chat-group,.chat-bubble,.ts-row'))return false;
        return el.getAttribute('aria-busy')==='true' || String(el.className).includes('skeleton') || /加载|读取中|获取中|连接中|刷新中|loading|fetching|connecting|refreshing/i.test(el.textContent??'');
      });
    })()`);
    if(!busy)return;
    assert.ok(Date.now()<deadline,'Page data did not become ready; refusing to accept a loading screen');
    await new Promise(resolve=>setTimeout(resolve,150));
  }
}

async function main(argv=process.argv) {
  const exe=arg(argv,'--exe',path.resolve('out/win32-x64/win-unpacked/CryoClaw.exe'));
  const attached=argv.includes('--attach-port');
  const port=Number(arg(argv,attached?'--attach-port':'--port','9230'));
  const out=arg(argv,'--out',path.resolve('out/ui-release',new Date().toISOString().replace(/[:.]/g,'-')));
  fs.mkdirSync(out,{recursive:true});
  const report={exe:path.basename(exe),startedAt:new Date().toISOString(),actionPaceMs:600,phase:'startup',launches:0,scenarios:[],screenshots:0,full:argv.includes('--full')};
  const started=Date.now();let running,ws,cdp,originalAppearance;
  const scan=`(()=>JSON.stringify({overlaps:JSON.parse(${overlapCheckExpr({viewportOnly:false})}),bare:JSON.parse(${bareI18nScanExpr()}),text:JSON.parse(${textOverflowScanExpr()}),contrast:JSON.parse(${contrastScanExpr()}),diagnostics:window.__ocLayoutDiagnostics?.run?.()??null}))()`;
  async function capture(name,baseline=false,checks={}) {
    report.phase=`capture:${name}`;
    const at=Date.now();if(!name.startsWith('behavior-cron-'))await waitForData(cdp);await settle(cdp);
    const result=JSON.parse(await cdp.evaluate(scan));
    const errors=hardFailures({...result,rendererExceptions:cdp.exceptions.length});
    if(Object.values(checks).some(value=>value!==true))errors.push('behavior assertion');
    if(baseline || errors.length || argv.includes('--screenshots-all')){
      const png=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:false,captureBeyondViewport:false});
      fs.writeFileSync(path.join(out,`${name}.png`),Buffer.from(png.data,'base64'));report.screenshots++;
    }
    report.scenarios.push({name,elapsedMs:Date.now()-at,...result,checks,errors});
    console.log(`${errors.length?'FAIL':'PASS'} ${name} (${Date.now()-at}ms)`);
    if(errors.length)throw Error(`${name}: ${errors.join(', ')}`);
  }
  try{
    assert.ok(fs.existsSync(exe),'Installer executable must exist');
    if(!attached){running=launch(exe,port);report.launches++;}else report.sharedLaunch=true;
    const page=await waitForPageTarget(port);assert.ok(page,'App page target');
    ({ws,cdp}=await connect(page));
    await cdp.send('Page.bringToFront');report.phase='app-ready';
    // Match the production gateway deadline and allow its WebSocket reconnect to finish.
    assert.ok(await waitForAppReady(cdp,{timeoutMs:process.platform==='win32'?210000:120000}),'App ready');await dismissReleaseNotes(cdp);
    report.phase='gateway-ready';
    assert.ok(await waitForGateway(undefined,60000),'Gateway ready');
    originalAppearance=await cdp.evaluate(`({theme:document.documentElement.dataset.theme,colorScheme:document.documentElement.style.colorScheme})`);
    await observeTransitions(cdp);
    report.phase='discover-settings';
    await click(cdp,settingsButton);
    const counts=await cdp.evaluate(`({nav:document.querySelectorAll('.oc-rail__nav .oc-rail__item').length,settings:document.querySelectorAll('.oc-settings-nav-item').length})`);
    const plan=buildPlan(counts.nav,counts.settings,report.full);report.plannedScenes=plan.length;
    let language=await cdp.evaluate('document.documentElement.lang.slice(0,2)');
    let interactionsDone=false;
    for(const scene of plan){
      report.phase=`navigate:${scene.name}`;
      if(scene.lang!==language){
        if(!interactionsDone){await interactions(cdp,capture);interactionsDone=true;}
        const url=await cdp.evaluate(`(()=>{const u=new URL(location.href);if(!/index\\.html?$/.test(u.pathname))u.pathname=u.pathname.replace(/[^/]*$/,'index.html');u.searchParams.set('lang',${JSON.stringify(scene.lang)});return u.toString();})()`);
        await navigateChecked(cdp,url);await waitForLocale(cdp,scene.lang);assert.ok(await waitForAppReady(cdp),'Reloaded app ready');await observeTransitions(cdp);language=scene.lang;
      }
      await setViewport(cdp,scene.width,{dsf:scene.dsf});await setTheme(cdp,scene.theme);
      await cdp.send('Emulation.setEmulatedMedia',{features:scene.motion?[{name:'prefers-reduced-motion',value:'reduce'}]:[]});
      if(scene.route==='main')await click(cdp,`document.querySelectorAll('.oc-rail__nav .oc-rail__item')[${scene.index}]`);
      else {await click(cdp,settingsButton);await click(cdp,`document.querySelectorAll('.oc-settings-nav-item')[${scene.index}]`);}
      await capture(scene.name,scene.screenshot);
    }
    if(!interactionsDone)await interactions(cdp,capture);
    report.phase='complete';report.ok=true;
  }catch(error){
    report.ok=false;report.error=error.message;console.error(error.message);
    if(cdp){try{const png=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'failure.png'),Buffer.from(png.data,'base64'));}catch{}}
  }finally{
    if(cdp){
      try{await cdp.evaluate(`(()=>{if(window.__smokeOriginalTransition){document.startViewTransition=window.__smokeOriginalTransition;delete window.__smokeOriginalTransition;delete window.__smokeTransition;}})()`);}catch{}
      report.rendererExceptions=cdp.exceptions;report.consoleErrors=cdp.consoleErrors;
      try{await cdp.send('Emulation.clearDeviceMetricsOverride');await cdp.send('Emulation.setEmulatedMedia',{features:[]});if(originalAppearance)await cdp.evaluate(`(()=>{const a=${JSON.stringify(originalAppearance)};if(a.theme)document.documentElement.dataset.theme=a.theme;else delete document.documentElement.dataset.theme;document.documentElement.style.colorScheme=a.colorScheme;})()`);}catch{}
    }
    if(running)await quitLaunchedApp(running,cdp);ws?.close();report.elapsedMs=Date.now()-started;
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({ok:report.ok,launches:report.launches,scenarios:report.scenarios.length,screenshots:report.screenshots,elapsedMs:report.elapsedMs,out}));
  }
  return report.ok?0:1;
}

async function interactions(cdp,capture){
  await setViewport(cdp,800);await setTheme(cdp,'dark');
  await cdp.send('Emulation.setEmulatedMedia',{features:[]});
  await click(cdp,settingsButton);
  await click(cdp,`[...document.querySelectorAll('.oc-settings-nav-item')].find(x=>/MCP/i.test(x.textContent))`);
  await click(cdp,`[...document.querySelectorAll('.oc-settings-content button')].find(x=>/添加服务器|add server/i.test(x.textContent))`);
  await capture('behavior-mcp-expanded',true);
  await click(cdp,`[...document.querySelectorAll('.oc-settings-content button')].find(x=>/取消|cancel/i.test(x.textContent))`);
  await click(cdp,`[...document.querySelectorAll('.oc-settings-nav-item')].find(x=>/备份|backup/i.test(x.textContent))`);
  await click(cdp,`[...document.querySelectorAll('.oc-settings-content button')].find(x=>/重置配置|恢复出厂|reset config|factory reset/i.test(x.textContent))`);
  assert.equal(await cdp.evaluate(`!!document.querySelector('[data-confirm-dialog]')`),true,'Danger confirmation must open');
  await cdp.pressEscape();await settle(cdp,true);
  await capture('behavior-confirm-cancel',false,{closed:await cdp.evaluate(`!document.querySelector('[data-confirm-dialog]')`)});
  await click(cdp,`[...document.querySelectorAll('.oc-settings-nav-item')].find(x=>/用量|usage/i.test(x.textContent))`);
  await click(cdp,`document.querySelector('oc-context-report summary')`);
  const contextDeadline=Date.now()+30000;
  while(!await cdp.evaluate(`document.querySelectorAll('oc-context-report tbody tr').length>=5`)){
    assert.ok(Date.now()<contextDeadline,'context report must show real bundled skills');await new Promise(resolve=>setTimeout(resolve,150));
  }
  await capture('behavior-context-report-expanded',true,{fingerprint:await cdp.evaluate(`document.querySelector('oc-context-report code')?.textContent.length===16`)});
  await click(cdp,`document.querySelector('oc-context-report summary')`);
  await taskChecks(cdp,capture);
  await toolCardsChecks(cdp,capture);
}

async function taskChecks(cdp,capture){
  await cdp.evaluate(`(()=>{const a=document.querySelector('openclaw-app');window.__releaseSmoke={a,client:a.client,jobs:a.cronJobs,form:a.cronForm,error:a.cronError,busy:a.cronBusy,loading:a.cronLoading,runs:a.cronRuns,runsJobId:a.cronRunsJobId,settings:a.settings,pending:{}};const s=window.__releaseSmoke;s.jobsFixture=['qa-a','qa-b'].map(id=>({id,name:'任务与长路径 '+id,enabled:false,schedule:{kind:'every',everyMs:90000},payload:{kind:'agentTurn',message:'review '+('long-path/'.repeat(20)),timeoutSeconds:123},delivery:{mode:'none'}}));a.client=new Proxy(s.client,{get:(target,key)=>key==='request'?((m,p)=>m==='cron.list'?Promise.resolve({jobs:s.jobsFixture}):m==='cron.runs'?(p.scope==='all'?Promise.resolve({entries:[]}):new Promise(r=>s.pending[p.id]=r)):m==='cron.status'?Promise.resolve({enabled:true}):target.request(m,p)):typeof target[key]==='function'?target[key].bind(target):target[key]});a.cronJobs=s.jobsFixture;a.cronLoading=false;a.cronBusy=false;a.cronError=null;a.cronRuns=[];a.cronRunsJobId=null;a.requestUpdate();})()`);
  await settle(cdp);
  try{
    await click(cdp,`document.querySelector('.oc-rail__nav [data-view="tasks"]')`);
    await click(cdp,`document.querySelectorAll('.ts-tabs [role=tab]')[1]`);
    await click(cdp,`document.querySelectorAll('.cm-list__item')[0]`);
    await click(cdp,`document.querySelectorAll('.cm-list__item')[1]`);
    await cdp.evaluate(`window.__releaseSmoke.pending['qa-a']({entries:[]})`);await settle(cdp);
    await capture('behavior-cron-loading-ownership',false,{newerStillLoading:await cdp.evaluate(`/加载|Loading/i.test(document.querySelector('.cm-detail__history').textContent)`)});
    await cdp.evaluate(`window.__releaseSmoke.pending['qa-b']({entries:[]})`);await settle(cdp);
    await click(cdp,`document.querySelector('.cm-list__item-action')`);
    const roundTrip=await cdp.evaluate(`(()=>{const a=window.__releaseSmoke.a;a.cronBusy=true;a.cronError='Validation failed: '+('long-path/'.repeat(12));a.requestUpdate();return a.cronForm.everyAmount==='90' && a.cronForm.enabled===false && a.cronForm.timeoutSeconds==='123';})()`);
    for(const width of [800,1440]){
      await setViewport(cdp,width);await settle(cdp,true);
      const checks=await cdp.evaluate(`(()=>{const error=document.querySelector('.cm-detail__error'),detail=document.querySelector('.cm-detail');return {disabled:document.querySelector('fieldset.cron-form').disabled,errorAboveForm:error.getBoundingClientRect().bottom<=detail.getBoundingClientRect().top+1};})()`);
      await capture(`behavior-cron-form-${width}`,true,{...checks,roundTrip});
    }
  }finally{
    await cdp.evaluate(`(()=>{const s=window.__releaseSmoke;if(!s)return;Object.assign(s.a,{client:s.client,cronJobs:s.jobs,cronForm:s.form,cronError:s.error,cronBusy:s.busy,cronLoading:s.loading,cronRuns:s.runs,cronRunsJobId:s.runsJobId,settings:s.settings});s.a.requestUpdate();delete window.__releaseSmoke;})()`);
  }
}


async function toolCardsChecks(cdp,capture){
  await click(cdp,`document.querySelectorAll('.oc-rail__nav .oc-rail__item')[0]`);
  await cdp.evaluate(`(()=>{const a=document.querySelector('openclaw-app');window.__toolCardsSmoke={a,messages:a.chatMessages,tools:a.chatToolMessages};a.chatMessages=[{role:'assistant',content:[{type:'toolCall',id:'qa-tool',name:'read',arguments:{path:'qa.txt'}}],timestamp:1},{role:'tool_result',tool_call_id:'qa-tool',content:[{type:'text',text:'fixture contents'}],timestamp:2},{role:'toolResult',content:[{type:'toolCall',name:'exec',arguments:{command:'pwd'},text:''}],timestamp:3}];a.chatToolMessages=[];a.requestUpdate();})()`);
  try{
    await settle(cdp);
    await cdp.evaluate(`document.querySelectorAll('.chat-tools-collapse').forEach(el=>el.open=true)`);await settle(cdp);
    const checks=await cdp.evaluate(`(()=>{const cards=[...document.querySelectorAll('.chat-tool-card')];return {oneCardPerInvocation:cards.length===2,noSyntheticTool:cards.every(el=>el.querySelector('.chat-tool-card__label')?.textContent.trim()!=='Tool'),resultPreserved:cards.some(el=>el.textContent.includes('fixture contents'))};})()`);
    await capture('behavior-tool-cards',true,checks);
  }finally{
    await cdp.evaluate(`(()=>{const s=window.__toolCardsSmoke;if(!s)return;s.a.chatMessages=s.messages;s.a.chatToolMessages=s.tools;s.a.requestUpdate();delete window.__toolCardsSmoke;})()`);
  }
}

if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main,settle,click,waitForData};
