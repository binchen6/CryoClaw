import type { GatewayBrowserClient } from "../gateway.ts";
import type { ApprovalKind } from "./exec-approval.ts";

export type { ApprovalKind };
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type ApprovalHistoryEntry = {
  id: string;
  kind: ApprovalKind;
  /** exec 为命令文本，plugin 为标题/插件名 */
  title: string;
  /** exec 为 cwd，plugin 为描述 */
  detail: string | null;
  agentId: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  status: ApprovalStatus;
  decision: string | null;
  resolvedBy: string | null;
  resolvedAtMs: number | null;
};

// 会话级审批记录缓存：RPC 只能查到 pending，已审批/拒绝/过期的记录靠事件流本地留存。
// 上限 100 条，超出时丢弃最旧的已完结记录。
const HISTORY_LIMIT = 100;
const store = new Map<string, ApprovalHistoryEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function entryKey(kind: ApprovalKind, id: string): string {
  return `${kind}:${id}`;
}

function titleFor(kind: ApprovalKind, request: Record<string, unknown>): string {
  if (kind === "exec") {
    return asString(request.command) ?? "";
  }
  return (
    asString(request.title) ?? asString(request.pluginId) ?? asString(request.toolName) ?? ""
  );
}

function detailFor(kind: ApprovalKind, request: Record<string, unknown>): string | null {
  if (kind === "exec") {
    return asString(request.cwd) ?? asString(request.host);
  }
  return asString(request.description) ?? asString(request.toolName);
}

function statusFromDecision(decision: string | null, resolvedAtMs: number | null): ApprovalStatus {
  if (resolvedAtMs === null) {
    return "pending";
  }
  if (decision === "allow-once" || decision === "allow-always") {
    return "approved";
  }
  if (decision === "deny") {
    return "denied";
  }
  return "expired";
}

function upsertEntry(entry: ApprovalHistoryEntry) {
  store.set(entryKey(entry.kind, entry.id), entry);
  if (store.size <= HISTORY_LIMIT) {
    return;
  }
  // 优先丢弃最旧的已完结记录；全是 pending 时丢弃最旧的一条
  const resolved = [...store.values()]
    .filter((item) => item.status !== "pending")
    .sort((a, b) => (a.resolvedAtMs ?? a.createdAtMs) - (b.resolvedAtMs ?? b.createdAtMs));
  const victim = resolved[0] ?? [...store.values()].sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
  if (victim) {
    store.delete(entryKey(victim.kind, victim.id));
  }
}

function applyRequestedPayload(kind: ApprovalKind, payload: unknown): ApprovalHistoryEntry | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = asString(payload.id);
  const request = payload.request;
  const createdAtMs = asNumber(payload.createdAtMs);
  const expiresAtMs = asNumber(payload.expiresAtMs);
  if (!id || !isRecord(request) || createdAtMs === null || expiresAtMs === null) {
    return null;
  }
  const existing = store.get(entryKey(kind, id));
  // 已完结的记录不被 requested 覆盖
  if (existing && existing.status !== "pending") {
    return existing;
  }
  const entry: ApprovalHistoryEntry = {
    id,
    kind,
    title: titleFor(kind, request),
    detail: detailFor(kind, request),
    agentId: asString(request.agentId),
    createdAtMs,
    expiresAtMs,
    status: expiresAtMs <= Date.now() ? "expired" : "pending",
    decision: null,
    resolvedBy: null,
    resolvedAtMs: null,
  };
  upsertEntry(entry);
  return entry;
}

/** 记录 exec/plugin.approval.requested 事件（也用于合并 RPC list 返回的 pending 项） */
export function recordApprovalRequested(kind: ApprovalKind, payload: unknown) {
  applyRequestedPayload(kind, payload);
}

