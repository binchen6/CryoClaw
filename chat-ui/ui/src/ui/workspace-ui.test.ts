// 守护回归（源码审计，R42 第二期 T5 合并 git-ui.test.ts / worktrees-ui.test.ts 后的最终形态）：
// Task 3「工作区页整合（IDE 式：文件树 + Git 变更 + Worktrees）」+ git/worktrees 接线钉点。
// 重 UI 模块（app.ts / components/cc-sidebar.ts / app-render.ts / views/workspace.ts）在
// node 下不可导入，只能钉源码；纯逻辑由 controllers/workspace.test.ts /
// controllers/git.test.ts / controllers/worktrees.test.ts 覆盖。
//
// 钉住的不变量：
// - views/registry.ts：视图 id 收敛为 6 视图（cron/worktrees/git/skills 已删）
// - app-render.ts：renderActiveView 无死分支 + workspace 分支渲染新工作区视图 + git bridge 声明
// - app-workspace.ts：open 入口带 mode 参数 + 初始化链（workspace 根注册 → worktrees → git 选项）
// - views/workspace.ts：左导航 Git 变更节点 + 文件树 + Worktrees 区块 + 右主区 slot 注入
// - worktree 节点选中 → 切仓库 + 右区切 git（联动补全）
// - controllers/git.ts：initGitPanel 收敛（不再自解析根 / 不再注册白名单）
// - app-chat-props.ts：file-changes「在 git 中查看」→ 工作区页 git 模式
// - views/worktrees.ts / views/git.ts：compact / embedded 变体
// - app.ts：git 面板响应式状态字段 + gitDetect 探测绑定
// - 会话 worktree 徽标 / 「更多」菜单按 gitAvailable 门控（cc-sidebar）
// - app-session-actions.ts：sessions.create {worktree:true} 新建 + 删除附带 worktrees.remove
// - app-gateway.ts：onHello 后拉 worktrees.list（徽标数据源）
// - 主进程：preload git* bridge 五通道 + gitDetect / git-ipc sender 校验 + 白名单 cwd 守卫 /
//   main.ts registerGitIpc / workspace-ipc 双白名单根（含 worktrees 根）
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

// 剥掉块注释与行注释：负向断言只针对真实代码，防注释中的字样误匹配
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("registry：视图 id 收敛为 6 视图（R42 第二期 T5）", () => {
  const code = stripComments(src("views/registry.ts"));
  // 带逗号边界（数组元素形态）避免误伤含同字的合法字符串字面量（如 "git:detect"）
  assert.ok(!/"cron",/.test(code), "cron 视图 id 应已删除");
  assert.ok(!/"worktrees",/.test(code), "worktrees 视图 id 应已删除");
  assert.ok(!/"git",/.test(code), "git 视图 id 应已删除");
  assert.ok(!/"skills",/.test(code), "skills 视图 id 应已删除");
  assert.match(code, /"chat"/, "应含 chat");
  assert.match(code, /"setup"/, "应含 setup");
  assert.match(code, /"settings"/, "应含 settings");
  assert.match(code, /"workspace"/, "应含 workspace");
  assert.match(code, /"tasks"/, "应含 tasks");
  assert.match(code, /"extensions"/, "应含 extensions");
});

test("app-render.ts：renderActiveView 无已删视图的死分支", () => {
  const code = stripComments(src("app-render.ts"));
  assert.ok(!/case "skills":/.test(code), "skills 渲染分支应已删除");
  assert.ok(!/case "cron":/.test(code), "cron 渲染分支应已删除");
  assert.ok(!/case "worktrees":/.test(code), "worktrees 渲染分支应已删除");
  assert.ok(!/case "git":/.test(code), "git 渲染分支应已删除");
  assert.ok(!/renderSkillsView/.test(code), "renderSkillsView import 应已删除（消费方在 app-extensions）");
  assert.ok(!/renderWorktreesView/.test(code), "renderWorktreesView import 应已删除（消费方在 app-workspace）");
  assert.ok(!/renderGitView/.test(code), "renderGitView import 应已删除（消费方在 app-workspace）");
  assert.ok(!/renderCronView/.test(code), "renderCronView import 应已删除（消费方在 app-tasks）");
});

