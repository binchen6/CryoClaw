import assert from "node:assert/strict";
import test from "node:test";
import { handleChatEvent, isTerminalRunTombstoned, sendChatMessage } from "./chat.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function makeState(request: (method: string, params: any) => Promise<unknown>) {
  const frames: FrameRequestCallback[] = [];
  const raf = (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; };
  Object.assign(globalThis, {
    requestAnimationFrame: raf, cancelAnimationFrame() {},
    window: { requestAnimationFrame: raf, cancelAnimationFrame() {}, setTimeout: () => 0, clearTimeout() {}, cryoclaw: {} },
  });
  const state = {
    client: { request }, connected: true, sessionKey: "attachment-followup",
    chatLoading: false, chatMessages: [], chatSending: false, chatRunId: "previous-run",
    chatStream: "previous output", chatPendingStreamText: null, chatStreamFrame: null,
    chatStreamStartedAt: Date.now(), chatLastActivityAt: Date.now(), chatStreamFrozenPrefix: "",
    chatThinkingStream: null, chatPendingThinkingText: null, chatNarrationText: null, chatPendingNarrationText: null,
    chatAbortPending: false, chatVisibleMessageCount: 0, chatHistoryHydrationFrame: null,
    chatMessage: "", chatAttachments: [], lastError: null,
  } as any;
  return { state, flushFrames() { const pending = frames.splice(0); for (const callback of pending) callback(0); } };
}

function finishPrevious(state: any) {
  handleChatEvent(state, { sessionKey: state.sessionKey, runId: "previous-run", state: "final" });
}

function assertStreaming(state: any, flushFrames: () => void, runId: string) {
  assert.equal(state.chatRunId, runId, "the new accepted run must expose Stop and own its events");
  assert.equal(state.chatTerminalRun, null, "the previous turn's terminal history guard cannot own the new run");
  handleChatEvent(state, {
    sessionKey: state.sessionKey, runId, state: "delta",
    message: { role: "assistant", content: [{ type: "text", text: "new streamed output" }] },
  });
  flushFrames();
  assert.equal(state.chatStream, "new streamed output");
}

test("a file followup starts a tracked run when the previous run finishes during file reading", async () => {
  const read = deferred<{ base64: string; size: number; mimeType: string }>();
  const { state, flushFrames } = makeState(async () => ({ runId: "after-file-run", status: "started" }));
  (window as any).cryoclaw.readFileBase64 = () => read.promise;
  const sending = sendChatMessage(state, "followup", [{ id: "file", filePath: "C:/qa/file.txt" }], undefined, { preserveRunState: true });
  finishPrevious(state);
  read.resolve({ base64: "eA==", size: 1, mimeType: "text/plain" });
  assert.equal(await sending, "after-file-run");
  assertStreaming(state, flushFrames, "after-file-run");
});

test("a followup ACK takes over after the previous run finishes while chat.send is awaiting admission", async () => {
  const ack = deferred<{ runId: string; status: string }>();
  const { state, flushFrames } = makeState(() => ack.promise);
  const sending = sendChatMessage(state, "followup", undefined, undefined, { preserveRunState: true });
  finishPrevious(state);
  ack.resolve({ runId: "after-ack-run", status: "started" });
  assert.equal(await sending, "after-ack-run");
  assertStreaming(state, flushFrames, "after-ack-run");
});

test("a followup ACK preserves an existing active run", async () => {
  const { state } = makeState(async () => ({ runId: "followup-receipt", status: "started" }));
  await sendChatMessage(state, "followup", undefined, undefined, { preserveRunState: true });
  assert.equal(state.chatRunId, "previous-run");
  assert.equal(state.chatStream, "previous output");
});

test("a followup ACK cannot take over a different run started during admission", async () => {
  const ack = deferred<{ runId: string; status: string }>();
  const { state } = makeState(() => ack.promise);
  const sending = sendChatMessage(state, "followup", undefined, undefined, { preserveRunState: true });
  finishPrevious(state);
  state.chatRunId = "newer-local-run";
  state.chatStream = "newer output";
  ack.resolve({ runId: "followup-receipt", status: "started" });
  await sending;
  assert.equal(state.chatRunId, "newer-local-run");
  assert.equal(state.chatStream, "newer output");
});

