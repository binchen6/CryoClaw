/**
 * Tasks 实时视图 — v2026.7 内核 tasks.list / tasks.cancel + task 事件。
 * 展示进行中（queued/running）与最近完成的后台任务，可取消、可跳转会话。
 * 2026.9 视觉重写：任务卡 → 清单式行（状态点 + 等宽 meta + hairline 分隔），
 * 顶层 tab → 分段控件（segmented control）。
 * R92：新增统计条（状态分组 chip 联动过滤）、搜索/来源/Agent 客户端筛选、
 * 30s 自动刷新开关（ticker 生命周期在 app-tasks）、失败详情展开/收起与
 * 「显示全部」。过滤/展开等视图私有状态放模块级变量（不给 AppViewState 加
 * 字段，参照 app-skills 的 skillsSubTab 模式）；统计与过滤逻辑走
 * controllers/tasks.ts 导出的纯函数，便于测试与复用。
 */
import { html, nothing, type TemplateResult } from "lit";
import type { CronJob, TaskSummary, TaskStatus } from "../types.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../format.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import "../components/toggle-switch.ts";
import {
  collectAgentIds,
  deriveTaskStats,
  filterTasksByQuery,
  filterTasksByRuntime,
  isActiveTask,
  taskDurationMs,
  taskGroupOfStatus,
  toTaskTimestampMs,
  type TaskGroupKey,
  type TaskRuntimeFilter,
  type TaskStats,
} from "../controllers/tasks.ts";

export type TasksViewTab = "runs" | "cron";

export type TasksProps = {
  loading: boolean;
  error: string | null;
  tasks: TaskSummary[];
  cronJobs: CronJob[];
  statusFilter: TaskStatus | "all";
  cancellingIds: ReadonlySet<string>;
  connected: boolean;
  tab: TasksViewTab;
  /** 定时 tab 内容（由装配层组装 renderCronView，避免 views 层反向依赖 app-cron） */
  cronSlot: TemplateResult;
  /** 启用中定时任务数（定时 tab 徽标） */
  cronJobCount: number;
  /** R92：30s 自动刷新开关状态（ticker 生命周期由 app-tasks 管理） */
  autoRefresh: boolean;
  onTabChange: (tab: TasksViewTab) => void;
  /** runtime === "cron" 任务行「查看定时任务」→ 切定时 tab */
  onOpenCronTab: () => void;
  onStatusFilterChange: (status: TaskStatus | "all") => void;
  onRefresh: () => void;
  onCancel: (taskId: string) => void;
  onOpenChat: (sessionKey: string) => void;
  /** R92：自动刷新开关切换（app-tasks 起/停 ticker） */
  onAutoRefreshChange: (enabled: boolean) => void;
  /** R92：视图私有状态变更（搜索防抖提交/展开切换等，无 RPC）后请求重渲染 */
  requestUpdate: () => void;
};

const STATUS_OPTIONS: Array<TaskStatus | "all"> = [
  "all",
  "running",
  "queued",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
];

// 来源筛选选项：四种已知 runtime + unknown（缺省/未知来源，标签复用 tasks.runtime.*）
const RUNTIME_FILTER_OPTIONS: TaskRuntimeFilter[] = ["subagent", "cron", "acp", "cli", "unknown"];

// 搜索防抖：停键 200ms 才提交过滤词并重渲染（避免每键 requestUpdate 风暴）
const SEARCH_DEBOUNCE_MS = 200;
// 最近完成默认折叠条数（超过才出现「显示全部」）
const RECENT_CLAMP = 50;
// 失败行错误详情默认截断字符数
const ERROR_DETAIL_CLAMP = 140;

// ── 视图私有过滤/交互状态（模块级；切走视图不重置，回到本页保留筛选上下文） ──
let tasksSearchInput = ""; // 搜索框即时值（每键同步，不触发渲染）
let tasksSearchQuery = ""; // 防抖提交后的过滤词（真正参与过滤）
let tasksSearchTimer: ReturnType<typeof setTimeout> | null = null;
let tasksRuntimeFilter: TaskRuntimeFilter = "all"; // 来源筛选
let tasksAgentFilter = ""; // Agent 筛选（空 = 全部）
// 统计 chip 的分组过滤态（active=queued+running、failed=failed+timed_out 等多
// 状态组无法塞进 AppViewState 的单状态 statusFilter，故存视图模块级）
let tasksStatusGroup: TaskGroupKey | "all" = "all";
let tasksShowAllRecent = false; // 最近完成 >50 条时在 50/全部之间切换
const tasksExpandedErrorIds = new Set<string>(); // 展开完整错误详情的 task.id

