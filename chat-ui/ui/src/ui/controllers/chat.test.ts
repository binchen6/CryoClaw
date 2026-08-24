import assert from "node:assert/strict";
import { handleChatEvent, loadChatHistory } from "./chat.ts";
import { FakeScheduler } from "../../test-utils/fake-scheduler.ts";

// 最小帧调度器，手动推进 requestAnimationFrame 回调。
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

function installBrowserGlobals(raf: FakeRaf) {
  Object.assign(globalThis, {
    window: {
      requestAnimationFrame: (fn: FrameRequestCallback) => raf.requestAnimationFrame(fn),
      cancelAnimationFrame: (id: number) => raf.cancelAnimationFrame(id),
    },
    requestAnimationFrame: (fn: FrameRequestCallback) => raf.requestAnimationFrame(fn),
    cancelAnimationFrame: (id: number) => raf.cancelAnimationFrame(id),
    performance: { now: () => 0 },
  });
}

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    client: null,
    connected: true,
    sessionKey: "session-1",
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatRunId: "run-1",
    chatStream: "",
    chatStreamStartedAt: null,
    chatStreamFrozenPrefix: "",
    chatVisibleMessageCount: 0,
    chatHistoryHydrationFrame: null,
    chatPendingStreamText: null,
    chatStreamFrame: null,
    lastError: null,
    ...overrides,
  } as any;
}

async function flushMicrotasks() {
  await Promise.resolve();
}

// stream delta 应在一帧内合并，只保留最新文本，避免每个 token 都触发重渲染。
async function testChatStreamIsRafThrottled() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState();

  handleChatEvent(state, {
    runId: "run-1",
    sessionKey: "session-1",
    state: "delta",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  });
  handleChatEvent(state, {
    runId: "run-1",
    sessionKey: "session-1",
    state: "delta",
    message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
  });

  assert.equal(state.chatStream, "", "delta 到达当帧不应立刻写入 Lit state");
  raf.runAll();
  assert.equal(state.chatStream, "hello world", "一帧内应只提交最新的 stream 文本");
}

// 首次加载大量历史消息时，首帧只渲染一个小批次，后续再渐进补齐。
async function testLoadChatHistoryBatchesInitialRender() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const messages = Array.from({ length: 80 }, (_, index) => ({
    role: "assistant",
    content: [{ type: "text", text: `message-${index}` }],
    timestamp: index,
  }));
  const state = makeState({
    client: {
      request: async () => ({
        messages,
        thinkingLevel: "medium",
      }),
    },
  });

  // loadChatHistory 的渐进渲染调度是 setTimeout(hydrate, 32)，不是 rAF；
  // stub 全局 setTimeout 收集 hydration 回调，手动推进（避免真实等待 32ms）。
  const hydrationTimers: Array<() => void> = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => {
    hydrationTimers.push(fn);
    return 0;
  }) as typeof setTimeout;

  try {
    await loadChatHistory(state);
    await flushMicrotasks();

    assert.equal(state.chatMessages.length, 80, "历史消息仍应完整保存在状态里");
    assert.equal(state.chatVisibleMessageCount, 20, "首帧应只暴露第一批可见消息");

    const next = hydrationTimers.shift();
    if (next) next();
    assert.ok(state.chatVisibleMessageCount > 20, "后续定时器应继续扩展可见消息");

    while (hydrationTimers.length > 0) {
      const timer = hydrationTimers.shift();
      if (timer) timer();
    }
    assert.equal(state.chatVisibleMessageCount, 80, "渐进渲染结束后应补齐全部历史消息");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

// 复现 #streaming-dup：tool_use 之后的 delta 不应把 tool_use 之前的整段文本再次写入 chatStream。
// 之前的段已经被 app-tool-stream 冻成 leadingSegment 单独渲染，再写入就会和 leadingSegment 重复。
async function testDeltaAfterToolUseShowsOnlyTrailingText() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState();

  // 1) tool_use 之前的流式：chatStream 反映完整文本。
  handleChatEvent(state, {
    runId: "run-1",
    sessionKey: "session-1",
    state: "delta",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "前置段：让我尝试直接调用 API" }],
    },
  });
  raf.runAll();
  assert.equal(state.chatStream, "前置段：让我尝试直接调用 API");

  // 2) 模拟 app-tool-stream 在 tool 事件中冻结 leadingSegment 后清空 chatStream。
  //    冻结的前置段写入 chatStreamFrozenPrefix，供后续 delta 按前缀截断避免重复。
  state.chatStream = null;
  state.chatPendingStreamText = null;
  state.chatStreamFrozenPrefix = "前置段：让我尝试直接调用 API";

  // 3) tool_use 之后第一帧 delta：content 仍带 tool_use 之前的 text 块，
  //    但 chatStream 应只反映 tool_use 之后的新段，不能把"前置段"再写一次。
  handleChatEvent(state, {
    runId: "run-1",
    sessionKey: "session-1",
    state: "delta",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "前置段：让我尝试直接调用 API" },
        { type: "tool_use", id: "t1", name: "bash", input: {} },
        { type: "text", text: "让我尝试使用一个已知的小红书 API 端点" },
      ],
    },
  });
  raf.runAll();
  // 截断后可能保留 tool_use 之后自然产生的换行；断言意图是「不含前置段 + 含后续段」。
  assert.ok(
    !state.chatStream.includes("前置段"),
    "tool_use 之后的 chatStream 不应包含前置段",
  );
  assert.ok(
    state.chatStream.includes("让我尝试使用一个已知的小红书 API 端点"),
    "tool_use 之后的 chatStream 应只显示后续段",
  );
}

