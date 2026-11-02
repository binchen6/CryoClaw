import assert from "node:assert/strict";
import { test } from "node:test";
import { QqbotLoginController } from "./qqbot-login.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("QR renders the local SVG format produced by the official connector boundary", async () => {
  const localSvg = "data:image/svg+xml;base64,PHN2Zy8+";
  const flow = new QqbotLoginController({ start: async () => ({ attemptId: "svg", status: "waiting", qrDataUrl: localSvg, message: "scan" }), wait: async () => { throw new Error("not polled"); }, cancel: async () => {}, onChange: () => {}, onConnected: async () => {}, schedule: () => () => {} });
  await flow.start();
  assert.equal(flow.state.qrDataUrl, localSvg);
});

test("QR cancellation rejects late start and cancels the attempt returned after leaving", async () => {
  const pending = deferred<any>(); const canceled: string[] = []; const updates: any[] = [];
  const flow = new QqbotLoginController({ start: () => pending.promise, wait: async () => { throw new Error("must not poll"); }, cancel: async ({ attemptId }) => { canceled.push(attemptId); }, onChange: state => updates.push({ ...state }), onConnected: async () => {} });
  const starting = flow.start();
  flow.cancel();
  pending.resolve({ attemptId: "late", status: "waiting", qrDataUrl: "data:image/png;base64,AA", message: "scan" });
  await starting; await tick();
  assert.deepEqual(canceled, ["late"]);
  assert.equal(flow.state.status, "idle");
  assert.equal(updates.some(s => s.qrDataUrl), false);
});

test("QR keeps one poll in flight, refreshes image, and reloads once on connected", async () => {
  let active = 0; let maxActive = 0; let reloads = 0; let polls = 0; const scheduled: Array<() => void> = []; const pending = deferred<any>();
  const flow = new QqbotLoginController({
    start: async () => ({ attemptId: "one", status: "waiting", qrDataUrl: "data:image/png;base64,AA", message: "scan" }),
    wait: async () => { active++; maxActive = Math.max(active, maxActive); polls++; const result = await pending.promise; active--; return result; },
    cancel: async () => {}, onChange: () => {}, onConnected: async () => { reloads++; }, schedule: fn => { scheduled.push(fn); return () => {}; },
  });
  await flow.start();
  assert.equal(scheduled.length, 1);
  scheduled.shift()!(); await tick();
  assert.equal(polls, 1);
  assert.equal(scheduled.length, 0);
  pending.resolve({ attemptId: "one", status: "waiting", qrDataUrl: "data:image/png;base64,BB", message: "refreshed" });
  await tick();
  assert.equal(flow.state.qrDataUrl, "data:image/png;base64,BB");
  flow.cancel();
  assert.equal(maxActive, 1);
  assert.equal(reloads, 0);
});

test("QR ignores a late connected response after account change and reconnects once on retry", async () => {
  const pending = deferred<any>(); const scheduled: Array<() => void> = []; let reloads = 0; let n = 0;
  const flow = new QqbotLoginController({ start: async () => ({ attemptId: String(++n), status: "waiting", qrDataUrl: "data:image/png;base64,AA", message: "scan" }), wait: async ({ attemptId }) => attemptId === "1" ? pending.promise : ({ attemptId, status: "connected", message: "bound" }), cancel: async () => {}, onChange: () => {}, onConnected: async () => { reloads++; }, schedule: fn => { scheduled.push(fn); return () => {}; } });
  await flow.start(); scheduled.shift()!(); await tick(); flow.cancel();
  pending.resolve({ attemptId: "1", status: "connected", message: "old" }); await tick();
  assert.equal(reloads, 0);
  await flow.start(); scheduled.pop()!(); await tick();
  assert.equal(flow.state.status, "connected"); assert.equal(reloads, 1);
});

test("QR surfaces failure and expired terminal states without another poll", async () => {
  for (const status of ["expired", "error"] as const) {
    const scheduled: Array<() => void> = [];
    const flow = new QqbotLoginController({ start: async () => ({ attemptId: "one", status: "waiting", qrDataUrl: "data:image/png;base64,AA", message: "scan" }), wait: async () => ({ attemptId: "one", status, message: "retry" }), cancel: async () => {}, onChange: () => {}, onConnected: async () => {}, schedule: fn => { scheduled.push(fn); return () => {}; } });
    await flow.start(); scheduled.shift()!(); await tick();
    assert.equal(flow.state.status, status); assert.equal(scheduled.length, 0);
  }
});
