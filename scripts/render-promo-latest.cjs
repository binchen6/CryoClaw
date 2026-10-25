#!/usr/bin/env node
/* Offline HyperFrames export, contact sheets and actual MP4 browser playback QA. */
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {createRequire}=require('node:module');
const {pipeline}=require('node:stream/promises');
const root=path.resolve(__dirname,'..');
const project=path.join(root,'website/promo/latest');
const cache=path.join(root,'.cache/promo-latest');
const film=JSON.parse(fs.readFileSync(path.join(project,'film.json'),'utf8'));
const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const flag=name=>process.argv.includes(name);
const bundled='C:/Users/binchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const runtimeRequire=createRequire(path.join(process.env.CRYOCLAW_PLAYWRIGHT_PATH||bundled,'package.json'));
const {chromium}=runtimeRequire('playwright');
const playwrightHome=path.join(os.homedir(),'AppData/Local/ms-playwright');
const headlessDirectory=fs.existsSync(playwrightHome)?fs.readdirSync(playwrightHome).filter(name=>/^chromium_headless_shell-\d+$/.test(name)).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)))[0]:null;
const defaultHeadless=headlessDirectory?path.join(playwrightHome,headlessDirectory,'chrome-headless-shell-win64/chrome-headless-shell.exe'):null;
const browserPath=arg('--browser')||process.env.HYPERFRAMES_BROWSER_PATH||(defaultHeadless&&fs.existsSync(defaultHeadless)?defaultHeadless:null);
const renderBrowserPath=arg('--render-browser')||process.env.HYPERFRAMES_BROWSER_PATH||(defaultHeadless&&fs.existsSync(defaultHeadless)?defaultHeadless:browserPath);
const ffmpeg=arg('--ffmpeg')||process.env.FFMPEG_PATH||path.join(root,'.cache/promo-deps/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
const ffprobe=arg('--ffprobe')||process.env.HYPERFRAMES_FFPROBE_PATH||path.join(root,'.cache/hyperframes-tools/node_modules/@ffprobe-installer/win32-x64/ffprobe.exe');
const cli=path.join(root,'.cache/hyperframes-tools/node_modules/hyperframes/bin/hyperframes.mjs');
const output=path.join(root,'website/assets/cryoclaw-demo.mp4');
const captionOutput=path.join(root,'website/assets/cryoclaw-demo.zh-CN.vtt');
const posterOutput=path.join(root,'website/assets/cryoclaw-demo-poster.jpg');
const staged={video:path.join(cache,'cryoclaw-demo-render.mp4'),captions:path.join(cache,'cryoclaw-demo.zh-CN.vtt'),poster:path.join(cache,'cryoclaw-demo-poster.jpg')};
const videoBudget=30*1024*1024;
fs.mkdirSync(cache,{recursive:true});
const env={...process.env,DO_NOT_TRACK:'1',HYPERFRAMES_NO_TELEMETRY:'1',HYPERFRAMES_FFMPEG_PATH:ffmpeg,HYPERFRAMES_FFPROBE_PATH:ffprobe,...(renderBrowserPath?{HYPERFRAMES_BROWSER_PATH:renderBrowserPath}:{})};
function run(binary,args,options={}){
  return new Promise((resolve,reject)=>{const child=spawn(binary,args,{cwd:root,env,stdio:'inherit',windowsHide:true,...options});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`${path.basename(binary)} exited ${code}`)));});
}
async function writeScore(){
  const rate=48000,frames=rate*film.duration,pcm=Buffer.alloc(frames*4);
  const chords=[[130.813,164.814,195.998,246.942],[110,130.813,164.814,195.998],[87.307,130.813,174.614,220],[97.999,146.832,195.998,246.942],[130.813,164.814,195.998,261.626]];
  for(let i=0;i<frames;i++){
    const t=i/rate,step=.4,beat=Math.floor(t/step),age=t%step,chord=chords[Math.floor(t/9)%chords.length],note=chord[[0,2,1,3,2,1,3,2][beat%8]]*2;
    const envNote=Math.min(1,age/.025)*Math.exp(-age*9),bell=(Math.sin(2*Math.PI*note*t)+.1*Math.sin(4*Math.PI*note*t))*.052*envNote;
    const chordAge=t%9,padEnvelope=Math.min(1,chordAge/.6,(9-chordAge)/.6),pad=chord.reduce((v,f,j)=>v+Math.sin(2*Math.PI*f*t)/(j+1),0)*.015*padEnvelope;
    const fade=Math.min(1,t/.6,Math.max(0,(film.duration-t)/1.2));
    for(let ch=0;ch<2;ch++)pcm.writeInt16LE(Math.round((bell*(1+(ch?1:-1)*.1*Math.sin(beat))+pad)*fade*32767),(i*2+ch)*2);
  }
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*4,28);header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
  const wav=path.join(cache,'score.wav');fs.writeFileSync(wav,Buffer.concat([header,pcm]));
  const encoder=spawn(ffmpeg,['-hide_banner','-loglevel','warning','-i',wav,'-c:a','libmp3lame','-b:a','128k','-f','mp3','pipe:1'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let log='';encoder.stderr.on('data',chunk=>log+=chunk);
  const done=new Promise((resolve,reject)=>{encoder.on('error',reject);encoder.on('close',code=>code===0?resolve():reject(new Error(log)));});
  await Promise.all([pipeline(encoder.stdout,fs.createWriteStream(path.join(project,'media/score.mp3'))),done]);
}
function probe(file){return JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8',windowsHide:true}));}
function mp4Boxes(file){
  const fd=fs.openSync(file,'r'),length=fs.statSync(file).size,boxes=[];
  try{for(let offset=0;offset+8<=length;){const header=Buffer.alloc(16);fs.readSync(fd,header,0,Math.min(16,length-offset),offset);let size=header.readUInt32BE(0);if(size===1)size=Number(header.readBigUInt64BE(8));else if(size===0)size=length-offset;const type=header.toString('ascii',4,8);boxes.push({type,offset,size});if(size<8)break;offset+=size;}}finally{fs.closeSync(fd);}
  return boxes;
}
function writeCaptions(destination=captionOutput){
  const cues=film.captions;
  if(!Array.isArray(cues)||!cues.length)throw new Error('film.json needs caption cues');
  for(let index=0;index<cues.length;index++){
    const [start,end,text]=cues[index];
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>film.duration||index&&start<cues[index-1][1]||typeof text!=='string'||!text)throw new Error(`Invalid caption cue ${index}`);
  }
  const stamp=t=>{
    const ms=Math.round(t*1000);
    return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;
  };
  fs.writeFileSync(destination,'WEBVTT\n\n'+cues.map(([start,end,text])=>`${stamp(start)} --> ${stamp(end)}\n${text}\n`).join('\n'));
}
function checkTimeline(){
  if(!Number.isFinite(film.duration)||film.duration<=0||film.duration>59)throw new Error('The website demo must stay below one minute');
  for(let index=0;index<film.scenes.length;index++){
    const scene=film.scenes[index],previous=index?film.scenes[index-1].end:0;
    if(scene.start!==previous||!Number.isFinite(scene.end)||scene.end<=scene.start)throw new Error(`Scene gap or invalid interval: ${scene.id}`);
  }
  if(film.scenes.at(-1).end!==film.duration)throw new Error('Scene timeline does not fill the film');
  if(film.captions[0][0]!==0||film.captions.at(-1)[1]!==film.duration)throw new Error('Captions must cover the complete film');
}
function checkMedia(){
  const html=fs.readFileSync(path.join(project,'index.html'),'utf8');
  const composition=html.match(/<main\b[^>]+data-duration="([\d.]+)"/);
  if(Number(composition?.[1])!==film.duration)throw new Error('Composition duration differs from film.json');
  const recordings=[];
  for(const scene of film.scenes.filter(scene=>scene.media)){
    const metadata=probe(path.join(project,scene.media));
    const video=metadata.streams.find(stream=>stream.codec_type==='video');
    const duration=Number(metadata.format.duration),expected=scene.end-scene.start;
    if(video?.codec_name!=='h264'||video.pix_fmt!=='yuv420p'||Math.abs(duration-expected)>.12)throw new Error(`Recording duration/codec differs from the scene: ${scene.id} ${duration}s, expected ${expected}s`);
    const manifest=JSON.parse(fs.readFileSync(path.join(project,scene.media+'.provenance.json'),'utf8'));
    if(manifest.speed!==1||!Number.isFinite(manifest.sourceDuration)||manifest.sourceDuration+.12<expected||manifest.trimStart+expected>manifest.sourceDuration+.12||!(/^[a-f0-9]{64}$/i.test(manifest.sourceConcatSha256)))throw new Error(`Recording provenance is inconsistent: ${scene.id}`);
    const tag=html.match(new RegExp(`<video\\b[^>]+id="${scene.id}-video"[^>]*>`))?.[0]||'';
    const attributes=Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match=>[match[1],match[2]]));
    if(Number(attributes['data-start'])!==scene.start||Math.abs(Number(attributes['data-duration'])-expected)>1e-6)throw new Error(`HTML clip timing differs from film.json: ${scene.id}`);
    recordings.push({scene:scene.id,duration,width:video.width,height:video.height,fps:video.avg_frame_rate,speed:manifest.speed,source:manifest.source,sourceConcatSha256:manifest.sourceConcatSha256});
  }
  fs.writeFileSync(path.join(cache,'recordings.json'),JSON.stringify(recordings,null,2)+'\n');
}
async function browserChecks(draft,assets={video:output,captions:captionOutput,poster:posterOutput}){
  const website=path.join(root,'website');
  const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.jpg':'image/jpeg','.png':'image/png','.mp4':'video/mp4','.mp3':'audio/mpeg','.vtt':'text/vtt; charset=utf-8','.woff2':'font/woff2'};
  const server=http.createServer((req,res)=>{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const requested=path.resolve(website,pathname.replace(/^\//,'')||'index.html');
    if(!requested.startsWith(website+path.sep)){res.writeHead(403);res.end();return;}
    const file=pathname==='/assets/cryoclaw-demo.mp4'?assets.video:pathname==='/assets/cryoclaw-demo.zh-CN.vtt'?assets.captions:requested;
    fs.stat(file,(error,stat)=>{
      if(error||!stat.isFile()){res.writeHead(404);res.end();return;}
      const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/),headers={'Content-Type':mime[path.extname(file)]||'application/octet-stream','Accept-Ranges':'bytes'};
      if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),stat.size-1):stat.size-1;if(start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${stat.size}`,'Content-Length':end-start+1});fs.createReadStream(file,{start,end}).pipe(res);}
      else{res.writeHead(200,{...headers,'Content-Length':stat.size});fs.createReadStream(file).pipe(res);}
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser;
  try{
    browser=await chromium.launch({headless:true,...(browserPath?{executablePath:browserPath}:{}),args:['--disable-background-timer-throttling']});
    const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1,colorScheme:'light',reducedMotion:'no-preference'});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`${origin}/promo/latest/index.html`);await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>window.promoReady);
    const seek=async time=>{
      await page.evaluate(async t=>{
        window.renderFrame(t);
        for(const video of document.querySelectorAll('video')){
          const start=Number(video.dataset.start),end=start+Number(video.dataset.duration);
          if(t<start||t>end)continue;
          if(video.readyState<1)await new Promise((resolve,reject)=>{video.addEventListener('loadedmetadata',resolve,{once:true});video.addEventListener('error',()=>reject(new Error(`Missing source video ${video.src}`)),{once:true});});
          const target=Math.min(video.duration-.04,Math.max(0,t-start));
          if(Math.abs(video.currentTime-target)>.005)await new Promise(resolve=>{video.addEventListener('seeked',resolve,{once:true});video.currentTime=target;});
        }
      },time);
    };
    const previews=[];
    for(const [time,name] of film.previews){
      const scene=film.scenes.findLast(scene=>time>=scene.start);
      if(draft&&scene.media)continue;
      await seek(time);
      const layout=await page.locator(`#${scene.id}`).evaluate(element=>{
        const bounds=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
        const text=[...element.querySelectorAll('h1,h2,p,.source-badge')];
        const clipped=text.filter(node=>{const style=getComputedStyle(node),clips=value=>['hidden','clip','scroll','auto'].includes(value);return clips(style.overflowX)&&node.scrollWidth>node.clientWidth+2||clips(style.overflowY)&&node.scrollHeight>node.clientHeight+2;}).map(node=>node.textContent);
        const outside=text.filter(node=>{const r=bounds(node);return r.left<0||r.top<0||r.right>1920||r.bottom>1080;}).map(node=>node.textContent);
        const frame=element.querySelector('.product-frame');
        return {opacity:Number(getComputedStyle(element).opacity),clipped,outside,frame:frame?bounds(frame):null,metrics:text.map(node=>({text:node.textContent,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,overflow:getComputedStyle(node).overflow,rect:bounds(node)}))};
      });
      if(layout.opacity<.99||layout.clipped.length||layout.outside.length)throw new Error(`Scene ${scene.id} is hidden or has clipped text: ${JSON.stringify(layout)}`);
      const screenshot=path.join(cache,`${name}.jpg`);await page.screenshot({path:screenshot,type:'jpeg',quality:94});previews.push({time,name,path:screenshot,layout});
    }
    if(!draft){await seek(film.posterTime);await page.screenshot({path:assets.poster,type:'jpeg',quality:94});}
    const sourceChecks=await page.evaluate(()=>({font:document.fonts.check('64px DemoMiSans'),timelines:Object.keys(window.__timelines),duration:window.promoDuration,viewport:{width:innerWidth,height:innerHeight}}));
    if(sourceChecks.duration!==film.duration||!sourceChecks.font)throw new Error(`Source timeline or font failed: ${JSON.stringify(sourceChecks)}`);
    if(errors.length)throw new Error(errors.join('\n'));
    const contact=async(items,name)=>{
      const contactPage=await browser.newPage({viewport:{width:1600,height:Math.ceil(items.length/2)*495},deviceScaleFactor:1});
      await contactPage.setContent(`<html><body style="margin:0;background:#e8e8e8;font:18px sans-serif;display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:18px">${items.map(p=>`<div><p style="margin:0 0 8px">${p.time.toFixed(1)} s / ${p.name}</p><img style="width:100%;display:block"></div>`).join('')}</body></html>`);
      // Cache files are outside the web root; embed the review JPEGs locally.
      await contactPage.evaluate(images=>{[...document.images].forEach((img,i)=>img.src=images[i]);},items.map(p=>'data:image/jpeg;base64,'+fs.readFileSync(p.path).toString('base64')));
      await contactPage.evaluate(()=>Promise.all([...document.images].map(img=>img.decode())));
      await contactPage.screenshot({path:path.join(cache,name),type:'jpeg',quality:92,fullPage:true});
      await contactPage.close();
    };
    await contact(previews,draft?'draft-contact.jpg':'contact-sheet.jpg');
    let playback=null;
    if(!draft){
      const rangeResponse=await fetch(`${origin}/assets/cryoclaw-demo.mp4`,{headers:{Range:'bytes=0-31'}});
      const rangeBytes=Buffer.from(await rangeResponse.arrayBuffer());
      if(rangeResponse.status!==206||rangeBytes.length!==32||rangeBytes.toString('ascii',4,8)!=='ftyp')throw new Error('The staged MP4 failed byte-range playback preparation');
      await page.setContent(`<html><body style="margin:0"><video style="width:100%;height:100vh" muted controls preload="auto" src="${origin}/assets/cryoclaw-demo.mp4"><track kind="captions" src="${origin}/assets/cryoclaw-demo.zh-CN.vtt" srclang="zh-CN" default></video></body></html>`);
      playback=await page.locator('video').evaluate(async video=>{
        video.muted=true;await video.play();
        await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Actual MP4 playback timed out')),15000);const check=()=>{if(video.currentTime>.25){clearTimeout(timeout);video.removeEventListener('timeupdate',check);resolve();}};video.addEventListener('timeupdate',check);});
        video.pause();return {duration:video.duration,width:video.videoWidth,height:video.videoHeight,currentTime:video.currentTime,readyState:video.readyState,error:video.error?.message||null};
      });
      if(Math.abs(playback.duration-film.duration)>.12||playback.width!==film.width||playback.height!==film.height||playback.error)throw new Error(`Actual video failed: ${JSON.stringify(playback)}`);
      playback.captions=await page.locator('video').evaluate(async video=>{
        video.controls=false;const track=video.querySelector('track');track.track.mode='hidden';
        if(track.readyState!==2)await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Caption loading timed out')),10000);track.addEventListener('load',()=>{clearTimeout(timeout);resolve();},{once:true});track.addEventListener('error',()=>{clearTimeout(timeout);reject(new Error('Caption loading failed'));},{once:true});});
        const cues=[...track.track.cues];return {cues:cues.length,end:cues.at(-1)?.endTime};
      });
      if(playback.captions.cues!==film.captions.length||Math.abs(playback.captions.end-film.duration)>.002)throw new Error(`Actual captions differ from film.json: ${JSON.stringify(playback.captions)}`);
      playback.range={status:rangeResponse.status,bytes:rangeBytes.length,contentRange:rangeResponse.headers.get('content-range')};
      const playbackPreviews=[];
      for(const [time,name] of film.previews){
        await page.locator('video').evaluate(async(video,t)=>{await new Promise(resolve=>{video.addEventListener('seeked',resolve,{once:true});video.currentTime=t;});},time);
        const screenshot=path.join(cache,`playback-${name}.jpg`);
        await page.screenshot({path:screenshot,type:'jpeg',quality:92});playbackPreviews.push({time,name,path:screenshot});
      }
      await contact(playbackPreviews,'playback-contact-sheet.jpg');
      const captionTime=film.previews.find(([,name])=>name==='request')?.[0]??film.duration-2;
      await page.locator('video').evaluate(async(video,time)=>{await new Promise(resolve=>{video.addEventListener('seeked',resolve,{once:true});video.currentTime=time;});video.textTracks[0].mode='showing';},captionTime);
      await page.screenshot({path:path.join(cache,'playback-captions.jpg'),type:'jpeg',quality:92});
    }
    const report={film,sourceChecks,previews,playback,rendererExceptions:errors};
    fs.writeFileSync(path.join(cache,draft?'draft-verification.json':'verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({sourceChecks,playback,previews:previews.length},null,2));
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
async function fitVideoBudget(file){
  if(fs.statSync(file).size<videoBudget)return file;
  const compact=path.join(cache,'cryoclaw-demo-compact.mp4');
  await run(ffmpeg,['-hide_banner','-loglevel','warning','-y','-i',file,'-map','0:v:0','-map','0:a:0','-c:v','libx264','-preset','slow','-crf','19','-maxrate','3600k','-bufsize','7200k','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-movflags','+faststart',compact]);
  if(fs.statSync(compact).size>=videoBudget)throw new Error('The demo exceeds its 30 MiB website/card-video budget');
  return compact;
}
function replaceAsset(from,to){const temporary=to+'.partial';fs.copyFileSync(from,temporary);fs.renameSync(temporary,to);}
async function main(){
  checkTimeline();
  const draft=flag('--draft-stills');
  if(draft){await browserChecks(true);return;}
  if(flag('--score-only')){await writeScore();writeCaptions();console.log('Generated the original offline score and WebVTT captions.');return;}
  const missing=film.scenes.filter(s=>s.media&&!fs.existsSync(path.join(project,s.media))).map(s=>s.media);
  if(missing.length)throw new Error(`Real recording assets are required: ${missing.join(', ')}`);
  checkMedia();
  const checkOnly=flag('--check-only');
  if(!checkOnly){
    await writeScore();writeCaptions(staged.captions);
    for(const command of ['lint','validate','inspect'])await run(process.execPath,[cli,command,project,...(command==='inspect'?['--samples','15']:[])]);
    if(!flag('--verify-only'))await run(process.execPath,[cli,'render',project,'--output',staged.video,'--fps',String(film.fps),'--quality','high','--crf','17','--video-frame-format','png','--experimental-fast-capture=false','--workers','2']);
  }
  if(flag('--verify-only'))return;
  const finalVideo=checkOnly?output:await fitVideoBudget(staged.video);
  if(fs.statSync(finalVideo).size>=videoBudget)throw new Error('The demo exceeds its 30 MiB website/card-video budget');
  const metadata=probe(finalVideo),video=metadata.streams.find(s=>s.codec_type==='video'),audio=metadata.streams.find(s=>s.codec_type==='audio');
  const [rateNumerator,rateDenominator]=video?.avg_frame_rate?.split('/').map(Number)||[],frameRate=rateNumerator/rateDenominator;
  if(video?.codec_name!=='h264'||video.width!==film.width||video.height!==film.height||video.pix_fmt!=='yuv420p'||audio?.codec_name!=='aac'||audio.channels!==2||!Number.isFinite(frameRate)||Math.abs(frameRate-film.fps)>.001||Math.abs(Number(metadata.format.duration)-film.duration)>.12||Number(metadata.format.duration)>=60)throw new Error(`Invalid deliverable media: ${JSON.stringify(metadata)}`);
  const boxes=mp4Boxes(finalVideo),moov=boxes.findIndex(box=>box.type==='moov'),mdat=boxes.findIndex(box=>box.type==='mdat');
  if(moov<0||mdat<0||moov>mdat)throw new Error('MP4 metadata must precede video data for progressive website playback');
  fs.writeFileSync(path.join(cache,'ffprobe.json'),JSON.stringify({...metadata,progressivePlayback:true,topLevelBoxes:boxes},null,2)+'\n');
  await browserChecks(false,checkOnly?undefined:{...staged,video:finalVideo});
  if(!checkOnly){replaceAsset(staged.captions,captionOutput);replaceAsset(staged.poster,posterOutput);replaceAsset(finalVideo,output);}
  const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
  const delivery={version,bytes:fs.statSync(output).size,budgetBytes:videoBudget,sha256:crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex'),duration:Number(metadata.format.duration),width:video.width,height:video.height,fps:frameRate,video:'website/assets/cryoclaw-demo.mp4',poster:'website/assets/cryoclaw-demo-poster.jpg',captions:'website/assets/cryoclaw-demo.zh-CN.vtt',url:`https://cryoconite.cn/CryoClaw/assets/cryoclaw-demo.mp4?v=${encodeURIComponent(version)}`};
  fs.writeFileSync(path.join(cache,'delivery.json'),JSON.stringify(delivery,null,2)+'\n');console.log(JSON.stringify({published:delivery},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
