// run-state-store.ts（切换会话不断流：per-session run 态快照 + 后台事件累积）单测。
// handleChatEvent delta / handleAgentEvent thinking·tool 走 rAF 与 window.setTimeout，
// 装最小桩手动推进；断言只读同步更新的字段，不依赖节流 flush 自然触发。
import test from "node:test";
import assert from "node:assert/strict";

const g = globalThis as Record<string, unknown>;
g.window ??= {
  setTimeout: () => 0,
  clearTimeout: () => {},
};

import {
  accumulateBackgroundAgentEvent,
  captureRunStateSnapshot,
  clearSessionRunStateSnapshot,
  consumeRunStateHistoryDirty,
  dispatchBackgroundChatEvent,
  markRunStateHistoryDirty,
  peekRunStateSnapshot,
  requeueChatMessageForSession,
  resetRunStateStoreForTests,
  restoreRunStateSnapshot,
  saveRunStateSnapshot,
  takeRunStateSnapshot,
  type RunStateSnapshot,
} from "./run-state-store.ts";
import type { ChatQueueItem } from "./ui-types.ts";
import type { ChatEventPayload } from "./controllers/chat.ts";
import type { AgentEventPayload } from "./app-tool-stream.ts";
import { FakeScheduler } from "../test-utils/fake-scheduler.ts";

class FakeRaf extends FakeScheduler<FrameRequestCallback> {
  constructor() {
    super((fn) => fn(performance.now()));
  }
  requestAnimationFrame(fn: FrameRequestCallback) {
    return this.schedule(fn);
  }
  cancelAnimationFrame(id: number) {
    this.cancel(id);
  }
}

function installRaf(raf: FakeRaf) {
  Object.assign(globalThis, {
    requestAnimationFrame: (fn: FrameRequestCallback) => raf.requestAnimationFrame(fn),
    cancelAnimationFrame: (id: number) => raf.cancelAnimationFrame(id),
  });
}

// 完整 run 态宿主替身（字段集 = capture 来源超集）
function makeSource(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: "session-1",
    chatRunId: "run-1",
    chatStream: "正文已可见",
    chatPendingStreamText: null,
    chatStreamFrozenPrefix: "已冻结前缀",
    chatStreamMismatchCount: 2,
    chatThinkingStream: "思考已可见",
    chatPendingThinkingText: "思考 pending",
    chatNarrationText: "解说已可见",
    chatPendingNarrationText: "解说 pending",
    chatStreamStartedAt: 123,
    chatLastActivityAt: 456,
    chatAbortPending: true,
    chatTerminalRun: null,
    chatQueue: [{ id: "q1", message: "排队消息" }],
    chatMessages: [],
    chatStreamFrame: null,
    planState: { runId: "run-1", steps: [], explanation: null, updatedAt: 1, dismissed: false },
    toolStreamSyncTimer: null,
    toolStreamById: new Map(),
    toolStreamOrder: [],
    chatToolMessages: [],
    evictedLeadingSegments: [],
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<RunStateSnapshot> = {}): RunStateSnapshot {
  return {
    sessionKey: "session-1",
    chatStream: "正文",
    chatPendingStreamText: null,
    chatStreamFrozenPrefix: "",
    chatStreamMismatchCount: 0,
    chatThinkingStream: null,
    chatPendingThinkingText: null,
    chatNarrationText: null,
    chatPendingNarrationText: null,
    chatRunId: "run-1",
    chatStreamStartedAt: 123,
    chatLastActivityAt: 456,
    chatAbortPending: false,
    chatTerminalRun: null,
    chatQueue: [],
    chatMessages: [],
    chatStreamFrame: null,
    planState: null,
    toolStreamById: new Map(),
    toolStreamOrder: [],
    chatToolMessages: [],
    evictedLeadingSegments: [],
    toolStreamSyncTimer: null,
    ...overrides,
  };
}

function chatPayload(overrides: Partial<ChatEventPayload>): ChatEventPayload {
  return {
    runId: "run-1",
    sessionKey: "session-1",
    state: "delta",
    ...overrides,
  } as ChatEventPayload;
}

// ── capture / restore ──

