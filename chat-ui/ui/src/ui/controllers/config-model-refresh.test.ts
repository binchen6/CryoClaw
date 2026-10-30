import test from "node:test";
import assert from "node:assert/strict";
import { getCachedConfigSnapshot, getConfigSnapshot, patchConfig } from "./config.ts";
import type { GatewayBrowserClient } from "../gateway.ts";

test("the confirmed config.patch snapshot updates model defaults without an extra config.get", async () => {
  let gets = 0;
  const client = { request: async (method: string) => {
    if (method === "config.get") { gets++; return { hash: "old", config: { model: "old" } }; }
    return { ok: true, hash: "new", config: { model: "new", normalized: true } };
  } } as unknown as GatewayBrowserClient;
  await getConfigSnapshot(client);
  assert.equal((await patchConfig(client, draft => { draft.model = "new"; })).ok, true);
  assert.deepEqual(await getConfigSnapshot(client), { hash: "new", config: { model: "new", normalized: true }, raw: null });
  assert.equal(gets, 1);
});

test("a completed patch from an old gateway cannot invalidate the current gateway snapshot", async () => {
  let resolve!: (value: unknown) => void;
  const old = { request: async (method: string) => method === "config.get"
    ? { hash: "old", config: { model: "old" } }
    : new Promise(done => { resolve = done; }) } as unknown as GatewayBrowserClient;
  const current = { request: async () => ({ hash: "current", config: { model: "current" } }) } as unknown as GatewayBrowserClient;
  await getConfigSnapshot(old);
  const pending = patchConfig(old, draft => { draft.model = "next"; });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await getConfigSnapshot(current);
  resolve({ ok: true, hash: "old-next", config: { model: "next" } });
  await pending;
  assert.equal(getCachedConfigSnapshot()?.hash, "current");
});

test("a delayed patch acknowledgement cannot overwrite a newer authoritative config read", async () => {
  let resolve!: (value: unknown) => void;
  let gets = 0;
  const client = { request: async (method: string) => method === "config.get"
    ? { hash: ++gets === 1 ? "old" : "newer", config: { model: gets === 1 ? "old" : "newer" } }
    : new Promise(done => { resolve = done; }) } as unknown as GatewayBrowserClient;
  await getConfigSnapshot(client);
  const pending = patchConfig(client, draft => { draft.model = "next"; });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await getConfigSnapshot(client, { force: true });
  resolve({ ok: true, hash: "old-next", config: { model: "next" } });
  await pending;
  assert.equal(getCachedConfigSnapshot()?.hash, "newer");
});
