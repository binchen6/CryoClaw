import assert from "node:assert/strict";
import test from "node:test";
import { flushChatQueueForEvent, handleAbortChat, handleSendChat, sendQueuedMessageNow } from "./app-chat.ts";
import { loadChatHistory, sendChatMessage } from "./controllers/chat.ts";
import { applySessionKeyTransition, clearSessionDraftSnapshot } from "./session-transition.ts";
import { peekRunStateSnapshot, resetRunStateStoreForTests } from "./run-state-store.ts";
import { buildChatProps } from "./app-chat-props.ts";

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeHost(request: (method: string, params?: any) => Promise<unknown>) {
  Object.assign(globalThis, {
    window: { setTimeout: () => 0, clearTimeout() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    document: { scrollingElement: null, documentElement: {} },
  });
  resetRunStateStoreForTests();
  for (const key of ["send-a", "send-b"]) clearSessionDraftSnapshot(key);
  return {
    connected: true, client: { request }, sessionKey: "send-a",
    chatMessage: "", chatAttachments: [], chatQueue: [], chatSending: false,
    chatRunId: null, chatAbortPending: false, chatLoading: false,
    chatMessages: [], chatVisibleMessageCount: 0, chatHistoryHydrationFrame: null,
    chatStream: null, chatStreamFrame: null, chatPendingStreamText: null,
    chatStreamFrozenPrefix: "", chatStreamStartedAt: null, chatLastActivityAt: null,
    chatThinkingLevel: null, chatThinkingStream: null, chatPendingThinkingText: null,
    chatNarrationText: null, chatPendingNarrationText: null, chatTerminalRun: null,
    chatToolMessages: [], toolStreamById: new Map(), toolStreamOrder: [],
    evictedLeadingSegments: [], toolStreamSyncTimer: null,
    basePath: "", hello: null, chatAvatarUrl: null, sessionsResult: null,
    chatScrollFrame: null, chatScrollTimeout: null, chatScrollGeneration: 0,
    chatHasAutoScrolled: false, chatUserNearBottom: true, chatNewMessagesBelow: false,
    updateComplete: Promise.resolve(), querySelector: () => null, style: {},
    settings: { sessionKey: "send-a", lastActiveSessionKey: "send-a", pinnedWorkspaces: [], sessionWorkspaceMap: {} },
    applySettings(next: unknown) { this.settings = next as any; },
    resetToolStream() {}, resetChatScroll() {}, async loadAssistantIdentity() {},
    lastError: null, thinkingLevel: null,
  } as any;
}

function switchSession(host: any, key: string) {
  host.connected = false; // This fixture never makes a real history request.
  applySessionKeyTransition(host, key);
  host.connected = true;
}

test("failed send restores its draft and attachments to its owner after switching sessions", async () => {
  const rpc = deferred();
  const host = makeHost(() => rpc.promise);
  const attachment = { id: "image-a", dataUrl: "data:image/png;base64,YQ==", mimeType: "image/png" };
  host.chatMessage = "message from A";
  host.chatAttachments = [attachment];
  const sending = handleSendChat(host);
  switchSession(host, "send-b");
  host.chatMessage = "new draft in B";
  host.chatAttachments = [{ id: "image-b", name: "B.png" }];
  rpc.reject(new Error("send failed"));
  assert.equal(await sending, false);
  assert.equal(host.chatMessage, "new draft in B");
  assert.equal(host.chatAttachments[0].id, "image-b");
  switchSession(host, "send-a");
  assert.equal(host.chatMessage, "message from A", "the unsent draft must remain recoverable in A");
  assert.deepEqual(host.chatAttachments, [attachment]);
  assert.equal(host.chatRunId, null, "a failed request cannot leave A's snapshot busy forever");
});

test("send failure keeps a newer draft and attachments written while the RPC was pending", async () => {
  const rpc = deferred();
  const host = makeHost(() => rpc.promise);
  host.chatMessage = "first message";
  const sending = handleSendChat(host);
  host.chatMessage = "next message";
  host.chatAttachments = [{ id: "next-file", name: "next.txt" }];
  rpc.reject(new Error("send failed"));
  assert.equal(await sending, false);
  assert.equal(host.chatMessage, "next message");
  assert.equal(host.chatAttachments[0].id, "next-file");
  assert.equal(host.chatMessages.at(-1).resendText, "first message");
});

test("a background failure with a newer owner draft remains visible and explicitly retryable with its original attachments", async () => {
  const rpc = deferred();
  const requested = deferred<void>();
  const sends: any[] = [];
  const host = makeHost(async (method, params) => {
    if (method === "chat.history") return { messages: [] };
    sends.push(params);
    requested.resolve();
    return sends.length === 1 ? rpc.promise : {};
  });
  const image = { id: "original-image", name: "original.png", dataUrl: "data:image/png;base64,YQ==", mimeType: "image/png" };
  const file = { id: "original-file", name: "original.txt", filePath: "C:/original.txt" };
  (window as any).cryoclaw = { readFileBase64: async () => ({ base64: "Yg==", mimeType: "text/plain", size: 1 }) };
  host.chatMessage = "original message";
  host.chatAttachments = [image, file];
  const sending = handleSendChat(host);
  await requested.promise;
  assert.equal(sends.length, 1);
  host.chatMessage = "newer owner draft";
  host.chatAttachments = [{ id: "newer-owner-file", name: "newer.txt" }];
  switchSession(host, "send-b");
  host.chatMessage = "draft B";
  host.chatAttachments = [{ id: "file-b", name: "b.txt" }];
  host.chatMessages = [{ role: "user", content: "history B" }];
  rpc.reject(new Error("original send failed"));
  assert.equal(await sending, false);
  assert.equal(host.chatMessage, "draft B");
  assert.deepEqual(host.chatAttachments.map((item: any) => item.id), ["file-b"]);
  assert.deepEqual(host.chatMessages, [{ role: "user", content: "history B" }]);
  assert.deepEqual(host.chatQueue, []);

  switchSession(host, "send-a");
  await loadChatHistory(host);
  assert.equal(host.chatMessage, "newer owner draft");
  assert.deepEqual(host.chatAttachments.map((item: any) => item.id), ["newer-owner-file"]);
  const visibleQueue = buildChatProps(host).queue;
  assert.equal(visibleQueue.length, 1, "the failed message must appear in the existing queue with its Send now action");
  assert.equal(visibleQueue[0].message, "original message");
  assert.equal(visibleQueue[0].text, "original message");
  assert.deepEqual(visibleQueue[0].attachments, [image, file]);
  assert.notEqual(visibleQueue[0].attachments?.[0], image, "later thumbnail updates must not mutate the recovered request");
  await flushChatQueueForEvent(host);
  assert.equal(sends.length, 1, "returning to the session or reconnecting must not silently retry the failure");

  assert.equal(await sendQueuedMessageNow(host, visibleQueue[0].id), true);
  assert.equal(sends.length, 2);
  assert.equal(sends[1].sessionKey, "send-a");
  assert.equal(sends[1].message, "original message");
  assert.deepEqual(sends[1].attachments, [
    { type: "image", mimeType: "image/png", content: "YQ==" },
    { type: "file", mimeType: "text/plain", fileName: "original.txt", content: "Yg==" },
  ]);
  assert.equal(host.chatQueue.length, 0);
  assert.equal(host.chatMessage, "newer owner draft");
  assert.deepEqual(host.chatAttachments.map((item: any) => item.id), ["newer-owner-file"]);
});

test("a foreground send failure retains its error retry card and original attachment identities", async () => {
  const rpc = deferred();
  const host = makeHost(() => rpc.promise);
  const attachment = { id: "failed-image", name: "failed.png", dataUrl: "data:image/png;base64,YQ==", mimeType: "image/png" };
  host.chatMessage = "retry me";
  host.chatAttachments = [attachment];
  const sending = handleSendChat(host);
  rpc.reject(new Error("send failed"));
  assert.equal(await sending, false);
  assert.equal(host.chatMessage, "retry me");
  assert.deepEqual(host.chatAttachments, [attachment]);
  assert.equal(host.chatMessages.at(-1).cryoclawError, true);
  assert.equal(host.chatMessages.at(-1).resendText, "retry me");
  assert.deepEqual(host.chatMessages.at(-1).resendAttachments, [attachment]);
  assert.deepEqual(host.chatQueue, [], "foreground failures already have a retry card and must not duplicate into the queue");
});

test("a completed send cannot change last active session after the user switches", async () => {
  const rpc = deferred();
  const host = makeHost(() => rpc.promise);
  host.chatMessage = "hello A";
  const sending = handleSendChat(host);
  switchSession(host, "send-b");
  rpc.resolve({});
  assert.equal(await sending, true);
  assert.equal(host.settings.lastActiveSessionKey, "send-b");
});

test("chatSending stays true until every concurrent followup RPC settles", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const host = makeHost(() => ++calls === 1 ? first.promise : second.promise);
  host.chatRunId = "active-run";
  const sendingFirst = sendChatMessage(host, "first", undefined, null, { preserveRunState: true });
  const sendingSecond = sendChatMessage(host, "second", undefined, null, { preserveRunState: true });
  first.resolve({});
  await sendingFirst;
  assert.equal(host.chatSending, true, "the second followup is still awaiting acknowledgement");
  second.resolve({});
  await sendingSecond;
  assert.equal(host.chatSending, false);
});

