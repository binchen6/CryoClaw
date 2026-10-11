import assert from "node:assert/strict";
import { mock } from "node:test";
import {
  cancelStaleHistoryRetryForTests,
  handleChatEvent,
  loadChatHistory,
  sendChatMessage,
  stripInFlightStreamDuplicates,
} from "./chat.ts";
import {
  clearReconnectOrphanRun,
  liveOrphanRunId,
  markReconnectOrphanRun,
} from "../stream-recovery.ts";
import {
  flushToolStreamSync,
  handleAgentEvent,
  invalidateDuplicatedNarrationSegments,
} from "../app-tool-stream.ts";
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
      // handleAgentEvent（tool 流节流）依赖 window.setTimeout；测试手动 flush，
      // 桩成不触发的定时器即可。
      setTimeout: () => 0,
      clearTimeout: () => {},
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
    chatNarrationText: null,
    chatPendingNarrationText: null,
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

// 可控 deferred 的历史客户端：request 挂起，直到外部调用 resolvers[i](响应)。
// 并发/交错加载类测试用它精确控制响应返回顺序。
function makeDeferredHistoryClient() {
  const resolvers: Array<(res: unknown) => void> = [];
  const client = {
    request: async () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  } as any;
  return { client, resolvers };
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

// mergeIfStale：空读（瞬时异常）同样保留本地，防 delta 丢失叠加空读清空视图（R23）。
async function testMergeIfStaleKeepsLocalOnEmptyRead() {
  installBrowserGlobals(new FakeRaf());
  const local = [1, 2, 3].map((i) => ({ role: "user", content: [{ type: "text", text: `m${i}` }] }));
  const state = makeState({
    client: makeHistoryClient([]),
    chatMessages: [...local],
  });

  await loadChatHistory(state, { mergeIfStale: true });
  assert.equal(state.chatMessages.length, 3, "空读应保留本地消息");
}

// 发送在途期间会话已切换：旧会话的失败结果（错误卡/run 状态清理）不得写入新会话。
// 否则错误卡的 resendText 重发会把旧文本发进新会话，且新会话进行中的 run 被清。
async function testSendFailureAfterSessionSwitchDoesNotTouchNewSession() {
  installBrowserGlobals(new FakeRaf());
  const state = makeState({
    client: {
      request: async (method: string) => {
        if (method === "chat.send") {
          // 模拟 await 期间用户切换到会话 B，随后请求才失败
          state.sessionKey = "session-2";
          throw new Error("network down");
        }
        throw new Error(`unexpected call: ${method}`);
      },
    },
  });

  const result = await sendChatMessage(state, "hello from session-1");
  assert.equal(result, null, "失败的发送应返回 null");
  assert.equal(state.chatMessages.length, 1, "新会话消息流不应被注入旧会话的错误卡");
  const only = state.chatMessages[0] as any;
  assert.equal(only.role, "user", "唯一消息应是乐观 append 的 user 消息");
  assert.equal(
    typeof state.chatRunId,
    "string",
    "新会话的 run 状态不得被旧会话的失败回调清除",
  );
  assert.equal(state.chatSending, false, "发送标志应由 finally 复位");
}

// R30 重连续跑恢复：断连重连后本地 run 态被清空，但内核侧 run 仍在跑。
// 断连前快照为 orphan 的 runId，其 delta（全量累计文本）应被收养续显，
// 而不是按僵尸帧丢弃。
async function testOrphanDeltaAdoptedAfterReconnect() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  markReconnectOrphanRun("run-orphan", "session-1");
  const state = makeState({ chatRunId: null, chatStream: null });

  const result = handleChatEvent(state, {
    runId: "run-orphan",
    sessionKey: "session-1",
    state: "delta",
    message: { role: "assistant", content: [{ type: "text", text: "续跑文本" }] },
  });
  raf.runAll();

  assert.equal(result, "delta");
  assert.equal(state.chatRunId, "run-orphan", "orphan delta 应被收养为当前 run");
  assert.equal(state.chatStream, "续跑文本", "收养后流式文本应续显");
  clearReconnectOrphanRun();
}

// R30：非 orphan 的外来 delta 仍按僵尸丢弃（R18 防线不回退）。
async function testNonOrphanDeltaStillDropped() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  markReconnectOrphanRun("run-orphan", "session-1");
  const state = makeState({ chatRunId: null, chatStream: null });

  const result = handleChatEvent(state, {
    runId: "run-foreign",
    sessionKey: "session-1",
    state: "delta",
    message: { role: "assistant", content: [{ type: "text", text: "foreign" }] },
  });
  raf.runAll();

  assert.equal(result, null);
  assert.equal(state.chatRunId, null, "非 orphan delta 不得收养");
  assert.equal(state.chatStream, null);
  clearReconnectOrphanRun();
}

// R30：orphan 快照过期后不再收养（run 大概率已终结/帧已永久丢失）。
async function testOrphanExpiredNotAdopted() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  markReconnectOrphanRun("run-orphan", "session-1", Date.now() - 200_000);
  const state = makeState({ chatRunId: null, chatStream: null });

  const result = handleChatEvent(state, {
    runId: "run-orphan",
    sessionKey: "session-1",
    state: "delta",
    message: { role: "assistant", content: [{ type: "text", text: "过期帧" }] },
  });
  raf.runAll();

  assert.equal(result, null, "过期 orphan 的 delta 应丢弃");
  assert.equal(state.chatRunId, null);
  assert.equal(liveOrphanRunId(), null, "过期快照应自动清除");
}

// R30：orphan 的终态帧透传（触发历史刷新）并清除快照。
async function testOrphanFinalPassesAndClearsSnapshot() {
  installBrowserGlobals(new FakeRaf());
  markReconnectOrphanRun("run-orphan", "session-1");
  const state = makeState({ chatRunId: null });

  const result = handleChatEvent(state, {
    runId: "run-orphan",
    sessionKey: "session-1",
    state: "final",
  });

  assert.equal(result, "final");
  assert.equal(liveOrphanRunId(), null, "orphan 终态后快照应清除");
}

// R30：mergeIfStale 保留本地后的退避补拉——800/1600/2400ms 依次补拉，
// 替换成功后退避链取消不再补拉。
async function testStaleRetryBackoffAndCancelOnReplace() {
  installBrowserGlobals(new FakeRaf());
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const local = [1, 2, 3, 4, 5].map((i) => ({
      role: "user",
      content: [{ type: "text", text: `m${i}` }],
    }));
    const recovered = [...local, { role: "assistant", content: [{ type: "text", text: "回复" }] }];
    let calls = 0;
    let serveShort = true;
    const client = {
      request: async (method: string) => {
        assert.equal(method, "chat.history");
        calls++;
        return { messages: serveShort ? [local[0]] : recovered };
      },
    } as any;
    const state = makeState({ client, chatMessages: [...local] });

    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
      }
    };

    await loadChatHistory(state, { mergeIfStale: true });
    assert.equal(calls, 1);
    assert.equal(state.chatMessages.length, 5, "首次短读应保留本地");

    mock.timers.tick(600);
    await flush();
    assert.equal(calls, 2, "600ms 后应补拉一次");
    assert.equal(state.chatMessages.length, 5, "仍短读仍保留");

    serveShort = true; // 保持短读，验证后续退避
    mock.timers.tick(1500);
    await flush();
    assert.equal(calls, 3, "1500ms 后应第二次补拉");

    serveShort = true;
    mock.timers.tick(3000);
    await flush();
    assert.equal(calls, 4, "3000ms 后应第三次补拉");

    serveShort = false; // 下一次补拉返回完整历史 → 替换成功 → 退避链取消
    mock.timers.tick(6000);
    await flush();
    assert.equal(calls, 5);
    assert.equal(state.chatMessages.length, 6, "完整历史应替换本地");

    mock.timers.tick(10_000);
    await flush();
    assert.equal(calls, 5, "替换成功后不得再补拉");
  } finally {
    mock.timers.reset();
    cancelStaleHistoryRetryForTests();
  }
}

// R30：补拉期间会话切走，挂起的补拉应作废（不打到新会话头上）。
async function testStaleRetryAbortedOnSessionSwitch() {
  installBrowserGlobals(new FakeRaf());
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const local = [1, 2, 3].map((i) => ({ role: "user", content: [{ type: "text", text: `m${i}` }] }));
    let calls = 0;
    const client = {
      request: async () => {
        calls++;
        return { messages: [local[0]] };
      },
    } as any;
    const state = makeState({ client, chatMessages: [...local] });

    await loadChatHistory(state, { mergeIfStale: true });
    assert.equal(calls, 1);

    state.sessionKey = "session-2";
    mock.timers.tick(600);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1, "会话切走后补拉不应发出");
  } finally {
    mock.timers.reset();
    cancelStaleHistoryRetryForTests();
  }
}

