/**
 * 子代理等待状态卡数据选择（R23）：
 * 从 tasks 列表中选出与当前会话相关的 subagent 任务，投影为聊天区内联卡片。
 * - 活跃（queued/running）任务恒显示（主 run 等待子代理期间的进度反馈）
 * - 终态任务短暂定格展示（grace 窗口），随后由 tick 刷新自然隐藏
 * - 跨会话任务不显示（与 tool / lifecycle 流的会话过滤约定一致）
 */
import type { TaskSummary } from "../types.ts";

// 2026.9.7 起 tasks.* 已移除，本模块不再有实时数据源（app-chat-props 恒传空数组），
// 纯函数与测试保留以待内核恢复任务面；活跃判定内联于此（原 controllers/tasks.ts
// isActiveTask：queued/running 为进行中，缺省按 queued）。

export type SubagentCard = {
  id: string;
  title: string;
  status: string;
  active: boolean;
  progress: string | null;
};

// 终态定格窗口：完成后短暂保留卡片展示结果，避免一闪而过。
// 收敛时机依赖下一次 buildChatItems 重算（新消息/流式/tick 驱动；公共 ticker 周期较长，
// 实际定格时长 = 窗口 + 至下一次重算的间隔）。
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
    // 无 status 字段视为不可判定，按终态路径走时间窗兜底（防僵尸等待卡：
    // 缺失 status 若按 queued 算活跃会误判为活跃恒显示）
    const active = task.status === "queued" || task.status === "running";
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
