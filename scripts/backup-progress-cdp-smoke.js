"use strict";
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {Cdp,httpGetJson,killTree,waitForPageTarget,connect,waitForAppReady,waitForSettle,setViewport,sleep}=require('./lib/cdp-harness');
(async()=>{
  const stateDir=process.env.OPENCLAW_STATE_DIR,cache=path.resolve('.cache');
  if(!stateDir || process.env.CRYOCLAW_MULTI_INSTANCE!=='1' || !path.resolve(stateDir).startsWith(cache+path.sep))throw Error('Use repository-local isolated QA state');
  const id=crypto.randomUUID(),fixture=path.join(stateDir,'workspace','qa-backup-'+id),archive=path.join(cache,'qa-backup-'+id+'.zip');
  fs.mkdirSync(fixture,{recursive:true});fs.writeFileSync(path.join(fixture,'marker.txt'),'Before export');fs.writeFileSync(path.join(fixture,'payload.bin'),crypto.randomBytes(32*1024*1024));
  const child=spawn(path.resolve('out/win32-x64/win-unpacked/CryoClaw.exe'),['--remote-debugging-port=9250','--inspect=127.0.0.1:9251'],{windowsHide:true,stdio:'ignore'});let ws,nodeWs,cdp;
  try{
    let nodePage;for(let i=0;i<60;i++){try{nodePage=(await httpGetJson('http://127.0.0.1:9251/json/list')).body?.[0];if(nodePage)break;}catch{}await sleep(200);}assert.ok(nodePage,'isolated main-process inspector ready');
    nodeWs=new WebSocket(nodePage.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{nodeWs.addEventListener('open',resolve);nodeWs.addEventListener('error',reject);});const main=new Cdp(nodeWs);await main.send('Runtime.enable');
    await main.evaluate(`(() => {const electron=process.mainModule.require('electron');globalThis.__qaOriginalSave=electron.dialog.showSaveDialog;globalThis.__qaOriginalOpen=electron.dialog.showOpenDialog;electron.dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(archive)}});electron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(archive)}]});})()`);
    const page=await waitForPageTarget(9250);assert.ok(page);const connection=await connect(page);ws=connection.ws;cdp=connection.cdp;assert.ok(await waitForAppReady(cdp,{timeoutMs:150000}));await setViewport(cdp,1200);
    const until=async(expr,label,attempts=300)=>{for(let i=0;i<attempts;i++){if(await cdp.evaluate(expr))return;await sleep(100);}throw Error(label);};
    await cdp.evaluate(`[...document.querySelectorAll('.oc-rail__footer > button.oc-rail__item')].pop().click()`);await waitForSettle(cdp,200);await cdp.evaluate(`[...document.querySelectorAll('.oc-settings-nav-item')].find(el=>/备份|backup/i.test(el.textContent)).click()`);await waitForSettle(cdp,200);
    await cdp.evaluate(`(() => {window.__qaArchivePhases=[];window.__qaArchiveUi=[];window.cryoclaw.onArchiveProgress(p=>window.__qaArchivePhases.push(p.phase));window.__qaArchiveObserver=new MutationObserver(()=>{const el=document.querySelector('.oc-backup-progress');if(el && window.__qaArchiveUi.length<100)window.__qaArchiveUi.push(el.textContent);});window.__qaArchiveObserver.observe(document.querySelector('openclaw-app'),{childList:true,subtree:true,characterData:true});document.querySelector('.oc-settings-backup__openclaw-state-actions button').click();})()`);
    await until(`!document.querySelector('.oc-backup-progress') && window.__qaArchivePhases.includes('done')`,'export did not complete');assert.ok(fs.existsSync(archive));assert.ok(await cdp.evaluate(`window.__qaArchiveUi.length>0 && window.__qaArchivePhases.includes('write')`),'export progress reaches the real UI');
    console.log('Native export and UI progress verified');
    fs.writeFileSync(path.join(fixture,'marker.txt'),'After export');await cdp.evaluate(`window.__qaArchivePhases=[];window.__qaArchiveUi=[];document.querySelectorAll('.oc-settings-backup__openclaw-state-actions button')[1].click()`);await until(`!!document.querySelector('[data-confirm-dialog]')`,'import confirmation missing');await cdp.evaluate(`document.querySelector('[data-confirm-dialog] button.danger').click()`);
    await until(`window.__qaArchivePhases.includes('done') && !document.querySelector('.oc-backup-progress')`,'import did not complete',1200);assert.equal(fs.readFileSync(path.join(fixture,'marker.txt'),'utf8'),'Before export');assert.ok(await cdp.evaluate(`window.__qaArchiveUi.length>0 && window.__qaArchivePhases.includes('restart')`),'restore and restart progress visible');
    assert.equal(cdp.exceptions.length,0);console.log(JSON.stringify({nativeExport:true,exportProgressUi:true,nativeImport:true,restoreVerified:true,restartProgress:true,rendererExceptions:0}));
  }finally{try{await cdp?.evaluate(`window.__qaArchiveObserver?.disconnect()`);}catch{}ws?.close();nodeWs?.close();killTree(child);assert.ok(fixture.startsWith(path.resolve(stateDir)+path.sep));fs.rmSync(fixture,{recursive:true,force:true});fs.rmSync(archive,{force:true});}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