test("switching sessions releases old busy state and old completion preserves the new busy state", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const host = makeHost(() => ++calls === 1 ? first.promise : second.promise);
  const sendingA = sendChatMessage(host, "message A");
  switchSession(host, "send-b");
  assert.equal(host.chatSending, false, "A's pending RPC must not block B's composer");
  const sendingB = sendChatMessage(host, "message B");
  first.resolve({});
  await sendingA;
  assert.equal(host.chatSending, true, "A's completion must not clear B's pending RPC");
  second.resolve({});
  await sendingB;
  assert.equal(host.chatSending, false);
});

test("old attachment preparation does not clear a new session's error or sending state", async () => {
  const file = deferred<{ base64: string; mimeType: string; size: number }>();
  const payloads: any[] = [];
  const host = makeHost(async (_method, params) => { payloads.push(params); return {}; });
  (window as any).cryoclaw = { readFileBase64: () => file.promise };
  const sending = sendChatMessage(host, "file A", [{ id: "a", filePath: "C:/a.txt", name: "a.txt" }]);
  switchSession(host, "send-b");
  host.lastError = "B connection error";
  file.resolve({ base64: "YQ==", mimeType: "text/plain", size: 1 });
  await sending;
  assert.equal(host.lastError, "B connection error");
  assert.equal(host.chatSending, false);
  assert.equal(payloads[0].sessionKey, "send-a");
  assert.equal(host.chatMessages.length, 0);
});

