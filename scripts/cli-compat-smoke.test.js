const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {defaultCliNodeBin}=require('./cli-compat-smoke');

test('CLI reference uses the physical native Node and never falls through an incompatible policy',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cryoclaw-cli-runtime-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const runtime=path.join(root,'runtime'),policy=path.join(runtime,'cryoclaw-runtime.json');fs.mkdirSync(runtime,{recursive:true});
 assert.equal(defaultCliNodeBin(root),require('electron'),'Legacy ASAR keeps the Electron compatibility runner');
 fs.writeFileSync(policy,'{}');assert.throws(()=>defaultCliNodeBin(root),/policy is incompatible/);
 fs.writeFileSync(policy,JSON.stringify({kind:'node',gatewayMode:'loose'}));assert.throws(()=>defaultCliNodeBin(root),/native Node is missing/);
 const node=path.join(runtime,'node.exe');fs.writeFileSync(node,'fixture');assert.equal(defaultCliNodeBin(root),node);
});
