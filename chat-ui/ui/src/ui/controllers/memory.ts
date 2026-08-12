import type { GatewayBrowserClient } from "../gateway.ts";

// doctor.memory.status 返回结构（内核 2026.7.1-2，字段防御性取值）：
// 成功 { agentId, provider, embedding: { ok, checked?, error? }, dreaming: { shortTermCount, totalSignalCount, promotedTotal, promotedToday, ... } }
// 失败 { agentId, embedding: { ok: false, error } }
export type MemoryStatus = {
  provider?: string;
  embedding?: { ok?: boolean; error?: string };
  dreaming?: {
    shortTermCount?: number;
    totalSignalCount?: number;
    promotedTotal?: number;
    promotedToday?: number;
  };
};

export type MemoryGatewayState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
};

export type MemoryStatusState = {
  memoryStatus: MemoryStatus | null;
  statusLoading: boolean;
  statusLoaded: boolean;
  statusFailed: boolean;
};

// 拉取记忆系统状态；RPC 失败时降级为提示文字，不影响设置页其他开关。
export async function loadMemoryStatus(
  state: MemoryStatusState,
  gateway: MemoryGatewayState,
  requestUpdate: () => void,
) {
  const client = gateway.client;
  if (state.statusLoading || state.statusLoaded || !client || !gateway.connected) {
    return;
  }
  state.statusLoading = true;
  requestUpdate();
  try {
    state.memoryStatus = (await client.request("doctor.memory.status", {})) as MemoryStatus;
    state.statusLoaded = true;
    state.statusFailed = false;
  } catch {
    state.memoryStatus = null;
    state.statusLoaded = true;
    state.statusFailed = true;
  } finally {
    state.statusLoading = false;
    requestUpdate();
  }
}