test("a late abort failure leaves the new run untouched and releases its old snapshot", async () => {
  const rpc = deferred();
  const host = makeHost(() => rpc.promise);
  host.chatRunId = "run-a";
  const aborting = handleAbortChat(host);
  switchSession(host, "send-b");
  host.chatRunId = "run-b";
  host.chatAbortPending = true;
  host.lastError = "B error";
  rpc.reject(new Error("A abort failed"));
  await aborting;
  assert.equal(host.chatAbortPending, true);
  assert.equal(host.lastError, "B error");
  assert.equal(peekRunStateSnapshot("send-a")?.chatAbortPending, false,
    "returning to A must allow retrying its failed Stop request");
});

test("queue send now does not overtake the initial message while its attachment is being read", async () => {
  const file = deferred<{ base64: string; mimeType: string; size: number }>();
  const sent: string[] = [];
  const host = makeHost(async (_method, params) => { sent.push(params.message); return {}; });
  (window as any).cryoclaw = { readFileBase64: () => file.promise };
  const sending = sendChatMessage(host, "initial message", [{ id: "a", filePath: "C:/a.txt", name: "a.txt" }]);
  host.chatQueue = [{ id: "followup", message: "followup", text: "followup", createdAt: 1 }];
  assert.equal(await sendQueuedMessageNow(host, "followup"), false);
  assert.equal(host.chatQueue[0].id, "followup");
  assert.deepEqual(sent, []);
  file.resolve({ base64: "YQ==", mimeType: "text/plain", size: 1 });
  await sending;
  assert.deepEqual(sent, ["initial message"]);
});

test("a late send failure cannot reset a newer run in the same session", async () => {
  const rpc = deferred();
  const host = makeHost(() => rpc.promise);
  const sending = sendChatMessage(host, "old request");
  host.chatRunId = "new-run";
  host.chatStream = "new run output";
  host.chatStreamStartedAt = 100;
  rpc.reject(new Error("old request failed"));
  assert.equal(await sending, null);
  assert.equal(host.chatRunId, "new-run");
  assert.equal(host.chatStream, "new run output");
  assert.equal(host.chatStreamStartedAt, 100);
});

test("history failures superseded by a successful refresh do not surface stale connection errors", async () => {
  for (const silent of [false, true]) {
    const stale = deferred();
    let calls = 0;
    const host = makeHost(async () => ++calls === 1
      ? stale.promise
      : { messages: [{ role: "user", content: "fresh history" }] });
    const oldRead = loadChatHistory(host, { silent });
    await loadChatHistory(host);
    stale.reject(new Error("old connection closed"));
    await oldRead;
    assert.equal(host.lastError, null, "only the latest read can report its failure");
    assert.equal(host.chatMessages[0].content, "fresh history");
  }
});

test("late attachment callbacks and thumbnails update their source session without touching the new composer", () => {
  const host = makeHost(async () => ({}));
  host.chatMessage = "draft A";
  host.chatAttachments = [{ id: "existing-a", filePath: "C:/a.png", name: "a.png" }];
  const update = buildChatProps(host).onAttachmentsChange!;
  switchSession(host, "send-b");
  host.chatMessage = "draft B";
  host.chatAttachments = [{ id: "existing-b", name: "b.txt" }];
  update((previous) => [...previous, { id: "paste-a", dataUrl: "data:image/png;base64,YQ==" }]);
  update((previous) => [...previous, { id: "picker-a", filePath: "C:/chosen.txt" }]);
  update((previous) => previous.map((item) => item.id === "existing-a"
    ? { ...item, thumbnailUrl: "data:image/png;base64,Yg==" } : item));
  assert.deepEqual(host.chatAttachments.map((item: any) => item.id), ["existing-b"]);
  assert.equal(host.chatMessage, "draft B");
  switchSession(host, "send-a");
  assert.equal(host.chatMessage, "draft A");
  assert.deepEqual(host.chatAttachments.map((item: any) => item.id), ["existing-a", "paste-a", "picker-a"]);
  assert.equal(host.chatAttachments[0].thumbnailUrl, "data:image/png;base64,Yg==");
});