/** 记录 exec/plugin.approval.resolved 事件，decision 为空视为过期 */
export function recordApprovalResolved(kind: ApprovalKind, payload: unknown) {
  if (!isRecord(payload)) {
    return;
  }
  const id = asString(payload.id);
  if (!id) {
    return;
  }
  const decision = asString(payload.decision);
  const resolvedBy = asString(payload.resolvedBy);
  const resolvedAtMs = asNumber(payload.ts) ?? Date.now();
  const key = entryKey(kind, id);
  const existing = store.get(key);
  if (existing) {
    existing.status = statusFromDecision(decision, resolvedAtMs);
    existing.decision = decision;
    existing.resolvedBy = resolvedBy;
    existing.resolvedAtMs = resolvedAtMs;
    return;
  }
  // 本地没有 requested 记录时，resolved 事件自带 request，可直接补一条
  if (isRecord(payload.request)) {
    upsertEntry({
      id,
      kind,
      title: titleFor(kind, payload.request),
      detail: detailFor(kind, payload.request),
      agentId: asString(payload.request.agentId),
      createdAtMs: resolvedAtMs,
      expiresAtMs: resolvedAtMs,
      status: statusFromDecision(decision, resolvedAtMs),
      decision,
      resolvedBy,
      resolvedAtMs,
    });
  }
}

function deriveVisibleStatus(entry: ApprovalHistoryEntry): ApprovalStatus {
  if (entry.status === "pending" && entry.expiresAtMs <= Date.now()) {
    return "expired";
  }
  return entry.status;
}

/** 当前历史列表（按创建时间倒序），pending 过期在读取时折算 */
export function listApprovalHistory(): ApprovalHistoryEntry[] {
  return [...store.values()]
    .map((entry) => ({ ...entry, status: deriveVisibleStatus(entry) }))
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
}

function parseListPayload(kind: ApprovalKind, payload: unknown): Set<string> {
  // 内核返回数组；防御性兼容 { items: [...] }
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.items)
      ? payload.items
      : null;
  const ids = new Set<string>();
  if (!list) {
    return ids;
  }
  for (const item of list) {
    const entry = applyRequestedPayload(kind, item);
    if (entry) {
      ids.add(entry.id);
    }
  }
  return ids;
}

// 以 RPC 返回的 pending 集合为准：本地缓存中不在集合内的 pending 项已在别处
// 完结（其他客户端审批/过期），标记为 expired；已完结项不动。
function reconcilePendingWithRpc(kind: ApprovalKind, rpcIds: Set<string>) {
  for (const entry of store.values()) {
    if (entry.kind === kind && entry.status === "pending" && !rpcIds.has(entry.id)) {
      entry.status = "expired";
      entry.resolvedAtMs = Date.now();
    }
  }
}

/**
 * 拉取 exec/plugin.approval.list 并合并进本地缓存。
 * 两个 RPC 都失败（旧内核无此方法）时抛错，由调用方降级为仅展示本地记录。
 */
export async function fetchApprovalHistory(client: GatewayBrowserClient): Promise<void> {
  const [execRes, pluginRes] = await Promise.allSettled([
    client.request<unknown>("exec.approval.list", {}),
    client.request<unknown>("plugin.approval.list", {}),
  ]);
  if (execRes.status === "rejected" && pluginRes.status === "rejected") {
    throw execRes.reason;
  }
  if (execRes.status === "fulfilled") {
    reconcilePendingWithRpc("exec", parseListPayload("exec", execRes.value));
  }
  if (pluginRes.status === "fulfilled") {
    reconcilePendingWithRpc("plugin", parseListPayload("plugin", pluginRes.value));
  }
}

/** 对 pending 项执行批准/拒绝，复用 exec/plugin.approval.resolve */
export async function resolveApproval(
  client: GatewayBrowserClient,
  kind: ApprovalKind,
  id: string,
  decision: "allow-once" | "deny",
) {
  await client.request(`${kind}.approval.resolve`, { id, decision });
  recordApprovalResolved(kind, { id, decision, ts: Date.now() });
}
