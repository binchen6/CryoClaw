import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitialAppUpdateState,
  reduceAppUpdateState,
  type AppUpdateState,
} from "./app-updater-state";

function idleState(supported = true): AppUpdateState {
  return createInitialAppUpdateState(supported, "1.0.0");
}

test("初始状态为 idle，携带 supported 与当前版本号", () => {
  const s = idleState();
  assert.equal(s.status, "idle");
  assert.equal(s.supported, true);
  assert.equal(s.currentVersion, "1.0.0");
  assert.equal(s.version, null);
  assert.equal(s.progress, null);
  assert.equal(s.error, null);
});

test("主流程：idle → checking → available → downloading → downloaded", () => {
  let s = idleState();
  s = reduceAppUpdateState(s, { type: "checking" });
  assert.equal(s.status, "checking");

  s = reduceAppUpdateState(s, { type: "available", version: "1.1.0", releaseNotes: { zh: "修复问题" } });
  assert.equal(s.status, "available");
  assert.equal(s.version, "1.1.0");
  assert.deepEqual(s.releaseNotes, { zh: "修复问题" });

  s = reduceAppUpdateState(s, { type: "progress", percent: 42, bytesPerSecond: 1024, transferred: 100, total: 200 });
  assert.equal(s.status, "downloading");
  assert.equal(s.progress?.percent, 42);
  assert.equal(s.progress?.total, 200);

  s = reduceAppUpdateState(s, { type: "downloaded" });
  assert.equal(s.status, "downloaded");
  assert.equal(s.progress, null);
  assert.equal(s.version, "1.1.0"); // 版本号保留，供重启按钮/提示使用
});

test("not-available：清空版本与进度", () => {
  let s = idleState();
  s = reduceAppUpdateState(s, { type: "checking" });
  s = reduceAppUpdateState(s, { type: "not-available" });
  assert.equal(s.status, "not-available");
  assert.equal(s.version, null);
  assert.equal(s.error, null);
});

test("error 后重新 checking 可重试（状态复位）", () => {
  let s = idleState();
  s = reduceAppUpdateState(s, { type: "checking" });
  s = reduceAppUpdateState(s, { type: "error", message: "network down" });
  assert.equal(s.status, "error");
  assert.equal(s.error, "network down");

  // 重新触发检查：清空错误，回到 checking
  s = reduceAppUpdateState(s, { type: "checking" });
  assert.equal(s.status, "checking");
  assert.equal(s.error, null);
  assert.equal(s.version, null);
});

test("progress 数值钳制到 0-100，非法值归零", () => {
  let s = reduceAppUpdateState(idleState(), { type: "available", version: "2.0.0" });

  s = reduceAppUpdateState(s, { type: "progress", percent: 150, bytesPerSecond: 0, transferred: 0, total: 0 });
  assert.equal(s.progress?.percent, 100);

  s = reduceAppUpdateState(s, { type: "progress", percent: -5, bytesPerSecond: 0, transferred: 0, total: 0 });
  assert.equal(s.progress?.percent, 0);

  s = reduceAppUpdateState(s, { type: "progress", percent: Number.NaN, bytesPerSecond: 0, transferred: 0, total: 0 });
  assert.equal(s.progress?.percent, 0);
});

test("游离 progress 事件被忽略（idle/checking 态不改变）", () => {
  const s = idleState();
  const next = reduceAppUpdateState(s, { type: "progress", percent: 50, bytesPerSecond: 0, transferred: 0, total: 0 });
  assert.equal(next.status, "idle");
  assert.equal(next.progress, null);
});