// R41：补拉预算 per-session 化——会话 A 挂起重试期间切到会话 B 触发滞后保留时，
// A 消耗过的档位不应由 B 继承，B 应从首档 600ms 重新开始（而非 1500）。
async function testStaleRetryBudgetResetsOnTargetSessionSwitch() {
  installBrowserGlobals(new FakeRaf());
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const local = [1, 2, 3].map((i) => ({ role: "user", content: [{ type: "text", text: `m${i}` }] }));
    let calls = 0;
    const client = {
      request: async () => {
        calls++;
        return { messages: [local[0]] }; // 恒短读：一直保持滞后保留路径
      },
    } as any;
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
      }
    };

    // 1) 会话 A 触发滞后保留 → 800ms 后补拉仍滞后 → attempt 消耗到 1（挂起 1600 档）
    const stateA = makeState({ client, sessionKey: "session-A", chatMessages: [...local] });
    await loadChatHistory(stateA, { mergeIfStale: true });
    assert.equal(calls, 1);
    mock.timers.tick(600);
    await flush();
    assert.equal(calls, 2, "A 的 800ms 补拉应发出");

    // 2) 切到会话 B 触发 B 的滞后保留（目标会话切换应复位预算）
    const stateB = makeState({ client, sessionKey: "session-B", chatMessages: [...local] });
    await loadChatHistory(stateB, { mergeIfStale: true });
    assert.equal(calls, 3);

    // 3) B 的补拉应仍是首档 800ms；若继承 A 的计数，800ms 内不会有补拉（排成 1600）
    mock.timers.tick(600);
    await flush();
    assert.equal(calls, 4, "切到 B 后补拉预算应复位，800ms 首档即补拉");
  } finally {
    mock.timers.reset();
    cancelStaleHistoryRetryForTests();
  }
}

// R41：预算耗尽（800/1600/2400 全走完仍滞后）后是静默终点且永不复位，
// 切到新会话应重新获得满额预算，否则任何会话的滞后读都不再补拉。
async function testStaleRetryBudgetExhaustedRecoversOnSessionSwitch() {
  installBrowserGlobals(new FakeRaf());
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const local = [1, 2, 3].map((i) => ({ role: "user", content: [{ type: "text", text: `m${i}` }] }));
    let calls = 0;
    const client = {
      request: async () => {
        calls++;
        return { messages: [local[0]] };
      },
    } as any;
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
      }
    };

    // 1) A 上连续 4 次滞后保留耗尽预算：首读 + 600/1500/3000/6000 四档补拉全短读 → 共 5 次调用
    const stateA = makeState({ client, sessionKey: "session-A", chatMessages: [...local] });
    await loadChatHistory(stateA, { mergeIfStale: true });
    assert.equal(calls, 1);
    mock.timers.tick(600);
    await flush();
    assert.equal(calls, 2);
    mock.timers.tick(1500);
    await flush();
    assert.equal(calls, 3);
    mock.timers.tick(3000);
    await flush();
    assert.equal(calls, 4);
    mock.timers.tick(6000);
    await flush();
    assert.equal(calls, 5, "预算耗尽前共应补拉 4 次");
    mock.timers.tick(10_000);
    await flush();
    assert.equal(calls, 5, "A 预算耗尽后不得再补拉");

    // 2) 切到 B 触发滞后保留：不得继承 A 的耗尽态静默放弃，600ms 后应补拉
    const stateB = makeState({ client, sessionKey: "session-B", chatMessages: [...local] });
    await loadChatHistory(stateB, { mergeIfStale: true });
    assert.equal(calls, 6);
    mock.timers.tick(600);
    await flush();
    assert.equal(calls, 7, "预算耗尽后切会话应重新补拉，而非静默放弃");
  } finally {
    mock.timers.reset();
    cancelStaleHistoryRetryForTests();
  }
}

// 发送失败（非 preserveRunState）：乐观 user 气泡打 cryoclawSendFailed 标记 + 注入错误卡，
// 供 onResendError 重发时一并移除（防重发后新旧两条 user 气泡并存）。
async function testSendFailureMarksLocalEchoForResend() {
  installBrowserGlobals(new FakeRaf());
  const state = makeState({
    chatRunId: null,
    chatStream: null,
    client: {
      request: async (method: string) => {
        assert.equal(method, "chat.send");
        throw new Error("network down");
      },
    },
  });

  const result = await sendChatMessage(state, "hello");
  assert.equal(result, null, "失败的发送应返回 null");
  assert.equal(state.chatMessages.length, 2, "应保留 user 气泡 + 错误卡");
  const echo = state.chatMessages[0] as Record<string, unknown>;
  assert.equal(echo.role, "user");
  assert.equal(echo.cryoclawSendFailed, true, "未落盘的乐观气泡应打标记供重发识别");
  const card = state.chatMessages[1] as Record<string, unknown>;
  assert.equal(card.cryoclawError, true);
  assert.equal(card.resendText, "hello");
}

// 队列「立即发送」（preserveRunState）失败：不向消息流注入气泡/错误卡（条目由
// sendQueuedMessageNow 放回队列兜底，双份呈现回归），撤掉乐观气泡，错误走 lastError。
async function testPreserveRunStateFailureDoesNotInject() {
  installBrowserGlobals(new FakeRaf());
  const existing = [{ role: "user", content: [{ type: "text", text: "m1" }] }];
  const state = makeState({
    chatMessages: [...existing],
    chatVisibleMessageCount: 1,
    client: {
      request: async (method: string) => {
        assert.equal(method, "chat.send");
        throw new Error("network down");
      },
    },
  });

  const result = await sendChatMessage(state, "followup", undefined, undefined, {
    preserveRunState: true,
  });
  assert.equal(result, null);
  assert.equal(state.chatMessages.length, 1, "失败不得注入新气泡/错误卡（队列条目兜底）");
  assert.equal((state.chatMessages[0] as Record<string, unknown>).role, "user");
  assert.equal(state.lastError, "Error: network down", "错误应走 lastError 顶部提示");
  assert.equal(state.chatRunId, "run-1", "preserveRunState 失败不得清本轮 run 态");
}

// ── P2 已发送文件附件卡片化：发送序列化行为 ──

function stubReadFileBase64(impl: (path: string) => Promise<unknown>) {
  (globalThis as any).document = { querySelector: () => null };
  (globalThis.window as any).cryoclaw = { readFileBase64: impl };
}

// 文件附件成功编码：走 apiAttachments type:"file"，不再拼文本前缀；
// 乐观气泡挂 MediaPaths/MediaTypes（与 history 同构）。
async function testSendFileAttachmentGoesBase64AndEchoHasMediaPaths() {
  installBrowserGlobals(new FakeRaf());
  stubReadFileBase64(async () => ({ base64: "aGVsbG8=", size: 5, mimeType: "text/plain" }));
  const requests: Array<Record<string, unknown>> = [];
  const state = makeState({
    chatRunId: null,
    chatStream: null,
    client: {
      request: async (method: string, params: Record<string, unknown>) => {
        assert.equal(method, "chat.send");
        requests.push(params);
        return {};
      },
    },
  });

  const result = await sendChatMessage(state, "看下这个文件", [
    { id: "att-1", filePath: "C:\\docs\\notes.txt", name: "notes.txt" },
  ] as never);
  assert.ok(result, "发送应成功返回 runId");
  const payload = requests[0];
  assert.equal(payload.message, "看下这个文件", "成功编码的文件不再拼路径文本前缀");
  assert.deepEqual(payload.attachments, [
    { type: "file", mimeType: "text/plain", fileName: "notes.txt", content: "aGVsbG8=" },
  ]);
  const echo = state.chatMessages[0] as Record<string, unknown>;
  assert.deepEqual(echo.MediaPaths, ["C:\\docs\\notes.txt"], "乐观气泡应挂 MediaPaths");
  assert.deepEqual(echo.MediaTypes, ["text/plain"], "乐观气泡应挂平行 MediaTypes");
}

