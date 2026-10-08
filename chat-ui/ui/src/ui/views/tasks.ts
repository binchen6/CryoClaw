/**
 * Tasks 视图（2026.9.7 适配）— 运行记录 = cron.runs scope:"all" 全局运行历史。
 * 内核已移除 tasks.*（无后台任务面），运行记录 tab 改展示定时任务运行历史
 * （状态点 + 等宽 meta + hairline 分隔的清单式行），定时 tab 不变。
 * 统计条（状态分组 chip 联动过滤）、搜索/状态客户端筛选、30s 自动刷新开关
 * （ticker 生命周期在 app-tasks）、失败详情展开/收起沿用 R92 模式；过滤/展开等
 * 视图私有状态放模块级变量（不给 AppViewState 加字段，参照 app-skills 的
 * skillsSubTab 模式）；统计与过滤逻辑走 controllers/tasks.ts 导出的纯函数。
 */
import { html, nothing, type TemplateResult } from "lit";
import type { CronJob, CronRunLogEntry } from "../types.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../format.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import "../components/toggle-switch.ts";
import {
  deriveRunStats,
  filterRunsByQuery,
  runGroupOfStatus,
  runMatchesStatusFilter,
  runTimestampMs,
  type CronRunStatusFilter,
  type RunGroupKey,
  type RunStats,
} from "../controllers/tasks.ts";

export type TasksViewTab = "runs" | "cron";

export type TasksProps = {
  loading: boolean;
  error: string | null;
  runs: CronRunLogEntry[];
  cronJobs: CronJob[];
  statusFilter: CronRunStatusFilter;
  connected: boolean;
  /** 当前内核未注册 cron.runs（2026.9.7 之前的内核）：显示说明性空态（非错误） */
  unsupported: boolean;
  tab: TasksViewTab;
  /** 定时 tab 内容（由装配层组装 renderCronView，避免 views 层反向依赖 app-cron） */
  cronSlot: TemplateResult;
  /** 启用中定时任务数（定时 tab 徽标） */
  cronJobCount: number;
  /** R92：30s 自动刷新开关状态（ticker 生命周期由 app-tasks 管理） */
  autoRefresh: boolean;
  onTabChange: (tab: TasksViewTab) => void;
  /** 运行记录行「查看定时任务」→ 切定时 tab */
  onOpenCronTab: () => void;
  onStatusFilterChange: (status: CronRunStatusFilter) => void;
  onRefresh: () => void;
  onOpenChat: (sessionKey: string) => void;
  /** R92：自动刷新开关切换（app-tasks 起/停 ticker） */
  onAutoRefreshChange: (enabled: boolean) => void;
  /** R92：视图私有状态变更（搜索防抖提交/展开切换等，无 RPC）后请求重渲染 */
  requestUpdate: () => void;
};

const STATUS_OPTIONS: CronRunStatusFilter[] = ["all", "ok", "error", "skipped"];

// 搜索防抖：停键 200ms 才提交过滤词并重渲染（避免每键 requestUpdate 风暴）
const SEARCH_DEBOUNCE_MS = 200;
// 失败行错误详情默认截断字符数
const ERROR_DETAIL_CLAMP = 140;

// ── 视图私有过滤/交互状态（模块级；切走视图不重置，回到本页保留筛选上下文） ──
let runsSearchInput = ""; // 搜索框即时值（每键同步，不触发渲染）
let runsSearchQuery = ""; // 防抖提交后的过滤词（真正参与过滤）
let runsSearchTimer: ReturnType<typeof setTimeout> | null = null;
// 统计 chip 的分组过滤态（other 覆盖缺省/未知状态，单状态 select 表达不了，
// 故存视图模块级）
let runsStatusGroup: RunGroupKey | "all" = "all";
const runsExpandedErrorKeys = new Set<string>(); // 展开完整错误详情的记录 key

function statusLabel(status: string | undefined): string {
  switch (status) {
    case "ok":
    case "error":
    case "skipped":
      return t(`tasks.status.${status}`);
    default:
      return t("tasks.status.other");
  }
}

// 状态点：ok=ok / error=destructive / skipped=warn / 其余 muted
function statusDotClass(status: string | undefined): string {
  switch (status) {
    case "ok":
      return "ts-dot--ok";
    case "error":
      return "ts-dot--danger";
    case "skipped":
      return "ts-dot--queued";
    default:
      return "ts-dot--muted";
  }
}

// meta 行内状态文字配色（与状态点同语义）
function statusTextClass(status: string | undefined): string {
  switch (status) {
    case "ok":
      return "ts-status--ok";
    case "error":
      return "ts-status--danger";
    case "skipped":
      return "ts-status--queued";
    default:
      return "ts-status--muted";
  }
}

