/**
 * Git 面板控制器（P4，文件级 v1）—— 主进程 git:* IPC 封装。
 *
 * 数据流：主进程 git-ipc.ts 已把 porcelain v2 status 与 unified diff 解析为
 * 结构化 JSON（解析器在 src/git-parse.ts，主进程侧单测覆盖）；本模块只做
 * 状态编排：仓库选择（workspace 根 + 活跃 worktree）、status 刷新、
 * 按文件懒拉 diff、stage/unstage/commit。
 *
 * 错误模型（view 按 kind 渲染本地化文案，controller 不做 i18n）：
 * - gitRepoState: "no-git"（未装 git）/ "not-a-repo"（当前目录非仓库）/ "ok"
 * - gitErrorKind: "identity"（commit 未配置 user.name/email）/ "generic"
 */

import type { GatewayBrowserClient } from "../gateway.ts";
import { isLiveWorktree, type WorktreeRecord } from "./worktrees.ts";

// ── 结构类型（与主进程 src/git-parse.ts 的输出结构对齐） ──────────────

export type GitBranchInfo = {
  head: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
};

export type GitStatusEntry = {
  kind: "tracked" | "renamed" | "unmerged" | "untracked" | "ignored";
  path: string;
  origPath?: string;
  index: string;
  worktree: string;
};

export type GitStatusResult = {
  branch: GitBranchInfo;
  entries: GitStatusEntry[];
  /** 主进程侧 git 输出超 buffer 被截断（条目/diff 不完整） */
  truncated?: boolean;
};

export type DiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
  noNewlineAfter?: boolean;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffFile = {
  oldPath: string | null;
  newPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  isBinary: boolean;
  hunks: DiffHunk[];
};

export type GitRepoOption = {
  path: string;
  kind: "workspace" | "worktree";
  /** worktree 的分支名（workspace 根为空串，view 侧另行标注） */
  branch: string;
};

/** 本地分支行（git:branch-list 解析产物） */
export type GitBranchRow = {
  name: string;
  current: boolean;
  upstream: string;
};

/** 提交历史行（git:log 解析产物；timestamp 为 Unix 秒） */
export type GitLogCommit = {
  hash: string;
  author: string;
  email: string;
  timestamp: number;
  subject: string;
};

export type GitPanelState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  gitAvailable: boolean | null;
  worktrees: WorktreeRecord[];
  gitRepoPath: string | null;
  gitRepoOptions: GitRepoOption[];
  gitStatusLoading: boolean;
  gitStatus: GitStatusResult | null;
  gitRepoState: "ok" | "no-git" | "not-a-repo" | null;
  gitErrorKind: "identity" | "generic" | null;
  gitErrorDetail: string | null;
  gitBusyPaths: ReadonlySet<string>;
  /** 选中文件的 key：`${"cached"|"worktree"}:${path}`（区分 staged/worktree 两侧同名文件） */
  gitSelectedFile: string | null;
  gitDiffFiles: DiffFile[] | null;
  gitDiffLoading: boolean;
  /** status/diff 输出被主进程截断（buffer 上限），view 据此显示提示行 */
  gitStatusTruncated: boolean;
  gitDiffTruncated: boolean;
  gitCommitMessage: string;
  gitCommitting: boolean;
  // ── R58：分支面板 / 提交历史 / push/pull ──
  gitBranches: GitBranchRow[] | null;
  gitBranchesLoading: boolean;
  gitBranchPanelOpen: boolean;
  /** 正在切换的分支名（per-row spinner） */
  gitCheckingOutBranch: string | null;
  gitLog: GitLogCommit[] | null;
  gitLogLoading: boolean;
  gitNetworkBusy: "push" | "pull" | null;
};

