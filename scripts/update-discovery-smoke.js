"use strict";
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
function option(name){const i=process.argv.indexOf(name);if(i<0 || !process.argv[i+1])throw Error('Required: '+name);return process.argv[i+1];}
// AppAdapter is the SDK's supported test seam; provider and version-selection logic remain real.
delete process.env.GH_TOKEN;delete process.env.GITHUB_TOKEN;
const deadline=setTimeout(()=>{console.error('Update discovery deadline exceeded');process.exit(1);},90_000);
(async()=>{
  const current=option('--from'),expected=option('--expect'),root=path.resolve(__dirname,'..','.cache','maintenance-update-discovery');
  fs.mkdirSync(root,{recursive:true});const config=path.join(root,'app-update.yml');
  fs.writeFileSync(config,'provider: github\nowner: binchen6\nrepo: CryoClaw\nupdaterCacheDirName: discovery-cache\n');
  const {NsisUpdater}=require('electron-updater/out/NsisUpdater');const {NodeHttpExecutor}=require('builder-util');
  const adapter={version:current,name:'cryoclaw',isPackaged:true,appUpdateConfigPath:config,userDataPath:root,baseCachePath:root,whenReady:async()=>{},relaunch:()=>{throw Error('Discovery must not relaunch');},quit:()=>{throw Error('Discovery must not install');},onQuit(){}};
  const updater=new NsisUpdater(null,adapter);updater.httpExecutor=new NodeHttpExecutor();
  updater.logger={info(){},debug(){},warn(){},error(){}};updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.disableWebInstaller=true;
  updater.setFeedURL(process.argv.includes('--manifest')?{provider:'generic',url:require('../dist/app-update-source').OFFICIAL_UPDATE_BASE,useMultipleRangeRequest:false}:{provider:'github',owner:'binchen6',repo:'CryoClaw',private:false});
  let available=null;updater.on('update-available',info=>{available=info.version;});updater.on('error',()=>{});
  const result=await updater.checkForUpdates();assert.equal(result?.updateInfo.version,expected);assert.equal(available,expected);assert.ok(!result.downloadPromise);
  console.log(JSON.stringify({currentVersion:current,discoveredVersion:expected,updateAvailable:true,autoDownload:false,executor:'NodeHttpExecutor',sdk:require('electron-updater/package.json').version}));
})().then(()=>{clearTimeout(deadline);},error=>{clearTimeout(deadline);console.error(error.message);process.exitCode=1;});
