import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { removeFailedSendArtifacts, handleAbortChat, flushChatQueueForEvent } from "./app-chat.ts";

// 与 controllers/chat.test.ts 同款的最小帧调度器/浏览器全局打桩。
class FakeRaf {
  private callbacks = new Map<number, FrameRequestCallback>();
  private nextId = 1;

  requestAnimationFrame(fn: FrameRequestCallback) {
    const id = this.nextId++;
    this.callbacks.set(id, fn);
    return id;
  }

  cancelAnimationFrame(id: number) {
    this.callbacks.delete(id);
  }

  runAll() {
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const fn of pending) fn(0);
  }
}

function installBrowserGlobals(raf: FakeRaf) {
  const scrollTarget = {
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 0,
    scrollTo() {},
  };
  Object.assign(globalThis, {
    window: {
      requestAnimationFrame: (fn: FrameRequestCallback) => raf.requestAnimationFrame(fn),
      cancelAnimationFrame: (id: number) => raf.cancelAnimationFrame(id),
      setTimeout: (fn: () => void) => setTimeout(fn, 60_000),
      clearTimeout: (id: unknown) => clearTimeout(id as any),
    },
    requestAnimationFrame: (fn: FrameRequestCallback) => raf.requestAnimationFrame(fn),
    cancelAnimationFrame: (id: number) => raf.cancelAnimationFrame(id),
    document: {
      scrollingElement: scrollTarget,
      documentElement: scrollTarget,
    },
    getComputedStyle: () => ({ overflowY: "visible" }),
  });
}

// flushChatQueue / handleAbortChat 所需的最小 ChatHost（兼含 sendChatMessage /
// resetToolStream / scheduleChatScroll 触达的字段）。
function makeHost(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatAbortPending: false,
    sessionKey: "session-1",
    basePath: "",
    hello: null,
    chatAvatarUrl: null,
    sessionsResult: null,
    client: null,
    chatMessages: [],
    chatVisibleMessageCount: 0,
    chatHistoryHydrationFrame: null,
    chatPendingStreamText: null,
    chatStreamFrame: null,
    chatStream: null,
    chatStreamStartedAt: null,
    chatLastActivityAt: null,
    chatStreamFrozenPrefix: "",
    chatThinkingLevel: null,
    chatThinkingStream: null,
    chatPendingThinkingText: null,
    chatNarrationText: null,
    chatPendingNarrationText: null,
    chatToolMessages: [],
    toolStreamById: new Map(),
    toolStreamOrder: [] as unknown[],
    evictedLeadingSegments: [],
    chatScrollFrame: null,
    chatScrollTimeout: null,
    chatScrollGeneration: 0,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatNewMessagesBelow: false,
    updateComplete: Promise.resolve(),
    querySelector: () => null,
    style: {},
    settings: { sessionKey: "session-1", lastActiveSessionKey: "session-1" },
    lastError: null,
    thinkingLevel: null,
    ...overrides,
  } as any;
}

// 发送失败残留清理：错误卡 + 带 cryoclawSendFailed 标记的本地乐观 user 气泡
// 一并移除；已落盘的 run 级 user 气泡（无标记）不受影响。

test("移除匹配错误卡及其前一条带标记的乐观 user 气泡", () => {
  const echo = { role: "user", cryoclawSendFailed: true };
  const card = { cryoclawError: true, resendText: "hello" };
  const kept = { role: "assistant" };
  const result = removeFailedSendArtifacts([kept, echo, card], "hello");
  assert.deepEqual(result, [kept]);
});

test("错误卡前一条无 cryoclawSendFailed 标记（已落盘 user 气泡）时只删卡", () => {
  const persistedUser = { role: "user" };
  const card = { cryoclawError: true, resendText: "hello" };
  const result = removeFailedSendArtifacts([persistedUser, card], "hello");
  assert.deepEqual(result, [persistedUser]);
});

test("resendText 不匹配时返回 null，原数组不动", () => {
  const card = { cryoclawError: true, resendText: "hello" };
  const messages = [card];
  assert.equal(removeFailedSendArtifacts(messages, "other"), null);
});

test("多张错误卡时只移除 resendText 匹配的最后一张", () => {
  const cardA = { cryoclawError: true, resendText: "a" };
  const echoB = { role: "user", cryoclawSendFailed: true };
  const cardB = { cryoclawError: true, resendText: "b" };
  const result = removeFailedSendArtifacts([cardA, echoB, cardB], "b");
  assert.deepEqual(result, [cardA]);
});

