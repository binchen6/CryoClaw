import type { GatewayBrowserClient } from "../gateway.ts";

// doctor.memory.status 返回结构（内核 2026.9.3，字段防御性取值）：
// 成功 { agentId, provider, embedding: { ok, checked?, error? },
//        dreaming: { enabled, frequency?, shortTermCount, totalSignalCount, recallSignalCount,
//                    promotedTotal, promotedToday, lightPhaseHitCount, remPhaseHitCount,
//                    phases: { light/deep/rem: { enabled, nextRunAt? } } } }
// 失败 { agentId, embedding: { ok: false, error } }
export type MemoryStatus = {
  provider?: string;
  embedding?: { ok?: boolean; error?: string };
  dreaming?: {
    enabled?: boolean;
    frequency?: string;
    shortTermCount?: number;
    totalSignalCount?: number;
    recallSignalCount?: number;
    dailySignalCount?: number;
    promotedTotal?: number;
    promotedToday?: number;
    lightPhaseHitCount?: number;
    remPhaseHitCount?: number;
  };
};

// doctor.memory.dreamDiary：{ agentId, path, found, content }
// （梦境分页实际走主进程 IPC memory:list-dreams/read-dream 统一解析，保证
//  列表 index 与删除接口一致；此处不另设读取路径）

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
// probe=true 时深测 embedding 连通性（doctor.memory.status { probe: true }）。
export async function loadMemoryStatus(
  state: MemoryStatusState,
  gateway: MemoryGatewayState,
  requestUpdate: () => void,
  opts?: { probe?: boolean; force?: boolean },
) {
  const client = gateway.client;
  if (state.statusLoading || (!opts?.force && state.statusLoaded) || !client || !gateway.connected) {
    return;
  }
  state.statusLoading = true;
  requestUpdate();
  try {
    state.memoryStatus = (await client.request("doctor.memory.status", opts?.probe ? { probe: true } : {})) as MemoryStatus;
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

// 危险区：清空短期回忆信号（doctor.memory.resetGroundedShortTerm）
export async function resetGroundedShortTerm(client: GatewayBrowserClient | null): Promise<boolean> {
  if (!client) return false;
  try {
    await client.request("doctor.memory.resetGroundedShortTerm", {});
    return true;
  } catch {
    return false;
  }
}

// 危险区：清空梦境日记（doctor.memory.resetDreamDiary）
export async function resetDreamDiary(client: GatewayBrowserClient | null): Promise<boolean> {
  if (!client) return false;
  try {
    await client.request("doctor.memory.resetDreamDiary", {});
    return true;
  } catch {
    return false;
  }
}
