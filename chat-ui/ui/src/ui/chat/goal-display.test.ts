import test from "node:test";
import assert from "node:assert/strict";
import {
  formatGoalCount,
  formatGoalDuration,
  goalElapsedMs,
  goalStatusKind,
  goalTokenPercent,
  goalTokensLabel,
} from "./goal-display.ts";
import type { SessionGoal } from "../types.ts";

function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    objective: "build the feature",
    status: "active",
    createdAt: 1_000,
    ...overrides,
  };
}

test("goalStatusKind 映射语义色分组", () => {
  assert.equal(goalStatusKind("active"), "active");
  assert.equal(goalStatusKind("paused"), "paused");
  assert.equal(goalStatusKind("complete"), "complete");
  assert.equal(goalStatusKind("blocked"), "blocked");
  assert.equal(goalStatusKind("budget_limited"), "blocked");
  assert.equal(goalStatusKind("usage_limited"), "warn");
});

test("goalElapsedMs：active 从 createdAt 计时，终态从对应时间戳计时", () => {
  const now = 10_000;
  assert.equal(goalElapsedMs(goal(), now), 9_000);
  assert.equal(goalElapsedMs(goal({ status: "paused", pausedAt: 5_000 }), now), 5_000);
  assert.equal(goalElapsedMs(goal({ status: "complete", completedAt: 7_000 }), now), 3_000);
  // 无状态时间戳回退 createdAt
  assert.equal(goalElapsedMs(goal({ status: "complete" }), now), 9_000);
  // 未来时间戳不出现负值
  assert.equal(goalElapsedMs(goal(), 500), 0);
});

test("formatGoalDuration：秒/分钟/小时", () => {
  assert.equal(formatGoalDuration(30_000), "30s");
  assert.equal(formatGoalDuration(90_000), "1m");
  assert.equal(formatGoalDuration(3_600_000), "1h");
  assert.equal(formatGoalDuration(3_900_000), "1h 5m");
});

test("formatGoalCount：千/百万缩写", () => {
  assert.equal(formatGoalCount(0), "0");
  assert.equal(formatGoalCount(500), "500");
  assert.equal(formatGoalCount(1_200), "1.2k");
  assert.equal(formatGoalCount(150_000), "150k");
  assert.equal(formatGoalCount(2_500_000), "2.5m");
});

test("goalTokensLabel / goalTokenPercent", () => {
  assert.equal(goalTokensLabel(goal({ tokensUsed: 1_200, tokenBudget: 8_000 })), "1.2k/8k");
  assert.equal(goalTokensLabel(goal({ tokensUsed: 300 })), "300 used");
  assert.equal(goalTokensLabel(goal()), null);
  assert.equal(goalTokenPercent(goal({ tokensUsed: 4_000, tokenBudget: 8_000 })), 50);
  assert.equal(goalTokenPercent(goal({ tokensUsed: 9_000, tokenBudget: 8_000 })), 100);
  assert.equal(goalTokenPercent(goal()), null);
});