// 超过大小上限（too-large 结构化返回）：降级为旧版文本前缀，不阻断发送。
async function testOversizedFileFallsBackToTextPrefix() {
  installBrowserGlobals(new FakeRaf());
  stubReadFileBase64(async () => ({ error: "too-large", size: 99_999_999 }));
  const requests: Array<Record<string, unknown>> = [];
  const state = makeState({
    client: {
      request: async (_method: string, params: Record<string, unknown>) => {
        requests.push(params);
        return {};
      },
    },
  });

  const result = await sendChatMessage(state, "big", [
    { id: "a1", filePath: "/tmp/big.bin", name: "big.bin" },
  ] as never);
  assert.ok(result);
  const payload = requests[0];
  assert.equal(payload.message, "/tmp/big.bin\n\nbig", "超限文件应降级为路径文本前缀");
  assert.equal(payload.attachments, undefined, "降级后不再有 apiAttachments");
  const echo = state.chatMessages[0] as Record<string, unknown>;
  assert.equal(echo.MediaPaths, undefined, "降级文件不进 MediaPaths（文本前缀已呈现，避免双重呈现）");
  assert.equal(echo.MediaTypes, undefined, "降级文件不进 MediaTypes");
}

// 发送失败：错误卡带 resendAttachments（重发不丢附件）。
async function testSendFailureKeepsResendAttachments() {
  installBrowserGlobals(new FakeRaf());
  stubReadFileBase64(async () => ({ base64: "eA==", size: 1, mimeType: "text/plain" }));
  const state = makeState({
    chatRunId: null,
    chatStream: null,
    client: {
      request: async () => {
        throw new Error("network down");
      },
    },
  });

  const result = await sendChatMessage(state, "hi", [
    { id: "a1", filePath: "/tmp/n.txt", name: "n.txt" },
  ] as never);
  assert.equal(result, null);
  const card = state.chatMessages[1] as Record<string, unknown>;
  assert.equal(card.cryoclawError, true);
  const ra = card.resendAttachments as Array<Record<string, unknown>>;
  assert.equal(ra.length, 1, "错误卡应保存可重发附件");
  assert.equal(ra[0].filePath, "/tmp/n.txt");
}

// 累计帧预算：首个大文件编码成功后，累计 base64 将超 ~23MB 的后续文件自动降级
// 文本前缀（内核 WS 单帧上限 25MB，多附件一起发必然失败、重发死循环）。
async function testCumulativeFrameBudgetDegradesLaterFiles() {
  installBrowserGlobals(new FakeRaf());
  const bigBase64 = "a".repeat(20_000_000);
  stubReadFileBase64(async (path: string) =>
    path.includes("big")
      ? { base64: bigBase64, size: 15_000_000, mimeType: "application/octet-stream" }
      : { base64: "b".repeat(5_000_000), size: 3_750_000, mimeType: "text/plain" },
  );
  const requests: Array<Record<string, unknown>> = [];
  const state = makeState({
    client: {
      request: async (_method: string, params: Record<string, unknown>) => {
        requests.push(params);
        return {};
      },
    },
  });

  const result = await sendChatMessage(state, "two files", [
    { id: "a1", filePath: "/tmp/big.bin", name: "big.bin" },
    { id: "a2", filePath: "/tmp/small.txt", name: "small.txt" },
  ] as never);
  assert.ok(result);
  const payload = requests[0];
  const atts = payload.attachments as Array<Record<string, unknown>>;
  assert.equal(atts.length, 1, "只有首个文件进 apiAttachments");
  assert.equal(atts[0].fileName, "big.bin");
  assert.equal(
    payload.message,
    "/tmp/small.txt\n\ntwo files",
    "累计预算超限的后续文件应降级文本前缀",
  );
  const echo = state.chatMessages[0] as Record<string, unknown>;
  assert.deepEqual(echo.MediaPaths, ["/tmp/big.bin"], "乐观气泡 MediaPaths 只含成功编码的文件");
  assert.deepEqual(echo.MediaTypes, ["application/octet-stream"], "降级文件不占 MediaTypes 槽位");
}

// R41 Task 2：同会话终态刷新（mergeIfStale）保留现有可见数，不重走渐进注水——
// 否则 60 条会话每轮终态都先缩回 20 条再逐批补回（闪烁 + 上方插入滚动位移）。
async function testMergeIfStaleKeepsVisibleCountWithoutHydration() {
  installBrowserGlobals(new FakeRaf());
  const local = Array.from({ length: 50 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `m${index}` }],
    timestamp: index,
  }));
  const remote = [
    ...local,
    { role: "user", content: [{ type: "text", text: "m50" }] },
    { role: "assistant", content: [{ type: "text", text: "m51" }] },
  ];
  const state = makeState({
    client: makeHistoryClient(remote),
    chatMessages: [...local],
    chatVisibleMessageCount: 50,
  });

  const hydrationTimers: Array<() => void> = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => {
    hydrationTimers.push(fn);
    return hydrationTimers.length;
  }) as typeof setTimeout;

  try {
    await loadChatHistory(state, { mergeIfStale: true });

    assert.equal(state.chatMessages.length, 52, "合法变长的替换应落地");
    assert.equal(state.chatVisibleMessageCount, 52, "终态刷新应保留可见数并展开新增消息");
    assert.equal(state.chatHistoryHydrationFrame, null, "不得挂渐进注水（避免缩回再补回）");
    assert.equal(hydrationTimers.length, 0, "不得调度注水定时器");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

// R41 Task 2：替换语义（无 mergeIfStale，切会话/重置/首次加载）仍走 20 条渐进注水。
async function testReplaceWithoutMergeStillHydratesFromTwenty() {
  installBrowserGlobals(new FakeRaf());
  const messages = Array.from({ length: 50 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `m${index}` }],
    timestamp: index,
  }));
  const state = makeState({
    client: makeHistoryClient(messages),
    chatVisibleMessageCount: 50,
  });

  const hydrationTimers: Array<() => void> = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => {
    hydrationTimers.push(fn);
    return hydrationTimers.length;
  }) as typeof setTimeout;

  try {
    await loadChatHistory(state);

    assert.equal(state.chatMessages.length, 50);
    assert.equal(state.chatVisibleMessageCount, 20, "替换语义首帧仍只暴露 20 条");
    assert.ok(hydrationTimers.length > 0, "替换语义应挂渐进注水");
    while (hydrationTimers.length > 0) {
      const timer = hydrationTimers.shift();
      if (timer) timer();
    }
    assert.equal(state.chatVisibleMessageCount, 50, "注水结束后应补齐全部历史");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

// R41 Task 2（边界）：先前只露出部分消息（可见数 < 本地消息数）时不得强行保持——
// 说明注水尚未完成/视图未展开，终态刷新应回归渐进注水路径（从 20 条起）。
async function testMergeIfStaleFallsBackToHydrationWhenPartiallyVisible() {
  installBrowserGlobals(new FakeRaf());
  const local = Array.from({ length: 50 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `m${index}` }],
    timestamp: index,
  }));
  const remote = [
    ...local,
    { role: "user", content: [{ type: "text", text: "m50" }] },
    { role: "assistant", content: [{ type: "text", text: "m51" }] },
  ];
  const state = makeState({
    client: makeHistoryClient(remote),
    chatMessages: [...local],
    chatVisibleMessageCount: 30,
  });

  const hydrationTimers: Array<() => void> = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => {
    hydrationTimers.push(fn);
    return hydrationTimers.length;
  }) as typeof setTimeout;

  try {
    await loadChatHistory(state, { mergeIfStale: true });

    assert.equal(state.chatVisibleMessageCount, 20, "部分可见时应回到 20 条起步");
    assert.ok(hydrationTimers.length > 0, "部分可见时应挂渐进注水");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

// R41 Task 4：看门狗/重连探测属于静默对齐，不能置 chatLoading——否则视图层每 30s
// 在消息线程顶部闪一次「加载中」。silent 路径全程（含 await 期间）不置位；
// 对照：不带 silent 的常规加载仍会置 true 再回 false。
async function testSilentProbeDoesNotToggleChatLoading() {
  installBrowserGlobals(new FakeRaf());
  const messages = [
    { role: "user", content: [{ type: "text", text: "m1" }] },
    { role: "assistant", content: [{ type: "text", text: "m2" }] },
  ];
  let requestSawLoadingFalse = false;
  const state = makeState({
    client: {
      request: async (method: string) => {
        assert.equal(method, "chat.history");
        // await 期间的同步可观测时刻：silent 下 chatLoading 必须仍为 false，
        // 一旦置 true，视图层此刻就会渲染「加载中」
        assert.equal(state.chatLoading, false, "silent 探测在请求期间不得置 chatLoading");
        requestSawLoadingFalse = true;
        return { messages };
      },
    },
  });

  assert.equal(state.chatLoading, false, "调用前应为 false");
  await loadChatHistory(state, { mergeIfStale: true, silent: true });
  assert.ok(requestSawLoadingFalse, "请求应实际发出");
  assert.equal(state.chatLoading, false, "silent 探测返回后仍不得置位");
  assert.equal(state.chatMessages.length, 2, "silent 只影响加载态，历史对齐照常落地");

  // 对照：不带 silent 的常规加载仍会置 true（请求期间可观测）再回 false。
  let normalSawLoadingTrue = false;
  const state2 = makeState({
    client: {
      request: async () => {
        assert.equal(state2.chatLoading, true, "非 silent 加载应在请求期间置 true");
        normalSawLoadingTrue = true;
        return { messages };
      },
    },
  });
  await loadChatHistory(state2);
  assert.ok(normalSawLoadingTrue, "对照请求应实际发出");
  assert.equal(state2.chatLoading, false, "非 silent 加载完成后应回 false");
}

async function testTerminalErrorPreservesVisiblePartialText() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState();

  handleChatEvent(state, {
    runId: "run-1",
    sessionKey: "session-1",
    state: "delta",
    deltaText: "partial answer",
  });
  // The error arrives before the scheduled RAF callback executes.
  handleChatEvent(state, {
    runId: "run-1",
    sessionKey: "session-1",
    state: "error",
    errorMessage: "provider failed",
  });

  assert.equal(state.chatStream, null, "terminal should clear the live bubble");
  assert.equal(state.chatPendingStreamText, null, "terminal should clear pending state");
  assert.equal(state.chatMessages.length, 2, "partial text and error should both remain visible");
  assert.equal(
    (state.chatMessages[0] as any).content[0].text,
    "partial answer",
    "the pending delta must be committed before error reset",
  );
  assert.equal((state.chatMessages[1] as any).cryoclawError, true);
}

