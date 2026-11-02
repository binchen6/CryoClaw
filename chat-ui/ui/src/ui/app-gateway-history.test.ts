import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { refreshChat } from "./app-chat.ts";
import { handleGatewayEvent } from "./app-gateway.ts";
import { resetRunStateStoreForTests } from "./run-state-store.ts";
import { cancelStaleHistoryRetryForTests } from "./controllers/chat.ts";

async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }

for (const terminalFirst of [false, true]) {
  test(`manual history refresh and terminal entry refresh share ordering (terminal first: ${terminalFirst})`, async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    resetRunStateStoreForTests();
    Object.assign(globalThis, { window: { setTimeout, clearTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {} },
      requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
    const resolvers: Array<(value: unknown) => void> = [];
    const key = `entry-history-race-${terminalFirst}`;
    const host: any = {
      sessionKey: key, connected: true, settings: { sessionKey: key, lastActiveSessionKey: key },
      client: { request: async (method: string) => method === "chat.history"
        ? new Promise(resolve => resolvers.push(resolve)) : { sessions: [] } },
      chatMessages: [], chatVisibleMessageCount: 0, chatLoading: false,
      chatQueue: [], chatMessage: "", chatAttachments: [], chatSending: false,
      chatRunId: `history-race-run-${terminalFirst}`, chatStream: null, chatStreamStartedAt: null,
      chatStreamFrame: null, chatPendingStreamText: null, chatStreamFrozenPrefix: "", chatHistoryHydrationFrame: null,
      chatThinkingStream: null, chatPendingThinkingText: null, chatNarrationText: null, chatPendingNarrationText: null,
      toolStreamById: new Map(), toolStreamOrder: [], chatToolMessages: [], evictedLeadingSegments: [], toolStreamSyncTimer: null,
      sessionsFilterActive: "", sessionsFilterLimit: "120", dirtyMeterSessions: new Set(), meterTotalsBaseline: new Map(),
      requestUpdate() {}, applySettings(settings: unknown) { this.settings = settings; },
    };
    const terminal = () => handleGatewayEvent(host, { type: "event", event: "chat", payload: {
      sessionKey: key, runId: `history-race-run-${terminalFirst}`, state: "final",
    } });
    try {
      if (terminalFirst) terminal();
      const manual = refreshChat(host, { scheduleScroll: false });
      if (!terminalFirst) terminal();
      assert.equal(resolvers.length, 2, "fixture must exercise both real history entry points");
      resolvers[1]!({ messages: [{ role: "user", content: "question" }, { role: "assistant", content: "latest terminal reply" }] });
      await settle();
      assert.equal(host.chatMessages.at(-1)?.content, "latest terminal reply");
      resolvers[0]!({ messages: [{ role: "user", content: "old question" }] });
      await manual; await settle();
      assert.equal(host.chatMessages.at(-1)?.content, "latest terminal reply", "late root/entry requests must not overwrite the same visible session");
      // A later event projects the retained entry again, so the backing snapshot
      // must also contain the winning direct-host history.
      handleGatewayEvent(host, { type: "event", event: "agent", payload: { sessionKey: key, stream: "thinking", data: { text: "next thought" } } });
      assert.equal(host.chatMessages.at(-1)?.content, "latest terminal reply");
      assert.equal(host.chatLoading, false);
    } finally { cancelStaleHistoryRetryForTests(); resetRunStateStoreForTests(); mock.timers.reset(); }
  });
}
