import type { GatewayBrowserClient } from "../gateway.ts";
import type { TaskRuntime, TaskSummary, TasksListResult, TaskStatus } from "../types.ts";

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
 * 会话关联的活跃任务（R58 删除守卫）：task 的 childSessionKey（子会话）或
 * sessionKey（发起会话）任一命中即视为关联。返回第一个活跃任务，无则 null。
 */
export function findActiveTaskForSession(
  tasks: readonly TaskSummary[],
  sessionKey: string,
): TaskSummary | null {
  const key = sessionKey.trim();
  if (!key) return null;
  const lower = key.toLowerCase();
  for (const task of tasks) {
    if (!isActiveTask(task)) continue;
    const child = (task.childSessionKey ?? "").trim().toLowerCase();
    const own = (task.sessionKey ?? "").trim().toLowerCase();
    if (child === lower || own === lower) return task;
  }
  return null;
}

/** 活跃任务关联的会话 key 集合（侧边栏删除项禁用标记用） */
export function activeTaskSessionKeys(tasks: readonly TaskSummary[]): Set<string> {
  const out = new Set<string>();
  for (const task of tasks) {
    if (!isActiveTask(task)) continue;
    const child = (task.childSessionKey ?? "").trim();
    const own = (task.sessionKey ?? "").trim();
    if (child) out.add(child);
    if (own) out.add(own);
  }
  return out;
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

// ── R92：统计/筛选纯函数（视图渲染与测试共用） ─────────────────────────
// 全部为无 DOM/无副作用函数，node --test 可直接 import（本模块仅有 type-only 依赖）。

/** 状态分组 key：统计条 4 枚 chip 的粒度（active 与 failed 覆盖多个原生状态） */
export type TaskGroupKey = "active" | "completed" | "failed" | "other";

/** 单状态 → 分组：queued+running→active / completed→completed / failed+timed_out→failed / cancelled 与未知→other */
export function taskGroupOfStatus(status: TaskStatus | undefined): TaskGroupKey {
  switch (status ?? "queued") {
    case "queued":
    case "running":
      return "active";
    case "completed":
      return "completed";
    case "failed":
    case "timed_out":
      return "failed";
    default:
      return "other";
  }
}

export type TaskStats = {
  total: number;
  active: number;
  completed: number;
  failed: number;
  other: number;
};

/** 统计条计数：始终基于全量列表计算（不受当前筛选影响，计数才是统计语义） */
export function deriveTaskStats(tasks: readonly TaskSummary[]): TaskStats {
  const stats: TaskStats = { total: tasks.length, active: 0, completed: 0, failed: 0, other: 0 };
  for (const task of tasks) {
    stats[taskGroupOfStatus(task.status)] += 1;
  }
  return stats;
}

/**
 * 客户端搜索过滤：title/kind/runtime/agentId/sessionKey 子串匹配
 * （大小写不敏感、两侧 trim）。空查询原样返回（引用不变，调用方无需分支）。
 */
export function filterTasksByQuery(tasks: TaskSummary[], query: string): TaskSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return tasks;
  }
  return tasks.filter((task) => {
    const fields = [task.title, task.kind, task.runtime, task.agentId, task.sessionKey];
    return fields.some((field) => typeof field === "string" && field.toLowerCase().includes(q));
  });
}

/** 来源（runtime）筛选值："all" | 四种已知来源 | "unknown"（缺省/未知来源） */
export type TaskRuntimeFilter = "all" | TaskRuntime | "unknown";

function toRuntimeKey(runtime: string | undefined): TaskRuntime | "unknown" {
  switch (runtime) {
    case "subagent":
    case "cron":
    case "acp":
    case "cli":
      return runtime;
    default:
      return "unknown";
  }
}

/** 来源筛选："unknown" 匹配四种已知来源之外的一切值（含 runtime 缺省） */
export function filterTasksByRuntime(
  tasks: TaskSummary[],
  runtime: TaskRuntimeFilter,
): TaskSummary[] {
  if (runtime === "all") {
    return tasks;
  }
  return tasks.filter((task) => toRuntimeKey(task.runtime) === runtime);
}

/** 收集唯一 agentId（trim、去空、去重、字典序排序）—— Agent 筛选下拉选项数据源 */
export function collectAgentIds(tasks: readonly TaskSummary[]): string[] {
  const seen = new Set<string>();
  for (const task of tasks) {
    const id = task.agentId?.trim();
    if (id) {
      seen.add(id);
    }
  }
  return [...seen].sort();
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
