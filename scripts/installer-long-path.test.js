const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {stageInstaller}=require('./lib/stage-installer');

for(const operation of ['rm','readdir'])test(`NSIS removes long Unicode paths and retries a transient ${operation} failure`, {timeout:30000}, async t=>{
  if(process.platform!=='win32'){t.skip('Windows NSIS integration');return;}
  const compiler=process.env.CRYOCLAW_MAKENSIS||path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-3.0.4.1-nsis-3.0.4.1/Bin/makensis.exe');
  if(!fs.existsSync(compiler)){t.skip('Cached NSIS compiler is unavailable');return;}
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cryoclaw-remove-long-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const install=path.join(root,'应用 with spaces'),outside=path.join(root,'unrelated.txt');
  let nested=install;while(nested.length<280)nested=path.join(nested,'deep-folder-中文');
  fs.mkdirSync(nested,{recursive:true});fs.writeFileSync(path.join(nested,'payload.txt'),'payload');fs.writeFileSync(outside,'keep');
  const runtime=path.join(install,'resources','resources','runtime','node.exe');fs.mkdirSync(path.dirname(runtime),{recursive:true});fs.copyFileSync(process.execPath,runtime);fs.writeFileSync(path.join(install,'CryoClaw.exe'),'fixture');fs.writeFileSync(path.join(install,'resources','app.asar'),'fixture');
  // Deterministic EBUSY injection: real NSIS must preserve its native retry path.
  const injected=path.join(root,'first-pass'),helperFile=path.join(root,'native-removal.cjs');
  const injection=`const originalRm=fs.promises.${operation};if(!fs.existsSync(${JSON.stringify(injected)})){fs.writeFileSync(${JSON.stringify(injected)},'injected');let failed=false;fs.promises.${operation}=async(...args)=>{if(!failed){failed=true;const error=Error('fixture locked file');error.code='EBUSY';throw error;}return originalRm.apply(fs.promises,args);};}\n`;
  fs.writeFileSync(helperFile,fs.readFileSync(path.join(__dirname,'remove-installed-files.cjs'),'utf8').replace('// The uninstaller',injection+'// The uninstaller'));
  const source=fs.readFileSync(path.join(__dirname,'installer.nsh'),'utf8');
  const retryLog=path.join(root,'retries.txt');
  const helper=source.match(/!macro cryoclawRemoveInstallDirectory\r?\n[\s\S]*?!macroend/)[0].replace('    Pop $0',`    Pop $0\n    FileOpen $1 "${retryLog}" a\n    FileSeek $1 0 END\n    FileWrite $1 "$0$\\r$\\n"\n    FileClose $1`);
  const macro=source.match(/!macro customRemoveFiles\r?\n[\s\S]*?!macroend/)[0];
  const marker=path.join(root,'complete.txt'),nsi=path.join(root,'remove.nsi'),exe=path.join(root,'remove.exe');
  fs.writeFileSync(nsi,`﻿Unicode true\n!include "LogicLib.nsh"\nName "CryoClaw long-path removal test"\nOutFile "${exe}"\nRequestExecutionLevel user\nSilentInstall silent\n!define CRYOCLAW_REMOVE_HELPER "${helperFile}"\n${helper}\n${macro}\nSection\nStrCpy $INSTDIR "${install}"\n!insertmacro customRemoveFiles\nFileOpen $0 "${marker}" w\nFileWrite $0 "complete"\nFileClose $0\nSectionEnd\n`);
  const compiled=spawnSync(compiler,['/V2',nsi],{encoding:'utf8',windowsHide:true});assert.equal(compiled.status,0,compiled.stderr);
  const staged=await stageInstaller(exe);t.after(()=>staged.cleanup());
  const result=spawnSync(staged.target,[],{timeout:15000,windowsHide:true,env:{...process.env,TEMP:staged.tempRoot,TMP:staged.tempRoot}});
  assert.equal(result.status,0,String(result.error||result.stderr));
  assert.equal(fs.existsSync(install),false,'long-path payload must be fully removed');
  assert.equal(fs.readFileSync(marker,'utf8'),'complete');assert.equal(fs.readFileSync(outside,'utf8'),'keep');
  assert.deepEqual(fs.readFileSync(retryLog,'utf8').trim().split(/\s+/),['1','0'],'native cleanup must retry with its runtime and ownership markers intact');
});
