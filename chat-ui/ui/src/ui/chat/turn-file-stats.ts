/**
 * 「本轮改动」胶囊的行数统计 —— 渲染层纯函数与 IPC 响应整形（可单测）。
 *
 * 数据流：oc-turn-files 组件在消息/可见数变化时按签名防抖拉取
 * `window.cryoclaw.gitChangeStats(workspacePath, paths)`（主进程 git:change-stats），
 * 本模块负责签名、响应校验与汇总：
 * - stats[].path 与传入路径一一对应（主进程原样回传），按路径建索引；
 * - 全部文件都有行数且未 truncated 才算「行数可用」，否则整体退回
 *   「新增/删除文件数」——不做半截统计，避免总数误导；
 * - 任何失败/异常都返回空结果（complete:false），界面静默降级不阻塞聊天。
 *
 * 拉取时机、250ms 防抖、过期响应丢弃与按签名缓存在组件内实现。
 */

import type { FileChange } from "./file-changes.ts";

export type TurnFileStat = {
  path: string;
  additions: number;
  deletions: number;
  /** 二进制文件：行数无意义，UI 不显示数字 */
  binary?: boolean;
};

/** IPC 响应（window.cryoclaw.gitChangeStats） */
export type TurnStatsBridgeResponse = {
  success?: boolean;
  data?: { stats?: unknown; truncated?: boolean };
  error?: string;
  message?: string;
};

export type TurnStatsLookup = {
  /** 路径 → 行数统计（只含主进程返回的路径） */
  byPath: Record<string, TurnFileStat>;
  /** 本轮所有文件都有行数且结果未截断 —— 行数可用 */
  complete: boolean;
};

const EMPTY_LOOKUP: TurnStatsLookup = { byPath: {}, complete: false };

/** 结果缓存键：workspacePath + 文件路径列表（顺序变化视为不同签名，按新数据重拉） */
export function turnStatsSignature(
  workspacePath: string | undefined,
  paths: readonly string[],
): string {
  return `${workspacePath ?? ""}\u0000${paths.join("\u0001")}`;
}

function toLineCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** 校验 IPC 返回的 stats 并建立路径索引；paths 为本次请求的完整路径列表 */
export function buildTurnStatsLookup(
  stats: unknown,
  paths: readonly string[],
  truncated?: boolean,
): TurnStatsLookup {
  const byPath: Record<string, TurnFileStat> = {};
  if (Array.isArray(stats)) {
    for (const raw of stats) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const path = typeof row.path === "string" ? row.path : "";
      if (!path || byPath[path]) continue;
      byPath[path] = {
        path,
        additions: toLineCount(row.additions),
        deletions: toLineCount(row.deletions),
        ...(row.binary === true ? { binary: true } : {}),
      };
    }
  }
  const complete =
    truncated !== true && paths.length > 0 && paths.every((path) => byPath[path] !== undefined);
  return { byPath, complete };
}

/**
 * 拉取并整形统计；fetchStats 缺失 / 无工作区 / 无路径 / 调用失败都返回空结果。
 * 渲染层据此显示「新增/删除文件数」的降级态。
 */
export async function fetchTurnFileStats(
  fetchStats: ((cwd: string, paths: string[]) => Promise<TurnStatsBridgeResponse>) | undefined,
  workspacePath: string | undefined,
  paths: readonly string[],
): Promise<TurnStatsLookup> {
  if (!fetchStats || !workspacePath || paths.length === 0) return EMPTY_LOOKUP;
  try {
    const response = await fetchStats(workspacePath, [...paths]);
    if (!response?.success) return EMPTY_LOOKUP;
    return buildTurnStatsLookup(response.data?.stats, paths, response.data?.truncated === true);
  } catch {
    // 失败静默降级：胶囊退回文件数，不打扰聊天
    return EMPTY_LOOKUP;
  }
}

export type TurnStatsSummary = {
  /** 行数可用：显示 +行数 / −行数；false 时显示新增/删除文件数 */
  lineStatsAvailable: boolean;
  additions: number;
  deletions: number;
  addedFiles: number;
  deletedFiles: number;
};

/** 汇总胶囊上的 +N / −M：优先行数，行数不可用时退回新增/删除文件数 */
export function summarizeTurnStats(
  files: readonly FileChange[],
  lookup: TurnStatsLookup,
): TurnStatsSummary {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    const stat = lookup.byPath[file.path];
    if (!stat) continue;
    additions += stat.additions;
    deletions += stat.deletions;
  }
  return {
    lineStatsAvailable: lookup.complete && files.length > 0,
    additions,
    deletions,
    addedFiles: files.filter((file) => file.kind === "added").length,
    deletedFiles: files.filter((file) => file.kind === "deleted").length,
  };
}