async function testOrphanRunsAreSessionScoped() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  markReconnectOrphanRun("run-a", "session-a", 1000);
  const state = makeState({ sessionKey: "session-b", chatRunId: null, chatStream: null });

  const result = handleChatEvent(state, {
    runId: "run-a",
    sessionKey: "session-b",
    state: "delta",
    deltaText: "must not be adopted",
  });
  raf.runAll();

  assert.equal(result, null, "an orphan from another session must be ignored");
  assert.equal(state.chatRunId, null);
  assert.equal(state.chatStream, null);
  clearReconnectOrphanRun();
}

// R59：内核 chat.history 响应的 inFlightRun 快照收养（会话切换回来/窗口刷新/重连后
// 本地 run 态已被清空，内核侧 run 仍在跑的场景）。
async function testInFlightRunAdoptedOnFreshLoad() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState({
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    chatLastActivityAt: null,
    client: {
      request: async () => ({
        messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
        inFlightRun: { runId: "run-ghost", text: "partial answer", startedAt: 12345 },
      }),
    },
  });

  await loadChatHistory(state);

  assert.equal(state.chatRunId, "run-ghost", "在途 run 应被收养为当前 run");
  assert.equal(state.chatStream, "partial answer", "快照全量文本应重建流式气泡");
  assert.equal(state.chatStreamStartedAt, 12345, "startedAt 应采用内核 run 起始时间");
  assert.equal(state.chatStreamFrozenPrefix, "", "收养后 frozenPrefix 必须清零");
  assert.ok(state.chatLastActivityAt != null, "收养应刷新流式活动锚点（看门狗用）");

  // 收养后同 runId 的 delta 应被接受续显（不再按别家 run 丢弃）
  const result = handleChatEvent(state, {
    runId: "run-ghost",
    sessionKey: "session-1",
    state: "delta",
    deltaText: "!",
    message: { role: "assistant", content: [{ type: "text", text: "partial answer!" }] },
  });
  raf.runAll();
  assert.equal(result, "delta", "同 runId delta 不应被僵尸帧过滤丢弃");
  assert.equal(state.chatStream, "partial answer!", "delta 应在快照文本基础上续写");
}

async function testInFlightRunEmptyTextAdoptedAsActivityIndicator() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState({
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    client: {
      request: async () => ({
        messages: [],
        inFlightRun: { runId: "run-quiet", text: "" },
      }),
    },
  });

  await loadChatHistory(state);

  assert.equal(state.chatRunId, "run-quiet", "空文本 run 也应收养（busy/Stop 语义）");
  assert.equal(state.chatStream, "", "空文本流 → 流式气泡降级为思考/阶段指示");
}

async function testInFlightRunNotAdoptedWhenLocalRunActive() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState({
    chatRunId: "run-local",
    chatStream: "local stream",
    chatStreamStartedAt: 777,
    client: {
      request: async () => ({
        messages: [],
        inFlightRun: { runId: "run-other", text: "other text", startedAt: 999 },
      }),
    },
  });

  await loadChatHistory(state);

  assert.equal(state.chatRunId, "run-local", "本地活跃 run 不被快照覆盖");
  assert.equal(state.chatStream, "local stream", "本轮流式文本保持原样");
  assert.equal(state.chatStreamStartedAt, 777, "startedAt 保持本轮流起始");
}

async function testInFlightRunAdoptedEvenOnStaleReadRetention() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  // 滞后读保留分支：raw 比本地短 → 保留本地消息列表；inFlightRun 仍应生效（重连路径）
  const localMessages = [
    { role: "user", content: [{ type: "text", text: "m1" }] },
    { role: "assistant", content: [{ type: "text", text: "m2" }] },
  ];
  const state = makeState({
    chatRunId: null,
    chatStream: null,
    chatMessages: localMessages,
    chatVisibleMessageCount: 2,
    client: {
      request: async () => ({
        messages: [localMessages[0]],
        inFlightRun: { runId: "run-late", text: "streaming", startedAt: 42 },
      }),
    },
  });

  await loadChatHistory(state, { mergeIfStale: true });

  assert.equal(state.chatMessages.length, 2, "滞后读应保留本地消息列表");
  assert.equal(state.chatRunId, "run-late", "滞后读保留分支下快照收养仍应生效");
  assert.equal(state.chatStream, "streaming");
}

async function testInFlightRunAbsentKeepsClearedState() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState({
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    client: {
      request: async () => ({
        messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
      }),
    },
  });

  await loadChatHistory(state);

  assert.equal(state.chatRunId, null, "无在途 run（快照缺省）时不得伪造 run 态");
  assert.equal(state.chatStream, null, "无在途 run 时流式态保持空");
}

// R4：answer_candidate narration 上屏后，同文本经 chat delta 进入正文流时，
// narration 必须清掉——否则 narration 气泡与正文气泡同文双份。
async function testBodyDeltaClearsNarration() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState({
    chatNarrationText: "解说文本",
    chatPendingNarrationText: null,
  });

  handleChatEvent(state, {
    runId: "run-1",
    sessionKey: "session-1",
    state: "delta",
    message: { role: "assistant", content: [{ type: "text", text: "解说文本正文" }] },
  });
  raf.runAll();

  assert.equal(state.chatStream, "解说文本正文");
  assert.equal(state.chatNarrationText, null, "正文 delta 非空上屏后 narration 应清除");
  assert.equal(state.chatPendingNarrationText, null);
}

// R4：正文为空（空白 delta）时不得误清 narration。
async function testEmptyBodyDeltaKeepsNarration() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState({
    chatStream: "",
    chatNarrationText: "解说文本",
  });

  handleChatEvent(state, {
    runId: "run-1",
    sessionKey: "session-1",
    state: "delta",
    message: { role: "assistant", content: [{ type: "text", text: "" }] },
  });
  raf.runAll();

  assert.equal(state.chatNarrationText, "解说文本", "空白正文 delta 不应清 narration");
}

