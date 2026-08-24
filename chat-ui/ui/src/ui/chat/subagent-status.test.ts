import test from "node:test";
import assert from "node:assert/strict";

import { isFailedSubagentStatus, selectSubagentCards } from "./subagent-status.ts";
import type { TaskSummary } from "../types.ts";

const SESSION = "agent:main:main";
const NOW = Date.now();

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "task-1",
    runtime: "subagent",
    status: "running",
    sessionKey: SESSION,
    title: "研究任务",
    ...overrides,
  };
}

test("subagent：活跃任务被投影为卡片（含 progressSummary）", () => {
  const cards = selectSubagentCards(
    [makeTask({ progressSummary: "正在检索资料" })],
    SESSION,
    NOW,
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].active, true);
  assert.equal(cards[0].title, "研究任务");
  assert.equal(cards[0].progress, "正在检索资料");
});

test("subagent：跨会话 / 非 subagent 任务不显示", () => {
  const cards = selectSubagentCards(
    [
      makeTask({ sessionKey: "agent:main:other" }),
      makeTask({ runtime: "cron" }),
    ],
    SESSION,
    NOW,
  );
  assert.equal(cards.length, 0, "跨会话与 cron 任务都不投影");
});

test("subagent：ownerKey 关联也视为当前会话", () => {
  const cards = selectSubagentCards(
    [makeTask({ sessionKey: "agent:sub:s1", ownerKey: SESSION })],
    SESSION,
    NOW,
  );
  assert.equal(cards.length, 1);
});

test("subagent：终态任务定格窗口内显示、过期隐藏", () => {
  const fresh = makeTask({ status: "completed", endedAt: NOW - 5_000 });
  const stale = makeTask({ id: "task-2", status: "completed", endedAt: NOW - 60_000 });
  const cards = selectSubagentCards([fresh, stale], SESSION, NOW);
  assert.equal(cards.length, 1, "仅定格窗口内的终态任务显示");
  assert.equal(cards[0].id, "task-1");
  assert.equal(cards[0].active, false);
});

test("subagent：终态无时间戳时不显示（防僵尸卡）", () => {
  const cards = selectSubagentCards(
    [makeTask({ status: "completed", endedAt: undefined, updatedAt: undefined })],
    SESSION,
    NOW,
  );
  assert.equal(cards.length, 0);
});

test("subagent：空列表 / 空会话键安全返回空", () => {
  assert.deepEqual(selectSubagentCards([], SESSION, NOW), []);
  assert.deepEqual(selectSubagentCards([makeTask()], "", NOW), []);
  assert.deepEqual(selectSubagentCards(null, SESSION, NOW), []);
});

test("subagent：无 status 字段不误判为活跃（防僵尸等待卡）", () => {
  // 无时间戳 → 不可判定，隐藏
  const noStatus = makeTask({ status: undefined, endedAt: undefined, updatedAt: undefined });
  assert.equal(selectSubagentCards([noStatus], SESSION, NOW).length, 0);
  // 终态时间窗内 → 按非活跃展示（而不是恒显示）
  const freshNoStatus = makeTask({ id: "t2", status: undefined, endedAt: NOW - 5_000, updatedAt: undefined });
  const cards = selectSubagentCards([freshNoStatus], SESSION, NOW);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].active, false, "无 status 应走终态路径");
  assert.equal(cards[0].status, "completed");
});

test("subagent：失败类状态判定", () => {
  assert.equal(isFailedSubagentStatus("failed"), true);
  assert.equal(isFailedSubagentStatus("cancelled"), true);
  assert.equal(isFailedSubagentStatus("timed_out"), true);
  assert.equal(isFailedSubagentStatus("completed"), false);
});
