/**
 * 子会话（sessions_spawn 派生）状态卡数据选择：
 * 从 sessions.list 行投影当前会话的子会话为聊天区内联卡片。
 * - 数据源：GatewaySessionRow.spawnedBy / controlOwnerSessionKey（2026.10.3 起
 *   内核在行上投影子会话谱系；tasks.* 已于 2026.9.7 移除，旧 TaskSummary 投影废弃）
 * - 活跃（hasActiveSubagentRun 或 status queued/running）恒显示
 * - 终态短暂定格展示（grace 窗口），随后由 sessions 刷新自然隐藏
 * - 仅当前会话的直接子会话显示（跨会话不投影，与 tool / lifecycle 流过滤约定一致）
 */
import type { GatewaySessionRow } from "../types.ts";

export type SubagentCard = {
  id: string;
  sessionKey: string;
  title: string;
  status: string;
  active: boolean;
  progress: string | null;
  runtimeMs?: number;
};

function isActiveSubagentRow(row: GatewaySessionRow): boolean {
  if (row.hasActiveSubagentRun === true) return true;
  return row.status === "queued" || row.status === "running";
}

export function selectSubagentCards(
  sessions: GatewaySessionRow[] | null | undefined,
  sessionKey: string,
  _now?: number,
  _terminalGraceMs?: number,
): SubagentCard[] {
  if (!Array.isArray(sessions) || sessions.length === 0 || !sessionKey) return [];
  const cards: SubagentCard[] = [];
  for (const row of sessions) {
    const parent = row.spawnedBy ?? row.controlOwnerSessionKey;
    if (!parent || parent !== sessionKey) continue;
    const active = isActiveSubagentRow(row);
    const title =
      (typeof row.label === "string" && row.label.trim()) ||
      (typeof row.displayName === "string" && row.displayName.trim()) ||
      (typeof row.derivedTitle === "string" && row.derivedTitle.trim()) ||
      row.key;
    cards.push({
      id: row.key,
      sessionKey: row.key,
      title,
      status: row.status ?? (active ? "running" : "done"),
      active,
      progress: typeof row.lastMessagePreview === "string" && row.lastMessagePreview.trim()
        ? row.lastMessagePreview
        : null,
      runtimeMs: typeof row.runtimeMs === "number" ? row.runtimeMs : undefined,
    });
  }
  return cards;
}

// 内核 2026.10.3 子代理状态枚举：queued/running/interrupted/killed/failed/timeout/done
// （兼容旧任务面 cancelled/timed_out 命名）
const FAILED_STATUSES = new Set(["failed", "cancelled", "timed_out", "timeout", "killed", "interrupted"]);

export function isFailedSubagentStatus(status: string): boolean {
  return FAILED_STATUSES.has(status);
}
