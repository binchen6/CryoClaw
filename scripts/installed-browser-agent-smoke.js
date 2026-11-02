// Explicit --live invokes the configured model in a temporary release QA session.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { browserAgentEvidence } = require('./lib/browser-agent-evidence');
const { arg, launch, quitLaunchedApp, waitForPageTarget, connect, waitForAppReady, dismissReleaseNotes, sleep } = require('./lib/cdp-harness');

async function main() {
  assert.ok(process.argv.includes('--live'), 'Use --live to authorize a real model request');
  const exe = arg(process.argv, '--exe', path.join(process.env.LOCALAPPDATA, 'Programs/CryoClaw/CryoClaw.exe'));
  const attached = process.argv.includes('--attach-port');
  const port = Number(arg(process.argv, attached ? '--attach-port' : '--port', '9372'));
  const out = path.resolve(arg(process.argv, '--out', `out/installed-browser-qa/${new Date().toISOString().replace(/[:.]/g, '-')}`));
  fs.mkdirSync(out, { recursive: true });
  const nonce = 'BROWSER_VERIFIED_' + randomUUID();
  const route = '/' + randomUUID();
  const server = http.createServer((request, response) => {
    if (request.url !== route) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<html><head><title>Installed browser verification</title></head><body><h1>Release verification</h1><p id="verification-token">Verification token: ${nonce}</p><label>Name <input id="qa-name"></label><button id="qa-action" onclick="document.body.dataset.clicked='yes'">Confirm</button></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}${route}`;
  let running, cdp, ws, qaKey, settingsSaved = false;
  const report = { ok: false, version: require('../package.json').version, checks: [] };
  const pass = name => { report.checks.push(name); console.log('PASS ' + name); };
  try {
    if (!attached) running = launch(exe, port);
    const page = await waitForPageTarget(port); assert.ok(page, 'Installed app target');
    ({ cdp, ws } = await connect(page));
    assert.ok(await waitForAppReady(cdp, { timeoutMs: 210000 }), 'Connected installed app');
    await dismissReleaseNotes(cdp);
    await cdp.evaluate(`(()=>{const app=document.querySelector('openclaw-app');window.__browserReleaseQA={settings:app.settings,dock:app.dockActiveTab,opened:app.dockOpenedTabs,launcher:app.dockLauncherOpen};app.dockActiveTab='browser';app.dockOpenedTabs=[...new Set([...(app.dockOpenedTabs||[]),'browser'])];app.dockLauncherOpen=false;app.applySettings({...app.settings,cryoclawView:'chat',embeddedBrowserEnabled:true,embeddedBrowserAgentEnabled:true,embeddedBrowserPriority:'builtin',dockCollapsed:false});app.requestUpdate();return true})()`);
    settingsSaved = true;
    await cdp.evaluate("window.cryoclaw.embeddedBrowserAgentPolicy({enabled:true,priority:'builtin'})");
    const deadline = Date.now() + 15000;
    while (!await cdp.evaluate("!!document.querySelector('oc-embedded-browser .embedded-browser__viewport')")) {
      assert.ok(Date.now() < deadline, 'Browser dock appears'); await sleep(100);
    }
    // The desktop bridge must load the native view before the model uses it.
    await cdp.evaluate(`window.cryoclaw.embeddedBrowserNavigate(${JSON.stringify(url)})`);
    const value = await cdp.evaluate("window.cryoclaw.embeddedBrowserEvaluate('document.querySelector(\"#verification-token\").textContent')");
    assert.ok(value.includes(nonce)); pass('installed native browser and trusted bridge');
    await cdp.evaluate("(()=>{const state=window.__browserReleaseQA;state.agentCommands=0;state.disposeAgentOpen=window.cryoclaw.onEmbeddedBrowserAgentOpen(()=>state.agentCommands++);return true})()");
    qaKey = 'agent:main:browser-release-' + Date.now();
    const prompt = `这是内置浏览器发布验收。必须调用 cryoclaw_browser 工具读取当前打开的网页（${url}），使用 snapshot 找到 Verification token。随后分别使用 type 动作在 #qa-name 输入 Installed QA、click 动作点击 #qa-action，最后只回复网页中读取到的完整 token。可以使用网关代码执行包装器调用该工具；不得使用其他浏览器、HTTP、操作系统命令或文件工具。`;
    await cdp.evaluate(`(async()=>{const client=document.querySelector('openclaw-app').client;await client.request('sessions.create',{key:${JSON.stringify(qaKey)},agentId:'main',displayName:'Installed browser release QA'},{timeoutMs:90000});await client.request('chat.send',{sessionKey:${JSON.stringify(qaKey)},message:${JSON.stringify(prompt)},deliver:false,idempotencyKey:crypto.randomUUID()},{timeoutMs:90000});return true})()`, { timeoutMs: 185000 });
    const end = Date.now() + 150000;
    let accepted = false;
    while (Date.now() < end) {
      const result = await cdp.evaluate(`document.querySelector('openclaw-app').client.request('chat.history',{sessionKey:${JSON.stringify(qaKey)},limit:80},{timeoutMs:45000}).then(r=>(${browserAgentEvidence.toString()})(r.messages,${JSON.stringify(nonce)},window.__browserReleaseQA.agentCommands))`, { timeoutMs: 65000 });
      report.evidence = result;
      if (result.errors?.length) throw Error(result.errors.join(';'));
      if (result.accepted) { accepted = true; break; }
      await sleep(1500);
    }
    assert.ok(accepted, 'Actual model called cryoclaw_browser and persisted the page token');
    pass('actual Agent discovers browser tool and reads page');
    assert.deepEqual(await cdp.evaluate("window.cryoclaw.embeddedBrowserEvaluate('({name:document.querySelector(\"#qa-name\").value,clicked:document.body.dataset.clicked})')"), { name: 'Installed QA', clicked: 'yes' });
    pass('actual Agent types and clicks in shared page');
    await cdp.send('Page.bringToFront');
    fs.writeFileSync(path.join(out, 'installed-browser.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: false })).data, 'base64'));
    await cdp.evaluate("window.cryoclaw.embeddedBrowserAgentPolicy({enabled:false,priority:'builtin'})");
    pass('user takeover revokes Agent policy');
    assert.equal(cdp.exceptions.length, 0); pass('zero renderer exceptions');
    report.ok = true;
  } catch (error) { report.error = String(error.stack || error); throw error; }
  finally {
    if (cdp && qaKey) await cdp.evaluate(`document.querySelector('openclaw-app').client.request('sessions.delete',{key:${JSON.stringify(qaKey)},agentId:'main',deleteTranscript:true})`).catch(error => { report.cleanupError = error.message; process.exitCode = 1; });
    if (cdp && settingsSaved) await cdp.evaluate("(async()=>{const app=document.querySelector('openclaw-app'),saved=window.__browserReleaseQA;saved.disposeAgentOpen?.();await window.cryoclaw.embeddedBrowserHide();await window.cryoclaw.embeddedBrowserAgentPolicy({enabled:saved.settings.embeddedBrowserAgentEnabled===true,priority:saved.settings.embeddedBrowserPriority||'builtin'});app.dockActiveTab=saved.dock;app.dockOpenedTabs=saved.opened;app.dockLauncherOpen=saved.launcher;app.applySettings(saved.settings);app.requestUpdate();delete window.__browserReleaseQA;return true})()").catch(error => { report.restoreError = error.message; process.exitCode = 1; });
    if (running) await quitLaunchedApp(running, cdp);
    ws?.close(); await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log('Report ' + out);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
