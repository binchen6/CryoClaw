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
const statusCache = new WeakMap<GatewayBrowserClient, {value:MemoryStatus;at:number}>();
const statusRequests = new WeakMap<GatewayBrowserClient, Promise<MemoryStatus>>();
const generations = new WeakMap<GatewayBrowserClient, number>();
const readers = new WeakMap<MemoryStatusState, {client:GatewayBrowserClient}>();
export function invalidateMemoryStatus(client: GatewayBrowserClient): void {
  generations.set(client,(generations.get(client)??0)+1);
  statusCache.delete(client);
  statusRequests.delete(client);
}
export function memoryStatusFresh(client: GatewayBrowserClient): boolean {
  const cached=statusCache.get(client);
  return !!cached && Date.now()-cached.at<30000;
}

// 拉取记忆系统状态；RPC 失败时降级为提示文字，不影响设置页其他开关。
// probe=true 时深测 embedding 连通性（doctor.memory.status { probe: true }）。
export async function loadMemoryStatus(
  state: MemoryStatusState,
  gateway: MemoryGatewayState,
  requestUpdate: () => void,
  opts?: { probe?: boolean; force?: boolean },
) {
  const client = gateway.client;
  const force=opts?.force || opts?.probe;
  if (!client || !gateway.connected || state.statusLoading && readers.get(state)?.client===client) {
    return;
  }
  const reader={client};readers.set(state,reader);
  if (!force && memoryStatusFresh(client)) {
    state.memoryStatus=statusCache.get(client)!.value;state.statusLoaded=true;state.statusLoading=false;state.statusFailed=false;requestUpdate();return;
  }
  const generation=generations.get(client)??0;
  const owns=()=>readers.get(state)===reader;
  const current=()=>owns() && gateway.client===client && gateway.connected && (generations.get(client)??0)===generation;
  const pending = statusRequests.get(client);
  let request: Promise<MemoryStatus> | undefined;
  state.statusLoading = true;
  requestUpdate();
  try {
    if (pending && !force) {
      request = pending;
    } else {
      request = (async () => {
        if (pending) await pending.catch(() => {});
        return (await client.request("doctor.memory.status", opts?.probe ? { probe: true } : {})) as MemoryStatus;
      })();
      statusRequests.set(client, request);
    }
    const status = await request;
    if(!current())return;
    state.memoryStatus = status;
    statusCache.set(client,{value:status,at:Date.now()});
    state.statusLoaded = true;
    state.statusFailed = false;
  } catch {
    if(!current())return;
    state.memoryStatus = null;
    state.statusLoaded = true;
    state.statusFailed = true;
  } finally {
    if (request && statusRequests.get(client) === request) statusRequests.delete(client);
    if(owns()){state.statusLoading = false;requestUpdate();}
  }
}

export function preloadMemoryStatus(gateway: MemoryGatewayState): Promise<void> {
  return loadMemoryStatus({ memoryStatus: null, statusLoading: false, statusLoaded: false, statusFailed: false }, gateway, () => {});
}

// 危险区：清空短期回忆信号（doctor.memory.resetGroundedShortTerm）
export async function resetGroundedShortTerm(client: GatewayBrowserClient | null): Promise<boolean> {
  if (!client) return false;
  try {
    await client.request("doctor.memory.resetGroundedShortTerm", {});
    invalidateMemoryStatus(client);
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
    invalidateMemoryStatus(client);
    return true;
  } catch {
    return false;
  }
}
