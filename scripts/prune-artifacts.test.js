const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {planPrune,applyPlan,validateTarget}=require('./prune-artifacts');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'prune-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));for(const n of ['.cache','out'])fs.mkdirSync(path.join(root,n));return root;}
function write(root,rel){const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'cache');}
test('prune keeps current and previous releases, user state, backups, dependency caches and unknown content',t=>{
  const root=fixture(t);for(const rel of ['.cache/kernel-recon/a','.cache/node/cache','.cache/db-backup/a','.cache/user-state/a','.cache/unknown/a','out/next-test/a'])write(root,rel);
  for(const v of ['2026.1018.2','2026.1018.3','2026.1018.4'])write(root,`out/win32-x64/CryoClaw-Setup-${v}-x64.exe`);
  const plan=planPrune(root,{version:'2026.1018.4',before:Date.now()+1000});const report=applyPlan(root,plan);
  assert.equal(report.failed.length,0);assert.ok(report.bytes>0);
  for(const rel of ['.cache/node/cache','.cache/db-backup/a','.cache/user-state/a','.cache/unknown/a','out/win32-x64/CryoClaw-Setup-2026.1018.3-x64.exe','out/win32-x64/CryoClaw-Setup-2026.1018.4-x64.exe'])assert.ok(fs.existsSync(path.join(root,rel)),rel);
  assert.ok(!fs.existsSync(path.join(root,'.cache/kernel-recon')));assert.ok(!fs.existsSync(path.join(root,'out/next-test')));assert.ok(!fs.existsSync(path.join(root,'out/win32-x64/CryoClaw-Setup-2026.1018.2-x64.exe')));
});
test('prune rejects workspace roots, traversal and redirected cleanup roots',t=>{
  const root=fixture(t);for(const rel of ['.cache','out','../outside','.git'])assert.throws(()=>validateTarget(root,rel));
  const outside=fixture(t);fs.rmdirSync(path.join(root,'.cache'));fs.symlinkSync(path.join(outside,'.cache'),path.join(root,'.cache'),'junction');write(outside,'.cache/kernel-recon/keep');
  assert.throws(()=>planPrune(root,{version:'1.0.0',before:Infinity}),/root|redirect/);assert.ok(fs.existsSync(path.join(outside,'.cache/kernel-recon/keep')));
});
test('prune unlinks nested directory junctions without following them',t=>{
  const root=fixture(t),outside=fixture(t);write(root,'.cache/kernel-recon/a');write(outside,'.cache/keep');
  fs.symlinkSync(path.join(outside,'.cache'),path.join(root,'.cache/kernel-recon/link'),'junction');
  assert.equal(applyPlan(root,[{relative:'.cache/kernel-recon'}]).failed.length,0);assert.ok(fs.existsSync(path.join(outside,'.cache/keep')));
});
test('prune ignores content newer than the requested cutoff',t=>{
  const root=fixture(t);write(root,'out/next-test/a');assert.deepEqual(planPrune(root,{version:'1.0.0',before:0}),[]);
});
test('prune retries a denied scratch directory after restoring ordinary access',t=>{
  const root=fixture(t);write(root,'.cache/kernel-recon/nested/a');const original=fs.readdirSync;let denied=false;
  fs.readdirSync=function(target,...args){if(!denied&&String(target).endsWith('kernel-recon')){denied=true;const error=new Error('denied');error.code='EACCES';throw error;}return original.call(this,target,...args);};
  try{const report=applyPlan(root,[{relative:'.cache/kernel-recon'}]);assert.equal(report.failed.length,0);assert.equal(denied,true);assert.ok(!fs.existsSync(path.join(root,'.cache/kernel-recon')));}finally{fs.readdirSync=original;}
});
