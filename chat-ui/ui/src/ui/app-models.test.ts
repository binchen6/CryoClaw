import test from "node:test";
import assert from "node:assert/strict";
import { handleModelChange, loadConfiguredModels, waitForSessionModelChange, hasPendingSessionModelChange, applyModelThinkingCapabilities, type ModelSelectionHost } from "./app-models.ts";
import { loadSessions, type SessionsState } from "./controllers/sessions.ts";
import { resolveThinkingCapabilities } from "./chat/thinking-levels.ts";

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function tick() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function host(request: (method: string, params?: any) => Promise<unknown>) {
  return {
    client: { request }, connected: true, sessionKey: "s1",
    sessionsResult: { sessions: [{ key: "s1", model: "p/old", thinkingLevels: ["off", "high"] }] },
    currentModel: "p/old", configuredModels: [], dirtyMeterSessions: new Set<string>(),
    meterTotalsBaseline: new Map<string, number>(), lastError: null,
    updates: 0, capabilities: 0,
    requestUpdate(this: { updates: number }) { this.updates++; },
    updateThinkingCapabilities(this: { capabilities: number }) { this.capabilities++; },
    sessionsLoading: false, sessionsError: null, sessionsFilterActive: "", sessionsFilterLimit: "120",
    sessionsIncludeGlobal: false, sessionsIncludeUnknown: false, sessionsIncludeArchived: false,
  } as unknown as ModelSelectionHost & SessionsState & { updates: number; capabilities: number };
}

test("model choice immediately updates the session row and discards old thinking capabilities", async () => {
  const patch = deferred();
  const state = host(() => patch.promise);
  const switching = handleModelChange(state, "p/new");
  assert.equal(state.sessionsResult?.sessions[0]?.model, "p/new");
  assert.equal(state.sessionsResult?.sessions[0]?.thinkingLevels, undefined);
  patch.resolve({});
  await switching;
});

test("rapid model choices persist in order and only the latest failure restores the last confirmed model", async () => {
  const first = deferred(), second = deferred();
  const requests: string[] = [];
  const state = host(async (_method, params) => { requests.push(params.model); return requests.length === 1 ? first.promise : second.promise; });
  const a = handleModelChange(state, "p/first");
  const b = handleModelChange(state, "p/second");
  assert.deepEqual(requests, ["p/first"]);
  assert.equal(state.sessionsResult?.sessions[0]?.model, "p/second");
  first.resolve({});
  await tick();
  assert.deepEqual(requests, ["p/first", "p/second"]);
  second.reject(new Error("second refused"));
  await Promise.all([a, b]);
  assert.equal(state.currentModel, "p/first");
  assert.equal(state.sessionsResult?.sessions[0]?.model, "p/first");
});

test("an old failed choice cannot roll back a newer selection", async () => {
  const first = deferred(), second = deferred();
  let calls = 0;
  const state = host(() => ++calls === 1 ? first.promise : second.promise);
  const a = handleModelChange(state, "p/first");
  const b = handleModelChange(state, "p/second");
  first.reject(new Error("first refused"));
  await tick();
  assert.equal(state.currentModel, "p/second");
  assert.equal(state.lastError, null);
  second.resolve({});
  await Promise.all([a, b]);
  assert.equal(state.sessionsResult?.sessions[0]?.model, "p/second");
});

test("a model completion from another session never recalculates current-session thinking", async () => {
  const patch = deferred();
  const state = host(() => patch.promise);
  const switching = handleModelChange(state, "p/new");
  state.sessionKey = "s2";
  state.currentModel = "other/model";
  const before = state.capabilities;
  patch.resolve({});
  await switching;
  assert.equal(state.capabilities, before);
  assert.equal(state.currentModel, "other/model");
});

test("a stale sessions.list response cannot overwrite a model change acknowledged after that read began", async () => {
  const list = deferred(), patch = deferred();
  const state = host(method => method === "sessions.list" ? list.promise : patch.promise);
  const loading = loadSessions(state);
  const switching = handleModelChange(state, "p/new");
  patch.resolve({}); await switching;
  list.resolve({ sessions: [{ key: "s1", model: "p/old", totalTokens: 123 }] });
  await loading;
  assert.equal(state.sessionsResult?.sessions[0]?.model, "p/new");
  assert.equal(state.sessionsResult?.sessions[0]?.totalTokens, 123);
});

test("configured provider models display before the account catalog finishes", async () => {
  const catalog = deferred();
  const state = host(method => method === "models.list" ? catalog.promise : Promise.resolve({
    hash: "new", config: { models: { providers: { p: { models: [{ id: "ready" }] } } }, agents: { defaults: { model: { primary: "p/ready" } } } },
  }));
  state.currentModel = null;
  const loading = loadConfiguredModels(state);
  await tick();
  assert.equal(state.configuredModels[0]?.key, "p/ready");
  catalog.resolve({ models: [] });
  await loading;
});

