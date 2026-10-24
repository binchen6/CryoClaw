const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {accepts,prunePlatformPackages}=require('./lib/prune-platform-packages');
test('npm negative/positive platform constraints preserve portable packages',()=>{
  assert.equal(accepts(['!darwin'],'win32'),true);assert.equal(accepts(['!win32'],'win32'),false);
  assert.equal(accepts(['linux','darwin'],'win32'),false);assert.equal(accepts(['any'],'win32'),true);assert.equal(accepts(undefined,'win32'),true);
});
test('pruning removes only declared foreign targets at nested npm package boundaries',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cryoclaw-platform-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const pkg=(rel,meta)=>{const dir=path.join(root,rel);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify(meta));return dir;};
  const linux=pkg('node_modules/@native/linux',{os:['linux'],cpu:['x64']}),wrong=pkg('node_modules/@native/arm',{os:['win32'],cpu:['arm64']});
  const current=pkg('node_modules/@native/current',{os:['win32'],cpu:['x64']}),portable=pkg('node_modules/portable',{os:['!darwin']});
  const nested=pkg('plugins/vendor/node_modules/native-other',{os:['darwin']}),data=pkg('data/not-a-package',{os:['linux']});
  const result=prunePlatformPackages(root,'win32','x64');assert.equal(result.packages,3);
  for(const p of [linux,wrong,nested])assert.equal(fs.existsSync(p),false);
  for(const p of [current,portable,data])assert.equal(fs.existsSync(p),true);
  assert.throws(()=>prunePlatformPackages(root,'unknown','x64'),/target/);
});
