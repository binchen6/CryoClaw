'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
const {connect,waitForPageTarget,killTree,arg}=require('./lib/cdp-harness');
async function main(){
  const root=path.resolve(__dirname,'..'),out=path.resolve(arg(process.argv,'--out','out/interaction-ui/1103')),port=Number(arg(process.argv,'--port','9375'));
  fs.mkdirSync(path.join(out,'build'),{recursive:true});
  await require('esbuild').build({absWorkingDir:root,entryPoints:['scripts/lib/interaction-ui-entry.ts'],outdir:path.join(out,'build'),bundle:true,format:'esm',target:'es2022',tsconfig:'chat-ui/ui/tsconfig.json',entryNames:'entry',nodePaths:[path.join(root,'chat-ui/ui/node_modules')],loader:{'.woff2':'file','.woff':'file','.ttf':'file'},plugins:[{name:'fonts',setup(build){build.onResolve({filter:/^\/fonts\//},args=>({path:path.join(root,'chat-ui/ui/public',args.path)}));}}]});
  fs.writeFileSync(path.join(out,'build/index.html'),'<!doctype html><html data-theme="light" data-motion="full"><meta charset="utf-8"><link rel="stylesheet" href="entry.css"><style>body{margin:0;padding:24px;min-width:0;overflow:auto}#app{width:100%}.fixture-split .chat-main{min-width:0}.fixture-split .chat-sidebar{min-width:0}.wk-nav input{max-width:100%}</style><main id="app"></main><script type="module" src="entry.js"></script></html>');
  const staged=await require('./lib/stage-electron-runtime').stageElectronRuntime(require('electron'));
  const env={...process.env,CRYOCLAW_INTERACTION_QA_OUT:out};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(staged.exe,[`--remote-debugging-port=${port}`,path.join(__dirname,'lib/interaction-ui-fixture.cjs')],{env,windowsHide:true,stdio:'ignore'});
  let ws,cdp;const report={ok:false,checks:[],out},record=name=>{report.checks.push(name);console.log('PASS '+name);},pause=ms=>new Promise(r=>setTimeout(r,ms));
  try{
    ({ws,cdp}=await connect(await waitForPageTarget(port,30000)));await pause(500);
    for(const width of [1050,390]){
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      for(const id of ['open-one','open-two']){
        await cdp.evaluate(`document.querySelector('#${id} .file-open-menu__toggle').click()`);await pause(180);
        const geometry=await cdp.evaluate(`(()=>{const host=document.querySelector('#${id}'),p=host.querySelector('[popover]'),a=host.querySelector('.file-open-menu__split').getBoundingClientRect(),b=p.getBoundingClientRect();return {open:p.matches(':popover-open'),side:p.dataset.anchorSide,inBounds:b.left>=10&&b.right<=innerWidth-10&&b.top>=10&&b.bottom<=innerHeight-10,overlap:a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top,transition:getComputedStyle(p).transitionProperty};})()`);
        assert.equal(geometry.open,true);assert.equal(geometry.inBounds,true);assert.equal(geometry.overlap,false);assert.ok(geometry.side);assert.match(geometry.transition,/transform/);
        await cdp.evaluate(`document.querySelector('#${id} .file-open-menu__toggle').click()`);assert.equal(await cdp.evaluate(`document.querySelector('#${id} [popover]').matches(':popover-open')`),false);
        await pause(180);record(`${width}px ${id}: anchored, viewport-safe, reversible native toggle`);
      }
    }
    let previousLongHeight=0;
    for(const height of [600,900]){
      await cdp.send('Emulation.setDeviceMetricsOverride',{width:1050,height,deviceScaleFactor:1,mobile:false});
      await cdp.evaluate(`(()=>{const edge=document.querySelector('.fixture-edge');edge.style.top='260px';edge.style.bottom='auto';const panel=edge.querySelector('[popover]');if(!panel.querySelector('[data-long-qa]'))for(let i=0;i<20;i++){const button=document.createElement('button');button.dataset.longQa='true';button.textContent='Long menu '+i;panel.append(button);}edge.querySelector('.file-open-menu__toggle').click();})()`);await pause(180);
      const size=await cdp.evaluate(`(()=>{const panel=document.querySelector('#open-two [popover]'),r=panel.getBoundingClientRect(),a=document.querySelector('#open-two .file-open-menu__split').getBoundingClientRect();return {height:r.height,overlap:r.top<a.bottom&&r.bottom>a.top&&r.left<a.right&&r.right>a.left,inBounds:r.top>=10&&r.bottom<=innerHeight-10};})()`);
      assert.equal(size.overlap,false);assert.equal(size.inBounds,true);if(previousLongHeight)assert.ok(size.height>previousLongHeight+50,'height cap must grow after resize');previousLongHeight=size.height;
      await cdp.evaluate(`document.querySelector('#open-two .file-open-menu__toggle').click()`);await pause(180);
    }
    await cdp.evaluate(`(()=>{document.querySelectorAll('[data-long-qa]').forEach(el=>el.remove());const edge=document.querySelector('.fixture-edge');edge.style.top='';edge.style.bottom='16px';})()`);record('long centre menus shrink safely and recover their height on a larger viewport');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    assert.equal(await cdp.evaluate(`(()=>{const input=document.querySelector('#workspace-input');input.focus();const probe=document.createElement('input');probe.style.boxShadow='var(--focus-field)';document.body.append(probe);const expected=getComputedStyle(probe).boxShadow,actual=getComputedStyle(input).boxShadow;probe.remove();return actual===expected&&getComputedStyle(input).outlineStyle==='none';})()`),true);record('workspace focus uses the shared field token');
    const tool=await cdp.evaluate(`(()=>{const r=document.querySelector('#tool-focus').getBoundingClientRect();return {x:r.x+20,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...tool,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...tool,button:'left',clickCount:1});await pause(220);
    const pointerFocus=await cdp.evaluate(`(()=>{const el=document.querySelector('#tool-focus'),probe=document.createElement('div');probe.style.boxShadow='var(--shadow-sm)';document.body.append(probe);const hover=getComputedStyle(probe).boxShadow;probe.remove();return {active:document.activeElement.id,visible:el.matches(':focus-visible'),shadow:getComputedStyle(el).boxShadow,hover};})()`);
    assert.equal(pointerFocus.active,'tool-focus');assert.equal(pointerFocus.visible,false);assert.equal(pointerFocus.shadow,pointerFocus.hover);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await cdp.evaluate(`document.querySelector('#tool-focus').focus()`);await pause(220);
    assert.equal(await cdp.evaluate(`(()=>{const el=document.querySelector('#tool-focus'),probe=document.createElement('div');probe.style.boxShadow='var(--focus-ring)';document.body.append(probe);const expected=getComputedStyle(probe).boxShadow;probe.remove();return el.matches(':focus-visible')&&getComputedStyle(el).boxShadow===expected&&getComputedStyle(el).outlineStyle==='none';})()`),true);record('tool-card pointer focus is quiet and keyboard focus uses the shared ring');
    const divider=await cdp.evaluate(`(()=>{const r=document.querySelector('.fixture-split oc-resizable-divider').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:divider.x,y:divider.y,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:divider.x+60,y:divider.y,button:'left',buttons:1});
    const tracking=await cdp.evaluate(`({commits:window.__interactionQa.commits,drag:!!document.querySelector('.split-resizing'),transition:getComputedStyle(document.querySelector('.fixture-split .chat-main')).transitionDuration})`);
    assert.equal(tracking.commits,0);assert.equal(tracking.drag,true);assert.equal(tracking.transition,'0s');
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:divider.x+60,y:divider.y,button:'left',clickCount:1});assert.equal(await cdp.evaluate('window.__interactionQa.commits'),1);record('Dock drag tracks directly and commits once on release');
    await cdp.evaluate(`document.querySelector('#toggle-controlled').click()`);await pause(280);
    await cdp.evaluate(`document.querySelector('#toggle-controlled').click()`);await pause(40);
    assert.equal(await cdp.evaluate(`!!document.querySelector('#controlled-body')&&document.querySelector('#controlled-body').closest('.cc-disclosure').inert`),true);
    await cdp.evaluate(`document.querySelector('#toggle-controlled').click()`);await pause(280);assert.equal(await cdp.evaluate(`!!document.querySelector('#controlled-body')`),true);
    await cdp.evaluate(`document.querySelector('#toggle-controlled').click()`);await pause(280);assert.equal(await cdp.evaluate(`!!document.querySelector('#controlled-body')`),false);record('controlled disclosure retains exit content, cancels stale removal, then frees subtree');
    await cdp.evaluate(`document.querySelector('#native-details summary').click()`);await pause(280);await cdp.evaluate(`document.querySelector('#native-details summary').click()`);await pause(40);
    assert.equal(await cdp.evaluate(`getComputedStyle(document.querySelector('#native-details'),'::details-content').contentVisibility`),'visible');record('native disclosure retains content during the closing transition');
    await cdp.evaluate(`document.documentElement.dataset.motion='reduce';document.querySelector('#open-two .file-open-menu__toggle').click()`);await pause(100);const reduced=await cdp.evaluate(`(()=>{const s=getComputedStyle(document.querySelector('#open-two [popover]'));return {duration:s.transitionDuration,transform:s.transform};})()`);assert.ok(reduced.duration.split(',').every(value=>parseFloat(value)<=.08));assert.equal(reduced.transform,'none');record('reduced motion removes menu movement and respects the global 80ms fade cap');
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'interaction.png'),Buffer.from(shot.data,'base64'));
    assert.deepEqual(cdp.exceptions,[]);report.ok=true;
  }catch(error){report.error=String(error.stack||error);throw error;}
  finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));ws?.close();killTree(child);await staged.cleanup();}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1});
