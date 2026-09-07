import test from "node:test";
import assert from "node:assert/strict";
import {
  activeTaskSessionKeys,
  applyTaskEvent,
  filterTasksByStatus,
  findActiveTaskForSession,
  isActiveTask,
  sortTasks,
  taskDurationMs,
  toTaskTimestampMs,
  type TaskEventPayload,
} from "./tasks.ts";
import type { TaskSummary } from "../types.ts";

function task(id: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return { id, status: "running", ...overrides };
}

test("sortTasks 按 updatedAt 降序，缺失时间戳排在末尾", () => {
  const a = task("a", { updatedAt: 100 });
  const b = task("b", { updatedAt: 300 });
  const c = task("c", {});
  const d = task("d", { updatedAt: 200 });

  const sorted = sortTasks([a, b, c, d]);
  assert.deepEqual(
    sorted.map((t) => t.id),
    ["b", "d", "a", "c"],
  );
});

test("sortTasks 时间戳相等时按 id 稳定排序", () => {
  const b = task("b", { updatedAt: 100 });
  const a = task("a", { updatedAt: 100 });
  const sorted = sortTasks([b, a]);
  assert.deepEqual(
    sorted.map((t) => t.id),
    ["a", "b"],
  );
});

test("sortTasks 不修改原数组", () => {
  const input = [task("a", { updatedAt: 100 }), task("b", { updatedAt: 300 })];
  sortTasks(input);
  assert.deepEqual(
    input.map((t) => t.id),
    ["a", "b"],
  );
});

test("isActiveTask：queued/running 为进行中", () => {
  assert.equal(isActiveTask(task("q", { status: "queued" })), true);
  assert.equal(isActiveTask(task("r", { status: "running" })), true);
});

test("isActiveTask：终态不是进行中，未知状态默认排队处理", () => {
  assert.equal(isActiveTask(task("c", { status: "completed" })), false);
  assert.equal(isActiveTask(task("f", { status: "failed" })), false);
  assert.equal(isActiveTask(task("x", { status: "cancelled" })), false);
  assert.equal(isActiveTask(task("t", { status: "timed_out" })), false);
  assert.equal(isActiveTask(task("z", {})), true);
});

test("filterTasksByStatus：all 返回全部，指定状态只返回匹配项", () => {
  const tasks = [
    task("a", { status: "running" }),
    task("b", { status: "failed" }),
    task("c", { status: "completed" }),
  ];
  assert.equal(filterTasksByStatus(tasks, "all").length, 3);
  assert.deepEqual(
    filterTasksByStatus(tasks, "failed").map((t) => t.id),
    ["b"],
  );
  assert.equal(filterTasksByStatus(tasks, "queued").length, 0);
});

test("applyTaskEvent：upserted 合并新任务并保持排序", () => {
  const current = [task("a", { updatedAt: 100 }), task("b", { updatedAt: 300 })];
  const payload: TaskEventPayload = {
    action: "upserted",
    task: task("c", { updatedAt: 200 }),
  };
  const next = applyTaskEvent(current, payload);
  assert.ok(next, "应返回新列表");
  assert.deepEqual(
    next!.map((t) => t.id),
    ["b", "c", "a"],
  );
});

test("applyTaskEvent：upserted 覆盖同 id 旧任务", () => {
  const current = [task("a", { updatedAt: 100, title: "old" })];
  const payload: TaskEventPayload = {
    action: "upserted",
    task: task("a", { updatedAt: 500, title: "new" }),
  };
  const next = applyTaskEvent(current, payload)!;
  assert.equal(next.length, 1);
  assert.equal(next[0].title, "new");
});

test("applyTaskEvent：deleted 按 taskId 移除", () => {
  const current = [task("a"), task("b"), task("c")];
  const payload: TaskEventPayload = { action: "deleted", taskId: "b" };
  const next = applyTaskEvent(current, payload)!;
  assert.deepEqual(
    next.map((t) => t.id),
    ["a", "c"],
  );
});

test("applyTaskEvent：deleted 也可从 task.id 兜底", () => {
  const current = [task("a"), task("b")];
  const payload: TaskEventPayload = { action: "deleted", task: task("a") };
  const next = applyTaskEvent(current, payload)!;
  assert.deepEqual(
    next.map((t) => t.id),
    ["b"],
  );
});

