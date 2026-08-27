/**
 * 会话操作 —— 会话切换/新建/重命名/删除/回放等，供侧边栏与对话页共用。
 * 从 app-render.ts 抽出（阶段 16 架构重构），逻辑未变。
 */

import { parseAgentSessionKey } from "../../../src/routing/session-key.js";
import { refreshChat, refreshChatAvatar } from "./app-chat.ts";
import { loadChatHistory } from "./controllers/chat.ts";
import { patchSession, loadSessions } from "./controllers/sessions.ts";
import {
  branchCompactionCheckpoint,
  loadCompactionCheckpoints,
  restoreCompactionCheckpoint,
} from "./controllers/session-compaction.ts";
import { t } from "./i18n.ts";
import { applySessionKeyTransition } from "./session-transition.ts";
import {
  clearToleratedHiddenSession,
  isToleratedHiddenSession,
  tolerateHiddenSession,
} from "./session-jump.ts";
import { resolveVisibleSessionSelection } from "./session-visibility.ts";
import { pendingSessionLabels, removePendingSessionLabel } from "./session-pending.ts";
import { setCryoClawView } from "./app-view-switch.ts";
import { showConfirm } from "./views/confirm-dialog.ts";
import { showToast } from "./app-toast.ts";
import type { AppViewState } from "./app-view-state.ts";

const AVATAR_DATA_RE = /^data:/i;
const AVATAR_HTTP_RE = /^https?:\/\//i;

export function resolveAssistantAvatarUrl(state: AppViewState): string | undefined {
  const list = state.agentsList?.agents ?? [];
  const parsed = parseAgentSessionKey(state.sessionKey);
  const agentId = parsed?.agentId ?? state.agentsList?.defaultId ?? "main";
  const agent = list.find((entry) => entry.id === agentId);
  const identity = agent?.identity;
  const candidate = identity?.avatarUrl ?? identity?.avatar;
  if (!candidate) {
    return undefined;
  }
  if (AVATAR_DATA_RE.test(candidate) || AVATAR_HTTP_RE.test(candidate)) {
    return candidate;
  }
  return identity?.avatarUrl;
}

export function applySessionKey(state: AppViewState, next: string, syncUrl = false) {
  const changed = applySessionKeyTransition(
    state as unknown as Parameters<typeof applySessionKeyTransition>[0],
    next,
    syncUrl,
  );
  if (changed) {
    // 显式切换的会话可能不在可见列表（已归档/被过滤），记录容忍防 tick reconcile 弹回
    tolerateHiddenSession(next);
    // 清空回放点缓存，避免上一会话的 checkpoints 在新会话被误展示/误操作
    state.compactionCheckpoints = [];
    state.compactionCheckpointsKey = null;
    state.compactionCheckpointsLoading = false;
    state.compactionCheckpointsError = null;
    state.compactionBusyCheckpointId = null;
    void refreshChatAvatar(state as unknown as Parameters<typeof refreshChatAvatar>[0]);
    // 拉取最新 sessions 快照，让 context meter 立即反映新会话的 token 占用。
    void loadSessions(state);
  }
}

function resolveSessionOptionLabel(
  key: string,
  row?: (NonNullable<AppViewState["sessionsResult"]>["sessions"][number] | undefined),
): string {
  const displayName = typeof row?.displayName === "string" ? row.displayName.trim() : "";
  const label = typeof row?.label === "string" ? row.label.trim() : "";
  // 有别名时只显示别名，不附带 key
  if (label && label !== key) {
    return label;
  }
  if (displayName && displayName !== key) {
    return displayName;
  }
  return key;
}

export function resolveSessionOptions(
  state: AppViewState,
): Array<{ key: string; label: string; updatedAt?: number; pinned?: boolean; unread?: boolean; archived?: boolean }> {
  const sessions = state.sessionsResult?.sessions ?? [];
  const seen = new Set<string>();
  const options: Array<{ key: string; label: string; updatedAt?: number; pinned?: boolean; unread?: boolean; archived?: boolean }> = [];

  const pushOption = (
    key: string,
    row?: NonNullable<AppViewState["sessionsResult"]>["sessions"][number],
    isCurrentSession = false,
  ) => {
    const trimmedKey = String(key || "").trim();
    if (!trimmedKey || seen.has(trimmedKey)) {
      return;
    }
    seen.add(trimmedKey);
    // 当前活跃会话若无 updatedAt，视为"刚刚使用"排到最前
    options.push({
      key: trimmedKey,
      label: resolveSessionOptionLabel(trimmedKey, row),
      updatedAt: row?.updatedAt ?? (isCurrentSession ? Date.now() : undefined),
      pinned: row?.pinned === true,
      unread: row?.unread === true,
      archived: row?.archived === true,
    });
  };

  const current = state.sessionKey?.trim() || "main";
  const currentSession = sessions.find((entry) => entry.key === current);
  if (currentSession) {
    pushOption(current, currentSession, true);
  }
  for (const session of sessions) {
    pushOption(session.key, session);
  }

  // 置顶会话在最前，其余按 updatedAt 降序（最近使用的在前，无时间戳的在末尾）
  options.sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });

  // 归档视图：内核 archived=true 仅返回已归档；正常视图兜底再过滤一次归档项
  // （归档开关切换瞬间列表可能还是旧数据，避免闪现错误集合）
  const showArchived = state.sessionsIncludeArchived === true;
  const archivedFiltered = options.filter((o) =>
    showArchived ? o.archived === true : o.archived !== true,
  );

  // 搜索过滤（客户端，匹配显示名或 key，不区分大小写）
  const search = (state.sidebarSessionSearch ?? "").trim().toLowerCase();
  if (!search) {
    return archivedFiltered;
  }
  return archivedFiltered.filter(
    (o) => o.label.toLowerCase().includes(search) || o.key.toLowerCase().includes(search),
  );
}

