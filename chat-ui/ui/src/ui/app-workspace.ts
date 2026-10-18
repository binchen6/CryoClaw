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
  setWorkspaceRoot,resolveAgentWorkspacePath,leaveWorkspace,
} from "./controllers/workspace.ts";
import { initGitPanel, selectGitRepo } from "./controllers/git.ts";
import { loadWorktrees } from "./controllers/worktrees.ts";
import { setCryoClawView,registerViewLeaveHook } from "./app-view-switch.ts";
import {transitionView} from "./utils/view-transition.ts";
import { renderGitView } from "./app-git.ts";
import { renderWorktreesView } from "./app-worktrees.ts";

// 打开工作区页（mode 缺省 files；file-changes「在 git 中查看」走 git 模式）
export function openWorkspaceView(state: AppViewState, mode: "files" | "git" = "files") {
  registerViewLeaveHook("workspace",leaveWorkspace);
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
  void switchWorkspaceRepository(state,repoPath);
}
async function switchWorkspaceRepository(state:AppViewState,path:string){
  try{if(!await setWorkspaceRoot(state,path,true))return;
    if(!state.gitRepoOptions.some(repo=>repo.path===path))await initGitPanel(state,path);
    await selectGitRepo(state,path);state.requestUpdate();
  }catch(error){workspaceViewState.error=String(error);state.requestUpdate();}
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
      void switchWorkspaceRepository(state,path);
    },
    // 终审 Major 修复：恢复旧版文件树的刷新/打开根目录/逐项打开能力（views 纯渲染，回调经 props 注入）
    onRefreshFiles: () => {
      void initWorkspace(state,true).then(() => state.requestUpdate());
    },
    onOpenRootFolder: () => {
      const root = workspaceViewState.root;
      if (!root) return;
      void window.cryoclaw?.workspaceOpenFolder?.(root);
    },
    onOpenItemFolder: (path) => {
      void window.cryoclaw?.workspaceOpenFolder?.(path);
    },
    onChooseRoot:()=>{void (async()=>{try{const selected=await window.cryoclaw?.selectDirectory?.();if(selected)await switchWorkspaceRepository(state,selected);}catch(error){workspaceViewState.error=String(error);state.requestUpdate();}})();},
    onDefaultRoot:()=>{void (async()=>{try{const root=await resolveAgentWorkspacePath(state,"main",true);if(root && await setWorkspaceRoot(state,root,false)){await initGitPanel(state,root);await selectGitRepo(state,root);}}catch(error){workspaceViewState.error=String(error);state.requestUpdate();}})();},
    onAttachFile:(path,name)=>{if(!state.chatAttachments.some(item=>item.filePath===path))state.chatAttachments=[...state.chatAttachments,{id:crypto.randomUUID(),filePath:path,name,...(workspaceViewState.imagePreview?{thumbnailUrl:workspaceViewState.imagePreview}:{})}];transitionView(()=>setCryoClawView(state,"chat"));},
    onPinRoot:()=>{const root=workspaceViewState.root;if(!root || state.settings.pinnedWorkspaces.some(workspace=>workspace.path===root))return;state.applySettings({...state.settings,pinnedWorkspaces:[...state.settings.pinnedWorkspaces,{id:crypto.randomUUID(),path:root,name:root.split(/[/\\]/).filter(Boolean).at(-1)??root,icon:"📁"}]});state.requestUpdate();},
  });
}