function statusLabel(status: TaskStatus | "all"): string {
  if (status === "all") {
    return t("tasks.statusAll");
  }
  return t(`tasks.status.${status}`);
}

// 状态点：running=accent（脉动）/ queued=warn / completed=ok / failed·timed_out=destructive / 其余 muted
function statusDotClass(status: TaskStatus | "all"): string {
  switch (status) {
    case "running":
      return "ts-dot--running";
    case "queued":
      return "ts-dot--queued";
    case "completed":
      return "ts-dot--ok";
    case "failed":
    case "timed_out":
      return "ts-dot--danger";
    default:
      return "ts-dot--muted";
  }
}

// meta 行内状态文字配色（与状态点同语义）
function statusTextClass(status: TaskStatus | "all"): string {
  switch (status) {
    case "running":
      return "ts-status--running";
    case "queued":
      return "ts-status--queued";
    case "completed":
      return "ts-status--ok";
    case "failed":
    case "timed_out":
      return "ts-status--danger";
    default:
      return "ts-status--muted";
  }
}

function runtimeLabel(runtime?: string): string {
  switch (runtime) {
    case "subagent":
      return t("tasks.runtime.subagent");
    case "cron":
      return t("tasks.runtime.cron");
    case "acp":
      return t("tasks.runtime.acp");
    case "cli":
      return t("tasks.runtime.cli");
    default:
      return t("tasks.runtime.unknown");
  }
}

function taskTitle(task: TaskSummary): string {
  const title = task.title?.trim();
  if (title) {
    return title;
  }
  const kind = task.kind?.trim();
  if (kind) {
    return kind;
  }
  return runtimeLabel(task.runtime);
}

function taskDetail(task: TaskSummary): string | null {
  const status = task.status;
  if (status === "failed" || status === "timed_out") {
    return task.error?.trim() || task.terminalSummary?.trim() || task.progressSummary?.trim() || null;
  }
  if (isActiveTask(task)) {
    return task.progressSummary?.trim() || null;
  }
  return task.terminalSummary?.trim() || task.progressSummary?.trim() || null;
}

function taskTimestamp(task: TaskSummary): string {
  const raw = task.updatedAt ?? task.startedAt ?? task.createdAt;
  const ms = toTaskTimestampMs(raw);
  return ms != null ? formatRelativeTimestamp(ms) : "n/a";
}

// cron 任务来源名：用 sourceId/kind 反查定时任务（内核任务行不直接带 job name）
function cronSourceName(props: TasksProps, task: TaskSummary): string | null {
  if (task.runtime !== "cron") return null;
  const match = props.cronJobs.find((j) => j.id === task.sourceId || j.id === task.kind);
  return match?.name ?? null;
}

/**
 * 搜索防抖：每键只同步模块态（input 的 .value 绑定保证回显），停键 200ms 后
 * 提交过滤词并 requestUpdate 一次。重复输入先清旧 timer，只保留最后一次。
 */
function onSearchInput(props: TasksProps, value: string) {
  tasksSearchInput = value;
  if (tasksSearchTimer != null) {
    clearTimeout(tasksSearchTimer);
  }
  tasksSearchTimer = setTimeout(() => {
    tasksSearchTimer = null;
    tasksSearchQuery = tasksSearchInput;
    props.requestUpdate();
  }, SEARCH_DEBOUNCE_MS);
}

/**
 * 统计 chip ↔ 状态过滤联动。chip 是「分组」（active=queued+running、
 * failed=failed+timed_out，单个 TaskStatus 表达不了），因此分组态存模块级
 * 变量，与单状态 select 互斥联动：点 chip 生效对应分组并把 select 归 all；
 * 再点同一分组（含 select 单状态归并出的分组）→ 还原 all。
 */
function toggleGroupFilter(props: TasksProps, group: TaskGroupKey) {
  const current = props.statusFilter !== "all"
    ? taskGroupOfStatus(props.statusFilter)
    : tasksStatusGroup;
  tasksStatusGroup = current === group ? "all" : group;
  if (props.statusFilter !== "all") {
    props.onStatusFilterChange("all");
  }
  props.requestUpdate();
}

/** 状态过滤匹配：单状态 select 优先，其次统计 chip 分组（覆盖多状态组） */
function statusMatchesFilter(task: TaskSummary, props: TasksProps): boolean {
  if (props.statusFilter !== "all") {
    return task.status === props.statusFilter;
  }
  if (tasksStatusGroup !== "all") {
    return taskGroupOfStatus(task.status) === tasksStatusGroup;
  }
  return true;
}

