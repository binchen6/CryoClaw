/**
 * Tasks 实时视图 — v2026.7 内核 tasks.list / tasks.cancel + task 事件。
 * 展示进行中（queued/running）与最近完成的后台任务，可取消、可跳转会话。
 * 2026.9 视觉重写：任务卡 → 清单式行（状态点 + 等宽 meta + hairline 分隔），
 * 顶层 tab → 分段控件（segmented control）。
 */
import { html, nothing, type TemplateResult } from "lit";
import type { CronJob, TaskSummary, TaskStatus } from "../types.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../format.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import { isActiveTask, taskDurationMs, toTaskTimestampMs } from "../controllers/tasks.ts";

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
  onTabChange: (tab: TasksViewTab) => void;
  /** runtime === "cron" 任务行「查看定时任务」→ 切定时 tab */
  onOpenCronTab: () => void;
  onStatusFilterChange: (status: TaskStatus | "all") => void;
  onRefresh: () => void;
  onCancel: (taskId: string) => void;
  onOpenChat: (sessionKey: string) => void;
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

function renderTaskRow(props: TasksProps, task: TaskSummary) {
  const active = isActiveTask(task);
  const cancelling = props.cancellingIds.has(task.id);
  const sessionKey = task.childSessionKey ?? task.sessionKey;
  const detail = taskDetail(task);
  const timestamp = taskTimestamp(task);
  const durationMs = taskDurationMs(task);
  const status = task.status ?? "queued";
  const source = cronSourceName(props, task);
  const title = taskTitle(task);
  return html`
    <div class="ts-row ${active ? "ts-row--active" : ""}">
      <span class="ts-dot ${statusDotClass(status)}" title=${statusLabel(status)}></span>
      <div class="ts-row__main">
        <div class="ts-row__title" title=${title}>${title}</div>
        <div class="ts-row__meta">
          <span class="ts-row__meta-item ts-status ${statusTextClass(status)}">${statusLabel(status)}</span>
          <span class="ts-row__meta-item">${runtimeLabel(task.runtime)}</span>
          ${task.agentId ? html`<span class="ts-row__meta-item">${task.agentId}</span>` : nothing}
          ${durationMs != null ? html`<span class="ts-row__meta-item">${formatDurationHuman(durationMs)}</span>` : nothing}
          ${source
            ? html`<span class="ts-row__meta-item" title=${source}>${t("tasks.cronSource").replace("{name}", source)}</span>`
            : nothing}
        </div>
        ${detail ? html`<div class="ts-row__detail">${detail}</div>` : nothing}
      </div>
      <div class="ts-row__side">
        <span class="ts-row__time" title=${timestamp}>${timestamp}</span>
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
    </div>
  `;
}

function renderTasksRuns(props: TasksProps) {
  const activeTasks = props.tasks.filter((task) => isActiveTask(task));
  const recentTasks = props.tasks.filter((task) => !isActiveTask(task)).slice(0, 50);
  // 状态过滤在客户端做（tasks.list 始终全量拉取，避免污染图标轨徽标计数）
  const filtered = props.statusFilter === "all"
    ? props.tasks
    : props.tasks.filter((task) => task.status === props.statusFilter);

  return html`
    <div class="ts-header panel__header">
        <div>
          <h2 class="ts-title panel__title">${t("tasks.title")}</h2>
          <p class="ts-sub panel__subtitle">${t("tasks.subtitle")}</p>
        </div>
        <div class="ts-toolbar panel__actions">
          <select
            class="ts-select"
            .value=${props.statusFilter}
            @change=${(e: Event) =>
              props.onStatusFilterChange((e.target as HTMLSelectElement).value as TaskStatus | "all")}
          >
            ${STATUS_OPTIONS.map((status) => html`<option value=${status}>${statusLabel(status)}</option>`)}
          </select>
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

      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}

      ${props.statusFilter === "all"
        ? html`
            <section class="ts-section">
              <h3 class="ts-section__title">${t("tasks.activeTitle")}
                ${activeTasks.length > 0 ? html`<span class="ts-count">${activeTasks.length}</span>` : nothing}
              </h3>
              ${activeTasks.length === 0
                ? html`<p class="ts-empty panel__empty">${t("tasks.noActive")}</p>`
                : html`<div class="ts-list">${activeTasks.map((task) => renderTaskRow(props, task))}</div>`}
            </section>
            <section class="ts-section">
              <h3 class="ts-section__title">${t("tasks.recentTitle")}</h3>
              ${recentTasks.length === 0
                ? html`<p class="ts-empty panel__empty">${t("tasks.noRecent")}</p>`
                : html`<div class="ts-list">${recentTasks.map((task) => renderTaskRow(props, task))}</div>`}
            </section>
          `
        : filtered.length === 0
          ? html`<p class="ts-empty panel__empty">${t("tasks.emptyFiltered")}</p>`
          : html`<div class="ts-list">${filtered.map((task) => renderTaskRow(props, task))}</div>`}
  `;
}

export function renderTasks(props: TasksProps) {
  return html`
    <div class="ts-layout panel">
      <div class="ts-tabs" role="tablist">
        <button
          class="ts-tab ${props.tab === "runs" ? "ts-tab--active" : ""}"
          type="button"
          role="tab"
          aria-selected=${props.tab === "runs" ? "true" : "false"}
          @click=${() => props.onTabChange("runs")}
        >${t("tasks.runsTab")}</button>
        <button
          class="ts-tab ${props.tab === "cron" ? "ts-tab--active" : ""}"
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
