const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Cdp, httpCheckOk } = require("./lib/cdp-harness");

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