test("app-render.ts：git bridge 声明保留（工作区页 git 面板仍经 preload 通道）", () => {
  const s = src("app-render.ts");
  assert.match(s, /gitStatus\?: \(cwd: string\) => Promise<any>/, "缺少 gitStatus bridge 声明");
  assert.match(s, /gitCommit\?: \(cwd: string, message: string\) => Promise<any>/, "缺少 gitCommit bridge 声明");
});

test("app.ts：git 面板响应式状态字段", () => {
  const s = src("app.ts");
  for (const field of [
    "gitRepoPath",
    "gitRepoOptions",
    "gitStatusLoading",
    "gitStatus",
    "gitRepoState",
    "gitBusyPaths",
    "gitSelectedFile",
    "gitDiffFiles",
    "gitCommitMessage",
    "gitCommitting",
  ]) {
    assert.match(s, new RegExp(`${field}: \\{ state: true \\}`), `${field} 应为响应式状态`);
  }
});

test("file-changes 面板「在 git 中查看」链接接线（app-chat-props / chat.ts / cc-chat-history / grouped-render）", () => {
  const chatProps = src("app-chat-props.ts");
  assert.match(chatProps, /gitAvailable: state\.gitAvailable/, "缺少 gitAvailable prop");
  assert.match(chatProps, /onOpenGitView: \(\) => openWorkspaceView\(state, "git"\)/, "缺少 onOpenGitView prop");

  const chat = src("views/chat.ts");
  assert.match(chat, /closest\("\.chat-git-view-link"\)/, "线程点击委托缺少 git 链接分支");
  assert.match(chat, /props\.onOpenGitView\?\.\(\)/, "git 链接点击应调 onOpenGitView");
  // R41 Task 11：历史列表迁入 <cc-chat-history>，外层改为向组件透传 gitAvailable 属性
  assert.match(chat, /\.gitAvailable=\$\{props\.gitAvailable\}/, "历史组件装配缺少 gitAvailable 透传");
  const history = src("components/cc-chat-history.ts");
  assert.match(history, /gitAvailable: this\.gitAvailable/, "group opts 缺少 gitAvailable（cc-chat-history）");

  const grouped = src("chat/grouped-render.ts");
  assert.match(grouped, /class="chat-git-view-link"/, "file-changes 缺少「在 git 中查看」链接");
  assert.match(grouped, /t\("chat\.viewInGit"\)/, "缺少链接文案");
  assert.match(grouped, /gitAvailable === true/, "链接应仅在 git 可用时渲染");
});

test("views/git.ts：分组/stage/commit/diff 渲染的关键结构", () => {
  const s = src("views/git.ts");
  assert.match(s, /groupGitEntries\(props\.status\.entries\)/, "应使用三分组");
  assert.match(s, /"git\.staged"/, "缺少 staged 分组");
  assert.match(s, /"git\.unstaged"/, "缺少 unstaged 分组");
  assert.match(s, /"git\.untracked"/, "缺少 untracked 分组");
  assert.match(s, /t\("git\.identityGuide"\)/, "缺少提交身份未配置的引导文案");
  assert.match(s, /t\("git\.diffBinary"\)/, "缺少二进制 diff 占位");
  assert.match(s, /t\("git\.diffEmpty"\)/, "缺少空 diff 占位");
  assert.match(s, /props\.onSelectFile\(side, entry\.path\)/, "文件行点击应懒拉 diff");
});

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

