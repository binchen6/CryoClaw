import type { GatewaySessionRow, SessionsListResult } from "./types.ts";

// Pending labels are delayed until chat.event state="final" so the agent
// runtime cannot overwrite them; they also identify local-only sessions.
export const pendingSessionLabels = new Map<string, string>();

// /new、/reset 发送后置位：内核会同 key 轮换 sessionId 并清空 transcript，
// 下一个 final 事件必须强制替换本地历史（绕过 R12 的 mergeIfStale 滞后兜底，
// 否则重置后的短历史会被误判为“滞后读”而继续显示旧对话）。
export const pendingSessionResets = new Set<string>();

export function consumePendingSessionReset(key: string): boolean {
  return pendingSessionResets.delete(key);
}

// F7：只读探测（不消费）。/new、/reset 的 final 帧若丢失在断连/gap 窗口，
// 标记会残留到重连——期间内核 transcript 已被清空，任何滞后兜底（mergeIfStale/
// R23 空读保护）都会把重置前/乐观写入的本地内容保留下来，旧对话永久残留。
// 探测到未消费标记的会话在重连读时必须强制替换（与终态路径一致）；
// 标记本身仍留给到达的终态事件/发送失败回滚去消费，这里不得 delete。
export function hasPendingSessionReset(key: string): boolean {
  return pendingSessionResets.has(key);
}

export function removePendingSessionLabel(key: string) {
  const trimmed = key.trim();
  if (trimmed) {
    pendingSessionLabels.delete(trimmed);
  }
}

export function withPendingSessionRows(
  result: SessionsListResult,
  now = Date.now(),
): SessionsListResult {
  if (pendingSessionLabels.size === 0) {
    return result;
  }

  const sessions = [...(result.sessions ?? [])];
  const pendingRows: GatewaySessionRow[] = [];
  let changed = false;

  for (const [rawKey, label] of pendingSessionLabels) {
    const key = rawKey.trim();
    if (!key) {
      continue;
    }

    const existingIndex = sessions.findIndex((row) => row.key === key);
    if (existingIndex >= 0) {
      const existing = sessions[existingIndex];
      if (!existing || existing.label === label) {
        continue;
      }
      sessions[existingIndex] = {
        ...existing,
        label,
      };
      changed = true;
      continue;
    }

    pendingRows.push({
      key,
      label,
      updatedAt: now,
    });
    changed = true;
  }

  if (!changed) {
    return result;
  }

  return {
    ...result,
    sessions: [...pendingRows, ...sessions],
  };
}
