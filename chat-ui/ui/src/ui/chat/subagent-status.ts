/**
 * 子代理等待状态卡数据选择（R23）：
 * 从 tasks 列表中选出与当前会话相关的 subagent 任务，投影为聊天区内联卡片。
 * - 活跃（queued/running）任务恒显示（主 run 等待子代理期间的进度反馈）
 * - 终态任务短暂定格展示（grace 窗口），随后由 tick 刷新自然隐藏
 * - 跨会话任务不显示（与 tool / lifecycle 流的会话过滤约定一致）
 */
import type { TaskSummary } from "../types.ts";
import { isActiveTask } from "../controllers/tasks.ts";

export type SubagentCard = {
  id: string;
  title: string;
  status: string;
  active: boolean;
  progress: string | null;
};

// 终态定格窗口：完成后短暂保留卡片展示结果，避免一闪而过
const TERMINAL_GRACE_MS = 15_000;

function toMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function selectSubagentCards(
  tasks: TaskSummary[] | null | undefined,
  sessionKey: string,
  now: number = Date.now(),
): SubagentCard[] {
  if (!Array.isArray(tasks) || tasks.length === 0 || !sessionKey) {
    return [];
  }
  const cards: SubagentCard[] = [];
  for (const task of tasks) {
    if (task.runtime !== "subagent") {
      continue;
    }
    // 关联判定：任务归属会话或父会话为当前会话
    if (task.sessionKey !== sessionKey && task.ownerKey !== sessionKey) {
      continue;
    }
    const active = isActiveTask(task);
    if (!active) {
      const ended = toMillis(task.endedAt) ?? toMillis(task.updatedAt);
      if (ended === null || now - ended > TERMINAL_GRACE_MS) {
        continue;
      }
    }
    const id =
      typeof task.id === "string" && task.id
        ? task.id
        : typeof task.taskId === "string" && task.taskId
          ? task.taskId
          : `subagent:${cards.length}`;
    cards.push({
      id,
      title: task.title || task.kind || "subagent",
      status: task.status ?? (active ? "running" : "completed"),
      active,
      progress:
        typeof task.progressSummary === "string" && task.progressSummary.trim()
          ? task.progressSummary
          : null,
    });
  }
  return cards;
}

const FAILED_STATUSES = new Set(["failed", "cancelled", "timed_out"]);

export function isFailedSubagentStatus(status: string): boolean {
  return FAILED_STATUSES.has(status);
}