test("capture/restore 往返：pending 提交进可见字段，字段与队列/计划/时间线无损", () => {
  const raf = new FakeRaf();
  installRaf(raf);
  const source = makeSource();
  const snapshot = captureRunStateSnapshot(source);

  const target = makeSource({
    chatStream: null,
    chatPendingStreamText: null,
    chatThinkingStream: null,
    chatPendingThinkingText: null,
    chatNarrationText: null,
    chatPendingNarrationText: null,
    chatStreamFrozenPrefix: "",
    chatStreamMismatchCount: 0,
    chatRunId: null,
    chatStreamStartedAt: null,
    chatLastActivityAt: null,
    chatAbortPending: false,
    chatQueue: [],
    planState: null,
  });
  restoreRunStateSnapshot(target, snapshot);

  // pending 优先提交：思考/解说 pending 覆盖可见字段；正文无 pending 用可见值
  assert.equal(target.chatStream, "正文已可见");
  assert.equal(target.chatThinkingStream, "思考 pending");
  assert.equal(target.chatNarrationText, "解说 pending");
  assert.equal(target.chatPendingThinkingText, null);
  assert.equal(target.chatPendingNarrationText, null);
  assert.equal(target.chatStreamFrozenPrefix, "已冻结前缀");
  assert.equal(target.chatStreamMismatchCount, 2);
  assert.equal(target.chatRunId, "run-1");
  assert.equal(target.chatStreamStartedAt, 123);
  assert.equal(target.chatLastActivityAt, 456);
  assert.equal(target.chatAbortPending, true);
  assert.deepEqual(target.chatQueue, [{ id: "q1", message: "排队消息" }]);
  assert.equal((target.planState as { runId: string }).runId, "run-1");
  // 恢复的队列是拷贝而非引用（快照与宿主互不牵连）
  assert.notEqual(target.chatQueue, snapshot.chatQueue);
});

test("capture 时 pending 的 rAF 帧被取消并提交（帧不跨宿主）", () => {
  const raf = new FakeRaf();
  installRaf(raf);
  const source = makeSource({
    chatStream: "旧文本",
    chatPendingStreamText: "最新 pending 文本",
    chatStreamFrame: 1,
  });
  // 挂一个帧模拟在途 flush
  raf.requestAnimationFrame(() => {});
  const snapshot = captureRunStateSnapshot(source);
  assert.equal(snapshot.chatStream, "最新 pending 文本", "pending 应已提交进可见字段");
  assert.equal(snapshot.chatPendingStreamText, null);
  assert.equal(snapshot.chatStreamFrame, null);
  assert.equal(source.chatStreamFrame, null, "旧宿主的在途帧应被取消");
});

test("capture：稀疏替身（无工具字段）退化为空时间线，不抛错", () => {
  const snapshot = captureRunStateSnapshot({ chatRunId: "r", chatStream: "x" });
  assert.equal(snapshot.chatRunId, "r");
  assert.equal(snapshot.toolStreamById.size, 0);
  assert.deepEqual(snapshot.chatQueue, []);
});

// ── Map 语义：一次性 take / LRU / 删除清理 / 历史脏 ──

test("save/take：take 一次性（第二次为 null），peek 不删除", () => {
  const snapshot = makeSnapshot();
  saveRunStateSnapshot("session-take", snapshot);
  assert.equal(peekRunStateSnapshot("session-take"), snapshot);
  assert.equal(takeRunStateSnapshot("session-take"), snapshot);
  assert.equal(takeRunStateSnapshot("session-take"), null, "take 为一次性语义");
  assert.equal(peekRunStateSnapshot("session-take"), null);
});

test("LRU 上限 20：最旧条目被逐出，重新 save 刷新迭代序", () => {
  for (let i = 1; i <= 20; i++) {
    saveRunStateSnapshot(`lru-${i}`, makeSnapshot({ chatRunId: `run-${i}` }));
  }
  assert.equal(peekRunStateSnapshot("lru-1")?.chatRunId, "run-1", "窗口内最旧仍在");
  saveRunStateSnapshot("lru-21", makeSnapshot({ chatRunId: "run-21" }));
  assert.equal(peekRunStateSnapshot("lru-1"), null, "超限后最旧条目被逐出");
  assert.equal(peekRunStateSnapshot("lru-2")?.chatRunId, "run-2");
  // 重存 lru-2 刷新序：再插入一条，逐出的应是 lru-3 而非 lru-2
  saveRunStateSnapshot("lru-2", makeSnapshot({ chatRunId: "run-2b" }));
  saveRunStateSnapshot("lru-22", makeSnapshot({ chatRunId: "run-22" }));
  assert.equal(peekRunStateSnapshot("lru-2")?.chatRunId, "run-2b", "重存条目保留");
  assert.equal(peekRunStateSnapshot("lru-3"), null, "最旧未被刷新的条目被逐出");
});

test("clearSessionRunStateSnapshot：删除条目与历史脏标记", () => {
  saveRunStateSnapshot("session-clear", makeSnapshot());
  markRunStateHistoryDirty("session-clear");
  clearSessionRunStateSnapshot("session-clear");
  assert.equal(peekRunStateSnapshot("session-clear"), null);
  assert.equal(consumeRunStateHistoryDirty("session-clear"), false);
});

