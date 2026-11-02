'use strict';
// Bounded Electron QA with in-memory config and login IPC. Never loads user config.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {connect,waitForPageTarget,killTree,arg}=require('./lib/cdp-harness');
async function main(){
  const root=path.resolve(__dirname,'..');
  const out=path.resolve(arg(process.argv,'--out','.cache/qqbot-ui-qa'));
  fs.mkdirSync(path.join(out,'build'),{recursive:true});
  await require('esbuild').build({absWorkingDir:root,entryPoints:['scripts/lib/qqbot-ui-entry.ts'],outdir:path.join(out,'build'),bundle:true,splitting:true,format:'esm',target:'es2022',tsconfig:'chat-ui/ui/tsconfig.json',entryNames:'entry',nodePaths:[path.join(root,'chat-ui/ui/node_modules')],loader:{'.woff2':'file','.woff':'file','.ttf':'file'},plugins:[{name:'fixture-public-fonts',setup(build){build.onResolve({filter:/^\/fonts\//},args=>({path:path.join(root,'chat-ui/ui/public',args.path)}));}}]});
  fs.writeFileSync(path.join(out,'build/index.html'),'<!doctype html><html lang="zh" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated QQ Bot settings QA</title><link rel="stylesheet" href="entry.css"><style>body{margin:0;padding:24px;overflow:auto;min-width:0}#app{max-width:800px;margin:0 auto}textarea{box-sizing:border-box;resize:vertical}summary{cursor:pointer}</style><main id="app"></main><script type="module" src="entry.js"></script></html>');
  const port=Number(arg(process.argv,'--port','9369'));
  const staged=await require('./lib/stage-electron-runtime').stageElectronRuntime(require('electron'));
  const env={...process.env,CRYOCLAW_QQ_QA_OUT:out};delete env.ELECTRON_RUN_AS_NODE;
  const fd=fs.openSync(path.join(out,'electron.log'),'w');
  const child=spawn(staged.exe,[`--remote-debugging-port=${port}`,path.join(__dirname,'lib/qqbot-ui-fixture.cjs')],{env,windowsHide:true,stdio:['ignore',fd,fd]});
  let ws,cdp;const report={ok:false,environment:{surface:'isolated Electron QQ settings',viewport:[1050,1050],browserPlugin:'not available; repository Electron CDP workflow',userConfig:'never read or written'},checks:[],out};
  const record=(name,details)=>{report.checks.push({name,details});console.log('PASS '+name);};
  const until=async(expression,label)=>{const deadline=Date.now()+12000;while(!await cdp.evaluate(expression)){assert.ok(Date.now()<deadline,label);await new Promise(r=>setTimeout(r,80));}};
  const select=async(id,value)=>cdp.evaluate(`(()=>{const field=document.querySelector(${JSON.stringify('#'+id)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  const clickText=async(text)=>cdp.evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!button)throw Error('Button missing: '+${JSON.stringify(text)});button.click();return true})()`);
  const screenshot=async(name)=>fs.writeFileSync(path.join(out,name+'.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  try{
    const page=await waitForPageTarget(port,30000);assert.ok(page,'Isolated QQ UI target');assert.ok(page.url.includes('qqbot-ui-qa')||page.url.startsWith('file:'),'Local fixture');
    ({ws,cdp}=await connect(page));
    await cdp.send('Page.bringToFront');
    await until("document.querySelector('[data-page-id=\"settings:channels:qqbot\"]')?.dataset.loadState==='ready'",'QQ settings ready');
    assert.equal(await cdp.evaluate('document.title'),'Isolated QQ Bot settings QA');
    assert.ok((await cdp.evaluate('document.body.innerText')).includes('消息能力'));
    assert.equal(await cdp.evaluate('window.cryoclaw.qqQaStats().then(s=>s.attempt)'),0);
    assert.equal(await cdp.evaluate('!!document.querySelector("vite-error-overlay")'),false);
    record('identity, meaningful content, no overlay, QR requires explicit click');

    await select('qqbot-account','work');await select('qqbot-setup-mode','manual');
    await until("document.querySelector('#qqbot-app-id')?.value==='2002'",'Named account selected');
    assert.equal(await cdp.evaluate('document.querySelector("oc-password-input input").value'),'');
    await cdp.evaluate("(()=>{const field=document.querySelector('#qqbot-allowFrom');field.value='USER_A\\n';field.dispatchEvent(new Event('input',{bubbles:true}));return true})()");
    assert.equal(await cdp.evaluate("document.querySelector('#qqbot-allowFrom').value"),'USER_A\n','Allowlist entry keeps a typed newline');
    await cdp.evaluate("(()=>{const field=document.querySelector('#qqbot-allowFrom');field.value='USER_A\\nUSER_B\\n';field.dispatchEvent(new Event('input',{bubbles:true}));return true})()");
    assert.equal(await cdp.evaluate("document.querySelector('#qqbot-allowFrom').value"),'USER_A\nUSER_B\n','Allowlist keeps trailing newline when adding another entry');
    await cdp.evaluate("(()=>{const toggle=[...document.querySelectorAll('oc-toggle-switch')].find(e=>e.label==='私聊流式回复');toggle.querySelector('[role=switch]').click();return true})()");
    await clickText('保存');
    await until("window.__qqFixture.patchCount===1 && window.__qqFixture.config().channels.qqbot.accounts.work.streaming.mode==='partial'",'Account scoped save');
    const saved=await cdp.evaluate('window.__qqFixture.config()');
    assert.equal(saved.channels.qqbot.appId,'1001');assert.equal(saved.channels.qqbot.clientSecret,'__OPENCLAW_REDACTED__');
    assert.equal(saved.channels.qqbot.accounts.work.clientSecretFile,'/fixture/secret');
    assert.deepEqual(saved.channels.qqbot.accounts.work.customAdvanced,{retain:true});
    assert.deepEqual(saved.channels.qqbot.accounts.work.allowFrom,['USER_A','USER_B']);
    assert.equal(saved.channels.qqbot.groups['*'].historyLimit,31);
    assert.equal(saved.plugins.entries.qqbot,undefined);assert.equal(saved.plugins.entries['openclaw-qqbot'].enabled,true);
    assert.ok(!(await cdp.evaluate('document.body.innerText')).includes('/fixture/secret'));
    await screenshot('manual-account');record('named-account save preserves other accounts, existing credentials and advanced config');

    await select('qqbot-setup-mode','qr');await clickText('生成二维码');
    await until("document.querySelector('.oc-weixin-qr-image')?.complete && document.querySelector('.oc-weixin-qr-image')?.naturalWidth===200",'Local SVG QR rendered');
    const first=await cdp.evaluate("document.querySelector('.oc-weixin-qr-image').src");
    assert.ok(first.startsWith('data:image/svg+xml;base64,'));
    await until(`document.querySelector('.oc-weixin-qr-image')?.src!==${JSON.stringify(first)}`,'QR replacement rendered');
    await screenshot('qr-waiting');record('local SVG QR appears and connector replacement refreshes image');
    await select('qqbot-setup-mode','manual');
    await until("window.cryoclaw.qqQaStats().then(s=>s.canceled.length===1)",'Manual mode cancels attempt');
    assert.equal(await cdp.evaluate('!!document.querySelector(".oc-weixin-qr-image")'),false);record('manual mode cancels QR and clears image');

    await select('qqbot-setup-mode','qr');await cdp.evaluate("window.cryoclaw.qqQaScenario('expired')");await clickText('生成二维码');
    await until("document.body.innerText.includes('二维码已过期')",'Expired state localized');
    assert.equal(await cdp.evaluate('!!document.querySelector(".oc-weixin-qr-image")'),false);await screenshot('qr-expired');record('expiry offers localized retry and removes QR');

    await cdp.evaluate("window.cryoclaw.qqQaScenario('error')");await clickText('重新生成二维码');
    await until("document.body.innerText.includes('绑定失败')",'Error state localized');record('failure explains retry');

    await cdp.evaluate("window.cryoclaw.qqQaScenario('success')");
    await cdp.evaluate('window.__qqFixture.gatewayReady=false;window.__qqFixture.linked=true;true');
    await clickText('重新生成二维码');
    await until("document.body.innerText.includes('账号已绑定，网关正在重启')",'Restart recovery shown');
    assert.equal(await cdp.evaluate('document.querySelector("#qqbot-account").value'),'work');
    await select('qqbot-account','default');
    assert.equal(await cdp.evaluate('document.querySelector("#qqbot-account").options.length'),2,'Switching accounts during restart keeps the last loaded account list');
    await cdp.evaluate('window.__qqFixture.gatewayReady=true;true');await clickText('重新加载已绑定账号');
    await until("document.querySelector('#qqbot-account')?.value==='3003'",'Real persisted snapshot loads after reconnect');
    assert.equal(await cdp.evaluate("document.querySelector('#qqbot-dm-policy').value"),'allowlist');
    await screenshot('qr-connected');record('binding success survives gateway restart and reloads persisted account, without secret IPC');

    await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    await screenshot('mobile');assert.equal(await cdp.evaluate('document.documentElement.scrollWidth>innerWidth'),false);record('390px viewport has no horizontal overflow');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.evaluate("window.cryoclaw.qqQaScenario('waiting')");await clickText('生成二维码');
    await until("!!document.querySelector('.oc-weixin-qr-image')",'Last QR started');
    await cdp.evaluate('window.__qqFixture.leave();true');
    await until("window.cryoclaw.qqQaStats().then(s=>s.canceled.length>=2)",'Leave cancels QR');
    const stats=await cdp.evaluate('window.cryoclaw.qqQaStats()');assert.equal(stats.maxActive,1);report.stats=stats;record('leaving settings cancels owner attempt; one poll in flight');
    assert.deepEqual(cdp.exceptions,[]);assert.deepEqual(cdp.consoleErrors,[]);record('no relevant console or runtime errors');
    report.ok=true;
  }catch(error){report.error=String(error.stack||error);if(cdp)report.failureState=await cdp.evaluate("({text:document.body.innerText,options:[...document.querySelectorAll('#qqbot-account option')].map(o=>({value:o.value,selected:o.selected})),config:window.__qqFixture?.config(),getCount:window.__qqFixture?.getCount,messages:[...document.querySelectorAll('oc-message-box')].map(m=>m.message)})").catch(()=>null);throw error;}
  finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));ws?.close();killTree(child);fs.closeSync(fd);await staged.cleanup();console.log('Report '+out);}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
