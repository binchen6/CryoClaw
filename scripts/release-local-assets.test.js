const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {verifyLocalAssets}=require('./lib/release-local-assets');
test('local release assets match server digests and reject stale bytes, sizes and states',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'release-assets-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const name='installer.exe',data=Buffer.from('verified release');fs.writeFileSync(path.join(dir,name),data);
  const asset={name,state:'uploaded',size:data.length,digest:'sha256:'+crypto.createHash('sha256').update(data).digest('hex')};
  await verifyLocalAssets([asset],dir,[name]);
  await assert.rejects(verifyLocalAssets([asset],dir,[name],{[name]:'wrong sha512'}),/manifest SHA-512/);
  for(const patch of [{size:1},{state:'new'},{digest:null},{digest:'sha256:'+'0'.repeat(64)}])await assert.rejects(verifyLocalAssets([{...asset,...patch}],dir,[name]));
  await assert.rejects(verifyLocalAssets([asset],dir,['../outside']),/Invalid local asset name/);
  fs.writeFileSync(path.join(dir,name),'changed');await assert.rejects(verifyLocalAssets([asset],dir,[name]),/mismatch/);
});
