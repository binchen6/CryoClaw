const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {stageElectronRuntime}=require('./lib/stage-electron-runtime');
test('runtime staging copies bytes to a private directory and cleans only its own tree',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-fixture-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),target=path.join(root,'target');fs.mkdirSync(path.join(source,'resources'),{recursive:true});fs.mkdirSync(target);
  fs.writeFileSync(path.join(source,'electron.exe'),'fixture runtime');fs.writeFileSync(path.join(source,'resources','default_app.asar'),'fixture app');fs.writeFileSync(path.join(target,'keep'),'untouched');
  const staged=await stageElectronRuntime(path.join(source,'electron.exe'),target);
  assert.equal(fs.readFileSync(staged.exe,'utf8'),'fixture runtime');assert.equal(fs.readFileSync(path.join(path.dirname(staged.exe),'resources/default_app.asar'),'utf8'),'fixture app');
  await staged.cleanup();assert.equal(fs.existsSync(staged.exe),false);assert.equal(fs.readFileSync(path.join(target,'keep'),'utf8'),'untouched');
});