test("views/workspace.ts：文件树保留刷新/打开根目录/逐项打开能力（终审 Major 修复）", () => {
  const s = src("views/workspace.ts");
  assert.match(s, /onRefreshFiles/, "缺刷新回调");
  assert.match(s, /onOpenRootFolder/, "缺打开根目录回调");
  assert.match(s, /onOpenItemFolder/, "缺逐项打开回调");
  assert.match(s, /"workspace\.refresh"/, "缺刷新 tooltip");
  assert.match(s, /"workspace\.openRoot"/, "缺打开根目录 tooltip");
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

test("app-render.ts：sidebar 收到 worktree props（gitAvailable + 新建入口）", () => {
  const s = src("app-render.ts");
  assert.match(s, /gitAvailable: state\.gitAvailable/, "缺少 gitAvailable prop");
  assert.match(s, /onNewWorktreeChat: \(\) => void createNewWorktreeSession\(state\)/, "缺少新建入口 prop");
});

test("views/worktrees.ts：compact 变体保留 GC/恢复/删除/打开能力", () => {
  const s = src("views/worktrees.ts");
  assert.match(s, /opts\?: \{ compact\?: boolean \}/, "缺 compact 选项");
  assert.match(s, /wt-compact-toolbar[\s\S]{0,300}props\.onGc/, "compact 工具行内应有 GC 入口");
  assert.match(s, /props\.onRestore/, "compact 态仍应有恢复入口");
});

test("views/git.ts：embedded 变体隐藏仓库选择、保留三分组/提交", () => {
  const s = src("views/git.ts");
  assert.match(s, /showRepoSelect/, "缺 embedded 选项");
  assert.match(s, /groupGitEntries\(props\.status\.entries\)/, "三分组应保留");
  assert.match(s, /"git\.commitTitle"/, "提交框应保留");
  assert.match(s, /gitp-toolbar[\s\S]{0,200}props\.onRefresh/, "embedded 工具行内应有刷新入口");
});

test("views/worktrees.ts：compact 卡片仓库切换仅对活跃 worktree 生效", () => {
  const s = src("views/worktrees.ts");
  assert.match(s, /live && props\.onSelectRepo\?\.\(w\.path\)/, "onSelectRepo 应带 live 门控");
});

test("views/git.ts：无可用仓库时空态提示", () => {
  const s = src("views/git.ts");
  assert.match(s, /"git\.noRepos"/, "缺无仓库空态文案");
  const zh = src("i18n/zh.ts");
  const en = src("i18n/en.ts");
  assert.ok(zh.includes('"git.noRepos"'), "zh.ts 缺 git.noRepos");
  assert.ok(en.includes('"git.noRepos"'), "en.ts 缺 git.noRepos");
});

test("cc-sidebar：会话 worktree 徽标 + 「更多」菜单按 gitAvailable 门控", () => {
  const s = src("components/cc-sidebar.ts");
  assert.match(s, /cryoclaw-sidebar__session-worktree/, "缺少会话 worktree 徽标");
  assert.match(s, /s\.worktreeBranch/, "徽标应渲染分支名");
  assert.match(s, /props\.gitAvailable === true/, "无 git 时「更多」菜单整体应隐藏（降级）");
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

test("主进程：preload git 面板 bridge 五个通道 + gitDetect", () => {
  const preload = mainSrc("preload.ts");
  assert.match(preload, /gitStatus: \(cwd: string\) => ipcRenderer\.invoke\("git:status", cwd\)/, "缺少 gitStatus");
  assert.match(preload, /ipcRenderer\.invoke\("git:diff", cwd, opts\)/, "缺少 gitDiff");
  assert.match(preload, /ipcRenderer\.invoke\("git:stage", cwd, paths\)/, "缺少 gitStage");
  assert.match(preload, /ipcRenderer\.invoke\("git:unstage", cwd, paths\)/, "缺少 gitUnstage");
  assert.match(preload, /ipcRenderer\.invoke\("git:commit", cwd, message\)/, "缺少 gitCommit");
  assert.match(preload, /gitDetect: \(\) => ipcRenderer\.invoke\("git:detect"\)/, "preload 缺少 gitDetect");
});

test("主进程：main registerGitIpc + 启动即探测缓存", () => {
  const main = mainSrc("main.ts");
  assert.match(main, /registerGitIpc\(\)/, "main.ts 应注册 git IPC");
  assert.match(main, /void detectGitCached\(\)/, "main.ts 启动时应触发一次探测并缓存");
  const gitIpc = mainSrc("git-ipc.ts");
  assert.match(gitIpc, /assertTrustedIpcSender\(event, "git:detect"\)/, "git:detect 应校验 sender");
});

test("主进程：git-ipc 通道全部 assertTrustedIpcSender + 白名单 cwd 守卫 + 结构化错误", () => {
  const s = mainSrc("git-ipc.ts");
  for (const ch of ["git:status", "git:diff", "git:stage", "git:unstage", "git:commit"]) {
    assert.match(s, new RegExp(`"${ch.replace(":", "\\:")}"`), `应注册 ${ch}`);
  }
  // sender 校验统一走 guardGitOp（git:detect 单独校验）
  assert.match(s, /assertTrustedIpcSender\(event, channel\)/, "guardGitOp 应校验 sender");
  assert.match(s, /resolveAllowedDir\(/, "cwd 应走白名单根守卫");
  assert.match(s, /error: "no-git"/, "git 缺失应返回结构化错误 no-git");
  assert.match(s, /error: "not-a-repo"/, "非 git 仓库应返回结构化错误 not-a-repo");
  assert.match(s, /sanitizeGitRelPaths\(/, "文件路径入参应校验（拒绝绝对路径/.. 逃逸）");
  assert.match(s, /normalizeCommitMessage\(/, "commit message 应校验");
  assert.match(s, /\["add", "--", \.\.\.paths\]/, "stage 应数组传参 git add --");
  assert.match(s, /\["restore", "--staged", "--", \.\.\.paths\]/, "unstage 应数组传参 git restore --staged --");
  assert.match(s, /\["rm", "--cached", "--", \.\.\.paths\]/, "unstage 空仓库应回退 git rm --cached");
  assert.match(s, /\["commit", "-m", msg\]/, "commit 应数组传参 -m（无注入面）");
  // 底层 runner 在 git-run.ts（execFile 参数 + maxBuffer 截断检测）
  const run = mainSrc("git-run.ts");
  assert.match(run, /windowsHide: true/, "execFile 应 windowsHide");
  assert.match(run, /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/, "应识别 Node ≥22 的 maxBuffer 字符串 code");
});

test("主进程：workspace-ipc 导出目录版守卫（realpath 复核防 symlink）+ 白名单含 worktrees 根", () => {
  const s = mainSrc("workspace-ipc.ts");
  assert.match(s, /export async function resolveAllowedDir/, "缺少 resolveAllowedDir 导出");
  assert.match(s, /fs\.promises\.realpath\(dirPath\)/, "守卫应 realpath 复核");
  assert.match(s, /path\.join\(resolveUserStateDir\(\), "worktrees"\)/, "缺少 worktrees 白名单根");
  assert.match(s, /isInsideAnyRoot\(filePath, allowedRoots\(\)\)/, "guardPath 应走多根校验");
  assert.match(s, /isInsideAnyRoot\(real, allowedRoots\(\)\)/, "realpath 复核应保持多根校验");
});

test("i18n：git 面板 key 双区齐全（抽样钉住，键集合一致性由 i18n.test.ts 保证）", () => {
  const zh = src("i18n/zh.ts");
  const en = src("i18n/en.ts");
  for (const key of ['"git.title"', '"git.staged"', '"git.identityGuide"', '"chat.viewInGit"']) {
    assert.ok(zh.includes(key), `zh.ts 缺少 ${key}`);
    assert.ok(en.includes(key), `en.ts 缺少 ${key}`);
  }
  // R42 第二期 T5：sidebar.git 键随视图删除作废
  assert.ok(!zh.includes('"sidebar.git"'), "zh.ts 应删除死键 sidebar.git");
  assert.ok(!en.includes('"sidebar.git"'), "en.ts 应删除死键 sidebar.git");
});
