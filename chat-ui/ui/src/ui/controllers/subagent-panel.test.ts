import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { closeSubagentPanel, loadSubagentPanelHistory, projectSubagentPanel, type SubagentPanelHost } from "./subagent-panel.ts";
import { clearSessionRunStateSnapshot, ensureRunStateSnapshot } from "../run-state-store.ts";

function host(key: string): SubagentPanelHost {
  return {
    client: { request: async () => ({ messages: Array.from({ length: 80 }, (_, i) => ({ role: "user", content: `message ${i}` })) }) } as never,
    connected: true, subagentPanelKey: key, subagentPanelMessages: [],
    subagentPanelVisibleMessageCount: 0, subagentPanelToolMessages: [],
    subagentPanelStream: null, subagentPanelThinkingStream: null, subagentPanelNarrationText: null,
    subagentPanelStreamStartedAt: null, subagentPanelLoading: false, subagentPanelError: null,
    requestUpdate() {},
  };
}

test("completed child history projects every hydration batch", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const panel = host("child-hydration");
  try {
    await loadSubagentPanelHistory(panel);
    assert.equal(panel.subagentPanelVisibleMessageCount, 20);
    mock.timers.tick(32);
    assert.equal(panel.subagentPanelVisibleMessageCount, 60);
    mock.timers.tick(32);
    assert.equal(panel.subagentPanelVisibleMessageCount, 80);
  } finally { closeSubagentPanel(panel); mock.timers.reset(); }
});

test("same-panel refresh failure preserves projection of successful history hydration", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const panel = host("child-refresh-during-hydration");
  try {
    await loadSubagentPanelHistory(panel);
    assert.equal(panel.subagentPanelVisibleMessageCount, 20);
    panel.client = { request: async () => { throw new Error("temporary refresh failure"); } } as never;
    await loadSubagentPanelHistory(panel);
    mock.timers.tick(32); mock.timers.tick(32);
    assert.equal(ensureRunStateSnapshot(panel.subagentPanelKey!).chatVisibleMessageCount, 80);
    assert.equal(panel.subagentPanelVisibleMessageCount, 80, "failed refresh must not revoke the successful hydration observer");
  } finally { closeSubagentPanel(panel); mock.timers.reset(); }
});

test("old hydration cannot project into a switched or reopened panel", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const panel = host("child-old");
  try {
    await loadSubagentPanelHistory(panel);
    closeSubagentPanel(panel);
    panel.subagentPanelKey = "child-new";
    const entry = ensureRunStateSnapshot("child-new");
    entry.chatMessages = [{ role: "user", content: "new panel" }];
    entry.chatVisibleMessageCount = 1;
    projectSubagentPanel(panel);
    const messages = panel.subagentPanelMessages;
    mock.timers.tick(64);
    assert.equal(panel.subagentPanelMessages, messages);
    assert.equal(panel.subagentPanelVisibleMessageCount, 1);
  } finally { closeSubagentPanel(panel); clearSessionRunStateSnapshot("child-old"); mock.timers.reset(); }
});

test("stream projection preserves history identity and skips unrelated sessions", () => {
  const panel = host("child-stream");
  const entry = ensureRunStateSnapshot("child-stream");
  entry.chatMessages = [{ role: "user", content: "history" }];
  let updates = 0;
  panel.requestUpdate = () => { updates += 1; };
  projectSubagentPanel(panel);
  const messages = panel.subagentPanelMessages;
  entry.chatPendingStreamText = "token";
  projectSubagentPanel(panel);
  assert.equal(panel.subagentPanelMessages, messages, "tokens must not invalidate full history memoization");
  assert.equal(panel.subagentPanelStream, "token");
  const previousUpdates = updates;
  (projectSubagentPanel as (host: SubagentPanelHost, eventSessionKey?: string) => void)(panel, "other-child");
  assert.equal(updates, previousUpdates, "unrelated background events must not request a panel render");
  closeSubagentPanel(panel);
});
