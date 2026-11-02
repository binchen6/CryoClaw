import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { connectGateway } from "./app-gateway.ts";
import { GatewayBrowserClient } from "./gateway.ts";
import { peekRunStateSnapshot, resetRunStateStoreForTests } from "./run-state-store.ts";
import { cancelStaleHistoryRetryForTests, loadChatHistory } from "./controllers/chat.ts";

async function settle() { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }

test("hello starts one visible history read before auxiliary catalogs, including reconnect", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  resetRunStateStoreForTests();
  Object.assign(globalThis, {
    window: { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {},
      requestAnimationFrame: () => 3, cancelAnimationFrame() {} },
    document: { hidden: false, addEventListener() {} },
    requestAnimationFrame: () => 3, cancelAnimationFrame() {},
  });
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  const calls: string[] = [];
  let client: any;
  let historyMessages: unknown[] = [{ role: "assistant", content: "saved reply" }];
  let finishHistory: (snapshot: unknown) => void = () => {};
  let admit: (identity: unknown) => void = () => {};
  const startMock = mock.method(GatewayBrowserClient.prototype, "start", function(this: any) {
    client = this;
    Object.defineProperty(this, "connected", { value: true });
    this.request = async (method: string) => {
      calls.push(method);
      if (method === "agent.identity.get") return new Promise(resolve => { admit = resolve; });
      if (method === "chat.history") return new Promise(resolve => { finishHistory = resolve; });
      if (method === "sessions.list") return { sessions: [{ key }] };
      return {};
    };
  });
  const key = "agent:main:startup-order";
  const host: any = {
    sessionKey: key, settings: { sessionKey: key, lastActiveSessionKey: key, token: "", gatewayUrl: "ws://127.0.0.1:18789" },
    password: "", tab: "chat", connected: false, client: null,
    chatMessages: [], chatVisibleMessageCount: 0, chatLoading: false,
    chatQueue: [], chatMessage: "", chatAttachments: [], chatSending: false,
    chatRunId: null, chatStream: null, chatStreamStartedAt: null,
    chatStreamFrame: null, chatPendingStreamText: null, chatStreamFrozenPrefix: "", chatHistoryHydrationFrame: null,
    chatThinkingStream: null, chatPendingThinkingText: null, chatNarrationText: null, chatPendingNarrationText: null,
    toolStreamById: new Map(), toolStreamOrder: [], chatToolMessages: [], evictedLeadingSegments: [], toolStreamSyncTimer: null,
    sessionsFilterActive: "", sessionsFilterLimit: "120", dirtyMeterSessions: new Set(), meterTotalsBaseline: new Map(),
    questionPrompts: [], progressCard: { loading: false }, board: { loading: false },
    updateComplete: Promise.resolve(), chatScrollGeneration: 0,
    loadConfiguredModels() { calls.push("models-catalog"); }, loadExecMode() { calls.push("exec-mode"); },
    requestUpdate() {}, applySettings(settings: unknown) { this.settings = settings; },
  };
  try {
    connectGateway(host);
    for (const reconnect of [false, true]) {
      calls.length = 0;
      client.opts.onHello({ type: "hello-ok", protocol: 3 });
      assert.equal(host.connected, false, "hello alone must not bypass database admission");
      assert.deepEqual(calls, ["agent.identity.get"]);
      admit({ agentId: "main", name: "Assistant" });
      await settle();
      assert.equal(host.chatLoading, true, "an admitted socket must still expose its unfinished real history read");
      assert.equal(host.lastError, null);
      assert.equal(calls.filter(method => method === "chat.history").length, 1,
        `one authoritative history read per hello (reconnect=${reconnect})`);
      assert.equal(calls.filter(method => method === "sessions.list").length, 1,
        "the immediate ticker owns the initial session listing");
      assert.ok(calls.indexOf("chat.history") < calls.indexOf("models-catalog"), "visible history precedes model catalog work");
      finishHistory({ messages: historyMessages });
      await settle();
      assert.equal(host.chatLoading, false);
      assert.equal(host.chatMessages.at(-1)?.content, "saved reply");
      client.opts.onClose({ code: 1013, reason: "gateway starting" });
      historyMessages = []; // A reconnect's stale short read must retain local history.
    }
  } finally {
    client?.stop(); startMock.mock.restore(); fetchMock.mock.restore();
    cancelStaleHistoryRetryForTests(); resetRunStateStoreForTests();
    t.mock.timers.reset();
  }
});

