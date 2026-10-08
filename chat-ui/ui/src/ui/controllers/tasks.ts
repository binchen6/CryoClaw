import type { GatewayBrowserClient, GatewayHelloOk } from "../gateway.ts";
import type { CronJob, CronRunHistoryResult, CronRunLogEntry } from "../types.ts";
import { supportsMethod } from "./capabilities.ts";

/**
 * 任务页「运行记录」数据源（2026.9.7 适配）：
 * 内核已移除 tasks.*，全局运行记录改走 cron.runs scope:"all"（不传 id 时的缺省
 * scope），返回 {entries,total,offset,limit,hasMore,nextOffset}，entries 为
 * CronRunLogEntry 且内核已按 jobId 附带 jobName；cron.list 仅作 jobName 兜底补全。
 * 注意 cron.history 不是列表接口：它要求 {id, runId|runAtMs}，返回单次运行的
 * transcript（委托 chat.history），不能用作运行记录数据源。
 * 响应字段防御式归一化：容忍缺 ts/status/summary 等字段与未知 status 字符串。
 */

export type RunHistoryState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  runsLoading: boolean;
  runsError: string | null;
  runHistory: CronRunLogEntry[];
  runsStatusFilter: CronRunStatusFilter;
  /** jobName 兜底补全来源（cron.list 结果；内核通常已在 entries 上附带 jobName） */
  cronJobs: CronJob[];
  /** 当前内核未注册 cron.runs：视图显示说明性空态而非报错 */
  runsUnsupported: boolean;
};

/** 状态筛选值："all" | 三种内核已知状态（ok/error/skipped） */
export type CronRunStatusFilter = "all" | "ok" | "error" | "skipped";

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return Date.parse(value);
  }
  return null;
}

/** 运行记录时间戳（number epoch ms / ISO string）统一转 epoch ms；无法解析返回 null */
export function toRunTimestampMs(value: unknown): number | null {
  return toNumber(value);
}

/** 记录展示时间：ts（记录写入时间）优先，runAtMs（触发时间）兜底 */
export function runTimestampMs(entry: CronRunLogEntry): number | null {
  return toNumber(entry.ts) ?? toNumber(entry.runAtMs);
}

/** cron.runs 返回行按展示时间降序，缺失时间戳的排在末尾 */
export function sortRunsByTimestamp(runs: CronRunLogEntry[]): CronRunLogEntry[] {
  return [...runs].sort((a, b) => {
    const at = runTimestampMs(a) ?? 0;
    const bt = runTimestampMs(b) ?? 0;
    if (bt !== at) {
      return bt - at;
    }
    return (a.jobId ?? "") < (b.jobId ?? "") ? -1 : (a.jobId ?? "") > (b.jobId ?? "") ? 1 : 0;
  });
}

// ── 统计/筛选纯函数（视图渲染与测试共用） ─────────────────────────────
// 全部为无 DOM/无副作用函数，node --test 可直接 import（本模块仅有 type-only 依赖）。

/** 状态分组 key：统计条 4 枚 chip 的粒度（other 覆盖缺省/未知状态字符串） */
export type RunGroupKey = "ok" | "error" | "skipped" | "other";

/** 单状态 → 分组：ok/error/skipped 直通；缺省与未知字符串 → other */
export function runGroupOfStatus(status: string | undefined): RunGroupKey {
  switch (status) {
    case "ok":
    case "error":
    case "skipped":
      return status;
    default:
      return "other";
  }
}

export type RunStats = {
  total: number;
  ok: number;
  error: number;
  skipped: number;
  other: number;
};

/** 统计条计数：始终基于全量列表计算（不受当前筛选影响，计数才是统计语义） */
export function deriveRunStats(runs: readonly CronRunLogEntry[]): RunStats {
  const stats: RunStats = { total: runs.length, ok: 0, error: 0, skipped: 0, other: 0 };
  for (const run of runs) {
    stats[runGroupOfStatus(run.status)] += 1;
  }
  return stats;
}

/**
 * 客户端搜索过滤：jobName/jobId/summary/error/sessionKey 子串匹配
 * （大小写不敏感、两侧 trim）。空查询原样返回（引用不变，调用方无需分支）。
 */
export function filterRunsByQuery(runs: CronRunLogEntry[], query: string): CronRunLogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return runs;
  }
  return runs.filter((run) => {
    const fields = [run.jobName, run.jobId, run.summary, run.error, run.sessionKey];
    return fields.some((field) => typeof field === "string" && field.toLowerCase().includes(q));
  });
}

/** 状态过滤匹配：单状态 select 优先，其次统计 chip 分组（other 覆盖未知状态） */
export function runMatchesStatusFilter(
  run: CronRunLogEntry,
  statusFilter: CronRunStatusFilter,
  statusGroup: RunGroupKey | "all",
): boolean {
  if (statusFilter !== "all") {
    return run.status === statusFilter;
  }
  if (statusGroup !== "all") {
    return runGroupOfStatus(run.status) === statusGroup;
  }
  return true;
}

/** jobName 兜底补全：内核 scope:"all" 响应通常已附带；任务已删/旧内核缺省时按 cron.list 反查 */
export function enrichRunJobNames(
  runs: CronRunLogEntry[],
  jobs: readonly CronJob[],
): CronRunLogEntry[] {
  let changed = false;
  const nameById = new Map<string, string>();
  for (const job of jobs) {
    const name = job.name?.trim();
    if (job.id && name) {
      nameById.set(job.id, name);
    }
  }
  if (nameById.size === 0) {
    return runs;
  }
  const next = runs.map((run) => {
    if (typeof run.jobName === "string" && run.jobName.trim()) {
      return run;
    }
    const name = run.jobId ? nameById.get(run.jobId) : undefined;
    if (!name) {
      return run;
    }
    changed = true;
    return { ...run, jobName: name };
  });
  return changed ? next : runs;
}

// 在途刷新期间若再被请求刷新（如 cron 事件触发），置脏标记并在完成后补跑一轮：
// 否则旧请求晚到的响应会整体覆盖事件增量（列表陈旧最长一个 ticker 周期）。
// chat-ui 按单 app 实例设计：模块级瞬态变量依赖单挂载前提（sessions.ts 已改用
// WeakMap keyed by state；若未来出现多实例需求，这里需同样改造）
let runsRefreshPending = false;

export async function loadRunHistory(state: RunHistoryState) {
  if (!state.client || !state.connected) {
    return;
  }
  // 能力门控：内核未注册 cron.runs 时零请求（2026.9.7 已注册；更老内核走空态）
  if (!supportsMethod(state.hello, "cron.runs")) {
    state.runsUnsupported = true;
    state.runHistory = [];
    state.runsError = null;
    return;
  }
  state.runsUnsupported = false;
  if (state.runsLoading) {
    runsRefreshPending = true;
    return;
  }
  state.runsLoading = true;
  state.runsError = null;
  try {
    // 始终拉全量（status 过滤在客户端做）：统计条计数与筛选互不影响。
    // 不传 id 时内核缺省 scope:"all"，返回全部任务的运行记录分页（上限 200）
    const res = await state.client.request<CronRunHistoryResult>("cron.runs", {
      scope: "all",
      limit: 200,
    });
    const entries = Array.isArray(res.entries) ? res.entries : [];
    state.runHistory = enrichRunJobNames(sortRunsByTimestamp(entries), state.cronJobs);
  } catch (err) {
    state.runsError = String(err);
  } finally {
    state.runsLoading = false;
    if (runsRefreshPending) {
      runsRefreshPending = false;
      void loadRunHistory(state);
    }
  }
}
