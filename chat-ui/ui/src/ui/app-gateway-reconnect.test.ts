import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { connectGateway, handleGatewayEvent } from "./app-gateway.ts";
import { GatewayBrowserClient } from "./gateway.ts";
import { clearReconnectOrphanRun } from "./stream-recovery.ts";

test("automatic reconnect on the original client restores its running chat from later events", async () => {
  Object.assign(globalThis, {
    window: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} },
    document: { hidden: true, addEventListener() {} },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  });
  // Network is the boundary: exercise the real onHello/admission path while
  // keeping unrelated catalog reads in flight and preventing any real socket.
  mock.method(GatewayBrowserClient.prototype, "start", () => {});
  const host = {
    client: null, connected: false, password: "", sessionKey: "auto-reconnect",
    settings: { gatewayUrl: "ws://127.0.0.1:18789", token: "", lastActiveSessionKey: "auto-reconnect" },
    tab: "settings", chatMessage: "", chatQueue: [], chatMessages: [],
    chatRunId: null, chatStream: null, chatStreamFrame: null,
    chatPendingStreamText: null, chatStreamFrozenPrefix: "",
    chatStreamStartedAt: null, chatLastActivityAt: null,
    chatPendingThinkingText: null, chatPendingNarrationText: null,
    toolStreamById: new Map(), toolStreamOrder: [], chatToolMessages: [],
    evictedLeadingSegments: [], toolStreamSyncTimer: null,
    board: { widgets: [], loading: false }, progressCard: { loading: false, card: null },
    questionPrompts: [], sessionsFilterActive: "", sessionsFilterLimit: "120",
    dirtyMeterSessions: new Set(), meterTotalsBaseline: new Map(),
    async loadConfiguredModels() {}, async loadExecMode() {},
    requestUpdate() {}, applySettings(next: unknown) { this.settings = next as any; },
  } as any;
  const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  try {
    connectGateway(host);
    const client = host.client;
    Object.defineProperty(client, "connected", { get: () => true });
    mock.method(client, "request", async (method: string) => method === "agent.identity.get"
      ? {} : new Promise(() => {}));
    const hello = () => (client as any).opts.onHello({ type: "hello-ok", protocol: 4 });
    hello();
    await tick();
    assert.equal(host.connected, true);
    assert.equal(host.lastError, null, "the fixture must complete admission without an unrelated error");

    host.chatRunId = "live-run";
    host.chatStream = "before disconnect";
    host.connected = false;
    hello(); // GatewayBrowserClient reconnects internally; connectGateway is not called again.
    await tick();
    handleGatewayEvent(host, { type: "event", event: "chat", payload: {
      sessionKey: "auto-reconnect", runId: "live-run", state: "delta", deltaText: "after reconnect",
    } });
    assert.equal(host.chatRunId, "live-run", "the original client's second hello must preserve orphan ownership");
    assert.equal(host.chatPendingStreamText, "after reconnect");
  } finally {
    clearReconnectOrphanRun(undefined, "auto-reconnect");
    mock.restoreAll();
  }
});
