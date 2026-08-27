import assert from "node:assert/strict";
import { applySessionKeyTransition, clearSessionDraftSnapshot } from "./session-transition.ts";

function makeHost() {
  let assistantLoads = 0;
  let toolResets = 0;
  let scrollResets = 0;
  const host = {
    client: null,
    connected: false,
    sessionKey: "session-a",
    settings: {
      sessionKey: "session-a",
      lastActiveSessionKey: "session-a",
    },
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatSending: false,
    chatMessage: "draft",
    chatAttachments: [{ name: "file.txt" }],
    chatRunId: "run-1",
    chatStream: "stream",
    chatStreamStartedAt: 123,
    chatHistoryHydrationFrame: null,
    chatPendingStreamText: "pending",
    chatStreamFrame: null,
    chatVisibleMessageCount: 7,
    chatQueue: [{ id: "queued" }],
    chatAvatarUrl: "https://example.com/avatar.png",
    basePath: "",
    hello: null,
    sessionsResult: null,
    lastError: null,
    applySettings(next: Record<string, unknown>) {
      this.settings = next as any;
    },
    resetToolStream() {
      toolResets++;
    },
    resetChatScroll() {
      scrollResets++;
    },
    async loadAssistantIdentity() {
      assistantLoads++;
    },
  } as any;
  return {
    host,
    get assistantLoads() {
      return assistantLoads;
    },
    get toolResets() {
      return toolResets;
    },
    get scrollResets() {
      return scrollResets;
    },
  };
}

async function testApplySessionKeyTransitionResetsComposerState() {
  const ctx = makeHost();

  const changed = applySessionKeyTransition(ctx.host, "session-b");
  await Promise.resolve();

  assert.equal(changed, true);
  assert.equal(ctx.host.sessionKey, "session-b");
  assert.equal(ctx.host.chatMessage, "");
  assert.deepEqual(ctx.host.chatAttachments, []);
  assert.equal(ctx.host.chatStream, null);
  assert.equal(ctx.host.chatPendingStreamText, null);
  assert.equal(ctx.host.chatVisibleMessageCount, 0);
  assert.equal(ctx.host.chatStreamStartedAt, null);
  assert.equal(ctx.host.chatRunId, null);
  assert.deepEqual(ctx.host.chatQueue, []);
  assert.equal(ctx.host.chatAvatarUrl, null);
  assert.equal(ctx.host.settings.sessionKey, "session-b");
  assert.equal(ctx.host.settings.lastActiveSessionKey, "session-b");
  assert.equal(ctx.assistantLoads, 1);
  assert.equal(ctx.toolResets, 1);
  assert.equal(ctx.scrollResets, 1);
}

// 切换会话时草稿/附件存入 per-session 快照，切回时恢复（一次性，恢复后即删除）。
async function testDraftSnapshotSavedAndRestored() {
  const ctx = makeHost();
  // session-a 有草稿 "draft" + 附件；切到 session-b（无快照）→ 输入框为空
  applySessionKeyTransition(ctx.host, "session-b");
  assert.equal(ctx.host.chatMessage, "");
  assert.deepEqual(ctx.host.chatAttachments, []);

  // 在 session-b 输入新草稿，切回 session-a → 恢复旧草稿；再切回 session-b → 恢复新草稿
  ctx.host.chatMessage = "b-draft";
  applySessionKeyTransition(ctx.host, "session-a");
  assert.equal(ctx.host.chatMessage, "draft", "切回应恢复原会话草稿");
  assert.deepEqual(ctx.host.chatAttachments, [{ name: "file.txt" }], "切回应恢复原会话附件");

  applySessionKeyTransition(ctx.host, "session-b");
  assert.equal(ctx.host.chatMessage, "b-draft");
  assert.deepEqual(ctx.host.chatAttachments, [], "session-b 无附件快照");

  // 空草稿切走不留快照：清空后切到 session-a 再切回，不应复活旧草稿
  ctx.host.chatMessage = "";
  applySessionKeyTransition(ctx.host, "session-a");
  applySessionKeyTransition(ctx.host, "session-b");
  assert.equal(ctx.host.chatMessage, "", "空草稿不应残留快照");
}

// 删除会话时 clearSessionDraftSnapshot 清理快照，防同名 key 复用复活旧草稿。
async function testClearSessionDraftSnapshot() {
  const ctx = makeHost();
  applySessionKeyTransition(ctx.host, "session-b");
  clearSessionDraftSnapshot("session-a");
  applySessionKeyTransition(ctx.host, "session-a");
  assert.equal(ctx.host.chatMessage, "", "快照已清理，切回不应恢复草稿");
  assert.deepEqual(ctx.host.chatAttachments, []);
}

async function main() {
  await testApplySessionKeyTransitionResetsComposerState();
  await testDraftSnapshotSavedAndRestored();
  await testClearSessionDraftSnapshot();
  console.log("session transition tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
