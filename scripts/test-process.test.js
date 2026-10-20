const test=require('node:test');
const assert=require('node:assert/strict');
const {probeProcess}=require('./lib/test-process');

test('ready process is stopped without waiting for its keepalive timer',async()=>{
  const start=Date.now();
  const result=await probeProcess(process.execPath,['-e','console.log("READY");setInterval(()=>{},1000)'],{isReady:({stdout})=>stdout.includes('READY'),timeoutMs:5000});
  assert.equal(result.kind,'ready');assert.ok(Date.now()-start<4500);
});
test('exits, spawn failures and deadlines return diagnostic outcomes',async()=>{
  const exit=await probeProcess(process.execPath,['-e','console.error("broken");process.exit(7)']);
  assert.equal(exit.kind,'exit:7');assert.match(exit.stderr,/broken/);
  const timeout=await probeProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:50});assert.equal(timeout.kind,'timeout');
  assert.equal((await probeProcess('missing-test-executable',[])).kind,'spawn-error');
});
test('probe output is bounded without discarding the final ready marker',async()=>{
  const result=await probeProcess(process.execPath,['-e','console.log("x".repeat(10000));console.log("READY");setInterval(()=>{},1000)'],{maxOutput:100,isReady:({stdout})=>stdout.includes('READY')});
  assert.equal(result.kind,'ready');assert.ok(result.stdout.length<=100);
});
