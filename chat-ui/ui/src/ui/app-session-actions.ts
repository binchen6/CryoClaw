/**
 * 会话操作 —— 会话切换/新建/重命名/删除等，供侧边栏与对话页共用。
 * 从 app-render.ts 抽出（阶段 16 架构重构），逻辑未变。
 */

import { parseAgentSessionKey } from "../../../src/routing/session-key.js";
import { refreshChat, refreshChatAvatar } from "./app-chat.ts";
import { loadChatHistory } from "./controllers/chat.ts";
import { patchSession, loadSessions } from "./controllers/sessions.ts";
import {
  forkSessionFromEntry,
  loadSessionBranches,
  rewindSessionToEntry,
  switchSessionBranchTo,
  type SessionEditorRestore,
} from "./controllers/session-branches.ts";
import { findActiveTaskForSession } from "./controllers/tasks.ts";
import {
  buildWorktreeSessionMap,
  isNotGitCheckoutError,
  loadWorktrees,
} from "./controllers/worktrees.ts";
import { t } from "./i18n.ts";
import {
  applySessionKeyTransition,
  clearSessionDraftSnapshot,
  seedSessionDraftSnapshot,
} from "./session-transition.ts";
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
    // 清空分支缓存，避免上一会话的分支列表在新会话被误展示/误操作
    state.sessionBranches = [];
    state.sessionBranchesKey = null;
    state.sessionBranchesLoading = false;
    state.sessionBranchesError = null;
    state.branchBusyAction = null;
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
): Array<{ key: string; label: string; updatedAt?: number; pinned?: boolean; unread?: boolean; archived?: boolean; worktreeBranch?: string }> {
  const sessions = state.sessionsResult?.sessions ?? [];
  // sessions.list 行不投影 worktree 字段，徽标数据从 worktrees.list 的 ownerId 反推
  const worktreeBySession = buildWorktreeSessionMap(state.worktrees ?? []);
  const seen = new Set<string>();
  const options: Array<{ key: string; label: string; updatedAt?: number; pinned?: boolean; unread?: boolean; archived?: boolean; worktreeBranch?: string }> = [];

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
      worktreeBranch: worktreeBySession.get(trimmedKey)?.branch,
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

// 侧边栏会话属性变更（重命名/置顶/未读/归档）。
// patchSession 失败时只把错误写进 state.sessionsError，而没有任何视图消费它——
// 用户点了重命名/置顶/归档会看起来"毫无反应"（R67）。此处统一 toast 失败。
export async function patchSessionFromSidebar(
  state: AppViewState,
  key: string,
  patch: { label?: string | null; pinned?: boolean; unread?: boolean; archived?: boolean },
) {
  const ok = await patchSession(state, key, patch);
  if (!ok) showToast(state, t("sidebar.patchFailed"));
}

// 正在删除的 session key —— 侧边栏 per-row spinner 状态
const deletingSessionKeys = new Set<string>();

export function isDeletingSession(key: string): boolean {
  return deletingSessionKeys.has(key);
}

// 侧边栏删除回调：同步走完 reset + delete，期间该行按钮显示 loading。
// R58 守卫：会话有 queued/running 任务时禁止删除（删除会连坐 transcript 与 worktree）。
export async function deleteSessionFromSidebar(state: AppViewState, key: string) {
  if (!state.client || !state.connected) return;
  if (deletingSessionKeys.has(key)) return;

  const activeTask = findActiveTaskForSession(state.tasks ?? [], key);
  if (activeTask) {
    showToast(state, t("sidebar.deleteBlockedByTask"));
    return;
  }

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

    // 2.5) worktree 会话：附带删除其持有的 worktree（有改动时内核自动快照，可恢复）。
    // 内核 sessions.delete 已对无损 worktree 做过 removeIfLossless，这里兜底有损场景；
    // 已被内核删掉的会让 worktrees.remove 报错，吞掉即可。
    const worktreeMap = buildWorktreeSessionMap(state.worktrees ?? []);
    let ownedWorktree = worktreeMap.get(key);
    if (!ownedWorktree) {
      // map miss 兜底：内核 ownerId 记的是 canonical key（规范大小写/空白），
      // 侧边栏 key 可能与之有大小写差异（如渠道会话），按 canonical 形式再查一次
      const canonical = key.trim().toLowerCase();
      for (const [ownerKey, w] of worktreeMap) {
        if (ownerKey.trim().toLowerCase() === canonical) {
          ownedWorktree = w;
          break;
        }
      }
    }
    if (ownedWorktree) {
      try {
        await state.client.request("worktrees.remove", { id: ownedWorktree.id });
      } catch {
        // 内核已清理 / worktree 已不存在：忽略
      }
      void loadWorktrees(state);
    }

    // 3) 成功：全量刷新侧边栏；reconcileVisibleSession 会在活跃会话被删时切到下一个可见会话。
    removePendingSessionLabel(key);
    // 同步清理该会话的草稿快照，防同名 key 复用时复活旧草稿
    clearSessionDraftSnapshot(key);
    // 被删的若是显式跳转容忍的会话，清除容忍让 reconcile 正常切走
    clearToleratedHiddenSession(key);
    await loadSessions(state);
    reconcileVisibleSession(state);
  } finally {
    deletingSessionKeys.delete(key);
    state.requestUpdate();
  }
}

