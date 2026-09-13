/**
 * 「用量」tab（v2026.913.3 自「会话用量」重构）——参照 openclaw 官方 /usage 页
 * 的核心区块：总览指标、每日活动、Top 模型/服务商、会话明细、服务商配额。
 * 数据面见 tab-usage.lib.ts 头注。
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t } from "../../i18n.ts";
import "../../components/message-box.ts";
import { formatCost, formatTokens } from "../usage-metrics.ts";
import {
  mapSessionsUsage,
  mapUsageCost,
  mapUsageStatus,
  resolveUsageSessionDisplayLabel,
  sharePercent,
  topRows,
  USAGE_RANGE_IDS,
  type UsageAggregates,
  type UsageCostPayload,
  type UsageDailyRow,
  type UsageProviderStatus,
  type UsageRangeId,
  type UsageSessionRow,
  type UsageSessionsPayload,
  type UsageTokenTotals,
  type UsageTopRow,
} from "./tab-usage.lib.ts";

type LoadingState = "idle" | "loading" | "ready" | "error";

const s = {
  range: "30d" as UsageRangeId,
  cost: { totals: null, daily: [] } as UsageCostPayload,
  sessions: { rows: [], totals: null, aggregates: null } as UsageSessionsPayload,
  providerStatus: [] as UsageProviderStatus[],
  loadingState: "idle" as LoadingState,
  error: null as string | null,
  loadSeq: 0,
  wasConnected: false,
};

async function load(state: AppViewState) {
  if (!state.client || !state.connected) return;
  const seq = ++s.loadSeq;
  const { startDate, endDate } = resolveRangeDates();
  s.loadingState = "loading";
  state.requestUpdate();
  try {
    const rangeParams = { startDate, endDate };
    // usage.cost / usage.status 为增强数据源：内核 <2026.9 或 scope 缺失时静默降级
    const [cost, sessions, status] = await Promise.all([
      state.client.request<unknown>("usage.cost", rangeParams).catch(() => null),
      state.client.request<unknown>("sessions.usage", { ...rangeParams, limit: 1000, groupBy: "instance" }),
      state.client.request<unknown>("usage.status", {}).catch(() => null),
    ]);
    if (seq !== s.loadSeq) return; // 范围已切换/重新加载：丢弃过期响应
    if (cost) s.cost = mapUsageCost(cost);
    s.sessions = mapSessionsUsage(sessions);
    if (status) s.providerStatus = mapUsageStatus(status);
    s.loadingState = "ready";
    s.error = null;
  } catch (err) {
    if (seq !== s.loadSeq) return;
    s.loadingState = "error";
    s.error = String(err);
  }
  state.requestUpdate();
}

// 范围档位 → 请求日期边界（本地时区；lib 里的 resolveUsageRange 有单测钉住同语义）
function resolveRangeDates(): { startDate: string; endDate: string } {
  const now = new Date();
  const endDate = toIsoDate(now);
  if (s.range === "today") return { startDate: endDate, endDate };
  if (s.range === "all") return { startDate: "2000-01-01", endDate };
  const days = s.range === "7d" ? 6 : 29;
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  return { startDate: toIsoDate(start), endDate };
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function resetUsageTab() {
  s.range = "30d";
  s.cost = { totals: null, daily: [] };
  s.sessions = { rows: [], totals: null, aggregates: null };
  s.providerStatus = [];
  s.loadingState = "idle";
  s.error = null;
  s.loadSeq = 0;
  s.wasConnected = false;
}

function formatDateTime(ms: number): string {
  return ms ? new Date(ms).toLocaleString() : "";
}

// ── 渲染 ──

function renderRangeSwitch(state: AppViewState) {
  return html`
    <div class="oc-usage__ranges" role="tablist">
      ${USAGE_RANGE_IDS.map((id) => html`
        <button
          class="oc-usage__range ${s.range === id ? "oc-usage__range--active" : ""}"
          type="button"
          @click=${() => {
            if (s.range === id) return;
            s.range = id;
            void load(state);
          }}
        >${t(`settings.usage.range.${id}`)}</button>
      `)}
      <button
        class="oc-usage__range oc-usage__range--refresh"
        type="button"
        ?disabled=${s.loadingState === "loading"}
        @click=${() => void load(state)}
      >${t("settings.usage.refresh")}</button>
    </div>
  `;
}

function renderStatCard(label: string, value: string, sub?: string) {
  return html`
    <div class="oc-usage__stat">
      <div class="oc-usage__stat-value">${value}</div>
      <div class="oc-usage__stat-label">${label}</div>
      ${sub ? html`<div class="oc-usage__stat-sub">${sub}</div>` : nothing}
    </div>
  `;
}

function renderMetrics(totals: UsageTokenTotals | null, aggregates: UsageAggregates | null, sessionCount: number) {
  const effective = totals ?? emptyTotals();
  const inOut = `${t("settings.usage.tokenIn")} ${formatTokens(effective.input)} · ${t("settings.usage.tokenOut")} ${formatTokens(effective.output)}`;
  const msgs = aggregates?.messages;
  return html`
    <div class="oc-usage__stats">
      ${renderStatCard(t("settings.usage.statTokens"), formatTokens(effective.totalTokens ?? effective.input + effective.output + effective.cacheRead), inOut)}
      ${renderStatCard(t("settings.usage.statCost"), effective.totalCost != null ? formatCost(effective.totalCost) : "—")}
      ${renderStatCard(t("settings.usage.statSessions"), String(aggregates?.sessionCount ?? sessionCount))}
      ${renderStatCard(
        t("settings.usage.statMessages"),
        msgs?.total != null ? String(msgs.total) : "—",
        msgs && (msgs.user != null || msgs.assistant != null || msgs.errors != null)
          ? `${t("settings.usage.msgUser")} ${msgs.user ?? 0} · ${t("settings.usage.msgAssistant")} ${msgs.assistant ?? 0} · ${t("settings.usage.msgErrors")} ${msgs.errors ?? 0}`
          : undefined,
      )}
    </div>
  `;
}

function emptyTotals(): UsageTokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: null, totalTokens: null, totalCost: null };
}

function renderDaily(daily: UsageDailyRow[]) {
  const rows = daily.filter((d) => (d.totalTokens ?? d.input + d.output + d.cacheRead) > 0).slice(-30);
  if (rows.length === 0) return nothing;
  const max = Math.max(...rows.map((d) => d.totalTokens ?? d.input + d.output + d.cacheRead));
  return html`
    <div class="oc-settings__card">
      <div class="oc-settings__card-title">${t("settings.usage.daily.title")}</div>
      <div class="oc-usage__daily">
        ${rows.map((d) => {
          const total = d.totalTokens ?? d.input + d.output + d.cacheRead;
          return html`
            <div class="oc-usage__daily-row" title=${`${d.date} · ${formatTokens(total)}${d.totalCost != null ? ` · ${formatCost(d.totalCost)}` : ""}`}>
              <span class="oc-usage__daily-date">${d.date.slice(5)}</span>
              <span class="oc-usage__daily-bar">
                <i class="oc-usage__bar-in" style="width:${sharePercent(d.input, max)}%"></i>
                <i class="oc-usage__bar-out" style="width:${sharePercent(d.output, max)}%"></i>
                <i class="oc-usage__bar-cache" style="width:${sharePercent(d.cacheRead, max)}%"></i>
              </span>
              <span class="oc-usage__daily-tokens">${formatTokens(total)}</span>
            </div>
          `;
        })}
      </div>
      <div class="oc-usage__legend">
        <span><i class="oc-usage__bar-in"></i>${t("settings.usage.tokenIn")}</span>
        <span><i class="oc-usage__bar-out"></i>${t("settings.usage.tokenOut")}</span>
        <span><i class="oc-usage__bar-cache"></i>${t("settings.usage.tokenCacheRead")}</span>
      </div>
    </div>
  `;
}

function renderTopSection(title: string, rows: UsageTopRow[]) {
  const top = topRows(rows);
  if (top.length === 0) return nothing;
  const max = top[0]!.tokens || 1;
  return html`
    <div class="oc-usage__top-group">
      <div class="oc-usage__top-title">${title}</div>
      ${top.map((row) => html`
        <div class="oc-usage__top-row" title=${row.label}>
          <span class="oc-usage__top-label">${row.label}</span>
          <span class="oc-usage__top-bar"><i style="width:${sharePercent(row.tokens, max)}%"></i></span>
          <span class="oc-usage__top-tokens">${formatTokens(row.tokens)}</span>
        </div>
      `)}
    </div>
  `;
}

function renderAggregates(aggregates: UsageAggregates | null) {
  if (!aggregates) return nothing;
  const hasAny = aggregates.byModel.length + aggregates.byProvider.length + aggregates.byChannel.length > 0;
  if (!hasAny) return nothing;
  return html`
    <div class="oc-settings__card">
      <div class="oc-settings__card-title">${t("settings.usage.top.title")}</div>
      <div class="oc-usage__tops">
        ${renderTopSection(t("settings.usage.top.models"), aggregates.byModel)}
        ${renderTopSection(t("settings.usage.top.providers"), aggregates.byProvider)}
        ${aggregates.byChannel.length ? renderTopSection(t("settings.usage.top.channels"), aggregates.byChannel) : nothing}
      </div>
    </div>
  `;
}

function renderProviderStatus(status: UsageProviderStatus[]) {
  const withWindows = status.filter((p) => p.windows.length > 0);
  if (withWindows.length === 0) return nothing;
  return html`
    <div class="oc-settings__card">
      <div class="oc-settings__card-title">${t("settings.usage.provider.title")}</div>
      ${withWindows.map((p) => html`
        <div class="oc-usage__provider">
          <div class="oc-usage__provider-name">${p.provider}</div>
          ${p.windows.map((w) => html`
            <div class="oc-usage__provider-window">
              <span class="oc-usage__provider-label">${w.label}</span>
              <span class="oc-usage__provider-bar"><i style="width:${w.usedPercent ?? 0}%"></i></span>
              <span class="oc-usage__provider-pct">${w.usedPercent != null ? `${Math.round(w.usedPercent)}%` : "—"}</span>
            </div>
          `)}
        </div>
      `)}
    </div>
  `;
}

function renderSessionRow(row: UsageSessionRow) {
  const displayLabel = resolveUsageSessionDisplayLabel(row);
  return html`
    <div class="oc-usage__session-row">
      <span class="oc-usage__session-label" title=${displayLabel}>${displayLabel}</span>
      <span class="oc-usage__session-tokens">
        <span><span class="oc-usage__tag">${t("settings.usage.tokenIn")}</span> ${formatTokens(row.input ?? undefined)}</span>
        <span class="oc-usage__sep">·</span>
        <span><span class="oc-usage__tag">${t("settings.usage.tokenOut")}</span> ${formatTokens(row.output ?? undefined)}</span>
        <span class="oc-usage__sep">·</span>
        <span><span class="oc-usage__tag">${t("settings.usage.tokenCacheRead")}</span> ${formatTokens(row.cacheRead ?? undefined)}</span>
      </span>
      <span class="oc-usage__session-cost">${row.totalCost != null ? formatCost(row.totalCost) : ""}</span>
      <span class="oc-usage__session-time">${formatDateTime(row.updatedAt)}</span>
    </div>
  `;
}

export function renderTabUsage(state: AppViewState) {
  // 断连重置：Gateway 回连后重新拉取，避免残留「加载失败」
  if (s.wasConnected && !state.connected) s.loadingState = "idle";
  s.wasConnected = state.connected;
  if (s.loadingState === "idle" && state.connected && state.client) void load(state);

  const totals = s.sessions.totals ?? s.cost.totals;
  const showSkeleton = s.loadingState === "loading" && !s.sessions.rows.length;

  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.usage.pageTitle")}</h2>
      <p class="oc-settings__hint">${t("settings.usage.pageDesc")}</p>

      ${renderRangeSwitch(state)}

      ${showSkeleton
        ? html`<div class="oc-usage__empty">…</div>`
        : html`
            ${renderMetrics(totals, s.sessions.aggregates, s.sessions.rows.length)}
            ${renderDaily(s.cost.daily)}
            ${renderAggregates(s.sessions.aggregates)}
            ${renderProviderStatus(s.providerStatus)}
            <div class="oc-settings__card">
              <div class="oc-settings__card-title">${t("settings.usage.sessions.title")}</div>
              ${s.sessions.rows.length === 0
                ? html`<div class="oc-usage__empty">${t("settings.usage.empty")}</div>`
                : html`<div class="oc-usage__sessions">${s.sessions.rows.map(renderSessionRow)}</div>`}
            </div>
          `}

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
    </div>
  `;
}
