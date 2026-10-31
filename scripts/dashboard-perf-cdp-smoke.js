'use strict';
// Offline, isolated steady-state dashboard probe. This is not an all-app benchmark.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { arg, connect, waitForPageTarget, setViewport, setTheme, killTree, sleep, appLaunchEnv } = require('./lib/cdp-harness');
const root = path.resolve(__dirname, '..');

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = require('node:net').createServer();
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(resolve));
  });
}

async function main(argv = process.argv) {
  const out = path.resolve(arg(argv, '--out', '.cache/task2-dashboard-cdp'));
  const port = Number(arg(argv, '--port', '9353'));
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Valid dedicated CDP port');
  await assertPortAvailable(port);
  const marker = require('node:crypto').randomUUID();
  const bundle = fs.readdirSync(path.join(root, 'chat-ui/dist/assets')).find(name => /^oc-dashboard-.*\.js$/.test(name));
  assert.ok(bundle, 'Build chat-ui first; this script does not build shared output');
  const { injectRuntime } = await import('../builtin-plugins/cryoclaw-dashboards/runtime.mjs');
  const frameHtml = injectRuntime(`<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;overflow:hidden;font:15px system-ui;background:#f3f8fb;color:#20334a}
    body{padding:22px;box-sizing:border-box}h2{font-size:20px;margin:0 0 14px}.tag{font-size:12px;color:#526b82}
    #nest{height:155px;overflow:auto;background:white;border:1px solid #c8dce8;border-radius:10px;padding:12px}
    #nest p{margin:0;padding:10px;border-bottom:1px solid #dfebf2}.tail{padding-top:16px}
  </style></head><body><h2>本地长内容 · 滚动探针</h2><p class="tag">隔离夹具 · 不调用模型 · 不连接网关</p>
    <div id="nest">${Array.from({ length: 36 }, (_, i) => `<p>嵌套滚动条目 ${i + 1} · 内容保留在卡片内</p>`).join('')}</div>
    <p class="tail">卡片其余区域滚动应传递到看板。数据与状态仅保存于夹具内存。</p>
    <script>
      addEventListener('message', async event => {
        if(event.source!==parent || event.data?.type!=='qa:command')return;
        const {id,command,value}=event.data; let result;
        try {
          const nest=document.getElementById('nest');
          if(command==='metrics'){const r=nest.getBoundingClientRect();result={top:nest.scrollTop,max:nest.scrollHeight-nest.clientHeight,rect:{x:r.x,y:r.y,width:r.width,height:r.height},sdk:cryoclawDashboard.version};}
          else if(command==='wheel'){const target=value.nested?nest.querySelector('p'):document.body;const e=new WheelEvent('wheel',{deltaY:value.dy,bubbles:true,cancelable:true});target.dispatchEvent(e);result={prevented:e.defaultPrevented};}
          else if(command==='save'){await cryoclawDashboard.setState(value);result=await cryoclawDashboard.getState();}
          else if(command==='wheelBurst'){for(let i=0;i<12;i++)document.body.dispatchEvent(new WheelEvent('wheel',{deltaY:20,bubbles:true,cancelable:true}));result=true;}
          else throw Error('Unknown fixture command');
          parent.postMessage({type:'qa:reply',id,result},'*');
        }catch(error){parent.postMessage({type:'qa:reply',id,error:String(error)},'*');}
      });
      parent.postMessage({type:'qa:ready'},'*');
    </script></body></html>`);
  fs.mkdirSync(out, { recursive: true });
  const binary = require('electron');
  const staged = process.platform === 'win32'
    ? await require('./lib/stage-electron-runtime').stageElectronRuntime(binary)
    : { exe: binary, cleanup: async () => {} };
  const fd = fs.openSync(path.join(out, 'electron.log'), 'w');
  const child = spawn(staged.exe, [`--remote-debugging-port=${port}`, path.join(__dirname, 'lib/reference-ui-fixture.cjs'), '--out', out], {
    cwd: root, env: { ...appLaunchEnv(), CRYOCLAW_REFERENCE_MARKER: marker }, windowsHide: true, stdio: ['ignore', fd, fd],
  });
  let launchError, ws, cdp;
  child.once('error', error => { launchError = error; });
  const report = { ok: false, scope: 'Built oc-dashboard + production iframe runtime, offline fixture only; not full-app latency/FPS/RSS', port, bundle, screenshots: [] };
  const until = async (expression, label) => {
    const deadline = Date.now() + 20000;
    while (!await cdp.evaluate(expression)) {
      assert.ok(Date.now() < deadline, label); await sleep(100);
    }
  };
  const shot = async name => {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, name), Buffer.from(image.data, 'base64')); report.screenshots.push(name);
  };
  const command = (command, value) => cdp.evaluate(`window.__qaCommand(0,${JSON.stringify(command)},${JSON.stringify(value ?? null)})`);
  try {
    const page = await waitForPageTarget(port, 30000);
    assert.ok(page, launchError?.message ?? 'Isolated renderer target; inspect electron.log');
    assert.equal(new URL(page.url).searchParams.get('qaMarker'), marker, 'Refuse CDP target not owned by this isolated fixture');
    report.targetVerified = true;
    ({ ws, cdp } = await connect(page));
    await until("!!document.querySelector('openclaw-app')?.updateComplete", 'App module loaded');
    await setViewport(cdp, 1440, { height: 1000 }); await setTheme(cdp, 'light');
    // srcdoc inherits the app's no-inline-script CSP. Permit only this offline
    // test document's injected runtime; network denial and sandbox stay active.
    await cdp.send('Page.setBypassCSP', { enabled: true });
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.removeEventListener('message', listener); reject(Error('Fixture reload timeout')); }, 20000);
      const listener = event => { if (JSON.parse(event.data).method === 'Page.loadEventFired') { clearTimeout(timer); ws.removeEventListener('message', listener); resolve(); } };
      ws.addEventListener('message', listener);
    });
    const fixtureUrl = require('node:url').pathToFileURL(path.join(root, 'chat-ui/dist/index.html'));
    fixtureUrl.search = '?lang=zh&gatewayUrl=ws%3A%2F%2F127.0.0.1%3A0';
    fixtureUrl.searchParams.set('qaMarker', marker);
    await cdp.send('Page.navigate', { url: fixtureUrl.href }); await loaded;
    await until("!!document.querySelector('openclaw-app')?.updateComplete", 'App reloaded under fixture CSP bypass');
    report.fixture = await cdp.evaluate(`(async () => {
      document.querySelector('openclaw-app').remove();
      await import(new URL('./assets/${bundle}',location.href));
      window.__qaRequests=[];window.__qaState=new Map();window.__qaReady=new Set();window.__qaPending=new Map();let sequence=0;
      const dashboard=document.createElement('oc-dashboard');window.__qaDashboard=dashboard;
      dashboard.style.cssText='height:100vh;width:100%;display:block';
      const cards=Array.from({length:24},(_,i)=>({id:'probe-'+i,title:'本地模块 '+(i+1),kind:'html',accent:'blue',revision:1,
        frameUrl:'/__cryoclaw__/dashboards/qa/probe-'+i+'?v=1',layout:{w:6,h:440,order:i}}));
      const board={id:'qa',title:'看板滚动 · 隔离性能夹具',description:'仅测真实组件，不代表全应用性能',revision:1,archived:false,updatedAt:Date.now(),cards};
      dashboard.client={request:async(method,params)=>{
        window.__qaRequests.push(method);
        if(method==='cryoclaw.dashboards.list')return params?.sinceRevision===1?{revision:1,unchanged:true}:{revision:1,boards:[board]};
        if(method==='cryoclaw.dashboards.setState'){window.__qaState.set(params.cardId,params.value);return params.value;}
        if(method==='cryoclaw.dashboards.getState')return window.__qaState.get(params.cardId)??{};
        throw Error('Unexpected offline RPC: '+method);
      }};
      dashboard.settings={gatewayUrl:'ws://127.0.0.1:0'};dashboard.connected=true;
      window.__qaObserver=new MutationObserver(()=>{
        for(const frame of dashboard.querySelectorAll('iframe'))if(!frame.dataset.qa){frame.dataset.qa='true';frame.loading='eager';frame.srcdoc=${JSON.stringify(frameHtml)};}
      });window.__qaObserver.observe(dashboard,{childList:true,subtree:true});
      addEventListener('message',event=>{
        if(!event.source || !dashboard.frameSources.get(event.source))return;
        if(event.data?.type==='qa:ready')window.__qaReady.add(event.source);
        if(event.data?.type==='qa:reply'){const p=window.__qaPending.get(event.data.id);if(p){clearTimeout(p.timer);window.__qaPending.delete(event.data.id);event.data.error?p.reject(Error(event.data.error)):p.resolve(event.data.result);}}
      });
      window.__qaCommand=(index,command,value)=>new Promise((resolve,reject)=>{
        const id=++sequence,timer=setTimeout(()=>{window.__qaPending.delete(id);reject(Error('Fixture command timeout '+command));},5000);
        window.__qaPending.set(id,{resolve,reject,timer});dashboard.querySelectorAll('iframe')[index].contentWindow.postMessage({type:'qa:command',id,command,value},'*');
      });
      document.body.replaceChildren(dashboard);await dashboard.updateComplete;await document.fonts.ready;
      return {cards:24,eagerSrcdoc:true,cspBypass:'Test-only srcdoc runtime; inherited app CSP forbids inline scripts',runtime:'builtin-plugins/cryoclaw-dashboards/runtime.mjs',profile:'isolated under output directory',network:'http/https/ws/wss denied by fixture'};
    })()`);
    await until('window.__qaReady.size===24 && window.__qaDashboard.frameReady.size===24 && !window.__qaDashboard.mountPump', '24 local srcdoc runtimes and prewarm settled');
    await sleep(250);
    report.initialErrors = { exceptions: cdp.exceptions.splice(0), console: cdp.consoleErrors.splice(0) };
    await shot('dashboard-top.png');
    report.savedState = await command('save', { note: 'offline only', count: 3 });
    assert.deepEqual(report.savedState, { note: 'offline only', count: 3 });
    // Real native wheel inside an overflowing child must stay inside that child.
    const innerBefore = await command('metrics'); assert.equal(innerBefore.sdk, 2);
    const frameRect = await cdp.evaluate(`(()=>{const r=window.__qaDashboard.querySelector('iframe').getBoundingClientRect();return{x:r.x,y:r.y};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: frameRect.x + innerBefore.rect.x + 30, y: frameRect.y + innerBefore.rect.y + 40, deltaY: 120, deltaX: 0 });
    await sleep(250);
    const innerAfter = await command('metrics');
    const boardAfterInner = await cdp.evaluate("window.__qaDashboard.querySelector('.dashboard-workspace__scroll').scrollTop");
    report.nestedWheel = { before: innerBefore.top, after: innerAfter.top, boardScrollTop: boardAfterInner };
    assert.ok(innerAfter.top > innerBefore.top, 'Native nested wheel scrolls the child'); assert.equal(boardAfterInner, 0, 'Nested wheel does not move the board');
    // Instrument only dashboard-specific reads, not intentional iframe overflow checks.
    await cdp.evaluate(`(()=>{
      const d=window.__qaDashboard;window.__qaCounts={styleReads:0,iframeScans:0,wheelMessages:0,visibility:0,inspector:0};
      const computed=window.getComputedStyle;window.getComputedStyle=function(el,...rest){if(el===d)window.__qaCounts.styleReads++;return computed.call(this,el,...rest)};
      const query=d.querySelectorAll.bind(d);d.querySelectorAll=function(selector){if(selector==='.dashboard-card iframe')window.__qaCounts.iframeScans++;return query(selector)};
      for(const name of ['postFrameVisibility','postInspector']){const original=d[name];d[name]=function(...args){window.__qaCounts[name==='postInspector'?'inspector':'visibility']++;return original.apply(this,args)}}
      addEventListener('message',event=>{if(event.data?.type==='cryoclaw:dashboard'&&event.data.action==='wheel')window.__qaCounts.wheelMessages++});
      window.__qaSamples=[];window.__qaSampling=true;let last=performance.now();const sample=now=>{if(!window.__qaSampling)return;window.__qaSamples.push(now-last);last=now;requestAnimationFrame(sample)};requestAnimationFrame(sample);
      return true;
    })()`);
    report.forwardedBurst = await command('wheelBurst');
    await sleep(100);
    const burstTop = await cdp.evaluate("window.__qaDashboard.querySelector('.dashboard-workspace__scroll').scrollTop");
    assert.equal(burstTop, 240, 'Twelve wheel deltas forward through runtime and host exactly once');
    const wheel = async deltaY => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1100, y: 380, deltaY, deltaX: 0 });
      await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))');
    };
    for (let i = 0; i < 32; i++) await wheel(100);
    await sleep(150);
    const down = await cdp.evaluate("window.__qaDashboard.querySelector('.dashboard-workspace__scroll').scrollTop");
    await shot('dashboard-scrolled.png');
    for (let i = 0; i < 32; i++) await wheel(-100);
    await sleep(150);
    report.steadyScroll = await cdp.evaluate(`(()=>{
      window.__qaSampling=false;const d=window.__qaDashboard,s=d.querySelector('.dashboard-workspace__scroll');
      const a=window.__qaSamples.filter(n=>n>0).sort((a,b)=>a-b),pct=p=>a[Math.min(a.length-1,Math.floor(a.length*p))]??0;
      return {up:s.scrollTop,counts:{...window.__qaCounts},rafIntervals:{samples:a.length,p50:pct(.5),p95:pct(.95),max:a.at(-1)??0,over50:a.filter(n=>n>50).length},
        frames:d.observedFrames.size,indexed:[...d.observedFrames].every(f=>d.frameSources.get(f.contentWindow)===f),tabsBackdrop:getComputedStyle(d.querySelector('.dashboard-tabs')).backdropFilter};
    })()`);
    report.steadyScroll.down = down;
    assert.ok(down > burstTop && report.steadyScroll.up < down, 'Board wheel scrolls down and up');
    assert.equal(report.steadyScroll.counts.styleReads, 0, 'No dashboard inspector style reads while scrolling');
    assert.equal(report.steadyScroll.counts.iframeScans, 0, 'No full iframe DOM scans in steady wheel/visibility paths');
    assert.equal(report.steadyScroll.counts.inspector, 0, 'No inspector traffic while scrolling');
    assert.ok(report.steadyScroll.counts.visibility > 0 && report.steadyScroll.counts.wheelMessages > 0, 'Exercise real iframe forwarding and visibility boundaries');
    assert.equal(report.steadyScroll.tabsBackdrop, 'none'); assert.equal(report.steadyScroll.indexed, true);
    report.unindexedSourceRejected = await cdp.evaluate(`(async()=>{const s=window.__qaDashboard.querySelector('.dashboard-workspace__scroll'),before=s.scrollTop;window.dispatchEvent(new MessageEvent('message',{source:window,data:{type:'cryoclaw:dashboard',action:'wheel',value:{dy:700}}}));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return s.scrollTop===before;})()`);
    assert.equal(report.unindexedSourceRejected, true, 'Synthetic window-source message is not an observed iframe');
    report.requests = await cdp.evaluate('window.__qaRequests');
    assert.ok(report.requests.every(name => ['cryoclaw.dashboards.list','cryoclaw.dashboards.getState','cryoclaw.dashboards.setState'].includes(name)));
    report.rendererExceptions = cdp.exceptions; assert.equal(cdp.exceptions.length, 0);
    report.ok = true;
  } catch (error) {
    report.error = error.stack ?? String(error); report.rendererExceptions = cdp?.exceptions;
    if (cdp) {
      report.diagnostics = await cdp.evaluate(`(()=>{const d=window.__qaDashboard;return {ready:window.__qaReady?.size,frames:d?.observedFrames?.size,frameReady:d?.frameReady?.size,mountPump:d?.mountPump,queue:d?.mountQueue,prefetched:d?.prefetched,errors:window.__qaRequests};})()`).catch(() => null);
      report.frameTree = await cdp.send('Page.getFrameTree').catch(() => null);
      report.consoleErrors = cdp.consoleErrors;
      await shot('failure.png').catch(() => {});
    }
  } finally {
    ws?.close(); killTree(child); fs.closeSync(fd); await staged.cleanup();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report)); process.exitCode = report.ok ? 0 : 1;
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
