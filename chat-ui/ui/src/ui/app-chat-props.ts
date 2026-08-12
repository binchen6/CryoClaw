/**
 * 对话页 props 装配：把 AppViewState 映射为 renderChat 所需的 ChatProps。
 * 从 app-render.ts 抽出（阶段 16 架构重构），行为与原内联 props 完全一致。
 */
import type { AppViewState } from "./app-view-state.ts";
import { refreshChatAvatar } from "./app-chat.ts";
import { showToast } from "./app-toast.ts";
import {
  applySessionKey,
  confirmAndCreateNewSession,
  handleBranchCheckpoint,
  handleRestoreCheckpoint,
  resolveAssistantAvatarUrl,
} from "./app-session-actions.ts";
import { loadChatHistory } from "./controllers/chat.ts";
import { getCachedCommands } from "./controllers/commands.ts";
import { loadCompactionCheckpoints } from "./controllers/session-compaction.ts";
import { listEligibleSkills } from "./controllers/skills.ts";
import { dismissPlan } from "./plan-stream.ts";
import type { ChatProps } from "./views/chat.ts";

export function buildChatProps(state: AppViewState): ChatProps {
  return {
    sessionKey: state.sessionKey,
    goal: state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey)?.goal ?? null,
    onGoalCommand: (text: string) => {
      state.chatMessage = text;
      void state.handleSendChat();
    },
    onRequestUpdate: () => state.requestUpdate(),
    commands: getCachedCommands(),
    execMode: state.execMode,
    onExecModeChange: (mode) => void state.setExecMode(mode),
    execApprovalQueue: state.execApprovalQueue,
    execApprovalBusy: state.execApprovalBusy,
    execApprovalError: state.execApprovalError,
    onApprovalDecision: (decision, id) => void state.handleExecApprovalDecision(decision, id),
    // 引用技能：走官方 skills.status，过滤 disabled / ineligible 后供加号菜单展示
    onListSkills: () => listEligibleSkills(state),
    onSessionKeyChange: (next) => applySessionKey(state, next),
    thinkingLevel: state.chatThinkingLevel,
    showThinking: state.onboarding ? false : state.settings.chatShowThinking,
    loading: state.chatLoading,
    sending: state.chatSending,
    compactionStatus: state.compactionStatus,
    fallbackNotice: state.fallbackNotice,
    plan: state.planState,
    onDismissPlan: () => dismissPlan(state),
    assistantAvatarUrl: state.chatAvatarUrl ?? resolveAssistantAvatarUrl(state) ?? null,
    messages: state.chatMessages,
    visibleHistoryCount: state.chatVisibleMessageCount,
    toolMessages: state.chatToolMessages,
    stream: state.chatStream,
    streamStartedAt: state.chatStreamStartedAt,
    draft: state.chatMessage,
    queue: state.chatQueue,
    connected: state.connected,
    canSend: state.connected,
    error: state.lastError,
    sessions: state.sessionsResult,
    onRefresh: () => {
      state.resetToolStream();
      return Promise.all([
        loadChatHistory(state as unknown as Parameters<typeof loadChatHistory>[0]),
        refreshChatAvatar(state as unknown as Parameters<typeof refreshChatAvatar>[0]),
      ]).then(() => undefined);
    },
    onChatScroll: (event) => state.handleChatScroll(event),
    onDraftChange: (next) => (state.chatMessage = next),
    configuredModels: state.configuredModels,
    currentModel: state.currentModel,
    dirtyMeterSessions: state.dirtyMeterSessions,
    onModelChange: (modelKey) => state.handleModelChange(modelKey),
    thinkingToggleLevel: state.thinkingLevel,
    thinkingToggleLevels: state.thinkingLevels,
    isBinaryThinking: state.isBinaryThinking,
    onThinkingToggle: () => state.handleThinkingToggle(),
    onThinkingLevelChange: (level: string) => state.handleThinkingLevelChange(level),
    attachments: state.chatAttachments,
    onAttachmentsChange: (next) => {
      // 函数式更新基于当前 state 合并，避免异步回调闭包里的旧 attachments 覆盖新附件
      state.chatAttachments =
        typeof next === "function" ? next(state.chatAttachments ?? []) : next;
    },
    onShowToast: (message) => showToast(state, message),
    compactionCheckpoints: state.compactionCheckpoints,
    compactionCheckpointsKey: state.compactionCheckpointsKey ?? null,
    compactionCheckpointsLoading: state.compactionCheckpointsLoading,
    compactionCheckpointsError: state.compactionCheckpointsError,
    compactionBusyCheckpointId: state.compactionBusyCheckpointId,
    onOpenCompactionCheckpoints: () => {
      void loadCompactionCheckpoints(
        state as unknown as Parameters<typeof loadCompactionCheckpoints>[0],
        state.sessionKey,
      );
    },
    onRestoreCheckpoint: (checkpointId: string) => {
      void handleRestoreCheckpoint(state, checkpointId);
    },
    onBranchCheckpoint: (checkpointId: string) => {
      void handleBranchCheckpoint(state, checkpointId);
    },
    onSend: () => state.handleSendChat(),
    canAbort: Boolean(state.chatRunId),
    onAbort: () => void state.handleAbortChat(),
    onQueueRemove: (id) => state.removeQueuedMessage(id),
    onQueueEdit: (id, newText) => state.editQueuedMessage(id, newText),
    onQueueSendNow: (id) => void state.sendQueuedMessageNow(id),
    onNewSession: () => confirmAndCreateNewSession(state),
    showNewMessages: !state.chatUserNearBottom,
    onScrollToBottom: () => state.scrollToBottom(),
    sidebarOpen: state.sidebarOpen,
    sidebarContent: state.sidebarContent,
    sidebarError: state.sidebarError,
    splitRatio: state.splitRatio,
    onOpenSidebar: (content: string) => state.handleOpenSidebar(content),
    onCloseSidebar: () => state.handleCloseSidebar(),
    onSplitRatioChange: (ratio: number) => state.handleSplitRatioChange(ratio),
    assistantName: state.assistantName,
    assistantAvatar: state.assistantAvatar,
  };
}
