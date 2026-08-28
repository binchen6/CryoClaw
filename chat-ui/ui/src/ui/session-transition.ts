import type { ChatState } from "./controllers/chat.ts";
import { clearReconnectOrphanRun } from "./stream-recovery.ts";
import type { UiSettings } from "./storage.ts";

export type SessionTransitionHost = ChatState & {
  chatQueue: unknown[];
  chatAvatarUrl: string | null;
  // 计划面板状态（可选：测试替身不实现也无妨，切换会话时直接清空）
  planState?: { sessionKey?: string } | null;
  // 压缩/降级提示胶囊按会话隔离：切走即清（含自动消失定时器）
  compactionStatus?: unknown | null;
  compactionClearTimer?: number | null;
  fallbackNotice?: unknown | null;
  fallbackClearTimer?: number | null;
  settings: UiSettings;
  applySettings(next: UiSettings): void;
  resetToolStream(): void;
  resetChatScroll(): void;
  loadAssistantIdentity(): Promise<void>;
};

function syncUrlWithSessionKey(sessionKey: string, replace: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionKey);
  if (replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
}

// 切换前把当前会话的草稿/附件存入 per-session 快照（sessionKey → 草稿），
// 切回时恢复；此前直接清空导致切会话丢草稿。恢复后即删除条目（一次性）。
type SessionDraftSnapshot = { draft: string; attachments: ChatState["chatAttachments"] };
const sessionDraftSnapshots = new Map<string, SessionDraftSnapshot>();

// 会话被删除时同步清理其草稿快照（app-session-actions.ts deleteSessionFromSidebar 调用）
export function clearSessionDraftSnapshot(sessionKey: string) {
  sessionDraftSnapshots.delete(sessionKey);
}

export function applySessionKeyTransition(
  host: SessionTransitionHost,
  next: string,
  syncUrl = false,
): boolean {
  const trimmed = next.trim();
  if (!trimmed || trimmed === host.sessionKey) {
    return false;
  }
  // 先存当前会话的草稿/附件快照（空草稿不留条目，防 Map 无限增长）
  if (host.chatMessage || host.chatAttachments.length > 0) {
    sessionDraftSnapshots.set(host.sessionKey, {
      draft: host.chatMessage,
      attachments: host.chatAttachments,
    });
  } else {
    sessionDraftSnapshots.delete(host.sessionKey);
  }
  const savedSnapshot = sessionDraftSnapshots.get(trimmed);
  sessionDraftSnapshots.delete(trimmed);
  host.sessionKey = trimmed;
  // 切换会话：上一会话的重连 orphan 快照作废（防跨会话误收养）
  clearReconnectOrphanRun();
  host.chatMessage = savedSnapshot?.draft ?? "";
  host.chatAttachments = savedSnapshot?.attachments ?? [];
  host.chatStream = null;
  host.chatPendingStreamText = null;
  host.chatStreamFrozenPrefix = "";
  host.chatVisibleMessageCount = 0;
  host.chatStreamStartedAt = null;
  host.chatLastActivityAt = null;
  host.chatRunId = null;
  host.chatQueue = [];
  host.chatAvatarUrl = null;
  // 计划面板按会话隔离：切走即清（渲染层也按 sessionKey 匹配兜底）
  host.planState = null;
  // 压缩/降级提示同属会话级瞬态：清掉并取消自动消失定时器，防跨会话残留
  if (host.compactionClearTimer != null && typeof window !== "undefined") {
    window.clearTimeout(host.compactionClearTimer);
  }
  host.compactionClearTimer = null;
  host.compactionStatus = null;
  if (host.fallbackClearTimer != null && typeof window !== "undefined") {
    window.clearTimeout(host.fallbackClearTimer);
  }
  host.fallbackClearTimer = null;
  host.fallbackNotice = null;
  host.resetToolStream();
  host.resetChatScroll();
  host.applySettings({
    ...host.settings,
    sessionKey: trimmed,
    lastActiveSessionKey: trimmed,
  });
  if (syncUrl) {
    syncUrlWithSessionKey(trimmed, true);
  }
  void host.loadAssistantIdentity();
  if (host.client && host.connected) {
    void import("./controllers/chat.ts")
      .then(({ loadChatHistory }) => loadChatHistory(host as ChatState))
      .catch((err) => console.warn("[session-transition] loadChatHistory failed:", err));
  }
  return true;
}
