import test from "node:test";
import assert from "node:assert/strict";
import { registerTickHandler, startTicker, stopTicker, unregisterTickHandler } from "./client-ticker.ts";

test("client ticker：同轮只读 handler 并发完成、错误隔离且轮次不重入", async () => {
  const events: string[] = [];
  const originalError = console.error;
  const originalWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval } as typeof window;
  console.error = () => {};
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  registerTickHandler("test-slow", async () => {
    events.push("slow:start");
    await sleep(25);
    events.push("slow:end");
  });
  registerTickHandler("test-fast", async () => {
    events.push("fast:start");
    await sleep(5);
    events.push("fast:end");
  });
  registerTickHandler("test-error", () => {
    events.push("error");
    throw new Error("expected isolated failure");
  });
  try {
    startTicker();
    startTicker();
    await sleep(45);
    assert.deepEqual(events.slice(0, 3), ["slow:start", "fast:start", "error"]);
    assert.ok(events.includes("slow:end") && events.includes("fast:end"));
    assert.equal(events.filter((event) => event === "slow:start").length, 1);
    assert.equal(events.filter((event) => event === "fast:start").length, 1);
  } finally {
    console.error = originalError;
    stopTicker();
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
    for (const name of ["test-slow", "test-fast", "test-error"]) unregisterTickHandler(name);
  }
});

test("reconnect starts fresh reads while the old round is pending, without unlocking the new round", async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  let tick: () => void = () => {};
  globalThis.window = { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval() {} } as unknown as typeof window;
  globalThis.document = { hidden: false } as Document;
  const pending: Array<() => void> = [];
  registerTickHandler("reconnect-test", () => new Promise<void>(resolve => pending.push(resolve)));
  try {
    startTicker();
    assert.equal(pending.length, 1);
    stopTicker(); startTicker();
    assert.equal(pending.length, 2, "old connection cannot defer sessions.list by a full tick interval");
    pending[0]!();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    tick();
    assert.equal(pending.length, 2, "old completion cannot unlock the current round");
    pending[1]!();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    tick();
    assert.equal(pending.length, 3);
    pending[2]!();
  } finally {
    stopTicker(); unregisterTickHandler("reconnect-test");
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});