// ── 会话分支（内核 2026.9.7 branch tree：rewind / fork / switch）─────────────
// transcript 是一棵树，可见历史 = active path。rewind 非破坏：被回退的内容保留为
// 可切换分支；fork 从所选消息分叉全新会话；switch 把 active path 切到指定分支 tip。

// 内核 editorAttachments（base64 图片）→ 输入框附件（dataUrl 形态，与粘贴路径同构）
function editorAttachmentsToChatAttachments(
  attachments: SessionEditorRestore["editorAttachments"],
): AppViewState["chatAttachments"] {
  if (!attachments?.length) return [];
  const stamp = Date.now();
  return attachments.map((a, i) => ({
    id: `att-${stamp}-${i}-${Math.random().toString(36).slice(2, 7)}`,
    type: "image",
    mimeType: a.mimeType,
    dataUrl: `data:${a.mimeType};base64,${a.data}`,
  }));
}

// 回退（编辑重发）：该用户消息及其之后移出 active path（保留为分支），
// 消息文本/图片回填输入框，随后整段替换语义刷新历史
export async function handleRewindToMessage(state: AppViewState, entryId: string) {
  if (!state.client || !state.connected || state.branchBusyAction) return;
  const key = state.sessionKey;
  const restored = await rewindSessionToEntry(state, key, entryId);
  // RPC await 期间用户可能已切走：续体必须归属校验，防止把 A 会话的消息
  // 内容写进 B 会话的输入框（branchBusyAction 已被会话切换清空，这里是唯一防线）
  if (state.sessionKey !== key) return;
  if (!restored) {
    const err = state.sessionBranchesError;
    showToast(state, err ? `${t("chat.rewind.failed")}: ${err}` : t("chat.rewind.failed"));
    return;
  }
  showToast(state, t("chat.rewind.success"));
  // 编辑重发语义：草稿替换为被回退消息的文本（无文本时保留用户已有草稿不被清空）
  if (restored.editorText) {
    state.chatMessage = restored.editorText;
  }
  state.chatAttachments = [
    ...state.chatAttachments,
    ...editorAttachmentsToChatAttachments(restored.editorAttachments),
  ];
  await loadChatHistory(state as unknown as Parameters<typeof loadChatHistory>[0]);
  void loadSessionBranches(state, key);
  void loadSessions(state);
}

// 分叉：从所选用户消息创建新会话（prefix 截止到该消息之前），文本/图片预填新会话输入框
export async function handleForkFromMessage(state: AppViewState, entryId: string) {
  if (!state.client || !state.connected || state.branchBusyAction) return;
  const key = state.sessionKey;
  const res = await forkSessionFromEntry(state, key, entryId);
  // await 期间用户切走则放弃跳转：seed 快照按 key 归属保留，用户之后手动切到
  // fork 会话时仍能一次性恢复预填内容
  if (state.sessionKey !== key) return;
  if (!res?.sessionKey) {
    const err = state.sessionBranchesError;
    showToast(state, err ? `${t("chat.fork.failed")}: ${err}` : t("chat.fork.failed"));
    return;
  }
  showToast(state, t("chat.fork.success"));
  seedSessionDraftSnapshot(
    res.sessionKey,
    res.editorText ?? "",
    editorAttachmentsToChatAttachments(res.editorAttachments),
  );
  // 先刷新会话列表让新会话出现在侧边栏，再切换过去
  await loadSessions(state);
  handleSessionChange(state, res.sessionKey);
}

