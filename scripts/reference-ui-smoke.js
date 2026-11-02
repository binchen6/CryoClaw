'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const net = require('node:net');

async function assertPortAvailable(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({port, host:'127.0.0.1', exclusive:true}, resolve);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
const { arg, connect, waitForPageTarget, setViewport, setTheme, killTree } = require('./lib/cdp-harness');
const root = path.resolve(__dirname, '..');

async function main(argv = process.argv) {
  const out = path.resolve(arg(argv, '--out', 'out/ui-qa/reference-refinement'));
  fs.mkdirSync(out, { recursive: true });
  const port = Number(arg(argv, '--port', '9352'));
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Valid CDP port');
  await assertPortAvailable(port);
  const marker = randomUUID();
  const binary = require('electron');
  const staged = process.platform === 'win32'
    ? await require('./lib/stage-electron-runtime').stageElectronRuntime(binary)
    : { exe: binary, cleanup: async () => {} };
  const env = { ...process.env, CRYOCLAW_REFERENCE_MARKER: marker };
  delete env.ELECTRON_RUN_AS_NODE;
  const fd = fs.openSync(path.join(out, 'electron.log'), 'w');
  const child = spawn(staged.exe, [`--remote-debugging-port=${port}`, path.join(__dirname, 'lib/reference-ui-fixture.cjs'), '--out', out], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', fd, fd],
  });
  let launchError, ws, cdp;
  child.once('error', error => { launchError = error; });
  const report = { ok: false, scenarios: [] };
  async function until(expression, label) {
    const deadline = Date.now() + 20000;
    while (!await cdp.evaluate(expression)) {
      assert.ok(Date.now() < deadline, label);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try {
    const page = await waitForPageTarget(port, 30000);
    assert.ok(page, launchError?.message ?? 'Isolated renderer target; inspect electron.log');
    assert.equal(new URL(page.url).searchParams.get('qaMarker'), marker, 'Only this isolated fixture may be controlled');
    ({ ws, cdp } = await connect(page));
    await until("!!document.querySelector('openclaw-app')?.updateComplete", 'App loaded');
    await cdp.evaluate(`(async () => {
      const app = document.querySelector('openclaw-app');
      const client = app.client;
      if (!client?.opts?.onEvent) throw new Error('Gateway event callback unavailable');
      client.stop();
      window.__qaGatewayEvent = client.opts.onEvent;
      app.tab = 'chat'; app.connected = true; app.chatLoading = false;
      app.chatSending = false; app.chatRunId = null;
      app.chatMessages = [{role:'user',content:[{type:'text',text:'请检查工作区的改动。'}]},
        {role:'assistant',content:[{type:'text',text:'正在检查工作区，并整理当前进度。\\n\\n这是一条隔离测试消息，不会调用模型或修改真实会话。'}]}];
      app.chatAbortPending = false; app.lastError = null;
      window.__qaRequests = [];
      client.request = (method) => {
        window.__qaRequests.push(method);
        if (method === 'chat.send') return Promise.resolve({runId:'qa-isolated-run',status:'started'});
        if (method === 'chat.abort') return new Promise(resolve => { window.__qaResolveAbort = resolve; });
        // Unrelated services deliberately stay pending: malformed catch-all {} replies
        // can corrupt typed state (e.g. sessions.list requires a sessions array).
        return new Promise(() => {});
      };
      // Seed the real per-session runtime through Send, rather than mutating only
      // the visible projection while its runtime still describes an idle chat.
      app.chatMessage = '这是隔离停止验证，不会调用真实模型。';
      await app.handleSendChat();
      app.sessionsResult = {sessions:[{key:app.sessionKey,totalTokens:3000,contextTokens:100000}]};
      app.dirtyMeterSessions = new Set();
      app.requestUpdate(); await app.updateComplete; return true;
    })()`);
    await until("!!document.querySelector('.chat-compose__send-btn--stop')", 'Stop rendered');
    await cdp.send('Page.bringToFront');
    for (const width of [1440, 800]) {
      for (const theme of ['light', 'dark']) {
        await setViewport(cdp, width, { height: 1000 });
        await setTheme(cdp, theme);
        await cdp.evaluate(`(async () => {
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await Promise.all(document.getAnimations().filter(animation =>
            Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
        })()`);
        const facts = await cdp.evaluate(`(() => {
          const b = document.querySelector('.chat-compose__send-btn--stop');
          const glyph = b.querySelector('.chat-compose__stop-icon');
          const style = getComputedStyle(b), iconStyle = getComputedStyle(glyph);
          const sample = document.createElement('span');
          sample.style.color = 'var(--destructive)'; b.append(sample);
          const expectedIcon = getComputedStyle(sample).color;
          sample.style.color = 'var(--bg-input)';
          const expectedSurface = getComputedStyle(sample).color; sample.remove();
          const toolbar = document.querySelector('.chat-compose__toolbar').getBoundingClientRect();
          return {background:style.backgroundColor, color:iconStyle.backgroundColor, expectedIcon, expectedSurface,
            buttonWidth:b.getBoundingClientRect().width, iconWidth:glyph.getBoundingClientRect().width,
            toolbarFits:toolbar.left>=0 && toolbar.right<=innerWidth+1,
            horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
            textareaScrollbar:getComputedStyle(document.querySelector('.chat-compose textarea')).scrollbarWidth,
            ring:(()=>{const ring=document.querySelector('.chat-compose__ctx-ring'),svg=ring.querySelector('svg');return {
              width:ring.getBoundingClientRect().width,height:ring.getBoundingClientRect().height,
              svgWidth:svg.getBoundingClientRect().width,stroke:getComputedStyle(svg.querySelector('circle')).strokeWidth,
              numeral:ring.innerText.trim(),svgText:!!svg.querySelector('text'),value:ring.getAttribute('aria-valuenow'),
              dash:svg.querySelector('.chat-compose__ctx-ring-fill').getAttribute('stroke-dasharray'),
              border:getComputedStyle(ring).borderTopWidth,background:getComputedStyle(ring).backgroundColor};})()};
        })()`);
        report.scenarios.push({ width, theme, ...facts });
        const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(out, `composer-${width}-${theme}.png`), Buffer.from(image.data, 'base64'));
        assert.equal(facts.color, facts.expectedIcon, 'Stop uses the destructive glyph, never the inherited send color');
        assert.equal(facts.background, facts.expectedSurface, 'Stop uses the fully settled neutral input surface');
        assert.notEqual(facts.background, 'rgb(0, 0, 0)', 'Stop must not use a black surface');
        assert.equal(facts.buttonWidth, 34); assert.equal(facts.iconWidth, 10);
        assert.ok(facts.toolbarFits); assert.equal(facts.horizontalOverflow, false);
        assert.equal(facts.textareaScrollbar, 'none');
        assert.deepEqual(facts.ring,{width:28,height:28,svgWidth:20,stroke:'1.5px',numeral:'',svgText:false,
          value:'3',dash:'3.0 100',border:'0px',background:'rgba(0, 0, 0, 0)'});
      }
    }
    await cdp.evaluate("document.querySelector('.chat-compose__ctx-ring').focus();true");
    await until("!!document.querySelector('.chat-compose__ctx-details:popover-open')",'Keyboard focus opens real usage details');
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:10,y:10});
    await cdp.evaluate("document.querySelector('.chat-compose__ctx-ring').dispatchEvent(new PointerEvent('pointerleave'));true");
    await new Promise(resolve=>setTimeout(resolve,220));
    assert.equal(await cdp.evaluate("!!document.querySelector('.chat-compose__ctx-details:popover-open') && document.querySelector('.chat-compose__ctx-details').textContent.includes('3,000 / 100,000')"),true);
    await cdp.evaluate("document.querySelector('.chat-compose__ctx-ring').click();true");
    await until("!document.querySelector('.chat-compose__ctx-details:popover-open')",'Same usage trigger closes details');
    await cdp.evaluate("document.querySelector('.chat-compose__ctx-ring').click();true");
    await until("!!document.querySelector('.chat-compose__ctx-details:popover-open')",'Usage details reopen by click');
    await cdp.evaluate("document.querySelector('.chat-compose__ctx-ring').blur();document.querySelector('.chat-compose__ctx-details').hidePopover();true");
    report.contextRing={numeralFree:true,realUsage:true,lightDarkAndNarrow:true,keyboardFocus:true,triggerToggle:true};
    // Exercise the actual abort handler without a provider: one click, pending state,
    // duplicate-input guard, then ACK and terminal event settle the run separately.
    await cdp.evaluate(`(() => {
      const button = document.querySelector('.chat-compose__send-btn--stop');
      button.focus(); button.click();
    })()`);
    await until("document.querySelector('openclaw-app').chatAbortPending === true", 'Abort pending');
    report.pending = await cdp.evaluate(`(() => {
      const button = document.querySelector('.chat-compose__send-btn--stop');
      button.click();
      return {disabled:button.disabled, busy:button.getAttribute('aria-busy'),
        requests:window.__qaRequests.filter(method => method === 'chat.abort').length};
    })()`);
    assert.equal(report.pending.disabled, true); assert.equal(report.pending.busy, 'true');
    assert.equal(report.pending.requests, 1);
    await cdp.evaluate('(async () => { window.__qaResolveAbort({aborted:true}); await Promise.resolve(); return true; })()');
    assert.ok(await cdp.evaluate("document.querySelector('openclaw-app').chatAbortPending"), 'ACK alone retains terminal-event guard');
    await cdp.evaluate(`(() => {
      const app = document.querySelector('openclaw-app');
      window.__qaGatewayEvent({type:'event', event:'chat', payload:{
        sessionKey:app.sessionKey, runId:'qa-isolated-run', state:'aborted'}});
      return true;
    })()`);
    await until("!document.querySelector('openclaw-app').chatAbortPending && !document.querySelector('openclaw-app').chatRunId", 'Abort terminal event');
    report.abortAcknowledged = true;
    report.shortcutGuards = await cdp.evaluate(`(() => {
      const dispatch = (extra) => {
        const event = new KeyboardEvent('keydown', {key:'n', ctrlKey:true, bubbles:true, cancelable:true, ...extra});
        document.dispatchEvent(event); return event.defaultPrevented;
      };
      const repeat = dispatch({repeat:true}), ime = dispatch({isComposing:true});
      const dialog = document.createElement('dialog'); document.body.append(dialog); dialog.showModal();
      const modal = dispatch({}); dialog.close(); dialog.remove();
      const custom = document.createElement('div'); custom.setAttribute('role','dialog'); custom.setAttribute('aria-modal','true');
      custom.textContent = 'QA modal'; document.body.append(custom);
      const customModal = dispatch({}); custom.remove();
      const consumed = new KeyboardEvent('keydown', {key:'n', ctrlKey:true, cancelable:true}); consumed.preventDefault();
      const before = document.querySelector('openclaw-app').sessionKey; document.dispatchEvent(consumed);
      const consumedUnchanged = document.querySelector('openclaw-app').sessionKey === before;
      const field = document.querySelector('.chat-compose textarea'); field.blur();
      const focus = dispatch({key:'l'}) && document.activeElement === field;
      return {repeat, ime, modal, customModal, consumedUnchanged, focus};
    })()`);
    assert.deepEqual(report.shortcutGuards, {repeat:false, ime:false, modal:false, customModal:false, consumedUnchanged:true, focus:true});
    await cdp.evaluate(`(() => {
      const app = document.querySelector('openclaw-app');
      app.settingsTabHint = 'shortcuts';
      app.settings = {...app.settings, cryoclawView:'settings'}; app.requestUpdate(); return true;
    })()`);
    const configurableShortcutRows = '.oc-shortcuts__list:not(.oc-shortcuts__list--fixed) .oc-shortcuts__row';
    await until(`document.querySelectorAll(${JSON.stringify(configurableShortcutRows)}).length === 12`, 'Complete configurable shortcut catalog loaded');
    report.shortcutSearch = [];
    for (const [query, expected] of [['保存', 1], ['no-matching-shortcut', 0], ['', 12]]) {
      await cdp.evaluate(`(() => {
        const field = document.querySelector('.oc-shortcuts input');
        field.value = ${JSON.stringify(query)}; field.dispatchEvent(new Event('input', {bubbles:true})); return true;
      })()`);
      await until(`document.querySelectorAll(${JSON.stringify(configurableShortcutRows)}).length === ${expected}`, 'Shortcut search');
      report.shortcutSearch.push({query, matches:expected});
    }
    await setViewport(cdp, 1440, {height:1000}); await setTheme(cdp, 'light');
    await cdp.evaluate(`(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
    })()`);
    const shortcutsImage = await cdp.send('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(path.join(out, 'settings-shortcuts.png'), Buffer.from(shortcutsImage.data, 'base64'));
    const tools = [
      {role:'assistant', pending:false, content:[{type:'toolCall', name:'exec', arguments:{command:'npm run typecheck',workdir:'C:/Workspace/CryoClaw'},text:'Type check completed successfully.',exitCode:0}]},
      {role:'assistant', pending:true, content:[{type:'toolCall', name:'exec', arguments:{command:'npm run test',workdir:'C:/Workspace/CryoClaw'}}]},
      {role:'assistant', pending:false, content:[{type:'toolCall', name:'read', arguments:{path:'src/example.ts'},text:'export function greeting() {\n  return "CryoClaw";\n}\n'}]},
      {role:'assistant', pending:false, content:[{type:'toolCall', name:'edit', arguments:{path:'src/example.ts',old_string:'return "Hello";',new_string:'return "CryoClaw";'},text:'The file was updated successfully.'}]},
    ];
    await cdp.evaluate(`(async () => {
      const app = document.querySelector('openclaw-app');
      app.settings = {...app.settings, cryoclawView:'chat'};
      app.chatToolMessages = ${JSON.stringify(tools)};
      app.progressCard = {sessionKey:app.sessionKey,loading:false,dismissing:false,error:null,
        card:{sessionKey:app.sessionKey,revision:1,steps:[{step:'检查工作区和类型',status:'completed'},
          {step:'执行回归测试',status:'in_progress'},{step:'复查遗漏项',status:'pending'}]}};
      app.progressCardCollapsed = false; app.requestUpdate(); await app.updateComplete; return true;
    })()`);
    await until("!!document.querySelector('oc-command-jobs .chat-command-jobs')", 'Command history projection');
    await cdp.evaluate("document.querySelector('oc-command-jobs .chat-command-jobs').open=true");
    await until("document.querySelectorAll('.chat-command-jobs__entry').length === 2", 'Two actual command invocations');
    report.commandFilters = [];
    for (const [index, expected] of [[1,1],[2,1],[3,2]]) {
      await cdp.evaluate(`document.querySelectorAll('.chat-command-jobs__filters button')[${index}].click()`);
      await until(`document.querySelectorAll('.chat-command-jobs__entry').length === ${expected}`, 'Command history filter');
      report.commandFilters.push({index,matches:expected});
    }
    // The timeline keeps one card expanded. Exercise each real disclosure in turn.
    await cdp.evaluate(`(() => {
      document.querySelectorAll('oc-chat-history .chat-tools-summary[aria-expanded="false"]').forEach(button => button.click()); return true;
    })()`);
    await until("document.querySelectorAll('oc-chat-history .chat-tool-card').length === 4", 'Four actual timeline cards');
    report.toolSheets = {};
    for (const [index, kind] of [[0,'command'],[2,'read'],[3,'diff']]) {
      await cdp.evaluate(`(()=>{const card=document.querySelectorAll('oc-chat-history .chat-tool-card')[${index}];if(card.getAttribute('aria-expanded')==='false')card.querySelector('.chat-tool-card__header').click();return true})()`);
      await until(`!!document.querySelector('.chat-tool-sheet--${kind}')`, `Structured ${kind} sheet`);
      assert.equal(await cdp.evaluate("document.querySelectorAll('oc-chat-history .chat-tool-card[aria-expanded=true]').length"),1);
      report.toolSheets[kind]=true;
    }
    await cdp.evaluate("document.querySelectorAll('oc-chat-history .chat-tool-card')[2].querySelector('.chat-tool-card__header').click();true");
    await until("!!document.querySelector('.chat-tool-sheet--read')", 'Read sheet reopened');
    report.toolSheets.wrap=await cdp.evaluate("(()=>{const button=document.querySelector('.chat-tool-sheet__wrap');button.click();return button.getAttribute('aria-pressed')})()");
    assert.ok(report.toolSheets.read && report.toolSheets.diff && report.toolSheets.command);
    assert.equal(report.toolSheets.wrap, 'true');
    await cdp.evaluate("document.querySelector('.chat-thread').scrollTop=document.querySelector('.chat-thread').scrollHeight");
    const toolsImage = await cdp.send('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(path.join(out, 'tools-progress-command-history.png'), Buffer.from(toolsImage.data, 'base64'));
    // A highlighted code element must remain updateable: highlighting must not
    // destroy a Lit ChildPart owned by the next tool-result render.
    await until("document.querySelector('.chat-tool-sheet--read code')?.dataset.hljsDone === '1'", 'Read code highlighted');
    await cdp.evaluate(`(async () => {
      const app = document.querySelector('openclaw-app');
      app.chatToolMessages = app.chatToolMessages.map(message => ({...message,
        content:message.content.map(part => part.name === 'read'
          ? {...part,text:'export const updatedGreeting = "Updated CryoClaw";'} : part)}));
      app.requestUpdate(); await app.updateComplete; return true;
    })()`);
    await until("document.querySelector('.chat-tool-sheet--read code')?.textContent.includes('updatedGreeting')", 'Highlighted read updates without detached Lit markers');
    report.highlightedReadUpdated = true;
    await cdp.evaluate(`(async () => {
      const sheet = document.querySelector('.chat-tool-sheet--read');
      for (let node = sheet?.parentElement; node; node = node.parentElement) {
        if (node instanceof HTMLDetailsElement) node.open = true;
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      sheet?.scrollIntoView({block:'center'});
      await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
    })()`);
    report.readSheetVisible = await cdp.evaluate("document.querySelector('.chat-tool-sheet--read').checkVisibility()");
    assert.equal(report.readSheetVisible, true);
    const readImage = await cdp.send('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(path.join(out, 'tools-read-edit.png'), Buffer.from(readImage.data, 'base64'));
    await cdp.evaluate("(()=>{const app=document.querySelector('openclaw-app');app.applySettings({...app.settings,cryoclawView:'chat',dockCollapsed:true,embeddedBrowserEnabled:true});return true})()");
    await until("!document.querySelector('oc-context-dock') && !!document.querySelector('.cc-contextbar__actions .cc-contextbar__toggle')",'Collapsed Dock leaves only upper-right entry');
    assert.equal(await cdp.evaluate("(()=>{const main=document.querySelector('.chat-main').getBoundingClientRect(),split=document.querySelector('.chat-split-container').getBoundingClientRect();return Math.abs(main.right-split.right)<2 && !document.querySelector('.chat-sidebar--collapsed')})()"),true);
    await cdp.evaluate("document.querySelector('.cc-contextbar__actions .cc-contextbar__toggle').click();true");
    await until("document.querySelectorAll('.context-dock__launcher [data-dock-open]').length===5",'Centered Dock launcher contains real feature entries');
    assert.equal(await cdp.evaluate("document.querySelectorAll('.context-dock__chip').length"),0);
    await cdp.evaluate("(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));return true})()");
    report.dockLayout=await cdp.evaluate("(()=>{const dock=document.querySelector('.chat-sidebar').getBoundingClientRect(),chat=document.querySelector('.chat').getBoundingClientRect(),compose=document.querySelector('.chat-compose').getBoundingClientRect(),main=document.querySelector('.chat-main').getBoundingClientRect();return {composeAvoidsDock:compose.right<=dock.left+1,mainAvoidsDock:main.right<=dock.left+1,dockFullHeight:Math.abs(dock.bottom-chat.bottom)<3,documentOverflow:document.documentElement.scrollWidth>innerWidth}})()");
    assert.deepEqual(report.dockLayout,{composeAvoidsDock:true,mainAvoidsDock:true,dockFullHeight:true,documentOverflow:false});
    fs.writeFileSync(path.join(out,'dock-launcher.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    const drag=await cdp.evaluate("(()=>{const divider=document.querySelector('oc-resizable-divider'),r=divider.getBoundingClientRect(),app=document.querySelector('openclaw-app');return {x:r.left+r.width/2,y:r.top+Math.min(120,r.height/2),ratio:app.splitRatio,width:document.querySelector('.chat-sidebar').getBoundingClientRect().width}})()");
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:drag.x,y:drag.y});
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:drag.x,y:drag.y,button:'left',buttons:1,clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:drag.x-80,y:drag.y,button:'left',buttons:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:drag.x-80,y:drag.y,button:'left',buttons:0,clickCount:1});
    await until(`document.querySelector('.chat-sidebar').getBoundingClientRect().width>${drag.width}+35`,'Dragging the actual divider widens the Dock');
    assert.equal(await cdp.evaluate("(()=>{const app=document.querySelector('openclaw-app');return app.settings.splitRatio===app.splitRatio && !document.querySelector('oc-resizable-divider').classList.contains('dragging')})()"),true);
    await cdp.evaluate(`document.querySelector('openclaw-app').handleSplitRatioChange(${drag.ratio});true`);
    await setViewport(cdp,800,{height:1000});
    await cdp.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    const narrowDock=await cdp.evaluate("(()=>{const compose=document.querySelector('.chat-compose').getBoundingClientRect(),dock=document.querySelector('.chat-sidebar').getBoundingClientRect();return {avoids:compose.right<=dock.left+1,overflow:document.documentElement.scrollWidth>innerWidth}})()");
    assert.deepEqual(narrowDock,{avoids:true,overflow:false});
    fs.writeFileSync(path.join(out,'dock-launcher-800.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await setViewport(cdp,1440,{height:1000});
    await cdp.evaluate("document.querySelector('.context-dock__launcher [data-dock-open=changes]').click();true");
    await until("document.querySelectorAll('.context-dock__chip').length===1 && !!document.querySelector('[data-change-view=tree]')",'Changes opens a real closeable chip and view switch');
    await cdp.evaluate("document.querySelector('[data-change-view=tree]').click();true");
    await until("!!document.querySelector('.context-dock__change-directory')",'Changes tree groups actual tool edits');
    fs.writeFileSync(path.join(out,'dock-changes-tree.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await cdp.evaluate("document.querySelectorAll('.context-dock__actions button')[1].click();true");
    await until("document.querySelector('.chat-main')?.style.display==='none' && !document.querySelector('.chat-compose').checkVisibility()",'Maximize hides the complete left column');
    await cdp.evaluate("document.querySelectorAll('.context-dock__actions button')[1].click();true");
    await until("document.querySelector('.chat-compose')?.checkVisibility() && document.querySelector('.chat-main')?.style.display!=='none'",'Restore returns composer and conversation');
    await cdp.evaluate("document.querySelector('.context-dock__actions [popovertarget]').click();true");
    await until("!!document.querySelector('.context-dock__new-tab-menu:popover-open')",'Outer plus opens feature menu');
    await cdp.evaluate("document.querySelector('.context-dock__new-tab-menu [data-dock-open=terminal]').click();true");
    await until("document.querySelectorAll('.context-dock__chip').length===2 && !!document.querySelector('.context-dock__body oc-command-jobs')",'Terminal tab shows real command history');
    await cdp.evaluate("document.querySelector('[data-dock-close=terminal]').click();true");
    await until("document.querySelectorAll('.context-dock__chip').length===1",'Closing active chip selects a survivor');
    await cdp.evaluate("document.querySelector('[data-dock-close=changes]').click();true");
    await until("!!document.querySelector('.context-dock__launcher') && document.querySelectorAll('.context-dock__chip').length===0",'Closing last chip returns to launcher');
    await cdp.evaluate("document.querySelector('.cc-contextbar__actions .cc-contextbar__toggle').click();true");
    await until("!document.querySelector('oc-context-dock')",'Same upper-right entry collapses Dock');
    assert.equal(await cdp.evaluate("(()=>{document.activeElement?.blur();const e=new KeyboardEvent('keydown',{key:'G',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true});document.dispatchEvent(e);return e.defaultPrevented})()"),true);
    await until("!!document.querySelector('[data-dock-close=changes]') && !document.querySelector('.context-dock__launcher')",'Actual configured shortcut opens content directly');
    report.dock={collapsedRailRemoved:true,conversationWidthReclaimed:true,launcher:true,chipClose:true,changesTree:true,commandHistory:true,shortcut:true,dragResizeAndPreference:true};
    report.rendererExceptions = cdp.exceptions;
    assert.equal(cdp.exceptions.length, 0);
    report.ok = true;
  } catch (error) {
    report.error = error.stack ?? String(error);
    report.rendererExceptions = cdp?.exceptions;
  } finally {
    ws?.close(); killTree(child); fs.closeSync(fd); await staged.cleanup();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report));
  process.exitCode = report.ok ? 0 : 1;
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
