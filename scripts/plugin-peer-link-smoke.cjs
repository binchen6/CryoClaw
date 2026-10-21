"use strict";
// Run with the packaged Electron CLI in Node mode, against its bundled OpenClaw root.
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),assert=require("node:assert/strict");
const {pathToFileURL}=require("node:url");
(async()=>{
  const hostRoot=path.resolve(process.argv[2]);
  assert.match(hostRoot,/\.asar[\\/]node_modules[\\/]openclaw$/i);
  const dist=path.join(hostRoot,"dist");
  const name=fs.readdirSync(dist).find(file=>/^plugin-peer-link-.*\.mjs$/.test(file));assert.ok(name,"Packaged peer-link module missing");
  const source=fs.readFileSync(path.join(dist,name),"utf8");assert.ok(source.includes("cryoclaw-peer-asar-link"),"Packaged patch missing");
  for(const [prefix,marker] of [["install-security-scan.runtime-","cryoclaw-asar-boundary-link"],["plugin-update-config-migration-","cryoclaw-repaired-peer-migration"]]){
    const moduleName=fs.readdirSync(dist).find(file=>file.startsWith(prefix) && file.endsWith(".mjs"));assert.ok(moduleName);assert.ok(fs.readFileSync(path.join(dist,moduleName),"utf8").includes(marker),`Packaged ${marker} patch missing`);
  }
  const peer=await import(pathToFileURL(path.join(dist,name)).href);
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"cryo-peer-smoke-"));
  try{
    const plugin=path.join(scratch,"plugin");fs.mkdirSync(plugin);fs.writeFileSync(path.join(plugin,"package.json"),JSON.stringify({name:"cryoclaw-peer-qa",peerDependencies:{openclaw:"*"}}));
    const result=await peer.a({installedDir:plugin,hostRoot,peerDependencies:{openclaw:"*"},logger:{}});
    assert.equal(result.skipped,0);const link=path.join(plugin,"node_modules/openclaw");assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(peer.i({packageDir:plugin}),null,"New kernel synchronous audit must accept the selected ASAR host");
    fs.unlinkSync(link);fs.symlinkSync(path.join(hostRoot,"..","clawhub"),link,"junction");
    assert.ok(peer.i({packageDir:plugin}),"Audit must reject another host");
    console.log(JSON.stringify({packagedPatch:true,realLinkCreated:true,synchronousAudit:true,wrongHostRejected:true}));
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