// 分支切换：把 active path 切到指定分支 tip。用 branches 加载时的 sessionKey
// （而非当前 key），避免会话已切换后误操作别的会话
export async function handleSwitchBranch(state: AppViewState, leafEntryId: string) {
  if (!state.client || !state.connected || state.branchBusyAction) return;
  const key =
    typeof state.sessionBranchesKey === "string" ? state.sessionBranchesKey : state.sessionKey;
  const ok = await switchSessionBranchTo(state, key, leafEntryId);
  if (ok) {
    showToast(state, t("chat.branch.switchSuccess"));
    closeBranchPopoverAndRefresh(state, key);
    await loadChatHistory(state as unknown as Parameters<typeof loadChatHistory>[0]);
    await loadSessions(state);
  } else {
    const err = state.sessionBranchesError;
    showToast(state, err ? `${t("chat.branch.switchFailed")}: ${err}` : t("chat.branch.switchFailed"));
  }
}

// 切换成功后的收尾：收起分支 popover（DOM 类）+ 重拉分支列表
function closeBranchPopoverAndRefresh(state: AppViewState, key: string) {
  document
    .querySelector<HTMLElement>(".chat-compose__branch-popover--open")
    ?.classList.remove("chat-compose__branch-popover--open");
  void loadSessionBranches(state, key);
}

// 新建会话：同步写入本地列表后再切换，异步同步到 Gateway 供跨终端访问
export function createNewSession(state: AppViewState) {
  const newKey = resolveNewSessionKey(state);
  adoptNewSession(state, newKey);
}

// 新会话落本地并切换：先把新会话插入本地列表（UI 立即可见正确的名称），
// 再切 key、重置模型选择为默认，最后标记为待自动命名
// （label 将在首条消息发送 + chat.event final 后持久化到 gateway）
function adoptNewSession(state: AppViewState, newKey: string) {
  const label = t("chat.newSession");
  setCryoClawView(state, "chat");
  const sessions = state.sessionsResult?.sessions ?? [];
  state.sessionsResult = {
    ...state.sessionsResult,
    sessions: [{ key: newKey, label, updatedAt: Date.now() }, ...sessions],
  };
  applySessionKey(state, newKey, true);
  state.resetModelToDefault();
  pendingSessionLabels.set(newKey, label);
}

// 新会话 key：与 resolveAgentIdForSession 同一套 fallback（当前会话 key 解析 → hello 默认 agent → "main"）
function resolveNewSessionKey(state: AppViewState): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: { defaultAgentId?: string } }
    | undefined;
  const agentId =
    parseAgentSessionKey(state.sessionKey)?.agentId ??
    snapshot?.sessionDefaults?.defaultAgentId?.trim() ??
    "main";
  return `agent:${agentId || "main"}:${id}`;
}

// 在隔离 worktree 中新建会话：内核 sessions.create {worktree:true} 自动 provision
// worktree（落 ~/.openclaw/worktrees/），失败时内核自己回滚 worktree。
export async function createNewWorktreeSession(state: AppViewState) {
  if (!state.client || !state.connected) {
    return;
  }
  const newKey = resolveNewSessionKey(state);
  const agentId = parseAgentSessionKey(newKey)?.agentId ?? "main";
  let createdWorktree: { id: string; path: string; branch: string } | undefined;
  try {
    const res = await state.client.request<{ worktree?: { id: string; path: string; branch: string } }>(
      "sessions.create",
      { key: newKey, agentId, worktree: true },
    );
    createdWorktree = res?.worktree;
  } catch (err) {
    // agent workspace 不是 git 仓库是最典型失败：引导用户先指向 git 仓库
    showToast(
      state,
      isNotGitCheckoutError(err)
        ? t("worktrees.notGitCheckout")
        : `${t("worktrees.createFailed")}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  adoptNewSession(state, newKey);
  // 内核已建会话与 worktree：刷新列表让徽标/管理视图立即反映
  void loadSessions(state);
  void loadWorktrees(state);
  if (createdWorktree) {
    showToast(state, `${t("worktrees.newSessionCreated")}: ${createdWorktree.branch}`);
  }
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
