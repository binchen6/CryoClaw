/**
 * Worktrees 管理视图 —— 入口与 props 构建。
 * 模式同 app-tasks.ts：open 负责切视图 + 首拉，render 只做 props 组装。
 */

import { renderWorktrees } from "./views/worktrees.ts";
import { showConfirm } from "./views/confirm-dialog.ts";
import {
  gcWorktrees,
  loadWorktrees,
  removeWorktree,
  restoreWorktree,
} from "./controllers/worktrees.ts";
import { setCryoClawView } from "./app-view-switch.ts";
import { showToast } from "./app-toast.ts";
import { t, tWithDetail } from "./i18n.ts";
import { handleSessionChange } from "./app-session-actions.ts";
import type { AppViewState } from "./app-view-state.ts";

// 打开 worktree 管理视图
export function openWorktreesView(state: AppViewState) {
  setCryoClawView(state, "worktrees");
  void loadWorktrees(state);
}

async function confirmAndRemoveWorktree(state: AppViewState, id: string) {
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
      ? tWithDetail(
          "worktrees.gcDone",
          `${res.removed.length} removed · ${res.orphansDeleted} orphans · ${res.snapshotsPruned} snapshots`,
        )
      : tWithDetail("worktrees.gcFailed", state.worktreesError),
  );
}

export function renderWorktreesView(state: AppViewState) {
  return renderWorktrees({
    loading: state.worktreesLoading,
    error: state.worktreesError,
    worktrees: state.worktrees,
    busyIds: state.worktreesBusyIds,
    gcBusy: state.worktreesGcBusy,
    connected: state.connected,
    gitAvailable: state.gitAvailable,
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
  });
}
