import type { ChatState } from "./controllers/chat.ts";
import { resetProgressCardForSession, type ProgressCardHost } from "./controllers/progress-card.ts";
import { resetBoardForSession, type BoardHost } from "./controllers/board.ts";
import { clearReconnectOrphanRun } from "./stream-recovery.ts";
import { removePendingSessionLabel } from "./session-pending.ts";
import {
  captureRunStateSnapshot,
  consumeRunStateHistoryDirty,
  restoreRunStateSnapshot,
  saveRunStateSnapshot,
  takeRunStateSnapshot,
} from "./run-state-store.ts";
import { restoreChatScrollPosition, saveChatScrollPosition } from "./app-scroll.ts";
import type { UiSettings } from "./storage.ts";

export type SessionTransitionHost = ChatState & {
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
  sessionDraftSnapshots.set(sessionKey, { draft, attachments });
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
    sessionDraftSnapshots.delete(host.sessionKey); // 重新插入以刷新 Map 迭代序（LRU 语义）
    sessionDraftSnapshots.set(host.sessionKey, {
      draft: host.chatMessage,
      attachments: host.chatAttachments,
    });
    while (sessionDraftSnapshots.size > SESSION_DRAFT_SNAPSHOT_MAX) {
      const oldest = sessionDraftSnapshots.keys().next().value;
      if (oldest === undefined) break;
      sessionDraftSnapshots.delete(oldest);
    }
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
  // 切换不断流：原会话 run 在跑（或有排队消息）时，run 态快照进 per-session Map
  //（后台期间的 chat/agent 事件由 app-gateway 分派累积进同一快照，见
  // run-state-store.ts），切回无损恢复；排队消息随快照保留——此前直接丢弃。
  if (host.chatRunId || (host.chatQueue?.length ?? 0) > 0) {
    saveRunStateSnapshot(host.sessionKey, captureRunStateSnapshot(host));
  }
  const savedSnapshot = sessionDraftSnapshots.get(trimmed);
  sessionDraftSnapshots.delete(trimmed);
  host.sessionKey = trimmed;
  // 切换会话：上一会话的重连 orphan 快照作废（防跨会话误收养）
  clearReconnectOrphanRun();
  host.chatMessage = savedSnapshot?.draft ?? "";
  host.chatAttachments = savedSnapshot?.attachments ?? [];
  // 命中 run 态快照 → 无损恢复（流式气泡/思考流/解说/工具时间线/队列原样续显；
  // 历史刻意不进快照，仍由下方 loadChatHistory 重拉）。未命中走原有重置路径。
  // 仅「run 在跑或队列非空」的会话有快照，其余会话与旧行为完全一致。
  const runSnapshot = takeRunStateSnapshot(trimmed);
  if (runSnapshot) {
    restoreRunStateSnapshot(host, runSnapshot);
    // 后台 own-run 终态已标记历史脏：下方 loadChatHistory 的无条件重拉即「强制
    // 重拉」的承载（本方法在已连接时总是重拉历史），消费掉脏标记即可。
    consumeRunStateHistoryDirty(trimmed);
    // 后台终态后切回：队列非空且无活跃 run → 补一次队列冲刷，排队消息继续自动发
    if (
      !host.chatRunId &&
      (host.chatQueue?.length ?? 0) > 0 &&
      host.client &&
      host.connected
    ) {
      void import("./app-chat.ts")
        .then(({ flushChatQueueForEvent }) =>
          flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]),
        )
        .catch((err) =>
          console.warn("[session-transition] flushChatQueueForEvent failed:", err),
        );
    }
  } else {
    host.chatStream = null;
    host.chatPendingStreamText = null;
    host.chatStreamFrozenPrefix = "";
    // R88：实时思考/解说按会话隔离——不清会残留上一会话的思考流式区
    host.chatThinkingStream = null;
    host.chatPendingThinkingText = null;
    host.chatNarrationText = null;
    host.chatPendingNarrationText = null;
    host.chatStreamStartedAt = null;
    host.chatLastActivityAt = null;
    host.chatRunId = null;
    // 终态轮记录按会话隔离：切走即清（等长滞后判定只属于原会话的终态轮次）
    host.chatTerminalRun = null;
    // R5：交叉校验计数随会话切换清零（此前只有终态/新 run 分支清零，跨 run 会继承）
    host.chatStreamMismatchCount = 0;
    // 中止在途标记随会话切换清零（新会话无在途中止）
    host.chatAbortPending = false;
    host.chatQueue = [];
    // 计划面板按会话隔离：切走即清（渲染层也按 sessionKey 匹配兜底）
    host.planState = null;
    host.resetToolStream();
  }
  host.chatVisibleMessageCount = 0;
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
