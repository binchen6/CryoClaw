import type { GatewayBrowserClient } from "../gateway.ts";
import type { TaskSummary, TasksListResult, TaskStatus } from "../types.ts";

export type TasksState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  tasksLoading: boolean;
  tasksError: string | null;
  tasks: TaskSummary[];
  tasksStatusFilter: TaskStatus | "all";
  tasksCancellingIds: Set<string>;
};

export type TaskEventPayload = {
  action?: string;
  taskId?: string;
  task?: TaskSummary;
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return Date.parse(value);
  }
  return null;
}

/** 任务时间戳（number epoch ms / ISO string）统一转 epoch ms；无法解析返回 null */
export function toTaskTimestampMs(value: unknown): number | null {
  return toNumber(value);
}

/** tasks.list 返回行按 updatedAt 降序，缺失时间戳的排在末尾 */
export function sortTasks(tasks: TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((a, b) => {
    const at = toNumber(a.updatedAt) ?? toNumber(a.createdAt) ?? 0;
    const bt = toNumber(b.updatedAt) ?? toNumber(b.createdAt) ?? 0;
    if (bt !== at) {
      return bt - at;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

const ACTIVE_STATUSES = new Set<TaskStatus>(["queued", "running"]);

export function isActiveTask(task: TaskSummary): boolean {
  return ACTIVE_STATUSES.has(task.status ?? "queued");
}

/**
 * 任务耗时（ms）：startedAt → endedAt；进行中的任务用当前时间；
 * 终态缺 endedAt 时退化用 updatedAt。无法确定（缺 startedAt / 时长非正）返回 null。
 */
export function taskDurationMs(task: TaskSummary, now = Date.now()): number | null {
  const start = toNumber(task.startedAt);
  if (start == null) {
    return null;
  }
  const end = toNumber(task.endedAt) ?? (isActiveTask(task) ? now : toNumber(task.updatedAt));
  if (end == null || end <= start) {
    return null;
  }
  return end - start;
}

export function filterTasksByStatus(
  tasks: TaskSummary[],
  status: TaskStatus | "all",
): TaskSummary[] {
  if (status === "all") {
    return tasks;
  }
  return tasks.filter((task) => task.status === status);
}

/** 合并事件推送的任务到本地列表（upsert/delete），保持排序 */
export function applyTaskEvent(
  current: TaskSummary[],
  payload: TaskEventPayload | undefined,
): TaskSummary[] | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const action = payload.action;
  if (action === "deleted") {
    const taskId = typeof payload.taskId === "string" ? payload.taskId : payload.task?.id;
    if (!taskId) {
      return null;
    }
    return sortTasks(current.filter((task) => task.id !== taskId));
  }
  if (action === "upserted") {
    const task = payload.task;
    if (!task || typeof task.id !== "string") {
      return null;
    }
    const rest = current.filter((entry) => entry.id !== task.id);
    return sortTasks([task, ...rest]);
  }
  // action === "restored"（或未知）→ 需要重新拉取全量
  return null;
}

// 在途刷新期间若再被请求刷新（如 task 事件触发），置脏标记并在完成后补跑一轮：
// 否则旧请求晚到的响应会整体覆盖事件增量（列表陈旧最长一个 ticker 周期）。
let tasksRefreshPending = false;

export async function loadTasks(state: TasksState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.tasksLoading) {
    tasksRefreshPending = true;
    return;
  }
  state.tasksLoading = true;
  state.tasksError = null;
  try {
    // 始终拉全量（status 过滤在客户端做）：保证侧边栏进行中徽标与视图过滤互不影响
    const res = await state.client.request<TasksListResult>("tasks.list", {
      limit: 200,
    });
    state.tasks = sortTasks(Array.isArray(res.tasks) ? res.tasks : []);
  } catch (err) {
    state.tasksError = String(err);
  } finally {
    state.tasksLoading = false;
    if (tasksRefreshPending) {
      tasksRefreshPending = false;
      void loadTasks(state);
    }
  }
}

export async function cancelTask(state: TasksState, taskId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.tasksCancellingIds.has(taskId)) {
    return;
  }
  const next = new Set(state.tasksCancellingIds);
  next.add(taskId);
  state.tasksCancellingIds = next;
  state.tasksError = null;
  try {
    await state.client.request("tasks.cancel", { taskId });
    await loadTasks(state);
  } catch (err) {
    state.tasksError = String(err);
  } finally {
    const after = new Set(state.tasksCancellingIds);
    after.delete(taskId);
    state.tasksCancellingIds = after;
  }
}
