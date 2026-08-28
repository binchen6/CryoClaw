// 守护回归（源码审计，同 git-ui.test.ts 模式）：
// R42 第二期 Task 3「工作区页整合（IDE 式：文件树 + Git 变更 + Worktrees）」接线钉点。
// 重 UI 模块（app.ts / components/cc-sidebar.ts / app-render.ts / views/workspace.ts）在
// node 下不可导入，只能钉源码；纯逻辑由 controllers/workspace.test.ts 覆盖。
//
// 钉住的不变量：
// - app-workspace.ts：open 入口带 mode 参数 + 初始化链（workspace 根注册 → worktrees → git 选项）
// - views/workspace.ts：左导航 Git 变更节点 + 文件树 + Worktrees 区块 + 右主区 slot 注入
// - worktree 节点选中 → 切仓库 + 右区切 git（联动补全）
// - controllers/git.ts：initGitPanel 收敛（不再自解析根 / 不再注册白名单）
// - app-chat-props.ts：file-changes「在 git 中查看」→ 工作区页 git 模式
// - app-render.ts：workspace 分支渲染新工作区视图
// - views/worktrees.ts / views/git.ts：compact / embedded 变体
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 编译产物位于 chat-ui/ui/.test-dist/ui/src/ui/，源文件位于 chat-ui/ui/src/ui/
function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

test("app-workspace.ts：open 入口带 mode 参数 + 初始化链", () => {
  const s = src("app-workspace.ts");
  assert.match(s, /export function openWorkspaceView\(state: AppViewState, mode: "files" \| "git" = "files"\)/, "缺 mode 参数入口");
  assert.match(s, /initWorkspace\(state\)/, "应初始化 workspace（含白名单根注册）");
  assert.match(s, /initGitPanel\(state, /, "git 选项初始化应复用 workspace 根");
});

test("views/workspace.ts：左导航含 Git 变更节点 + 文件树 + Worktrees 区块", () => {
  const s = src("views/workspace.ts");
  assert.match(s, /"git\.title"/, "缺 Git 变更节点");
  assert.match(s, /"worktrees\.title"/, "缺 Worktrees 区块标题");
  assert.match(s, /worktreesSlot/, "Worktrees 区块应以 slot 注入");
  assert.match(s, /gitSlot/, "Git 面板应以 slot 注入右主区");
  assert.match(s, /gitRepoOptions/, "左导航应渲染仓库选择");
});

test("app-workspace.ts：worktree 节点选中 → 切仓库 + 右区切 git（联动补全）", () => {
  const s = src("app-workspace.ts");
  assert.match(s, /selectGitRepo\(state, repoPath\)/, "worktree 节点应切换 git 仓库上下文");
  assert.match(s, /selectWorkspaceMode\("git"\)/, "右区应切 git 面板");
});

test("controllers/git.ts：initGitPanel 不再自解析根/注册白名单（收敛为一次）", () => {
  const s = src("controllers/git.ts");
  assert.ok(!/workspaceSetRoot/.test(s), "initGitPanel 不应再调 workspaceSetRoot");
  assert.match(s, /initGitPanel\(\s*state: GitPanelState,\s*workspaceRoot: string \| null\s*,?\s*\)/, "应接收外部传入的 workspaceRoot");
});

test("app-chat-props.ts：文件变更「在 git 中查看」→ 工作区页 git 模式", () => {
  const s = src("app-chat-props.ts");
  assert.match(s, /onOpenGitView: \(\) => openWorkspaceView\(state, "git"\)/, "应路由到工作区页 git 模式");
});

test("app-render.ts：workspace 分支渲染新工作区视图", () => {
  const s = src("app-render.ts");
  assert.match(s, /case "workspace":\s*\n\s*return renderWorkspaceIntegratedView\(state\)/, "workspace 分支应走新渲染");
});

test("views/worktrees.ts：compact 变体保留 GC/恢复/删除/打开能力", () => {
  const s = src("views/worktrees.ts");
  assert.match(s, /opts\?: \{ compact\?: boolean \}/, "缺 compact 选项");
  assert.match(s, /props\.onGc/, "compact 态仍应有 GC 入口");
  assert.match(s, /props\.onRestore/, "compact 态仍应有恢复入口");
});

test("views/git.ts：embedded 变体隐藏仓库选择、保留三分组/提交", () => {
  const s = src("views/git.ts");
  assert.match(s, /showRepoSelect/, "缺 embedded 选项");
  assert.match(s, /groupGitEntries\(props\.status\.entries\)/, "三分组应保留");
  assert.match(s, /"git\.commitTitle"/, "提交框应保留");
});
