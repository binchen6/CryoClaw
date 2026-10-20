#!/usr/bin/env node
"use strict";
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {arg,waitForPageTarget,connect,setViewport,setTheme,killTree}=require('./lib/cdp-harness');
const {click,settle}=require('./release-ui-smoke');
const {bareI18nScanExpr}=require('./lib/bare-i18n-scan');
const root=path.resolve(__dirname,'..'),out=path.resolve(arg(process.argv,'--out','out/setup-ui'));
async function main(){
  fs.mkdirSync(out,{recursive:true});const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const binary=require('electron');
  const staged=process.platform==='win32'?await require('./lib/stage-electron-runtime').stageElectronRuntime(binary):{exe:binary,cleanup:async()=>{}};
  const logFd=fs.openSync(path.join(out,'electron.log'),'w');
  const child=spawn(staged.exe,['--remote-debugging-port=9348',path.join(__dirname,'lib/setup-smoke-fixture.cjs'),'--out',out],{cwd:root,env,windowsHide:true,stdio:['ignore',logFd,logFd]});
  let launchError;child.once('error',error=>{launchError=error;});
  const results=[];let ws,cdp;const started=Date.now();
  const wait=async(expression)=>{const deadline=Date.now()+12000;while(!await cdp.evaluate(expression)){assert.ok(Date.now()<deadline,'Setup UI did not reach expected state');await new Promise(r=>setTimeout(r,100));}await settle(cdp);};
  const screenshot=async(name)=>{
    await settle(cdp);const facts=await cdp.evaluate(`({overflow:document.documentElement.scrollWidth>innerWidth,bare:JSON.parse(${bareI18nScanExpr()})})`);
    const png=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(png.data,'base64'));results.push({name,...facts});assert.equal(facts.overflow,false);assert.deepEqual(facts.bare,[]);
  };
  try{
    const page=await waitForPageTarget(9348,30000);assert.ok(page,launchError?.message??'Isolated setup page; inspect electron.log');({ws,cdp}=await connect(page));
    await wait(`!!document.querySelector('.oc-setup-ready')`);await setViewport(cdp,800,{height:600});
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.oc-setup-progress-item').length`),4);await screenshot('welcome-800-light');
    await click(cdp,`document.querySelector('.oc-setup-step > .btn-row .primary')`);
    await click(cdp,`[...document.querySelectorAll('.oc-provider-seg__pill')].find(b=>b.textContent.trim()==='OpenAI')`);
    await cdp.evaluate(`(()=>{const input=document.querySelector('.oc-password input');input.value='fixture-fail';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click(cdp,`document.querySelector('.oc-setup-step > .btn-row .primary')`);
    assert.equal(await cdp.evaluate(`document.querySelector('.oc-password input').disabled`),true,'Verification locks credentials');
    await wait(`!document.querySelector('.oc-password input').disabled`);
    assert.equal((await cdp.evaluate(`window.cryoclaw.qaState()`)).saves,0);assert.ok(await cdp.evaluate(`document.querySelector('.oc-setup-inline-error')?.textContent.includes('Fixture verification failed')`));await screenshot('verify-failed-800');
    await cdp.evaluate(`(()=>{const input=document.querySelector('.oc-password input');input.value='fixture-key';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click(cdp,`document.querySelector('.oc-setup-step > .btn-row .primary')`);
    await wait(`document.querySelector('.oc-setup-title')?.textContent.includes('完成') || !!document.querySelector('.oc-setup-options')`);
    const saved=await cdp.evaluate(`window.cryoclaw.qaState()`);assert.equal(saved.saves,1);assert.match(saved.primaryModel,/^openai\//);
    await wait(`!document.querySelector('.oc-setup-step > .btn-row .primary').disabled`);await setTheme(cdp,'dark');await screenshot('completion-800-dark');
    await click(cdp,`document.querySelector('.oc-setup-step > .btn-row .primary')`);
    await wait(`document.querySelector('.oc-setup-inline-error')?.textContent.includes('Fixture startup failed')`);await screenshot('startup-retry-800-dark');
    await click(cdp,`document.querySelector('.oc-setup-step > .btn-row .primary')`);
    await wait(`document.querySelector('.oc-setup-step > .btn-row .primary')?.textContent.includes('打开')`);
    const complete=await cdp.evaluate(`window.cryoclaw.qaState()`);assert.equal(complete.completions,2);assert.equal(complete.lastComplete.enableWebbridge,true);
    await setViewport(cdp,1440,{height:900});await setTheme(cdp,'light');await screenshot('completed-1440-light');
    assert.equal(cdp.exceptions.length,0);return {ok:true,scenarios:results,elapsedMs:Date.now()-started};
  }catch(error){if(cdp){try{await screenshot('failure');}catch{}}return {ok:false,error:error.message,scenarios:results,rendererExceptions:cdp?.exceptions,elapsedMs:Date.now()-started};}
  finally{ws?.close();killTree(child);fs.closeSync(logFd);await staged.cleanup();}
}
main().then(report=>{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));process.exitCode=report.ok?0:1;}).catch(error=>{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({ok:false,error:error.message}));console.error(error);process.exitCode=1;});