function startupFixture(t: TestContext) {
  let clock = 0;
  let nextTimer = 0;
  const timers = new Map<number, { at: number; fire: () => void }>();
  mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const id = ++nextTimer;
    timers.set(id, { at: clock + delay, fire: () => callback(...args) });
    return id;
  }) as any);
  mock.method(globalThis, "clearTimeout", ((id: number) => { timers.delete(id); }) as any);
  const advance = (ms: number) => {
    const deadline = clock + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= deadline).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock = due[1].at; timers.delete(due[0]); due[1].fire();
    }
    clock = deadline;
  };
  resetRunStateStoreForTests();
  Object.assign(globalThis, {
    window: { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {} },
    document: { hidden: false, addEventListener() {} },
    requestAnimationFrame: () => 3, cancelAnimationFrame() {},
  });
  mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  mock.method(GatewayBrowserClient.prototype, "start", () => {});
  const key = "agent:main:startup-projection";
  const host: any = {
    sessionKey: key, settings: { sessionKey: key, lastActiveSessionKey: key, token: "", gatewayUrl: "ws://127.0.0.1:18789" },
    password: "", tab: "chat", connected: false, client: null,
    chatMessages: [], chatVisibleMessageCount: 0, chatLoading: false,
    chatQueue: [], chatMessage: "", chatAttachments: [], chatSending: false,
    chatRunId: null, chatStream: null, chatStreamStartedAt: null, chatStreamFrame: null,
    chatPendingStreamText: null, chatStreamFrozenPrefix: "", chatHistoryHydrationFrame: null,
    chatThinkingStream: null, chatPendingThinkingText: null, chatNarrationText: null, chatPendingNarrationText: null,
    toolStreamById: new Map(), toolStreamOrder: [], chatToolMessages: [], evictedLeadingSegments: [], toolStreamSyncTimer: null,
    sessionsFilterActive: "", sessionsFilterLimit: "120", dirtyMeterSessions: new Set(), meterTotalsBaseline: new Map(),
    questionPrompts: [], progressCard: { loading: false }, board: { loading: false },
    updateComplete: Promise.resolve(), chatScrollGeneration: 0,
    loadConfiguredModels() {}, loadExecMode() {}, requestUpdate() {},
    applySettings(settings: unknown) { this.settings = settings; },
  };
  connectGateway(host);
  const client: any = host.client;
  Object.defineProperty(client, "connected", { value: true });
  const histories: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  mock.method(client, "request", async (method: string) => {
    if (method === "agent.identity.get") return { agentId: "main", name: "Assistant" };
    if (method === "sessions.list") return { sessions: [{ key }] };
    if (method === "chat.history") return new Promise((resolve, reject) => { histories.push({ resolve, reject }); });
    return {};
  });
  t.after(() => {
    host.client = client;
    client.opts.onClose({ code: 1013, reason: "gateway starting" });
    client.stop(); cancelStaleHistoryRetryForTests(); resetRunStateStoreForTests();
    mock.restoreAll();
  });
  client.opts.onHello({ type: "hello-ok", protocol: 3 });
  return { host, client, histories, advance };
}

test("one startup history progressively exposes all saved messages without another RPC", async t => {
  const { host, histories, advance } = startupFixture(t);
  await settle();
  assert.equal(histories.length, 1);
  histories[0]!.resolve({ messages: Array.from({ length: 61 }, (_, index) => ({ role: "user", content: `saved-${index}` })) });
  await settle();
  assert.equal(host.chatMessages.length, 61);
  assert.equal(host.chatVisibleMessageCount, 20);
  assert.notEqual(peekRunStateSnapshot(host.sessionKey)?.chatHistoryHydrationFrame, null);
  advance(32); await settle();
  assert.equal(peekRunStateSnapshot(host.sessionKey)?.chatVisibleMessageCount, 60, "entry hydration must advance");
  assert.equal(host.chatVisibleMessageCount, 60, "the first hydration batch must reach the visible host");
  advance(32); await settle();
  assert.equal(host.chatVisibleMessageCount, 61);
  assert.equal(histories.length, 1);
});

test("failed first history remains a visible startup failure", async t => {
  const { host, histories } = startupFixture(t);
  await settle();
  histories[0]!.reject(new Error("history storage unavailable"));
  await settle();
  assert.equal(host.chatLoading, false);
  assert.match(host.lastError ?? "", /history storage unavailable/);
});

test("a newer direct history generation retains its hydration after an old startup request settles", async t => {
  const { host, histories, advance } = startupFixture(t);
  await settle();
  const refresh = loadChatHistory(host);
  assert.equal(histories.length, 2);
  histories[1]!.resolve({ messages: Array.from({ length: 61 }, (_, index) => ({ role: "user", content: `fresh-${index}` })) });
  await refresh; await settle();
  histories[0]!.reject(new Error("obsolete startup failure"));
  await settle();
  assert.equal(host.lastError, null);
  assert.equal(host.chatMessages[0].content, "fresh-0");
  advance(64); await settle();
  assert.equal(host.chatVisibleMessageCount, 61, "an old wrapper must not replace a newer generation's hydration array");
});

for (const change of ["session", "client"] as const) {
  test(`late startup failure cannot affect a newer ${change}`, async t => {
    const { host, histories } = startupFixture(t);
    await settle();
    if (change === "session") host.sessionKey = "agent:main:new-session";
    else host.client = {};
    host.lastError = "current error";
    host.chatMessages = [{ role: "user", content: "current history" }];
    host.chatVisibleMessageCount = 1;
    host.chatLoading = true;
    histories[0]!.reject(new Error("old storage failure"));
    await settle();
    assert.equal(host.lastError, "current error");
    assert.equal(host.chatLoading, true);
    assert.equal(host.chatMessages[0].content, "current history");
  });

  test(`late startup hydration cannot affect a newer ${change}`, async t => {
    const { host, histories, advance } = startupFixture(t);
    await settle();
    histories[0]!.resolve({ messages: Array.from({ length: 61 }, (_, index) => ({ role: "user", content: `old-${index}` })) });
    await settle();
    if (change === "session") host.sessionKey = "agent:main:new-session";
    else host.client = {};
    host.chatMessages = [{ role: "user", content: "current history" }];
    host.chatVisibleMessageCount = 1;
    advance(64); await settle();
    assert.equal(host.chatVisibleMessageCount, 1);
    assert.equal(host.chatMessages[0].content, "current history");
  });
}
