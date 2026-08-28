/**
 * Worktrees 控制器 —— 内核 worktrees.list / remove / restore / gc RPC 封装。
 *
 * 内核事实（发货 gateway.asar 取证）：
 * - worktrees.list {} → { worktrees: WorktreeRecord[] }；返回活跃项 + 有快照的可恢复已删项
 * - worktrees.remove {id, force?} → {removed, snapshotRef?}（有改动时自动快照）
 * - worktrees.restore {id} → 恢复快照
 * - worktrees.gc {} → {removed: string[], orphansDeleted, snapshotsPruned}
 * - 会话 ↔ worktree 关联：record.ownerKind === "session" && ownerId === sessionKey
 *   （sessions.list 行不投影 worktree 字段，徽标数据只能从这里推导）
 */

import type { GatewayBrowserClient } from "../gateway.ts";

export type WorktreeRecord = {
  id: string;
  name: string;
  repoFingerprint: string;
  repoRoot: string;
  path: string;
  branch: string;
  baseRef: string;
  ownerKind: "manual" | "workboard" | "session" | string;
  ownerId?: string;
  snapshotRef?: string;
  createdAt: number;
  lastActiveAt: number;
  removedAt?: number;
};

export type WorktreesGcResult = {
  removed: string[];
  orphansDeleted: number;
  snapshotsPruned: number;
};

export type WorktreesState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  worktreesLoading: boolean;
  worktreesError: string | null;
  worktrees: WorktreeRecord[];
  // 进行中的 remove/restore 行（per-row spinner），与 tasksCancellingIds 同一模式
  worktreesBusyIds: Set<string>;
  worktreesGcBusy: boolean;
};

/** 活跃 worktree（未被删除） */
export function isLiveWorktree(w: WorktreeRecord): boolean {
  return w.removedAt == null;
}

/** 已删除但带快照、可 restore 的 worktree */
export function isRestorableWorktree(w: WorktreeRecord): boolean {
  return w.removedAt != null && typeof w.snapshotRef === "string" && w.snapshotRef.length > 0;
}

/** 列表排序：活跃在前（lastActiveAt 降序），已删除可恢复的按 removedAt 降序排尾 */
export function sortWorktrees(list: WorktreeRecord[]): WorktreeRecord[] {
  return [...list].sort((a, b) => {
    const liveA = isLiveWorktree(a);
    const liveB = isLiveWorktree(b);
    if (liveA !== liveB) {
      return liveA ? -1 : 1;
    }
    const at = liveA ? a.lastActiveAt : (a.removedAt ?? 0);
    const bt = liveB ? b.lastActiveAt : (b.removedAt ?? 0);
    return bt - at;
  });
}

/**
 * 会话 key → 持有它的活跃 worktree（侧边栏徽标数据源）。
 * 同一会话理论上只有一个活跃 worktree；异常多条时后出现的覆盖（记录均为活跃）。
 */
export function buildWorktreeSessionMap(list: WorktreeRecord[]): Map<string, WorktreeRecord> {
  const map = new Map<string, WorktreeRecord>();
  for (const w of list) {
    if (w.ownerKind === "session" && typeof w.ownerId === "string" && w.ownerId && isLiveWorktree(w)) {
      map.set(w.ownerId, w);
    }
  }
  return map;
}

/** 内核「agent workspace 不是 git 仓库」错误识别（sessions.create {worktree:true} 的典型失败） */
export function isNotGitCheckoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not a git checkout|not a git repository/i.test(msg);
}

export async function loadWorktrees(state: WorktreesState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.worktreesLoading = true;
  state.worktreesError = null;
  try {
    const res = await state.client.request<{ worktrees?: WorktreeRecord[] }>("worktrees.list", {});
    state.worktrees = sortWorktrees(Array.isArray(res?.worktrees) ? res.worktrees : []);
  } catch (err) {
    state.worktreesError = String(err);
  } finally {
    state.worktreesLoading = false;
  }
}

// remove/restore 公共骨架：busy 集合标记 + 调用 + 成功后重拉列表；失败写 worktreesError
async function runWorktreeOp(
  state: WorktreesState,
  id: string,
  method: "worktrees.remove" | "worktrees.restore",
  params: Record<string, unknown>,
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  if (state.worktreesBusyIds.has(id)) {
    return false;
  }
  const next = new Set(state.worktreesBusyIds);
  next.add(id);
  state.worktreesBusyIds = next;
  state.worktreesError = null;
  try {
    await state.client.request(method, params);
    await loadWorktrees(state);
    return true;
  } catch (err) {
    state.worktreesError = String(err);
    return false;
  } finally {
    const after = new Set(state.worktreesBusyIds);
    after.delete(id);
    state.worktreesBusyIds = after;
  }
}

/** 删除 worktree（内核有未提交改动时自动先快照，可再 restore） */
export async function removeWorktree(state: WorktreesState, id: string, force = false): Promise<boolean> {
  return runWorktreeOp(state, id, "worktrees.remove", force ? { id, force: true } : { id });
}

/** 从快照恢复已删除的 worktree */
export async function restoreWorktree(state: WorktreesState, id: string): Promise<boolean> {
  return runWorktreeOp(state, id, "worktrees.restore", { id });
}

/** GC：清理孤儿目录与过期快照；返回结果供 toast，失败返回 null 并写 worktreesError */
export async function gcWorktrees(state: WorktreesState): Promise<WorktreesGcResult | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  if (state.worktreesGcBusy) {
    return null;
  }
  state.worktreesGcBusy = true;
  state.worktreesError = null;
  try {
    const res = await state.client.request<WorktreesGcResult>("worktrees.gc", {});
    await loadWorktrees(state);
    return res;
  } catch (err) {
    state.worktreesError = String(err);
    return null;
  } finally {
    state.worktreesGcBusy = false;
  }
}
