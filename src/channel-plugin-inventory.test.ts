import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {channelPluginInventoryEnv,parseChannelPluginInventory} from './channel-plugin-inventory';
test('selected kernel manifests retain all channel IDs without treating providers as channels',()=>{
 const result=parseChannelPluginInventory([{id:'custom',channels:['one','two','one']},{id:'provider',channels:[]}]);
 assert.deepEqual(result.channels.get('custom'),['one','two']);assert.equal(result.channels.has('provider'),false);assert.ok(result.installed.has('provider'));
});
test('invalid or duplicate metadata cannot drive a configuration write',()=>{
 for(const value of [null,{},[{id:'bot',channels:'one'}],[{id:'bot',channels:[1]}],[{id:'__proto__',channels:[]}],[{id:'bot',channels:['one']},{id:'bot',channels:['two']}]])assert.throws(()=>parseChannelPluginInventory(value));
});

test('inventory uses the same version/build compile cache as its gateway without changing parent environment',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'inventory-cache-'));
 t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const packageDir=path.join(root,'kernel'),stateDir=path.join(root,'state');
 fs.mkdirSync(path.join(packageDir,'dist'),{recursive:true});
 fs.writeFileSync(path.join(packageDir,'package.json'),JSON.stringify({version:'2026.10.9'}));
 fs.writeFileSync(path.join(packageDir,'dist','build-info.json'),JSON.stringify({buildId:'inventory-test-build'}));
 const parent={NODE_COMPILE_CACHE:'other-kernel',NODE_DISABLE_COMPILE_CACHE:'1',OPENCLAW_STATE_DIR:'other-state',KEEP:'yes'};
 const extra={ELECTRON_RUN_AS_NODE:'',KEEP:'extra'};
 const actual=channelPluginInventoryEnv(packageDir,stateDir,extra,parent);
 const marker=createHash('sha256').update('inventory-test-build').digest('hex').slice(0,16);
 assert.equal(actual.NODE_COMPILE_CACHE,path.join(stateDir,'cache','v8-compile','openclaw','2026.10.9',marker));
 assert.equal(actual.NODE_DISABLE_COMPILE_CACHE,'1');
 assert.equal(actual.OPENCLAW_STATE_DIR,stateDir);
 assert.equal(actual.ELECTRON_RUN_AS_NODE,'');
 assert.equal(actual.KEEP,'extra');
 assert.equal(parent.NODE_COMPILE_CACHE,'other-kernel');
 assert.equal(parent.OPENCLAW_STATE_DIR,'other-state');
 assert.deepEqual(extra,{ELECTRON_RUN_AS_NODE:'',KEEP:'extra'});
});