// 队列 flush 失败回队：与 sendQueuedMessageNow 同一契约——空闲路径失败已向
// 消息流注入乐观气泡+错误卡，回队前先清残留，否则与队列条目双份呈现。
test("flushChatQueue 失败回队时清理失败残留（防队列条目与错误卡双份）", async () => {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const host = makeHost({
    chatQueue: [{ id: "q1", message: "hello", text: "hello", createdAt: 1 }],
    client: {
      request: async (method: string) => {
        assert.equal(method, "chat.send");
        throw new Error("network down");
      },
    },
  });

  await flushChatQueueForEvent(host);

  assert.equal(host.chatQueue.length, 1, "失败条目应回队");
  assert.equal(host.chatQueue[0].id, "q1");
  assert.equal(
    host.chatMessages.length,
    0,
    "回队时应清掉失败注入的乐观气泡+错误卡，不得与队列条目双份呈现",
  );
});

test("flushChatQueue 成功出队：条目移除且消息发送", async () => {
  const raf = new FakeRaf();
  installBrowserGlobals(raf);
  const sent: string[] = [];
  const host = makeHost({
    chatQueue: [{ id: "q1", message: "hello", text: "hello", createdAt: 1 }],
    client: {
      request: async (method: string, params: { message?: string }) => {
        if (method === "chat.send") sent.push(params.message ?? "");
        return {};
      },
    },
  });

  await flushChatQueueForEvent(host);

  assert.deepEqual(sent, ["hello"]);
  assert.equal(host.chatQueue.length, 0, "成功发送后条目应出队");
});

// Stop 按钮中止在途守卫：成功提交后保持 chatAbortPending（按钮禁用，等终态清零），
// 在途期间重复触发（连击/命令路径双触发）不得重复提交 chat.abort。
test("handleAbortChat：在途防重，不重复提交 chat.abort", async () => {
  installBrowserGlobals(new FakeRaf());
  let abortCalls = 0;
  const host = makeHost({
    chatRunId: "run-1",
    client: {
      request: async (method: string) => {
        assert.equal(method, "chat.abort");
        abortCalls++;
        return {};
      },
    },
  });

  await handleAbortChat(host);
  assert.equal(abortCalls, 1);
  assert.equal(host.chatAbortPending, true, "成功提交后保持到终态事件清零");

  await handleAbortChat(host);
  assert.equal(abortCalls, 1, "在途期间不得重复提交 chat.abort");
});

test("handleAbortChat：提交失败即刻清零，按钮恢复可点", async () => {
  installBrowserGlobals(new FakeRaf());
  const host = makeHost({
    chatRunId: "run-1",
    client: {
      request: async () => {
        throw new Error("nope");
      },
    },
  });

  await handleAbortChat(host);

  assert.equal(host.chatAbortPending, false, "失败不得让按钮永久禁用");
  assert.ok(host.lastError, "失败原因应写入 lastError");
});

test("handleAbortChat：无活跃 run 时不置位（防标记永驻）", async () => {
  installBrowserGlobals(new FakeRaf());
  let abortCalls = 0;
  const host = makeHost({
    chatRunId: null,
    client: {
      request: async () => {
        abortCalls++;
        return {};
      },
    },
  });

  await handleAbortChat(host);

  assert.equal(abortCalls, 0, "无活跃 run 不应提交 chat.abort");
  assert.equal(host.chatAbortPending, false, "无活跃 run 置位后无终态事件清零，标记会永驻");
});

// 源码钉点（app-chat-props.ts 依赖 Lit 视图层，node 下不可导入）：onResendError
// 重发前按文本对发送队列去重（否则终态 flush 重复发送同一条）+ run 活跃时
// toast 反馈「已加入队列」。
test("app-chat-props.ts：onResendError 队列去重 + busy 入队 toast 反馈（钉源码）", () => {
  const s = readFileSync(new URL("../../../../src/ui/app-chat-props.ts", import.meta.url), "utf8");
  const branchStart = s.indexOf("onResendError:");
  assert.notEqual(branchStart, -1, "app-chat-props.ts 缺少 onResendError");
  const branch = s.slice(branchStart, s.indexOf("onSend:", branchStart));
  assert.match(
    branch,
    /state\.chatQueue = state\.chatQueue\.filter\([\s\S]*?\(item\.message \?\? item\.text\) !== text/,
    "重发前应按文本从 chatQueue 移除匹配条目（防终态 flush 双份发送）",
  );
  assert.match(
    branch,
    /showToast\(state, t\("chat\.resentToQueue"\)\)/,
    "run 活跃导致静默入队时应给 toast 反馈",
  );
});
