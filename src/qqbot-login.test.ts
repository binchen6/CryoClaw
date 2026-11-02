import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// A real connector is substituted only at its network boundary.
const implementation = () => require("./qqbot-login") as any;
class Owner extends EventEmitter { id = 1; destroyed = false; isDestroyed() { return this.destroyed; } }
function fixture(options: any = {}) {
  let callbacks: any, stopCount = 0, writes = 0, restarts = 0;
  let config: any = { channels: { qqbot: { enabled: false, dmPolicy: "disabled", accounts: { team: { appId: "111", clientSecret: "old", custom: true } } } }, other: 1 };
  const owner = new Owner();
  const service = implementation().createQqbotLoginService({
    startQrConnect: (cb: any, opts: any) => { callbacks = cb; assert.equal(opts.displayQrCodeToConsole, false); options.onStart?.(cb); return () => { stopCount++; }; },
    renderQr: async (url: string) => `data:image/svg+xml;base64,${Buffer.from(url).toString("base64")}`,
    readConfig: () => structuredClone(config), writeConfig: (next: any) => { config = next; writes++; }, restart: () => { restarts++; },
    startupTimeoutMs: 30, deadlineMs: 200, ...options,
  });
  return { service, owner, get callbacks() { return callbacks; }, get config() { return config; }, set config(v: any) { config = v; }, counts: () => ({ stopCount, writes, restarts }) };
}
async function start(f: ReturnType<typeof fixture>) { const promise = f.service.start(f.owner); f.callbacks.onQrDisplayed("https://q.qq.com/qqbot/openclaw/connect.html?task_id=one"); return promise; }
test("QQ service refreshes local QR and persists all credentials once against latest config without exposing secrets", async () => {
  const f = fixture(), initial = await start(f); assert.equal(initial.success, true); const id = initial.data.attemptId;
  f.config = { ...f.config, concurrent: "keep" };
  f.callbacks.onQrDisplayed("https://q.qq.com/qqbot/openclaw/connect.html?task_id=two"); await new Promise(setImmediate);
  assert.notEqual(f.service.wait(f.owner, id).data.qrDataUrl, initial.data.qrDataUrl);
  f.callbacks.onSuccess([{ appId: "111", appSecret: "new-secret", userOpenid: "scanner" }, { appId: "222", appSecret: "another-secret", userOpenid: "scanner" }]);
  f.callbacks.onSuccess([{ appId: "333", appSecret: "late-secret" }]); await new Promise(setImmediate);
  const result = f.service.wait(f.owner, id); assert.equal(result.data.status, "connected");
  assert.equal(f.config.concurrent, "keep"); assert.equal(f.config.channels.qqbot.enabled, false);
  assert.equal(f.config.channels.qqbot.accounts.team.clientSecret, "new-secret"); assert.equal(f.config.channels.qqbot.accounts.team.custom, true);
  assert.equal(f.config.channels.qqbot.accounts["222"].dmPolicy, "allowlist"); assert.deepEqual(f.config.channels.qqbot.accounts["222"].allowFrom, ["scanner"]);
  assert.equal(JSON.stringify(result).includes("secret"), false); assert.equal(JSON.stringify(result).includes("scanner"), false);
  assert.deepEqual(f.counts(), { stopCount: 1, writes: 1, restarts: 1 });
});
test("QQ attempts belong to one owner; cancel ignores late callbacks and stops connector", async () => {
  const f = fixture(), initial = await start(f), id = initial.data.attemptId, other = new Owner(); other.id = 2;
  assert.equal(f.service.cancel(other, id).success, false); assert.equal(f.service.wait(other, id).success, false);
  assert.equal(f.service.cancel(f.owner, id).success, true); f.callbacks.onSuccess([{ appId: "1", appSecret: "late" }]);
  assert.equal(f.service.wait(f.owner, id).data.status, "canceled"); assert.deepEqual(f.counts(), { stopCount: 1, writes: 0, restarts: 0 });
});
test("QQ synchronous QR/success callbacks persist once and dispose after connector returns", async () => {
  const f = fixture({ onStart(cb: any) { cb.onQrDisplayed("https://q.qq.com/qqbot/openclaw/connect.html?task_id=sync"); cb.onSuccess([{ appId: "5", appSecret: "sync" }]); } });
  const initial = await f.service.start(f.owner); assert.equal(initial.success, true); assert.equal(f.service.wait(f.owner, initial.data.attemptId).data.status, "connected");
  assert.deepEqual(f.counts(), { stopCount: 1, writes: 1, restarts: 1 });
});
test("QQ owner destruction, deadline and bounded startup prevent late writes", async () => {
  const f = fixture(), initial = await start(f); f.owner.destroyed = true; f.owner.emit("destroyed"); f.callbacks.onSuccess([{ appId: "6", appSecret: "late" }]); assert.equal(f.counts().writes, 0);
  const deadline = fixture({ deadlineMs: 15 }); const begun = await start(deadline); await new Promise(r => setTimeout(r, 25)); assert.equal(deadline.service.wait(deadline.owner, begun.data.attemptId).data.status, "expired");
  const noQr = fixture({ startupTimeoutMs: 10 }); const failed = await noQr.service.start(noQr.owner); assert.equal(failed.success, false); assert.equal(noQr.counts().stopCount, 1);
});
test("QQ failure messages never echo credentials and QR expiry accepts connector refresh", async () => {
  const f = fixture(), begun = await start(f); f.callbacks.onQrExpired(); f.callbacks.onQrDisplayed("https://q.qq.com/qqbot/openclaw/connect.html?task_id=refresh"); await new Promise(setImmediate);
  assert.equal(f.service.wait(f.owner, begun.data.attemptId).data.status, "waiting");
  f.callbacks.onFailure(new Error("appSecret=do-not-echo")); const result = f.service.wait(f.owner, begun.data.attemptId); assert.equal(result.data.status, "error"); assert.equal(JSON.stringify(result).includes("do-not-echo"), false);
});

