const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'..');
const runtimeRequire=process.env.CRYOCLAW_PLAYWRIGHT_PATH?createRequire(path.join(path.resolve(process.env.CRYOCLAW_PLAYWRIGHT_PATH),'package.json')):require;
const {chromium}=runtimeRequire('playwright');
const esbuild=require('esbuild');
const cache=path.join(root,'.cache/promo');
const output=path.join(root,'website/promo/screens');

async function capture(){
  fs.mkdirSync(cache,{recursive:true});fs.mkdirSync(output,{recursive:true});
  await esbuild.build({entryPoints:[path.join(__dirname,'promo-ui.ts')],outfile:path.join(cache,'production-fixture.js'),bundle:true,format:'esm',platform:'browser',target:'chrome140',loader:{'.css':'empty'},tsconfig:path.join(root,'chat-ui/ui/tsconfig.json'),define:{'import.meta.env':'{}'},logLevel:'warning'});
  const css=fs.readdirSync(path.join(root,'chat-ui/dist/assets')).find(name=>/^index-.*\.css$/.test(name));
  if(!css)throw new Error('Run npm run build:chat before capturing production UI');
  const bridge=`window.cryoclaw=new Proxy({platform:'win32',settingsGetVersion:async()=>({success:true,data:{version:'2026.1019.0'}})}, {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:async()=>({success:true,data:{}})});`;
  const html=`<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/app/assets/${css}"><style>html,body,#production-ui{width:100%;height:100%;margin:0;overflow:hidden}*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><div id="production-ui"></div><script src="/bridge.js"></script><script type="module" src="/fixture.js"></script></body></html>`;
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
    if(url.pathname==='/bridge.js'){res.setHeader('Content-Type','text/javascript');res.end(bridge);return;}
    const file=url.pathname==='/fixture.js'?path.join(cache,'production-fixture.js'):path.resolve(root,'chat-ui/dist',url.pathname.replace(/^\/app\//,''));
    if(file!==path.join(cache,'production-fixture.js')&&!file.startsWith(path.join(root,'chat-ui/dist')+path.sep)){res.writeHead(403);res.end();return;}
    fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)]||'application/octet-stream');res.end(data);});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    const index=process.argv.indexOf('--browser');
    browser=await chromium.launch({headless:true,args:[`--log-file=${path.join(cache,'capture-chromium.log')}`],...(index>=0?{executablePath:process.argv[index+1]}:{})});
    const errors=[], targets={}, assertions=[];
    const bounds=async(locator)=>{
      const r=await locator.boundingBox();if(!r)throw new Error('Demo target is not visible');
      return {...r,cx:r.x+r.width/2,cy:r.y+r.height/2};
    };
    const shot=async(page,name)=>{
      await page.screenshot({path:path.join(output,`${name}.jpg`),type:'jpeg',quality:97});
      console.log(`Production UI: ${name}`);
    };
    for(const scene of ['models','chat','workspace','theme-light','theme-dark','theme-studio']){
      const page=await browser.newPage({viewport:{width:1440,height:660},deviceScaleFactor:1.5,colorScheme:'light',reducedMotion:'reduce'});
      page.on('pageerror',e=>errors.push(`${scene}: ${e.message}`));
      await page.goto(`http://127.0.0.1:${server.address().port}/?lang=zh`);
      await page.waitForFunction(()=>typeof window.showDemoScene==='function');
      await page.evaluate(name=>window.showDemoScene(name),scene);await page.evaluate(()=>document.fonts.ready);
      if(scene==='models'){
        await page.locator('summary').filter({hasText:'ChatGPT / Codex'}).click();
        await page.getByText('模型库',{exact:true}).evaluate(el=>el.scrollIntoView({block:'start'}));
        const star=page.locator('[data-model-key="anthropic/claude-sonnet-4-5"]').getByRole('button',{name:'设为默认',exact:true});
        await star.hover();targets.defaultModel=await bounds(star);
        await shot(page,scene);await star.click();
        await page.waitForFunction(()=>document.querySelector('[data-model-key="anthropic/claude-sonnet-4-5"] button.is-default')!==null);
        await shot(page,'models-selected');assertions.push('Default model changed through its production handler');
      }else if(scene==='workspace'){
        const edit=page.getByRole('button',{name:'编辑',exact:true});targets.editFile=await bounds(edit);
        await shot(page,scene);await edit.click();
        const editor=page.locator('.wk-editor');
        const text=await editor.inputValue();await editor.fill(text.replace('- [ ] 与团队确认下一步行动','- [x] 与团队确认下一步行动'));
        await page.waitForFunction(()=>document.body.textContent.includes('草稿已在本机暂存'));
        targets.editor=await bounds(editor);targets.saveFile=await bounds(page.getByRole('button',{name:'保存文件',exact:true}));
        await shot(page,'workspace-edit');assertions.push('Edited file draft backed up through the workspace controller');
      }else if(scene==='theme-light'){
        const tile=page.getByRole('button').filter({hasText:'石墨 · Graphite'});targets.graphite=await bounds(tile);
        await shot(page,scene);await tile.click();
        targets.darkMode=await bounds(page.getByRole('button',{name:'深色',exact:true}));
        await shot(page,'theme-graphite');
      }else if(scene==='theme-studio'){
        await page.getByRole('button',{name:'选择界面元素',exact:true}).click();
        const bubble=page.locator('.chat-group.user .chat-bubble');
        targets.bubble=await bounds(bubble);await bubble.click({position:{x:4,y:20}});
        await page.locator('.theme-editor').getByRole('button',{name:'外观',exact:true}).click();
        const slider=page.locator('.theme-editor').getByRole('slider',{name:'圆角',exact:true});
        await slider.evaluate(el=>el.scrollIntoView({block:'center'}));
        targets.radius=await bounds(slider);
        for(let step=0;step<=24;step++){
          await slider.evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},12+step);
          await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          await shot(page,`radius-${String(step).padStart(2,'0')}`);
        }
        const actual=await page.locator('[data-theme-selected]').evaluate(el=>getComputedStyle(el).borderRadius);
        if(actual!=='36px')throw new Error(`Theme radius was not applied: ${actual}`);
        await shot(page,'theme-tuned');assertions.push('Theme Studio changed the actual selected bubble radius to 36px');
        fs.copyFileSync(path.join(output,'radius-00.jpg'),path.join(output,'theme-studio.jpg'));
      }else{
        await shot(page,scene);
      }
      await page.close();
    }
    if(errors.length)throw new Error(errors.join('\n'));
    fs.writeFileSync(path.join(output,'targets.json'),JSON.stringify(targets,null,2));
    fs.writeFileSync(path.join(cache,'interaction-verification.json'),JSON.stringify({assertions,errors},null,2));
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
capture().catch(error=>{console.error(error);process.exitCode=1;});
