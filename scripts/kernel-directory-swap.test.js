const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {versionOf, swapDirectory, recoverDirectorySwap} = require("./lib/kernel-directory-swap");
test('update consumes its own same-volume staging tree without a second full copy',t=>{
  const {tree}=fixture(t),current=tree('gateway','2026.10.5'),next=tree('candidate','2026.10.6');
  const io={...fs,cpSync(){throw Error('redundant copy');}};
  swapDirectory(next,current,'2026.10.6',io,{moveCandidate:true});
  assert.equal(versionOf(current),'2026.10.6');assert.equal(fs.existsSync(next),false);
});
test('cross-volume staging falls back to copying while retaining the source',t=>{
  const {tree}=fixture(t),current=tree('gateway','2026.10.5'),next=tree('candidate','2026.10.6');let copies=0;
  const io={...fs,cpSync(...a){copies++;return fs.cpSync(...a);},renameSync(a,b){if(a===next){const error=Error('different volume');error.code='EXDEV';throw error;}return fs.renameSync(a,b);}};
  swapDirectory(next,current,'2026.10.6',io,{moveCandidate:true});assert.equal(copies,1);assert.equal(versionOf(next),'2026.10.6');
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-directory-swap-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  function tree(name, version) { const dir=path.join(root,name),pkg=path.join(dir,"node_modules/openclaw"); fs.mkdirSync(pkg,{recursive:true}); fs.writeFileSync(path.join(pkg,"package.json"),JSON.stringify({version})); fs.writeFileSync(path.join(pkg,"openclaw.mjs"),"export {};\n"); return dir; }
  return {root,tree};
}
test("physical gateway swaps a complete tree and removes transaction debris",t=>{
  const {tree}=fixture(t),current=tree("gateway","2026.10.5"),next=tree("candidate","2026.10.6");
  swapDirectory(next,current,"2026.10.6");assert.equal(versionOf(current),"2026.10.6");assert.equal(recoverDirectorySwap(current),"clean");
});
test("failed publication restores previous complete directory",t=>{
  const {tree}=fixture(t),current=tree("gateway","2026.10.5"),next=tree("candidate","2026.10.6");
  const io={...fs,renameSync(a,b){if(a.includes(".new-")&&b===current)throw Error("simulated locked destination");return fs.renameSync(a,b);}};
  assert.throws(()=>swapDirectory(next,current,"2026.10.6",io),/locked/);assert.equal(versionOf(current),"2026.10.5");assert.equal(recoverDirectorySwap(current),"clean");
});
test("transient directory locks retry only the same publication rename",t=>{
  const {tree}=fixture(t),current=tree("gateway","2026.10.5"),next=tree("candidate","2026.10.6");let denied=0,copies=0;
  const io={...fs,cpSync(...args){copies++;return fs.cpSync(...args);},renameSync(a,b){if(a===current&&denied++<2){const error=Error("temporary scanner lock");error.code="EPERM";throw error;}return fs.renameSync(a,b);}};
  swapDirectory(next,current,"2026.10.6",io);assert.equal(versionOf(current),"2026.10.6");assert.equal(copies,1);assert.equal(denied,3);
});
test("crash after old-directory retirement rolls back, preserving unrelated files",t=>{
  const {tree,root}=fixture(t),current=path.join(root,"gateway");tree("gateway.old-123","2026.10.5");tree("gateway.new-123","2026.10.6");const unrelated=tree("gateway.old-124","2026.9.9");
  fs.writeFileSync(current+".swap.json",JSON.stringify({from:"2026.10.5",to:"2026.10.6",ts:123}));assert.equal(recoverDirectorySwap(current),"rollback");assert.equal(versionOf(current),"2026.10.5");assert.equal(versionOf(unrelated),"2026.9.9");
});
test("crash after publication settles new tree; malformed journals retain evidence",t=>{
  const {tree}=fixture(t),current=tree("gateway","2026.10.6");tree("gateway.old-123","2026.10.5");fs.writeFileSync(current+".swap.json",JSON.stringify({from:"2026.10.5",to:"2026.10.6",ts:123}));assert.equal(recoverDirectorySwap(current),"committed");
  fs.writeFileSync(current+".swap.json",JSON.stringify({from:"2026.10.5",to:"2026.10.6",ts:"../outside"}));assert.throws(()=>recoverDirectorySwap(current),/Invalid/);assert.ok(fs.existsSync(current+".swap.json"));assert.equal(versionOf(current),"2026.10.6");
});
test("missing recovery tree or wrong target never publishes staged data",t=>{
  const {tree,root}=fixture(t),current=tree("gateway","2026.10.5"),next=tree("candidate","2026.10.4");assert.throws(()=>swapDirectory(next,current,"2026.10.6"),/mismatch/);assert.equal(versionOf(current),"2026.10.5");
  fs.rmSync(current,{recursive:true});fs.writeFileSync(current+".swap.json",JSON.stringify({from:"2026.10.5",to:"2026.10.6",ts:123}));assert.throws(()=>recoverDirectorySwap(current),/evidence retained/);assert.ok(fs.existsSync(current+".swap.json"));assert.ok(fs.existsSync(path.join(root,"candidate")));
});