test("LRU 驱逐优先空闲条目：活跃/队列条目豁免，脏标记随驱逐清理", () => {
  resetRunStateStoreForTests();
  for (let i = 0; i < 19; i++) {
    saveRunStateSnapshot(`idle-${i}`, makeSnapshot({ chatRunId: null }));
  }
  saveRunStateSnapshot("busy", makeSnapshot({ chatRunId: "run-busy" }));
  // 窗口满后每插一条逐出最旧空闲条目，busy 恒豁免
  for (let i = 19; i < 39; i++) {
    saveRunStateSnapshot(`idle-${i}`, makeSnapshot({ chatRunId: null }));
  }
  assert.ok(peekRunStateSnapshot("busy"), "活跃条目连续插入下不被驱逐");
  assert.equal(peekRunStateSnapshot("idle-0"), null, "最旧空闲条目已被逐出");
  // 队列非空的空闲条目同样豁免（排队消息不得随驱逐静默丢失）
  saveRunStateSnapshot("queued", makeSnapshot({ chatRunId: null, chatQueue: [{ id: "q", message: "x" }] }));
  saveRunStateSnapshot("idle-39", makeSnapshot({ chatRunId: null }));
  saveRunStateSnapshot("idle-40", makeSnapshot({ chatRunId: null }));
  assert.ok(peekRunStateSnapshot("queued"), "队列非空条目不被驱逐");
  // 脏标记随驱逐一并清理（否则 Set 只增不减）
  markRunStateHistoryDirty("idle-23");
  saveRunStateSnapshot("idle-41", makeSnapshot({ chatRunId: null }));
  assert.equal(peekRunStateSnapshot("idle-23"), null, "最旧空闲条目被逐出");
  assert.equal(consumeRunStateHistoryDirty("idle-23"), false, "脏标记随驱逐清理");
  resetRunStateStoreForTests();
});

test("requeueChatMessageForSession：有条目插回队首，无条目建最小快照条目", () => {
  resetRunStateStoreForTests();
  const item: ChatQueueItem = { id: "q9", message: "错投防护" };
  // 无条目：补一个仅含队列的最小条目（切回走既有恢复路径，队列继续自动冲刷）
  requeueChatMessageForSession("session-requeue-a", item);
  const created = takeRunStateSnapshot("session-requeue-a");
  assert.ok(created, "无条目时应建最小快照条目");
  assert.deepEqual(created!.chatQueue, [item]);
  assert.equal(created!.chatRunId, null);
  assert.equal(created!.toolStreamById.size, 0);
  assert.equal(created!.chatStream, null);
  // 有条目：插回队首并刷新 LRU 迭代序
  const entry = makeSnapshot({
    sessionKey: "session-requeue-b",
    chatRunId: null,
    chatQueue: [{ id: "q0", message: "已有" }],
  });
  saveRunStateSnapshot("session-requeue-b", entry);
  requeueChatMessageForSession("session-requeue-b", item);
  assert.deepEqual(entry.chatQueue, [item, { id: "q0", message: "已有" }], "回队条目插回队首");
  assert.equal(peekRunStateSnapshot("session-requeue-b"), entry, "LRU 序已刷新（不被驱逐）");
  resetRunStateStoreForTests();
});

test("markRunStateHistoryDirty / consume：一次性消费", () => {
  markRunStateHistoryDirty("session-dirty");
  assert.equal(consumeRunStateHistoryDirty("session-dirty"), true);
  assert.equal(consumeRunStateHistoryDirty("session-dirty"), false, "脏标记一次性消费");
});

// ── 后台 chat 事件分派 ──

test("后台 delta 累积进快照条目：append 与 message 全量自愈漏帧", () => {
  const raf = new FakeRaf();
  installRaf(raf);
  const entry = makeSnapshot({
    sessionKey: "session-bg",
    chatRunId: "run-1",
    chatStream: "Hello",
    chatStreamFrozenPrefix: "",
  });
  saveRunStateSnapshot("session-bg", entry);

  dispatchBackgroundChatEvent(
    chatPayload({
      sessionKey: "session-bg",
      deltaText: " world",
      message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    }),
  );
  raf.runAll();
  assert.equal(entry.chatStream, "Hello world");

  // 模拟漏帧：内核累计已含 "!"，本地基线落后——reducer 应以 message 全量 resync
  dispatchBackgroundChatEvent(
    chatPayload({
      sessionKey: "session-bg",
      deltaText: " again",
      message: { role: "assistant", content: [{ type: "text", text: "Hello world again!" }] },
    }),
  );
  raf.runAll();
  assert.equal(entry.chatStream, "Hello world again!", "漏帧应由 message 全量快照自愈");
  assert.ok(entry.chatLastActivityAt !== null);
});