// R3：replace 帧越过 tool 边界整体重生成（全文不再以 frozenPrefix 开头）→
// 调用作废钩子并清空 frozenPrefix，被重写的 leadingSegment 由消费端清掉。
async function testReplaceBeyondFrozenPrefixInvalidatesFrozenSegments() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  let hookCalls = 0;
  const state = makeState({
    chatStream: "trail",
    chatStreamFrozenPrefix: "before tool",
    chatStreamMismatchCount: 2,
    onReplaceBeyondFrozenPrefix: () => {
      hookCalls++;
    },
  });

  handleChatEvent(state, {
    runId: "run-1",
    sessionKey: "session-1",
    state: "delta",
    replace: true,
    deltaText: "regenerated from scratch",
  });
  raf.runAll();

  assert.equal(state.chatStream, "regenerated from scratch", "replace 帧整段采用新文本");
  assert.equal(hookCalls, 1, "应触发 onReplaceBeyondFrozenPrefix 作废被重写的冻结段");
  assert.equal(state.chatStreamFrozenPrefix, "", "frozenPrefix 不再适用于新累计文本，必须清空");
  assert.equal(state.chatStreamMismatchCount, 0, "replace 帧后交叉校验计数应清零");
}

// R5（Bug1-D）：连续失配第 3 帧的强制 resync 有前向条件——快照必须是 base
// （frozenPrefix+current）的前向延伸。滞后/分叉快照不再触发 resync（防文本回退
// 双份闪现），继续保守追加、计数累计；随后到来的前向延伸快照由 R88 self-heal 收敛。
async function testMismatchResyncAfterThreeFailures() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState({ chatStream: "corrupted", chatStreamFrozenPrefix: "pre" });
  const frame = (text: string, deltaText: string) => {
    handleChatEvent(state, {
      runId: "run-1",
      sessionKey: "session-1",
      state: "delta",
      deltaText,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  };

  // fullText "kernel truth 1" 与 base("pre"+"corrupted") 对不上、也不是其前向延伸
  // → 保守追加，计数 1
  frame("kernel truth 1", " x");
  assert.equal(state.chatPendingStreamText, "corrupted x");
  assert.equal(state.chatStreamMismatchCount, 1);
  // 第 2 帧：仍对不上 → 保守追加，计数 2
  state.chatStream = state.chatPendingStreamText!;
  state.chatPendingStreamText = null;
  frame("kernel truth 2", " y");
  assert.equal(state.chatPendingStreamText, "corrupted x y");
  assert.equal(state.chatStreamMismatchCount, 2);
  // 第 3 帧：达到阈值但快照不是前向延伸 → 不回跳（旧行为会 resync 成 "kernel truth 3"）
  state.chatStream = state.chatPendingStreamText!;
  state.chatPendingStreamText = null;
  frame("kernel truth 3", " z");
  assert.equal(state.chatPendingStreamText, "corrupted x y z", "非前向快照不得强制 resync 回退文本");
  assert.equal(state.chatStreamMismatchCount, 3, "前向条件不满足：计数继续累计");
  // 随后前向延伸快照（base 之后丢了 " gap" 一段）到达 → self-heal 立即收敛
  state.chatStream = state.chatPendingStreamText!;
  state.chatPendingStreamText = null;
  frame("precorrupted x y z gap!", "!");
  assert.equal(state.chatPendingStreamText, "corrupted x y z gap!");
  assert.equal(state.chatStreamMismatchCount, 0, "self-heal 后计数清零");
}

// R6：orphan 收养必须显式清空上一 run 的流式残留，否则与收养后文本叠加成双份。
async function testOrphanAdoptionClearsStreamResidue() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  markReconnectOrphanRun("run-orphan", "session-1");
  const state = makeState({
    chatRunId: null,
    // 模拟清态遗漏路径下的脏残留（正常 onHello 清态后这些字段应为空）
    chatStream: "old run residue",
    chatPendingStreamText: "old pending residue",
    chatStreamFrozenPrefix: "old prefix",
    chatNarrationText: "old narration",
  });

  handleChatEvent(state, {
    runId: "run-orphan",
    sessionKey: "session-1",
    state: "delta",
    message: { role: "assistant", content: [{ type: "text", text: "新文本" }] },
  });
  raf.runAll();

  assert.equal(state.chatRunId, "run-orphan");
  assert.equal(state.chatStream, "新文本", "收养后 chatStream 应以本帧为基，不得叠加旧残留");
  assert.equal(state.chatPendingStreamText, null);
  assert.equal(state.chatStreamFrozenPrefix, "");
  assert.equal(state.chatNarrationText, null);
  clearReconnectOrphanRun();
}

// R6：历史（本次拉取）已含本 run 回复（终态帧丢失但已持久化）→ 不收养 inFlightRun，
// 否则快照累计文本与历史回复双份。
async function testInFlightRunNotAdoptedWhenReplyInFreshHistory() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState({
    chatRunId: null,
    chatStream: null,
    client: {
      request: async () => ({
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "已完成回复" }],
            runId: "run-done",
            timestamp: Date.now(),
          },
        ],
        inFlightRun: { runId: "run-done", text: "已完成回复", startedAt: Date.now() - 1000 },
      }),
    },
  });

  await loadChatHistory(state);

  assert.equal(state.chatRunId, null, "历史已含本 run 回复时不得收养 inFlightRun");
  assert.equal(state.chatStream, null, "收养被拒时不应重建流式气泡");
}

// R6：本地旧列表已含本 run 回复（runId 精确匹配）同样拒绝收养。
async function testInFlightRunNotAdoptedWhenReplyInLocalHistory() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState({
    chatRunId: null,
    chatStream: null,
    chatMessages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "早前已落盘" }],
        runId: "run-done",
        timestamp: Date.now(),
      },
    ],
    client: {
      request: async () => ({
        messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
        inFlightRun: { runId: "run-done", text: "早前已落盘", startedAt: Date.now() - 1000 },
      }),
    },
  });

  await loadChatHistory(state);

  assert.equal(state.chatRunId, null, "本地历史已含本 run 回复时不得收养 inFlightRun");
}

// 回归：run 中途内核会落盘中间产物（progressive persist/子代理公告），时间戳上与终态
// 回复不可区分。快照带内核 startedAt 时不得再走时间戳兜底拒收——否则切会话回来收养
// 被误拒，后续 delta 被僵尸过滤丢弃，流式永久中断（线上实测回归）。
async function testMidRunPersistedReplyDoesNotBlockAdoption() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const now = Date.now();
  const state = makeState({
    chatRunId: null,
    chatStream: null,
    client: {
      request: async () => ({
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }], timestamp: now - 500 },
          // 中途落盘：时间戳在 run 开始后，但无 runId、无 stopReason（非终态条目）
          { role: "assistant", content: [{ type: "text", text: "中途产物" }], timestamp: now - 100 },
        ],
        inFlightRun: { runId: "run-live", text: "中途产物", startedAt: now - 600 },
      }),
    },
  });

  await loadChatHistory(state);

  assert.equal(
    state.chatRunId,
    "run-live",
    "有内核 startedAt 时中途落盘产物不得拒收养（回归：切会话回来流式断掉）",
  );
  assert.equal(state.chatStream, "中途产物", "收养后流式文本应接续快照累计文本");
}

// 对照组：命中带 stopReason 的终态条目仍拒绝收养（内核终态已落盘，防双份）。
async function testTerminalStopReasonStillBlocksAdoption() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const now = Date.now();
  const state = makeState({
    chatRunId: null,
    chatStream: null,
    client: {
      request: async () => ({
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }], timestamp: now - 500 },
          {
            role: "assistant",
            content: [{ type: "text", text: "终态回复" }],
            timestamp: now - 100,
            stopReason: "stop",
          },
        ],
        inFlightRun: { runId: "run-done-2", text: "终态回复", startedAt: now - 600 },
      }),
    },
  });

  await loadChatHistory(state);

  assert.equal(state.chatRunId, null, "命中带 stopReason 的终态回复应拒绝收养");
  assert.equal(state.chatStream, null, "收养被拒时不应重建流式气泡");
}

// 快照缺 startedAt 时保留时间戳兜底（无法区分中途产物，旧行为不回退）。
async function testNoStartedAtKeepsTimestampFallback() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const now = Date.now();
  const state = makeState({
    chatRunId: null,
    chatStream: null,
    client: {
      request: async () => ({
        messages: [
          { role: "assistant", content: [{ type: "text", text: "刚落盘" }], timestamp: now - 100 },
        ],
        inFlightRun: { runId: "run-x", text: "刚落盘" },
      }),
    },
  });

  await loadChatHistory(state);

  assert.equal(state.chatRunId, null, "缺 startedAt 时时间戳兜底仍应拒收养（旧行为保留）");
}

