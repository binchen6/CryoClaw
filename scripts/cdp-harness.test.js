const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Cdp, httpCheckOk, navigateChecked, waitForLocale } = require("./lib/cdp-harness");

test("gateway health checks stop waiting when a server never responds", async t => {
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal(await httpCheckOk(`http://127.0.0.1:${server.address().port}`, 30), false);
});

test("CDP disconnect rejects pending and future commands", async () => {
  const ws = new EventTarget(); ws.send = () => {};
  const cdp = new Cdp(ws);
  const pending = assert.rejects(cdp.send("Runtime.evaluate"), /connection closed/);
  ws.dispatchEvent(new Event("close"));
  await pending;
  assert.equal(cdp.pending.size, 0);
  await assert.rejects(cdp.send("Page.enable"), /connection closed/);
});

test("CDP stalled commands and synchronous send failures release pending slots", async () => {
  const ws = new EventTarget(); ws.send = () => {};
  const cdp = new Cdp(ws, 20);
  await assert.rejects(cdp.send("Runtime.evaluate"), /timed out/);
  assert.equal(cdp.pending.size, 0);
  ws.send = () => { throw new Error("socket unavailable"); };
  await assert.rejects(cdp.send("Page.enable"), /socket unavailable/);
  assert.equal(cdp.pending.size, 0);
});

test("failed file navigation rejects even when the previous page is still interactive",async()=>{
  const ws=new EventTarget();let result={errorText:'net::ERR_FILE_NOT_FOUND'};
  ws.send=data=>{const {id}=JSON.parse(data);queueMicrotask(()=>ws.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id,result})})));};
  const cdp=new Cdp(ws);
  await assert.rejects(navigateChecked(cdp,'file:///missing/chat'),/ERR_FILE_NOT_FOUND/);
  result={frameId:'frame'};assert.deepEqual(await navigateChecked(cdp,'file:///app/index.html'),{frameId:'frame'});
});

test("locale checks wait for the reloaded document instead of accepting the old ready page",async()=>{
  let checks=0;await waitForLocale({evaluate:async()=>++checks>=2},'en',500);assert.equal(checks,2);
  await assert.rejects(waitForLocale({evaluate:async()=>false},'en',5),/Locale did not become en/);
});
