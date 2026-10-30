'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const bridge=fs.readFileSync(path.resolve('shared/channel-plugin-inventory.cjs'),'utf8');
const distDir=path.resolve('resources/targets/win32-x64/gateway/node_modules/openclaw/dist');
const nodeBin=path.resolve('resources/targets/win32-x64/runtime/node.exe');
// Hashed kernel filenames change between releases. Once the native resources
// exist, a missing metadata contract must fail these integration tests.
const available=fs.existsSync(nodeBin)&&fs.existsSync(distDir);
async function loadInventory(params){return JSON.parse(execFileSync(nodeBin,['--no-warnings','-e',bridge,'--','cryoclaw-channel-inventory'],{input:JSON.stringify(params),encoding:'utf8',env:params.env,windowsHide:true,stdio:['pipe','pipe','pipe'],timeout:30000}));}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cryoclaw-inventory-'));
 t.after(()=>{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true});});
 const state=path.join(root,'state'),bundled=path.join(root,'bundled'),workspace=path.join(root,'workspace');
 function plugin(dir,id,channels){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'openclaw.plugin.json'),JSON.stringify({id,channels,configSchema:{type:'object',additionalProperties:false,properties:{}}}));fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:id,version:'1.0.0',openclaw:{extensions:['./index.mjs']}}));fs.writeFileSync(path.join(dir,'index.mjs'),'throw new Error("inventory must never execute plugin code")');return dir;}
 const env={...process.env,OPENCLAW_STATE_DIR:state,OPENCLAW_BUNDLED_PLUGINS_DIR:bundled,VITEST:'1',OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR:'1'};
 return {root,state,bundled,workspace,plugin,env};
}
test('native metadata chooses bundled over an unregistered duplicate and discovers workspace channels',{skip:!available},async t=>{
 const f=fixture(t);f.plugin(path.join(f.bundled,'bot'),'fixture-bot',['active']);f.plugin(path.join(f.state,'extensions','stale'),'fixture-bot',['stale']);f.plugin(path.join(f.workspace,'.openclaw','extensions','custom'),'workspace-bot',['custom-one','custom-two']);
 const result=await loadInventory({distDir,config:{agents:{defaults:{workspace:f.workspace}}},env:f.env});
 assert.deepEqual(result.find(p=>p.id==='fixture-bot').channels,['active']);assert.deepEqual(result.find(p=>p.id==='workspace-bot').channels,['custom-one','custom-two']);
});
test('config-selected directory and file override a bundled channel manifest, including an empty channel list',{skip:!available},async t=>{
 const f=fixture(t);f.plugin(path.join(f.bundled,'bot'),'fixture-bot',['bundled-channel']);const custom=f.plugin(path.join(f.root,'selected'),'fixture-bot',['selected-channel']);
 const result=await loadInventory({distDir,config:{plugins:{load:{paths:[custom]}}},env:f.env});assert.deepEqual(result.find(p=>p.id==='fixture-bot').channels,['selected-channel']);
 const provider=f.plugin(path.join(f.root,'provider'),'fixture-bot',[]);
 const replaced=await loadInventory({distDir,config:{plugins:{load:{paths:[path.join(provider,'index.mjs')]}}},env:f.env});assert.deepEqual(replaced.find(p=>p.id==='fixture-bot').channels,[]);
});
function installedIndex(f,records,version=20){
 const {DatabaseSync}=require('node:sqlite');const directory=path.join(f.state,'state');fs.mkdirSync(directory,{recursive:true});const db=new DatabaseSync(path.join(directory,'openclaw.sqlite'));
 try{db.exec(`PRAGMA user_version=${version}; CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY,value_json TEXT NOT NULL)`);db.prepare('INSERT INTO config_machine_state VALUES (?,?)').run('plugins.installedIndex',JSON.stringify({revision:1,index:{installRecords:records}}));}finally{db.close();}
}
test('registered external installs take their canonical precedence without reconstructing SQLite contracts',{skip:!available},async t=>{
 const f=fixture(t);f.plugin(path.join(f.bundled,'bot'),'fixture-bot',['stock']);const external=f.plugin(path.join(f.root,'external'),'fixture-bot',['registered']);
 installedIndex(f,{'fixture-bot':{source:'path',installPath:external,sourcePath:external}});
 const result=await loadInventory({distDir,config:{},env:f.env});assert.deepEqual(result.find(p=>p.id==='fixture-bot').channels,['registered']);
});
test('unreadable newer state and invalid installed records reject demand reconciliation',{skip:!available},async t=>{
 for(const version of [20,21]){
  const f=fixture(t);f.plugin(path.join(f.bundled,'bot'),'fixture-bot',['stock']);installedIndex(f,version===20?{'fixture-bot':{source:'invalid-source'}}:{},version);
  await assert.rejects(loadInventory({distDir,config:{},env:f.env}));
 }
});
test('a malformed unrelated plugin blocks enabling but preserves valid channel metadata for disabling',{skip:!available},async t=>{
 const f=fixture(t);f.plugin(path.join(f.bundled,'bot'),'fixture-bot',['active']);const broken=f.plugin(path.join(f.state,'extensions','broken'),'broken',['broken-channel']);fs.writeFileSync(path.join(broken,'openclaw.plugin.json'),'{');
 await assert.rejects(loadInventory({distDir,config:{},env:f.env}));
 const result=await loadInventory({distDir,config:{},env:f.env,allowErrors:true});assert.deepEqual(result.find(plugin=>plugin.id==='fixture-bot').channels,['active']);
});