export function reconcileVisibleSession(state: AppViewState) {
  if (!state.sessionsResult) {
    return;
  }
  // 显式跳转到的隐藏会话（已归档/被过滤）豁免 reconcile，防 tick 弹回 main
  if (isToleratedHiddenSession(state.sessionKey)) {
    return;
  }
  const next = resolveVisibleSessionSelection(state.sessionKey, state.hello, state.sessionsResult);
  if (!next || next === state.sessionKey) {
    return;
  }
  applySessionKey(state, next, true);
}

// 侧边栏点击会话：切换 session 并确保回到对话视图
export function handleSessionChange(state: AppViewState, nextSessionKey: string) {
  if (!nextSessionKey.trim()) {
    return;
  }
  setCryoClawView(state, "chat");
  applySessionKey(state, nextSessionKey, true);
}

// 侧边栏重命名回调：修改会话 label 后刷新列表
export async function patchSessionFromSidebar(state: AppViewState, key: string, newLabel: string) {
  await patchSession(state, key, { label: newLabel || null });
}

// 正在删除的 session key —— 侧边栏 per-row spinner 状态
const deletingSessionKeys = new Set<string>();

export function isDeletingSession(key: string): boolean {
  return deletingSessionKeys.has(key);
}

// 侧边栏删除回调：同步走完 reset + delete，期间该行按钮显示 loading。
export async function deleteSessionFromSidebar(state: AppViewState, key: string) {
  if (!state.client || !state.connected) return;
  if (deletingSessionKeys.has(key)) return;

  const confirmed = await showConfirm(state, t("sidebar.deleteSession"), { danger: true });
  if (!confirmed) return;

  deletingSessionKeys.add(key);
  state.requestUpdate();

  try {
    // 1) reset：触发 session-memory hook 归档对话摘要；gateway 不认识时忽略。
    try {
      await state.client.request("sessions.reset", { key, reason: "new" });
    } catch {
      // 本地独有会话（新建未发消息）gateway 不可见，跳过
    }

    // 2) delete：移除 sessions.json 条目并归档 transcript。
    try {
      await state.client.request("sessions.delete", { key, deleteTranscript: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/session not found|unknown session/i.test(msg)) {
        showToast(state, `${t("sidebar.deleteSessionFailed")}: ${msg}`);
        return;
      }
      // not-found 视作等效成功，继续刷新
    }

    // 3) 成功：全量刷新侧边栏；reconcileVisibleSession 会在活跃会话被删时切到下一个可见会话。
    removePendingSessionLabel(key);
    // 被删的若是显式跳转容忍的会话，清除容忍让 reconcile 正常切走
    clearToleratedHiddenSession(key);
    await loadSessions(state);
    reconcileVisibleSession(state);
  } finally {
    deletingSessionKeys.delete(key);
    state.requestUpdate();
  }
}

// 回放（rewind）：二次确认后把当前会话回退到选中回放点，成功后刷新会话历史
// 成功后：收起回放 popover、刷新回放点列表与侧边栏（R14）
export async function handleRestoreCheckpoint(state: AppViewState, checkpointId: string) {
  const confirmed = await showConfirm(state, t("chat.rewind.confirmRestore"), { danger: true });
  if (!confirmed) return;
  // 用 checkpoints 加载时的 sessionKey（而非当前 key），避免会话已切换后误操作别的会话
  const key = typeof state.compactionCheckpointsKey === "string" ? state.compactionCheckpointsKey : state.sessionKey;
  const ok = await restoreCompactionCheckpoint(state, key, checkpointId);
  if (ok) {
    showToast(state, t("chat.rewind.restoreSuccess"));
    // 回放会改写 transcript，复用 loadChatHistory 路径刷新当前会话历史
    await loadChatHistory(state as unknown as Parameters<typeof loadChatHistory>[0]);
    closeCompactionPopoverAndRefresh(state, key);
    await loadSessions(state);
  } else {
    const err = state.compactionCheckpointsError;
    showToast(state, err ? `${t("chat.rewind.restoreFailed")}: ${err}` : t("chat.rewind.restoreFailed"));
  }
}

// 回放/分支成功后的收尾：收起 popover（DOM 类）+ 重拉回放点列表
function closeCompactionPopoverAndRefresh(state: AppViewState, key: string) {
  document
    .querySelector<HTMLElement>(".chat-compose__rewind-popover--open")
    ?.classList.remove("chat-compose__rewind-popover--open");
  void loadCompactionCheckpoints(
    state as unknown as Parameters<typeof loadCompactionCheckpoints>[0],
    key,
  );
}

// 分支（fork）：从选中回放点分叉出新会话，成功后切换到新会话
export async function handleBranchCheckpoint(state: AppViewState, checkpointId: string) {
  // 同 restore：用 checkpoints 加载时的 sessionKey，避免会话切换后从错误的会话分叉
  const key = typeof state.compactionCheckpointsKey === "string" ? state.compactionCheckpointsKey : state.sessionKey;
  const nextKey = await branchCompactionCheckpoint(state, key, checkpointId);
  if (nextKey) {
    showToast(state, t("chat.rewind.branchSuccess"));
    closeCompactionPopoverAndRefresh(state, key);
    // 先刷新会话列表让新会话出现在侧边栏，再切换过去
    await loadSessions(state);
    handleSessionChange(state, nextKey);
  } else {
    const err = state.compactionCheckpointsError;
    showToast(state, err ? `${t("chat.rewind.branchFailed")}: ${err}` : t("chat.rewind.branchFailed"));
  }
}

// 新建会话：同步写入本地列表后再切换，异步同步到 Gateway 供跨终端访问
export function createNewSession(state: AppViewState) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // agentId 与 resolveAgentIdForSession 同一套 fallback：当前会话 key 解析 → hello 快照默认 agent → "main"
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: { defaultAgentId?: string } }
    | undefined;
  const agentId =
    parseAgentSessionKey(state.sessionKey)?.agentId ??
    snapshot?.sessionDefaults?.defaultAgentId?.trim() ??
    "main";
  const newKey = `agent:${agentId || "main"}:${id}`;
  const label = t("chat.newSession");
  setCryoClawView(state, "chat");
  // 先把新会话插入本地列表，UI 立即可见正确的名称
  const sessions = state.sessionsResult?.sessions ?? [];
  state.sessionsResult = {
    ...state.sessionsResult,
    sessions: [{ key: newKey, label, updatedAt: Date.now() }, ...sessions],
  };
  applySessionKey(state, newKey, true);
  // 新建会话时重置模型选择为默认
  state.resetModelToDefault();
  // 标记为待自动命名。label 将在首条消息发送 + chat.event final 后持久化到 gateway。
  pendingSessionLabels.set(newKey, label);
}