type GitBridge = {
  gitStatus?: (cwd: string) => Promise<{
    success: boolean;
    data?: GitStatusResult;
    error?: string;
    message?: string;
  }>;
  gitDiff?: (cwd: string, opts?: { cached?: boolean; path?: string }) => Promise<{
    success: boolean;
    data?: { files: DiffFile[]; truncated?: boolean };
    error?: string;
    message?: string;
  }>;
  gitStage?: (cwd: string, paths: string[]) => Promise<{ success: boolean; error?: string; message?: string }>;
  gitUnstage?: (cwd: string, paths: string[]) => Promise<{ success: boolean; error?: string; message?: string }>;
  gitCommit?: (cwd: string, message: string) => Promise<{ success: boolean; error?: string; message?: string }>;
  gitBranchList?: (cwd: string) => Promise<{ success: boolean; data?: { branches: GitBranchRow[] }; error?: string; message?: string }>;
  gitCheckout?: (cwd: string, branch: string) => Promise<{ success: boolean; error?: string; message?: string }>;
  gitLog?: (cwd: string, limit?: number) => Promise<{ success: boolean; data?: { commits: GitLogCommit[]; truncated?: boolean }; error?: string; message?: string }>;
  gitPush?: (cwd: string, opts?: { remote?: string; branch?: string; setUpstream?: boolean }) => Promise<{ success: boolean; error?: string; message?: string }>;
  gitPull?: (cwd: string) => Promise<{ success: boolean; error?: string; message?: string }>;
  gitDiscard?: (cwd: string, paths: string[]) => Promise<{ success: boolean; error?: string; message?: string }>;
  gitClean?: (cwd: string, paths: string[]) => Promise<{ success: boolean; error?: string; message?: string }>;
};

function bridge(): GitBridge | undefined {
  return (window as unknown as { cryoclaw?: GitBridge }).cryoclaw;
}

// ── 纯函数（可单测） ─────────────────────────────────────────────────

/** staged 组：tracked/renamed 且 index 字母非 "."（与主进程 isStagedEntry 同规则） */
export function isStagedEntry(e: GitStatusEntry): boolean {
  return (e.kind === "tracked" || e.kind === "renamed") && e.index !== "." && e.index !== " ";
}

/** unstaged 组：tracked/renamed 且 worktree 字母非 "."；unmerged 归入 unstaged */
export function isUnstagedEntry(e: GitStatusEntry): boolean {
  if (e.kind === "unmerged") return true;
  return (e.kind === "tracked" || e.kind === "renamed") && e.worktree !== "." && e.worktree !== " ";
}

export type GitEntryGroups = {
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
};

/** status 条目三分组（ignored 不展示；一个条目可同时进 staged 与 unstaged） */
export function groupGitEntries(entries: GitStatusEntry[]): GitEntryGroups {
  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  const untracked: GitStatusEntry[] = [];
  for (const e of entries) {
    if (e.kind === "untracked") {
      untracked.push(e);
      continue;
    }
    if (e.kind === "ignored") continue;
    if (isStagedEntry(e)) staged.push(e);
    if (isUnstagedEntry(e)) unstaged.push(e);
  }
  return { staged, unstaged, untracked };
}

/** 仓库选择项：workspace 根在前，活跃 worktree 随后（去重同路径） */
export function buildGitRepoOptions(
  workspaceRoot: string | null,
  worktrees: WorktreeRecord[],
): GitRepoOption[] {
  const options: GitRepoOption[] = [];
  const seen = new Set<string>();
  if (workspaceRoot) {
    options.push({ path: workspaceRoot, kind: "workspace", branch: "" });
    seen.add(workspaceRoot);
  }
  for (const w of worktrees) {
    if (!isLiveWorktree(w) || seen.has(w.path)) continue;
    seen.add(w.path);
    options.push({ path: w.path, kind: "worktree", branch: w.branch ?? "" });
  }
  return options;
}

/** commit stderr 是否「未配置提交身份」（user.name/user.email 缺失的典型文案） */
export function isGitIdentityError(stderr: string): boolean {
  return /author identity unknown|unable to auto-detect email|empty ident|no user\.name|no user\.email/i.test(
    stderr,
  );
}

/** diff 选中 key 编解码 */
export function gitFileKey(side: "cached" | "worktree", path: string): string {
  return `${side}:${path}`;
}

// ── 状态编排 ─────────────────────────────────────────────────────────

// 加载序号：快速切换仓库/文件时防旧响应覆盖新响应
let statusSeq = 0;
let diffSeq = 0;
// 分支列表 / 提交历史加载序号：仓库切换后旧响应不得落入新仓库
let branchSeq = 0;
let logSeq = 0;

/** 初始化 git 面板选项：workspace 根由调用方（工作区页）解析并注册白名单一次，
 * 这里只组装仓库选项（workspace 根 + 活跃 worktree）并首刷 status。 */