// orphan 快照被 status 事件误清：内核 run 启动阶段广播 state:"status"
// （preparing_workspace 等 7 phase）。status 帧不是终态，不得清除 orphan 快照——
// 误清后同 runId 的后续 delta 会被僵尸过滤丢弃，重连恢复链路断裂。
async function testOrphanStatusFrameDoesNotClearSnapshot() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  markReconnectOrphanRun("run-orphan", "session-1");
  const state = makeState({ chatRunId: null, chatStream: null });

  const statusResult = handleChatEvent(state, {
    runId: "run-orphan",
    sessionKey: "session-1",
    state: "status",
  });

  assert.equal(statusResult, "status", "status 帧透传（无消费方，不影响调用方）");
  assert.equal(
    liveOrphanRunId("session-1"),
    "run-orphan",
    "status 帧不得清除 orphan 快照（否则后续 delta 被僵尸过滤丢弃）",
  );
  assert.equal(state.chatRunId, null, "status 帧不得触碰本地 run 态");

  // 快照仍在：后续 delta 应照常收养（回归点：误清后这里会被丢弃）
  const deltaResult = handleChatEvent(state, {
    runId: "run-orphan",
    sessionKey: "session-1",
    state: "delta",
    message: { role: "assistant", content: [{ type: "text", text: "续跑文本" }] },
  });
  raf.runAll();
  assert.equal(deltaResult, "delta");
  assert.equal(state.chatRunId, "run-orphan", "status 帧之后 delta 仍应被收养续显");
  clearReconnectOrphanRun();
}

// aborted 与 error 同一 partial 保留逻辑：中止前已上屏的末段文本不得随 reset 丢弃
// （内核 abort 时同样可能截断持久化）。注意只保留 partial、不注入错误卡。
async function testAbortedPreservesVisiblePartialText() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const state = makeState();

  handleChatEvent(state, {
    runId: "run-1",
    sessionKey: "session-1",
    state: "delta",
    deltaText: "partial answer",
  });
  // aborted 与 error 同帧竞速：pending RAF 未执行即到达终态
  handleChatEvent(state, {
    runId: "run-1",
    sessionKey: "session-1",
    state: "aborted",
  });

  assert.equal(state.chatStream, null, "terminal should clear the live bubble");
  assert.equal(state.chatPendingStreamText, null, "terminal should clear pending state");
  assert.equal(state.chatMessages.length, 1, "aborted 只保留 partial 一条，无错误卡");
  const partial = state.chatMessages[0] as any;
  assert.equal(partial.cryoclawPartial, true);
  assert.equal(partial.content[0].text, "partial answer");
  assert.notEqual(partial.cryoclawError, true, "aborted 不注入错误卡（语义是主动中止）");
}

// 并发非 silent 加载：代际令牌——后发起者使先前加载失效。先前加载完成时
// 不得清 loading（最新一代仍在飞）、不得写回快照（防旧响应后至覆盖新响应）。
async function testConcurrentLoadsLatestGenerationWins() {
  installBrowserGlobals(new FakeRaf());
  const { client, resolvers } = makeDeferredHistoryClient();
  const state = makeState({ client });

  const pA = loadChatHistory(state);
  const pB = loadChatHistory(state);
  assert.equal(resolvers.length, 2, "两个并发加载都应发出请求");
  assert.equal(state.chatLoading, true, "并发加载期间 loading 应置位");

  // 最新一代（B）先返回
  resolvers[1]!({
    messages: [{ role: "assistant", content: [{ type: "text", text: "B-reply" }], timestamp: 2 }],
  });
  await pB;
  assert.equal(
    (state.chatMessages[0] as any).content[0].text,
    "B-reply",
    "最新一代的响应应写回快照",
  );
  assert.equal(state.chatLoading, false, "最新一代完成时应清加载态");

  // 旧代（A）后返回：整体失效——不写回、不清位
  resolvers[0]!({
    messages: [{ role: "assistant", content: [{ type: "text", text: "A-reply" }], timestamp: 1 }],
  });
  await pA;
  assert.equal(
    (state.chatMessages[0] as any).content[0].text,
    "B-reply",
    "旧代加载后至不得覆盖新快照（last-write-wins 倒置）",
  );
  assert.equal(state.chatMessages.length, 1);
  assert.equal(state.chatLoading, false, "旧代加载的 finally 不得再动加载态");
}

// R5：chatStreamMismatchCount 随用户发起的新 run 清零（此前只有终态清零，
// 上一 run 累计的计数会继承进新 run，过早触发强制 resync）。
async function testNewRunResetsMismatchCount() {
  installBrowserGlobals(new FakeRaf());
  const state = makeState({
    chatRunId: null,
    chatStream: null,
    chatStreamMismatchCount: 7,
    client: { request: async () => ({}) },
  });

  await sendChatMessage(state, "hi");

  assert.ok(state.chatRunId, "新 run 应建立");
  assert.equal(state.chatStreamMismatchCount, 0, "新 run 应清零交叉校验计数");
}

// ── Bug1-A：在途 run 的历史替换剔除与流同文/同前缀的尾部 assistant 条目 ──

function testStripInFlightStreamDuplicatesPure() {
  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
  // 同文与前缀剔除（尾部连续命中，更早的无关条目保留）
  let out = stripInFlightStreamDuplicates(
    [assistant("无关的旧回复"), assistant("abc")],
    "run-1", "run-1", "", "abcdef",
  );
  assert.equal(out.length, 1, "前缀命中的尾部产物应被剔除");
  out = stripInFlightStreamDuplicates(
    [assistant("abcdef"), assistant("abcdef")],
    "run-1", "run-1", "ab", "cdef",
  );
  assert.equal(out.length, 0, "同文（含 frozenPrefix 拼接后）应被剔除");
  // 反向不动：持久化比流更长（内核已领先），剔除会丢可见文本
  out = stripInFlightStreamDuplicates(
    [assistant("abcdefZZZ")],
    "run-1", "run-1", "", "abcdef",
  );
  assert.equal(out.length, 1, "比流更长的条目不得剔除");
  // 非尾部/非 assistant/空文本不剔
  out = stripInFlightStreamDuplicates(
    [assistant("abc"), { role: "user", content: [{ type: "text", text: "u" }] }],
    "run-1", "run-1", "", "abcdef",
  );
  assert.equal(out.length, 2, "尾部是 user 消息时不得继续向前剔");
  out = stripInFlightStreamDuplicates(
    [assistant("abc"), assistant("")],
    "run-1", "run-1", "", "abcdef",
  );
  assert.equal(out.length, 2, "空文本 assistant 条目应中断剔除（保守）");
  // 收养条件不满足时整体 no-op
  out = stripInFlightStreamDuplicates(
    [assistant("abc")],
    "run-other", "run-1", "", "abcdef",
  );
  assert.equal(out.length, 1, "inFlightRun 声明的不是本地活跃 run 时不得剔除");
  out = stripInFlightStreamDuplicates(
    [assistant("abc")],
    "run-1", null, "", "abcdef",
  );
  assert.equal(out.length, 1, "无本地活跃 run（终态后）时不得剔除");
}

// Bug1-A 集成：run 在途期间静默历史拉取把 progressive persist 中途产物替换进
// chatMessages；thinkingStream 全程非 null 使渲染层同文抑制（前提 thinking==null）
// 失效——替换前剔除与流式全量同文的尾部产物后，流式气泡成为唯一渲染源。
async function testLoadChatHistoryStripsInFlightDuplicates() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const artifact = {
    role: "assistant",
    content: [{ type: "text", text: "前置段：让我尝试直接调用 API" }],
    timestamp: Date.now() - 100,
  };
  const olderReply = {
    role: "assistant",
    content: [{ type: "text", text: "上一轮的真实回复，不应误伤" }],
    timestamp: Date.now() - 90_000,
  };
  const state = makeState({
    client: {
      request: async () => ({
        messages: [olderReply, artifact],
        inFlightRun: { runId: "run-1", text: "前置段：让我尝试直接调用 API", startedAt: Date.now() - 50 },
      }),
    },
  });
  state.chatStream = "前置段：让我尝试直接调用 API";
  state.chatStreamStartedAt = Date.now() - 50;
  // thinking 全程非 null —— 正是渲染层同文抑制失效的场景
  state.chatThinkingStream = "思考中";

  await loadChatHistory(state, { mergeIfStale: true, silent: true });

  assert.equal(state.chatMessages.length, 1, "与流同文的中途产物应被剔除");
  assert.equal(
    (state.chatMessages[0] as { content: Array<{ text: string }> }).content[0]?.text,
    "上一轮的真实回复，不应误伤",
  );
  assert.equal(state.chatStream, "前置段：让我尝试直接调用 API", "流式气泡仍是该文本的唯一渲染源");
}

