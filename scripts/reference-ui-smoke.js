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
      app.chatSending = false; app.chatRunId = 'qa-isolated-run';
      app.chatMessages = [{role:'user',content:[{type:'text',text:'请检查工作区的改动。'}]},
        {role:'assistant',content:[{type:'text',text:'正在检查工作区，并整理当前进度。\\n\\n这是一条隔离测试消息，不会调用模型或修改真实会话。'}]}];
      app.chatAbortPending = false; app.lastError = null;
      window.__qaRequests = [];
      client.request = (method) => {
        window.__qaRequests.push(method);
        if (method === 'chat.abort') return new Promise(resolve => { window.__qaResolveAbort = resolve; });
        // Unrelated services deliberately stay pending: malformed catch-all {} replies
        // can corrupt typed state (e.g. sessions.list requires a sessions array).
        return new Promise(() => {});
      };
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
            textareaScrollbar:getComputedStyle(document.querySelector('.chat-compose textarea')).scrollbarWidth};
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
      }
    }
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
    await until("document.querySelectorAll('.oc-shortcuts__row').length === 7", 'Shortcut catalog loaded');
    report.shortcutSearch = [];
    for (const [query, expected] of [['保存', 1], ['no-matching-shortcut', 0], ['', 7]]) {
      await cdp.evaluate(`(() => {
        const field = document.querySelector('.oc-shortcuts input');
        field.value = ${JSON.stringify(query)}; field.dispatchEvent(new Event('input', {bubbles:true})); return true;
      })()`);
      await until(`document.querySelectorAll('.oc-shortcuts__row').length === ${expected}`, 'Shortcut search');
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
    // Open real lazy tool disclosures before testing the read/edit/command sheets.
    await cdp.evaluate(`(() => {
      document.querySelectorAll('oc-chat-history details').forEach(details => {details.open=true;}); return true;
    })()`);
    await until("document.querySelectorAll('.chat-tool-sheet').length >= 4", 'Structured tool sheets');
    report.toolSheets = await cdp.evaluate(`(() => {
      const button = document.querySelector('.chat-tool-sheet__wrap'); button.click();
      return {count:document.querySelectorAll('.chat-tool-sheet').length,
        read:!!document.querySelector('.chat-tool-sheet--read'),diff:!!document.querySelector('.chat-tool-sheet--diff'),
        command:!!document.querySelector('.chat-tool-sheet--command'),wrap:button.getAttribute('aria-pressed')};
    })()`);
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
