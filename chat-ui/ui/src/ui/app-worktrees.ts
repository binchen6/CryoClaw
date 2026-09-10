/**
 * Worktrees 管理视图 —— 入口与 props 构建。
 * 模式同 app-tasks.ts：open 负责切视图 + 首拉，render 只做 props 组装。
 * R58：新增手动创建面板（worktrees.create / worktrees.branches RPC）；
 * owner 会话有活跃任务的 worktree 禁止删除（删除守卫与会话删除同规则）。
 */

import { renderWorktrees } from "./views/worktrees.ts";
import { showConfirm } from "./views/confirm-dialog.ts";
import {
  createWorktree,
  gcWorktrees,
  isValidWorktreeName,
  listWorktreeBranches,
  loadWorktrees,
  removeWorktree,
  resolveWorktreeRepoRootCandidates,
  restoreWorktree,
  type WorktreeBranch,
} from "./controllers/worktrees.ts";
import { findActiveTaskForSession } from "./controllers/tasks.ts";
import { workspaceViewState } from "./controllers/workspace.ts";
import { showToast } from "./app-toast.ts";
import { t, tWithDetail } from "./i18n.ts";
import { handleSessionChange } from "./app-session-actions.ts";
import type { AppViewState } from "./app-view-state.ts";

async function confirmAndRemoveWorktree(state: AppViewState, id: string) {
  // R58 删除守卫：owner 会话有 queued/running 任务时禁止删除
  const target = state.worktrees.find((w) => w.id === id);
  if (target?.ownerKind === "session" && target.ownerId) {
    if (findActiveTaskForSession(state.tasks ?? [], target.ownerId)) {
      showToast(state, t("worktrees.removeBlockedByTask"));
      return;
    }
  }
  // 内核删除时有未提交改动会自动先快照（可 restore），确认文案已说明
  const confirmed = await showConfirm(state, t("worktrees.removeConfirm"), { danger: true });
  if (!confirmed) return;
  const ok = await removeWorktree(state, id);
  showToast(
    state,
    ok ? t("worktrees.removed") : tWithDetail("worktrees.removeFailed", state.worktreesError),
  );
}

async function confirmAndRestoreWorktree(state: AppViewState, id: string) {
  const confirmed = await showConfirm(state, t("worktrees.restoreConfirm"));
  if (!confirmed) return;
  const ok = await restoreWorktree(state, id);
  showToast(
    state,
    ok ? t("worktrees.restored") : tWithDetail("worktrees.restoreFailed", state.worktreesError),
  );
}

async function confirmAndGcWorktrees(state: AppViewState) {
  const confirmed = await showConfirm(state, t("worktrees.gcConfirm"), { danger: true });
  if (!confirmed) return;
  const res = await gcWorktrees(state);
  showToast(
    state,
    res
      ? t("worktrees.gcDone")
          .replace("{removed}", String(res.removed.length))
          .replace("{orphans}", String(res.orphansDeleted))
          .replace("{snapshots}", String(res.snapshotsPruned))
      : tWithDetail("worktrees.gcFailed", state.worktreesError),
  );
}

/* ── R58：手动创建面板（模块级轻量状态，render 驱动重绘） ── */

interface WorktreeCreateState {
  open: boolean;
  name: string;
  baseRef: string;
  repoRoot: string;
  branches: WorktreeBranch[] | null;
  branchesLoading: boolean;
  creating: boolean;
  error: string | null;
}

const createState: WorktreeCreateState = {
  open: false,
  name: "",
  baseRef: "",
  repoRoot: "",
  branches: null,
  branchesLoading: false,
  creating: false,
  error: null,
};

function repoRootCandidates(state: AppViewState): string[] {
  return resolveWorktreeRepoRootCandidates(state.worktrees ?? [], workspaceViewState.root);
}

// 分支列表加载序号：repoRoot 切换后旧响应不得落入新仓库
let createBranchSeq = 0;

async function loadCreateBranches(state: AppViewState) {
  if (!state.client || !state.connected || !createState.repoRoot) return;
  const seq = ++createBranchSeq;
  createState.branchesLoading = true;
  createState.error = null;
  state.requestUpdate();
  try {
    const res = await listWorktreeBranches(state, createState.repoRoot);
    if (seq !== createBranchSeq) return;
    createState.branches = res?.branches ?? [];
  } catch (err) {
    if (seq !== createBranchSeq) return;
    // 分支列表是辅助数据：失败不阻断创建（仍可留空用默认基线）
    createState.branches = [];
    createState.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === createBranchSeq) createState.branchesLoading = false;
  }
}

