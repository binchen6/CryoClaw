/**
 * 工作区页入口与 props 组装（R42 第二期）。模式同 app-tasks.ts：
 * open 负责切视图 + 初始化链（workspace 根注册 → worktrees 刷新 → git 选项），
 * render 只做 slot 组装。worktree→git 联动补全：选中 worktree 节点即切换
 * 仓库上下文并刷 status。
 */
import type { AppViewState } from "./app-view-state.ts";
import { renderWorkspaceView } from "./views/workspace.ts";
import {
  initWorkspace,
  selectWorkspaceMode,
  workspaceViewState,
} from "./controllers/workspace.ts";
import { initGitPanel, selectGitRepo } from "./controllers/git.ts";
import { loadWorktrees } from "./controllers/worktrees.ts";
import { setCryoClawView } from "./app-view-switch.ts";
import { renderGitView } from "./app-git.ts";
import { renderWorktreesView } from "./app-worktrees.ts";

// 打开工作区页（mode 缺省 files；file-changes「在 git 中查看」走 git 模式）
export function openWorkspaceView(state: AppViewState, mode: "files" | "git" = "files") {
  selectWorkspaceMode(mode);
  setCryoClawView(state, "workspace");
  // 初始化链：workspace 根解析 + 白名单注册（全应用唯一注册点）→ worktrees
  // 快照刷新（git 仓库选项依赖）→ git 选项组装 + 首刷 status
  void initWorkspace(state).then(() =>
    void loadWorktrees(state).then(() => initGitPanel(state, workspaceViewState.root)),
  );
}

// worktree 节点点击：切换仓库上下文 + 右区切 git（worktree→git 联动）
export function openWorkspaceGitForRepo(state: AppViewState, repoPath: string) {
  selectWorkspaceMode("git");
  state.requestUpdate();
  void selectGitRepo(state, repoPath);
}

export function renderWorkspaceIntegratedView(state: AppViewState) {
  return renderWorkspaceView(state, {
    gitSlot: renderGitView(state, { showRepoSelect: false }),
    worktreesSlot: renderWorktreesView(state, {
      compact: true,
      onSelectRepo: (path) => openWorkspaceGitForRepo(state, path),
    }),
    onSelectGitNode: () => {
      selectWorkspaceMode("git");
      state.requestUpdate();
    },
    onOpenFiles: () => {
      selectWorkspaceMode("files");
      state.requestUpdate();
    },
    onRepoChange: (path) => {
      void selectGitRepo(state, path);
    },
  });
}
