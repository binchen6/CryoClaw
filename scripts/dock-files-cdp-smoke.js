'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {connect,waitForPageTarget,killTree,arg}=require('./lib/cdp-harness');
async function main(){
  const root=path.resolve(__dirname,'..'),out=path.resolve(arg(process.argv,'--out','.cache/dock-files-ui-qa'));
  fs.mkdirSync(path.join(out,'build'),{recursive:true});
  await require('esbuild').build({absWorkingDir:root,entryPoints:['scripts/lib/dock-files-ui-entry.ts'],outdir:path.join(out,'build'),bundle:true,splitting:true,format:'esm',target:'es2022',tsconfig:'chat-ui/ui/tsconfig.json',entryNames:'entry',nodePaths:[path.join(root,'chat-ui/ui/node_modules')],loader:{'.woff2':'file','.woff':'file','.ttf':'file'},plugins:[{name:'fixture-public-fonts',setup(build){build.onResolve({filter:/^\/fonts\//},args=>({path:path.join(root,'chat-ui/ui/public',args.path)}));}}]});
  fs.writeFileSync(path.join(out,'build/index.html'),'<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated Dock Files QA</title><link rel="stylesheet" href="entry.css"><style>html,body{margin:0;width:100%;height:100%;min-width:0;overflow:hidden}#app{display:flex;width:100%;height:100%;min-width:0;min-height:0}</style><main id="app"></main><script type="module" src="entry.js"></script></html>');
  const port=Number(arg(process.argv,'--port','9392'));
  const staged=await require('./lib/stage-electron-runtime').stageElectronRuntime(require('electron'));
  const env={...process.env,CRYOCLAW_DOCK_FILES_QA_OUT:out};delete env.ELECTRON_RUN_AS_NODE;
  const fd=fs.openSync(path.join(out,'electron.log'),'w');
  const child=spawn(staged.exe,[`--remote-debugging-port=${port}`,path.join(__dirname,'lib/dock-files-ui-fixture.cjs')],{env,windowsHide:true,stdio:['ignore',fd,fd]});
  let ws,cdp;const report={ok:false,environment:{surface:'isolated Electron real Dock Files',port,browserPlugin:'not available; repository Electron CDP workflow',userConfig:'never read or written'},checks:[],out};
  const record=(name,details)=>{report.checks.push({name,details});console.log('PASS '+name);};
  const until=async(expression,label)=>{const deadline=Date.now()+12000;while(!await cdp.evaluate(expression)){assert.ok(Date.now()<deadline,label);await new Promise(resolve=>setTimeout(resolve,80));}};
  const click=selector=>cdp.evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button)throw Error('Missing control');button.click();return true})()`);
  const row=name=>cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('.dock-files__row')].find(node=>node.querySelector('.dock-files__name').textContent.trim()===${JSON.stringify(name)});if(!row)throw Error('Missing tree row: '+${JSON.stringify(name)});row.click();return true})()`);
  const search=value=>cdp.evaluate(`(()=>{const input=document.querySelector('.dock-files__search input');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  const shot=async name=>fs.writeFileSync(path.join(out,name+'.png'),Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  const overflow=()=>cdp.evaluate(`(()=>{const selectors=['#app','.dock-files','.dock-files__body','.dock-files__preview'];return {page:document.documentElement.scrollWidth>innerWidth,regions:selectors.map(selector=>{const node=document.querySelector(selector);return {selector,client:node.clientWidth,scroll:node.scrollWidth,overflow:node.scrollWidth>node.clientWidth+1}})}})()`);
  try{
    const target=await waitForPageTarget(port,30000);assert.ok(target,'Isolated Files target');assert.ok(target.url.startsWith('file:'));
    ({ws,cdp}=await connect(target));await cdp.send('Page.bringToFront');
    await until("document.querySelector('.dock-files__workspace')?.textContent.includes('workspace-alpha') && document.querySelector('.dock-files__nodes')?.textContent.includes('README.md')",'Files initialized');
    assert.equal(await cdp.evaluate('document.title'),'Isolated Dock Files QA');
    assert.equal(await cdp.evaluate('!!document.querySelector("vite-error-overlay")'),false);
    assert.equal(await cdp.evaluate("document.querySelector('.dock-files__nodes').textContent.includes('.hidden.txt')"),false);
    const geometry=await cdp.evaluate("(()=>{const preview=document.querySelector('.dock-files__preview').getBoundingClientRect(),tree=document.querySelector('.dock-files__tree').getBoundingClientRect();return {previewRight:preview.right,treeLeft:tree.left,treeWidth:tree.width,previewWidth:preview.width}})()");
    assert.ok(geometry.treeLeft>=geometry.previewRight-1&&geometry.treeWidth<geometry.previewWidth,'Narrow tree is right of preview');
    await shot('desktop');record('identity, real workspace title, right-hand tree, hidden preference, meaningful empty preview',geometry);
    const original=await cdp.evaluate('window.__dockFilesFixture.snapshot()');
    await row('docs');await until("document.querySelector('.dock-files__nodes').textContent.includes('notes.md')",'Nested directory expanded');
    assert.equal((await cdp.evaluate('window.__dockFilesFixture.snapshot()')).currentPath,original.currentPath,'Tree expansion leaves global directory navigation unchanged');
    await row('notes.md');await until("document.querySelector('.wk-preview__text')?.textContent.includes('DOCK_FILES_REAL_PREVIEW')",'Disk file in left preview');
    assert.ok((await cdp.evaluate('window.cryoclaw.dockFilesQaStats()')).reads>=1);await shot('preview');record('lazy directory expansion and real disk file selection populate left preview');
    await search('notes');await until("!document.querySelector('.dock-files__nodes').getAttribute('aria-busy').includes('true') && document.querySelector('.dock-files__nodes').textContent.includes('notes.md')",'Rooted search');
    assert.equal(await cdp.evaluate("document.querySelector('.dock-files__nodes').textContent.includes('README.md')"),false);
    await search('');await until("document.querySelector('.dock-files__nodes').textContent.includes('README.md')",'Search cleared');
    await cdp.evaluate('window.cryoclaw.dockFilesQaCreateFile()');await click('.dock-files__search-row button');
    await until("document.querySelector('.dock-files__nodes').textContent.includes('fresh-after-refresh.txt')",'Refresh reads new on-disk file');record('search is rooted and refresh discovers a newly created real file');
    await click('.dock-files__actions button[aria-pressed]');await until("!document.querySelector('.dock-files__tree')",'Tree hidden');
    assert.ok(await cdp.evaluate("document.querySelector('.wk-preview__text')?.textContent.includes('DOCK_FILES_REAL_PREVIEW')"));
    await click('.dock-files__actions button[aria-pressed]');await until("document.querySelector('.dock-files__nodes')?.textContent.includes('README.md')",'Tree restored');record('tree visibility toggle retains file preview and restores navigation');
    for(const width of [800,390]){
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:false});
      const layout=await overflow();assert.equal(layout.page,false,`${width}px page overflow`);assert.deepEqual(layout.regions.filter(region=>region.overflow),[],`${width}px dock overflow`);
      await shot(width===390?'mobile':'medium');record(`${width}px viewport has no page or dock horizontal overflow`,layout);
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await row('slow');await until('window.cryoclaw.dockFilesQaStats().then(stats=>stats.pendingSlow>0)','Old-root response pending');
    await cdp.evaluate("window.__dockFilesFixture.switchRoot('alternate')");
    await until("document.querySelector('.dock-files__workspace')?.textContent.includes('workspace-beta') && document.querySelector('.dock-files__nodes')?.textContent.includes('BETA_ONLY.txt')",'Second authorized root rendered');
    await until('window.cryoclaw.dockFilesQaStats().then(stats=>stats.completedSlow>0 && stats.pendingSlow===0)','Old root response completed');
    assert.equal(await cdp.evaluate("document.querySelector('.dock-files__nodes').textContent.includes('OLD_ROOT_SENTINEL')"),false);record('a late listing cannot overwrite the newly selected authorized root');
    await click('.dock-files__actions button:not([aria-pressed])');await until("document.querySelector('.dock-files__workspace')?.textContent.includes('workspace-alpha')",'Chooser callback changes authorized root');record('workspace chooser uses the existing root controller path');
    report.stats=await cdp.evaluate('window.cryoclaw.dockFilesQaStats()');assert.equal(report.stats.denied,0);
    assert.deepEqual(cdp.exceptions,[]);assert.deepEqual(cdp.consoleErrors,[]);record('no relevant console or runtime errors');report.ok=true;
  }catch(error){report.error=String(error.stack||error);if(cdp){report.failureState=await cdp.evaluate("({text:document.body.innerText,snapshot:window.__dockFilesFixture?.snapshot()})").catch(()=>null);await shot('failure').catch(()=>{});}throw error;}
  finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));ws?.close();killTree(child);fs.closeSync(fd);await staged.cleanup();console.log('Report '+out);}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
