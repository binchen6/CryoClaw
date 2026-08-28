import assert from "node:assert/strict";
import { mock } from "node:test";
import {
  cancelStaleHistoryRetryForTests,
  handleChatEvent,
  loadChatHistory,
  sendChatMessage,
} from "./chat.ts";
import {
  clearReconnectOrphanRun,
  liveOrphanRunId,
  markReconnectOrphanRun,
} from "../stream-recovery.ts";
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
  markReconnectOrphanRun("run-orphan");
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
  markReconnectOrphanRun("run-orphan");
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
  markReconnectOrphanRun("run-orphan", Date.now() - 200_000);
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
  markReconnectOrphanRun("run-orphan");
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

    mock.timers.tick(800);
    await flush();
    assert.equal(calls, 2, "800ms 后应补拉一次");
    assert.equal(state.chatMessages.length, 5, "仍短读仍保留");

    serveShort = true; // 保持短读，验证第三次退避
    mock.timers.tick(1600);
    await flush();
    assert.equal(calls, 3, "1600ms 后应第二次补拉");

    serveShort = false; // 下一次补拉返回完整历史 → 替换成功 → 退避链取消
    mock.timers.tick(2400);
    await flush();
    assert.equal(calls, 4);
    assert.equal(state.chatMessages.length, 6, "完整历史应替换本地");

    mock.timers.tick(10_000);
    await flush();
    assert.equal(calls, 4, "替换成功后不得再补拉");
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
    mock.timers.tick(800);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1, "会话切走后补拉不应发出");
  } finally {
    mock.timers.reset();
    cancelStaleHistoryRetryForTests();
  }
}

// R41：补拉预算 per-session 化——会话 A 挂起重试期间切到会话 B 触发滞后保留时，
// A 消耗过的档位不应由 B 继承，B 应从首档 800ms 重新开始（而非 1600）。
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
    mock.timers.tick(800);
    await flush();
    assert.equal(calls, 2, "A 的 800ms 补拉应发出");

    // 2) 切到会话 B 触发 B 的滞后保留（目标会话切换应复位预算）
    const stateB = makeState({ client, sessionKey: "session-B", chatMessages: [...local] });
    await loadChatHistory(stateB, { mergeIfStale: true });
    assert.equal(calls, 3);

    // 3) B 的补拉应仍是首档 800ms；若继承 A 的计数，800ms 内不会有补拉（排成 1600）
    mock.timers.tick(800);
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

    // 1) A 上连续 3 次滞后保留耗尽预算：首读 + 800/1600/2400 三档补拉全短读 → 共 4 次调用
    const stateA = makeState({ client, sessionKey: "session-A", chatMessages: [...local] });
    await loadChatHistory(stateA, { mergeIfStale: true });
    assert.equal(calls, 1);
    mock.timers.tick(800);
    await flush();
    assert.equal(calls, 2);
    mock.timers.tick(1600);
    await flush();
    assert.equal(calls, 3);
    mock.timers.tick(2400);
    await flush();
    assert.equal(calls, 4, "预算耗尽前共应补拉 3 次");
    mock.timers.tick(10_000);
    await flush();
    assert.equal(calls, 4, "A 预算耗尽后不得再补拉");

    // 2) 切到 B 触发滞后保留：不得继承 A 的耗尽态静默放弃，800ms 后应补拉
    const stateB = makeState({ client, sessionKey: "session-B", chatMessages: [...local] });
    await loadChatHistory(stateB, { mergeIfStale: true });
    assert.equal(calls, 5);
    mock.timers.tick(800);
    await flush();
    assert.equal(calls, 6, "预算耗尽后切会话应重新补拉，而非静默放弃");
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

async function main() {
  await testChatStreamIsRafThrottled();
  await testLoadChatHistoryBatchesInitialRender();
  await testDeltaAfterToolUseShowsOnlyTrailingText();
  await testRunErrorInjectsInlineErrorMessage();
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
  cancelStaleHistoryRetryForTests();
  console.log("chat controller tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
