'use strict';
// Real built renderer + typed fake Gateway replies. Never opens a real profile,
// permits network, validates credentials, or writes provider configuration.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { arg, connect, waitForPageTarget, setViewport, setTheme, killTree } = require('./lib/cdp-harness');
const root = path.resolve(__dirname, '..');
const LONG_MODEL_ID = 'custom-research-model-with-an-intentionally-long-identifier-' + 'context-aware-'.repeat(8);

function fixtureConfig() {
  return {
    models: { providers: {
      'kimi-coding': { baseUrl: 'http://127.0.0.1:0/v1', api: 'anthropic-messages', apiKey: 'proxy-managed',
        models: [{ id: 'k2p5', name: 'Kimi Coding QA', contextWindow: 262144, maxTokens: 8192, input: ['text', 'image'] }] },
      deepseek: { baseUrl: 'https://api.deepseek.invalid/v1', api: 'openai-completions', apiKey: '__OPENCLAW_REDACTED__',
        models: [{ id: 'one', name: 'DeepSeek Primary QA', contextWindow: 65536, maxTokens: 8192, input: ['text'] },
          { id: 'two', name: 'DeepSeek Reasoning QA', contextWindow: 131072, maxTokens: 16384, reasoning: true, input: ['text'] }] },
      'custom-long': { baseUrl: 'https://custom-provider.invalid/' + 'endpoint-'.repeat(12), api: 'openai-completions', apiKey: '__OPENCLAW_REDACTED__',
        models: [{ id: LONG_MODEL_ID, name: 'Long custom model QA', contextWindow: 32768, maxTokens: 4096, input: ['text'] }] },
    } },
    agents: { defaults: { model: { primary: 'deepseek/one', fallbacks: ['deepseek/two'] } } },
  };
}