test("后台 own-run 终态：条目内 run 态与时间线清零，队列保留，历史标脏", () => {
  const raf = new FakeRaf();
  installRaf(raf);
  const timeline = new Map([["tc1", {
    toolCallId: "tc1", runId: "run-1", name: "exec", startedAt: 1, updatedAt: 1,
    callMessage: {},
  }]]);
  const entry = makeSnapshot({
    sessionKey: "session-term",
    chatRunId: "run-1",
    chatStream: "部分回复",
    chatQueue: [{ id: "q1", message: "排队" }],
    toolStreamById: timeline,
    toolStreamOrder: ["tc1"],
  });
  saveRunStateSnapshot("session-term", entry);

  dispatchBackgroundChatEvent(
    chatPayload({ sessionKey: "session-term", state: "final", runId: "run-1" }),
  );

  assert.equal(entry.chatRunId, null, "终态后 runId 清零");
  assert.equal(entry.chatStream, null);
  assert.equal(entry.toolStreamById.size, 0, "工具时间线随终态清零");
  assert.deepEqual(entry.chatQueue, [{ id: "q1", message: "排队" }], "队列刻意保留");
  assert.equal(consumeRunStateHistoryDirty("session-term"), true, "历史应标脏（切回强制重拉）");
});

test("后台外来 run 终态：只 tombstone，条目 run 态原样保留", () => {
  const entry = makeSnapshot({ sessionKey: "session-foreign", chatRunId: "run-1", chatStream: "仍在跑" });
  saveRunStateSnapshot("session-foreign", entry);

  dispatchBackgroundChatEvent(
    chatPayload({ sessionKey: "session-foreign", state: "final", runId: "run-subagent" }),
  );

  assert.equal(entry.chatRunId, "run-1", "外来 run 终态不得清本会话 run 态");
  assert.equal(entry.chatStream, "仍在跑");
  assert.equal(consumeRunStateHistoryDirty("session-foreign"), false, "外来终态不标脏");
});

test("无条目：后台事件维持丢弃语义（delta 静默丢弃，终态不炸）", () => {
  dispatchBackgroundChatEvent(
    chatPayload({ sessionKey: "session-none", state: "delta", runId: "run-x", deltaText: "x" }),
  );
  dispatchBackgroundChatEvent(
    chatPayload({ sessionKey: "session-none", state: "final", runId: "run-x" }),
  );
  assert.equal(peekRunStateSnapshot("session-none"), null);
});

// ── 后台 agent 事件分派 ──

function agentPayload(overrides: Partial<AgentEventPayload> & { data: Record<string, unknown> }): AgentEventPayload {
  return {
    runId: "run-1",
    seq: 1,
    stream: "thinking",
    ts: Date.now(),
    sessionKey: "session-bg-agent",
    ...overrides,
  };
}

test("后台 thinking 事件累积进条目（pending 语义，切回时提交）", () => {
  const raf = new FakeRaf();
  installRaf(raf);
  const entry = makeSnapshot({ sessionKey: "session-bg-agent", chatRunId: "run-1" });
  saveRunStateSnapshot("session-bg-agent", entry);

  accumulateBackgroundAgentEvent(
    "session-bg-agent",
    agentPayload({ data: { text: "后台思考中", delta: "后台思考中" } }),
  );
  assert.equal(entry.chatPendingThinkingText, "后台思考中");
});

test("后台 tool start：冻结 leadingSegment/frozenPrefix 并以条目为宿主建时间线", () => {
  const raf = new FakeRaf();
  installRaf(raf);
  const entry = makeSnapshot({ sessionKey: "session-bg-tool", chatRunId: "run-1", chatStream: "工具前正文", chatStreamStartedAt: 7 });
  saveRunStateSnapshot("session-bg-tool", entry);

  accumulateBackgroundAgentEvent(
    "session-bg-tool",
    agentPayload({
      stream: "tool",
      sessionKey: "session-bg-tool",
      data: { phase: "start", toolCallId: "tc1", name: "exec", args: { command: "ls" } },
    }),
  );

  const tc = entry.toolStreamById.get("tc1");
  assert.ok(tc, "条目时间线应含该工具条目");
  assert.equal(tc?.leadingSegment?.text, "工具前正文");
  assert.equal(entry.chatStream, null, "冻结后可见正文清空");
  assert.equal(entry.chatStreamFrozenPrefix, "工具前正文", "冻结前缀推进（后台 delta 切片用）");
  assert.equal(entry.toolStreamOrder.length, 1);
});

test("无条目的后台 agent 事件：静默丢弃", () => {
  accumulateBackgroundAgentEvent(
    "session-none-agent",
    agentPayload({ sessionKey: "session-none-agent", data: { text: "x" } }),
  );
  assert.equal(peekRunStateSnapshot("session-none-agent"), null);
});
