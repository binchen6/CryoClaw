import test from "node:test";
import assert from "node:assert/strict";

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