async function assertPortAvailable(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function main(argv = process.argv) {
  const base = path.resolve(arg(argv, '--out', 'out/ui-qa/provider-workbench'));
  const port = Number(arg(argv, '--port', '9354'));
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Valid private CDP port');
  // Refuse an occupied port before launching, connecting, or issuing any CDP command.
  await assertPortAvailable(port);
  fs.mkdirSync(base, { recursive: true });
  const out = fs.mkdtempSync(path.join(base, 'run-'));
  const marker = randomUUID();
  const index = path.join(root, 'chat-ui/dist/index.html');
  assert.ok(fs.existsSync(index), 'Build must be supplied by the coordinator; this smoke never builds');
  const report = { ok: false, marker, out, port, startedAt: new Date().toISOString(),
    buildIndexSha256: createHash('sha256').update(fs.readFileSync(index)).digest('hex'),
    isolation: { freshProfile: path.join(out, 'profile'), fixture: 'reference-ui-fixture.cjs', network: 'all HTTP(S)/WS(S) denied', realIpc: false },
    scenarios: [], interactions: {}, limitations: ['No credential validation or config.patch is executed. Real IPC validation/patch is covered separately.', 'Mock data, actual built renderer DOM and handlers.'] };
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
  let ws, cdp, launchError;
  child.once('error', error => { launchError = error; });
  const cleanupChild = () => { if (child.pid && child.exitCode === null && child.signalCode === null) killTree(child); };
  process.once('exit', cleanupChild);
  async function until(expression, label) {
    const deadline = Date.now() + 20000;
    while (!await cdp.evaluate(expression)) {
      assert.ok(Date.now() < deadline, label);
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }
  async function settle() {
    await cdp.evaluate(`(async () => {
      await document.fonts.ready;
      const app = document.querySelector('openclaw-app'); await app.updateComplete;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
      return true;
    })()`);
  }
  async function click(selector) {
    await cdp.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node || node.disabled) throw new Error('Missing or disabled QA target: ' + ${JSON.stringify(selector)});
      node.click(); return true;
    })()`);
    await settle();
  }
  async function waitView(view) {
    await until(`document.querySelector('.oc-provider-workbench')?.dataset.providerView === ${JSON.stringify(view)}`, `Provider ${view} rendered`);
    await settle();
  }
  async function input(selector, value) {
    await cdp.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Input missing');
      node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('input', {bubbles:true})); return true;
    })()`);
    await settle();
  }
  async function screenshot(name) {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(image.data, 'base64'));
  }
  async function measure(view, width, theme, suffix = '') {
    await settle();
    const facts = await cdp.evaluate(`(() => {
      const host = document.querySelector('.oc-provider-workbench');
      const rect = host.getBoundingClientRect();
      const exposed = /__OPENCLAW_REDACTED__|proxy-managed/.test(host.innerText)
        || [...host.querySelectorAll('input')].some(input => /__OPENCLAW_REDACTED__|proxy-managed/.test(input.value));
      return {view:host.dataset.providerView, loadState:host.dataset.loadState,
        viewportWidth:innerWidth, documentWidth:document.documentElement.scrollWidth,
        hostWidth:host.clientWidth, hostScrollWidth:host.scrollWidth,
        fitsViewport:rect.left>=-1 && rect.right<=innerWidth+1, maskedSecretExposed:exposed,
        visibleErrorMessages:[...document.querySelectorAll('oc-message-box')].filter(node=>node.visible && node.type==='error').map(node=>node.message),
        horizontalOffenders:[...host.querySelectorAll('*')].filter(el=>el.checkVisibility() && el.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(el=>({tag:el.tagName,class:el.className}))};
    })()`);
    report.scenarios.push({ view, width, theme, suffix, ...facts });
    await screenshot(`${view}-${width}-${theme}${suffix}`);
    assert.equal(facts.view, view); assert.equal(facts.loadState, 'ready');
    assert.ok(facts.documentWidth <= facts.viewportWidth + 1, `${view} document horizontal overflow at ${width}/${theme}`);
    assert.ok(facts.hostScrollWidth <= facts.hostWidth + 1, `${view} workbench horizontal overflow at ${width}/${theme}`);
    assert.ok(facts.fitsViewport, `${view} within viewport`);
    assert.deepEqual(facts.horizontalOffenders, [], `${view} has no visible horizontally overflowing descendants`);
    assert.equal(facts.maskedSecretExposed, false, 'Saved credential sentinel is never rendered as a key');
    assert.deepEqual(facts.visibleErrorMessages, [], 'No visible fixture IPC/schema error message');
    const footerSelector = view === 'catalog' ? '.oc-provider-catalog > .oc-provider-secondary:last-child'
      : view === 'detail' ? '.oc-provider-detail__footer' : '.oc-provider-add-panel > .btn-row:last-child';
    const footer = await cdp.evaluate(`(async () => {
      const node = document.querySelector(${JSON.stringify(footerSelector)});
      if (!node) throw new Error('Footer/end target missing');
      node.scrollIntoView({block:'end',behavior:'instant'});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = node.getBoundingClientRect();
      let scroller=node.parentElement;
      while(scroller && !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight>scroller.clientHeight+1)) scroller=scroller.parentElement;
      const contentHeight=document.querySelector('.oc-provider-workbench').getBoundingClientRect().height;
      // The settings scroller's bottom padding can overflow even when the entire
      // form fits. Pinning is required for genuinely taller content, not padding.
      return {top:rect.top,bottom:rect.bottom,visible:node.checkVisibility(),reachable:rect.top>=-1 && rect.bottom<=innerHeight+1,
        hasScrollOverflow:!!scroller, contentHeight, scrollportHeight:scroller?.clientHeight ?? innerHeight,
        overflowing:!!scroller && contentHeight>scroller.clientHeight+1, viewportHeight:innerHeight, viewportBottomGap:innerHeight-rect.bottom};
    })()`);
    report.scenarios[report.scenarios.length - 1].footer = footer;
    if (!footer.reachable) await screenshot(`${view}-${width}-${theme}${suffix}-footer-failure`);
    assert.ok(footer.visible && footer.reachable, `${view} footer reachable at ${width}/${theme}`);
    if (view === 'add') {
      if (footer.overflowing) assert.ok(Math.abs(footer.viewportBottomGap)<=2, `Overflowing add footer flush with viewport bottom at ${width}/${theme}: ${footer.viewportBottomGap}px gap`);
      const alias = await cdp.evaluate(`(async () => {
        const panel=document.querySelector('.oc-provider-add-panel');
        const group=[...panel.querySelectorAll(':scope > .oc-settings__form-group')].at(-1);
        const input=group?.querySelector('input');
        if(!input || !/别名|alias/i.test(group.querySelector('label')?.textContent ?? '')) throw new Error('Final alias input missing');
        input.scrollIntoView({block:'center',behavior:'instant'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const rect=input.getBoundingClientRect(), footer=panel.querySelector(':scope > .btn-row:last-child').getBoundingClientRect();
        const hit=document.elementFromPoint(rect.left+Math.min(rect.width/2,20),rect.top+rect.height/2);
        return {top:rect.top,bottom:rect.bottom,footerTop:footer.top,footerBottom:footer.bottom,
          visible:input.checkVisibility(),uncovered:rect.top>=-1 && rect.bottom<=footer.top+1 && hit===input};
      })()`);
      report.scenarios[report.scenarios.length-1].alias = alias;
      await screenshot(`${view}-${width}-${theme}${suffix}-bottom`);
      assert.ok(alias.visible && alias.uncovered, `Last alias input is reachable and not covered by footer at ${width}/${theme}`);
    }
  }
  try {
    const page = await waitForPageTarget(port, 30000);
    assert.ok(page, launchError?.message ?? 'Private fixture target; inspect electron.log');
    assert.equal(new URL(page.url).searchParams.get('qaMarker'), marker, 'Refuse to control any renderer not owned by this run');
    ({ ws, cdp } = await connect(page));
    await until("!!document.querySelector('openclaw-app')?.updateComplete", 'Built app loaded');
    const config = fixtureConfig();
    const models = Object.entries(config.models.providers).flatMap(([provider, entry]) => entry.models.map(model => ({ ...model, provider, available: true })));
    await cdp.evaluate(`(async () => {
      const app = document.querySelector('openclaw-app');
      if (!app.client) throw new Error('Real built Gateway client missing');
      app.client.stop(); window.__providerQaRequests = []; window.__providerQaIpc = [];
      // The sandboxed renderer has no preload. Only initial read-only OAuth/proxy
      // configuration is mocked; this cannot invoke Electron or touch credentials.
      if (window.cryoclaw) throw new Error('Fixture unexpectedly has a real preload bridge');
      window.cryoclaw = {
        kimiOAuthStatus: async () => { window.__providerQaIpc.push('kimiOAuthStatus'); return {loggedIn:false}; },
        openaiProxyGet: async () => { window.__providerQaIpc.push('openaiProxyGet'); return {success:true,data:{mode:'system',url:''}}; },
      };
      const config = ${JSON.stringify(config)}, models = ${JSON.stringify(models)};
      app.client.request = (method, params) => {
        window.__providerQaRequests.push({method,params});
        if (method === 'config.get') return Promise.resolve({exists:true,valid:true,hash:'qa-provider-v1',raw:null,config});
        if (method === 'models.list') return Promise.resolve({models});
        if (method === 'agents.list') return Promise.resolve({agents:[{id:'main',identity:{name:'QA Agent'},model:{primary:'deepseek/one'}}]});
        if (method === 'config.patch') return Promise.reject(new Error('QA forbids provider writes'));
        // Never invent malformed catch-all responses for unrelated background services.
        return new Promise(() => {});
      };
      app.connected = true; app.lastError = null;
      app.settingsTabHint = 'provider'; app.settings = {...app.settings,cryoclawView:'settings'};
      app.requestUpdate(); await app.updateComplete; return true;
    })()`);
    await waitView('catalog');
    await until("document.querySelector('.oc-provider-workbench')?.dataset.loadState === 'ready'", 'Typed RPC data loaded');
    report.interactions.catalog = await cdp.evaluate(`({groups:document.querySelectorAll('.oc-provider-collection').length,
      providers:[...document.querySelectorAll('.oc-provider-tile')].map(node=>node.dataset.providerKey),
      marks:[...document.querySelectorAll('.oc-provider-tile')].map(node=>{const avatar=node.querySelector('.oc-provider-avatar');return {provider:node.dataset.providerKey,kind:avatar?.dataset.providerIcon,svg:!!avatar?.querySelector('svg'),initial:avatar?.querySelector('.oc-provider-initial')?.textContent ?? null};}),
      primary:document.querySelector('.oc-model-overview__primary strong')?.textContent})`);
    assert.equal(report.interactions.catalog.groups, 2);
    assert.deepEqual([...report.interactions.catalog.providers].sort(), ['custom-long','deepseek','kimi-coding']);
    assert.equal(report.interactions.catalog.primary, 'DeepSeek Primary QA');
    const catalogMarks = Object.fromEntries(report.interactions.catalog.marks.map(mark => [mark.provider, mark]));
    assert.equal(catalogMarks['kimi-coding'].kind, 'moonshot'); assert.ok(catalogMarks['kimi-coding'].svg);
    assert.equal(catalogMarks.deepseek.kind, 'deepseek'); assert.ok(catalogMarks.deepseek.svg);
    assert.equal(catalogMarks['custom-long'].kind, 'custom'); assert.equal(catalogMarks['custom-long'].initial, 'C');
    report.interactions.filters = [];
    for (const [query, expected] of [['DeepSeek Reasoning QA',1],['no-matching-qa-provider',0],['',3]]) {
      await input('.oc-provider-filter__input', query);
      const count = await cdp.evaluate("document.querySelectorAll('.oc-provider-tile').length");
      assert.equal(count, expected, `Filter ${query}`); report.interactions.filters.push({query,count});
    }
    // Managed Kimi keeps its existing explicit key-edit route, without exercising
    // verification/save. The only typed value is a disposable fake QA draft.
    await click('.oc-provider-tile[data-provider-key="kimi-coding"]'); await waitView('detail');
    assert.equal(await cdp.evaluate("document.querySelector('.oc-provider-connection oc-password-input') === null"), true);
    assert.ok(await cdp.evaluate("/安全代理托管|managed by the local secure proxy/i.test(document.querySelector('.oc-provider-connection').innerText)"));
    assert.equal(await cdp.evaluate("document.querySelector('.oc-provider-detail__footer .primary') === null"), true);
    async function openManagedKeyEditor() {
      await click('.oc-provider-detail > .oc-provider-secondary > summary');
      await cdp.evaluate(`(() => {
        const button=[...document.querySelectorAll('.oc-provider-detail .oc-provider-kimi-extras button')].find(node=>/编辑密钥|edit API key/i.test(node.textContent));
        if(!button || button.disabled)throw new Error('Managed key-edit button missing');button.click();return true;
      })()`);
      await settle();
      assert.equal(await cdp.evaluate("document.querySelector('.oc-provider-connection oc-password-input')?.value"), '');
      assert.equal(await cdp.evaluate("document.querySelector('.oc-provider-connection oc-password-input input')?.type"), 'password');
      assert.equal(await cdp.evaluate("document.querySelector('.oc-provider-detail__footer .primary')?.disabled"), true);
    }
    await openManagedKeyEditor();
    await input('.oc-provider-connection oc-password-input input', 'qa-disposable-draft-never-verified');
    assert.equal(await cdp.evaluate("document.querySelector('.oc-provider-detail__footer .primary')?.disabled"), false);
    assert.equal(await cdp.evaluate("document.querySelector('.oc-provider-connection oc-password-input input')?.type"), 'password');
    await click('.oc-provider-detail .oc-provider-back'); await waitView('catalog');
    await click('.oc-provider-tile[data-provider-key="kimi-coding"]'); await waitView('detail');
    assert.equal(await cdp.evaluate("document.querySelector('.oc-provider-connection oc-password-input') === null"), true);
    await openManagedKeyEditor(); // Re-entry must not restore the cancelled draft.
    await click('.oc-provider-detail .oc-provider-back'); await waitView('catalog');
    report.interactions.managedKimiKeyEdit = {managedHint:true,explicitEditor:true,masked:true,emptySaveDisabled:true,draftEnablesSave:true,cancelClearsDraft:true,saveNeverClicked:true};
    // Real detail handlers and modal capability editor; no save is ever clicked.
    await click('.oc-provider-tile[data-provider-key="deepseek"]'); await waitView('detail');
    report.interactions.detail = await cdp.evaluate(`({id:document.querySelector('#provider-identity').value,
      rows:[...document.querySelectorAll('.oc-provider-model-table__row')].map(node=>node.innerText),
      headings:document.querySelector('.oc-provider-model-table__head').innerText,
      passwordValue:document.querySelector('.oc-provider-connection oc-password-input')?.value,
      passwordType:document.querySelector('.oc-provider-connection oc-password-input input')?.type,
      readonlyConnection:['provider-identity','provider-protocol','provider-endpoint'].every(id=>document.getElementById(id)?.readOnly),
      saveDisabled:document.querySelector('.oc-provider-detail__footer .primary')?.disabled})`);
    assert.equal(report.interactions.detail.id, 'deepseek');
    assert.equal(report.interactions.detail.rows.length, 2);
    assert.ok(report.interactions.detail.rows[0].includes('one') && report.interactions.detail.rows[0].includes('DeepSeek Primary QA'));
    assert.match(report.interactions.detail.rows[0], /64K|65,?536/);
    assert.ok(report.interactions.detail.rows[1].includes('two') && report.interactions.detail.rows[1].includes('DeepSeek Reasoning QA'));
    assert.match(report.interactions.detail.rows[1], /128K|131,?072/);
    assert.equal(report.interactions.detail.passwordValue, ''); assert.equal(report.interactions.detail.passwordType, 'password');
    assert.equal(report.interactions.detail.readonlyConnection, true); assert.equal(report.interactions.detail.saveDisabled, true);
    await click('.oc-provider-detail__models-heading .btn-row button:last-child'); await waitView('add');
    assert.equal(await cdp.evaluate("document.querySelectorAll('.oc-provider-preset').length"), 0, 'Append-to-provider does not offer provider presets');
    assert.equal(await cdp.evaluate("document.querySelector('.oc-provider-reuse-notice__key')?.textContent"), 'deepseek');
    assert.ok(await cdp.evaluate("!!document.querySelector('.oc-provider-add-panel .oc-provider-model-select-row') && !!document.querySelector('.oc-provider-add-panel oc-caps-editor')"), 'Existing model and capability controls remain available');
    await click('.oc-provider-add-panel > .btn-row:last-child button:first-child'); await waitView('detail');
    assert.equal(await cdp.evaluate("document.querySelector('.oc-provider-detail')?.dataset.providerKey"), 'deepseek', 'Append cancellation returns to its provider detail');
    report.interactions.appendModelAndCancel = true;
    await click('.oc-provider-model-table__row .btn-row button:first-child');
    await until("!!document.querySelector('.oc-provider-edit-drawer__backdrop[open] oc-caps-editor')", 'Capability drawer opens');
    report.interactions.advancedDrawer = true;
    await click('.oc-provider-edit-drawer [data-dialog-dismiss]');
    await until("!document.querySelector('.oc-provider-edit-drawer')", 'Capability drawer cancels');
    await click('.oc-provider-detail .oc-provider-back'); await waitView('catalog');
    for (const width of [1440, 800, 600]) for (const theme of ['light','dark']) {
      await setViewport(cdp, width, {height:1000}); await setTheme(cdp, theme);
      await measure('catalog', width, theme);
      await click('.oc-provider-tile[data-provider-key="deepseek"]'); await waitView('detail');
      await measure('detail', width, theme);
      await click('.oc-provider-detail .oc-provider-back'); await waitView('catalog');
      await click('.oc-provider-tile[data-provider-key="custom-long"]'); await waitView('detail');
      await measure('detail', width, theme, '-long-id');
      assert.equal(await cdp.evaluate("document.querySelector('.oc-provider-model-table__row code').textContent"), LONG_MODEL_ID);
      await click('.oc-provider-detail .oc-provider-back'); await waitView('catalog');
      await click('.oc-provider-header .primary'); await waitView('add');
      if (width === 1440 && theme === 'light') {
        report.interactions.presetIcons = await cdp.evaluate(`[...document.querySelectorAll('.oc-provider-preset')].map(node=>({label:node.textContent.trim(),kind:node.querySelector('[data-provider-icon]')?.dataset.providerIcon,svg:!!node.querySelector('svg')}))`);
        assert.equal(report.interactions.presetIcons.length, 17, 'Every provider preset is rendered');
        assert.ok(report.interactions.presetIcons.every(mark => mark.svg), 'Every preset has a vector glyph');
        assert.equal(new Set(report.interactions.presetIcons.map(mark => mark.kind)).size, 12, 'Preset families are visually distinct');
      }
      // Choose the existing DeepSeek preset through its visible real button.
      await cdp.evaluate(`(() => { const button=[...document.querySelectorAll('.oc-provider-preset')].find(node=>/deepseek/i.test(node.textContent)); if(!button)throw new Error('DeepSeek preset missing');button.click();return true; })()`);
      await settle();
      assert.ok(await cdp.evaluate("!![...document.querySelectorAll('.oc-provider-preset')].find(node=>/deepseek/i.test(node.textContent) && node.getAttribute('aria-pressed')==='true')"));
      await measure('add', width, theme, '-preset');
      await click('.oc-provider-preset:last-child');
      assert.equal(await cdp.evaluate("document.querySelector('.oc-provider-preset:last-child').getAttribute('aria-pressed')"), 'true');
      assert.ok(await cdp.evaluate("!!document.querySelector('.oc-provider-add-panel .oc-settings__details-advanced[open] input')"));
      await measure('add', width, theme, '-custom');
      await click('.oc-provider-add-panel > .btn-row:last-child button:first-child'); await waitView('catalog');
    }
    report.interactions.addPresetCustomAndCancel = true;
    for (const width of [800,600]) {
      assert.ok(report.scenarios.some(scenario => scenario.view==='add' && scenario.width===width
        && scenario.footer?.overflowing && Math.abs(scenario.footer.viewportBottomGap)<=2 && scenario.alias?.uncovered),
      `At least one genuinely overflowing add form at ${width}px exercises sticky-bottom and uncovered-alias assertions`);
    }
    report.requests = await cdp.evaluate('window.__providerQaRequests');
    report.ipcCalls = await cdp.evaluate('window.__providerQaIpc');
    assert.equal(report.requests.filter(request => request.method === 'config.patch').length, 0, 'No provider write attempted');
    assert.ok(report.ipcCalls.includes('kimiOAuthStatus') && report.ipcCalls.includes('openaiProxyGet'));
    assert.ok(report.ipcCalls.every(method => ['kimiOAuthStatus','openaiProxyGet'].includes(method)), 'Only read-only fake IPC methods');
    report.rendererExceptions = [...cdp.exceptions]; report.consoleErrors = [...cdp.consoleErrors];
    // Exact Chromium failure observed for the intentionally denied bootstrap ws0.
    // All other renderer console errors remain failures rather than being hidden.
    report.unexpectedConsoleErrors = report.consoleErrors.filter(error => !/^WebSocket connection to 'ws:\/\/127\.0\.0\.1:0\/' failed:  \(file:\/\/\/.*\/chat-ui\/dist\/assets\/index-[^/()]+\.js\)$/.test(error));
    assert.deepEqual(report.unexpectedConsoleErrors, [], 'No unexpected renderer console error');
    assert.equal(report.rendererExceptions.length, 0, 'No renderer exception');
    report.ok = true;
  } catch (error) {
    report.error = error.stack ?? String(error); report.rendererExceptions = cdp?.exceptions ?? [];
    report.consoleErrors = cdp?.consoleErrors ?? [];
    if (cdp) await screenshot('failure').catch(() => {});
  } finally {
    ws?.close(); cleanupChild(); process.removeListener('exit', cleanupChild);
    fs.closeSync(fd); await staged.cleanup();
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report)); process.exitCode = report.ok ? 0 : 1;
  return report;
}

module.exports = { fixtureConfig, assertPortAvailable, main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