// 记录标题：jobName（内核附带或 cron.list 补全）→ jobId → 通用兜底
function runTitle(run: CronRunLogEntry): string {
  const name = run.jobName?.trim();
  if (name) {
    return name;
  }
  const id = run.jobId?.trim();
  if (id) {
    return id;
  }
  return t("tasks.unknownJob");
}

function runDetail(run: CronRunLogEntry): string | null {
  if (run.status === "error") {
    return run.error?.trim() || run.summary?.trim() || null;
  }
  return run.summary?.trim() || run.error?.trim() || null;
}

function runTimestamp(run: CronRunLogEntry): string {
  const ms = runTimestampMs(run);
  return ms != null ? formatRelativeTimestamp(ms) : "n/a";
}

// 展开态 key：runId 优先，缺省退化为 jobId+ts 组合（同一次运行唯一）
function runKey(run: CronRunLogEntry): string {
  return run.runId ?? `${run.jobId ?? ""}:${run.ts}`;
}

/**
 * 搜索防抖：每键只同步模块态（input 的 .value 绑定保证回显），停键 200ms 后
 * 提交过滤词并 requestUpdate 一次。重复输入先清旧 timer，只保留最后一次。
 */
function onSearchInput(props: TasksProps, value: string) {
  runsSearchInput = value;
  if (runsSearchTimer != null) {
    clearTimeout(runsSearchTimer);
  }
  runsSearchTimer = setTimeout(() => {
    runsSearchTimer = null;
    runsSearchQuery = runsSearchInput;
    props.requestUpdate();
  }, SEARCH_DEBOUNCE_MS);
}

/**
 * 统计 chip ↔ 状态过滤联动。chip 是「分组」（other 覆盖缺省/未知状态，单个
 * 状态 select 表达不了），因此分组态存模块级变量，与单状态 select 互斥联动：
 * 点 chip 生效对应分组并把 select 归 all；再点同一分组（含 select 单状态
 * 归并出的分组）→ 还原 all。
 */
function toggleGroupFilter(props: TasksProps, group: RunGroupKey) {
  const current = props.statusFilter !== "all"
    ? runGroupOfStatus(props.statusFilter)
    : runsStatusGroup;
  runsStatusGroup = current === group ? "all" : group;
  if (props.statusFilter !== "all") {
    props.onStatusFilterChange("all");
  }
  props.requestUpdate();
}

/** 统计条：4 枚状态 chip（计数 + 状态点），点击等价设置状态分组过滤。
 *  无数据时整组隐藏（全零药丸无信息量，QA 任务页空态观感修复）；无数据且
 *  加载中渲染 shimmer 骨架占位，表达「统计即将到来」而非静默。 */
function renderStatsBar(props: TasksProps, stats: RunStats) {
  if (stats.total === 0) {
    if (!props.loading) {
      return nothing;
    }
    return html`
      <div class="ts-stats ts-stats--skeleton" role="status" aria-label=${t("chat.loading")}>
        <span class="ts-stats__skeleton-chip"></span>
        <span class="ts-stats__skeleton-chip"></span>
        <span class="ts-stats__skeleton-chip"></span>
        <span class="ts-stats__skeleton-chip"></span>
      </div>
    `;
  }
  // chip 高亮：select 单状态归并到所在分组（如选 error → 失败 chip 亮），否则用分组态
  const activeGroup = props.statusFilter !== "all"
    ? runGroupOfStatus(props.statusFilter)
    : runsStatusGroup;
  const chips: Array<{ group: RunGroupKey; label: string; count: number; dot: string }> = [
    { group: "ok", label: t("tasks.stats.ok"), count: stats.ok, dot: "ts-dot--ok" },
    { group: "error", label: t("tasks.stats.error"), count: stats.error, dot: "ts-dot--danger" },
    { group: "skipped", label: t("tasks.stats.skipped"), count: stats.skipped, dot: "ts-dot--queued" },
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
 * 记录详情行。失败行：默认截断 ${ERROR_DETAIL_CLAMP} 字符 +「展开详情」
 * 切换完整内容；展开态记模块级 Set（按运行 key，切走视图保留）。其余行沿用
 * CSS 2 行 clamp（运行摘要一般较短）。
 */
function renderRunDetail(
  props: TasksProps,
  run: CronRunLogEntry,
): TemplateResult | typeof nothing {
  const detail = runDetail(run);
  if (!detail) {
    return nothing;
  }
  if (run.status !== "error") {
    return html`<div class="ts-row__detail">${detail}</div>`;
  }
  const key = runKey(run);
  const expanded = runsExpandedErrorKeys.has(key);
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
              runsExpandedErrorKeys.delete(key);
            } else {
              runsExpandedErrorKeys.add(key);
            }
            props.requestUpdate();
          }}
        >${expanded ? t("tasks.collapse") : t("tasks.expand")}</button>`
      : nothing}
  `;
}

