import test from 'node:test';
import assert from 'node:assert/strict';
import {ResourceCache} from './resource-cache.ts';
test('resource cache coalesces requests, honors TTL and preserves empty snapshots',async()=>{
  let clock=0,calls=0;const cache=new ResourceCache<string[]>(100,3,()=>clock);
  const load=async()=>{calls++;return [];};const first=cache.read('a',load);assert.equal(first,cache.read('a',load));await first;
  await cache.read('a',load);assert.equal(calls,1);clock=101;await cache.read('a',load);assert.equal(calls,2);
});
test('resource cache starts the first load synchronously without losing coalescing',async()=>{
  let started=0;const cache=new ResourceCache<number>(1000);
  const pending=cache.read('a',async()=>{started++;return 1;});
  assert.equal(started,1);assert.equal(pending,cache.read('a',async()=>{started++;return 2;}));assert.equal(await pending,1);
});
test('failed loads retry and old in-flight values cannot overwrite forced refreshes',async()=>{
  const cache=new ResourceCache<string>(1000);await assert.rejects(cache.read('a',async()=>{throw Error('offline');}));
  let finish!:(value:string)=>void;const old=cache.read('a',()=>new Promise(resolve=>finish=resolve));await Promise.resolve();
  await cache.read('a',async()=>'new',true);finish('old');await old;assert.equal(cache.peek('a'),'new');
  cache.clear('a');assert.equal(cache.peek('a'),undefined);assert.equal(await cache.read('a',async()=>'retry'),'retry');
});
test('clear revokes in-flight cache writes and entry count remains bounded',async()=>{
  const cache=new ResourceCache<number>(1000,2);let finish!:(value:number)=>void;
  const pending=cache.read('a',()=>new Promise(resolve=>finish=resolve));await Promise.resolve();cache.clear();finish(1);await pending;assert.equal(cache.peek('a'),undefined);
  await cache.read('b',async()=>2);await cache.read('c',async()=>3);await cache.read('d',async()=>4);assert.equal(cache.peek('b'),undefined);
});
