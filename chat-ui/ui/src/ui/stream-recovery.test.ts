// stream-recovery 纯逻辑测试：orphan 快照 / 挂起流看门狗判定 / 滞后读恢复判定。
import test from "node:test";
import assert from "node:assert/strict";

import {
  clearReconnectOrphanRun,
  hasAssistantReplyAfter,
  isStreamStalled,
  liveOrphanRun,
  liveOrphanRunId,
  markReconnectOrphanRun,
  preAlignThresholdMs,
  resetStreamPreAlign,
  shouldStreamPreAlign,
} from "./stream-recovery.ts";

// ── orphan 快照 ──

test("orphan：liveOrphanRun 返回完整快照（含标记时间，供回复判定用）", () => {
  markReconnectOrphanRun("run-1", "agent:main:main", 5000);
  const snapshot = liveOrphanRun("agent:main:main", 5000);
  assert.deepEqual(snapshot, { runId: "run-1", markedAt: 5000 });
  assert.equal(liveOrphanRunId("agent:main:main", 5000), "run-1", "liveOrphanRunId 与完整版一致");
  assert.equal(liveOrphanRun("agent:other:main", 5000), null);
  clearReconnectOrphanRun();
});

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

test("恢复判定：最后一条 assistant 缺 timestamp 时继续向前扫描", () => {
  const messages = [
    { role: "assistant", timestamp: 5000, content: [{ type: "text", text: "a" }] },
    { role: "assistant", content: [{ type: "text", text: "b" }] }, // 无 timestamp
  ];
  assert.equal(hasAssistantReplyAfter(messages, 4000), true);
});

test("恢复判定：cryoclawError 合成卡与缺时间戳条目混合仍正确", () => {
  const messages = [
    { role: "assistant", timestamp: 5000, content: [] },
    { role: "assistant", cryoclawError: true, timestamp: 6000, content: [] },
    { role: "assistant", content: [] },
  ];
  assert.equal(hasAssistantReplyAfter(messages, 4000), true);
});

test("恢复判定：上一轮刚落盘的回复（1s 容差窗口内）不得误判为本轮回复", () => {
  // 上一轮回复 10_400 落盘，距本轮开始 10_500 不足 1s——旧实现的
  // runStartedAt-1s 容差会把它误判为本轮回复，导致预对齐误清活跃 run。
  const messages = [
    { role: "user", timestamp: 10_000 },
    { role: "assistant", timestamp: 10_400, content: [{ type: "text", text: "上一轮回复" }] },
    { role: "user", timestamp: 10_500 },
  ];
  assert.equal(hasAssistantReplyAfter(messages, 10_500), false);
});

test("恢复判定：本轮回声之后的回复仍判定为本轮回复", () => {
  const messages = [
    { role: "assistant", timestamp: 10_400, content: [] },
    { role: "user", timestamp: 10_500 },
    { role: "assistant", timestamp: 12_000, content: [{ type: "text", text: "本轮回复" }] },
  ];
  assert.equal(hasAssistantReplyAfter(messages, 10_500), true);
});

test("恢复判定：无 user 回声时退回全列表扫描（1s 容差兜底，如 orphan 探测）", () => {
  const messages = [{ role: "assistant", timestamp: 12_000, content: [] }];
  assert.equal(hasAssistantReplyAfter(messages, 11_500), true);
});

test("恢复判定：内核副本回声时间戳略晚于 runStartedAt（+1s 宽限内）仍能锚定", () => {
  // mergeIfStale 替换后回声是内核副本，持久化时间戳晚于本地发送时刻（同机毫秒级，
  // 远程/云工作区更大）。锚条件若不带宽限会静默 miss、退化为全列表扫描——
  // 此时上一轮刚落盘的回复又会落进 1s 容差窗口被误判为本轮回复。
  const prevReply = { role: "assistant", timestamp: 9_400, content: [] };
  const kernelEcho = { role: "user", timestamp: 10_500 }; // 比 startedAt(10_000) 晚 500ms
  assert.equal(
    hasAssistantReplyAfter([prevReply, kernelEcho], 10_000),
    false,
    "锚定生效后，回声之前的上一轮回复不得被判定为本轮回复",
  );
  assert.equal(
    hasAssistantReplyAfter(
      [prevReply, kernelEcho, { role: "assistant", timestamp: 12_000, content: [] }],
      10_000,
    ),
    true,
    "回声之后的本轮回复仍正常命中",
  );
});

// ── R62 预对齐退避（P3-6） ──

test("预对齐阈值：首次 45s，步进翻倍，封顶 5min", () => {
  assert.equal(preAlignThresholdMs(0), 45_000);
  assert.equal(preAlignThresholdMs(1), 135_000, "45s + 90s");
  assert.equal(preAlignThresholdMs(2), 315_000, "45s + 90s + 180s");
  assert.equal(preAlignThresholdMs(3), 615_000, "第四步步进 360s 封顶 300s");
  assert.equal(preAlignThresholdMs(4), 915_000, "之后每步固定 +300s");
  assert.equal(preAlignThresholdMs(10), 2_715_000, "915s + 6×300s");
});

test("预对齐：阈值前不放行，同 run 内按退避逐个放行（修每 tick 全量拉）", () => {
  resetStreamPreAlign();
  // idleFor 46s：首次放行
  assert.equal(shouldStreamPreAlign("run-1", 46_000), true);
  // 下一个 tick（30s 后，idleFor 76s）：距上次对齐仅 30s < 90s 步进 → 不放行
  assert.equal(shouldStreamPreAlign("run-1", 76_000), false);
  assert.equal(shouldStreamPreAlign("run-1", 134_999), false);
  // idleFor 达 135s（累计间隔 90s）→ 第二次放行
  assert.equal(shouldStreamPreAlign("run-1", 135_000), true);
  // 之后步进 180s：315s 前不放行
  assert.equal(shouldStreamPreAlign("run-1", 300_000), false);
  assert.equal(shouldStreamPreAlign("run-1", 315_000), true);
});

test("预对齐：新 run 自动重新起算（run 生命周期去重）", () => {
  resetStreamPreAlign();
  assert.equal(shouldStreamPreAlign("run-1", 46_000), true);
  assert.equal(shouldStreamPreAlign("run-1", 200_000), true);
  // 换 runId：首次阈值重新从 45s 起算
  assert.equal(shouldStreamPreAlign("run-2", 46_000), true);
  assert.equal(shouldStreamPreAlign("run-2", 76_000), false);
});

test("预对齐：resetStreamPreAlign 清空状态，下一 run 从首次阈值起算", () => {
  resetStreamPreAlign();
  assert.equal(shouldStreamPreAlign("run-1", 46_000), true);
  assert.equal(shouldStreamPreAlign("run-1", 135_000), true);
  resetStreamPreAlign();
  assert.equal(shouldStreamPreAlign("run-1", 46_000), true, "reset 后同 runId 也重新起算");
  resetStreamPreAlign();
});

test("预对齐：自定义 base/cap 参数透传", () => {
  resetStreamPreAlign();
  assert.equal(preAlignThresholdMs(0, 10_000, 15_000), 10_000);
  assert.equal(preAlignThresholdMs(1, 10_000, 15_000), 25_000, "10s + 20s 步进封顶 15s");
  assert.equal(preAlignThresholdMs(2, 10_000, 15_000), 40_000, "之后每步固定 +15s");
  assert.equal(shouldStreamPreAlign("run-custom", 11_000, 10_000, 15_000), true);
  assert.equal(shouldStreamPreAlign("run-custom", 20_000, 10_000, 15_000), false);
  resetStreamPreAlign();
});