export async function initGitPanel(
  state: GitPanelState,
  workspaceRoot: string | null,
): Promise<void> {
  if (state.gitAvailable === false) {
    state.gitRepoState = "no-git";
    return;
  }
  state.gitRepoOptions = buildGitRepoOptions(workspaceRoot, state.worktrees);
  const stillValid = state.gitRepoOptions.some((o) => o.path === state.gitRepoPath);
  state.gitRepoPath = stillValid ? state.gitRepoPath : (state.gitRepoOptions[0]?.path ?? null);
  await refreshGitStatus(state);
  // 首次进入也拉提交历史（此前只有切仓库/手动刷新才拉，git 面板首屏历史恒空）
  void loadGitLog(state);
}

/** 刷新当前仓库 status；结果落到 gitStatus / gitRepoState */
export async function refreshGitStatus(state: GitPanelState): Promise<void> {
  const b = bridge();
  if (!b?.gitStatus || !state.gitRepoPath) {
    state.gitStatus = null;
    return;
  }
  const seq = ++statusSeq;
  state.gitStatusLoading = true;
  state.gitErrorKind = null;
  state.gitErrorDetail = null;
  try {
    const res = await b.gitStatus(state.gitRepoPath);
    if (seq !== statusSeq) return;
    if (res?.success && res.data) {
      state.gitStatus = res.data;
      state.gitStatusTruncated = res.data.truncated === true;
      state.gitRepoState = "ok";
      // 刷新后选中文件可能已消失（已 stage/commit），清空选中与 diff
      state.gitSelectedFile = null;
      state.gitDiffFiles = null;
      state.gitDiffTruncated = false;
    } else if (res?.error === "no-git") {
      state.gitRepoState = "no-git";
      state.gitStatus = null;
      state.gitStatusTruncated = false;
    } else if (res?.error === "not-a-repo") {
      state.gitRepoState = "not-a-repo";
      state.gitStatus = null;
      state.gitStatusTruncated = false;
    } else {
      state.gitRepoState = null;
      state.gitErrorKind = "generic";
      state.gitErrorDetail = res?.message ?? null;
    }
  } catch (err) {
    if (seq !== statusSeq) return;
    state.gitRepoState = null;
    state.gitErrorKind = "generic";
    state.gitErrorDetail = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === statusSeq) state.gitStatusLoading = false;
  }
}

/** 切换仓库（下拉选择） */
export async function selectGitRepo(state: GitPanelState, repoPath: string): Promise<void> {
  if (state.gitRepoPath === repoPath) return;
  state.gitRepoPath = repoPath;
  state.gitSelectedFile = null;
  state.gitDiffFiles = null;
  state.gitDiffTruncated = false;
  // 仓库切换：分支列表 / 提交历史 / 分支面板随仓库重置（旧仓库的迟到响应一并失效）
  state.gitBranches = null;
  state.gitBranchPanelOpen = false;
  state.gitLog = null;
  ++branchSeq;
  ++logSeq;
  // 使在途 diff 响应失效（旧仓库的迟到响应不得落入新仓库）
  ++diffSeq;
  await refreshGitStatus(state);
  void loadGitLog(state);
}

/** 点击文件行：懒拉该文件 diff（staged 侧拉 --cached，unstaged 侧拉 worktree diff） */
export async function selectGitFile(
  state: GitPanelState,
  side: "cached" | "worktree",
  path: string,
): Promise<void> {
  const b = bridge();
  if (!b?.gitDiff || !state.gitRepoPath) return;
  const key = gitFileKey(side, path);
  if (state.gitSelectedFile === key) {
    // 再次点击同一文件 = 收起（使在途 diff 响应失效，防迟到的旧响应重开已收起的 diff）
    state.gitSelectedFile = null;
    state.gitDiffFiles = null;
    state.gitDiffTruncated = false;
    ++diffSeq;
    return;
  }
  const seq = ++diffSeq;
  state.gitSelectedFile = key;
  state.gitDiffLoading = true;
  state.gitDiffFiles = null;
  state.gitDiffTruncated = false;
  try {
    const res = await b.gitDiff(state.gitRepoPath, { cached: side === "cached", path });
    if (seq !== diffSeq) return;
    if (res?.success && res.data) {
      state.gitDiffFiles = res.data.files;
      state.gitDiffTruncated = res.data.truncated === true;
    } else {
      state.gitDiffFiles = null;
      state.gitErrorKind = "generic";
      state.gitErrorDetail = res?.message ?? null;
    }
  } catch (err) {
    if (seq !== diffSeq) return;
    state.gitDiffFiles = null;
    state.gitErrorKind = "generic";
    state.gitErrorDetail = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === diffSeq) state.gitDiffLoading = false;
  }
}

