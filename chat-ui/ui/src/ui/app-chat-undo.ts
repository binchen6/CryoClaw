/**
 * 对话页「撤销本轮改动」（终态改动卡片的「撤销」按钮）。
 *
 * 与 git 面板（app-git.ts）同一交互惯例：showConfirm danger 危险确认 +
 * 结果 toast。不复用 controllers/git.ts 的 discardGitFiles/cleanGitFiles——
 * 那对函数绑定 git 面板状态（state.gitRepoPath 仅面板打开期间有值），
 * 聊天页只有会话工作区路径，故直接走 preload 桥。
 *
 * 撤销语义：丢弃这些文件的工作区改动——已跟踪文件走 git restore --worktree
 * （git:discard），未跟踪文件走 git clean -f（git:clean）。tracked/untracked
 * 分流依据是 git status 的未跟踪集合（路径整形见 chat/turn-undo-paths.ts，
 * git:discard/git:clean 只接受仓库相对路径，主进程拒绝绝对路径与 .. 逃逸）。
 */

import type { AppViewState } from "./app-view-state.ts";
import type { FileChange } from "./chat/file-changes.ts";
import { partitionUndoPaths } from "./chat/turn-undo-paths.ts";
import { showConfirm } from "./views/confirm-dialog.ts";
import { showToast } from "./app-toast.ts";
import { t, tWithDetail } from "./i18n.ts";

type GitUndoBridge = {
  gitStatus?: (cwd: string) => Promise<{
    success?: boolean;
    data?: { entries?: unknown };
    message?: string;
  }>;
  gitDiscard?: (cwd: string, paths: string[]) => Promise<{ success?: boolean; message?: string }>;
  gitClean?: (cwd: string, paths: string[]) => Promise<{ success?: boolean; message?: string }>;
};

function undoBridge(): GitUndoBridge | undefined {
  return (window as unknown as { cryoclaw?: GitUndoBridge }).cryoclaw;
}

/** 从 git status 响应取未跟踪路径集合（entries 为主进程解析的仓库相对路径） */
function collectUntracked(status: { data?: { entries?: unknown } }): Set<string> {
  const untracked = new Set<string>();
  const entries = status.data?.entries;
  if (!Array.isArray(entries)) return untracked;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (row.kind === "untracked" && typeof row.path === "string" && row.path) {
      untracked.add(row.path);
    }
  }
  return untracked;
}

export async function confirmAndUndoTurnChanges(
  state: AppViewState,
  workspacePath: string,
  files: FileChange[],
): Promise<void> {
  if (!workspacePath || files.length === 0) return;
  const confirmed = await showConfirm(
    state,
    t("chat.undoChangesConfirm").replace("{n}", String(files.length)),
    { danger: true },
  );
  if (!confirmed) return;
  const bridge = undoBridge();
  // 桥缺失视为环境异常（理论上前端装配已按 gitAvailable 门控按钮）
  if (!bridge?.gitStatus || !bridge.gitDiscard || !bridge.gitClean) {
    showToast(state, t("git.opFailed"), undefined, "error");
    return;
  }
  const status = await bridge.gitStatus(workspacePath).catch(() => null);
  if (!status?.success || !status.data) {
    showToast(state, t("git.opFailed"), undefined, "error");
    return;
  }
  const { discard, clean } = partitionUndoPaths(files, workspacePath, collectUntracked(status));
  if (discard.length === 0 && clean.length === 0) {
    showToast(state, t("git.opFailed"), undefined, "error");
    return;
  }
  // 两个操作相互独立：各自成败分别记，全部成功才算撤销完成
  let lastError: string | null = null;
  let ok = true;
  if (discard.length > 0) {
    const res = await bridge.gitDiscard(workspacePath, discard).catch(() => null);
    ok = ok && res?.success === true;
    if (!res?.success) lastError = res?.message ?? null;
  }
  if (clean.length > 0) {
    const res = await bridge.gitClean(workspacePath, clean).catch(() => null);
    ok = ok && res?.success === true;
    if (!res?.success) lastError = res?.message ?? null;
  }
  showToast(
    state,
    ok ? t("git.discarded") : tWithDetail("git.opFailed", lastError),
    undefined,
    ok ? "success" : "error",
  );
}
