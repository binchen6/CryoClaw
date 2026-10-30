'use strict';
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
class UnsupportedPairingContract extends Error {}
async function kernelExport(distDir,prefix,name){
 for(const file of fs.readdirSync(distDir).filter(file=>file.startsWith(prefix)&&file.endsWith('.mjs'))){
  const source=fs.readFileSync(path.join(distDir,file),'utf8');
  const exports=source.match(/export\s*\{([^}]+)\}/g)?.join(' ')??'';
  const alias=exports.match(new RegExp('\\b'+name+'\\s+as\\s+(\\w+)\\b'))?.[1];
  if(alias)return (await import(pathToFileURL(path.join(distDir,file)).href))[alias];
 }
 throw new UnsupportedPairingContract(`Kernel pairing contract unavailable: ${name}`);
}
async function listPairingRequests(packageDir,channel){
 if(!['feishu','wecom'].includes(channel))throw new Error('Unsupported pairing channel');
 const distDir=path.join(packageDir,'dist');
 if(!fs.existsSync(distDir))throw new UnsupportedPairingContract('Kernel pairing modules unavailable');
 const [runWithLocalStateOwner,caps]=await Promise.all([
  kernelExport(distDir,'local-state-owner-','runWithLocalStateOwner'),
  kernelExport(distDir,'server-capabilities-','GATEWAY_SERVER_CAPS'),
 ]);
 if(typeof runWithLocalStateOwner!=='function'||typeof caps?.CHANNELS_PAIRING_LIST_OWNER!=='string')throw new UnsupportedPairingContract('Kernel pairing owner contract unavailable');
 // The owner controls authenticated dispatch, offline custody and SQLite admission.
 // Only preflight contract failures may fall back; errors after entering it are final.
 try {
  return await runWithLocalStateOwner({
   method:'channels.pairing.list',params:{channel,format:'cli'},target:`${channel} pairing requests`,
   requiredCapabilities:[caps.CHANNELS_PAIRING_LIST_OWNER],
   runLocal:async({env,assertCurrent})=>{
    const list=await kernelExport(distDir,'pairing-store-','listChannelPairingRequests');
    return list(channel,env,undefined,assertCurrent);
   },
  });
 } catch(error){
  if(error instanceof UnsupportedPairingContract)throw new Error(error.message,{cause:error});
  throw error;
 }
}
module.exports={listPairingRequests,UnsupportedPairingContract};
if(process.argv[1]==='cryoclaw-channel-pairing-list'){
 const packageDir=process.argv[2],channel=process.argv[3];
 listPairingRequests(packageDir,channel).then(requests=>process.stdout.write(JSON.stringify({channel,requests}))).catch(error=>{
  console.error(error.message);process.exitCode=error instanceof UnsupportedPairingContract?78:1;
 });
}
