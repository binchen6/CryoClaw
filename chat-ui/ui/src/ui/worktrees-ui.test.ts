// 守护回归（源码审计，同 i18n.test.ts / app-update-notify.test.ts 模式）：
// P3「worktrees 接入」的接线钉点。重 UI 模块（app.ts / components/cc-sidebar.ts /
// app-render.ts）在 node 下不可导入，只能钉源码；纯逻辑由 controllers/worktrees.test.ts 覆盖。
//
// 钉住的不变量：
// - views/registry.ts：worktrees 视图 id + meta（gotchas #49 接线点 1）
// - app-render.ts：renderActiveView 分发 + sidebar props（接线点 3）
// - components/cc-sidebar.ts：导航项 / 会话 worktree 徽标 / git 降级隐藏的新建入口（R41 Task 12 自 sidebar.ts 迁入）
// - app-session-actions.ts：sessions.create {worktree:true} 新建 + 删除附带 worktrees.remove
// - app-gateway.ts：onHello 后拉 worktrees.list（徽标数据源）
// - app.ts：gitDetect 探测绑定 + gitAvailable 状态
// - 主进程：preload gitDetect / main.ts registerGitIpc / workspace-ipc 双白名单根
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 编译产物位于 chat-ui/ui/.test-dist/ui/src/ui/，源文件位于 chat-ui/ui/src/ui/
function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

// 主进程源码（仓库根 src/；编译产物在 chat-ui/ui/.test-dist/ui/src/ui/，上 6 级到仓库根）
function mainSrc(rel: string): string {
  return readFileSync(new URL(`../../../../../../src/${rel}`, import.meta.url), "utf8");
}

test("views/registry.ts：worktrees 视图 id + fullpage meta（gotchas #49 接线点 1）", () => {
  const s = src("views/registry.ts");
  assert.match(s, /"worktrees"/, "CRYOCLAW_VIEW_IDS 应包含 worktrees");
  assert.match(s, /worktrees:\s*\{\s*id: "worktrees", fullpage: true, titlebarBack: true \}/, "缺少 worktrees meta");
});

test("app-render.ts：renderActiveView 分发 worktrees + sidebar 收到 worktree props（接线点 3）", () => {
  const s = src("app-render.ts");
  assert.match(s, /case "worktrees":\s*\n\s*return renderWorktreesView\(state\)/, "缺少渲染分支");
  assert.match(s, /worktreesActive: cryoclawView === "worktrees"/, "缺少 worktreesActive prop");
  assert.match(s, /onOpenWorktrees: \(\) => openWorktreesView\(state\)/, "缺少 onOpenWorktrees prop");
  assert.match(s, /gitAvailable: state\.gitAvailable/, "缺少 gitAvailable prop");
  assert.match(s, /onNewWorktreeChat: \(\) => void createNewWorktreeSession\(state\)/, "缺少新建入口 prop");
});

test("cc-sidebar：导航项 / 会话徽标 / 新建入口按 gitAvailable 降级隐藏", () => {
  const s = src("components/cc-sidebar.ts");
  assert.match(s, /t\("sidebar\.worktrees"\)/, "缺少 worktrees 导航项");
  assert.match(s, /props\.onOpenWorktrees/, "导航项未接 onOpenWorktrees");
  assert.match(s, /cryoclaw-sidebar__session-worktree/, "缺少会话 worktree 徽标");
  assert.match(s, /s\.worktreeBranch/, "徽标应渲染分支名");
  assert.match(s, /props\.gitAvailable === true/, "无 git 时新建入口应隐藏（降级）");
  assert.match(s, /t\("sidebar\.newWorktreeChat"\)/, "缺少新建入口文案");
});

test("app-session-actions.ts：worktree 新建走 sessions.create {worktree:true}，删除附带 worktrees.remove", () => {
  const s = src("app-session-actions.ts");
  assert.match(s, /export async function createNewWorktreeSession/, "缺少 createNewWorktreeSession");
  assert.match(s, /"sessions\.create",\s*\n?\s*\{ key: newKey, agentId, worktree: true \}/, "应调用 sessions.create {worktree:true}");
  assert.match(s, /isNotGitCheckoutError\(err\)/, "非 git 仓库错误应有友好引导");
  assert.match(s, /"worktrees\.remove", \{ id: ownedWorktree\.id \}/, "删除会话应附带 worktrees.remove");
  assert.match(s, /buildWorktreeSessionMap\(state\.worktrees \?\? \[\]\)/, "徽标/删除应共享 ownerId 反推表");
});

test("app-gateway.ts：onHello 后拉取 worktrees（侧边栏徽标数据源）", () => {
  const s = src("app-gateway.ts");
  assert.match(s, /void loadWorktrees\(host as unknown as OpenClawApp\)/, "onHello 应加载 worktrees");
});

test("app.ts：git 探测绑定 + gitAvailable 响应式状态", () => {
  const s = src("app.ts");
  assert.match(s, /this\.bindGitDetection\(\)/, "connectedCallback 应绑定 git 探测");
  assert.match(s, /bridge\.gitDetect\(\)/, "应经 bridge gitDetect 取缓存结果");
  assert.match(s, /gitAvailable: \{ state: true \}/, "gitAvailable 应为响应式状态");
  assert.match(s, /worktrees: \{ state: true \}/, "worktrees 应为响应式状态");
});

test("主进程：preload gitDetect / main registerGitIpc / 启动即探测缓存", () => {
  const preload = mainSrc("preload.ts");
  assert.match(preload, /gitDetect: \(\) => ipcRenderer\.invoke\("git:detect"\)/, "preload 缺少 gitDetect");
  const main = mainSrc("main.ts");
  assert.match(main, /registerGitIpc\(\)/, "main.ts 应注册 git IPC");
  assert.match(main, /void detectGitCached\(\)/, "main.ts 启动时应触发一次探测并缓存");
  const gitIpc = mainSrc("git-ipc.ts");
  assert.match(gitIpc, /assertTrustedIpcSender\(event, "git:detect"\)/, "git:detect 应校验 sender");
});

test("主进程：workspace-ipc 白名单含 ~/.openclaw/worktrees/ 根", () => {
  const s = mainSrc("workspace-ipc.ts");
  assert.match(s, /path\.join\(resolveUserStateDir\(\), "worktrees"\)/, "缺少 worktrees 白名单根");
  assert.match(s, /isInsideAnyRoot\(filePath, allowedRoots\(\)\)/, "guardPath 应走多根校验");
  assert.match(s, /isInsideAnyRoot\(real, allowedRoots\(\)\)/, "realpath 复核应保持多根校验");
});