// ── Bug1-B'：answer_candidate → tool start 冻结 → 正文回放同文本，冻结 narration 段作废 ──

async function testBodyDeltaInvalidatesFrozenNarrationSegment() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  type TimelineMessage = { content?: Array<{ type: string; text?: string }> };
  type CompHost = {
    toolStreamById: Map<string, { narrationSegment?: { text: string } | undefined }>;
    toolStreamOrder: string[];
    chatToolMessages: TimelineMessage[];
    toolStreamSyncTimer: number | null;
    evictedLeadingSegments: Array<{ text: string }>;
    onBodyTextAdoptsNarration?: (bodyText: string) => void;
  };
  const host = {
    ...makeState(),
    toolStreamById: new Map(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    evictedLeadingSegments: [],
  } as CompHost;
  host.onBodyTextAdoptsNarration = (bodyText: string) =>
    invalidateDuplicatedNarrationSegments(host as never, bodyText);

  // 1) answer_candidate narration 上屏
  handleAgentEvent(host as never, {
    runId: "run-1", seq: 1, stream: "item", ts: Date.now(), sessionKey: "session-1",
    data: { kind: "answer_candidate", phase: "update", progressText: "候选答案全文", itemId: "item-1" },
  });
  raf.runAll();
  assert.equal((host as unknown as { chatNarrationText: string | null }).chatNarrationText, "候选答案全文");

  // 2) tool start 把 narration 冻结成 entry.narrationSegment
  handleAgentEvent(host as never, {
    runId: "run-1", seq: 2, stream: "tool", ts: Date.now(), sessionKey: "session-1",
    data: { phase: "start", name: "exec", toolCallId: "call-1", args: { command: "echo hi" } },
  });
  const entry = host.toolStreamById.get("call-1");
  assert.equal(entry?.narrationSegment?.text, "候选答案全文");
  flushToolStreamSync(host as never);
  const timelineHasNarration = () =>
    host.chatToolMessages.some((m: TimelineMessage) =>
      m.content?.some((b) => b.type === "text" && b.text === "候选答案全文"),
    );
  assert.ok(timelineHasNarration(), "正文回放前冻结 narration 段应在时间线上");

  // 3) 正文通道回放同文本 → R4 触发点经钩子作废冻结段
  handleChatEvent(host as never, {
    runId: "run-1",
    sessionKey: "session-1",
    state: "delta",
    message: { role: "assistant", content: [{ type: "text", text: "候选答案全文" }] },
  });
  raf.runAll();
  assert.equal(entry?.narrationSegment, undefined, "被正文接管的冻结 narrationSegment 应作废");
  assert.ok(!timelineHasNarration(), "时间线里不应再出现该 narration 段消息");

  // 4) 对照：正文与 narration 不同文时冻结段保留（answer_candidate 被否决的场景）
  const host2 = {
    ...makeState(),
    toolStreamById: new Map(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    evictedLeadingSegments: [],
    onBodyTextAdoptsNarration: (bodyText: string) =>
      invalidateDuplicatedNarrationSegments(host2 as never, bodyText),
  } as CompHost;
  handleAgentEvent(host2 as never, {
    runId: "run-1", seq: 1, stream: "item", ts: Date.now(), sessionKey: "session-1",
    data: { kind: "answer_candidate", phase: "update", progressText: "被否决的候选", itemId: "item-2" },
  });
  raf.runAll();
  handleAgentEvent(host2 as never, {
    runId: "run-1", seq: 2, stream: "tool", ts: Date.now(), sessionKey: "session-1",
    data: { phase: "start", name: "exec", toolCallId: "call-2", args: {} },
  });
  handleChatEvent(host2 as never, {
    runId: "run-1",
    sessionKey: "session-1",
    state: "delta",
    message: { role: "assistant", content: [{ type: "text", text: "另一个回答" }] },
  });
  raf.runAll();
  assert.equal(
    host2.toolStreamById.get("call-2")?.narrationSegment?.text,
    "被否决的候选",
    "正文未接管该段时冻结 narration 应保留（唯一展示来源）",
  );
}

// ── Bug2-1：mergeIfStale 等长滞后（缺本 run 回复）保留本地 + 补拉 ──

// Bug2 测试共用：终态轮消息基线——[user 回声] + run 起始时间锚
// （乐观回声与 chatStreamStartedAt 同源，均为发送时刻）。
function makeTerminalRoundState(overrides: Record<string, unknown> = {}) {
  const startedAt = Date.now() - 5000;
  const echo = { role: "user", content: [{ type: "text", text: "问题" }], timestamp: startedAt };
  const state = makeState({
    chatMessages: [echo],
    chatVisibleMessageCount: 1,
    chatStreamStartedAt: startedAt,
    ...overrides,
  });
  return { state, echo, startedAt };
}

async function testFinalInjectsSyntheticPartialPlaceholder() {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const { state } = makeTerminalRoundState();

  handleChatEvent(state, {
    runId: "run-1", sessionKey: "session-1", state: "delta",
    deltaText: "完整回复",
    message: { role: "assistant", content: [{ type: "text", text: "完整回复" }] },
  });
  handleChatEvent(state, { runId: "run-1", sessionKey: "session-1", state: "final" });

  assert.equal(state.chatStream, null, "final 后流式态应清除");
  assert.equal(state.chatMessages.length, 2, "final 应注入合成 partial 占位（回复全程可见）");
  const placeholder = state.chatMessages[1] as Record<string, unknown>;
  assert.equal(placeholder.cryoclawPartial, true, "占位复用 aborted/error 的 partial 形态");
  assert.equal(placeholder.runId, "run-1", "占位带 runId 供等长滞后判定精确命中");
  assert.equal(
    (placeholder.content as Array<{ text: string }>)[0]?.text,
    "完整回复",
  );
  assert.ok(state.chatTerminalRun, "终态 run 记录应写入（等长滞后判定用）");
}

async function testMergeIfStaleEqualLengthMissingReplyRetainsLocal() {
  installBrowserGlobals(new FakeRaf());
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { state, echo, startedAt } = makeTerminalRoundState();
    state.chatTerminalRun = { runId: "run-1", startedAt };
    // final 已注入合成占位：本地 = [回声, 占位]，长度 2
    state.chatMessages = [...state.chatMessages, {
      role: "assistant",
      content: [{ type: "text", text: "完整回复" }],
      timestamp: Date.now(),
      cryoclawPartial: true,
      runId: "run-1",
    }];
    state.chatVisibleMessageCount = 2;

    // 滞后快照等长（2）：含回声 + 一条更早的旧 assistant 回复，缺本 run 回复
    const staleRemote = [
      echo,
      { role: "assistant", content: [{ type: "text", text: "旧回复" }], timestamp: startedAt - 60_000 },
    ];
    let calls = 0;
    state.client = {
      request: async () => {
        calls++;
        return { messages: staleRemote };
      },
    };
    await loadChatHistory(state, { mergeIfStale: true });
    assert.equal(calls, 1);
    assert.equal(state.chatMessages.length, 2, "等长缺回复应保留本地（含合成占位）");
    assert.equal((state.chatMessages[1] as { cryoclawPartial?: boolean }).cryoclawPartial, true);

    // 关键回归点：不得 cancelStaleHistoryRetry——600ms 后应发起补拉
    mock.timers.tick(600);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(calls, 2, "等长滞后保留后应调度补拉而非取消");
  } finally {
    mock.timers.reset();
    cancelStaleHistoryRetryForTests();
  }
}

// Bug2-1 收敛方向：等长快照含本 run 真回复 → 放行替换，合成占位随本地列表撤掉。
async function testMergeIfStaleEqualLengthWithReplyReplaces() {
  installBrowserGlobals(new FakeRaf());
  const startedAt = Date.now() - 5000;
  const echo = { role: "user", content: [{ type: "text", text: "问题" }], timestamp: startedAt };
  const realReply = {
    role: "assistant",
    content: [{ type: "text", text: "完整回复" }],
    timestamp: Date.now() - 100,
    runId: "run-1",
  };
  const state = makeState({
    chatMessages: [
      echo,
      { role: "assistant", content: [{ type: "text", text: "完整回复" }], timestamp: Date.now(), cryoclawPartial: true, runId: "run-1" },
    ],
    chatVisibleMessageCount: 2,
    chatTerminalRun: { runId: "run-1", startedAt },
    client: makeHistoryClient([echo, realReply]),
  });

  await loadChatHistory(state, { mergeIfStale: true });

  assert.equal(state.chatMessages.length, 2, "等长含回复应放行替换");
  const tail = state.chatMessages[1] as Record<string, unknown>;
  assert.equal(tail.cryoclawPartial, undefined, "拿到真回复后合成占位应撤掉");
  assert.equal(tail.runId, "run-1");
}

