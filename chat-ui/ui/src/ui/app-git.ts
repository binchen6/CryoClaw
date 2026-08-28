/**
 * Git 面板 —— 入口与 props 构建（P4，文件级 v1）。
 * 模式同 app-worktrees.ts：open 负责切视图 + 初始化，render 只做 props 组装。
 */

import { renderGitPanel } from "./views/git.ts";
import {
  commitGitChanges,
  initGitPanel,
  refreshGitStatus,
  selectGitFile,
  selectGitRepo,
  stageGitFiles,
  unstageGitFiles,
} from "./controllers/git.ts";
import { setCryoClawView } from "./app-view-switch.ts";
import { showToast } from "./app-toast.ts";
import { t } from "./i18n.ts";
import type { AppViewState } from "./app-view-state.ts";

// 打开 git 面板视图（初始化会解析 workspace 根并向主进程注册白名单根）
export function openGitView(state: AppViewState) {
  setCryoClawView(state, "git");
  void initGitPanel(state);
}

export function renderGitView(state: AppViewState) {
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
    onRepoChange: (path) => {
      void selectGitRepo(state, path);
    },
    onRefresh: () => {
      void refreshGitStatus(state);
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
        if (ok) showToast(state, t("git.committed"));
      });
    },
  });
}
