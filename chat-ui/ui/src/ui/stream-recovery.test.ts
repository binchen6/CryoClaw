// stream-recovery 纯逻辑测试：orphan 快照 / 挂起流看门狗判定 / 滞后读恢复判定。
import test from "node:test";
import assert from "node:assert/strict";

import {
  clearReconnectOrphanRun,
  hasAssistantReplyAfter,
  isStreamStalled,
  liveOrphanRunId,
  markReconnectOrphanRun,
} from "./stream-recovery.ts";

// ── orphan 快照 ──

test("orphan：快照后可收养，清除后不可", () => {
  markReconnectOrphanRun("run-1", 1000);
  assert.equal(liveOrphanRunId(1000), "run-1");
  clearReconnectOrphanRun("run-1");
  assert.equal(liveOrphanRunId(1000), null);
});

test("orphan：空 runId 不记录", () => {
  markReconnectOrphanRun(null, 1000);
  assert.equal(liveOrphanRunId(1000), null);
  markReconnectOrphanRun("  ", 1000);
  assert.equal(liveOrphanRunId(1000), null);
});

test("orphan：超过 TTL 自动失效", () => {
  markReconnectOrphanRun("run-1", 1000);
  assert.equal(liveOrphanRunId(1000 + 120_001), null, "TTL 后快照应失效");
});

test("orphan：无参清除全清，带参清除只清匹配项", () => {
  markReconnectOrphanRun("run-1", 1000);
  clearReconnectOrphanRun("other");
  assert.equal(liveOrphanRunId(1000), "run-1", "不匹配的 key 不应清除快照");
  clearReconnectOrphanRun();
  assert.equal(liveOrphanRunId(1000), null);
});

// ── 挂起流看门狗 ──

test("看门狗：无活跃 run 不判定超时", () => {
  assert.equal(
    isStreamStalled({ chatRunId: null, lastActivityAt: 1000, now: 999_000, idleMs: 180_000 }),
    false,
  );
});

test("看门狗：空闲超阈值判定超时，未超不判", () => {
  const base = { chatRunId: "run-1", idleMs: 180_000 };
  assert.equal(isStreamStalled({ ...base, lastActivityAt: 1000, now: 182_000 }), true);
  assert.equal(isStreamStalled({ ...base, lastActivityAt: 1000, now: 180_000 }), false);
});

test("看门狗：缺活动时间戳按不超时处理（保守）", () => {
  assert.equal(
    isStreamStalled({ chatRunId: "run-1", lastActivityAt: null, now: 999_000, idleMs: 180_000 }),
    false,
  );
});

// ── 滞后读恢复判定 ──

test("恢复判定：run 开始后落盘的 assistant 回复 → 可清挂起态", () => {
  const messages = [
    { role: "user", timestamp: 10_000 },
    { role: "assistant", timestamp: 12_000 },
  ];
  assert.equal(hasAssistantReplyAfter(messages, 11_000), true);
});

test("恢复判定：只有 run 前的旧回复 → 继续等待", () => {
  const messages = [
    { role: "assistant", timestamp: 8_000 },
    { role: "user", timestamp: 10_000 },
  ];
  assert.equal(hasAssistantReplyAfter(messages, 10_000), false);
});

test("恢复判定：合成错误卡不算落盘结果", () => {
  const messages = [{ role: "assistant", timestamp: 12_000, cryoclawError: true }];
  assert.equal(hasAssistantReplyAfter(messages, 11_000), false);
});

test("恢复判定：缺 timestamp / 缺起始时间保守返回 false", () => {
  assert.equal(hasAssistantReplyAfter([{ role: "assistant" }], 11_000), false);
  assert.equal(hasAssistantReplyAfter([{ role: "assistant", timestamp: 99_000 }], null), false);
  assert.equal(hasAssistantReplyAfter([], 11_000), false);
});