// stage/unstage 公共骨架：busy 集合标记 + 调用 + 成功后重刷 status
async function runGitMutation(
  state: GitPanelState,
  paths: string[],
  op: "stage" | "unstage",
): Promise<boolean> {
  const b = bridge();
  const fn = op === "stage" ? b?.gitStage : b?.gitUnstage;
  if (!fn || !state.gitRepoPath || paths.length === 0) return false;
  const next = new Set(state.gitBusyPaths);
  for (const p of paths) next.add(p);
  state.gitBusyPaths = next;
  state.gitErrorKind = null;
  state.gitErrorDetail = null;
  try {
    const res = await fn(state.gitRepoPath, paths);
    if (!res?.success) {
      state.gitErrorKind = "generic";
      state.gitErrorDetail = res?.message ?? null;
      return false;
    }
    await refreshGitStatus(state);
    return true;
  } catch (err) {
    state.gitErrorKind = "generic";
    state.gitErrorDetail = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    const after = new Set(state.gitBusyPaths);
    for (const p of paths) after.delete(p);
    state.gitBusyPaths = after;
  }
}

export async function stageGitFiles(state: GitPanelState, paths: string[]): Promise<boolean> {
  return runGitMutation(state, paths, "stage");
}

export async function unstageGitFiles(state: GitPanelState, paths: string[]): Promise<boolean> {
  return runGitMutation(state, paths, "unstage");
}

/** 提交 staged 区；失败按 stderr 分类（identity → view 渲染配置引导） */
export async function commitGitChanges(state: GitPanelState): Promise<boolean> {
  const b = bridge();
  const message = state.gitCommitMessage.trim();
  if (!b?.gitCommit || !state.gitRepoPath || !message || state.gitCommitting) return false;
  state.gitCommitting = true;
  state.gitErrorKind = null;
  state.gitErrorDetail = null;
  try {
    const res = await b.gitCommit(state.gitRepoPath, message);
    if (!res?.success) {
      const detail = res?.message ?? null;
      state.gitErrorKind = detail && isGitIdentityError(detail) ? "identity" : "generic";
      state.gitErrorDetail = detail;
      return false;
    }
    state.gitCommitMessage = "";
    await refreshGitStatus(state);
    return true;
  } catch (err) {
    state.gitErrorKind = "generic";
    state.gitErrorDetail = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    state.gitCommitting = false;
  }
}

// ── R58：分支面板 / 提交历史 / push / pull / 丢弃 ──────────────────

/** 打开/收起分支切换面板（打开时懒拉分支列表） */
export function toggleGitBranchPanel(state: GitPanelState): void {
  state.gitBranchPanelOpen = !state.gitBranchPanelOpen;
  if (state.gitBranchPanelOpen && !state.gitBranches) {
    void loadGitBranches(state);
  }
}

export async function loadGitBranches(state: GitPanelState): Promise<void> {
  const b = bridge();
  if (!b?.gitBranchList || !state.gitRepoPath) return;
  const seq = ++branchSeq;
  state.gitBranchesLoading = true;
  try {
    const res = await b.gitBranchList(state.gitRepoPath);
    if (seq !== branchSeq) return;
    if (res?.success && res.data) {
      state.gitBranches = res.data.branches;
    } else {
      state.gitErrorKind = "generic";
      state.gitErrorDetail = res?.message ?? null;
    }
  } catch (err) {
    if (seq !== branchSeq) return;
    state.gitErrorKind = "generic";
    state.gitErrorDetail = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === branchSeq) state.gitBranchesLoading = false;
  }
}

/** 切换分支：成功后刷新 status / 分支列表 / 历史 */
export async function checkoutGitBranch(state: GitPanelState, branch: string): Promise<boolean> {
  const b = bridge();
  if (!b?.gitCheckout || !state.gitRepoPath || state.gitCheckingOutBranch) return false;
  state.gitCheckingOutBranch = branch;
  state.gitErrorKind = null;
  state.gitErrorDetail = null;
  try {
    const res = await b.gitCheckout(state.gitRepoPath, branch);
    if (!res?.success) {
      state.gitErrorKind = "generic";
      state.gitErrorDetail = res?.message ?? null;
      return false;
    }
    await Promise.all([refreshGitStatus(state), loadGitBranches(state), loadGitLog(state)]);
    return true;
  } catch (err) {
    state.gitErrorKind = "generic";
    state.gitErrorDetail = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    state.gitCheckingOutBranch = null;
  }
}

