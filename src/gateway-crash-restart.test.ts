// gateway-crash-restart.test.ts — 网关崩溃自动重启策略（R71）
import test from "node:test";
import assert from "node:assert/strict";
import {
  CRASH_RESTART_MAX,
  CRASH_RESTART_WINDOW_MS,
  decideCrashRestart,
} from "./gateway-crash-restart";

test("窗口内前 N 次允许重启，第 N+1 次拒绝（防崩溃循环）", () => {
  let times: number[] = [];
  const now = 1_000_000;
  for (let i = 1; i <= CRASH_RESTART_MAX; i++) {
    const d = decideCrashRestart(times, now + i * 1000);
    assert.equal(d.allow, true, `第 ${i} 次应允许`);
    assert.equal(d.attempt, i);
    times = d.times;
  }
  const denied = decideCrashRestart(times, now + (CRASH_RESTART_MAX + 1) * 1000);
  assert.equal(denied.allow, false, "达上限后拒绝自动重启");
  assert.equal(denied.times.length, CRASH_RESTART_MAX, "被拒时不追加时间戳");
});

test("超出时间窗的历史记录被清出（窗口滑动后可再次重启）", () => {
  const recent = [1000, 2000, 3000];
  const justOutside = 3000 + CRASH_RESTART_WINDOW_MS + 1;
  const d = decideCrashRestart(recent, justOutside);
  assert.equal(d.allow, true, "窗口外的旧崩溃不再计入");
  assert.deepEqual(d.times, [justOutside], "窗口内只剩本次");
});

test("部分过期：仅窗口内计数（窗口边缘不误判）", () => {
  const now = 1_000_000;
  // 一条严格过期（now - window - 1）、一条在窗内；边界值 now-1 也应计入
  const times = [now - CRASH_RESTART_WINDOW_MS - 1, now - 1];
  const d = decideCrashRestart(times, now);
  assert.equal(d.allow, true);
  assert.deepEqual(d.times, [now - 1, now], "过期项被剔除、边界内保留");
});

test("自定义上限/窗口（测试与未来调参用）", () => {
  const d1 = decideCrashRestart([], 0, { max: 1, windowMs: 1000 });
  assert.equal(d1.allow, true);
  const d2 = decideCrashRestart(d1.times, 10, { max: 1, windowMs: 1000 });
  assert.equal(d2.allow, false);
  const d3 = decideCrashRestart(d2.times, 2000, { max: 1, windowMs: 1000 });
  assert.equal(d3.allow, true, "窗口过期后重新允许");
});