function toggleCreatePanel(state: AppViewState) {
  createState.open = !createState.open;
  createState.error = null;
  if (createState.open) {
    const candidates = repoRootCandidates(state);
    createState.repoRoot = candidates[0] ?? "";
    createState.name = "";
    createState.baseRef = "";
    createState.branches = null;
    if (createState.repoRoot) void loadCreateBranches(state).then(() => state.requestUpdate());
  }
  state.requestUpdate();
}

async function submitCreateWorktree(state: AppViewState) {
  // state.connected 必须显式校验：createWorktree 在断连时直接 return null（什么都不做），
  // 而面板提交按钮不看连接状态——按下去会弹「已创建」成功 toast 却什么都没发生（R67）。
  if (createState.creating || !state.connected || !isValidWorktreeName(createState.name) || !createState.repoRoot) return;
  createState.creating = true;
  createState.error = null;
  try {
    const res = await createWorktree(state, {
      repoRoot: createState.repoRoot,
      name: createState.name,
      baseRef: createState.baseRef || undefined,
    });
    if (!res) {
      // 断连/空响应：不关面板、不报成功
      createState.error = t("worktrees.createFailed");
      return;
    }
    createState.open = false;
    createState.name = "";
    createState.baseRef = "";
    showToast(
      state,
      res.worktree?.branch
        ? t("worktrees.created").replace("{branch}", res.worktree.branch)
        : t("worktrees.createdPlain"),
    );
  } catch (err) {
    createState.error = err instanceof Error ? err.message : String(err);
  } finally {
    createState.creating = false;
  }
}

export function renderWorktreesView(
  state: AppViewState,
  opts?: { compact?: boolean; onSelectRepo?: (path: string) => void },
) {
  // owner 会话有活跃任务的 worktree：删除按钮禁用
  const blockedIds = new Set<string>();
  for (const w of state.worktrees) {
    if (w.ownerKind === "session" && w.ownerId && findActiveTaskForSession(state.tasks ?? [], w.ownerId)) {
      blockedIds.add(w.id);
    }
  }
  return renderWorktrees(
    {
      loading: state.worktreesLoading,
      error: state.worktreesError,
      worktrees: state.worktrees,
      busyIds: state.worktreesBusyIds,
      blockedIds,
      gcBusy: state.worktreesGcBusy,
      connected: state.connected,
      gitAvailable: state.gitAvailable,
      createOpen: createState.open,
      createName: createState.name,
      createBaseRef: createState.baseRef,
      createRepoRoot: createState.repoRoot,
      createRepoOptions: repoRootCandidates(state),
      createBranches: createState.branches,
      createBranchesLoading: createState.branchesLoading,
      creating: createState.creating,
      createError: createState.error,
      onRefresh: () => {
        void loadWorktrees(state);
      },
      onGc: () => {
        void confirmAndGcWorktrees(state);
      },
      onRemove: (id) => {
        void confirmAndRemoveWorktree(state, id);
      },
      onRestore: (id) => {
        void confirmAndRestoreWorktree(state, id);
      },
      onOpenFolder: (wtPath) => {
        void window.cryoclaw?.workspaceOpenFolder?.(wtPath);
      },
      onOpenChat: (sessionKey) => {
        // 走完整会话切换，与侧边栏点击一致
        handleSessionChange(state, sessionKey);
      },
      onSelectRepo: opts?.onSelectRepo,
      onToggleCreate: () => toggleCreatePanel(state),
      onCreateNameChange: (value) => {
        createState.name = value;
        state.requestUpdate();
      },
      onCreateBaseRefChange: (value) => {
        createState.baseRef = value;
        state.requestUpdate();
      },
      onCreateRepoChange: (value) => {
        createState.repoRoot = value;
        createState.branches = null;
        state.requestUpdate();
        void loadCreateBranches(state).then(() => state.requestUpdate());
      },
      onCreateSubmit: () => {
        void submitCreateWorktree(state).then(() => state.requestUpdate());
      },
    },
    { compact: opts?.compact === true },
  );
}