export async function loadGitLog(state: GitPanelState): Promise<void> {
  const b = bridge();
  if (!b?.gitLog || !state.gitRepoPath) return;
  const seq = ++logSeq;
  state.gitLogLoading = true;
  try {
    const res = await b.gitLog(state.gitRepoPath, 30);
    if (seq !== logSeq) return;
    if (res?.success && res.data) {
      state.gitLog = res.data.commits;
    }
    // 历史加载失败不打扰 status 区（面板折叠时无感）
  } catch {
    /* 历史是辅助信息，失败静默 */
  } finally {
    if (seq === logSeq) state.gitLogLoading = false;
  }
}

/** push/pull 公共骨架：网络操作 busy 标记 + 成功后刷新 status/log */
async function runGitNetworkOp(
  state: GitPanelState,
  op: "push" | "pull",
  opts?: { remote?: string; branch?: string; setUpstream?: boolean },
): Promise<boolean> {
  const b = bridge();
  const fn = op === "push" ? b?.gitPush : b?.gitPull;
  if (!fn || !state.gitRepoPath || state.gitNetworkBusy) return false;
  state.gitNetworkBusy = op;
  state.gitErrorKind = null;
  state.gitErrorDetail = null;
  try {
    const res = op === "push"
      ? await b!.gitPush!(state.gitRepoPath, opts)
      : await b!.gitPull!(state.gitRepoPath);
    if (!res?.success) {
      state.gitErrorKind = "generic";
      state.gitErrorDetail = res?.message ?? null;
      return false;
    }
    await Promise.all([refreshGitStatus(state), loadGitLog(state)]);
    return true;
  } catch (err) {
    state.gitErrorKind = "generic";
    state.gitErrorDetail = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    state.gitNetworkBusy = null;
  }
}

export async function pushGitChanges(state: GitPanelState): Promise<boolean> {
  const branch = state.gitStatus?.branch?.head ?? "";
  // detached HEAD / 空仓库：git-parse 约定 head 为 "(detached)" 或 null，
  // 此时无有效 refspec 可推，前置拦截并给出可读错误（而非透传 git 原始报错）
  if (!branch || branch === "(detached)") {
    state.gitErrorKind = "generic";
    state.gitErrorDetail = "no-branch";
    return false;
  }
  const hasUpstream = !!state.gitStatus?.branch?.upstream;
  return runGitNetworkOp(state, "push", hasUpstream ? undefined : { remote: "origin", branch, setUpstream: true });
}

export async function pullGitChanges(state: GitPanelState): Promise<boolean> {
  return runGitNetworkOp(state, "pull");
}

/** 丢弃已跟踪文件的未暂存改动（UI 层必须先弹危险确认） */
export async function discardGitFiles(state: GitPanelState, paths: string[]): Promise<boolean> {
  const b = bridge();
  if (!b?.gitDiscard || !state.gitRepoPath || paths.length === 0) return false;
  return runDestructiveGitOp(state, paths, "discard");
}

/** 删除未跟踪文件（UI 层必须先弹危险确认） */
export async function cleanGitFiles(state: GitPanelState, paths: string[]): Promise<boolean> {
  const b = bridge();
  if (!b?.gitClean || !state.gitRepoPath || paths.length === 0) return false;
  return runDestructiveGitOp(state, paths, "clean");
}

// discard/clean 公共骨架：复用 gitBusyPaths per-row spinner
async function runDestructiveGitOp(
  state: GitPanelState,
  paths: string[],
  op: "discard" | "clean",
): Promise<boolean> {
  const b = bridge();
  const fn = op === "discard" ? b?.gitDiscard : b?.gitClean;
  if (!fn || !state.gitRepoPath) return false;
  const next = new Set(state.gitBusyPaths);
  for (const p of paths) next.add(p);
  state.gitBusyPaths = next;
  state.gitErrorKind = null;
  state.gitErrorDetail = null;
  try {
    const res = await fn(state.gitRepoPath, paths);
    if (!res?.success) {
      state.gitErrorKind = "generic";
      state.gitErrorDetail = res?.message ?? null;
      return false;
    }
    await refreshGitStatus(state);
    return true;
  } catch (err) {
    state.gitErrorKind = "generic";
    state.gitErrorDetail = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    const after = new Set(state.gitBusyPaths);
    for (const p of paths) after.delete(p);
    state.gitBusyPaths = after;
  }
}
