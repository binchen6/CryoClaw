import { syncChatSendingState, type ChatState } from "./controllers/chat.ts";
import { resetProgressCardForSession, type ProgressCardHost } from "./controllers/progress-card.ts";
import { resetBoardForSession, type BoardHost } from "./controllers/board.ts";
import { clearReconnectOrphanRun } from "./stream-recovery.ts";
import { removePendingSessionLabel } from "./session-pending.ts";
import {
  captureRunStateSnapshot,
  consumeRunStateHistoryDirty,
  peekRunStateSnapshot,
  restoreRunStateSnapshot,
  saveRunStateSnapshot,
} from "./run-state-store.ts";
import { restoreChatScrollPosition, saveChatScrollPosition } from "./app-scroll.ts";
import type { UiSettings } from "./storage.ts";
import type { ConfiguredModel } from "./ui-types.ts";
import { resolveModelSelectKey } from "./controllers/models.ts";

export type SessionTransitionHost = ChatState & {
  configuredModels?: ConfiguredModel[];
  currentModel?: string | null;
  sessionsResult?: import("./types.ts").SessionsListResult | null;
  chatQueue: unknown[];
  chatAvatarUrl: string | null;
  // 中止请求在途标记（可选：测试替身不实现也无妨；切换会话时清零）
  chatAbortPending?: boolean;
  // 计划面板状态（可选：测试替身不实现也无妨，切换会话时直接清空）
  planState?: { sessionKey?: string } | null;
  // Progress Card 状态（可选：测试替身不实现也无妨；切换会话时重建并重新拉取）
  progressCard?: unknown;
  // R89 Board（会话仪表盘）状态（可选：测试替身不实现也无妨；切换会话时清态+重拉）
  board?: { sessionKey: string | null } | null;
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
// 快照条目上限（R64 审查 P3）：图片附件是整段 base64 dataUrl（单个可数 MB），
// 无上限的 Map 在跨大量会话粘贴图片时会线性累积驻留内存；超限逐出最旧条目
//（Map 迭代序 = 插入序，首个 key 即最旧）。
const SESSION_DRAFT_SNAPSHOT_MAX = 20;

// 会话被删除时同步清理其草稿快照（app-session-actions.ts deleteSessionFromSidebar 调用）
export function clearSessionDraftSnapshot(sessionKey: string) {
  sessionDraftSnapshots.delete(sessionKey);
}

// 预置目标会话的草稿快照（一次性，切过去即恢复并删除）：fork 新会话时用内核
// 返回的 editorText/editorAttachments 预填输入框（复用恢复管线的同构语义）。
export function seedSessionDraftSnapshot(
  sessionKey: string,
  draft: string,
  attachments: ChatState["chatAttachments"] = [],
) {
  sessionDraftSnapshots.delete(sessionKey);
  sessionDraftSnapshots.set(sessionKey, { draft, attachments });
  while (sessionDraftSnapshots.size > SESSION_DRAFT_SNAPSHOT_MAX) {
    const oldest = sessionDraftSnapshots.keys().next().value;
    if (oldest === undefined) break;
    sessionDraftSnapshots.delete(oldest);
  }
}

// Failed sends may settle after their composer has moved offscreen. Recover
// into that session only when it has no newer draft to preserve.
export function restoreSessionDraftSnapshot(
  sessionKey: string,
  draft: string,
  attachments: ChatState["chatAttachments"] = [],
): boolean {
  const existing = sessionDraftSnapshots.get(sessionKey);
  if (existing?.draft || existing?.attachments.length) return false;
  if (draft || attachments.length > 0) seedSessionDraftSnapshot(sessionKey, draft, attachments);
  return true;
}

// File readers, pickers and thumbnail IPC can finish after a session switch.
// Their captured callback must still merge into the original session's draft.
export function updateSessionAttachments(
  host: Pick<ChatState, "sessionKey" | "chatAttachments">,
  sessionKey: string,
  next: ChatState["chatAttachments"] | ((previous: ChatState["chatAttachments"]) => ChatState["chatAttachments"]),
) {
  if (host.sessionKey === sessionKey) {
    host.chatAttachments = typeof next === "function" ? next(host.chatAttachments ?? []) : next;
    return;
  }
  const snapshot = sessionDraftSnapshots.get(sessionKey);
  const attachments = typeof next === "function" ? next(snapshot?.attachments ?? []) : next;
  if (snapshot?.draft || attachments.length > 0) {
    seedSessionDraftSnapshot(sessionKey, snapshot?.draft ?? "", attachments);
  } else {
    sessionDraftSnapshots.delete(sessionKey);
  }
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
    seedSessionDraftSnapshot(host.sessionKey, host.chatMessage, host.chatAttachments);
  } else {
    sessionDraftSnapshots.delete(host.sessionKey);
  }
  // R91 审查修复：被放弃的「新会话」pending label 切走即清——该会话无任何
  // 消息时 label 永不会被 final 事件消费，不清会一直以幽灵行注入侧边栏
  // （每轮 sessions.list 刷新都重插入），且 Map 无上界。
  // 判空剔除本地合成条目（cryoclawError 错误卡 / cryoclawSendFailed 乐观气泡）：
  // 它们不代表内核持久化内容——新会话首发失败后消息流只剩合成条目，此前判定
  // 「有消息」不清 label，幽灵行永驻。
  const realMessageCount = (host.chatMessages ?? []).filter(
    (m) =>
      !((m as Record<string, unknown>).cryoclawError === true) &&
      !((m as Record<string, unknown>).cryoclawSendFailed === true),
  ).length;
  if (realMessageCount === 0 && !host.chatMessage && host.chatAttachments.length === 0) {
    removePendingSessionLabel(host.sessionKey);
  }
  // 滚动位置按会话记忆：切走即存（此时 DOM 仍是旧会话内容），切回还原。
  saveChatScrollPosition(host.sessionKey);
  // 每个会话的运行条目持续存在。切走只保存当前投影，后台事件继续写同一条目；
  // 切回投影最新状态，不再 take 删除后形成前台/快照两个写入目标。
  if (host.chatRunId || (host.chatQueue?.length ?? 0) > 0 || (host.chatMessages?.length ?? 0) > 0) {
    saveRunStateSnapshot(host.sessionKey, captureRunStateSnapshot(host));
  }
  const savedSnapshot = sessionDraftSnapshots.get(trimmed);
  sessionDraftSnapshots.delete(trimmed);
  host.sessionKey = trimmed;
  if ("currentModel" in host) {
    const models = host.configuredModels ?? [];
    const row = host.sessionsResult?.sessions.find(session => session.key === trimmed);
    host.currentModel = resolveModelSelectKey(row?.model, models)
      ?? models.find(model => model.isDefault)?.key ?? models[0]?.key ?? null;
  }
  syncChatSendingState(host);
  clearReconnectOrphanRun();
  host.chatMessage = savedSnapshot?.draft ?? "";
  host.chatAttachments = savedSnapshot?.attachments ?? [];
  const runSnapshot = peekRunStateSnapshot(trimmed);
  if (runSnapshot) {
    restoreRunStateSnapshot(host, runSnapshot);
    consumeRunStateHistoryDirty(trimmed);
    if (!host.chatRunId && (host.chatQueue?.length ?? 0) > 0 && host.client && host.connected) {
      void import("./app-chat.ts")
        .then(({ flushChatQueueForEvent }) =>
          flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]),
        )
        .catch((err) => console.warn("[session-transition] flushChatQueueForEvent failed:", err));
    }
  } else {
    host.chatStream = null;
    host.chatPendingStreamText = null;
    host.chatStreamFrozenPrefix = "";
    host.chatThinkingStream = null;
    host.chatPendingThinkingText = null;
    host.chatNarrationText = null;
    host.chatPendingNarrationText = null;
    host.chatStreamStartedAt = null;
    host.chatLastActivityAt = null;
    host.chatRunId = null;
    host.chatTerminalRun = null;
    host.chatStreamMismatchCount = 0;
    host.chatAbortPending = false;
    host.chatQueue = [];
    host.chatMessages = [];
    host.chatVisibleMessageCount = 0;
    host.planState = null;
    host.resetToolStream();
  }
  // 加载态随会话重置（R64 审查 P3）：断连交错下旧请求的 finally 以
  // sessionKey 守卫跳过清位，若不在此重置，新会话线程区会一直显示「加载中」
  // 直到重连；已连接时随后的 loadChatHistory 会立即重新置位。
  host.chatLoading = false;
  host.chatAvatarUrl = null;
  // Progress Card 同属会话级状态：重建为新会话锚点，随后随历史一起重拉
  // （resetProgressCardForSession 内部会在已连接时发起 progressCard.get）
  resetProgressCardForSession(host as unknown as ProgressCardHost, trimmed);
  // R89 Board（会话仪表盘）同属会话级状态：清态 + 重拉（board 不可用时静默为空）
  if (host.board) {
    resetBoardForSession(host as unknown as BoardHost, trimmed);
  }
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
  host.resetChatScroll();
  // 滚动位置按会话记忆：切回有记忆的会话时还原（贴底场景由既有逻辑兜底）
  restoreChatScrollPosition(
    host as unknown as Parameters<typeof restoreChatScrollPosition>[0],
    trimmed,
  );
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
