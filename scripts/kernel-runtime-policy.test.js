const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {syncNativeKernelVersion}=require('../shared/kernel-runtime-policy.cjs');
function fixture(t,version='2026.10.7'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cryoclaw-runtime-policy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const core=path.join(root,'gateway','node_modules','openclaw'),runtime=path.join(root,'runtime');fs.mkdirSync(core,{recursive:true});fs.mkdirSync(runtime,{recursive:true});
 fs.writeFileSync(path.join(core,'package.json'),JSON.stringify({version}));fs.writeFileSync(path.join(core,'openclaw.mjs'),'export {};');fs.writeFileSync(path.join(runtime,'node.exe'),'fixture');
 const marker=path.join(runtime,'cryoclaw-runtime.json'),policy={kind:'node',gatewayMode:'loose',nodeVersion:'24.22.1',kernelVersion:'2026.10.6'};fs.writeFileSync(marker,JSON.stringify(policy));
 return {root,core,marker,policy};
}
test('runtime policy follows the selected complete gateway and is byte-for-byte idempotent',t=>{
 const f=fixture(t);assert.equal(syncNativeKernelVersion(f.root),true);const policy=JSON.parse(fs.readFileSync(f.marker,'utf8'));assert.deepEqual(policy,{...f.policy,kernelVersion:'2026.10.7'});assert.ok(fs.statSync(path.join(f.root,'runtime','node.exe')).isFile());
 const once=fs.readFileSync(f.marker,'utf8');assert.equal(syncNativeKernelVersion(f.root),false);assert.equal(fs.readFileSync(f.marker,'utf8'),once);
 fs.writeFileSync(path.join(f.core,'package.json'),JSON.stringify({version:'2026.10.6'}));assert.equal(syncNativeKernelVersion(f.root),true);assert.equal(JSON.parse(fs.readFileSync(f.marker,'utf8')).kernelVersion,'2026.10.6');
});
test('legacy runtime is untouched and incomplete gateways cannot rewrite policy',t=>{
 const f=fixture(t);fs.rmSync(f.marker);assert.equal(syncNativeKernelVersion(f.root),false);fs.writeFileSync(f.marker,JSON.stringify(f.policy));const before=fs.readFileSync(f.marker,'utf8');
 fs.rmSync(path.join(f.core,'openclaw.mjs'));assert.throws(()=>syncNativeKernelVersion(f.root),/Incomplete physical gateway/);assert.equal(fs.readFileSync(f.marker,'utf8'),before);
});
