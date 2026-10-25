#!/usr/bin/env node
/* Deterministic product film exporter. No model, cloud API, or user data. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const bundledRequire = process.env.CRYOCLAW_PLAYWRIGHT_PATH
  ? createRequire(path.join(path.resolve(process.env.CRYOCLAW_PLAYWRIGHT_PATH), 'package.json')) : require;
const { chromium } = bundledRequire('playwright');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const ffmpegPath = arg('--ffmpeg') || process.env.FFMPEG_PATH || 'ffmpeg';
const checkOnly = process.argv.includes('--check-only');
const film=JSON.parse(fs.readFileSync(path.join(root,'website/promo/film.json'),'utf8'));
const {duration,fps}=film, frameCount=duration*fps;
const cache = path.join(root, '.cache', 'promo');
const output = path.join(root, 'website', 'assets');
fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(output, { recursive: true });

// Original 120 BPM score: soft triad arpeggios, a warm bass pulse and transition chimes.
function writeScore(file) {
  const rate=48000, frames=rate*duration, channels=2;
  const pcm=Buffer.alloc(frames*channels*2);
  const chords=[[130.813,164.814,195.998,246.942],[110,130.813,164.814,195.998],[87.307,130.813,174.614,220],[97.999,146.832,195.998,246.942],[130.813,164.814,195.998,261.626]];
  for(let i=0;i<frames;i++){
    const t=i/rate,beat=Math.floor(t/.3),age=t% .3,chord=chords[Math.min(4,Math.floor(t/4))],note=chord[[0,2,1,3,2,1,3,2][beat%8]]*2;
    const attack=Math.min(1,age/.012),env=attack*Math.exp(-age*12);
    const bell=(Math.sin(2*Math.PI*note*t)+.12*Math.sin(2*Math.PI*note*2*t))*.09*env;
    const chordAge=t%4,padEnvelope=Math.min(1,chordAge/.18,(4-chordAge)/.2);
    const pad=chord.reduce((value,freq,j)=>value+Math.sin(2*Math.PI*freq*t)/(j+1),0)*.03*padEnvelope;
    const pulseAge=t% .5,pulse=Math.sin(2*Math.PI*(64*pulseAge-19*pulseAge*pulseAge))*.09*Math.exp(-pulseAge*22);
    let chime=0;
    for(const cue of [0,3.4,6.6,10.2,17.8]){const a=t-cue;if(a>=0&&a<.5)chime+=Math.sin(2*Math.PI*1046.5*a)*.035*Math.exp(-a*11)*Math.min(1,a/.01);}
    for(const cue of film.clicks){const a=t-cue;if(a>=0&&a<.06)chime+=Math.sin(2*Math.PI*1800*a)*.025*Math.exp(-a*100)*Math.min(1,a/.003);}
    const fade=Math.min(1,t/.12,Math.max(0,(duration-t)/.7));
    for(let ch=0;ch<2;ch++){
      const stereo=bell*(1+(ch?1:-1)*.12*Math.sin(beat));
      pcm.writeInt16LE(Math.round(Math.max(-1,Math.min(1,(stereo+pad+pulse+chime)*fade))*32767),(i*2+ch)*2);
    }
  }
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*4,28);header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
  fs.writeFileSync(file,Buffer.concat([header,pcm]));
}

async function main(){
  const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.mp4':'video/mp4','.vtt':'text/vtt'};
  const server=http.createServer((req,res)=>{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(pathname==='/api/cryoclaw-release'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({tag_name:'v2026.1019.0',assets:[]}));return;}
    const relative=pathname.replace(/^\/(?:CryoClaw\/)?/,'');
    const file=path.resolve(root,'website',relative||'index.html');
    const websiteRoot=path.join(root,'website');
    if(!file.startsWith(websiteRoot+path.sep)){res.writeHead(403);res.end();return;}
    fs.readFile(file,(error,data)=>{if(error){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(data);});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser;
  try{
    browser=await chromium.launch({headless:true,args:[`--log-file=${path.join(cache,'chromium.log')}`],...(arg('--browser')?{executablePath:arg('--browser')}:{})});
    const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1,colorScheme:'light',reducedMotion:'no-preference'});
    const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error(`Film renderer: ${error.message}`);});
    await page.goto(`${origin}/promo/index.html?render`);await page.evaluate(()=>document.fonts.ready);
    await page.waitForFunction(()=>window.promoReady===true);
    for(const [time,name] of film.previews){
      await page.evaluate(t=>window.renderFrame(t),time);
      await page.screenshot({path:path.join(cache,`${name}.jpg`),type:'jpeg',quality:95});
    }
    const hitChecks=await page.evaluate(()=>window.promoConfig.clicks.map(t=>{window.renderFrame(t);const state=window.promoFrameState,p=window.promoTargets[state.action];return{time:t,action:state.action,error:Math.hypot(state.cursor.x-p.x,state.cursor.y-p.y)};}));
    if(hitChecks.some(check=>check.error>.5))throw new Error(`Cursor missed control: ${JSON.stringify(hitChecks)}`);
    const cursorModes=await page.evaluate(()=>{
      const times=[.8,1,1.2,1.8,2,2.7,7.5,8.2,11.3,12.6,14.9,15.3,15.8,16.3,17];
      return times.map(time=>{window.renderFrame(time);const hand=document.querySelector('#cursor').classList.contains('dragging');return {time,hand,expected:time>=window.promoConfig.drag.start&&time<=window.promoConfig.drag.end};});
    });
    if(cursorModes.some(check=>check.hand!==check.expected))throw new Error(`Unstable cursor mode: ${JSON.stringify(cursorModes)}`);
    fs.writeFileSync(path.join(cache,'cursor-verification.json'),JSON.stringify({hitChecks,cursorModes},null,2));
    await page.evaluate(()=>window.renderFrame(13.6));
    await page.screenshot({path:path.join(output,'cryoclaw-demo-poster.jpg'),type:'jpeg',quality:92});
    if(!checkOnly){
      const score=path.join(cache,'score.wav');writeScore(score);
      const args=['-y','-hide_banner','-loglevel','warning','-f','image2pipe','-framerate',String(fps),'-vcodec','mjpeg','-i','pipe:0','-i',score,'-vf','scale=in_range=pc:out_range=tv:out_color_matrix=bt709','-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p','-color_range','tv','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-af','volume=2','-c:a','aac','-b:a','160k','-ar','48000','-t',String(duration),'-movflags','+faststart',path.join(output,'cryoclaw-demo.mp4')];
      const encoder=spawn(ffmpegPath,args,{stdio:['pipe','ignore','pipe'],windowsHide:true});
      let log='';encoder.stderr.on('data',data=>log+=data);
      const finished=new Promise((resolve,reject)=>{encoder.on('error',reject);encoder.on('close',code=>code===0?resolve():reject(new Error(`ffmpeg exited ${code}: ${log}`)));});
      encoder.stdin.on('error',()=>{});
      for(let frame=0;frame<frameCount;frame++){
        await page.evaluate(t=>window.renderFrame(t),frame/fps);
        const jpeg=await page.screenshot({type:'jpeg',quality:96});
        if(!encoder.stdin.write(jpeg))await once(encoder.stdin,'drain');
        if(frame%120===0)console.log(`Rendered ${frame}/${frameCount} frames`);
      }
      encoder.stdin.end();await finished;console.log(`Exported 1920×1080 / ${fps} fps / ${duration}s / H.264 + AAC`);
    }
    // Validate the actual landing page, including local-file portability and reduced motion.
    const checks=[];
    for(const [width,height,scheme] of [[1440,1000,'light'],[390,844,'light'],[1440,1000,'dark']]){
      await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme,reducedMotion:'reduce'});
      await page.goto(`${origin}/CryoClaw/index.html`);await page.evaluate(()=>document.fonts.ready);
      const result=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,features:document.querySelectorAll('.bento__card').length,brokenImages:[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src),video:!!document.querySelector('video source[type="video/mp4"]'),headlines:[...document.querySelectorAll('h1')].length}));
      if(result.overflow||result.brokenImages.length||result.features!==10||!result.video||result.headlines!==1)throw new Error(`Website check failed ${width}: ${JSON.stringify(result)}`);
      checks.push({width,scheme,...result});
      await page.screenshot({path:path.join(cache,`website-${width}-${scheme}.jpg`),fullPage:true,type:'jpeg',quality:88});
      if(width===1440&&scheme==='light'){
        const film=page.locator('video');await film.scrollIntoViewIfNeeded();
        const playback=await film.evaluate(async el=>{el.muted=true;await el.play();await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Video playback timed out')),10000);const done=()=>{if(el.currentTime>.08){clearTimeout(timeout);el.removeEventListener('timeupdate',done);resolve();}};el.addEventListener('timeupdate',done);});el.pause();return{duration:el.duration,width:el.videoWidth,height:el.videoHeight,time:el.currentTime};});
        if(Math.abs(playback.duration-duration)>.1||playback.width!==1920||playback.height!==1080)throw new Error(`Invalid video: ${JSON.stringify(playback)}`);
        checks.push({playback});
      }
    }
    if(errors.length)throw new Error(`Renderer exceptions: ${errors.join('; ')}`);
    fs.writeFileSync(path.join(cache,'verification.json'),JSON.stringify({checks,rendererExceptions:errors},null,2));
    console.log(JSON.stringify({checks,rendererExceptions:errors},null,2));
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
