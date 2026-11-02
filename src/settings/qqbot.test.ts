import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import Module from "node:module";

test("QQ IPC rejects untrusted callers and binds each attempt to sender identity", async () => {
  const handlers = new Map<string, Function>(); let trusted = true, cb: any, written: any, restarts = 0;
  const owner = Object.assign(new EventEmitter(), { id: 10, isDestroyed: () => false });
  const second = Object.assign(new EventEmitter(), { id: 11, isDestroyed: () => false });
  const original = (Module as any)._load;
  (Module as any)._load = function(name: string, ...args: any[]) {
    if (name === "electron") return { ipcMain: { handle: (key: string, fn: Function) => handlers.set(key, fn) } };
    if (name === "../ipc-sender-guard") return { assertTrustedIpcSender: () => trusted };
    if (name === "../qqbot-config") return { resolveQqbotPluginDir: () => "unused" };
    if (name === "../provider-config") return { readUserConfigForWrite: () => ({ config: { keep: 1 }, baseSnapshot: { keep: 1 } }), writeUserConfig: (config: any) => { written = config; } };
    if (name === "../qqbot-login") return { ...original.call(this, name, ...args), loadOfficialQqbotBoundary: () => ({ startQrConnect: (callbacks: any) => { cb = callbacks; callbacks.onQrDisplayed("local"); return () => {}; }, renderQr: async () => "data:image/svg+xml;base64,local" }) };
    return original.call(this, name, ...args);
  };
  try { require("./qqbot").registerQqbotIpc({ requestGatewayRestart: () => restarts++ }); } finally { (Module as any)._load = original; }
  assert.equal(handlers.size, 3);
  trusted = false; await assert.rejects(Promise.resolve().then(() => handlers.get("settings:qqbot-login-start")!({ sender: owner })), /trusted/);
  trusted = true; const initial = await handlers.get("settings:qqbot-login-start")!({ sender: owner });
  const id = initial.data.attemptId;
  assert.equal((await handlers.get("settings:qqbot-login-wait")!({ sender: second }, { attemptId: id })).success, false);
  assert.equal((await handlers.get("settings:qqbot-login-cancel")!({ sender: second }, { attemptId: id })).success, false);
  cb.onSuccess([{ appId: "555", appSecret: "private" }]);
  assert.equal(written.channels.qqbot.accounts["555"].clientSecret, "private"); assert.equal(restarts, 1);
  const result = await handlers.get("settings:qqbot-login-wait")!({ sender: owner }, { attemptId: id });
  assert.equal(result.data.status, "connected"); assert.equal(JSON.stringify(result).includes("private"), false);
});