test("refreshing provider models keeps known account models visible until readiness is confirmed", async () => {
  const catalog = deferred();
  const state = host(method => method === "models.list" ? catalog.promise : Promise.resolve({
    hash: "account", config: { agents: { defaults: { model: { primary: "openai-codex/account" } } } },
  }));
  state.configuredModels = [{ key: "openai-codex/account", provider: "openai-codex", name: "Account", isDefault: true }];
  const loading = loadConfiguredModels(state);
  await tick();
  assert.equal(state.configuredModels[0]?.key, "openai-codex/account");
  catalog.resolve({ models: [] }); await loading;
  assert.deepEqual(state.configuredModels, [], "the final readiness response is authoritative");
});

test("a disconnected picker does not change the displayed model", async () => {
  const state = host(async () => ({}));
  state.connected = false;
  await handleModelChange(state, "p/new");
  assert.equal(state.currentModel, "p/old");
});

test("sending waits through the latest queued model choice and reports a failure", async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const state = host(() => ++calls === 1 ? first.promise : second.promise);
  const a = handleModelChange(state, "p/first");
  const ready = waitForSessionModelChange(state, "s1");
  const b = handleModelChange(state, "p/second");
  assert.equal(hasPendingSessionModelChange(state, "s1"), true);
  first.resolve({}); await tick();
  second.reject(new Error("refused"));
  assert.equal(await ready, false);
  await Promise.all([a, b]);
  assert.equal(hasPendingSessionModelChange(state, "s1"), false);
  assert.equal(await waitForSessionModelChange(state, "s1"), true, "a later explicit send can use the restored model");
});

test("a fresh authoritative session read can adopt a model changed in another client", async () => {
  let model = "p/new";
  const state = host(async method => method === "sessions.list" ? { sessions: [{ key: "s1", model }] } : {});
  await handleModelChange(state, "p/new");
  await loadSessions(state);
  model = "p/external";
  await loadSessions(state);
  assert.equal(state.sessionsResult?.sessions[0]?.model, "p/external");
});

test("a disconnected model operation cannot remain pending after reconnect", async () => {
  const patch = deferred();
  const state = host(method => method === "sessions.patch" ? patch.promise : Promise.resolve({ sessions: [{ key: "s1", model: "p/actual" }] }));
  const switching = handleModelChange(state, "p/new");
  state.connected = false;
  patch.reject(new Error("connection lost"));
  await switching;
  state.connected = true;
  await loadSessions(state);
  assert.equal(hasPendingSessionModelChange(state, "s1"), false);
  assert.equal(state.sessionsResult?.sessions[0]?.model, "p/actual");
});

test("a new gateway loads sessions immediately while the old gateway request is still pending", async () => {
  const old = deferred();
  const state = host(() => old.promise);
  const stale = loadSessions(state);
  let freshCalled = false;
  state.client = { request: async () => { freshCalled = true; return { sessions: [{ key: "new-gateway" }] }; } } as any;
  const fresh = loadSessions(state);
  await tick();
  assert.equal(freshCalled, true);
  old.resolve({ sessions: [{ key: "old-gateway" }] });
  await Promise.all([stale, fresh]);
  assert.equal(state.sessionsResult?.sessions[0]?.key, "new-gateway");
});

function thinkingHost(patch: ReturnType<typeof deferred>) {
  const writtenLevels: string[] = [];
  const state = Object.assign(host(() => patch.promise), {
    thinkingLevel: "high", thinkingLevels: ["off", "high"], isBinaryThinking: false,
  });
  state.updateThinkingCapabilities = () => {
    const row = state.sessionsResult?.sessions.find(session => session.key === state.sessionKey);
    applyModelThinkingCapabilities(state, resolveThinkingCapabilities({
      modelKey: row?.model, provider: row?.modelProvider,
      sessionThinkingLevels: row?.thinkingLevels,
    }), level => { writtenLevels.push(level); });
  };
  return { state, writtenLevels };
}

test("pending model selection never automatically clears or persists the old thinking preference", async () => {
  const patch = deferred(); const { state, writtenLevels } = thinkingHost(patch);
  const switching = handleModelChange(state, "zai/glm");
  state.updateThinkingCapabilities(); // A sessions.list refresh can arrive while the patch is pending.
  assert.deepEqual(state.thinkingLevels, ["off", "on"]);
  assert.equal(state.thinkingLevel, "high");
  assert.deepEqual(writtenLevels, []);
  patch.resolve({}); await switching;
});

test("a rejected model selection preserves the previous model's thinking preference", async () => {
  const patch = deferred(); const { state, writtenLevels } = thinkingHost(patch);
  const switching = handleModelChange(state, "zai/glm");
  state.updateThinkingCapabilities();
  patch.reject(new Error("model refused")); await switching;
  assert.equal(state.currentModel, "p/old");
  assert.equal(state.thinkingLevel, "high");
  assert.deepEqual(state.thinkingLevels, ["off", "high"]);
  assert.deepEqual(writtenLevels, []);
});

test("the latest confirmed model adjusts an unsupported thinking preference exactly once", async () => {
  const patch = deferred(); const { state, writtenLevels } = thinkingHost(patch);
  const switching = handleModelChange(state, "zai/glm");
  state.updateThinkingCapabilities();
  assert.deepEqual(writtenLevels, []);
  patch.resolve({}); await switching;
  assert.equal(state.thinkingLevel, "off");
  assert.deepEqual(writtenLevels, ["off"]);
  state.updateThinkingCapabilities();
  assert.deepEqual(writtenLevels, ["off"]);
});
