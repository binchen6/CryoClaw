import test from "node:test";
import assert from "node:assert/strict";
import { isUpdateDownloadPending, requestUpdateDownload } from "./update-download.ts";

test("download guard blocks rapid retry clicks and notifies the renderer immediately", async () => {
  let finish!: () => void;
  let calls = 0;
  let updates = 0;
  const host = {
    requestUpdate() { updates++; },
    startUpdateDownload() {
      calls++;
      return new Promise<void>(resolve => { finish = resolve; });
    },
  };
  const first = requestUpdateDownload(host);
  assert.equal(isUpdateDownloadPending(host), true);
  assert.equal(updates, 1);
  await requestUpdateDownload(host);
  assert.equal(calls, 1);
  finish();
  await first;
  assert.equal(isUpdateDownloadPending(host), false);
  assert.equal(updates, 2);
});

test("command rejection releases the guard so retry remains possible", async () => {
  let calls = 0;
  const host = {
    requestUpdate() {},
    async startUpdateDownload() { if (++calls === 1) throw new Error("offline"); },
  };
  await assert.rejects(requestUpdateDownload(host), /offline/);
  assert.equal(isUpdateDownloadPending(host), false);
  await requestUpdateDownload(host);
  assert.equal(calls, 2);
});

test("download guards are isolated between app states", async () => {
  let finish!: () => void;
  const a = { requestUpdate() {}, startUpdateDownload: () => new Promise<void>(resolve => { finish = resolve; }) };
  let called = false;
  const b = { requestUpdate() {}, async startUpdateDownload() { called = true; } };
  const pending = requestUpdateDownload(a);
  await requestUpdateDownload(b);
  assert.equal(called, true);
  assert.equal(isUpdateDownloadPending(a), true);
  assert.equal(isUpdateDownloadPending(b), false);
  finish();
  await pending;
});
