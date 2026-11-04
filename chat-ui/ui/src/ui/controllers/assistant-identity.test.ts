import test from "node:test";
import assert from "node:assert/strict";
import { loadAssistantIdentity, type AssistantIdentityState } from "./assistant-identity.ts";

test("identity refresh cannot publish across disconnect or client replacement", async () => {
  for (const change of ["disconnect", "client", "session", "none"]) {
    let resolve!: (value: unknown) => void;
    const client = { request: () => new Promise(r => { resolve = r; }) };
    const state = { client, connected: true, sessionKey: "agent:main:main", assistantName: "old", assistantAvatar: null, assistantAgentId: "main" } as unknown as AssistantIdentityState;
    const pending = loadAssistantIdentity(state);
    if (change === "disconnect") state.connected = false;
    if (change === "client") state.client = {} as AssistantIdentityState["client"];
    if (change === "session") state.sessionKey = "agent:other:main";
    resolve({ name: "new", agentId: "main" });
    await pending;
    assert.equal(state.assistantName, change === "none" ? "new" : "old");
  }
});
