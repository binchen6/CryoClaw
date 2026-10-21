/**
 * 「撤销本轮改动」的路径处理（纯函数，node:test 直接覆盖）。
 *
 * 为什么需要：git:discard / git:clean 只接受仓库相对路径（主进程
 * sanitizeGitRelPaths 拒绝绝对路径与 .. 逃逸），而渲染层文件改动来自
 * 工具调用参数——可能是绝对路径（Windows 反斜杠）、cwd 相对路径或
 * ./ 前缀混用。这里统一归一化后把「工作区内的绝对路径」转成相对路径，
 * 工作区外的路径直接判为不可撤销（skipped），由主进程做最终校验。
 */

import type { FileChange } from "./file-changes.ts";

/** 反斜杠转正斜杠并去掉 ./ 前缀，供前缀比较与 git pathspec 使用 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:\//.test(path);
}

/**
 * 把渲染层文件路径转成 git 可接受的仓库相对路径。
 * 返回 null 表示无法安全转换（空路径、.. 逃逸、不在工作区内）——调用方跳过。
 */
export function toRepoRelativePath(path: string, workspaceRoot: string): string | null {
  const normalized = normalizePath(path.trim());
  if (!normalized) return null;
  // 任何形态的 .. 逃逸都不进 git pathspec（主进程同样拒绝，这里提前丢弃）
  if (normalized.split("/").includes("..")) return null;
  if (!isAbsolute(normalized)) return normalized;
  const root = normalizePath(workspaceRoot.trim()).replace(/\/+$/, "");
  if (!root) return null;
  // Windows 盘符不区分大小写，前缀比较统一小写（与主进程 path 校验同语义）
  const lower = normalized.toLowerCase();
  const lowerRoot = root.toLowerCase();
  if (lower === lowerRoot) return null;
  if (!lower.startsWith(`${lowerRoot}/`)) return null;
  return normalized.slice(root.length + 1);
}

export type UndoPathPartition = {
  /** 已跟踪（及暂存）文件：走 git restore --worktree */
  discard: string[];
  /** 未跟踪文件：走 git clean -f */
  clean: string[];
  /** 无法安全转换的路径（工作区外/逃逸），不参与撤销 */
  skipped: string[];
};

/** 按 git status 的未跟踪集合把本轮改动分流为 discard / clean / skipped */
export function partitionUndoPaths(
  files: readonly FileChange[],
  workspaceRoot: string,
  untracked: ReadonlySet<string>,
): UndoPathPartition {
  const result: UndoPathPartition = { discard: [], clean: [], skipped: [] };
  for (const file of files) {
    const rel = toRepoRelativePath(file.path, workspaceRoot);
    if (rel === null) {
      result.skipped.push(file.path);
    } else if (untracked.has(rel)) {
      result.clean.push(rel);
    } else {
      result.discard.push(rel);
    }
  }
  return result;
}