export async function confirmAndCreateNewSession(state: AppViewState) {
  const ok = await showConfirm(state, t("chat.confirmNewSession"));
  if (!ok) {
    return;
  }
  setCryoClawView(state, "chat");
  return state.handleSendChat("/new", { restoreDraft: true });
}

// 断开连接时尝试重连，3 秒后仍失败则弹窗询问是否重启 Gateway
export function handleReconnect(state: AppViewState) {
  state.client?.reconnectNow();
  setTimeout(() => {
    if (!state.connected) {
      state.showRestartGatewayDialog = true;
    }
  }, 3000);
}

export async function handleOpenWebUI(state: AppViewState) {
  if (window.cryoclaw?.openWebUI) {
    window.cryoclaw.openWebUI();
  } else if (window.cryoclaw?.openExternal) {
    let port = 18789;
    try {
      if (window.cryoclaw.getGatewayPort) {
        port = await window.cryoclaw.getGatewayPort();
      }
    } catch { /* use default */ }
    const token = state.settings.token.trim();
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    window.cryoclaw.openExternal(`http://127.0.0.1:${port}/${query}`);
  }
}

// 文件拖拽/粘贴事件桥接
let fileDropBound = false;

export function ensureFileDropBridge(state: AppViewState) {
  if (fileDropBound) return;
  fileDropBound = true;
  let latestState = state;
  // 更新引用以便事件回调能访问最新的 state
  (window as unknown as { __cryoclawFileDropState?: { update: (s: AppViewState) => void } }).__cryoclawFileDropState = {
    update: (s: AppViewState) => { latestState = s; },
  };
  window.addEventListener("cryoclaw:file-drop", ((e: CustomEvent<{ paths: string[] }>) => {
    const current = latestState.chatAttachments ?? [];
    const additions = e.detail.paths.map((p: string) => ({
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      filePath: p,
      name: p.split(/[/\\]/).pop() || p,
    }));
    latestState.chatAttachments = [...current, ...additions];
  }) as EventListener);
}

export function updateFileDropState(state: AppViewState) {
  (window as unknown as { __cryoclawFileDropState?: { update: (s: AppViewState) => void } })
    .__cryoclawFileDropState?.update(state);
}
