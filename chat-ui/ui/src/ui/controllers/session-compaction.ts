import type { GatewayBrowserClient } from "../gateway.ts";

// 会话 rewind/fork（回放点/分支）相关 RPC 封装。
// 对应内核 RPC：sessions.compaction.{list,get,branch,restore}。
// checkpoint 字段以内核持久化结构为准（gateway/session-compaction-checkpoints.ts）。

export type SessionCompactionCheckpoint = {
  checkpointId: string;
  sessionKey?: string;
  sessionId?: string;
  createdAt: number;
  reason?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
  firstKeptEntryId?: string;
};

export type SessionCompactionListResult = {
  ok: boolean;
  key?: string;
  checkpoints?: SessionCompactionCheckpoint[];
};

export type SessionCompactionBranchResult = {
  ok: boolean;
  sourceKey?: string;
  key?: string;
  sessionId?: string;
  checkpoint?: SessionCompactionCheckpoint;
};

export type SessionCompactionState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  compactionCheckpoints: SessionCompactionCheckpoint[];
  /** 本次 checkpoints 加载时对应的 sessionKey，防止跨会话误用缓存结果 */
  compactionCheckpointsKey: string | null;
  compactionCheckpointsLoading: boolean;
  compactionCheckpointsError: string | null;
  // 正在执行 restore/branch 的 checkpointId（同一时刻只允许一个操作）
  compactionBusyCheckpointId: string | null;
};

// 拉取当前会话的回放点列表（内核按 createdAt 降序返回）
export async function loadCompactionCheckpoints(state: SessionCompactionState, key: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.compactionCheckpointsLoading = true;
  state.compactionCheckpointsError = null;
  try {
    const res = await state.client.request<SessionCompactionListResult | undefined>(
      "sessions.compaction.list",
      { key },
    );
    state.compactionCheckpoints = Array.isArray(res?.checkpoints) ? res.checkpoints : [];
    // 结果归属到加载时的 key（异步返回时当前会话可能已切换）
    state.compactionCheckpointsKey = key;
  } catch (err) {
    state.compactionCheckpoints = [];
    state.compactionCheckpointsKey = key;
    state.compactionCheckpointsError = err instanceof Error ? err.message : String(err);
  } finally {
    state.compactionCheckpointsLoading = false;
  }
}

// 回放（rewind）：把当前会话回退到指定回放点，成功返回 true
export async function restoreCompactionCheckpoint(
  state: SessionCompactionState,
  key: string,
  checkpointId: string,
): Promise<boolean> {
  if (!state.client || !state.connected || state.compactionBusyCheckpointId) {
    return false;
  }
  state.compactionBusyCheckpointId = checkpointId;
  state.compactionCheckpointsError = null;
  try {
    await state.client.request("sessions.compaction.restore", { key, checkpointId });
    return true;
  } catch (err) {
    state.compactionCheckpointsError = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    state.compactionBusyCheckpointId = null;
  }
}

// 分支（fork）：从指定回放点分叉出一个新会话，成功返回新会话 key
export async function branchCompactionCheckpoint(
  state: SessionCompactionState,
  key: string,
  checkpointId: string,
): Promise<string | null> {
  if (!state.client || !state.connected || state.compactionBusyCheckpointId) {
    return null;
  }
  state.compactionBusyCheckpointId = checkpointId;
  state.compactionCheckpointsError = null;
  try {
    const res = await state.client.request<SessionCompactionBranchResult | undefined>(
      "sessions.compaction.branch",
      { key, checkpointId },
    );
    const nextKey = typeof res?.key === "string" ? res.key.trim() : "";
    if (!nextKey) {
      throw new Error("missing branch session key");
    }
    return nextKey;
  } catch (err) {
    state.compactionCheckpointsError = err instanceof Error ? err.message : String(err);
    return null;
  } finally {
    state.compactionBusyCheckpointId = null;
  }
}