test("QQ managed accounts preserve disabled/access settings and select documentation-only upgrades", () => {
  const config: any = { plugins: { entries: { qqbot: { enabled: false } }, deny: ["qqbot"], installs: { qqbot: { custom: true } } }, channels: { qqbot: { enabled: false, appId: "10", clientSecret: "old", upgradeMode: "hot-reload", streaming: { mode: "partial" }, dmPolicy: "disabled", allowFrom: ["keep"], accounts: { other: { appId: "20", enabled: false, upgradeMode: "hot-reload", custom: 1 } } } } };
  implementation().mergeQqbotCredentials(config, [{ appId: "10", appSecret: "updated" }, { appId: "30", appSecret: "new", userOpenid: "scanner" }]);
  assert.equal(config.channels.qqbot.enabled, false); assert.equal(config.channels.qqbot.dmPolicy, "disabled"); assert.deepEqual(config.channels.qqbot.allowFrom, ["keep"]);
  assert.equal(config.plugins.entries["openclaw-qqbot"].enabled, false); assert.deepEqual(config.plugins.deny, ["openclaw-qqbot"]);
  assert.equal(config.plugins.installs.qqbot, undefined); assert.equal(config.plugins.installs["openclaw-qqbot"].custom, true);
  assert.deepEqual(config.channels.qqbot.streaming, { mode: "partial" });
  assert.equal(config.channels.qqbot.upgradeMode, "doc"); assert.equal(config.channels.qqbot.accounts.other.upgradeMode, "doc");
  assert.equal(config.channels.qqbot.accounts.other.enabled, false); assert.equal(config.channels.qqbot.accounts.other.custom, 1);
  assert.equal(config.channels.qqbot.accounts["30"].upgradeMode, "doc"); assert.deepEqual(config.channels.qqbot.accounts["30"].streaming, { mode: "off" });
});
test("QQ completion does not admit an older QR image generation", async () => {
  const renders: Array<(image: string) => void> = [];
  const f = fixture({ renderQr: () => new Promise(resolve => renders.push(resolve)) });
  const pending = f.service.start(f.owner);
  f.callbacks.onQrDisplayed("one"); f.callbacks.onQrDisplayed("two"); renders[1]("data:image/svg+xml;base64,new");
  const initial = await pending; f.callbacks.onSuccess([{ appId: "5", appSecret: "secret" }]); renders[0]("data:image/svg+xml;base64,old"); await new Promise(setImmediate);
  assert.equal(f.service.wait(f.owner, initial.data.attemptId).data.qrDataUrl, "data:image/svg+xml;base64,new");
});
test("QQ synchronous success waits for pending local QR generation", async () => {
  const f = fixture({ renderQr: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return "data:image/svg+xml;base64,delayed"; }, onStart(cb: any) { cb.onQrDisplayed("local"); cb.onSuccess([{ appId: "5", appSecret: "secret" }]); } });
  const initial = await f.service.start(f.owner); assert.equal(initial.success, true); assert.equal(f.service.wait(f.owner, initial.data.attemptId).data.status, "connected");
});

test("QQ new login cannot overwrite an unrelated account whose key equals the new app ID", () => {
  const config: any = { channels: { qqbot: { accounts: { "30": { appId: "20", clientSecret: "keep", enabled: false, custom: 1 } } } } };
  const summaries = implementation().mergeQqbotCredentials(config, [{ appId: "30", appSecret: "new", userOpenid: "scanner" }]);
  assert.equal(config.channels.qqbot.accounts["30"].appId, "20"); assert.equal(config.channels.qqbot.accounts["30"].clientSecret, "keep");
  assert.notEqual(summaries[0].accountId, "30"); assert.equal(config.channels.qqbot.accounts[summaries[0].accountId].appId, "30");
});
