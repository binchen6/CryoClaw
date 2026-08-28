// 守护回归（源码审计，同 worktrees-ui.test.ts 模式）：
// P4「git 索引/审查/提交面板（文件级 v1）」的接线钉点。重 UI 模块
// （app.ts / components/cc-sidebar.ts / app-render.ts / views/git.ts）在 node 下不可导入，
// 只能钉源码；纯逻辑由 controllers/git.test.ts 与 src/git-parse.test.ts 覆盖。
//
// 钉住的不变量：
// - views/registry.ts：git 视图 id + meta（gotchas #49 接线点 1）
// - app-render.ts：renderActiveView 分发 + git bridge 声明（接线点 3）
// - app.ts：git 面板响应式状态字段
// - file-changes 面板「在 git 中查看」链接（app-chat-props / chat.ts / cc-chat-history / grouped-render）
// - 主进程：preload git* bridge；git-ipc 5 通道 + sender 校验 + 白名单 cwd 守卫
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

test("views/registry.ts：git 视图 id + fullpage meta（gotchas #49 接线点 1）", () => {
  const s = src("views/registry.ts");
  assert.match(s, /"git",/, "CRYOCLAW_VIEW_IDS 应包含 git");
  assert.match(s, /git:\s*\{\s*id: "git", fullpage: true, titlebarBack: true \}/, "缺少 git meta");
});

test("app-render.ts：renderActiveView 分发 git + git bridge 声明（接线点 3）", () => {
  const s = src("app-render.ts");
  assert.match(s, /case "git":\s*\n\s*return renderGitView\(state\)/, "缺少渲染分支");
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

test("主进程：preload git 面板 bridge 五个通道", () => {
  const preload = mainSrc("preload.ts");
  assert.match(preload, /gitStatus: \(cwd: string\) => ipcRenderer\.invoke\("git:status", cwd\)/, "缺少 gitStatus");
  assert.match(preload, /ipcRenderer\.invoke\("git:diff", cwd, opts\)/, "缺少 gitDiff");
  assert.match(preload, /ipcRenderer\.invoke\("git:stage", cwd, paths\)/, "缺少 gitStage");
  assert.match(preload, /ipcRenderer\.invoke\("git:unstage", cwd, paths\)/, "缺少 gitUnstage");
  assert.match(preload, /ipcRenderer\.invoke\("git:commit", cwd, message\)/, "缺少 gitCommit");
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

test("主进程：workspace-ipc 导出目录版守卫（realpath 复核防 symlink）", () => {
  const s = mainSrc("workspace-ipc.ts");
  assert.match(s, /export async function resolveAllowedDir/, "缺少 resolveAllowedDir 导出");
  assert.match(s, /fs\.promises\.realpath\(dirPath\)/, "守卫应 realpath 复核");
});

test("i18n：git 面板 key 双区齐全（抽样钉住，键集合一致性由 i18n.test.ts 保证）", () => {
  const zh = src("i18n/zh.ts");
  const en = src("i18n/en.ts");
  for (const key of ['"git.title"', '"git.staged"', '"git.identityGuide"', '"sidebar.git"', '"chat.viewInGit"']) {
    assert.ok(zh.includes(key), `zh.ts 缺少 ${key}`);
    assert.ok(en.includes(key), `en.ts 缺少 ${key}`);
  }
});
