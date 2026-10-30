const test=require('node:test'),assert=require('node:assert/strict');
const {parseRange,createStaticUpdateServer}=require('./update-download-benchmark');
test('Range parser handles bounded and suffix reads',()=>{
 assert.deepEqual(parseRange('bytes=2-5',10),{start:2,end:5});assert.deepEqual(parseRange('bytes=7-',10),{start:7,end:9});assert.deepEqual(parseRange('bytes=-3',10),{start:7,end:9});
 assert.throws(()=>parseRange('bytes=20-30',10),/Unsatisfiable/);assert.throws(()=>parseRange('items=1-2',10),/Unsupported/);
});
test('local update server records real partial responses and blockmap failures',async t=>{
 const remote=await createStaticUpdateServer({manifest:Buffer.from('version: 2'),assets:new Map([['new.exe',Buffer.from('0123456789')],['new.exe.blockmap',Buffer.from('valid')]]),corruptBlockmap:true});t.after(()=>remote.close());
 const partial=await fetch(remote.origin+'/new.exe',{headers:{Range:'bytes=2-5'}});assert.equal(partial.status,206);assert.equal(await partial.text(),'2345');assert.equal(partial.headers.get('content-range'),'bytes 2-5/10');
 const blockmap=await fetch(remote.origin+'/new.exe.blockmap');assert.equal(await blockmap.text(),'corrupted-blockmap');
 const missing=await fetch(remote.origin+'/missing');assert.equal(missing.status,404);
 assert.equal(remote.requests[0].bytes,4);assert.equal(remote.requests[0].range,'bytes=2-5');
});
