import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseChannelPluginInventory} from './channel-plugin-inventory';
test('selected kernel manifests retain all channel IDs without treating providers as channels',()=>{
 const result=parseChannelPluginInventory([{id:'custom',channels:['one','two','one']},{id:'provider',channels:[]}]);
 assert.deepEqual(result.channels.get('custom'),['one','two']);assert.equal(result.channels.has('provider'),false);assert.ok(result.installed.has('provider'));
});
test('invalid or duplicate metadata cannot drive a configuration write',()=>{
 for(const value of [null,{},[{id:'bot',channels:'one'}],[{id:'bot',channels:[1]}],[{id:'__proto__',channels:[]}],[{id:'bot',channels:['one']},{id:'bot',channels:['two']}]])assert.throws(()=>parseChannelPluginInventory(value));
});