function renderRunRow(props: TasksProps, run: CronRunLogEntry, staggerClass = "") {
  const sessionKey = typeof run.sessionKey === "string" ? run.sessionKey.trim() : "";
  const timestamp = runTimestamp(run);
  const durationMs = typeof run.durationMs === "number" && run.durationMs > 0 ? run.durationMs : null;
  const title = runTitle(run);
  return html`
    <div class="ts-row ${staggerClass}">
      <span class="ts-dot ${statusDotClass(run.status)}" title=${statusLabel(run.status)}></span>
      <div class="ts-row__main">
        <div class="ts-row__title-line">
          <span class="ts-row__title" title=${title}>${title}</span>
        </div>
        <div class="ts-row__meta">
          <span class="ts-row__meta-item ts-status ${statusTextClass(run.status)}">${statusLabel(run.status)}</span>
          ${durationMs != null ? html`<span class="ts-row__meta-item">${formatDurationHuman(durationMs)}</span>` : nothing}
          <span class="ts-row__meta-item ts-row__time-inline" title=${timestamp}>${timestamp}</span>
        </div>
        ${renderRunDetail(props, run)}
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
        <button
          class="btn btn--sm"
          type="button"
          @click=${() => props.onOpenCronTab()}
          >
          ${t("tasks.viewCronJob")}
          </button>
      </div>
    </div>
  `;
}

function renderTasksRuns(props: TasksProps) {
  // 当前内核未注册 cron.runs（2026.9.7 之前的内核）——说明性空态，隐藏统计/筛选/列表
  if (props.unsupported) {
    return html`
      <div class="ts-header panel__header">
        <div>
          <h2 class="ts-title panel__title">${t("tasks.title")}</h2>
          <p class="ts-sub panel__subtitle">${t("tasks.subtitle")}</p>
        </div>
      </div>
      <div class="callout info ts-error">
        <span class="ts-error__text">${t("tasks.unsupportedKernel")}</span>
      </div>
    `;
  }
  // 统计条始终基于全量列表（deriveRunStats 计数不受筛选影响）
  const stats = deriveRunStats(props.runs);
  // 搜索生效 → 与状态过滤共用一条结果流；空态文案：搜索生效用 noMatch，
  // 仅状态过滤沿用 emptyFiltered
  const hasListFilters = runsSearchQuery.trim() !== "";

  // 过滤管线（全客户端）：状态（select 优先，其次 chip 分组）→ 搜索
  let visible = props.runs.filter((run) => runMatchesStatusFilter(run, props.statusFilter, runsStatusGroup));
  visible = filterRunsByQuery(visible, runsSearchQuery);

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
            <span class="ts-error__text" title=${props.error}>${t("tasks.loadFailed")}</span>
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

      <!-- 统计条：有数据才展示全量计数；无数据且加载中出骨架占位，全零药丸不再空挂 -->
      ${renderStatsBar(props, stats)}

      <!-- 筛选控件独立工具行（页头只留标题与两个主操作） -->
      <div class="ts-toolbar panel__toolbar">
          <input
            class="ts-search"
            type="text"
            placeholder=${t("tasks.searchPlaceholder")}
            .value=${runsSearchInput}
            @input=${(e: Event) => onSearchInput(props, (e.target as HTMLInputElement).value)}
          />
          <select
            class="ts-select"
            .value=${props.statusFilter}
            @change=${(e: Event) => {
              // 单状态 select 与统计 chip 分组互斥：select 生效时清分组态，避免叠加过滤
              runsStatusGroup = "all";
              props.onStatusFilterChange((e.target as HTMLSelectElement).value as CronRunStatusFilter);
            }}
          >
            ${STATUS_OPTIONS.map((status) => html`
              <option value=${status}>${status === "all" ? t("tasks.statusAll") : statusLabel(status)}</option>
            `)}
          </select>
      </div>

      ${visible.length === 0
        ? hasListFilters || props.statusFilter !== "all" || runsStatusGroup !== "all"
          ? html`<p class="ts-empty panel__empty">${hasListFilters ? t("tasks.noMatch") : t("tasks.emptyFiltered")}</p>`
          : html`<div class="empty-state">
              <span class="empty-state__icon">${icons.activity}</span>
              <div class="empty-state__title">${t("tasks.noRuns")}</div>
              <div class="empty-state__actions">
                <button
                  class="btn btn--sm"
                  type="button"
                  @click=${() => props.onOpenCronTab()}
                >${t("tasks.viewCronJob")}</button>
              </div>
            </div>`
        : html`<div class="ts-list">${visible.map((run, i) => renderRunRow(props, run, i < 6 ? `stagger-${i + 1}` : ""))}</div>`}
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