// Bug2-1 边界：双方都无本 run 回复（空回复终态）——尾部差异只是回声时间戳噪音，
// 放行替换，否则这类合法快照被永久挡住，历史永不收敛。
async function testMergeIfStaleEqualLengthBothMissingReplyReplaces() {
  installBrowserGlobals(new FakeRaf());
  const startedAt = Date.now() - 5000;
  const state = makeState({
    chatMessages: [{ role: "user", content: [{ type: "text", text: "问题" }], timestamp: startedAt }],
    chatVisibleMessageCount: 1,
    chatTerminalRun: { runId: "run-1", startedAt },
    // 内核持久化的回声副本：时间戳略晚于本地乐观回声（合法差异）
    client: makeHistoryClient([
      { role: "user", content: [{ type: "text", text: "问题" }], timestamp: startedAt + 800 },
    ]),
  });

  await loadChatHistory(state, { mergeIfStale: true });

  assert.equal(
    (state.chatMessages[0] as { timestamp: number }).timestamp,
    startedAt + 800,
    "双方都无回复的等长快照应放行替换（回声时间戳收敛）",
  );
}

// ── Bug2-3：silent 迟到响应丢弃 + 终态 tombstone 拒收养 ──

async function testSilentLateResponseDroppedAfterNewerNonSilentLoad() {
  installBrowserGlobals(new FakeRaf());
  const { client, resolvers } = makeDeferredHistoryClient();
  const state = makeState({ client });

  const silentPromise = loadChatHistory(state, { mergeIfStale: true, silent: true });
  const nonSilentPromise = loadChatHistory(state);
  assert.equal(resolvers.length, 2, "两个加载都应发出请求");

  // 非 silent（后发起）先完成并写回
  resolvers[1]!({
    messages: [{ role: "assistant", content: [{ type: "text", text: "new-reply" }], timestamp: 2 }],
  });
  await nonSilentPromise;
  assert.equal(state.chatLoading, false);
  assert.equal(
    (state.chatMessages[0] as { content: Array<{ text: string }> }).content[0]?.text,
    "new-reply",
  );

  // silent（先发起）后到：期间已有更新的非 silent 加载发起 → 丢弃写回
  resolvers[0]!({
    messages: [{ role: "assistant", content: [{ type: "text", text: "stale-reply" }], timestamp: 1 }],
  });
  await silentPromise;
  assert.equal(
    (state.chatMessages[0] as { content: Array<{ text: string }> }).content[0]?.text,
    "new-reply",
    "迟到的 silent 响应不得覆盖更新的非 silent 写回",
  );
  assert.equal(state.chatMessages.length, 1);
  assert.equal(state.chatLoading, false, "silent 丢弃路径不得动非 silent 的加载态");
}

async function testTerminalTombstoneRejectsInFlightAdoption() {
  installBrowserGlobals(new FakeRaf());
  const state = makeState();
  // own-run final → 记录 tombstone（run-1 已终结）
  handleChatEvent(state, { runId: "run-1", sessionKey: "session-1", state: "final" });
  assert.equal(state.chatRunId, null);

  // 迟到的历史响应仍声明 run-1 在途（滞后快照）→ 不得收养复活成僵尸流
  state.client = {
    request: async () => ({
      messages: [],
      inFlightRun: { runId: "run-1", text: "复活文本", startedAt: Date.now() - 1000 },
    }),
  };
  await loadChatHistory(state);
  assert.equal(state.chatRunId, null, "已收过终态帧的 run 不得被迟到快照收养");
  assert.equal(state.chatStream, null);

  // 对照：未收过终态的 run 仍可正常收养（tombstone 不误伤）
  state.client = {
    request: async () => ({
      messages: [],
      inFlightRun: { runId: "run-fresh", text: "hi", startedAt: 42 },
    }),
  };
  await loadChatHistory(state);
  assert.equal(state.chatRunId, "run-fresh", "未终结 run 的收养不受影响");
  assert.equal(state.chatStream, "hi");
}

async function main() {
  await testChatStreamIsRafThrottled();
  await testLoadChatHistoryBatchesInitialRender();
  await testDeltaAfterToolUseShowsOnlyTrailingText();
  await testRunErrorInjectsInlineErrorMessage();
  await testTerminalErrorPreservesVisiblePartialText();
  await testOrphanRunsAreSessionScoped();
  await testForeignDeltaDroppedWhenNoActiveRun();
  await testForeignErrorDoesNotInjectCardWhenNoActiveRun();
  await testForeignFinalPassesThroughWhenNoActiveRun();
  await testMergeIfStaleKeepsLocalOnShortRead();
  await testMergeIfStaleKeepsLocalOnEmptyRead();
  await testMergeIfStaleReplacesOnCompaction();
  await testSendFailureAfterSessionSwitchDoesNotTouchNewSession();
  await testOrphanDeltaAdoptedAfterReconnect();
  await testNonOrphanDeltaStillDropped();
  await testOrphanExpiredNotAdopted();
  await testOrphanFinalPassesAndClearsSnapshot();
  await testStaleRetryBackoffAndCancelOnReplace();
  await testStaleRetryAbortedOnSessionSwitch();
  await testStaleRetryBudgetResetsOnTargetSessionSwitch();
  await testStaleRetryBudgetExhaustedRecoversOnSessionSwitch();
  await testSendFailureMarksLocalEchoForResend();
  await testPreserveRunStateFailureDoesNotInject();
  await testSendFileAttachmentGoesBase64AndEchoHasMediaPaths();
  await testOversizedFileFallsBackToTextPrefix();
  await testSendFailureKeepsResendAttachments();
  await testCumulativeFrameBudgetDegradesLaterFiles();
  await testMergeIfStaleKeepsVisibleCountWithoutHydration();
  await testReplaceWithoutMergeStillHydratesFromTwenty();
  await testMergeIfStaleFallsBackToHydrationWhenPartiallyVisible();
  await testSilentProbeDoesNotToggleChatLoading();
  await testInFlightRunAdoptedOnFreshLoad();
  await testInFlightRunEmptyTextAdoptedAsActivityIndicator();
  await testInFlightRunNotAdoptedWhenLocalRunActive();
  await testInFlightRunAdoptedEvenOnStaleReadRetention();
  await testInFlightRunAbsentKeepsClearedState();
  await testBodyDeltaClearsNarration();
  await testEmptyBodyDeltaKeepsNarration();
  await testReplaceBeyondFrozenPrefixInvalidatesFrozenSegments();
  await testMismatchResyncAfterThreeFailures();
  await testOrphanAdoptionClearsStreamResidue();
  await testInFlightRunNotAdoptedWhenReplyInFreshHistory();
  await testInFlightRunNotAdoptedWhenReplyInLocalHistory();
  await testMidRunPersistedReplyDoesNotBlockAdoption();
  await testTerminalStopReasonStillBlocksAdoption();
  await testNoStartedAtKeepsTimestampFallback();
  await testOrphanStatusFrameDoesNotClearSnapshot();
  await testAbortedPreservesVisiblePartialText();
  await testConcurrentLoadsLatestGenerationWins();
  await testNewRunResetsMismatchCount();
  testStripInFlightStreamDuplicatesPure();
  await testLoadChatHistoryStripsInFlightDuplicates();
  await testBodyDeltaInvalidatesFrozenNarrationSegment();
  await testFinalInjectsSyntheticPartialPlaceholder();
  await testMergeIfStaleEqualLengthMissingReplyRetainsLocal();
  await testMergeIfStaleEqualLengthWithReplyReplaces();
  await testMergeIfStaleEqualLengthBothMissingReplyReplaces();
  await testSilentLateResponseDroppedAfterNewerNonSilentLoad();
  await testTerminalTombstoneRejectsInFlightAdoption();
  cancelStaleHistoryRetryForTests();
  console.log("chat controller tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
