#!/usr/bin/env node
/* Import genuine CDP screencast frames at their recorded timestamps. No speed-up. */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {pipeline}=require('node:stream/promises');
const root=path.resolve(__dirname,'..');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const input=arg('--input'),output=arg('--output'),segmentSpec=arg('--segments');
if(!input||!output)throw new Error('Usage: node scripts/import-promo-screencast.cjs --input recording.ffconcat --output clip.mp4 [--start 0 --duration 6 | --segments 0:3,5:8 --crossfade 0.166667] [--ffmpeg path]');
const ffmpeg=arg('--ffmpeg')||process.env.FFMPEG_PATH||path.join(root,'.cache/promo-deps/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
const start=Number(arg('--start')||0),duration=arg('--duration');
if(!Number.isFinite(start)||start<0||duration&&(!Number.isFinite(Number(duration))||Number(duration)<=0))throw new Error('Invalid trim interval');
if(segmentSpec&&(arg('--start')||duration))throw new Error('Use either a single trim or an ordered segment list');
async function main(){
  const source=path.resolve(input),destination=path.resolve(output);
  const concat=fs.readFileSync(source,'utf8');
  const sourceDuration=[...concat.matchAll(/^duration\s+([\d.]+)/gm)].reduce((sum,match)=>sum+Number(match[1]),0);
  const entries=[...concat.matchAll(/^file\s+'([^']+)'/gm)].map(match=>match[1]);
  const segments=segmentSpec?.split(',').map(interval=>interval.split(':').map(Number));
  const crossfade=segments?.length>1?Number(arg('--crossfade')??(1/6)):0;
  if(!Number.isFinite(crossfade)||crossfade<0||crossfade>.35)throw new Error('Crossfade must be between 0 and 0.35 seconds');
  if(segments){
    segments.forEach(([begin,end],index)=>{
      if(!Number.isFinite(begin)||!Number.isFinite(end)||begin<0||end-begin<=2*crossfade||end>sourceDuration+.04||index&&begin<segments[index-1][1])throw new Error(`Invalid or nonchronological source segment ${index}`);
    });
  }else if(start>=sourceDuration||duration&&start+Number(duration)>sourceDuration+.04)throw new Error('Requested trim exceeds the genuine recording');
  // CDP JPEGs are full-range BT.601; convert the matrix before tagging the HD clip.
  const conversion='fps=30,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p';
  const filters=[];let editedDuration=duration?Number(duration):sourceDuration-start;
  if(segments){
    if(segments.length>1)filters.push(`[0:v]split=${segments.length}${segments.map((_,i)=>`[s${i}]`).join('')}`);
    segments.forEach(([begin,end],i)=>filters.push(`${segments.length>1?`[s${i}]`:'[0:v]'}trim=start=${begin}:end=${end},setpts=PTS-STARTPTS,${conversion}[v${i}]`));
    let accumulated=segments[0][1]-segments[0][0],previous='v0';
    for(let i=1;i<segments.length;i++){
      const next=`cut${i}`;
      filters.push(crossfade?`[${previous}][v${i}]xfade=transition=fade:duration=${crossfade}:offset=${accumulated-crossfade}[${next}]`:`[${previous}][v${i}]concat=n=2:v=1:a=0[${next}]`);
      accumulated+=segments[i][1]-segments[i][0]-crossfade;previous=next;
    }
    filters.push(`[${previous}]format=yuv420p[edited]`);editedDuration=accumulated;
  }
  const args=['-hide_banner','-loglevel','warning','-f','concat','-safe','0','-i',source,...(segments?['-filter_complex',filters.join(';'),'-map','[edited]']:['-ss',String(start),...(duration?['-t',String(Number(duration))]:[]),'-vf',conversion]),'-an','-c:v','libx264','-preset','medium','-crf','16','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-movflags','frag_keyframe+empty_moov+default_base_moof','-f','mp4','pipe:1'];
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  const temporary=destination+'.partial';
  const encoder=spawn(ffmpeg,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let log='';encoder.stderr.on('data',chunk=>log+=chunk);
  const finished=new Promise((resolve,reject)=>{encoder.on('error',reject);encoder.on('close',code=>code===0?resolve():reject(new Error(`FFmpeg exited ${code}: ${log}`)));});
  await Promise.all([pipeline(encoder.stdout,fs.createWriteStream(temporary)),finished]);
  fs.renameSync(temporary,destination);
  const manifest={kind:'Electron Page.startScreencast recording',source:path.relative(root,source).replaceAll('\\','/'),sourceConcatSha256:crypto.createHash('sha256').update(concat).digest('hex'),frames:new Set(entries).size,fileEntries:entries.length,sourceDuration,trimStart:segments?0:start,trimDuration:editedDuration,...(segments?{segments:segments.map(([begin,end])=>({start:begin,end,speed:1})),transition:{type:crossfade?'crossfade':'cut',duration:crossfade}}:{}),speed:1,outputFps:30,output:path.relative(root,destination).replaceAll('\\','/'),sourceWasUploaded:false,ffmpegArgs:args.map(value=>value===source?path.relative(root,source).replaceAll('\\','/'):value)};
  fs.writeFileSync(destination+'.provenance.json',JSON.stringify(manifest,null,2)+'\n');
  console.log(JSON.stringify({output:destination,frames:manifest.frames,sourceDuration:manifest.sourceDuration,speed:1},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