// （已移除）旧架构测试：多 tool_use / 尾部 tool_use 的 delta 内容解析。
// 当前 chat.ts 的 delta 设计（见 handleChatEvent 注释）：gateway 把整轮 assistant 文本
// 累积进同一 text block，工具调用走独立 agent 流并由 app-tool-stream 冻结为
// chatStreamFrozenPrefix；chat delta 里不再依赖解析 content 中的 tool_use 位置。
// 该场景的截断语义由 testDeltaAfterToolUseShowsOnlyTrailingText 覆盖。

// run 级 state==="error"（如 "Agent failed before reply"）只在消息流内注入 cryoclawError
// 合成消息 → 渲染层走着色错误卡片（对齐 control-ui）；不写 lastError，避免与顶部 callout 双显示。
async function testRunErrorInjectsInlineErrorMessage() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState();

  handleChatEvent(state, {
    runId: "run-1",
    sessionKey: "session-1",
    state: "error",
    errorMessage: "Agent failed before reply: boom",
  });

  assert.equal(state.lastError, null, "错误已由消息流卡片展示，不应再写 lastError callout");
  assert.equal(state.chatRunId, null, "error 后应清掉 run 状态");
  assert.equal(state.chatMessages.length, 1, "应在消息流内注入一条错误消息");
  const injected = state.chatMessages[0] as Record<string, unknown>;
  assert.equal(injected.role, "assistant");
  assert.equal(injected.cryoclawError, true, "渲染层据此走着色错误卡片");
  assert.equal(
    (injected.content as Array<{ text?: string }>)[0]?.text,
    "Error: Agent failed before reply: boom",
  );
  assert.equal(state.chatVisibleMessageCount, 1, "注入的消息应立即可见");
}

// 无本地活跃 run 时，别家 run（sub-agent/迟到帧）的 delta 必须丢弃，否则出现僵尸流式气泡。
async function testForeignDeltaDroppedWhenNoActiveRun() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState({ chatRunId: null, chatStream: null });

  const result = handleChatEvent(state, {
    runId: "run-foreign",
    sessionKey: "session-1",
    state: "delta",
    message: { role: "assistant", content: [{ type: "text", text: "foreign" }] },
  });
  raf.runAll();

  assert.equal(result, null);
  assert.equal(state.chatStream, null, "外来 delta 不应写入 chatStream");
  assert.equal(state.chatPendingStreamText, null);
}

// 无本地活跃 run 时，别家 run 的 error 不得注入带「重发」的错误卡。
async function testForeignErrorDoesNotInjectCardWhenNoActiveRun() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState({ chatRunId: null });

  const result = handleChatEvent(state, {
    runId: "run-foreign",
    sessionKey: "session-1",
    state: "error",
    errorMessage: "sub-agent exploded",
  });

  assert.equal(result, null);
  assert.equal(state.chatMessages.length, 0, "外来 error 不应注入错误卡片");
}

// 无本地活跃 run 时 final 仍透传（触发历史刷新，如 sub-agent announce）。
async function testForeignFinalPassesThroughWhenNoActiveRun() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState({ chatRunId: null });

  const result = handleChatEvent(state, {
    runId: "run-foreign",
    sessionKey: "session-1",
    state: "final",
  });
  assert.equal(result, "final");
}

function makeHistoryClient(messages: unknown[]) {
  return {
    request: async (method: string) => {
      assert.equal(method, "chat.history");
      return { messages };
    },
  } as any;
}

// mergeIfStale：普通短读（内核滞后）保留本地列表。
async function testMergeIfStaleKeepsLocalOnShortRead() {
  installBrowserGlobals(new FakeRaf());
  const local = [1, 2, 3, 4, 5].map((i) => ({ role: "user", content: [{ type: "text", text: `m${i}` }] }));
  const state = makeState({
    client: makeHistoryClient([{ role: "user", content: [{ type: "text", text: "m1" }] }]),
    chatMessages: [...local],
  });

  await loadChatHistory(state, { mergeIfStale: true });
  assert.equal(state.chatMessages.length, 5, "滞后短读应保留本地消息");
}

// mergeIfStale：raw 含 compaction 标记说明服务端合法压缩，必须替换（否则新回复永不上屏）。
async function testMergeIfStaleReplacesOnCompaction() {
  installBrowserGlobals(new FakeRaf());
  const local = [1, 2, 3, 4, 5].map((i) => ({ role: "user", content: [{ type: "text", text: `m${i}` }] }));
  const compacted = [
    {
      role: "system",
      content: [{ type: "text", text: "Compaction" }],
      __openclaw: { kind: "compaction", id: "c1", seq: 1 },
    },
    { role: "assistant", content: [{ type: "text", text: "new reply" }] },
  ];
  const state = makeState({
    client: makeHistoryClient(compacted),
    chatMessages: [...local],
  });

  await loadChatHistory(state, { mergeIfStale: true });
  assert.equal(state.chatMessages.length, 2, "compaction 后应替换为压缩后的历史");
  assert.equal(
    (state.chatMessages[1] as any).content[0].text,
    "new reply",
  );
}

async function main() {
  await testChatStreamIsRafThrottled();
  await testLoadChatHistoryBatchesInitialRender();
  await testDeltaAfterToolUseShowsOnlyTrailingText();
  await testRunErrorInjectsInlineErrorMessage();
  await testForeignDeltaDroppedWhenNoActiveRun();
  await testForeignErrorDoesNotInjectCardWhenNoActiveRun();
  await testForeignFinalPassesThroughWhenNoActiveRun();
  await testMergeIfStaleKeepsLocalOnShortRead();
  await testMergeIfStaleReplacesOnCompaction();
  console.log("chat controller tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
