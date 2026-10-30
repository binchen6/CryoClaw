const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {removeInstalledFiles}=require('./remove-installed-files.cjs');
test('installation cleanup removes long names and junctions while retaining its runtime and unrelated data',async t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'cryoclaw-native-remove-'));
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const root=path.join(parent,'应用'),outside=path.join(parent,'unrelated'),runtime=path.join(root,'resources','resources','runtime',process.platform==='win32'?'node.exe':'node');
  fs.mkdirSync(path.dirname(runtime),{recursive:true});fs.writeFileSync(runtime,'retained');
  fs.writeFileSync(path.join(root,'CryoClaw.exe'),'app');fs.writeFileSync(path.join(root,'resources','app.asar'),'app');
  let long=root;while(long.length<280)long=path.join(long,'long-name-中文');fs.mkdirSync(long,{recursive:true});fs.writeFileSync(path.join(long,'entry.js'),'long');
  fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep.txt'),'keep');fs.symlinkSync(outside,path.join(root,'link'),process.platform==='win32'?'junction':'dir');
  assert.equal((await removeInstalledFiles(root,runtime)).ok,true);
  assert.equal(fs.readFileSync(runtime,'utf8'),'retained');assert.equal(fs.readFileSync(path.join(outside,'keep.txt'),'utf8'),'keep');assert.equal(fs.existsSync(long),false);
  assert.deepEqual(fs.readdirSync(root),['CryoClaw.exe','resources']);
  assert.equal(fs.readFileSync(path.join(root,'resources','app.asar'),'utf8'),'app');
});
test('cleanup refuses mismatched runtime ownership and linked roots before deleting files',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cryoclaw-native-remove-guard-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const sentinel=path.join(root,'keep');fs.writeFileSync(sentinel,'keep');
  await assert.rejects(removeInstalledFiles(root,path.join(root,'other.exe')),/ownership/);assert.equal(fs.readFileSync(sentinel,'utf8'),'keep');
});