/** 统计条：4 枚状态 chip（计数 + 状态点），点击等价设置状态分组过滤 */
function renderStatsBar(props: TasksProps, stats: TaskStats) {
  // chip 高亮：select 单状态归并到所在分组（如选 failed → 失败 chip 亮），否则用分组态
  const activeGroup = props.statusFilter !== "all"
    ? taskGroupOfStatus(props.statusFilter)
    : tasksStatusGroup;
  const chips: Array<{ group: TaskGroupKey; label: string; count: number; dot: string }> = [
    { group: "active", label: t("tasks.stats.active"), count: stats.active, dot: "ts-dot--running" },
    { group: "completed", label: t("tasks.stats.completed"), count: stats.completed, dot: "ts-dot--ok" },
    { group: "failed", label: t("tasks.stats.failed"), count: stats.failed, dot: "ts-dot--danger" },
    { group: "other", label: t("tasks.stats.other"), count: stats.other, dot: "ts-dot--muted" },
  ];
  return html`
    <div class="ts-stats" role="group">
      ${chips.map(({ group, label, count, dot }) => {
        const on = activeGroup === group;
        return html`
          <button
            class="ts-chip ${on ? "ts-chip--on" : ""}"
            type="button"
            aria-pressed=${on ? "true" : "false"}
            @click=${() => toggleGroupFilter(props, group)}
          >
            <span class="ts-dot ${dot}" aria-hidden="true"></span>
            ${label}
            <span class="ts-chip__count">${count}</span>
          </button>
        `;
      })}
    </div>
  `;
}

/**
 * 任务详情行。失败/超时行：默认截断 ${ERROR_DETAIL_CLAMP} 字符 +「展开详情」
 * 切换完整内容；展开态记模块级 Set（按 task.id，切走视图保留）。其余行沿用
 * CSS 2 行 clamp（进行中/完成摘要一般较短）。
 */
function renderTaskDetail(
  props: TasksProps,
  task: TaskSummary,
  status: TaskStatus | "all",
): TemplateResult | typeof nothing {
  const detail = taskDetail(task);
  if (!detail) {
    return nothing;
  }
  if (status !== "failed" && status !== "timed_out") {
    return html`<div class="ts-row__detail">${detail}</div>`;
  }
  const expanded = tasksExpandedErrorIds.has(task.id);
  const clamped = detail.length > ERROR_DETAIL_CLAMP;
  const text = expanded || !clamped ? detail : `${detail.slice(0, ERROR_DETAIL_CLAMP)}…`;
  return html`
    <div class="ts-row__detail ${expanded ? "ts-row__detail--full" : ""}">${text}</div>
    ${clamped
      ? html`<button
          class="ts-detail-toggle"
          type="button"
          aria-expanded=${expanded ? "true" : "false"}
          @click=${() => {
            // 展开是纯本地交互：改模块级 Set 后直接请求重渲染（无 RPC）
            if (expanded) {
              tasksExpandedErrorIds.delete(task.id);
            } else {
              tasksExpandedErrorIds.add(task.id);
            }
            props.requestUpdate();
          }}
        >${expanded ? t("tasks.collapse") : t("tasks.expand")}</button>`
      : nothing}
  `;
}

function renderTaskRow(props: TasksProps, task: TaskSummary) {
  const active = isActiveTask(task);
  const cancelling = props.cancellingIds.has(task.id);
  const sessionKey = task.childSessionKey ?? task.sessionKey;
  const timestamp = taskTimestamp(task);
  // 耗时基于 Date.now()：30s 自动刷新 tick 的 requestUpdate 会顺带滚动该值（不另开 1s 定时器）
  const durationMs = taskDurationMs(task);
  const status = task.status ?? "queued";
  const source = cronSourceName(props, task);
  const title = taskTitle(task);
  return html`
    <div class="ts-row ${active ? "ts-row--active" : ""}">
      <span class="ts-dot ${statusDotClass(status)}" title=${statusLabel(status)}></span>
      <div class="ts-row__main">
        <div class="ts-row__title-line">
          <span class="ts-row__title" title=${title}>${title}</span>
        </div>
        <div class="ts-row__meta">
          <span class="ts-row__meta-item ts-status ${statusTextClass(status)}">${statusLabel(status)}</span>
          <span class="ts-row__meta-item">${runtimeLabel(task.runtime)}</span>
          ${task.agentId ? html`<span class="ts-row__meta-item">${task.agentId}</span>` : nothing}
          ${durationMs != null ? html`<span class="ts-row__meta-item">${formatDurationHuman(durationMs)}</span>` : nothing}
          ${source
            ? html`<span class="ts-row__meta-item" title=${source}>${t("tasks.cronSource").replace("{name}", source)}</span>`
            : nothing}
          <span class="ts-row__meta-item ts-row__time-inline" title=${timestamp}>${timestamp}</span>
        </div>
        ${renderTaskDetail(props, task, status)}
      </div>
      <div class="ts-row__actions">
        ${sessionKey
          ? html`<button
              class="btn btn--sm"
              type="button"
              @click=${() => props.onOpenChat(sessionKey)}
              >
              ${t("tasks.openSession")}
              </button>`
          : nothing}
        ${task.runtime === "cron"
          ? html`<button
              class="btn btn--sm"
              type="button"
              @click=${() => props.onOpenCronTab()}
              >
              ${t("tasks.viewCronJob")}
              </button>`
          : nothing}
        ${active
          ? html`<button
              class="btn danger btn--sm"
              type="button"
              ?disabled=${cancelling || !props.connected}
              @click=${() => props.onCancel(task.id)}
              >
              ${cancelling ? icons.loader : nothing}
              ${cancelling ? t("tasks.cancelling") : t("tasks.cancel")}
              </button>`
          : nothing}
      </div>
    </div>
  `;
}

