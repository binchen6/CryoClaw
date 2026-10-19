const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {stageInstaller}=require('./lib/stage-installer');
test('installer staging creates an independent identical copy and cleans only its own files',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'stage-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'Setup.exe');fs.writeFileSync(source,Buffer.alloc(70_000,12));
  const stage=await stageInstaller(source,root);assert.notEqual(stage.target,source);assert.deepEqual(fs.readFileSync(stage.target),fs.readFileSync(source));
  await stage.cleanup();assert.equal(fs.existsSync(stage.target),false);assert.equal(fs.existsSync(source),true);
});
test('failed staging removes its temporary directory',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'stage-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  await assert.rejects(stageInstaller(path.join(root,'missing.exe'),root));assert.deepEqual(fs.readdirSync(root),[]);
});
