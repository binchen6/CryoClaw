import assert from "node:assert/strict";
import test from "node:test";
import { handleChatEvent, sendChatMessage } from "./chat.ts";
import { handleModelChange } from "../app-models.ts";
import { handleAbortChat } from "../app-chat.ts";

function makeState(ack: (params: any) => unknown, patch?: () => Promise<unknown>) {
  Object.assign(globalThis, {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  const reads: string[] = [];
  const state = {
    connected: true, sessionKey: "ack-session", chatMessages: [],
    chatSending: false, chatRunId: null, chatStream: null,
    chatStreamStartedAt: null, chatLastActivityAt: null,
    chatVisibleMessageCount: 0, chatHistoryHydrationFrame: null,
    chatStreamFrame: null, chatPendingStreamText: null,
    chatStreamFrozenPrefix: "", chatThinkingStream: null,
    chatPendingThinkingText: null, chatNarrationText: null,
    chatPendingNarrationText: null, chatAbortPending: false,
    chatLoading: false, chatThinkingLevel: null, chatMessage: "", chatAttachments: [],
    lastError: null,
    sessionsResult: { sessions: [{ key: "ack-session", model: "p/old" }] },
    currentModel: "p/old", dirtyMeterSessions: new Set(), meterTotalsBaseline: new Map(),
    configuredModels: [], requestUpdate() {}, updateThinkingCapabilities() {},
    client: { request: async (method: string, params: any) => {
      if (method === "chat.send") return ack(params);
      if (method === "sessions.patch" && patch) return patch();
      reads.push(method);
      return { messages: state.chatMessages };
    } },
  } as any;
  return { state, reads };
}

test("the acknowledged run ID owns subsequent chat events", async () => {
  const { state } = makeState(() => ({ runId: "accepted-run", status: "started" }));
  assert.equal(await sendChatMessage(state, "hello"), "accepted-run");
  assert.equal(state.chatRunId, "accepted-run");
  handleChatEvent(state, { sessionKey: "ack-session", runId: "accepted-run", state: "final" });
  assert.equal(state.chatRunId, null, "the acknowledged run's terminal event must end processing");
});

test("sending after choosing a model waits until that session's selection is acknowledged", async () => {
  let resolve!: (value: unknown) => void;
  const patch = new Promise(yes => { resolve = yes; });
  let sent = false;
  const { state } = makeState(() => { sent = true; return {}; }, () => patch);
  const selecting = handleModelChange(state, "p/new");
  const sending = sendChatMessage(state, "use the selected model");
  assert.equal(sent, false, "chat.send must not race ahead of sessions.patch");
  resolve({});
  await selecting;
  assert.ok(await sending);
  assert.equal(sent, true);
});

test("a rejected pending model choice prevents sending on the unintended previous model", async () => {
  let reject!: (error: Error) => void;
  const patch = new Promise((_yes, no) => { reject = no; });
  let sent = false;
  const { state } = makeState(() => { sent = true; return {}; }, () => patch);
  const selecting = handleModelChange(state, "p/new");
  const sending = sendChatMessage(state, "use the selected model");
  reject(new Error("model patch refused"));
  await selecting;
  assert.equal(await sending, null);
  assert.equal(sent, false);
  assert.equal(state.chatRunId, null);
  assert.equal(state.chatSending, false);
  assert.ok(state.chatMessages.some((message: any) => message.cryoclawError));
});

test("a terminal success acknowledgment releases processing without waiting for a repeated event", async () => {
  const { state, reads } = makeState(({ idempotencyKey }) => ({ runId: idempotencyKey, status: "ok" }));
  assert.ok(await sendChatMessage(state, "already completed"));
  assert.equal(state.chatRunId, null);
  assert.equal(state.chatSending, false);
  assert.deepEqual(reads, ["chat.history"], "terminal acknowledgments reconcile the actual transcript");
  assert.equal(state.chatMessages.some((message: any) => message.cryoclawError), false);
});

for (const status of ["error", "timeout"]) {
  test(`a terminal ${status} acknowledgment exposes the gateway failure`, async () => {
    const { state, reads } = makeState(({ idempotencyKey }) => ({
      runId: idempotencyKey, status, summary: "provider could not complete this run",
    }));
    assert.ok(await sendChatMessage(state, "hello"), "the gateway accepted this request before failing");
    assert.equal(state.chatRunId, null);
    assert.equal(state.chatSending, false);
    const error = state.chatMessages.find((message: any) => message.cryoclawError);
    assert.ok(error, "a terminal failure cannot be displayed as a successful empty reply");
    assert.match(error.content[0].text, /provider could not complete/);
    assert.deepEqual(reads, ["chat.history"]);
  });
}

test("a late acknowledgment cannot revive a run whose terminal event already arrived", async () => {
  const { state } = makeState(({ idempotencyKey }) => {
    handleChatEvent(state, { sessionKey: "ack-session", runId: idempotencyKey, state: "final" });
    return { runId: idempotencyKey, status: "started" };
  });
  await sendChatMessage(state, "hello");
  assert.equal(state.chatRunId, null);
});

test("a late acknowledgment cannot replace another session's active run", async () => {
  const { state } = makeState(() => {
    state.sessionKey = "other-session";
    state.chatRunId = "other-run";
    state.chatStream = "other output";
    return { runId: "accepted-run", status: "ok" };
  });
  await sendChatMessage(state, "hello");
  assert.equal(state.chatRunId, "other-run");
  assert.equal(state.chatStream, "other output");
});

test("Stop before model admission cancels the pending message and never submits it later", async () => {
  let resolve!: (value: unknown) => void;
  const patch = new Promise(yes => { resolve = yes; });
  const calls: string[] = [];
  const { state } = makeState(() => { calls.push("chat.send"); return {}; }, () => patch);
  const request = state.client.request;
  state.client.request = (method: string, params: any) => {
    if (method === "chat.abort") calls.push(method);
    return request(method, params);
  };
  const selecting = handleModelChange(state, "p/new");
  const sending = sendChatMessage(state, "cancel before admission");
  await handleAbortChat(state);
  assert.equal(state.chatRunId, null, "Stop must complete locally before the model patch finishes");
  assert.equal(state.chatAbortPending, false);
  assert.equal(state.chatSending, false);
  assert.deepEqual(calls, [], "there is no remote run to abort before chat.send");
  assert.equal(await sending, null);
  assert.equal(state.chatMessages.length, 0, "an unsubmitted canceled message must not remain in transcript");
  resolve({});
  await selecting;
  await Promise.resolve();
  assert.deepEqual(calls, [], "a late model patch cannot submit the stopped message");
});

test("an explicit abort miss releases Stop while an authoritative live snapshot keeps the run active", async () => {
  const { state } = makeState(() => ({}));
  state.chatRunId = "live-abort";
  state.chatStream = "still working";
  let historyReads = 0;
  state.client.request = async (method: string) => {
    if (method === "chat.abort") return { ok: true, aborted: false, runIds: [] };
    historyReads++;
    return { messages: [], inFlightRun: { runId: "live-abort", text: "still working" } };
  };
  await handleAbortChat(state);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(state.chatAbortPending, false);
  assert.equal(state.chatRunId, "live-abort", "an abort miss cannot manufacture run completion");
  assert.equal(state.chatStream, "still working");
  assert.equal(historyReads, 1);
});

test("an abort miss reconciles a matching persisted terminal reply", async () => {
  const { state } = makeState(() => ({}));
  state.chatRunId = "completed-abort";
  state.chatStream = "completed";
  state.client.request = async (method: string) => method === "chat.abort"
    ? { ok: true, aborted: false, runIds: [] }
    : { messages: [{ role: "assistant", runId: "completed-abort", stopReason: "stop", content: "completed" }] };
  await handleAbortChat(state);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(state.chatAbortPending, false);
  assert.equal(state.chatRunId, null, "the persisted terminal reply confirms this exact run completed");
});

test("an abort miss from an old session never loads or clears the new session", async () => {
  const { state } = makeState(() => ({}));
  state.chatRunId = "old-abort";
  let reads = 0;
  state.client.request = async (method: string) => {
    if (method !== "chat.abort") { reads++; return { messages: [] }; }
    state.sessionKey = "new-session";
    state.chatRunId = "new-run";
    state.chatAbortPending = true;
    return { ok: true, aborted: false, runIds: [] };
  };
  await handleAbortChat(state);
  assert.equal(state.chatRunId, "new-run");
  assert.equal(state.chatAbortPending, true);
  assert.equal(reads, 0);
});

test("a late abort history result cannot stop a newer run in the same session", async () => {
  const { state } = makeState(() => ({}));
  state.chatRunId = "old-abort";
  let resolve!: (value: unknown) => void;
  const history = new Promise(yes => { resolve = yes; });
  state.client.request = async (method: string) => method === "chat.abort"
    ? { ok: true, aborted: false, runIds: [] } : history;
  await handleAbortChat(state);
  state.chatRunId = "new-run";
  state.chatStream = "new run output";
  state.chatMessages = [{ role: "user", content: "new question" }];
  state.chatAbortPending = true;
  resolve({ messages: [{ role: "assistant", runId: "old-abort", stopReason: "stop", content: "old reply" }] });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(state.chatRunId, "new-run");
  assert.equal(state.chatStream, "new run output");
  assert.equal(state.chatAbortPending, true);
  assert.deepEqual(state.chatMessages, [{ role: "user", content: "new question" }]);
});

test("an abort miss with only a persisted intermediate reply keeps the run stoppable", async () => {
  const { state } = makeState(() => ({}));
  state.chatRunId = "tool-run";
  state.client.request = async (method: string) => method === "chat.abort"
    ? { ok: true, aborted: false, runIds: [] }
    : { messages: [{ role: "assistant", runId: "tool-run", stopReason: "toolUse", content: "running tool" }] };
  await handleAbortChat(state);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(state.chatRunId, "tool-run");
  assert.equal(state.chatAbortPending, false);
});

test("a failed remote abort keeps the active run and restores Stop for retry", async () => {
  const { state } = makeState(() => ({}));
  state.chatRunId = "remote-run";
  state.chatStream = "remote output";
  state.client.request = async () => { throw new Error("abort rejected"); };
  await handleAbortChat(state);
  assert.equal(state.chatRunId, "remote-run");
  assert.equal(state.chatStream, "remote output");
  assert.equal(state.chatAbortPending, false);
  assert.match(state.lastError, /abort rejected/);
});