function renderTasksRuns(props: TasksProps) {
  // 统计条始终基于全量列表（deriveTaskStats 计数不受筛选影响）
  const stats = deriveTaskStats(props.tasks);
  // Agent 选项动态收集；列表刷新后选中 agent 可能已无任务 → 归一化为「全部」
  const agentIds = collectAgentIds(props.tasks);
  const agentFilter = agentIds.includes(tasksAgentFilter) ? tasksAgentFilter : "";
  // 搜索/来源/Agent 任一生效 → 扁平结果列表（与状态过滤共用一条结果流）；
  // 空态文案：列表筛选生效用 noMatch，仅状态过滤沿用 emptyFiltered
  const hasListFilters =
    tasksRuntimeFilter !== "all" || agentFilter !== "" || tasksSearchQuery.trim() !== "";
  const flatMode = hasListFilters || props.statusFilter !== "all" || tasksStatusGroup !== "all";

  // 过滤管线（全客户端）：状态（select 优先，其次 chip 分组）→ 来源 → Agent → 搜索
  let visible = props.tasks.filter((task) => statusMatchesFilter(task, props));
  visible = filterTasksByRuntime(visible, tasksRuntimeFilter);
  if (agentFilter) {
    visible = visible.filter((task) => task.agentId === agentFilter);
  }
  visible = filterTasksByQuery(visible, tasksSearchQuery);

  // 双分组视图只在完全无过滤时展示（进行中 + 最近完成）
  const activeTasks = props.tasks.filter((task) => isActiveTask(task));
  const recentAll = props.tasks.filter((task) => !isActiveTask(task));
  const recentShown = tasksShowAllRecent ? recentAll : recentAll.slice(0, RECENT_CLAMP);

  return html`
    <div class="ts-header panel__header">
        <div>
          <h2 class="ts-title panel__title">${t("tasks.title")}</h2>
          <p class="ts-sub panel__subtitle">${t("tasks.subtitle")}</p>
        </div>
        <div class="panel__actions">
          <span class="ts-autorefresh">
            <oc-toggle-switch
              .checked=${props.autoRefresh}
              .label=${t("tasks.autoRefresh")}
              @change=${(e: CustomEvent) =>
                props.onAutoRefreshChange(Boolean((e.detail as { checked?: boolean } | null)?.checked))}
            ></oc-toggle-switch>
          </span>
          <button
            class="btn"
            type="button"
            ?disabled=${props.loading}
            @click=${props.onRefresh}
          >
            ${props.loading ? icons.loader : icons.refreshCw}
            ${t("tasks.refresh")}
          </button>
        </div>
      </div>

      ${props.error
        ? html`<div class="callout danger ts-error">
            <span class="ts-error__text">${props.error}</span>
            <button
              class="btn btn--sm"
              type="button"
              ?disabled=${props.loading}
              @click=${props.onRefresh}
            >
              ${icons.refreshCw}
              ${t("tasks.retry")}
            </button>
          </div>`
        : nothing}

      ${renderStatsBar(props, stats)}

      <!-- R94：筛选控件从页头下沉为独立工具行（页头只留标题与两个主操作） -->
      <div class="ts-toolbar panel__toolbar">
          <input
            class="ts-search"
            type="text"
            placeholder=${t("tasks.searchPlaceholder")}
            .value=${tasksSearchInput}
            @input=${(e: Event) => onSearchInput(props, (e.target as HTMLInputElement).value)}
          />
          <select
            class="ts-select"
            .value=${tasksRuntimeFilter}
            @change=${(e: Event) => {
              tasksRuntimeFilter = (e.target as HTMLSelectElement).value as TaskRuntimeFilter;
              props.requestUpdate();
            }}
          >
            <option value="all">${t("tasks.runtimeAll")}</option>
            ${RUNTIME_FILTER_OPTIONS.map((runtime) => html`
              <option value=${runtime}>${runtimeLabel(runtime === "unknown" ? undefined : runtime)}</option>
            `)}
          </select>
          ${agentIds.length > 0
            ? html`<select
                class="ts-select"
                .value=${agentFilter}
                @change=${(e: Event) => {
                  tasksAgentFilter = (e.target as HTMLSelectElement).value;
                  props.requestUpdate();
                }}
              >
                <option value="">${t("tasks.agentAll")}</option>
                ${agentIds.map((id) => html`<option value=${id}>${id}</option>`)}
              </select>`
            : nothing}
          <select
            class="ts-select"
            .value=${props.statusFilter}
            @change=${(e: Event) => {
              // 单状态 select 与统计 chip 分组互斥：select 生效时清分组态，避免叠加过滤
              tasksStatusGroup = "all";
              props.onStatusFilterChange((e.target as HTMLSelectElement).value as TaskStatus | "all");
            }}
          >
            ${STATUS_OPTIONS.map((status) => html`<option value=${status}>${statusLabel(status)}</option>`)}
          </select>
      </div>

      ${flatMode
        ? visible.length === 0
          ? html`<p class="ts-empty panel__empty">${hasListFilters ? t("tasks.noMatch") : t("tasks.emptyFiltered")}</p>`
          : html`<div class="ts-list">${visible.map((task) => renderTaskRow(props, task))}</div>`
        : html`
            <section class="ts-section">
              <h3 class="ts-section__title">${t("tasks.activeTitle")}
                ${activeTasks.length > 0 ? html`<span class="ts-count">${activeTasks.length}</span>` : nothing}
              </h3>
              ${activeTasks.length === 0
                ? html`<div class="empty-state">
                    <span class="empty-state__icon">${icons.activity}</span>
                    <div class="empty-state__title">${t("tasks.noActive")}</div>
                    <div class="empty-state__actions">
                      <button
                        class="btn btn--sm"
                        type="button"
                        @click=${() => props.onOpenCronTab()}
                      >${t("tasks.viewCronJob")}</button>
                    </div>
                  </div>`
                : html`<div class="ts-list">${activeTasks.map((task) => renderTaskRow(props, task))}</div>`}
            </section>
            <section class="ts-section">
              <h3 class="ts-section__title">${t("tasks.recentTitle")}</h3>
              ${recentShown.length === 0
                ? html`<p class="ts-empty panel__empty">${t("tasks.noRecent")}</p>`
                : html`<div class="ts-list">${recentShown.map((task) => renderTaskRow(props, task))}</div>`}
              ${recentAll.length > RECENT_CLAMP
                ? html`<div class="ts-recent-more">
                    <button
                      class="btn btn--sm"
                      type="button"
                      @click=${() => {
                        tasksShowAllRecent = !tasksShowAllRecent;
                        props.requestUpdate();
                      }}
                    >${tasksShowAllRecent ? t("tasks.collapse") : t("tasks.showAll")}</button>
                  </div>`
                : nothing}
            </section>
          `}
  `;
}

export function renderTasks(props: TasksProps) {
  return html`
    <div class="ts-layout panel">
      <div class="ts-tabs" role="tablist">
        <button
          class="ts-tab ${props.tab ==="runs" ? "ts-tab--active" : ""}"
          type="button"
          role="tab"
          aria-selected=${props.tab === "runs" ? "true" : "false"}
          @click=${() => props.onTabChange("runs")}
        >${t("tasks.runsTab")}</button>
        <button
          class="ts-tab ${props.tab ==="cron" ? "ts-tab--active" : ""}"
          type="button"
          role="tab"
          aria-selected=${props.tab === "cron" ? "true" : "false"}
          @click=${() => props.onTabChange("cron")}
        >${t("tasks.cronTab")}${props.cronJobCount > 0
          ? html`<span class="ts-tab__badge">${props.cronJobCount}</span>`
          : nothing}</button>
      </div>
      ${props.tab === "cron" ? props.cronSlot : renderTasksRuns(props)}
    </div>
  `;
}
