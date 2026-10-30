#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
function parseRange(value,size){
 if(!value)return {start:0,end:size-1};const match=/^bytes=(\d*)-(\d*)$/.exec(value.trim());if(!match)throw Error('Unsupported Range: '+value);
 let start,end;if(!match[1]){const suffix=Number(match[2]);assert.ok(Number.isSafeInteger(suffix)&&suffix>0);start=Math.max(0,size-suffix);end=size-1;}else{start=Number(match[1]);end=match[2]?Number(match[2]):size-1;}
 assert.ok(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<size&&end>=start,'Unsatisfiable Range');return {start,end:Math.min(end,size-1)};
}
async function createStaticUpdateServer({manifest,assets,throttleBytesPerSecond=0,corruptBlockmap=false}){
 const requests=[];const server=http.createServer(async(req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname),name=pathname.slice(1);let body;
  if(pathname==='/latest.yml')body=manifest;else if(assets.has(name)){if(corruptBlockmap&&name.endsWith('.blockmap'))body=Buffer.from('corrupted-blockmap');else body=assets.get(name);}else{res.writeHead(404);res.end('not found');return;}
  let start=0,end=body.length-1,status=200;try{if(req.headers.range){({start,end}=parseRange(req.headers.range,body.length));status=206;}}catch{res.writeHead(416,{'Content-Range':`bytes */${body.length}`});res.end();return;}
  const length=Math.max(0,end-start+1),chunk=body.subarray(start,start+length);requests.push({path:pathname,range:req.headers.range??null,status,bytes:chunk.length});
  res.writeHead(status,{'Content-Type':'application/octet-stream','Content-Length':chunk.length,'Accept-Ranges':'bytes',...(status===206?{'Content-Range':`bytes ${start}-${end}/${body.length}`}:{})});
  if(req.method==='HEAD'){res.end();return;}
  if(throttleBytesPerSecond>0){const step=64*1024;for(let offset=0;offset<chunk.length;offset+=step){res.write(chunk.subarray(offset,Math.min(chunk.length,offset+step)));await new Promise(resolve=>setTimeout(resolve,Math.min(step,chunk.length-offset)*1000/throttleBytesPerSecond));}res.end();}else res.end(chunk);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,requests,origin:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
}
async function hashFile(file,algorithm='sha512',encoding='base64'){const hash=crypto.createHash(algorithm);await new Promise((resolve,reject)=>{const stream=fs.createReadStream(file);stream.on('data',chunk=>hash.update(chunk));stream.on('error',reject);stream.on('end',resolve);});return hash.digest(encoding);}
async function main(argv=process.argv){
 const option=(name,fallback)=>{const index=argv.indexOf(name);return index>=0?argv[index+1]:fallback};
 if(argv.includes('--help')){console.log('node scripts/update-download-benchmark.js --old <old.exe> --new <new.exe> --manifest <latest.yml> [--full] [--corrupt-blockmap] [--throttle <bytes/sec>] [--out <report.json>]');return;}
 const oldInstaller=path.resolve(option('--old','')),newInstaller=path.resolve(option('--new','')),manifestPath=path.resolve(option('--manifest','')),out=option('--out',null);
 for(const file of [oldInstaller,newInstaller,manifestPath])assert.ok(fs.existsSync(file),'Missing input: '+file);
 const manifest=fs.readFileSync(manifestPath),parsed=require('js-yaml').load(manifest.toString('utf8')),newName=path.basename(newInstaller),oldName=path.basename(oldInstaller),oldVersion=oldName.match(/Setup-(\d+\.\d+\.\d+)/)?.[1];assert.ok(oldVersion,'Cannot infer old version');
 assert.equal(parsed.version,newName.match(/Setup-(\d+\.\d+\.\d+)/)?.[1],'New installer/version mismatch');
 const temp=await fs.promises.mkdtemp(path.join(os.tmpdir(),'cryoclaw-update-benchmark-')),cacheDir=path.join(temp,'updater');await fs.promises.mkdir(cacheDir,{recursive:true});
 await fs.promises.copyFile(oldInstaller,path.join(cacheDir,'installer.exe'));if(fs.existsSync(oldInstaller+'.blockmap'))await fs.promises.copyFile(oldInstaller+'.blockmap',path.join(cacheDir,'current.blockmap'));
 const assets=new Map([[newName,await fs.promises.readFile(newInstaller)]]);for(const file of [newInstaller+'.blockmap',oldInstaller+'.blockmap'])if(fs.existsSync(file))assets.set(path.basename(file),await fs.promises.readFile(file));
 const remote=await createStaticUpdateServer({manifest,assets,throttleBytesPerSecond:Number(option('--throttle','0')),corruptBlockmap:argv.includes('--corrupt-blockmap')});
 const report={schemaVersion:1,oldVersion,newVersion:parsed.version,mode:argv.includes('--full')?'full':'differential',corruptBlockmap:argv.includes('--corrupt-blockmap'),throttleBytesPerSecond:Number(option('--throttle','0')),startedAt:new Date().toISOString(),ok:false};let updater;
 try{
  const config=path.join(temp,'app-update.yml');fs.writeFileSync(config,'provider: generic\nurl: '+remote.origin+'\nupdaterCacheDirName: updater\n');
  const adapter={version:oldVersion,name:'cryoclaw',isPackaged:true,appUpdateConfigPath:config,userDataPath:temp,baseCachePath:temp,whenReady:async()=>{},relaunch:()=>{throw Error('No relaunch in download benchmark');},quit:()=>{throw Error('No install in download benchmark');},onQuit(){}};
  const {NsisUpdater}=require('electron-updater/out/NsisUpdater');const {NodeHttpExecutor}=require('builder-util'),{configureRequestUrl,configureRequestOptions}=require('builder-util-runtime');updater=new NsisUpdater(null,adapter);updater.httpExecutor=new NodeHttpExecutor();
  updater.httpExecutor.download=async function(url,destination,options){return options.cancellationToken.createPromise((resolve,reject,onCancel)=>{const requestOptions={headers:options.headers||undefined,redirect:'manual'};configureRequestUrl(url,requestOptions);configureRequestOptions(requestOptions);this.doDownload(requestOptions,{destination,options,onCancel,callback:error=>error==null?resolve(destination):reject(error),responseHandler:null},0);});};updater.logger={info(){},debug(){},warn(){},error(){}};
  updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.disableWebInstaller=true;updater.disableDifferentialDownload=argv.includes('--full');updater.setFeedURL({provider:'generic',url:remote.origin,useMultipleRangeRequest:false});
  const logs=[];updater.logger={info:msg=>logs.push(String(msg)),debug(){},warn:msg=>logs.push(String(msg)),error:msg=>logs.push(String(msg))};
  let downloadedEvent=null;updater.on('update-downloaded',info=>{downloadedEvent=info;});
  const checkStarted=performance.now();const found=await updater.checkForUpdates();report.checkMs=performance.now()-checkStarted;assert.equal(found.updateInfo.version,parsed.version);
  const downloadStarted=performance.now(),files=await updater.downloadUpdate();report.downloadMs=performance.now()-downloadStarted;assert.ok(files.length>0&&downloadedEvent,'Download did not settle');
  const output=files[0],expected=parsed.files.find(file=>file.url===newName)??parsed.files[0];report.outputBytes=(await fs.promises.stat(output)).size;report.sha512=await hashFile(output);report.sha512Verified=report.sha512===expected.sha512&&report.outputBytes===expected.size;assert.ok(report.sha512Verified,'Downloaded installer hash/size mismatch');
  report.fallbackToFull=logs.some(line=>/fallback to full download/i.test(line));report.requests=remote.requests;report.responseBytes=remote.requests.reduce((sum,row)=>sum+row.bytes,0);report.installerResponseBytes=remote.requests.filter(row=>row.path.endsWith('.exe')).reduce((sum,row)=>sum+row.bytes,0);report.metadataResponseBytes=report.responseBytes-report.installerResponseBytes;report.ok=true;
 }catch(error){report.error=String(error.stack||error);throw error;}
 finally{report.finishedAt=new Date().toISOString();await remote.close();updater?.removeAllListeners();if(out){fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(path.resolve(out),JSON.stringify(report,null,2)+'\n');}await fs.promises.rm(temp,{recursive:true,force:true});}
 console.log(JSON.stringify(report,null,2));
}
module.exports={parseRange,createStaticUpdateServer,hashFile,main};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