for (const terminal of ["final", "aborted", "error"] as const) {
  test(`a followup ACK must not revive an accepted run whose ${terminal} arrived first`, async () => {
    const ack = deferred<{ runId: string; status: string }>();
    const { state } = makeState(() => ack.promise);
    const sending = sendChatMessage(state, "followup", undefined, undefined, { preserveRunState: true });
    finishPrevious(state);
    const endedRunId = `finished-followup-${terminal}`;
    handleChatEvent(state, { sessionKey: state.sessionKey, runId: endedRunId, state: terminal, errorMessage: "provider failed" });
    ack.resolve({ runId: endedRunId, status: "started" });
    await sending;
    assert.equal(state.chatRunId, null, "a late started ACK cannot restore Stop for a finished run");
    assert.equal(state.chatMessages.some((message: any) => message.cryoclawError), false, "unclaimed run errors must not create a foreign retry card");
  });

  test(`an unrelated ${terminal} event records completion without interrupting the active run`, () => {
    const { state } = makeState(async () => ({}));
    const endedRunId = `unrelated-completed-${terminal}`;
    const beforeMessages = [...state.chatMessages];
    const result = handleChatEvent(state, { sessionKey: state.sessionKey, runId: endedRunId, state: terminal, errorMessage: "unrelated failure" });
    assert.equal(result, terminal === "final" ? "final" : null);
    assert.equal(state.chatRunId, "previous-run");
    assert.equal(state.chatStream, "previous output");
    assert.deepEqual(state.chatMessages, beforeMessages);
    assert.equal(state.lastError, null);
    assert.equal(isTerminalRunTombstoned(endedRunId), true, "all terminal evidence must prevent later adoption of this exact run");
    assert.equal(isTerminalRunTombstoned("unrelated-still-running"), false);
  });
}

test("a file followup ACK updates only its offscreen owner after a session switch", async () => {
  const ack = deferred<{ runId: string; status: string }>();
  const { state } = makeState(() => ack.promise);
  const sending = sendChatMessage(state, "followup", undefined, undefined, {
    preserveRunState: true, resolveRunState: () => owner,
  });
  const owner = { ...state, chatRunId: null, chatStream: null, chatMessages: [...state.chatMessages] };
  state.sessionKey = "other-session"; state.chatRunId = "other-run"; state.chatStream = "other output";
  ack.resolve({ runId: "offscreen-followup", status: "started" });
  await sending;
  assert.equal(owner.chatRunId, "offscreen-followup");
  assert.equal(state.chatRunId, "other-run");
  assert.equal(state.chatStream, "other output");
});

for (const sizes of [[26 * 1024 * 1024], [14 * 1024 * 1024, 14 * 1024 * 1024]]) {
  test(`clipboard images exceeding the shared frame budget are recoverable without sending (${sizes.length} image)`, async () => {
    let submitted = false;
    const { state } = makeState(async () => { submitted = true; return {}; });
    state.chatRunId = null; state.chatStream = null;
    const attachments = sizes.map((size, index) => ({ id: `image-${index}`, mimeType: "image/png", dataUrl: `data:image/png;base64,${"a".repeat(size)}` }));
    assert.equal(await sendChatMessage(state, "large screenshot", attachments), null);
    assert.equal(submitted, false, "no oversize WebSocket request may disconnect the session");
    assert.equal(state.chatRunId, null);
    assert.equal(state.chatSending, false);
    const card = state.chatMessages.find((message: any) => message.cryoclawError);
    assert.ok(card, "the user must see why the image was not sent");
    assert.equal(card.resendAttachments.length, attachments.length, "the original images remain available for recovery");
  });
}

test("ordinary clipboard images still send with their original base64 payload", async () => {
  let payload: any;
  const { state } = makeState(async (_method, params) => { payload = params; return {}; });
  state.chatRunId = null;
  assert.ok(await sendChatMessage(state, "screenshot", [{ id: "small", dataUrl: "data:image/png;base64,eA==", mimeType: "image/png" }]));
  assert.deepEqual(payload.attachments, [{ type: "image", mimeType: "image/png", content: "eA==" }]);
});
