import test from "node:test";
import assert from "node:assert/strict";

// tool 流路径的 scheduleToolStreamSync 走 window.setTimeout（80ms 节流）；
// node 环境无 window，打桩为「不触发」的定时器——断言只读同步更新的 entry/message，
// 不依赖节流 flush（result 终态走 force 同步路径）。
const g = globalThis as Record<string, unknown>;
g.window ??= {
  setTimeout: () => 0,
  clearTimeout: () => {},
};

import {
  clearFallbackNotice,
  flushToolStreamSync,
  handleAgentEvent,
  type AgentEventPayload,
} from "./app-tool-stream.ts";

type TestHost = Parameters<typeof handleAgentEvent>[0] & {
  fallbackNotice?: unknown;
  fallbackClearTimer?: number | null;
};

function makeHost(overrides?: Partial<TestHost>): TestHost {
  return {
    sessionKey: "agent:main:main",
    chatRunId: "run-1",
    toolStreamById: new Map(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    chatStream: null,
    chatStreamStartedAt: null,
    chatPendingStreamText: null,
    chatStreamFrozenPrefix: "",
    evictedLeadingSegments: [],
    fallbackNotice: null,
    fallbackClearTimer: null,
    ...overrides,
  } as TestHost;
}

function lifecycleEvent(data: Record<string, unknown>, overrides?: Partial<AgentEventPayload>): AgentEventPayload {
  return {
    runId: "run-1",
    seq: 1,
    stream: "lifecycle",
    ts: Date.now(),
    sessionKey: "agent:main:main",
    data,
    ...overrides,
  };
}

test("lifecycle fallback：解析为 fallbackNotice（activeModel/selectedModel/reasonSummary）", () => {
  const host = makeHost();
  handleAgentEvent(
    host,
    lifecycleEvent({
      phase: "fallback",
      activeModel: "openai/gpt-4o-mini",
      selectedModel: "openai/gpt-4o",
      reasonSummary: "rate limit",
    }),
  );
  const notice = host.fallbackNotice as Record<string, unknown> | null;
  assert.ok(notice);
  assert.equal(notice.cleared, false);
  assert.equal(notice.activeModel, "openai/gpt-4o-mini");
  assert.equal(notice.selectedModel, "openai/gpt-4o");
  assert.equal(notice.reasonSummary, "rate limit");
  assert.equal(typeof notice.at, "number");
});

test("lifecycle fallback_cleared：解析为 cleared 提示（previousActiveModel/activeModel）", () => {
  const host = makeHost();
  handleAgentEvent(
    host,
    lifecycleEvent({
      phase: "fallback_cleared",
      activeModel: "openai/gpt-4o",
      previousActiveModel: "openai/gpt-4o-mini",
    }),
  );
  const notice = host.fallbackNotice as Record<string, unknown> | null;
  assert.ok(notice);
  assert.equal(notice.cleared, true);
  assert.equal(notice.activeModel, "openai/gpt-4o");
  assert.equal(notice.previousActiveModel, "openai/gpt-4o-mini");
});

test("lifecycle 过滤：sessionKey 不匹配丢弃", () => {
  const host = makeHost();
  handleAgentEvent(
    host,
    lifecycleEvent(
      { phase: "fallback", activeModel: "m2", selectedModel: "m1" },
      { sessionKey: "agent:other:main" },
    ),
  );
  assert.equal(host.fallbackNotice, null);
});

test("lifecycle 过滤：runId 不匹配丢弃", () => {
  const host = makeHost();
  handleAgentEvent(
    host,
    lifecycleEvent({ phase: "fallback", activeModel: "m2" }, { runId: "run-other" }),
  );
  assert.equal(host.fallbackNotice, null);
});

test("lifecycle 过滤：无活跃 run（chatRunId=null）丢弃", () => {
  const host = makeHost({ chatRunId: null });
  handleAgentEvent(host, lifecycleEvent({ phase: "fallback", activeModel: "m2" }));
  assert.equal(host.fallbackNotice, null);
});

test("lifecycle 容错：缺 activeModel 或未知 phase 丢弃", () => {
  const host = makeHost();
  handleAgentEvent(host, lifecycleEvent({ phase: "fallback", selectedModel: "m1" }));
  assert.equal(host.fallbackNotice, null);
  handleAgentEvent(host, lifecycleEvent({ phase: "something_else", activeModel: "m2" }));
  assert.equal(host.fallbackNotice, null);
});

test("clearFallbackNotice：清掉提示与定时器句柄", () => {
  const host = makeHost();
  handleAgentEvent(host, lifecycleEvent({ phase: "fallback", activeModel: "m2" }));
  assert.ok(host.fallbackNotice);
  clearFallbackNotice(host as Parameters<typeof clearFallbackNotice>[0]);
  assert.equal(host.fallbackNotice, null);
  assert.equal(host.fallbackClearTimer, null);
});

// ── R52 T4：input_delta 实时 diff / result 终态字段消费 ──

function toolEvent(data: Record<string, unknown>, overrides?: Partial<AgentEventPayload>): AgentEventPayload {
  return {
    runId: "run-1",
    seq: 1,
    stream: "tool",
    ts: Date.now(),
    sessionKey: "agent:main:main",
    data,
    ...overrides,
  };
}

test("tool input_delta：实时 diff 写入 entry 并随 callMessage 内容块上屏", () => {
  const host = makeHost();
  handleAgentEvent(
    host,
    toolEvent({ phase: "start", toolCallId: "tc1", name: "write", args: { path: "a.ts" } }),
  );
  handleAgentEvent(
    host,
    toolEvent({ phase: "input_delta", toolCallId: "tc1", name: "write", diff: { added: 3, removed: 1 } }),
  );
  const entry = host.toolStreamById.get("tc1");
  assert.deepEqual(entry?.diffStat, { added: 3, removed: 1 });
  const content = (entry?.callMessage.content as Array<Record<string, unknown>>)[0];
  assert.deepEqual(content.diffStat, { added: 3, removed: 1 });
  // input_delta 不产生 output，call 仍是 pending
  assert.equal(entry?.output, undefined);
});

test("tool input_delta：非法 diff 载荷被忽略", () => {
  const host = makeHost();
  handleAgentEvent(
    host,
    toolEvent({ phase: "start", toolCallId: "tc1", name: "edit", args: { path: "a.ts" } }),
  );
  handleAgentEvent(
    host,
    toolEvent({ phase: "input_delta", toolCallId: "tc1", name: "edit", diff: { added: -1, removed: 0 } }),
  );
  handleAgentEvent(
    host,
    toolEvent({ phase: "input_delta", toolCallId: "tc1", name: "edit", diff: "nope" }),
  );
  assert.equal(host.toolStreamById.get("tc1")?.diffStat, undefined);
});

test("tool result：details.diff 文本解析出的最终统计替换实时徽标", () => {
  const host = makeHost();
  handleAgentEvent(
    host,
    toolEvent({ phase: "start", toolCallId: "tc1", name: "edit", args: { path: "a.ts" } }),
  );
  handleAgentEvent(
    host,
    toolEvent({ phase: "input_delta", toolCallId: "tc1", name: "edit", diff: { added: 9, removed: 9 } }),
  );
  handleAgentEvent(
    host,
    toolEvent({
      phase: "result",
      toolCallId: "tc1",
      name: "edit",
      isError: false,
      result: {
        text: "edited",
        details: { diff: "--- a/a.ts\n+++ b/a.ts\n@@\n-old\n+new\n+new2" },
      },
    }),
  );
  const entry = host.toolStreamById.get("tc1");
  assert.deepEqual(entry?.diffStat, { added: 2, removed: 1 });
  // R83：result 并入 call 内容块（无独立 resultMessage）
  const callContent = (entry?.callMessage.content as Array<Record<string, unknown>>)[0];
  assert.deepEqual(callContent.diffStat, { added: 2, removed: 1 });
  assert.equal(entry?.callMessage.pending, undefined);
});

test("tool result：details 无 diff 时清除实时徽标（对齐 control-ui）", () => {
  const host = makeHost();
  handleAgentEvent(
    host,
    toolEvent({ phase: "start", toolCallId: "tc1", name: "write", args: { path: "a.ts" } }),
  );
  handleAgentEvent(
    host,
    toolEvent({ phase: "input_delta", toolCallId: "tc1", name: "write", diff: { added: 5, removed: 0 } }),
  );
  handleAgentEvent(
    host,
    toolEvent({
      phase: "result",
      toolCallId: "tc1",
      name: "write",
      isError: false,
      result: { text: "ok" },
    }),
  );
  const entry = host.toolStreamById.get("tc1");
  assert.equal(entry?.diffStat, undefined);
  const callContent = (entry?.callMessage.content as Array<Record<string, unknown>>)[0];
  assert.equal(callContent.diffStat, undefined);
});

test("tool result（R83 合并）：输出/错误摘要/退出码并入 call 内容块，无独立 result 消息", () => {
  const host = makeHost();
  handleAgentEvent(
    host,
    toolEvent({ phase: "start", toolCallId: "tc1", name: "exec", args: { command: "npm test" } }),
  );
  // 进行中：pending 标记 + 无输出
  const pendingEntry = host.toolStreamById.get("tc1");
  assert.equal(pendingEntry?.callMessage.pending, true);
  handleAgentEvent(
    host,
    toolEvent({
      phase: "result",
      toolCallId: "tc1",
      name: "exec",
      isError: true,
      toolErrorSummary: "command failed: exit 2",
      result: { text: "full raw output…", exitCode: 2 },
    }),
  );
  const entry = host.toolStreamById.get("tc1");
  assert.equal(entry?.isError, true);
  assert.equal(entry?.toolErrorSummary, "command failed: exit 2");
  assert.equal(entry?.exitCode, 2);
  // call 消息：pending 消失，块上带完整 result 载荷
  const callMessage = entry?.callMessage as Record<string, unknown>;
  assert.equal(callMessage.pending, undefined);
  assert.equal(callMessage.role, "assistant");
  const block = (callMessage.content as Array<Record<string, unknown>>)[0];
  assert.equal(block.text, "full raw output…");
  assert.equal(block.isError, true);
  assert.equal(block.toolErrorSummary, "command failed: exit 2");
  assert.equal(block.exitCode, 2);
  assert.deepEqual(block.arguments, { command: "npm test" });
  // 时间线只有一条消息（call 含 result）
  assert.equal(host.chatToolMessages.length, 1);
  assert.equal(host.chatToolMessages[0], callMessage);
});

test("tool result：空字符串输出也算完成（不永远 pending）", () => {
  const host = makeHost();
  handleAgentEvent(
    host,
    toolEvent({ phase: "start", toolCallId: "tc1", name: "read", args: { path: "a.ts" } }),
  );
  handleAgentEvent(
    host,
    toolEvent({
      phase: "result",
      toolCallId: "tc1",
      name: "read",
      isError: false,
      result: "",
    }),
  );
  const entry = host.toolStreamById.get("tc1");
  assert.equal(entry?.output, "");
  assert.equal(entry?.callMessage.pending, undefined);
  const block = (entry?.callMessage.content as Array<Record<string, unknown>>)[0];
  assert.equal(block.text, "");
});

test("tool update：空 partialResult 不提前结束执行中状态", () => {
  const host = makeHost();
  handleAgentEvent(
    host,
    toolEvent({ phase: "start", toolCallId: "tc1", name: "read", args: { path: "a.ts" } }),
  );
  handleAgentEvent(
    host,
    toolEvent({ phase: "update", toolCallId: "tc1", name: "read", partialResult: "" }),
  );
  const entry = host.toolStreamById.get("tc1");
  assert.equal(entry?.output, undefined);
  assert.equal(entry?.callMessage.pending, true);
});

test("tool result：exitCode 宽容解析（非整数/缺失不计）", () => {
  const host = makeHost();
  handleAgentEvent(
    host,
    toolEvent({ phase: "start", toolCallId: "tc1", name: "exec", args: {} }),
  );
  handleAgentEvent(
    host,
    toolEvent({
      phase: "result",
      toolCallId: "tc1",
      name: "exec",
      isError: false,
      result: { text: "ok", exitCode: 1.5 },
    }),
  );
  const entry = host.toolStreamById.get("tc1");
  assert.equal(entry?.exitCode, undefined);
  const block = (entry?.callMessage.content as Array<Record<string, unknown>>)[0];
  assert.equal(block.exitCode, undefined);
});

// ── R88：思考流式 / 中途解说（preamble）流式 ──

test("thinking 流式：data.text 全量写入 chatPendingThinkingText（跨 flush 的 pending 语义）", () => {
  const host = makeHost({ chatThinkingStream: null, chatPendingThinkingText: null });
  handleAgentEvent(host, {
    runId: "run-1", seq: 1, stream: "thinking", ts: Date.now(),
    sessionKey: "agent:main:main",
    data: { text: "先拆解任务", delta: "先拆解任务" },
  });
  assert.equal(host.chatPendingThinkingText, "先拆解任务");
});

test("thinking 流式：phase 重启（text 变短）整体替换而非追加", () => {
  const host = makeHost({ chatThinkingStream: "很长的第一段推理...", chatPendingThinkingText: null });
  handleAgentEvent(host, {
    runId: "run-1", seq: 2, stream: "thinking", ts: Date.now(),
    sessionKey: "agent:main:main",
    data: { text: "第二段", delta: "第二段" },
  });
  assert.equal(host.chatPendingThinkingText, "第二段");
});

test("thinking 流式：sessionKey 不匹配不写入", () => {
  const host = makeHost({ chatThinkingStream: null, chatPendingThinkingText: null });
  handleAgentEvent(host, {
    runId: "run-1", seq: 3, stream: "thinking", ts: Date.now(),
    sessionKey: "agent:main:other",
    data: { text: "别家思考", delta: "别家思考" },
  });
  assert.equal(host.chatPendingThinkingText ?? null, null);
});

test("preamble 解说流式：progressText 写入 chatPendingNarrationText", () => {
  const host = makeHost({ chatNarrationText: null, chatPendingNarrationText: null });
  handleAgentEvent(host, {
    runId: "run-1", seq: 4, stream: "item", ts: Date.now(),
    sessionKey: "agent:main:main",
    data: { kind: "preamble", phase: "update", title: "Preamble", progressText: "我先跑第一条命令看看输出", itemId: "item-1" },
  });
  assert.equal(host.chatPendingNarrationText, "我先跑第一条命令看看输出");
});

test("preamble → tool start：解说冻结为 narrationSegment，时间线顺序 解说→正文段→工具卡", () => {
  const host = makeHost({
    chatNarrationText: "我先跑第一条命令看看输出",
    chatPendingNarrationText: null,
    chatStream: "正文第一段",
    chatStreamStartedAt: Date.now() - 1000,
  });
  handleAgentEvent(host, {
    runId: "run-1", seq: 5, stream: "tool", ts: Date.now(),
    sessionKey: "agent:main:main",
    data: { phase: "start", name: "exec", toolCallId: "call-1", args: { command: "echo hi" } },
  });
  const entry = host.toolStreamById.get("call-1");
  assert.ok(entry, "tool entry 应已创建");
  assert.equal(entry?.narrationSegment?.text, "我先跑第一条命令看看输出");
  assert.equal(entry?.leadingSegment?.text, "正文第一段");
  // 解说不并入 frozenPrefix（commentary 被内核从 chat delta 广播中抑制，不属于累计文本）
  assert.equal(host.chatStreamFrozenPrefix, "正文第一段");
  // 解说在冻结后被清空
  assert.equal(host.chatNarrationText ?? null, null);
  // 时间线顺序：narrationSegment → leadingSegment → callMessage
  // （start 阶段走节流 flush；测试桩不触发定时器，手动 flush 后断言）
  flushToolStreamSync(host);
  assert.equal(host.chatToolMessages.length, 3);
  const first = host.chatToolMessages[0] as { content: Array<{ text: string }> };
  assert.equal(first.content[0]?.text, "我先跑第一条命令看看输出");
});

test("seq-gap agent 错误：匹配当前 run 时触发 onStreamSeqGap 钩子", () => {
  let called = 0;
  const host = makeHost({ onStreamSeqGap: () => { called++; } });
  handleAgentEvent(host, {
    runId: "run-1", seq: 99, stream: "error", ts: Date.now(),
    sessionKey: "agent:main:main",
    data: { reason: "seq gap", expected: 50, received: 99 },
  });
  assert.equal(called, 1);
  assert.notEqual(host.chatLastActivityAt ?? null, null);
});

test("seq-gap agent 错误：run 不匹配不触发", () => {
  let called = 0;
  const host = makeHost({ onStreamSeqGap: () => { called++; } });
  handleAgentEvent(host, {
    runId: "run-other", seq: 99, stream: "error", ts: Date.now(),
    sessionKey: "agent:main:main",
    data: { reason: "seq gap", expected: 50, received: 99 },
  });
  assert.equal(called, 0);
});
