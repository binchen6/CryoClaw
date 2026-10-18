import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { launchInstaller } from "./installer-launch";

test("installer launch waits for spawn before application exit", () => {
  let exits = 0;
  let unrefs = 0;
  const child = Object.assign(new EventEmitter(), { unref() { unrefs++; } });
  launchInstaller(() => child as ChildProcess, () => exits++, error => assert.fail(String(error)));
  assert.equal(exits, 0);
  child.emit("spawn");
  assert.equal(exits, 1);
  assert.equal(unrefs, 1);
});
test("asynchronous installer launch failure leaves the app running and reports error", () => {
  let exits = 0;
  let error: unknown;
  const child = new EventEmitter();
  launchInstaller(() => child as ChildProcess, () => exits++, e => error = e);
  const denied = new Error("EACCES");
  child.emit("error", denied);
  assert.equal(error, denied);
  assert.equal(exits, 0);
});
test("synchronous launch errors also release through failure callback", () => {
  let error: unknown;
  launchInstaller(() => { throw new Error("invalid executable"); }, assert.fail, e => error = e);
  assert.match(String(error), /invalid executable/);
});
