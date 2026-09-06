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
  // call 卡与 result 卡都能拿到最终统计
  const callContent = (entry?.callMessage.content as Array<Record<string, unknown>>)[0];
  assert.deepEqual(callContent.diffStat, { added: 2, removed: 1 });
  assert.deepEqual(entry?.resultMessage?.diffStat, { added: 2, removed: 1 });
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

test("tool result：toolErrorSummary / exitCode / toolArgs 透传到 resultMessage", () => {
  const host = makeHost();
  handleAgentEvent(
    host,
    toolEvent({ phase: "start", toolCallId: "tc1", name: "exec", args: { command: "npm test" } }),
  );
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
  const resultMessage = entry?.resultMessage;
  assert.ok(resultMessage);
  assert.equal(resultMessage.isError, true);
  assert.equal(resultMessage.toolErrorSummary, "command failed: exit 2");
  assert.equal(resultMessage.exitCode, 2);
  assert.equal(resultMessage.toolName, "exec");
  assert.deepEqual(resultMessage.toolArgs, { command: "npm test" });
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
  assert.equal(entry?.resultMessage?.exitCode, undefined);
});