test("applyTaskEvent：restored / 未知 action / 非法 payload 返回 null 触发全量重拉", () => {
  assert.equal(applyTaskEvent([], { action: "restored" }), null);
  assert.equal(applyTaskEvent([], { action: "renamed" }), null);
  assert.equal(applyTaskEvent([], undefined), null);
  assert.equal(applyTaskEvent([], { action: "upserted" }), null);
  assert.equal(applyTaskEvent([], { action: "deleted" }), null);
});

test("toTaskTimestampMs：number / ISO string 均解析，非法值返回 null", () => {
  assert.equal(toTaskTimestampMs(123), 123);
  assert.equal(toTaskTimestampMs("1970-01-01T00:00:01.000Z"), 1000);
  assert.equal(toTaskTimestampMs("not-a-date"), null);
  assert.equal(toTaskTimestampMs(undefined), null);
  assert.equal(toTaskTimestampMs(Number.NaN), null);
});

test("taskDurationMs：startedAt→endedAt 计算耗时", () => {
  const t = task("a", { status: "completed", startedAt: 1000, endedAt: 4000 });
  assert.equal(taskDurationMs(t), 3000);
});

test("taskDurationMs：进行中任务用当前时间", () => {
  const t = task("a", { status: "running", startedAt: 1000 });
  assert.equal(taskDurationMs(t, 6000), 5000);
});

test("taskDurationMs：终态缺 endedAt 时退化用 updatedAt", () => {
  const t = task("a", { status: "failed", startedAt: 1000, updatedAt: 2500 });
  assert.equal(taskDurationMs(t), 1500);
});

test("taskDurationMs：缺 startedAt / 时长非正返回 null", () => {
  assert.equal(taskDurationMs(task("a", { status: "completed", endedAt: 1000 })), null);
  assert.equal(
    taskDurationMs(task("b", { status: "completed", startedAt: 2000, endedAt: 1000 })),
    null,
  );
  // ISO string 也可解析
  const t = task("c", {
    status: "completed",
    startedAt: "1970-01-01T00:00:01.000Z",
    endedAt: "1970-01-01T00:00:02.500Z",
  });
  assert.equal(taskDurationMs(t), 1500);
});

// ── R58：删除守卫（会话关联活跃任务） ──────────────────────────────

test("findActiveTaskForSession：childSessionKey / sessionKey 任一命中且任务活跃才算关联", () => {
  const runningChild = task("a", { status: "running", childSessionKey: "agent:main:s1", sessionKey: "agent:main:s0" });
  const queuedOwn = task("b", { status: "queued", sessionKey: "agent:main:s2" });
  const doneChild = task("c", { status: "completed", childSessionKey: "agent:main:s1" });
  const list = [runningChild, queuedOwn, doneChild];

  assert.equal(findActiveTaskForSession(list, "agent:main:s1")?.id, "a", "child 会话命中 running 任务");
  assert.equal(findActiveTaskForSession(list, "agent:main:s0")?.id, "a", "发起会话命中同一 running 任务");
  assert.equal(findActiveTaskForSession(list, "agent:main:s2")?.id, "b", "queued 同样算活跃");
  assert.equal(findActiveTaskForSession(list, "agent:main:s9"), null, "无关联会话返回 null");
  assert.equal(findActiveTaskForSession([], "agent:main:s1"), null);
  assert.equal(findActiveTaskForSession(list, ""), null, "空 key 返回 null");
});

test("activeTaskSessionKeys：收集全部活跃任务的会话 key（大小写不敏感命中由查询侧保证）", () => {
  const keys = activeTaskSessionKeys([
    task("a", { status: "running", childSessionKey: "s-child", sessionKey: "s-own" }),
    task("b", { status: "completed", childSessionKey: "s-done" }),
    task("c", { status: "cancelled", sessionKey: "s-cancelled" }),
    task("d", { status: "queued", sessionKey: "s-own" }),
  ]);
  assert.deepEqual([...keys].sort(), ["s-child", "s-own"]);
});
