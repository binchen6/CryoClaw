"use strict";
const assert = require("node:assert/strict"), path = require("node:path");
const { arg, launch, connect, waitForPageTarget, waitForAppReady, waitForSettle, setViewport } = require("./lib/cdp-harness");
(async () => {
  if (!process.env.OPENCLAW_STATE_DIR || process.env.CRYOCLAW_MULTI_INSTANCE !== "1") throw Error("Isolated QA state required");
  const { cleanup } = launch(path.resolve(arg(process.argv, "--exe", "out/next-review/win-unpacked/CryoClaw.exe")), 9258);
  let ws;
  try {
    const page = await waitForPageTarget(9258); assert.ok(page);
    const connection = await connect(page); ws = connection.ws; const cdp = connection.cdp;
    assert.ok(await waitForAppReady(cdp, { timeoutMs: 150000 }));
    const until = async (expression, label) => { for (let i = 0; i < 400; i++) { if (await cdp.evaluate(expression)) return; await waitForSettle(cdp, 100); } throw Error(label); };
    await cdp.evaluate(`document.querySelector('.oc-rail__nav .oc-rail__item').click()`);
    await until(`!document.querySelector('openclaw-app').chatLoading`, "History ready");
    await cdp.evaluate(`(()=>{const app=document.querySelector('openclaw-app');app.chatMessage='';app.requestUpdate();})()`);
    await waitForSettle(cdp, 100); await cdp.evaluate(`document.querySelector('.chat-compose textarea').focus()`);
    await cdp.send("Input.insertText", { text: "/" });
    await until(`document.querySelectorAll('.chat-cmd-suggest__item').length>0`, "Native slash catalog appeared after typing");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await until(`!document.querySelector('.chat-cmd-suggest')`, "Escape dismisses candidates");
    await cdp.evaluate(`(()=>{const field=document.querySelector('.chat-compose textarea');field.value='/model ';field.setSelectionRange(7,7);field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));})()`);
    await until(`document.querySelectorAll('.chat-cmd-suggest__item').length>0`, "Model argument choices appeared");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
    assert.match(await cdp.evaluate(`document.querySelector('openclaw-app').chatMessage`), /^\/model qa-local\//);
    await cdp.evaluate(`document.querySelector('[aria-controls=conversation-info]').click()`);
    await until(`!!document.querySelector('#conversation-info')`, "Conversation info opened");
    assert.ok(await cdp.evaluate(`!document.querySelector('.chat-plan-panel') && /来源文件|Source files/.test(document.querySelector('#conversation-info').textContent)`));
    // Reverse an exit before it finishes: the obsolete timer must not hide the reopened panel.
    await cdp.evaluate(`(()=>{const button=document.querySelector('[aria-controls=conversation-info]');button.click();button.click();})()`);
    await waitForSettle(cdp, 250); assert.ok(await cdp.evaluate(`!!document.querySelector('#conversation-info:not(.is-leaving)')`));
    await cdp.evaluate(`document.querySelector('#conversation-info header button').click()`);
    const root = path.join(process.env.OPENCLAW_STATE_DIR, "workspace");
    await cdp.evaluate(`(()=>{const app=document.querySelector('openclaw-app');app.chatMessage='';app.applySettings({...app.settings,pinnedWorkspaces:[{id:'qa-native',name:'QA native workspace',path:${JSON.stringify(root)},icon:'📁'}]});const client=app.client,request=client.request.bind(client);client.request=(method,params)=>{if(method==='sessions.create')window.__qaCreated=params;return request(method,params);};})()`);
    await until(`!!document.querySelector('.oc-panel__workspace-action:not(.oc-panel__workspace-action--danger)')`, "Workspace row");
    await cdp.evaluate(`document.querySelector('.oc-panel__workspace-action:not(.oc-panel__workspace-action--danger)').click()`);
    await until(`(()=>{const app=document.querySelector('openclaw-app');return app.settings.sessionWorkspaceMap[app.sessionKey]==='qa-native';})()`, "Native workspace conversation created");
    assert.equal(await cdp.evaluate(`window.__qaCreated.cwd`), root);
    await until(`!document.querySelector('openclaw-app').chatLoading`, "New conversation ready");
    await cdp.evaluate(`(()=>{const app=document.querySelector('openclaw-app');app.chatMessages=[{role:'user',content:[{type:'text',text:'Update file'}],timestamp:Date.now()},{role:'assistant',content:[{type:'toolcall',name:'write',arguments:{path:'src/changed.ts',content:'example'}}],timestamp:Date.now()+1}];app.chatToolMessages=[];app.requestUpdate();})()`);
    await until(`!!document.querySelector('oc-turn-files .chat-turn-files')`, "Turn file capsule");
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.chat-group .chat-file-changes').length`), 0);
    const summaryBounds = await cdp.evaluate(`(()=>{const r=document.querySelector('.chat-turn-files summary').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...summaryBounds });
    await waitForSettle(cdp, 200);
    assert.ok(await cdp.evaluate(`document.querySelector('.chat-turn-files__popover').checkVisibility()`), "Hover opens the visible details without clicking");
    await cdp.evaluate(`document.querySelector('.chat-turn-files summary').click()`);
    assert.ok(await cdp.evaluate(`document.querySelector('.chat-turn-files__path').textContent.includes('src/changed.ts')`));
    for (const width of [800, 1200]) { await setViewport(cdp, width); await waitForSettle(cdp, 150); assert.ok(await cdp.evaluate(`document.documentElement.scrollWidth<=innerWidth`)); }
    assert.deepEqual(cdp.exceptions, []);
    console.log(JSON.stringify({ nativeSlashCatalog: true, modelCompletion: true, escape: true, conversationInfo: true, interruptibleExit: true, nativeWorkspaceCwd: true, turnFileCapsule: true, hoverDetails: true, widths: [800, 1200], rendererExceptions: 0 }));
  } finally { ws?.close(); cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
