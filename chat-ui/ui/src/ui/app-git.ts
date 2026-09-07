/**
 * Git 面板 —— 入口与 props 构建（P4 文件级 + R58 分支/历史/推拉/丢弃）。
 * 模式同 app-worktrees.ts：open 负责切视图 + 初始化，render 只做 props 组装。
 */

import { renderGitPanel } from "./views/git.ts";
import {
  checkoutGitBranch,
  cleanGitFiles,
  commitGitChanges,
  discardGitFiles,
  loadGitLog,
  pullGitChanges,
  pushGitChanges,
  refreshGitStatus,
  selectGitFile,
  selectGitRepo,
  stageGitFiles,
  toggleGitBranchPanel,
  unstageGitFiles,
} from "./controllers/git.ts";
import { showConfirm } from "./views/confirm-dialog.ts";
import { showToast } from "./app-toast.ts";
import { t, tWithDetail } from "./i18n.ts";
import type { AppViewState } from "./app-view-state.ts";

async function confirmAndDiscard(state: AppViewState, paths: string[]) {
  const confirmed = await showConfirm(
    state,
    paths.length === 1
      ? t("git.discardConfirmOne").replace("{path}", paths[0])
      : t("git.discardConfirmMany").replace("{count}", String(paths.length)),
    { danger: true },
  );
  if (!confirmed) return;
  const ok = await discardGitFiles(state, paths);
  showToast(state, ok ? t("git.discarded") : tWithDetail("git.opFailed", state.gitErrorDetail));
}

async function confirmAndClean(state: AppViewState, paths: string[]) {
  const confirmed = await showConfirm(
    state,
    paths.length === 1
      ? t("git.cleanConfirmOne").replace("{path}", paths[0])
      : t("git.cleanConfirmMany").replace("{count}", String(paths.length)),
    { danger: true },
  );
  if (!confirmed) return;
  const ok = await cleanGitFiles(state, paths);
  showToast(state, ok ? t("git.cleaned") : tWithDetail("git.opFailed", state.gitErrorDetail));
}

export function renderGitView(state: AppViewState, opts?: { showRepoSelect?: boolean }) {
  return renderGitPanel({
    gitAvailable: state.gitAvailable,
    connected: state.connected,
    repoOptions: state.gitRepoOptions,
    repoPath: state.gitRepoPath,
    loading: state.gitStatusLoading,
    repoState: state.gitRepoState,
    errorKind: state.gitErrorKind,
    errorDetail: state.gitErrorDetail,
    status: state.gitStatus,
    selectedFile: state.gitSelectedFile,
    diffFiles: state.gitDiffFiles,
    diffLoading: state.gitDiffLoading,
    statusTruncated: state.gitStatusTruncated,
    diffTruncated: state.gitDiffTruncated,
    busyPaths: state.gitBusyPaths,
    commitMessage: state.gitCommitMessage,
    committing: state.gitCommitting,
    branches: state.gitBranches,
    branchesLoading: state.gitBranchesLoading,
    branchPanelOpen: state.gitBranchPanelOpen,
    checkingOutBranch: state.gitCheckingOutBranch,
    log: state.gitLog,
    logLoading: state.gitLogLoading,
    networkBusy: state.gitNetworkBusy,
    onRepoChange: (path) => {
      void selectGitRepo(state, path);
    },
    onRefresh: () => {
      void refreshGitStatus(state).then(() => loadGitLog(state));
    },
    onSelectFile: (side, path) => {
      void selectGitFile(state, side, path);
    },
    onStage: (paths) => {
      void stageGitFiles(state, paths);
    },
    onUnstage: (paths) => {
      void unstageGitFiles(state, paths);
    },
    onCommitMessageChange: (value) => {
      state.gitCommitMessage = value;
    },
    onCommit: () => {
      void commitGitChanges(state).then((ok) => {
        if (ok) {
          showToast(state, t("git.committed"));
          void loadGitLog(state);
        }
      });
    },
    onToggleBranchPanel: () => {
      toggleGitBranchPanel(state);
    },
    onCheckoutBranch: (branch) => {
      void checkoutGitBranch(state, branch).then((ok) => {
        if (ok) showToast(state, t("git.checkedOut").replace("{branch}", branch));
      });
    },
    onPush: () => {
      void pushGitChanges(state).then((ok) => {
        showToast(
          state,
          ok
            ? t("git.pushed")
            : state.gitErrorDetail === "no-branch"
              ? t("git.pushNoBranch")
              : tWithDetail("git.pushFailed", state.gitErrorDetail),
        );
      });
    },
    onPull: () => {
      void pullGitChanges(state).then((ok) => {
        showToast(state, ok ? t("git.pulled") : tWithDetail("git.pullFailed", state.gitErrorDetail));
      });
    },
    onDiscard: (paths) => {
      void confirmAndDiscard(state, paths);
    },
    onClean: (paths) => {
      void confirmAndClean(state, paths);
    },
  }, opts);
}
