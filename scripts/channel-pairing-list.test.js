'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
function fixture(t,ownerBody){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cryoclaw-pairing-native-'));
 t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const dist=path.join(root,'dist');fs.mkdirSync(dist);
 fs.writeFileSync(path.join(dist,'local-state-owner-test.mjs'),`async function runWithLocalStateOwner(p){${ownerBody}} export {runWithLocalStateOwner as t};`);
 fs.writeFileSync(path.join(dist,'server-capabilities-test.mjs'),'const GATEWAY_SERVER_CAPS={CHANNELS_PAIRING_LIST_OWNER:"channels-pairing-list-owner-v1"}; export {GATEWAY_SERVER_CAPS as t};');
 return root;
}
test('native pairing preserves owner parameters and does not load local store for a routed request',async t=>{
 const root=fixture(t,'if(p.method!=="channels.pairing.list"||p.params.channel!=="feishu"||p.params.format!=="cli"||p.requiredCapabilities[0]!=="channels-pairing-list-owner-v1")throw Error("wrong owner contract"); return [{code:"LIVE",id:"u",meta:{name:"Name"}}];');
 const {listPairingRequests}=require('../shared/channel-pairing-list.cjs');
 assert.deepEqual(await listPairingRequests(root,'feishu'),[{code:'LIVE',id:'u',meta:{name:'Name'}}]);
});
test('offline list uses the owner-provided environment and admission guard',async t=>{
 const root=fixture(t,'return p.runLocal({env:{fixture:"selected"},assertCurrent:()=>{}});');
 fs.writeFileSync(path.join(root,'dist','pairing-store-test.mjs'),'async function listChannelPairingRequests(channel,env,accountId,assertCurrent){if(channel!=="wecom"||env.fixture!=="selected"||accountId!==undefined||typeof assertCurrent!=="function")throw Error("lost authority");assertCurrent();return [];} export {listChannelPairingRequests as a};');
 const {listPairingRequests}=require('../shared/channel-pairing-list.cjs');assert.deepEqual(await listPairingRequests(root,'wecom'),[]);
});
test('contract absence permits CLI fallback but an admitted owner error never does',async t=>{
 const {listPairingRequests,UnsupportedPairingContract}=require('../shared/channel-pairing-list.cjs');
 const root=fixture(t,'throw Error("STATE_OWNER_CHANGED");');
 await assert.rejects(listPairingRequests(root,'wecom'),error=>error.message==='STATE_OWNER_CHANGED'&&!(error instanceof UnsupportedPairingContract));
 fs.unlinkSync(path.join(root,'dist','local-state-owner-test.mjs'));
 await assert.rejects(listPairingRequests(root,'wecom'),UnsupportedPairingContract);
});
test('a local-store contract failure after owner admission cannot request CLI fallback',async t=>{
 const root=fixture(t,'return p.runLocal({env:{},assertCurrent:()=>{}});');
 const {listPairingRequests,UnsupportedPairingContract}=require('../shared/channel-pairing-list.cjs');
 await assert.rejects(listPairingRequests(root,'wecom'),error=>!(error instanceof UnsupportedPairingContract));
});
function settingsFixture(t,replies){
 const root=fixture(t,'return [];'),calls=[],{EventEmitter}=require('node:events');
 const source=fs.readFileSync(path.resolve('src/settings/pairing.ts'),'utf8')+'\nexport {listChannelPairingRequests};';
 const code=require('typescript').transpileModule(source,{compilerOptions:{module:1,target:9,esModuleInterop:true}}).outputText;
 const exported={exports:{}};
 require('node:vm').runInNewContext(code,{module:exported,exports:exported.exports,__dirname:path.resolve('src/settings'),process,Buffer,setTimeout,clearTimeout,require(name){
  if(name==='electron')return {ipcMain:{}};
  if(name==='child_process')return {spawn(node,args,options){
   calls.push({node,args,options});const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
   queueMicrotask(()=>{const reply=replies.shift();assert.ok(reply,'Unexpected fallback');child.stdout.emit('data',Buffer.from(reply.stdout??''));child.stderr.emit('data',Buffer.from(reply.stderr??''));child.emit('close',reply.code);});return child;
  }};
  if(name==='../constants')return {resolveUserStateDir:()=>root,resolveNodeBin:()=>'/fixture/node',resolveGatewayEntry:()=>'/fixture/openclaw/openclaw.mjs',resolveGatewayCwd:()=>root,resolveResourcesPath:()=>root,resolveNodeExtraEnv:()=>({})};
  if(name==='../wecom-config')return {WECOM_CHANNEL_ID:'wecom'};
  if(name==='../feishu-config')return {FEISHU_CHANNEL_ID:'feishu'};
  if(name.startsWith('../'))return {};
  return require(name);
 }});
 return {root,calls,list:channel=>exported.exports.listChannelPairingRequests(channel,'list failed','invalid JSON')};
}
test('settings native list preserves names, rejection filtering and stale-code pruning',async t=>{
 const f=settingsFixture(t,[{code:0,stdout:JSON.stringify({requests:[{code:'REJECTED',id:'u1'},{code:'ACTIVE',id:'u2',meta:{name:'Alice'},createdAt:'today'}]})}]);
 fs.mkdirSync(path.join(f.root,'credentials'));
 const rejected=path.join(f.root,'credentials','feishu-rejected-pairing-codes.json');fs.writeFileSync(rejected,JSON.stringify({version:1,codes:['REJECTED','EXPIRED']}));
 const result=await f.list('feishu');assert.equal(result.success,true);assert.equal(result.requests.length,1);assert.equal(result.requests[0].name,'Alice');assert.equal(result.requests[0].code,'ACTIVE');
 assert.deepEqual(JSON.parse(fs.readFileSync(rejected)).codes,['REJECTED']);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].args[1],'-e');assert.deepEqual(Array.from(f.calls[0].args.slice(-3)),['cryoclaw-channel-pairing-list','/fixture/openclaw','feishu']);assert.equal(f.calls[0].options.env.OPENCLAW_STATE_DIR,f.root);
});
test('settings falls back only before admission and never masks a state-owner failure',async t=>{
 const fallback=settingsFixture(t,[{code:78},{code:0,stdout:'{"requests":[]}'}]);assert.equal((await fallback.list('wecom')).success,true);assert.equal(fallback.calls.length,2);assert.deepEqual(Array.from(fallback.calls[1].args),['/fixture/openclaw/openclaw.mjs','pairing','list','wecom','--json']);
 const refused=settingsFixture(t,[{code:1,stderr:'STATE_OWNER_CHANGED'}]);const result=await refused.list('wecom');assert.equal(result.success,false);assert.equal(result.message,'STATE_OWNER_CHANGED');assert.equal(refused.calls.length,1);
});
test('command wrapper reserves exit 78 for preflight contract absence',t=>{
 const {spawnSync}=require('node:child_process'),bridge=fs.readFileSync(path.resolve('shared/channel-pairing-list.cjs'),'utf8');
 const root=fixture(t,'throw Error("STATE_OWNER_CHANGED");');
 const run=()=>spawnSync(process.execPath,['-e',bridge,'--','cryoclaw-channel-pairing-list',root,'wecom'],{encoding:'utf8',windowsHide:true});
 const admitted=run();assert.equal(admitted.status,1);assert.match(admitted.stderr,/STATE_OWNER_CHANGED/);
 fs.unlinkSync(path.join(root,'dist','local-state-owner-test.mjs'));assert.equal(run().status,78);
});
const nativeNode=path.resolve('resources/targets/win32-x64/runtime/node.exe'),nativeCore=path.resolve('resources/targets/win32-x64/gateway/node_modules/openclaw');
test('real kernel refuses a newer database without returning empty success or altering it',{skip:!fs.existsSync(nativeNode)||!fs.existsSync(nativeCore)},t=>{
 const root=fixture(t,'return [];');fs.mkdirSync(path.join(root,'state'));
 const database=path.join(root,'state','openclaw.sqlite'),{DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(database);
 db.exec('PRAGMA user_version=999; CREATE TABLE preservation_probe(value TEXT); INSERT INTO preservation_probe VALUES (\'keep\')');db.close();
 const before=fs.readFileSync(database);fs.writeFileSync(path.join(root,'openclaw.json'),JSON.stringify({gateway:{port:19849},plugins:{enabled:false}}));
 const result=require('node:child_process').spawnSync(nativeNode,['--no-warnings','-e',fs.readFileSync(path.resolve('shared/channel-pairing-list.cjs'),'utf8'),'--','cryoclaw-channel-pairing-list',nativeCore,'wecom'],{env:{...process.env,OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:path.join(root,'openclaw.json'),OPENCLAW_NO_RESPAWN:'1'},encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/newer|schema|version/i);assert.equal(result.stdout.trim(),'');assert.deepEqual(fs.readFileSync(database),before);
});
